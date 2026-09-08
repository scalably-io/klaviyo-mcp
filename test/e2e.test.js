import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textOf = (response) => response.result?.content?.find((item) => item.type === 'text')?.text || '';

function client(origin) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      KLAVIYO_KEY_TEST: 'pk_test',
      KLAVIYO_API_BASE: origin,
      KLAVIYO_RETRY_BASE_MS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let id = 1;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  const request = (method, params) => {
    const requestId = id++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}: ${stderr}`)), 15_000);
      pending.set(requestId, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    return promise;
  };
  return {
    async init() {
      await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'klaviyo-test', version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    list: () => request('tools/list', {}),
    call: (name, args = {}) => request('tools/call', { name, arguments: args }),
    async close() {
      const done = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await done;
    },
  };
}

test('Klaviyo stdio covers 24 tools, latest revision, report/list cursors and partial failures', async () => {
  let origin;
  const server = http.createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => { rawBody += chunk; });
    req.on('end', () => {
      assert.equal(req.headers.revision, '2026-07-15');
      const url = new URL(req.url, 'http://test');
      const parsedBody = rawBody ? JSON.parse(rawBody) : null;
      const send = (status, data) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(data));
      };

      if (url.pathname === '/metrics') {
        if (url.searchParams.get('page[cursor]') === '2') {
          return send(200, { data: [{ id: 'm2', attributes: { name: 'Opened Email' } }], links: { next: null } });
        }
        return send(200, {
          data: [{ id: 'm1', attributes: { name: 'Placed Order', integration: { name: 'Shopify' } } }],
          links: { next: `${origin}/api/metrics?page%5Bcursor%5D=2` },
        });
      }

      if (url.pathname === '/campaign-values-reports/') {
        if (url.searchParams.get('page_cursor') === '2') {
          return send(200, {
            data: { attributes: { results: [{ groupings: { campaign_id: 'c2' }, statistics: { recipients: 20 } }] } },
            links: { next: null },
          });
        }
        if (url.searchParams.get('page_cursor') === 'bad') return send(503, { error: 'down' });
        const metric = parsedBody?.data?.attributes?.conversion_metric_id;
        return send(200, {
          data: { attributes: { results: [{ groupings: { campaign_id: 'c1' }, statistics: { recipients: 10 } }] } },
          links: { next: `${origin}/api/campaign-values-reports/?page_cursor=${metric === 'badmetric' ? 'bad' : '2'}` },
        });
      }

      if (url.pathname === '/profiles') {
        assert.match(decodeURIComponent(url.search), /HARD_BOUNCE/);
        return send(200, {
          data: [{
            id: 'p1',
            attributes: {
              email: 'a@b.com',
              subscriptions: { email: { marketing: { suppression: [{ reason: 'HARD_BOUNCE' }] } } },
            },
          }],
          links: { next: `${origin}/api/profiles?page%5Bcursor%5D=next` },
        });
      }

      if (url.pathname === '/events') {
        return send(200, {
          data: [{ id: 'e1', attributes: { datetime: '2026-08-01T00:00:00Z', event_properties: {} } }],
          links: { next: url.searchParams.get('page[cursor]') ? null : `${origin}/api/events?page%5Bcursor%5D=e2` },
        });
      }

      return send(400, { error: 'bad' });
    });
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  origin = `http://localhost:${server.address().port}`;

  const mcp = client(origin);
  try {
    await mcp.init();
    assert.equal((await mcp.list()).result.tools.length, 24);

    const metrics = JSON.parse(textOf(await mcp.call('list_metrics', { account: 'test' })));
    assert.equal(metrics.status, 'succeeded');
    assert.deepEqual(Object.keys(metrics).sort(), ['operation', 'proof', 'recovery', 'result', 'status', 'summary', 'target', 'warnings'], 'reply contract: all eight keys present');
    assert.equal(metrics.recovery, null);
    assert.match(metrics.result.text, /2 total/);

    const report = JSON.parse(textOf(await mcp.call('campaign_report', {
      account: 'test',
      conversion_metric_id: 'metric',
      timeframe: 'last_30_days',
    })));
    assert.equal(report.status, 'succeeded');
    assert.match(report.result.text, /Campaign c1/);
    assert.match(report.result.text, /Campaign c2/);

    const partial = JSON.parse(textOf(await mcp.call('campaign_report', {
      account: 'test',
      conversion_metric_id: 'badmetric',
      timeframe: 'last_30_days',
    })));
    assert.equal(partial.status, 'partial');

    const suppressed = JSON.parse(textOf(await mcp.call('list_suppressed_profiles', {
      account: 'test',
      reason: 'hard_bounce',
    })));
    assert.equal(suppressed.status, 'partial');
    assert.match(suppressed.result.text, /Next cursor: next/);

    const events = JSON.parse(textOf(await mcp.call('list_recent_events', { account: 'test', page_size: 25 })));
    assert.equal(events.status, 'partial');
    assert.match(events.result.text, /Next cursor: e2/);

    const events2 = JSON.parse(textOf(await mcp.call('list_recent_events', {
      account: 'test',
      page_size: 25,
      page_cursor: 'e2',
    })));
    assert.equal(events2.status, 'succeeded');

    const bad = await mcp.call('account_info', { account: 'test' });
    assert.equal(bad.result.isError, true);
  } finally {
    await mcp.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
