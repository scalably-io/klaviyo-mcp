#!/usr/bin/env node
/**
 * Klaviyo Multi-Account MCP Server
 *
 * Read-only reporting across multiple Klaviyo accounts.
 * Designed for cross-brand email performance analysis.
 *
 * Env vars: KLAVIYO_KEY_{ACCOUNT_NAME}=pk_xxx (one per account)
 * Auth: Klaviyo-API-Key header per request
 * API revision: 2026-04-15
 */

import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { fail, reply } from './reply.js';

const API_BASE = process.env.KLAVIYO_API_BASE || 'https://a.klaviyo.com/api';
const API_REVISION = '2026-07-15';
const TIMEFRAME_KEYS = [
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'last_12_months',
  'last_365_days',
] as const;
const INTERVAL_KEYS = ['hourly', 'daily', 'weekly', 'monthly'] as const;

// ── Account Discovery ──────────────────────────────────────────

interface KlaviyoAccount {
  name: string;
  displayName: string;
  apiKey: string;
}

function discoverAccounts(): KlaviyoAccount[] {
  const accounts: KlaviyoAccount[] = [];
  const prefix = 'KLAVIYO_KEY_';
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix) && value) {
      const name = key.slice(prefix.length).toLowerCase().replace(/_/g, '-');
      const displayName = key
        .slice(prefix.length)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      accounts.push({ name, displayName, apiKey: value });
    }
  }
  return accounts;
}

function getAccount(accountName: string): KlaviyoAccount | null {
  const accounts = discoverAccounts();
  const normalized = accountName.toLowerCase().replace(/[\s_]/g, '-');
  return (
    accounts.find(
      (a) =>
        a.name === normalized ||
        a.displayName.toLowerCase() === accountName.toLowerCase(),
    ) ?? null
  );
}

// ── Input Validation ────────────────────────────────────────────

// Klaviyo IDs are alphanumeric (sometimes with dashes/underscores), up to 64
// chars. Validate before interpolating into URLs or filter expressions to
// block injection into `equals(x,"...")` clauses and URL paths.
const KLAVIYO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function safeId(id: string, label: string): string {
  if (!KLAVIYO_ID_RE.test(id)) {
    throw new Error(
      `Invalid ${label}: "${id.slice(0, 40)}". Must match [A-Za-z0-9_-]{1,64}.`,
    );
  }
  return id;
}

// ── API Helpers ─────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;

// Every failure mode (network error, timeout, non-2xx, 429, invalid JSON)
// returns a plain { error: string } that the calling tool surfaces to the
// agent. This function never throws - no silent hangs, no unsurfaced faults.
async function klaviyoFetch(
  apiKey: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: API_REVISION,
    Accept: 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const retryBase=Number(process.env.KLAVIYO_RETRY_BASE_MS||1000);
  for(let attempt=0;attempt<=2;attempt++){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
    try{
      const res=await fetch(url,{method,headers,body:body?JSON.stringify(body):undefined,signal:controller.signal});
      const text=await res.text();
      if((res.status===429||res.status>=500)&&attempt<2){const after=Number(res.headers.get('Retry-After'));await new Promise(r=>setTimeout(r,Number.isFinite(after)&&after>0?after*1000:Math.min(retryBase*2**attempt,5000)));continue;}
      if(!res.ok)return{error:`Klaviyo API error (${res.status}): ${text.slice(0,500)}`,retryable:res.status===429||res.status>=500};
      try{return JSON.parse(text);}catch(e:any){return{error:`Klaviyo returned invalid JSON (${res.status}) for ${path}: ${e?.message||e}`};}
    }catch(e:any){if(attempt===2){const reason=e?.name==='AbortError'?`timed out after ${REQUEST_TIMEOUT_MS/1000}s`:e?.message||String(e);return{error:`Klaviyo request failed (${method} ${path}): ${reason}`,retryable:true};}await new Promise(r=>setTimeout(r,Math.min(retryBase*2**attempt,5000)));}
    finally{clearTimeout(timer);}
  }
  return{error:`Klaviyo request failed (${method} ${path}): retry limit exhausted`,retryable:true};
}

// Follow `links.next` cursors to collect a full collection (GET list endpoints),
// bounded by `cap` items / `maxPages` so it can never run away.
async function klaviyoFetchAll(
  apiKey: string,
  path: string,
  cap = 500,
  maxPages = 60,
): Promise<{ data: any[]; error?: string; truncated?: boolean }> {
  const out: any[] = [];
  let url: string | null = path;
  let pages = 0;
  while (url && out.length < cap && pages < maxPages) {
    const res = (await klaviyoFetch(apiKey, url)) as any;
    if (res.error) return { data: out, error: res.error };
    out.push(...(res.data || []));
    pages++;
    const next = res.links?.next;
    if (next) {
      const u = new URL(next);
      url = u.pathname.replace(/^\/api/, '') + u.search;
    } else url = null;
  }
  return { data: out, truncated: !!url };
}

async function klaviyoFetchReportAll(
  apiKey:string,path:string,body:unknown,maxPages=60,
):Promise<{results:any[];dateTimes:string[];error?:string;truncated:boolean}>{
  const results:any[]=[];let dateTimes:string[]=[];let url:string|null=path;let pages=0;
  while(url&&pages<maxPages){
    const res=await klaviyoFetch(apiKey,url,'POST',body) as any;
    if(res.error)return{results,dateTimes,error:res.error,truncated:results.length>0};
    const attrs=res.data?.attributes||{};results.push(...(attrs.results||[]));
    if(dateTimes.length===0)dateTimes=attrs.date_times||[];
    pages++;const next=res.links?.next||res.data?.links?.next;
    if(next){const parsed=new URL(next);url=parsed.pathname.replace(/^\/api/,'')+parsed.search;}else url=null;
  }
  return{results,dateTimes,truncated:!!url,...(url?{error:`Reporting pagination safety cap reached after ${maxPages} pages.`}:{})};
}

// ── Timeframe / historical windowing ────────────────────────────

// The Klaviyo Reporting API (campaign/flow/segment/form value + series
// reports) holds aggregated data only from this FIXED epoch onward - it is
// NOT a rolling window, so reachable history grows over time. Requests that
// end before it have nothing to return. Adjust here if Klaviyo moves it.
const REPORTING_FLOOR_ISO = '2023-06-01';
const REPORTING_FLOOR_MS = Date.parse(`${REPORTING_FLOOR_ISO}T00:00:00+00:00`);
// Spacing between windowed reporting calls (2/min limit → ~31s apart).
const REPORTING_SPACING_MS = 31_000;

// Klaviyo rejects any single request whose span exceeds 1 calendar year
// ("timeframe is greater than 1 year", verified live). We window by calendar
// year so a full Jan–Dec year stays a single request and no window trips it.
function addOneYear(ms: number): number {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
}

interface TimeWindow {
  start: string; // ISO with +00:00 offset
  end: string;
  label: string; // YYYY-MM-DD..YYYY-MM-DD
}

type TfResolved =
  | { key: string }
  | { windows: TimeWindow[]; clamped: boolean };

const QUARTER_MONTHS: Record<number, [number, number]> = {
  1: [0, 2],
  2: [3, 5],
  3: [6, 8],
  4: [9, 11],
};

function toKlaviyoIso(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '+00:00');
}

// Parse YYYY-MM-DD or a full ISO string → epoch ms, or null if unparseable.
function parseUserDate(s: string): number | null {
  const t = s.trim();
  const ms = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00+00:00` : t,
  );
  return Number.isNaN(ms) ? null : ms;
}

// Build ≤1-year windows for a custom range, clamped to the reporting floor.
// Returns { error } for anything the caller must be told about (never silent).
function buildWindows(p: {
  start?: string;
  end?: string;
  quarter?: number;
  year?: number;
}): { windows?: TimeWindow[]; clamped?: boolean; error?: string } {
  let startMs: number;
  let endMs: number;

  if (p.quarter != null || p.year != null) {
    if (p.quarter == null || p.year == null) {
      return { error: 'Both quarter (1-4) and year are required together.' };
    }
    const months = QUARTER_MONTHS[p.quarter];
    if (!months) return { error: `Invalid quarter "${p.quarter}". Use 1-4.` };
    startMs = Date.UTC(p.year, months[0], 1, 0, 0, 0);
    endMs = Date.UTC(p.year, months[1] + 1, 1, 0, 0, 0) - 1000; // last sec of quarter
  } else {
    if (!p.start) {
      return { error: 'Provide start (and optionally end), or quarter+year.' };
    }
    const s = parseUserDate(p.start);
    if (s == null) {
      return { error: `Unparseable start "${p.start}". Use YYYY-MM-DD.` };
    }
    const e = p.end ? parseUserDate(p.end) : Date.now();
    if (e == null) {
      return { error: `Unparseable end "${p.end}". Use YYYY-MM-DD.` };
    }
    startMs = s;
    // A bare YYYY-MM-DD end means "include the whole day".
    endMs =
      p.end && /^\d{4}-\d{2}-\d{2}$/.test(p.end.trim()) ? e + 86_399_000 : e;
  }

  if (endMs <= startMs) {
    return {
      error: `end must be after start (start=${toKlaviyoIso(startMs)}, end=${toKlaviyoIso(endMs)}).`,
    };
  }
  if (endMs < REPORTING_FLOOR_MS) {
    return {
      error: `Reporting API has no data before ${REPORTING_FLOOR_ISO}; your range ends before that, so there is nothing to report.`,
    };
  }

  let clamped = false;
  if (startMs < REPORTING_FLOOR_MS) {
    startMs = REPORTING_FLOOR_MS;
    clamped = true;
  }
  // After clamping, an end at/near the floor can leave nothing - guard so the
  // windows array is never empty (rangeLabel would deref windows[0]).
  if (startMs >= endMs) {
    return {
      error: `After clamping to the Reporting API floor ${REPORTING_FLOOR_ISO}, no range remains to report.`,
    };
  }

  const windows: TimeWindow[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    // 1 calendar year minus 1s keeps each window strictly under Klaviyo's cap.
    const yearLimit = addOneYear(cursor) - 1000;
    const wEnd = Math.min(yearLimit, endMs);
    windows.push({
      start: toKlaviyoIso(cursor),
      end: toKlaviyoIso(wEnd),
      label: `${toKlaviyoIso(cursor).slice(0, 10)}..${toKlaviyoIso(wEnd).slice(0, 10)}`,
    });
    cursor = wEnd + 1000;
  }
  return { windows, clamped };
}

// Preset key vs custom window mode. Any of start/end/quarter/year → custom.
function resolveTimeframe(p: {
  timeframe?: string;
  start?: string;
  end?: string;
  quarter?: number;
  year?: number;
}): TfResolved | { error: string } {
  const custom =
    p.start != null || p.end != null || p.quarter != null || p.year != null;
  if (!custom) return { key: p.timeframe || 'last_30_days' };
  const b = buildWindows(p);
  if (b.error) return { error: b.error };
  return { windows: b.windows!, clamped: !!b.clamped };
}

// Custom-range Zod params shared by every timeframe-aware report tool.
const CUSTOM_RANGE_PARAMS = {
  start: z
    .string()
    .optional()
    .describe(
      `Custom range start, YYYY-MM-DD. Overrides timeframe. Data floor: ${REPORTING_FLOOR_ISO} (earlier is clamped).`,
    ),
  end: z
    .string()
    .optional()
    .describe('Custom range end, YYYY-MM-DD. Defaults to today.'),
  quarter: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe('Quarter 1-4 (with year) - convenience for a full quarter.'),
  year: z
    .number()
    .int()
    .min(2023)
    .max(2100)
    .optional()
    .describe('Year for quarter, e.g. 2024.'),
};

function clampNote(tf: TfResolved): string {
  return 'windows' in tf && tf.clamped
    ? `\n\n(Note: start was clamped to the Reporting API floor ${REPORTING_FLOOR_ISO}.)`
    : '';
}

// Human label of the resolved range so the agent/user can verify EXACTLY what
// was queried - critical when a relative ask ("last 2 years", "this quarter")
// was turned into concrete dates. Presets show the key; custom shows start..end.
function rangeLabel(tf: TfResolved): string {
  if ('key' in tf) return tf.key;
  const w = tf.windows;
  const from = w[0].label.split('..')[0];
  const to = w[w.length - 1].label.split('..')[1];
  return `${from}..${to}`;
}

// Klaviyo caps a series report's span by interval (verified live): hourly ≤ 7d,
// daily ≤ 60d, weekly/monthly ≤ ~52 weeks. Reject too-fine intervals with
// guidance instead of letting the API 400.
const SERIES_MAX_DAYS: Record<string, number> = {
  hourly: 7,
  daily: 60,
  weekly: 364,
  monthly: 364,
};
const PRESET_DAYS: Record<string, number> = {
  last_7_days: 7,
  last_30_days: 30,
  last_90_days: 90,
  last_12_months: 365,
  last_365_days: 365,
};
function maxWindowDays(tf: TfResolved): number {
  if ('key' in tf) return PRESET_DAYS[tf.key] ?? 365;
  return Math.max(
    ...tf.windows.map((w) =>
      Math.ceil((Date.parse(w.end) - Date.parse(w.start)) / 86_400_000),
    ),
  );
}
function checkSeriesInterval(interval: string, tf: TfResolved): string | null {
  const cap = SERIES_MAX_DAYS[interval] ?? 60;
  const d = maxWindowDays(tf);
  return d > cap
    ? `Klaviyo caps a "${interval}" series at ${cap} days per request; your range is ~${d} days. Use a coarser interval (monthly supports ~1 year) or a shorter range.`
    : null;
}

// Run a value-report across a resolved timeframe. Every window's error is
// surfaced explicitly - no window is silently skipped. Presets are one call.
async function fetchValueReport(
  acc: KlaviyoAccount,
  path: string,
  type: string,
  attributes: Record<string, unknown>,
  tf: TfResolved,
): Promise<{ label: string; results: any[]; error?: string; truncated?: boolean }[]> {
  const calls: { timeframe: unknown; label: string }[] =
    'key' in tf
      ? [{ timeframe: { key: tf.key }, label: tf.key }]
      : tf.windows.map((w) => ({
          timeframe: { start: w.start, end: w.end },
          label: w.label,
        }));

  const out: { label: string; results: any[]; error?: string; truncated?:boolean }[] = [];
  for (let i = 0; i < calls.length; i++) {
    const { timeframe, label } = calls[i];
    const data = await klaviyoFetchReportAll(acc.apiKey, path, {
      data: { type, attributes: { ...attributes, timeframe } },
    });
    if (data.error) out.push({ label, results: data.results, error: data.error, truncated:data.truncated });
    else out.push({ label, results: data.results, truncated:data.truncated });
    if (i < calls.length - 1) {
      await new Promise((r) => setTimeout(r, REPORTING_SPACING_MS));
    }
  }
  return out;
}

// Run a series (time-bucketed) report across a resolved timeframe. Each
// window's error is surfaced; windows are presented in order.
async function fetchSeriesReport(
  acc: KlaviyoAccount,
  path: string,
  type: string,
  attributes: Record<string, unknown>,
  tf: TfResolved,
): Promise<
  { label: string; dateTimes: string[]; results: any[]; error?: string; truncated?:boolean }[]
> {
  const calls: { timeframe: unknown; label: string }[] =
    'key' in tf
      ? [{ timeframe: { key: tf.key }, label: tf.key }]
      : tf.windows.map((w) => ({
          timeframe: { start: w.start, end: w.end },
          label: w.label,
        }));

  const out: {
    label: string;
    dateTimes: string[];
    results: any[];
    error?: string;
    truncated?:boolean;
  }[] = [];
  for (let i = 0; i < calls.length; i++) {
    const { timeframe, label } = calls[i];
    const data = await klaviyoFetchReportAll(acc.apiKey, path, {
      data: { type, attributes: { ...attributes, timeframe } },
    });
    if (data.error) out.push({ label, dateTimes: data.dateTimes, results: data.results, error: data.error, truncated:data.truncated });
    else
      out.push({
        label,
        dateTimes: data.dateTimes,
        results: data.results,
        truncated:data.truncated,
      });
    if (i < calls.length - 1) {
      await new Promise((r) => setTimeout(r, REPORTING_SPACING_MS));
    }
  }
  return out;
}

// ── MCP Server ──────────────────────────────────────────────────

const mcp = new FastMCP({ name: 'klaviyo', version: '1.0.0' });

// Klaviyo's tool bodies below return a plain summary string (matching the
// production shape). withReply wraps each definition's execute so callers
// always see the shared reply contract: a classified plain-JSON reply on
// success, or a thrown UserError (via fail()) on a hard failure. The
// classification regexes match the strings each tool already returns.
interface KlaviyoToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
  annotations?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

const HARD_ERROR_RE =
  /^(Account .*not found|Klaviyo API error|Klaviyo request failed|Rate limited|Invalid |Both quarter|Provide start|Unparseable |.* requires conversion_metric_id|Klaviyo caps )/i;
const RETRYABLE_RE = /429|Rate limited|timed out|request failed|API error \(5/i;
const PARTIAL_RE = /ERROR:|\(truncated\)|\+ \(truncated\)|could not load|Next cursor:/i;
const NO_OP_RE = /^No /i;

function withReply(definition: KlaviyoToolDefinition): KlaviyoToolDefinition {
  const execute = definition.execute;
  return {
    ...definition,
    execute: async (args: Record<string, unknown>) => {
      let text: string;
      try {
        const raw = await execute(args);
        text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      } catch (error) {
        if (error instanceof Error) throw error;
        fail('klaviyo_tool_failed', String(error), 'Correct input or account configuration before retrying.');
      }

      if (HARD_ERROR_RE.test(text)) {
        const retryable = RETRYABLE_RE.test(text);
        fail(
          retryable ? 'upstream_failure' : 'invalid_request',
          text,
          retryable
            ? 'Retry once after the stated delay; stop if it fails again.'
            : 'Correct account, range, identifiers, or required metric before retrying.',
        );
      }

      const partial = PARTIAL_RE.test(text);
      const noOp = NO_OP_RE.test(text);
      return reply({
        status: partial ? 'partial' : noOp ? 'no_op' : 'succeeded',
        operation: definition.name,
        summary: partial
          ? `${definition.name} returned partial Klaviyo data.`
          : `${definition.name} succeeded.`,
        target: { type: 'klaviyo_account', account: args.account ?? null },
        result: { text },
        proof: { apiRevision: API_REVISION, complete: !partial },
        warnings: partial
          ? ['One or more pages/windows failed, remain cursor-paginated, or hit a safety cap; do not treat this result as complete.']
          : [],
        recovery: partial
          ? { nextAction: 'Continue with the returned cursor or retry only the failed page/window; preserve successful sections.' }
          : undefined,
      });
    },
  };
}

const rawAddTool = mcp.addTool.bind(mcp);
mcp.addTool = ((definition: KlaviyoToolDefinition) => rawAddTool(withReply(definition) as never)) as typeof mcp.addTool;

// Tool 1: List accounts
mcp.addTool({
  name: 'list_accounts',
  annotations: { title: 'List configured Klaviyo accounts', readOnlyHint: true, openWorldHint: true },
  description:
    'List all configured Klaviyo accounts. Use this first to see which brands are available.',
  parameters: z.object({}),
  execute: async () => {
    const accounts = discoverAccounts();
    if (accounts.length === 0) {
      return 'No Klaviyo accounts configured. Add KLAVIYO_KEY_{NAME}=pk_xxx to .env.';
    }
    const lines = accounts.map((a) => `• ${a.displayName} (${a.name})`);
    return `${accounts.length} Klaviyo accounts:\n${lines.join('\n')}`;
  },
});

// Tool 2: List campaigns for an account
mcp.addTool({
  name: 'list_campaigns',
  annotations: { title: 'List email campaigns', readOnlyHint: true, openWorldHint: true },
  description:
    'List recent email campaigns for a specific Klaviyo account. Returns campaign IDs, names, status, and send dates.',
  parameters: z.object({
    account: z
      .string()
      .describe("Account name (e.g., 'my-store' or 'My Store')"),
    status: z
      .enum([
        'Draft',
        'Queued without Recipients',
        'Scheduled',
        'Sending',
        'Sent',
        'Cancelled',
      ])
      .optional()
      .describe(
        'Filter by campaign status (case-sensitive Klaviyo values). Default: all.',
      ),
  }),
  execute: async ({ account, status }) => {
    const acc = getAccount(account);
    if (!acc) {
      const available = discoverAccounts()
        .map((a) => a.displayName)
        .join(', ');
      return `Account "${account}" not found. Available: ${available}`;
    }
    let filter = "equals(messages.channel,'email')";
    if (status) filter += `,equals(status,'${status}')`;

    const data = await klaviyoFetchAll(
      acc.apiKey,
      `/campaigns?filter=${encodeURIComponent(filter)}&sort=-created_at&fields[campaign]=name,status,created_at,updated_at,send_time&page[size]=100`,
      2000,
    );

    if (data.error) return data.error;
    const campaigns = data.data;
    if (campaigns.length === 0)
      return `No campaigns found for ${acc.displayName}.`;

    const lines = campaigns.map((c: any) => {
      const attr = c.attributes;
      return `• ${attr.name} | Status: ${attr.status} | Sent: ${attr.send_time || 'not sent'} | ID: ${c.id}`;
    });
    return `${acc.displayName} - ${campaigns.length} campaigns${data.truncated ? '+ (truncated)' : ''} (send dates included - join to campaign_report by ID for monthly buckets):\n${lines.join('\n')}`;
  },
});

// Tool 3: Campaign performance report
mcp.addTool({
  name: 'campaign_report',
  annotations: { title: 'Get campaign performance metrics', readOnlyHint: true, openWorldHint: true },
  description:
    'Get email campaign performance metrics for a Klaviyo account. Returns opens, clicks, revenue, bounce rate, unsubscribes for the specified time period. Rate limited: 2/min.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    timeframe: z
      .enum(TIMEFRAME_KEYS)
      .optional()
      .describe('Preset period. Default: last_30_days. Ignored if a custom range is given.'),
    conversion_metric_id: z
      .string()
      .describe(
        'Metric ID for revenue tracking (Placed Order). REQUIRED by Klaviyo API. Get from list_metrics tool first.',
      ),
    ...CUSTOM_RANGE_PARAMS,
  }),
  execute: async ({ account, timeframe, conversion_metric_id, start, end, quarter, year }) => {
    const acc = getAccount(account);
    if (!acc) {
      const available = discoverAccounts()
        .map((a) => a.displayName)
        .join(', ');
      return `Account "${account}" not found. Available: ${available}`;
    }

    const tf = resolveTimeframe({ timeframe, start, end, quarter, year });
    if ('error' in tf) return `${acc.displayName}: ${tf.error}`;

    const stats = [
      'recipients',
      'opens',
      'open_rate',
      'clicks',
      'click_rate',
      'bounce_rate',
      'unsubscribe_rate',
      'spam_complaint_rate',
      'conversion_rate',
      'conversion_value',
      'revenue_per_recipient',
    ];

    const windows = await fetchValueReport(
      acc,
      '/campaign-values-reports/',
      'campaign-values-report',
      {
        statistics: stats,
        conversion_metric_id,
        filter: "equals(send_channel,'email')",
      },
      tf,
    );

    const fmt = (r: any) => {
      const s = r.statistics;
      const campaignId = r.groupings?.campaign_id || 'unknown';
      let line = `Campaign ${campaignId}:\n`;
      line += `  Recipients: ${(s.recipients ?? 0).toLocaleString()}\n`;
      line += `  Open: ${((s.open_rate ?? 0) * 100).toFixed(1)}% | Click: ${((s.click_rate ?? 0) * 100).toFixed(1)}% | Bounce: ${((s.bounce_rate ?? 0) * 100).toFixed(2)}% | Unsub: ${((s.unsubscribe_rate ?? 0) * 100).toFixed(2)}%\n`;
      line += `  Revenue: $${(s.conversion_value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | RPR: $${(s.revenue_per_recipient ?? 0).toFixed(4)} | Conv: ${((s.conversion_rate ?? 0) * 100).toFixed(2)}%`;
      return line;
    };

    const multi = !('key' in tf) && windows.length > 1;
    const sections = windows.map((w) => {
      const head = multi ? `━━ ${w.label} ━━\n` : '';
      if (w.error) return `${head}ERROR: ${w.error}`;
      if (w.results.length === 0) return `${head}No campaign data.`;
      return head + w.results.map(fmt).join('\n\n');
    });

    return `${acc.displayName} - Campaign Report (${rangeLabel(tf)}):\n\n${sections.join('\n\n')}${clampNote(tf)}`;
  },
});

// Tool 4: List metrics (needed to find Placed Order metric ID for revenue)
mcp.addTool({
  name: 'list_metrics',
  annotations: { title: 'List available metrics', readOnlyHint: true, openWorldHint: true },
  description:
    "List available metrics for a Klaviyo account. Use this to find the 'Placed Order' metric ID needed for revenue reporting.",
  parameters: z.object({
    account: z.string().describe('Account name'),
  }),
  execute: async ({ account }) => {
    const acc = getAccount(account);
    if (!acc) {
      const available = discoverAccounts()
        .map((a) => a.displayName)
        .join(', ');
      return `Account "${account}" not found. Available: ${available}`;
    }

    const data = await klaviyoFetchAll(acc.apiKey, '/metrics');

    if (data.error) return data.error;
    const metrics = data.data;
    if (metrics.length === 0) return `No metrics found for ${acc.displayName}.`;

    const relevant = metrics
      .filter((m: any) => {
        const name = (m.attributes?.name || '').toLowerCase();
        return (
          name.includes('order') ||
          name.includes('revenue') ||
          name.includes('open') ||
          name.includes('click') ||
          name.includes('bounce') ||
          name.includes('unsubscribe') ||
          name.includes('received') ||
          name.includes('subscribed')
        );
      })
      .map(
        (m: any) =>
          `• ${m.attributes.name} | ID: ${m.id} | Integration: ${m.attributes.integration?.name || 'n/a'}`,
      );

    const placedCount = metrics.filter(
      (m: any) => (m.attributes?.name || '').toLowerCase() === 'placed order',
    ).length;
    const dupWarn =
      placedCount > 1
        ? `\n\n⚠ ${placedCount} metrics named "Placed Order" exist - they are NOT interchangeable; usually only the e-commerce-integration one carries revenue (the others read $0). Prefer the curated ID from the klaviyo skill table; if unsure, test each with a short campaign_report and pick the one returning non-zero revenue.`
        : '';
    return `${acc.displayName} - Key metrics (${relevant.length} of ${metrics.length} total):\n${relevant.join('\n')}\n\nUse the "Placed Order" metric ID as conversion_metric_id for revenue.${dupWarn}`;
  },
});

// Tool 5: Multi-account summary
mcp.addTool({
  name: 'multi_account_summary',
  annotations: { title: 'Pull cross-account campaign summary', readOnlyHint: true, openWorldHint: true },
  description:
    'Pull campaign performance summary from ALL configured Klaviyo accounts. Returns a unified cross-brand report. Rate limited: 2/min per account - may take several minutes for many accounts.',
  parameters: z.object({
    timeframe: z
      .enum(TIMEFRAME_KEYS)
      .optional()
      .describe('Preset period. Default: last_30_days. Ignored if a custom range is given.'),
    conversion_metric_ids: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Map of account name → Placed Order metric ID (from the klaviyo skill table). STRONGLY recommended: accounts often have duplicate "Placed Order" metrics and auto-discovery can pick the wrong one (revenue reads $0). Keys match names from list_accounts.',
      ),
    ...CUSTOM_RANGE_PARAMS,
  }),
  execute: async ({ timeframe, conversion_metric_ids, start, end, quarter, year }) => {
    const accounts = discoverAccounts();
    if (accounts.length === 0) return 'No Klaviyo accounts configured.';

    const tf = resolveTimeframe({ timeframe, start, end, quarter, year });
    if ('error' in tf) return tf.error;
    if ('windows' in tf && tf.windows.length > 1)
      return 'Cross-brand summary supports a single period up to 1 year. Narrow the range, or use campaign_report per account for multi-year.';
    const tfObj: any =
      'key' in tf ? { key: tf.key } : { start: tf.windows[0].start, end: tf.windows[0].end };
    const tfLabel = rangeLabel(tf);

    const summaries: string[] = [];
    const skipped: string[] = [];
    // Accounts we will actually query (have a curated ID) - used for rate-limit spacing.
    const toQuery = accounts.filter(
      (a) => conversion_metric_ids?.[a.name] || conversion_metric_ids?.[a.displayName],
    );
    for (const a of accounts) {
      if (!(conversion_metric_ids?.[a.name] || conversion_metric_ids?.[a.displayName]))
        skipped.push(a.displayName);
    }

    for (let qi = 0; qi < toQuery.length; qi++) {
      const acc = toQuery[qi];
      const convMetricId =
        conversion_metric_ids![acc.name] || conversion_metric_ids![acc.displayName];

      const body = {
        data: {
          type: 'campaign-values-report',
          attributes: {
            timeframe: tfObj,
            conversion_metric_id: convMetricId,
            filter: "equals(send_channel,'email')",
            statistics: [
              'recipients',
              'delivered',
              'opens_unique',
              'clicks_unique',
              'conversion_value',
            ],
          },
        },
      };

      const data = await klaviyoFetchReportAll(
        acc.apiKey,
        '/campaign-values-reports/',
        body,
      );

      if (data.error) {
        summaries.push(`${acc.displayName}: ${data.error}`);
      } else {
        const results = data.results;
        if (results.length === 0) {
          summaries.push(`${acc.displayName}: No email campaigns in period`);
        } else {
          // Weighted, count-based aggregation (not an average of per-row rates).
          let recip = 0,
            delivered = 0,
            opensU = 0,
            clicksU = 0,
            revenue = 0;
          const campaignIds = new Set<string>();
          for (const r of results) {
            const s = r.statistics || {};
            recip += s.recipients ?? 0;
            delivered += s.delivered ?? 0;
            opensU += s.opens_unique ?? 0;
            clicksU += s.clicks_unique ?? 0;
            revenue += s.conversion_value ?? 0;
            if (r.groupings?.campaign_id) campaignIds.add(r.groupings.campaign_id);
          }
          const openRate = delivered ? (opensU / delivered) * 100 : 0;
          const clickRate = delivered ? (clicksU / delivered) * 100 : 0;
          summaries.push(
            `${acc.displayName}: ${campaignIds.size || results.length} campaigns | ${recip.toLocaleString()} recipients | Open ${openRate.toFixed(1)}% | Click ${clickRate.toFixed(1)}% | Revenue $${revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          );
        }
      }

      if (qi < toQuery.length - 1) {
        await new Promise((r) => setTimeout(r, 31_000));
      }
    }

    const skipNote = skipped.length
      ? `\n\n⚠ Skipped (no conversion_metric_id provided - campaign reports require it): ${skipped.join(', ')}. Pass conversion_metric_ids from the klaviyo skill table to include them.`
      : '';
    return `Cross-Account Summary - email (${tfLabel}):\n\n${summaries.join('\n') || '(no accounts queried)'}${skipNote}`;
  },
});

// Tool 6: Flow report
mcp.addTool({
  name: 'flow_report',
  annotations: { title: 'Get email flow performance', readOnlyHint: true, openWorldHint: true },
  description:
    'Get email flow (automation) performance for a Klaviyo account. Returns metrics for welcome series, abandoned cart, post-purchase, etc.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    conversion_metric_id: z
      .string()
      .describe(
        'Metric ID for revenue tracking (Placed Order). REQUIRED. Get from list_metrics tool first.',
      ),
    timeframe: z
      .enum(TIMEFRAME_KEYS)
      .optional()
      .describe('Preset period. Default: last_30_days. Ignored if a custom range is given.'),
    ...CUSTOM_RANGE_PARAMS,
  }),
  execute: async ({ account, conversion_metric_id, timeframe, start, end, quarter, year }) => {
    const acc = getAccount(account);
    if (!acc) {
      const available = discoverAccounts()
        .map((a) => a.displayName)
        .join(', ');
      return `Account "${account}" not found. Available: ${available}`;
    }

    const tf = resolveTimeframe({ timeframe, start, end, quarter, year });
    if ('error' in tf) return `${acc.displayName}: ${tf.error}`;

    const windows = await fetchValueReport(
      acc,
      '/flow-values-reports/',
      'flow-values-report',
      {
        conversion_metric_id,
        filter: "equals(send_channel,'email')",
        statistics: [
          'recipients',
          'open_rate',
          'click_rate',
          'bounce_rate',
          'unsubscribe_rate',
          'conversion_value',
          'revenue_per_recipient',
        ],
      },
      tf,
    );

    const fmt = (r: any) => {
      const s = r.statistics;
      const flowId = r.groupings?.flow_id || 'unknown';
      const rev = s.conversion_value ?? 0;
      let line = `Flow ${flowId}: Sent ${(s.recipients ?? 0).toLocaleString()} | Open ${((s.open_rate ?? 0) * 100).toFixed(1)}% | Click ${((s.click_rate ?? 0) * 100).toFixed(1)}%`;
      if (rev > 0)
        line += ` | Revenue: $${rev.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      return line;
    };

    const multi = !('key' in tf) && windows.length > 1;
    const sections = windows.map((w) => {
      const head = multi ? `━━ ${w.label} ━━\n` : '';
      if (w.error) return `${head}ERROR: ${w.error}`;
      if (w.results.length === 0) return `${head}No flow data.`;
      return head + w.results.map(fmt).join('\n');
    });

    return `${acc.displayName} - Flow Report (${rangeLabel(tf)}):\n${sections.join('\n\n')}${clampNote(tf)}`;
  },
});

// ── Tier 1: A/B + Series + Audience Reports ────────────────────

// Tool 7: Campaign A/B variation report
mcp.addTool({
  name: 'campaign_ab_report',
  annotations: { title: 'Get campaign A/B metrics', readOnlyHint: true, openWorldHint: true },
  description:
    'Get per-variation (A/B arm) email/SMS campaign metrics for a Klaviyo account. Splits results by variation so you can compare arms. Rate limited: 2/min.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    conversion_metric_id: z
      .string()
      .describe('Placed Order metric ID. Get from list_metrics.'),
    timeframe: z.enum(TIMEFRAME_KEYS).optional(),
    campaign_id: z
      .string()
      .optional()
      .describe('Filter to a single campaign ID.'),
    ...CUSTOM_RANGE_PARAMS,
  }),
  execute: async ({
    account,
    conversion_metric_id,
    timeframe,
    campaign_id,
    start,
    end,
    quarter,
    year,
  }) => {
    const acc = getAccount(account);
    if (!acc)
      return `Account "${account}" not found. Available: ${discoverAccounts()
        .map((a) => a.displayName)
        .join(', ')}`;

    const tf = resolveTimeframe({ timeframe, start, end, quarter, year });
    if ('error' in tf) return `${acc.displayName}: ${tf.error}`;

    const attributes: any = {
      conversion_metric_id,
      statistics: [
        'recipients',
        'open_rate',
        'click_rate',
        'conversion_rate',
        'conversion_value',
        'revenue_per_recipient',
        'unsubscribe_rate',
      ],
      group_by: [
        'variation',
        'variation_name',
        'campaign_message_id',
        'campaign_id',
        'send_channel',
      ],
    };
    if (campaign_id) {
      attributes.filter = `equals(campaign_id,"${safeId(campaign_id, 'campaign_id')}")`;
    }

    const windows = await fetchValueReport(
      acc,
      '/campaign-values-reports/',
      'campaign-values-report',
      attributes,
      tf,
    );

    const fmt = (r: any) => {
      const s = r.statistics;
      const g = r.groupings || {};
      const variation = g.variation_name || g.variation || 'default';
      const channel = g.send_channel || 'email';
      return (
        `Variation "${variation}" (${channel}) campaign=${g.campaign_id}:\n` +
        `  Recipients: ${(s.recipients ?? 0).toLocaleString()} | ` +
        `Open: ${((s.open_rate ?? 0) * 100).toFixed(2)}% | ` +
        `Click: ${((s.click_rate ?? 0) * 100).toFixed(2)}% | ` +
        `Conv: ${((s.conversion_rate ?? 0) * 100).toFixed(2)}% | ` +
        `Unsub: ${((s.unsubscribe_rate ?? 0) * 100).toFixed(2)}% | ` +
        `Revenue: $${(s.conversion_value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ` +
        `RPR: $${(s.revenue_per_recipient ?? 0).toFixed(4)}`
      );
    };

    const multi = !('key' in tf) && windows.length > 1;
    const sections = windows.map((w) => {
      const head = multi ? `━━ ${w.label} ━━\n` : '';
      if (w.error) return `${head}ERROR: ${w.error}`;
      if (w.results.length === 0) return `${head}No A/B variation data.`;
      return head + w.results.map(fmt).join('\n\n');
    });
    return `${acc.displayName} - A/B Report (${rangeLabel(tf)}):\n\n${sections.join('\n\n')}${clampNote(tf)}`;
  },
});

// NOTE: There is NO campaign-series endpoint in Klaviyo (/campaign-series-reports/
// returns 404 - verified live). For campaign metrics over time use one of:
//   • metric_aggregate on the Placed Order metric (measurement sum_value, interval
//     month) → total revenue trend, one fast call (NOT campaign-attributed);
//   • campaign_report once per month/quarter, then bucket → campaign-attributed.
// Series reports exist only for flows, forms, and segments.

// Tool 8: Flow series (time-bucketed)
mcp.addTool({
  name: 'flow_series_report',
  annotations: { title: 'Get time-series flow metrics', readOnlyHint: true, openWorldHint: true },
  description:
    'Time-series flow (automation) metrics for a Klaviyo account. Buckets by interval. Rate limited: 2/min.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    conversion_metric_id: z.string().describe('Placed Order metric ID.'),
    interval: z.enum(INTERVAL_KEYS).optional(),
    timeframe: z.enum(TIMEFRAME_KEYS).optional(),
    ...CUSTOM_RANGE_PARAMS,
  }),
  execute: async ({ account, conversion_metric_id, interval, timeframe, start, end, quarter, year }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;

    const tf = resolveTimeframe({ timeframe, start, end, quarter, year });
    if ('error' in tf) return `${acc.displayName}: ${tf.error}`;
    const iv = interval || 'daily';
    const ivErr = checkSeriesInterval(iv, tf);
    if (ivErr) return `${acc.displayName}: ${ivErr}`;

    const windows = await fetchSeriesReport(
      acc,
      '/flow-series-reports/',
      'flow-series-report',
      {
        interval: iv,
        conversion_metric_id,
        filter: "equals(send_channel,'email')",
        statistics: ['recipients', 'open_rate', 'click_rate', 'conversion_value'],
      },
      tf,
    );

    const lines: string[] = [
      `${acc.displayName} - Flow Series (${interval || 'daily'} / ${rangeLabel(tf)}):`,
    ];
    const multi = !('key' in tf) && windows.length > 1;
    for (const w of windows) {
      if (multi) lines.push(`\n━━ ${w.label} ━━`);
      if (w.error) {
        lines.push(`ERROR: ${w.error}`);
        continue;
      }
      if (w.results.length === 0) {
        lines.push('No flow series data.');
        continue;
      }
      for (const r of w.results) {
        const s = r.statistics || {};
        lines.push(`\nFlow ${r.groupings?.flow_id || 'unknown'}:`);
        for (let i = 0; i < w.dateTimes.length; i++) {
          const dt = (w.dateTimes[i] || '').slice(0, 10);
          lines.push(
            `  ${dt}: recip=${(s.recipients?.[i] ?? 0).toLocaleString()} ` +
              `open=${((s.open_rate?.[i] ?? 0) * 100).toFixed(1)}% ` +
              `click=${((s.click_rate?.[i] ?? 0) * 100).toFixed(1)}% ` +
              `rev=$${(s.conversion_value?.[i] ?? 0).toFixed(2)}`,
          );
        }
      }
    }
    return lines.join('\n') + clampNote(tf);
  },
});

// Tool 10: Segment report
mcp.addTool({
  name: 'segment_report',
  annotations: { title: 'Get segment performance metrics', readOnlyHint: true, openWorldHint: true },
  description:
    'Segment performance metrics for a Klaviyo account: member counts, additions, removals. Rate limited: 2/min.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    timeframe: z.enum(TIMEFRAME_KEYS).optional(),
    ...CUSTOM_RANGE_PARAMS,
  }),
  execute: async ({ account, timeframe, start, end, quarter, year }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;

    const tf = resolveTimeframe({ timeframe, start, end, quarter, year });
    if ('error' in tf) return `${acc.displayName}: ${tf.error}`;

    const windows = await fetchValueReport(
      acc,
      '/segment-values-reports/',
      'segment-values-report',
      {
        statistics: [
          'total_members',
          'members_added',
          'members_removed',
          'net_members_changed',
        ],
      },
      tf,
    );

    const fmt = (r: any) => {
      const s = r.statistics;
      const g = r.groupings || {};
      return (
        `Segment ${g.segment_id}: members=${(s.total_members ?? 0).toLocaleString()} ` +
        `added=${(s.members_added ?? 0).toLocaleString()} ` +
        `removed=${(s.members_removed ?? 0).toLocaleString()} ` +
        `net=${(s.net_members_changed ?? 0).toLocaleString()}`
      );
    };
    const multi = !('key' in tf) && windows.length > 1;
    const sections = windows.map((w) => {
      const head = multi ? `━━ ${w.label} ━━\n` : '';
      if (w.error) return `${head}ERROR: ${w.error}`;
      if (w.results.length === 0) return `${head}No segment data.`;
      return head + w.results.map(fmt).join('\n');
    });
    return `${acc.displayName} - Segment Report (${rangeLabel(tf)}):\n${sections.join('\n\n')}${clampNote(tf)}`;
  },
});

// Tool 11: Form report
mcp.addTool({
  name: 'form_report',
  annotations: { title: 'Get sign-up form performance', readOnlyHint: true, openWorldHint: true },
  description:
    'Sign-up form performance for a Klaviyo account: views, submissions, submit rate. Rate limited: 2/min.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    timeframe: z.enum(TIMEFRAME_KEYS).optional(),
    ...CUSTOM_RANGE_PARAMS,
  }),
  execute: async ({ account, timeframe, start, end, quarter, year }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;

    const tf = resolveTimeframe({ timeframe, start, end, quarter, year });
    if ('error' in tf) return `${acc.displayName}: ${tf.error}`;

    const windows = await fetchValueReport(
      acc,
      '/form-values-reports/',
      'form-values-report',
      {
        statistics: [
          'viewed_form',
          'viewed_form_uniques',
          'submits',
          'submit_rate',
          'qualified_form',
          'closed_form',
        ],
      },
      tf,
    );

    const fmt = (r: any) => {
      const s = r.statistics;
      const g = r.groupings || {};
      return (
        `Form ${g.form_id}: views=${(s.viewed_form ?? 0).toLocaleString()} ` +
        `submits=${(s.submits ?? 0).toLocaleString()} ` +
        `submit_rate=${((s.submit_rate ?? 0) * 100).toFixed(2)}% ` +
        `qualified=${(s.qualified_form ?? 0).toLocaleString()}`
      );
    };
    const multi = !('key' in tf) && windows.length > 1;
    const sections = windows.map((w) => {
      const head = multi ? `━━ ${w.label} ━━\n` : '';
      if (w.error) return `${head}ERROR: ${w.error}`;
      if (w.results.length === 0) return `${head}No form data.`;
      return head + w.results.map(fmt).join('\n');
    });
    return `${acc.displayName} - Form Report (${rangeLabel(tf)}):\n${sections.join('\n\n')}${clampNote(tf)}`;
  },
});

// Tool 12: List segments
mcp.addTool({
  name: 'list_segments',
  annotations: { title: 'List account segments', readOnlyHint: true, openWorldHint: true },
  description:
    'List all segments in a Klaviyo account with name, member count, and creation date.',
  parameters: z.object({
    account: z.string().describe('Account name'),
  }),
  execute: async ({ account }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;
    const data = await klaviyoFetchAll(
      acc.apiKey,
      '/segments?fields[segment]=name,created,updated,is_active&page[size]=10',
    );
    if (data.error) return data.error;

    const segments = data.data;
    if (segments.length === 0) return `No segments for ${acc.displayName}.`;
    const lines = segments.map((s: any) => {
      const a = s.attributes;
      return `• ${a.name} | active: ${a.is_active ? 'yes' : 'no'} | created: ${(a.created || '').slice(0, 10)} | updated: ${(a.updated || '').slice(0, 10)} | ID: ${s.id}`;
    });
    return `${acc.displayName} - ${segments.length} segments${data.truncated ? '+ (truncated)' : ''} (use segment_report for member counts):\n${lines.join('\n')}`;
  },
});

// Tool 13: List lists
mcp.addTool({
  name: 'list_lists',
  annotations: { title: 'List email lists', readOnlyHint: true, openWorldHint: true },
  description:
    'List all email lists in a Klaviyo account with name, opt-in process, and creation date.',
  parameters: z.object({
    account: z.string().describe('Account name'),
  }),
  execute: async ({ account }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;
    const data = await klaviyoFetchAll(
      acc.apiKey,
      '/lists?fields[list]=name,created,updated,opt_in_process&page[size]=10',
    );
    if (data.error) return data.error;

    const lists = data.data;
    if (lists.length === 0) return `No lists for ${acc.displayName}.`;
    const lines = lists.map((l: any) => {
      const a = l.attributes;
      return `• ${a.name} | opt-in: ${a.opt_in_process || 'n/a'} | created: ${(a.created || '').slice(0, 10)} | updated: ${(a.updated || '').slice(0, 10)} | ID: ${l.id}`;
    });
    return `${acc.displayName} - ${lists.length} lists${data.truncated ? '+ (truncated)' : ''}:\n${lines.join('\n')}`;
  },
});

// Tool 14: List flows
mcp.addTool({
  name: 'list_flows',
  annotations: { title: 'List account flows', readOnlyHint: true, openWorldHint: true },
  description:
    'List all flows (automations) in a Klaviyo account with name, status, trigger type, and last updated.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    status: z
      .enum(['draft', 'manual', 'live'])
      .optional()
      .describe('Filter by status.'),
  }),
  execute: async ({ account, status }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;
    let path =
      '/flows?fields[flow]=name,status,trigger_type,created,updated&page[size]=50';
    if (status)
      path += `&filter=${encodeURIComponent(`equals(status,'${status}')`)}`;

    const data = await klaviyoFetchAll(acc.apiKey, path);
    if (data.error) return data.error;

    const flows = data.data;
    if (flows.length === 0) return `No flows for ${acc.displayName}.`;
    const lines = flows.map((f: any) => {
      const a = f.attributes;
      return `• ${a.name} | status: ${a.status} | trigger: ${a.trigger_type || 'n/a'} | updated: ${(a.updated || '').slice(0, 10)} | ID: ${f.id}`;
    });
    return `${acc.displayName} - ${flows.length} flows${data.truncated ? '+ (truncated)' : ''}:\n${lines.join('\n')}`;
  },
});

// Tool 15: Get campaign detail
mcp.addTool({
  name: 'get_campaign_detail',
  annotations: { title: 'Get campaign details', readOnlyHint: true, openWorldHint: true },
  description:
    'Get full details for a single campaign by ID: name, status, send_time, subject, preview text, channel, and message IDs.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    campaign_id: z.string().describe('Campaign ID.'),
  }),
  execute: async ({ account, campaign_id }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;

    const data = (await klaviyoFetch(
      acc.apiKey,
      `/campaigns/${safeId(campaign_id, 'campaign_id')}?include=campaign-messages`,
    )) as any;
    if (data.error) return data.error;

    const c = data.data;
    if (!c) return `Campaign ${campaign_id} not found.`;
    const a = c.attributes || {};
    const messages = (data.included || []).filter(
      (x: any) => x.type === 'campaign-message',
    );

    const header =
      `Campaign ${c.id}: ${a.name}\n` +
      `  Status: ${a.status} | Send method: ${a.send_strategy?.method || 'n/a'}\n` +
      `  Created: ${a.created_at || 'n/a'} | Scheduled: ${a.send_time || 'n/a'}\n` +
      `  Audiences (included): ${(a.audiences?.included || []).join(', ') || 'n/a'}\n` +
      `  Audiences (excluded): ${(a.audiences?.excluded || []).join(', ') || 'none'}`;

    const msgLines = messages.map((m: any) => {
      const ma = m.attributes || {};
      const content = ma.definition?.content || {};
      const channel = ma.definition?.channel || ma.channel || 'email';
      return (
        `  Message ${m.id} (${channel}):\n` +
        `    Subject: ${content.subject || 'n/a'}\n` +
        `    Preview: ${content.preview_text || 'n/a'}\n` +
        `    From: ${content.from_email || 'n/a'} <${content.from_label || 'n/a'}>`
      );
    });

    return [header, '', 'Messages:', ...msgLines].join('\n');
  },
});

// Tool 16: List suppressed profiles
mcp.addTool({
  name: 'list_suppressed_profiles',
  annotations: { title: 'List suppressed profiles', readOnlyHint: true, openWorldHint: true },
  description:
    'List profiles suppressed from email marketing for a single reason. Klaviyo only allows `equals` (not `any`) for suppression.reason, so call once per reason if you need a full picture. Up to 100 per call. Use cursor for pagination.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    reason: z
      .enum([
        'unsubscribe',
        'hard_bounce',
        'spam_complaint',
        'user_suppressed',
        'invalid_email',
      ])
      .describe(
        'Suppression reason. Required - Klaviyo allows only `equals` here.',
      ),
    page_cursor: z.string().optional().describe('Cursor from previous page.'),
  }),
  execute: async ({ account, reason, page_cursor }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;
    const apiReason=reason.toUpperCase();
    const filter = `equals(subscriptions.email.marketing.suppression.reason,"${apiReason}")`;
    let path = `/profiles?fields[profile]=email,first_name,last_name,created&additional-fields[profile]=subscriptions&filter=${encodeURIComponent(filter)}&page[size]=100`;
    if (page_cursor) path += `&page[cursor]=${encodeURIComponent(page_cursor)}`;

    const data = (await klaviyoFetch(acc.apiKey, path)) as any;
    if (data.error) return data.error;
    const profiles = data.data || [];
    if (profiles.length === 0)
      return `No suppressed profiles for ${acc.displayName}${reason ? ` (reason=${reason})` : ''}.`;

    const lines = profiles.map((p: any) => {
      const a = p.attributes || {};
      const sup = a.subscriptions?.email?.marketing?.suppression;
      const arr = Array.isArray(sup) ? sup : sup ? [sup] : [];
      // Prefer the suppression record matching the requested reason, not just [0].
      const match =
        arr.find(
          (x: any) => (x?.reason || '').toUpperCase() === apiReason,
        ) ||
        arr[0] ||
        {};
      const supReason = (match.reason || 'unknown').toLowerCase();
      const supTime = (match.timestamp || '').slice(0, 10);
      return `• ${a.email || '(no email)'} | reason: ${supReason} | at: ${supTime} | ID: ${p.id}`;
    });
    const nextCursor = data.links?.next
      ? new URL(data.links.next).searchParams.get('page[cursor]')
      : null;
    const footer = nextCursor ? `\n\nNext cursor: ${nextCursor}` : '';
    return `${acc.displayName} - ${profiles.length} suppressed profiles${reason ? ` (${reason})` : ''}:\n${lines.join('\n')}${footer}`;
  },
});

// ── Tier 2: Misc reads ──────────────────────────────────────────

// Tool 17: Metric aggregate
mcp.addTool({
  name: 'metric_aggregate',
  annotations: { title: 'Aggregate metric values', readOnlyHint: true, openWorldHint: true },
  description:
    'Aggregate values for any Klaviyo metric (e.g. opens, clicks, revenue) over a custom timeframe + interval. More flexible than campaign/flow reports - use for any metric.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    metric_id: z.string().describe('Metric ID. Get from list_metrics.'),
    measurement: z
      .enum(['count', 'sum_value', 'unique'])
      .optional()
      .describe('count, sum_value (revenue), or unique. Default count.'),
    interval: z
      .enum(['hour', 'day', 'week', 'month'])
      .optional()
      .describe(
        'Note: metric-aggregates uses singular (hour/day/week/month), NOT the series-report plural form.',
      ),
    timeframe: z
      .enum(TIMEFRAME_KEYS)
      .optional()
      .describe('Preset lookback. Use this OR start/end. Default: last_30_days.'),
    start: z
      .string()
      .optional()
      .describe(
        'Custom start YYYY-MM-DD. Raw events have NO 2023 floor - reaches back to account inception. Max 1 year per call.',
      ),
    end: z
      .string()
      .optional()
      .describe('Custom end YYYY-MM-DD. Defaults to now.'),
  }),
  execute: async ({ account, metric_id, measurement, interval, timeframe, start, end }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;

    let startIso: string;
    let endIso: string;
    if (start || end) {
      if (!start) return `Provide start (YYYY-MM-DD) with end, or use timeframe.`;
      const s = parseUserDate(start);
      if (s == null) return `Unparseable start "${start}". Use YYYY-MM-DD.`;
      const e = end ? parseUserDate(end) : Date.now();
      if (end && e == null) return `Unparseable end "${end}". Use YYYY-MM-DD.`;
      const eAdj =
        end && /^\d{4}-\d{2}-\d{2}$/.test(end.trim())
          ? (e as number) + 86_399_000
          : (e as number);
      if (eAdj <= s) return `end must be after start.`;
      // metric-aggregates rejects a range of exactly 1 year - keep it under.
      if (eAdj - s > 364 * 86_400_000)
        return `Metric aggregates allows just under 1 year per request (~364 days). Narrow the range, or call once per year.`;
      startIso = toKlaviyoIso(s);
      endIso = toKlaviyoIso(eAdj);
    } else {
      // Cap year presets at 364 days - metric-aggregates rejects exactly 1 year.
      const days = Math.min(PRESET_DAYS[timeframe || 'last_30_days'] ?? 30, 364);
      startIso = toKlaviyoIso(Date.now() - days * 86_400_000);
      endIso = toKlaviyoIso(Date.now());
    }

    const body = {
      data: {
        type: 'metric-aggregate',
        attributes: {
          metric_id,
          measurements: [measurement || 'count'],
          interval: interval || 'day',
          timezone: 'UTC',
          page_size: 500,
          filter: [
            `greater-or-equal(datetime,${startIso})`,
            `less-than(datetime,${endIso})`,
          ],
        },
      },
    };
    const data = (await klaviyoFetch(
      acc.apiKey,
      '/metric-aggregates',
      'POST',
      body,
    )) as any;
    if (data.error) return data.error;

    const attrs = data.data?.attributes || {};
    const dates: string[] = attrs.dates || [];
    const measurementData =
      attrs.data?.[0]?.measurements?.[measurement || 'count'] || [];

    if (dates.length === 0) return `No metric data for ${acc.displayName}.`;
    const lines = dates.map(
      (d, i) =>
        `  ${d.slice(0, 10)}: ${(measurementData[i] ?? 0).toLocaleString()}`,
    );
    return `${acc.displayName} - Metric ${metric_id} (${measurement || 'count'}, ${interval || 'day'}):\n${lines.join('\n')}`;
  },
});

// Tool 18: Get template
mcp.addTool({
  name: 'get_template',
  annotations: { title: 'Fetch email template', readOnlyHint: true, openWorldHint: true },
  description:
    'Fetch an email template by ID, including HTML/text content. Use for audit/preview.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    template_id: z.string().describe('Template ID.'),
    include_html: z
      .boolean()
      .optional()
      .describe('Include full HTML body. Default false (truncated).'),
  }),
  execute: async ({ account, template_id, include_html }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;
    const data = (await klaviyoFetch(
      acc.apiKey,
      `/templates/${safeId(template_id, 'template_id')}`,
    )) as any;
    if (data.error) return data.error;

    const t = data.data;
    if (!t) return `Template ${template_id} not found.`;
    const a = t.attributes || {};
    const html = a.html || '';
    const htmlOut = include_html
      ? html
      : html.slice(0, 500) +
        (html.length > 500 ? `\n... (${html.length - 500} more chars)` : '');
    return (
      `Template ${t.id}: ${a.name}\n` +
      `  Editor: ${a.editor_type || 'n/a'} | Created: ${(a.created || '').slice(0, 10)} | Updated: ${(a.updated || '').slice(0, 10)}\n\n` +
      `HTML:\n${htmlOut}`
    );
  },
});

// Tool 19: List recent events
mcp.addTool({
  name: 'list_recent_events',
  annotations: { title: 'List recent events', readOnlyHint: true, openWorldHint: true },
  description:
    'List recent events for a Klaviyo account, optionally filtered by metric_id (e.g. Placed Order). Returns up to 100 most recent.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    metric_id: z
      .string()
      .optional()
      .describe('Filter to events for one metric.'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Default 25, maximum 100 per page.'),
    page_cursor: z.string().optional().describe('Cursor from the previous page.'),
  }),
  execute: async ({ account, metric_id, page_size, page_cursor }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;

    const params = new URLSearchParams();
    params.set('sort', '-datetime');
    params.set('page[size]', String(page_size || 25));
    params.set('fields[event]', 'event_properties,datetime,uuid');
    if(page_cursor)params.set('page[cursor]',page_cursor);
    if (metric_id) {
      params.set(
        'filter',
        `equals(metric_id,"${safeId(metric_id, 'metric_id')}")`,
      );
    }

    const data = (await klaviyoFetch(
      acc.apiKey,
      `/events?${params.toString()}`,
    )) as any;
    if (data.error) return data.error;
    const events = data.data || [];
    if (events.length === 0) return `No recent events for ${acc.displayName}.`;

    const lines = events.map((e: any) => {
      const a = e.attributes || {};
      const props = a.event_properties || {};
      const value = props.$value || props.value || '';
      return `• ${(a.datetime || '').slice(0, 19)} | ${e.id} ${value ? `| value=$${value}` : ''}`;
    });
    const nextCursor=data.links?.next?new URL(data.links.next).searchParams.get('page[cursor]'):null;
    return `${acc.displayName} - ${events.length} recent events${metric_id ? ` (metric=${metric_id})` : ''}:\n${lines.join('\n')}${nextCursor?`\n\nNext cursor: ${nextCursor}`:''}`;
  },
});

// Tool 20: Account info
mcp.addTool({
  name: 'account_info',
  annotations: { title: 'Get account metadata', readOnlyHint: true, openWorldHint: true },
  description:
    'Get Klaviyo account metadata: org name, timezone, currency, contact email, industry.',
  parameters: z.object({
    account: z.string().describe('Account name'),
  }),
  execute: async ({ account }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;
    const data = (await klaviyoFetch(acc.apiKey, '/accounts')) as any;
    if (data.error) return data.error;
    const accounts = data.data || [];
    if (accounts.length === 0) return `No account info for ${acc.displayName}.`;

    return accounts
      .map((a: any) => {
        const at = a.attributes || {};
        const c = at.contact_information || {};
        return (
          `Account ${a.id} (${at.test_account ? 'TEST' : 'LIVE'}):\n` +
          `  Org: ${at.contact_information?.organization_name || 'n/a'}\n` +
          `  Industry: ${at.industry || 'n/a'} | Timezone: ${at.timezone || 'n/a'} | Locale: ${at.locale || 'n/a'}\n` +
          `  Currency: ${at.preferred_currency || 'n/a'}\n` +
          `  Contact email: ${c.default_sender_email || 'n/a'}\n` +
          `  Public API key: ${at.public_api_key || 'n/a'}`
        );
      })
      .join('\n\n');
  },
});

// Tool 21: List tags
mcp.addTool({
  name: 'list_tags',
  annotations: { title: 'List account tags', readOnlyHint: true, openWorldHint: true },
  description:
    'List all tags in a Klaviyo account (used to label campaigns, flows, segments, lists).',
  parameters: z.object({
    account: z.string().describe('Account name'),
  }),
  execute: async ({ account }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;
    const data = await klaviyoFetchAll(acc.apiKey, '/tags?page[size]=50');
    if (data.error) return data.error;
    const tags = data.data;
    if (tags.length === 0) return `No tags for ${acc.displayName}.`;
    const lines = tags.map(
      (t: any) => `• ${t.attributes?.name || '(unnamed)'} | ID: ${t.id}`,
    );
    return `${acc.displayName} - ${tags.length} tags:\n${lines.join('\n')}`;
  },
});

// Tool 22: List templates
mcp.addTool({
  name: 'list_templates',
  annotations: { title: 'List email templates', readOnlyHint: true, openWorldHint: true },
  description:
    'List email templates in a Klaviyo account (name, editor type, dates). Use get_template for the HTML of one.',
  parameters: z.object({ account: z.string().describe('Account name') }),
  execute: async ({ account }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;
    // Templates cap page[size] at 10 and the endpoint is slow, so fetch the most
    // recent page only (discovery); note if more exist.
    const data = (await klaviyoFetch(
      acc.apiKey,
      '/templates?fields[template]=name,editor_type,created,updated&sort=-updated&page[size]=10',
    )) as any;
    if (data.error) return data.error;
    const templates = data.data || [];
    if (templates.length === 0) return `No templates for ${acc.displayName}.`;
    const lines = templates.map(
      (t: any) =>
        `• ${t.attributes?.name || '(unnamed)'} | editor: ${t.attributes?.editor_type || 'n/a'} | updated: ${(t.attributes?.updated || '').slice(0, 10)} | ID: ${t.id}`,
    );
    const more = data.links?.next ? '\n(more templates exist - this is the 10 most recently updated)' : '';
    return `${acc.displayName} - ${templates.length} templates:\n${lines.join('\n')}${more}`;
  },
});

// Tool 23: Get profile (customer lookup)
mcp.addTool({
  name: 'get_profile',
  annotations: { title: 'Look up customer profile', readOnlyHint: true, openWorldHint: true },
  description:
    'Look up a customer profile by email or profile ID: name, location, and email-marketing consent/suppression status.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    email: z.string().optional().describe('Email address to look up.'),
    profile_id: z
      .string()
      .optional()
      .describe('Profile ID (alternative to email).'),
  }),
  execute: async ({ account, email, profile_id }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;
    let path: string;
    if (profile_id) {
      path = `/profiles/${safeId(profile_id, 'profile_id')}?additional-fields[profile]=subscriptions`;
    } else if (email) {
      const clean = email.replace(/["\\]/g, '');
      path = `/profiles?filter=${encodeURIComponent(`equals(email,"${clean}")`)}&additional-fields[profile]=subscriptions`;
    } else return 'Provide email or profile_id.';

    const data = (await klaviyoFetch(acc.apiKey, path)) as any;
    if (data.error) return data.error;
    const p = Array.isArray(data.data) ? data.data[0] : data.data;
    if (!p) return `No profile found for ${email || profile_id} in ${acc.displayName}.`;
    const a = p.attributes || {};
    const m = a.subscriptions?.email?.marketing || {};
    const sup = m.suppression;
    const supArr = Array.isArray(sup) ? sup : sup ? [sup] : [];
    return (
      `${acc.displayName} - Profile ${p.id}\n` +
      `  ${a.email || '(no email)'} | ${[a.first_name, a.last_name].filter(Boolean).join(' ') || '(no name)'}\n` +
      `  Location: ${[a.location?.city, a.location?.region, a.location?.country].filter(Boolean).join(', ') || 'n/a'}\n` +
      `  Email marketing: ${m.can_receive_email_marketing ? 'subscribed' : 'not subscribed'}${supArr.length ? ` | suppressed: ${supArr.map((x: any) => x.reason).join(', ')}` : ''}\n` +
      `  Created: ${(a.created || '').slice(0, 10)}`
    );
  },
});

// Tool 24: Get flow detail (structure)
mcp.addTool({
  name: 'get_flow_detail',
  annotations: { title: 'Get flow structure', readOnlyHint: true, openWorldHint: true },
  description:
    "Get a flow's structure by ID: status, trigger, and its actions/steps (type, message channel). Use list_flows for IDs.",
  parameters: z.object({
    account: z.string().describe('Account name'),
    flow_id: z.string().describe('Flow ID.'),
  }),
  execute: async ({ account, flow_id }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;
    const fid = safeId(flow_id, 'flow_id');
    const meta = (await klaviyoFetch(
      acc.apiKey,
      `/flows/${fid}?fields[flow]=name,status,trigger_type`,
    )) as any;
    if (meta.error) return meta.error;
    const f = meta.data;
    if (!f) return `Flow ${flow_id} not found.`;
    const actions = await klaviyoFetchAll(
      acc.apiKey,
      `/flows/${fid}/flow-actions?page[size]=50`,
    );
    const header = `${acc.displayName} - Flow ${f.id}: ${f.attributes?.name}\n  Status: ${f.attributes?.status} | Trigger: ${f.attributes?.trigger_type || 'n/a'} | Actions: ${actions.error ? '?' : actions.data.length}`;
    if (actions.error) return `${header}\n  (could not load actions: ${actions.error})`;
    const lines = actions.data.map((x: any) => {
      const d = x.attributes?.definition || {};
      return `  • ${d.action_type || 'action'} | ID: ${x.id}`;
    });
    return [header, ...lines].join('\n');
  },
});

// Tool 25: Custom report - expert escape hatch
mcp.addTool({
  name: 'custom_report',
  annotations: { title: 'Run any Klaviyo report', readOnlyHint: true, openWorldHint: true },
  description:
    'Expert escape hatch - run ANY Klaviyo values or series report with full control over statistics, group_by, filter, interval, and timeframe (preset OR custom range, auto-windowed into 1-year chunks back to the 2023-06-01 floor). Returns raw JSON results so you can analyze like a Klaviyo analyst. Use when the specialized report tools do not expose a statistic, dimension, or filter you need.',
  parameters: z.object({
    account: z.string().describe('Account name'),
    report_type: z
      .enum([
        'campaign-values-report',
        'flow-values-report',
        'segment-values-report',
        'form-values-report',
        'flow-series-report',
        'form-series-report',
        'segment-series-report',
      ])
      .describe(
        'Which Klaviyo report to run. NOTE: there is no campaign-series-report - campaign reports are values-only; use metric_aggregate or per-period campaign-values for campaign trends.',
      ),
    statistics: z
      .array(z.string())
      .min(1)
      .describe(
        'Statistics to fetch, e.g. ["recipients","open_rate","conversion_value"]. Must be valid for the chosen report_type.',
      ),
    conversion_metric_id: z
      .string()
      .optional()
      .describe(
        'Required whenever you request a revenue/conversion statistic (e.g. conversion_value, conversion_rate).',
      ),
    group_by: z
      .array(z.string())
      .optional()
      .describe('Grouping dimensions, e.g. ["campaign_id","send_channel"].'),
    interval: z
      .enum(INTERVAL_KEYS)
      .optional()
      .describe('For *-series-report only: hourly/daily/weekly/monthly. Default daily.'),
    filter: z
      .string()
      .optional()
      .describe(
        'Raw Klaviyo filter expression, e.g. equals(campaign_id,"01ABC"). You own its correctness.',
      ),
    timeframe: z
      .enum(TIMEFRAME_KEYS)
      .optional()
      .describe('Preset period, OR use start/end/quarter/year.'),
    ...CUSTOM_RANGE_PARAMS,
  }),
  execute: async ({
    account,
    report_type,
    statistics,
    conversion_metric_id,
    group_by,
    interval,
    filter,
    timeframe,
    start,
    end,
    quarter,
    year,
  }) => {
    const acc = getAccount(account);
    if (!acc) return `Account "${account}" not found.`;

    const tf = resolveTimeframe({ timeframe, start, end, quarter, year });
    if ('error' in tf) return `${acc.displayName}: ${tf.error}`;

    // campaign/flow reports require conversion_metric_id even for engagement-only
    // stats (verified live) - fail closed with a clear message rather than 400.
    const needsConv = [
      'campaign-values-report',
      'flow-values-report',
      'flow-series-report',
    ].includes(report_type);
    if (needsConv && !conversion_metric_id)
      return `${acc.displayName}: ${report_type} requires conversion_metric_id (even for engagement-only stats). Pass the account's Placed Order ID.`;

    const isSeries = report_type.endsWith('-series-report');
    if (isSeries) {
      const ivErr = checkSeriesInterval(interval || 'daily', tf);
      if (ivErr) return `${acc.displayName}: ${ivErr}`;
    }
    const path = `/${report_type}s/`;
    const attributes: Record<string, unknown> = { statistics };
    if (conversion_metric_id) attributes.conversion_metric_id = conversion_metric_id;
    if (group_by) attributes.group_by = group_by;
    if (filter) attributes.filter = filter;
    if (isSeries) attributes.interval = interval || 'daily';

    const windows: any[] = isSeries
      ? await fetchSeriesReport(acc, path, report_type, attributes, tf)
      : await fetchValueReport(acc, path, report_type, attributes, tf);

    const multi = !('key' in tf) && windows.length > 1;
    const sections = windows.map((w) => {
      const head = multi ? `━━ ${w.label} ━━\n` : '';
      if (w.error) return `${head}ERROR: ${w.error}`;
      if ((w.results || []).length === 0) return `${head}(no results)`;
      const payload = isSeries
        ? { date_times: w.dateTimes, results: w.results }
        : { results: w.results };
      return head + JSON.stringify(payload, null, 2);
    });

    return `${acc.displayName} - ${report_type} (${rangeLabel(tf)}, raw):\n\n${sections.join('\n\n')}${clampNote(tf)}`;
  },
});

mcp.start({ transportType: 'stdio' });
