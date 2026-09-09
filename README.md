# Klaviyo MCP

Klaviyo MCP server. 24 read-only tools cover campaigns, flows, segments, metrics, reports, and profiles across many accounts.

<!-- mcp-name: io.scalably/klaviyo-mcp -->

## Install

Claude Code:

```bash
claude mcp add klaviyo -e KLAVIYO_KEY_MAIN=pk_your_key -- npx -y @scalably-io/klaviyo-mcp
```

Codex:

```bash
codex mcp add klaviyo --env KLAVIYO_KEY_MAIN=pk_your_key -- npx -y @scalably-io/klaviyo-mcp
```

Claude Desktop: download `klaviyo-mcp.mcpb` from the latest GitHub release and open it. Claude Desktop's install form only accepts one account (`KLAVIYO_KEY_MAIN`).

## Setup

1. Create a private API key in Klaviyo under Settings > API Keys.
2. Set one `KLAVIYO_KEY_<name>=pk_xxx` environment variable per account, for example `KLAVIYO_KEY_MAIN` or `KLAVIYO_KEY_STOREONE`. The server auto-discovers every `KLAVIYO_KEY_*` variable at startup; `list_accounts` shows what it found.
3. Multiple Klaviyo accounts (agencies, multi-brand portfolios) work only through Claude Code or Codex, since both let you pass arbitrary extra environment variables. Add as many `KLAVIYO_KEY_<name>` variables as you have accounts, then call tools with the matching `account` argument (the name after `KLAVIYO_KEY_`, lowercased).
4. All 24 tools are read-only.

## Tools (24)

| Tool | What it does |
|---|---|
| `list_accounts` | List all configured Klaviyo accounts. Use this first to see which brands are available. |
| `list_campaigns` | List recent email campaigns for a specific Klaviyo account. Returns campaign IDs, names, status, and send dates. |
| `campaign_report` | Get email campaign performance metrics for a Klaviyo account. Returns opens, clicks, revenue, bounce rate, unsubscribes for the specified time period. |
| `list_metrics` | List available metrics for a Klaviyo account. Use this to find the 'Placed Order' metric ID needed for revenue reporting. |
| `multi_account_summary` | Pull campaign performance summary from ALL configured Klaviyo accounts. Returns a unified cross-brand report. |
| `flow_report` | Get email flow (automation) performance for a Klaviyo account. Returns metrics for welcome series, abandoned cart, post-purchase, etc. |
| `campaign_ab_report` | Get per-variation (A/B arm) email/SMS campaign metrics for a Klaviyo account. Splits results by variation so you can compare arms. |
| `flow_series_report` | Time-series flow (automation) metrics for a Klaviyo account. Buckets by interval. |
| `segment_report` | Segment performance metrics for a Klaviyo account: member counts, additions, removals. |
| `form_report` | Sign-up form performance for a Klaviyo account: views, submissions, submit rate. |
| `list_segments` | List all segments in a Klaviyo account with name, member count, and creation date. |
| `list_lists` | List all email lists in a Klaviyo account with name, opt-in process, and creation date. |
| `list_flows` | List all flows (automations) in a Klaviyo account with name, status, trigger type, and last updated. |
| `get_campaign_detail` | Get full details for a single campaign by ID: name, status, send_time, subject, preview text, channel, and message IDs. |
| `list_suppressed_profiles` | List profiles suppressed from email marketing for a single reason. Klaviyo only allows `equals` (not `any`) for suppression.reason, so call once per reason for a full picture. |
| `metric_aggregate` | Aggregate values for any Klaviyo metric (e.g. opens, clicks, revenue) over a custom timeframe and interval. |
| `get_template` | Fetch an email template by ID, including HTML/text content. Use for audit/preview. |
| `list_recent_events` | List recent events for a Klaviyo account, optionally filtered by metric_id (e.g. Placed Order). Returns up to 100 most recent. |
| `account_info` | Get Klaviyo account metadata: org name, timezone, currency, contact email, industry. |
| `list_tags` | List all tags in a Klaviyo account (used to label campaigns, flows, segments, lists). |
| `list_templates` | List email templates in a Klaviyo account (name, editor type, dates). Use `get_template` for the HTML of one. |
| `get_profile` | Look up a customer profile by email or profile ID: name, location, and email-marketing consent/suppression status. |
| `get_flow_detail` | Get a flow's structure by ID: status, trigger, and its actions/steps (type, message channel). Use `list_flows` for IDs. |
| `custom_report` | Expert escape hatch: run any Klaviyo values or series report with full control over statistics, group_by, filter, interval, and timeframe. |

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `KLAVIYO_KEY_MAIN` (or any `KLAVIYO_KEY_<name>`) | yes | Private API key for one Klaviyo account. One variable per account; the name after `KLAVIYO_KEY_` becomes the `account` argument. |
| `KLAVIYO_API_BASE` | no | Override the Klaviyo API base URL (default `https://a.klaviyo.com/api`) |
| `KLAVIYO_RETRY_BASE_MS` | no | Base delay in milliseconds for the retry backoff (default 1000) |

## Reply shape

Every tool returns plain JSON with `status` (`succeeded`, `partial`, `no_op`), `operation`, `summary`, `target`, `result`, `proof`, `warnings`, `recovery`. Failures throw a plain error string: `<code>: <message> <hint>`.

## Limits

Reporting endpoints (`campaign_report`, `flow_report`, `campaign_ab_report`, `flow_series_report`, `segment_report`, `form_report`, `custom_report` for values/series reports) are rate limited by Klaviyo to 2 requests per minute per account. Reporting data is only available from 2023-06-01 onward; a custom range starting earlier is clamped to that floor. A single reporting request cannot span more than one calendar year, so a longer custom range is auto-windowed into consecutive yearly chunks with a spacing delay between them.

## Verify

Each release lists the package version, the `.mcpb` sha256 and the production commit it was derived from in CHANGELOG.md. CI runs the tests and a clean install of the packed tarball on every push.

## Privacy Policy

This server runs locally, on your machine, under your own credentials. It collects no personal data, contains no telemetry, stores nothing persistently, and talks only to the vendor API it wraps. No third party, including Scalably, receives your data. Contact: hello@scalably.io. Canonical copy: https://scalably.io/connector-privacy.html

## License

MIT. Copyright Scalably.
