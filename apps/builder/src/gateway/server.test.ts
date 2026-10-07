import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateway, hashToken, type Gateway, type GatewayAlert } from './server.js';
import { InMemoryGatewayStore } from './store.js';
import type { PricingTable } from './pricing.js';

const REAL_KEY = 'sk-ant-test-REAL-KEY-0123456789';
const MODEL = 'claude-test-model';

/** $1 per MTok of anything: 1M tokens = $1. */
const PRICING: PricingTable = {
  [MODEL]: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 1, cacheWritePerMTok: 1 },
  'claude-other-model': { inputPerMTok: 2, outputPerMTok: 2, cacheReadPerMTok: 2, cacheWritePerMTok: 2 },
};

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Responder = (req: Received, res: http.ServerResponse) => void;

function jsonResponder(usage: object, extra: object = {}): Responder {
  return (_req, res) => {
    const body = JSON.stringify({ id: 'msg_1', type: 'message', model: MODEL, usage, ...extra });
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_1', 'set-cookie': 'a=b' });
    res.end(body);
  };
}

function sseResponder(inputTokens: number, outputTokens: number): Responder {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'msg_1', model: MODEL, usage: { input_tokens: inputTokens, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } }],
      ['message_stop', { type: 'message_stop' }],
    ] as const;
    // Split the stream at awkward byte boundaries to exercise the incremental parser.
    const text = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    const parts = [text.slice(0, 7), text.slice(7, 150), text.slice(150)];
    let i = 0;
    const next = () => {
      if (i < parts.length) {
        res.write(parts[i++]);
        setTimeout(next, 5);
      } else {
        res.end();
      }
    };
    next();
  };
}

describe('AI gateway', () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  let received: Received[];
  let responder: Responder;
  let gateway: Gateway;
  let gatewayUrl: string;
  let store: InMemoryGatewayStore;
  let clock: number;
  let alerts: GatewayAlert[];
  let logLines: string[];

  async function start(overrides: { dailyBudgetUsd?: number; allowedModels?: string[] } = {}) {
    gateway = createGateway({
      upstreamUrl,
      apiKey: REAL_KEY,
      store,
      pricing: PRICING,
      dailyBudgetUsd: overrides.dailyBudgetUsd ?? 100,
      allowedModels: overrides.allowedModels ?? [MODEL],
      onAlert: (alert) => {
        alerts.push(alert);
      },
      now: () => clock,
      logger: pino({ level: 'trace' }, { write: (line: string) => logLines.push(line) }),
    });
    const address = await gateway.listen(0);
    gatewayUrl = `http://127.0.0.1:${address.port}`;
  }

  function call(
    token: string | undefined,
    body: object = { model: MODEL, max_tokens: 10, messages: [] },
    path = '/v1/messages',
    header: 'bearer' | 'x-api-key' = 'bearer',
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (token) {
      if (header === 'bearer') headers.authorization = `Bearer ${token}`;
      else headers['x-api-key'] = token;
    }
    return fetch(gatewayUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  beforeEach(async () => {
    received = [];
    alerts = [];
    logLines = [];
    clock = Date.parse('2026-10-07T12:00:00Z');
    store = new InMemoryGatewayStore();
    responder = jsonResponder({ input_tokens: 10, output_tokens: 5 });
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const r = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
        received.push(r);
        responder(r, res);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    await start();
  });

  afterEach(async () => {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('proxies a valid token with the real key injected and the client token removed', async () => {
    const token = await gateway.issueToken('job-1');
    const res = await fetch(`${gatewayUrl}/v1/messages?beta=true&evil=1`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-api-key': token,
        cookie: 'session=1',
        'anthropic-beta': 'some-beta',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('request-id')).toBe('req_1');
    expect(res.headers.get('set-cookie')).toBeNull();
    const json = (await res.json()) as { id: string };
    expect(json.id).toBe('msg_1');

    expect(received).toHaveLength(1);
    const up = received[0]!;
    expect(up.url).toBe('/v1/messages?beta=true');
    expect(up.headers['x-api-key']).toBe(REAL_KEY);
    expect(up.headers.authorization).toBeUndefined();
    expect(up.headers.cookie).toBeUndefined();
    expect(up.headers['anthropic-beta']).toBe('some-beta');
    expect(JSON.stringify(up.headers)).not.toContain(token);
    expect(up.body).not.toContain(token);
    expect(JSON.parse(up.body)).toMatchObject({ model: MODEL });
  });

  it('accepts the token in x-api-key and stores only its hash', async () => {
    const token = await gateway.issueToken('job-1');
    expect(token).toMatch(/^forge_gw_[A-Za-z0-9_-]{43}$/);
    expect(await store.getToken(token)).toBeUndefined();
    expect(await store.getToken(hashToken(token))).toMatchObject({ jobId: 'job-1' });
    const res = await call(token, undefined, '/v1/messages', 'x-api-key');
    expect(res.status).toBe(200);
  });

  it('rejects a missing or unknown token', async () => {
    expect((await call(undefined)).status).toBe(401);
    const res = await call('forge_gw_unknown');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    expect(received).toHaveLength(0);
  });

  it('rejects mismatched bearer and x-api-key tokens', async () => {
    const a = await gateway.issueToken('job-1');
    const b = await gateway.issueToken('job-2');
    const res = await fetch(`${gatewayUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a}`, 'x-api-key': b, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = await gateway.issueToken('job-1', { ttlMinutes: 30 });
    clock += 30 * 60_000;
    const res = await call(token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/expired/);
    expect(received).toHaveLength(0);
  });

  it('rejects a revoked token', async () => {
    const token = await gateway.issueToken('job-1');
    expect((await call(token)).status).toBe(200);
    await gateway.revokeToken(token);
    const res = await call(token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/revoked/);
    expect(received).toHaveLength(1);
  });

  it('records non-streaming usage, including cache tokens', async () => {
    responder = jsonResponder({
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 150_000,
    });
    const token = await gateway.issueToken('job-1');
    expect((await call(token)).status).toBe(200);
    // 500k tokens at $1/MTok
    expect(await store.getJobCost('job-1')).toBeCloseTo(0.5, 10);
  });

  it('blocks once the budget is reached after streamed usage', async () => {
    responder = sseResponder(600_000, 400_000);
    const token = await gateway.issueToken('job-1', { budgetUsd: 1 });
    const res = await call(token, { model: MODEL, max_tokens: 10, stream: true, messages: [] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('message_stop');
    expect(text).toContain('hello');
    expect(await store.getJobCost('job-1')).toBeCloseTo(1, 10);

    const blocked = await call(token, { model: MODEL, max_tokens: 10, stream: true, messages: [] });
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toMatchObject({ type: 'error', error: { type: 'budget_exceeded_error' } });
    expect(received).toHaveLength(1);
  });

  it('lets the in-flight request finish and blocks the next one', async () => {
    responder = jsonResponder({ input_tokens: 700_000, output_tokens: 0 });
    const token = await gateway.issueToken('job-1', { budgetUsd: 1 });
    expect((await call(token)).status).toBe(200);
    expect((await call(token)).status).toBe(200);
    expect(await store.getJobCost('job-1')).toBeCloseTo(1.4, 10);
    expect((await call(token)).status).toBe(402);
  });

  it('rejects a model that is not allowed', async () => {
    const token = await gateway.issueToken('job-1');
    const res = await call(token, { model: 'claude-other-model', messages: [] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { type: 'permission_error' } });
    expect((await call(token, { messages: [] })).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it('rejects server tools and remote MCP servers', async () => {
    const token = await gateway.issueToken('job-1');
    const webSearch = await call(token, {
      model: MODEL,
      messages: [],
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    });
    expect(webSearch.status).toBe(403);
    const mcp = await call(token, { model: MODEL, messages: [], mcp_servers: [{ type: 'url', url: 'https://x' }] });
    expect(mcp.status).toBe(403);
    const custom = await call(token, {
      model: MODEL,
      messages: [],
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
    });
    expect(custom.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it('refuses disallowed paths and methods', async () => {
    const token = await gateway.issueToken('job-1');
    for (const path of ['/v1/models', '/v1/messages/batches', '/v1/messages/../files', '/v1/complete', '/']) {
      const res = await call(token, undefined, path);
      expect(res.status, path).toBe(404);
    }
    const get = await fetch(`${gatewayUrl}/v1/messages`, { headers: { authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);
    expect(received).toHaveLength(0);
  });

  it('forwards count_tokens without charging', async () => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 42 }));
    };
    const token = await gateway.issueToken('job-1');
    const res = await call(token, undefined, '/v1/messages/count_tokens');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 42 });
    expect(received[0]!.url).toBe('/v1/messages/count_tokens');
    expect(await store.getJobCost('job-1')).toBe(0);
  });

  it('rejects a body over the size limit', async () => {
    await gateway.close();
    gateway = createGateway({
      upstreamUrl,
      apiKey: REAL_KEY,
      store,
      pricing: PRICING,
      allowedModels: [MODEL],
      dailyBudgetUsd: 100,
      onAlert: () => {},
      maxBodyBytes: 1024,
      logger: pino({ level: 'silent' }),
    });
    gatewayUrl = `http://127.0.0.1:${(await gateway.listen(0)).port}`;
    const token = await gateway.issueToken('job-1');
    const res = await call(token, { model: MODEL, messages: [{ role: 'user', content: 'x'.repeat(5000) }] });
    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it('times out a slow upstream', async () => {
    await gateway.close();
    responder = () => {
      /* never answers */
    };
    gateway = createGateway({
      upstreamUrl,
      apiKey: REAL_KEY,
      store,
      pricing: PRICING,
      allowedModels: [MODEL],
      dailyBudgetUsd: 100,
      onAlert: () => {},
      upstreamTimeoutMs: 100,
      logger: pino({ level: 'silent' }),
    });
    gatewayUrl = `http://127.0.0.1:${(await gateway.listen(0)).port}`;
    const token = await gateway.issueToken('job-1');
    const res = await call(token);
    expect(res.status).toBe(504);
  });

  it('fires the 80% daily alert exactly once and blocks at 100%', async () => {
    await gateway.close();
    await start({ dailyBudgetUsd: 10 });
    responder = jsonResponder({ input_tokens: 3_000_000, output_tokens: 0 }); // $3 per call
    const token = await gateway.issueToken('job-1', { budgetUsd: 1000 });
    expect((await call(token)).status).toBe(200); // $3
    expect((await call(token)).status).toBe(200); // $6
    expect(alerts).toHaveLength(0);
    expect((await call(token)).status).toBe(200); // $9 -> 90% >= 80%
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'daily_budget_threshold', day: '2026-10-07', dailyBudgetUsd: 10 });
    expect((await call(token)).status).toBe(200); // $12
    expect(alerts).toHaveLength(1);
    const blocked = await call(token);
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toMatchObject({ error: { type: 'daily_budget_exceeded_error' } });
  });

  it('never logs nor echoes the real key or the tokens', async () => {
    const token = await gateway.issueToken('job-1');
    responder = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `bad key ${REAL_KEY}` } }));
    };
    const echoed = await call(token);
    expect(echoed.status).toBe(401);
    const echoedText = await echoed.text();
    expect(echoedText).not.toContain(REAL_KEY);

    responder = sseResponder(10, 10);
    await (await call(token, { model: MODEL, stream: true, messages: [] })).text();
    await call(token, { model: 'claude-other-model', messages: [] });
    await call('forge_gw_not-a-real-token');
    await gateway.revokeToken(token);
    await call(token);

    const logs = logLines.join('\n');
    expect(logLines.length).toBeGreaterThan(0);
    expect(logs).toContain('job-1');
    expect(logs).not.toContain(REAL_KEY);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(hashToken(token));
    expect(logs).not.toContain('forge_gw_not-a-real-token');
  });

  it('charges max_tokens when a stream is cut before message_delta', async () => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const start = { type: 'message_start', message: { id: 'msg_1', model: MODEL, usage: { input_tokens: 1000, output_tokens: 1 } } };
      const delta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } };
      res.write(`event: message_start
data: ${JSON.stringify(start)}

event: content_block_delta
data: ${JSON.stringify(delta)}

`);
      // Never sends message_delta nor message_stop.
    };
    const token = await gateway.issueToken('job-1');
    const client = new AbortController();
    const res = await fetch(`${gatewayUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 50_000, stream: true, messages: [] }),
      signal: client.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    client.abort();
    // Real input (1000) + max_tokens (50k) at $1/MTok.
    await vi.waitFor(async () => expect(await store.getJobCost('job-1')).toBeCloseTo(0.051, 10), { timeout: 5000 });
  });

  it('charges an estimate when a non-streaming request is cut before the response', async () => {
    responder = () => {
      /* never answers */
    };
    const token = await gateway.issueToken('job-1');
    const client = new AbortController();
    const pending = fetch(`${gatewayUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 50_000, messages: [] }),
      signal: client.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
    client.abort();
    await pending;
    await vi.waitFor(async () => expect(await store.getJobCost('job-1')).toBeGreaterThanOrEqual(0.05), { timeout: 5000 });
  });

  it('charges an estimate when a non-streaming body read is interrupted', async () => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":"msg_1","type":"message",');
      // Body never completes.
    };
    const token = await gateway.issueToken('job-1');
    const client = new AbortController();
    const pending = fetch(`${gatewayUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 50_000, messages: [] }),
      signal: client.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.abort();
    await pending;
    await vi.waitFor(async () => expect(await store.getJobCost('job-1')).toBeGreaterThanOrEqual(0.05), { timeout: 5000 });
  });

  it('reserves in-flight cost so parallel requests cannot overrun the job budget', async () => {
    const base = jsonResponder({ input_tokens: 10, output_tokens: 5 });
    responder = (req, res) => setTimeout(() => base(req, res), 200);
    // Each request may cost up to 60k output tokens = $0.06, above the $0.05 budget.
    const token = await gateway.issueToken('job-1', { budgetUsd: 0.05 });
    const body = { model: MODEL, max_tokens: 60_000, messages: [] };
    const statuses = (await Promise.all([call(token, body), call(token, body), call(token, body)])).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 402, 402]);
    expect(received).toHaveLength(1);
    // The reservation is settled to the real cost, so the job is not blocked afterwards.
    expect(await store.getJobCost('job-1')).toBeCloseTo(15 / 1_000_000, 12);
    expect((await call(token, body)).status).toBe(200);
  });

  it('rejects max_tokens above the gateway cap', async () => {
    const token = await gateway.issueToken('job-1');
    const res = await call(token, { model: MODEL, max_tokens: 1_000_000, messages: [] });
    expect(res.status).toBe(400);
    expect((await call(token, { model: MODEL, max_tokens: -1, messages: [] })).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it('refuses invalid configuration', () => {
    const base = { upstreamUrl, apiKey: REAL_KEY, store, pricing: PRICING, dailyBudgetUsd: 1, onAlert: () => {} };
    expect(() => createGateway({ ...base, allowedModels: ['unpriced-model'] })).toThrow(/no pricing/);
    expect(() => createGateway({ ...base, apiKey: '' })).toThrow(/apiKey/);
    expect(() => createGateway({ ...base, dailyBudgetUsd: 0 })).toThrow(/dailyBudgetUsd/);
  });
});
