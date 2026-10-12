// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { RelayConfig } from '../config';
import { createRelayHandler, MAX_BODY_BYTES } from '../handler';
import { DEFAULT_LIMITS, MemoryRateLimitStore, type RelayLimits } from '../limits';
import { MemoryLogger } from '../log';
import type { DirectorySnapshot, LaunchpadDirectory } from '../origins';
import { secretFragments } from '../redact';
import { deriveRelayToken, RELAY_TOKEN_HEADER } from '../server-token';
import { createUpstream, GENESIS_HASH, type FetchLike } from '../upstream';
import { CREATOR_POOLS_WEIGHT, DBC_PROGRAM_ID } from '../methods';
import {
  call,
  DEVNET_GENESIS,
  FAKE_KEY,
  PK,
  PK2,
  SIG,
  smallTransactionBase64,
  UPSTREAM_URL,
} from './helpers';

const CLIENT = 'https://moonpad.forge-sites.app';
/** Site of a sleeping launchpad (status 'sleeping' in the directory). */
const SLEEPING = 'https://sleepy.forge-sites.app';
const FORGE = 'https://forge.example';
const SECRET = Buffer.from('s'.repeat(48));
const TX = smallTransactionBase64();
/** The SDK getPoolsByCreator query (VirtualPool discriminator, creator at offset 104). */
const CREATOR_POOLS_PARAMS = [
  DBC_PROGRAM_ID,
  {
    encoding: 'base64',
    commitment: 'confirmed',
    filters: [
      { memcmp: { offset: 0, bytes: 'cmrfVvtHrjd', encoding: 'base58' } },
      { memcmp: { offset: 104, bytes: PK2, encoding: 'base58' } },
    ],
  },
];

type UpstreamBody = { jsonrpc: string; id: number; method: string; params?: unknown };
type Responder = (
  payload: UpstreamBody | UpstreamBody[],
  init: RequestInit,
) => Promise<Response> | Response;

const okJson = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** Default upstream: echoes `result: "<method>:<id>"` for every call. */
const echo: Responder = (payload) => {
  const answer = (c: UpstreamBody) => ({ jsonrpc: '2.0', id: c.id, result: `${c.method}:${c.id}` });
  return okJson(Array.isArray(payload) ? payload.map(answer) : answer(payload));
};

interface RelayOptions {
  respond?: Responder;
  limits?: Partial<RelayLimits>;
  allowAnonymous?: boolean;
  tokenSecret?: Buffer | null;
  directory?: LaunchpadDirectory | null;
  genesis?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const responses: string[] = [];

function makeRelay(options: RelayOptions = {}) {
  const upstreamPayloads: (UpstreamBody | UpstreamBody[])[] = [];
  let genesisCalls = 0;
  const fetchFake: FetchLike = async (url, init) => {
    expect(url).toBe(UPSTREAM_URL);
    const payload = JSON.parse(String(init.body)) as UpstreamBody | UpstreamBody[];
    if (!Array.isArray(payload) && payload.method === 'getGenesisHash') {
      genesisCalls += 1;
      return okJson({ jsonrpc: '2.0', id: payload.id, result: options.genesis ?? DEVNET_GENESIS });
    }
    upstreamPayloads.push(payload);
    return (options.respond ?? echo)(payload, init);
  };
  const snapshot: DirectorySnapshot = {
    activeSlugs: new Set(['moonpad', 'sun-pad']),
    sleepingSlugs: new Set(['sleepy']),
    previewOrigins: new Map([['https://forge-moonpad-abc-team.vercel.app', 'moonpad']]),
    loadedAt: 0,
  };
  const directory =
    options.directory === undefined
      ? { snapshot: () => Promise.resolve(snapshot) }
      : options.directory;
  const logger = new MemoryLogger();
  const config: Pick<
    RelayConfig,
    'appOrigin' | 'clientsDomain' | 'allowLocalhost' | 'tokenSecret' | 'allowAnonymous' | 'limits'
  > = {
    appOrigin: FORGE,
    clientsDomain: 'forge-sites.app',
    allowLocalhost: false,
    tokenSecret: options.tokenSecret === undefined ? SECRET : options.tokenSecret,
    allowAnonymous: options.allowAnonymous ?? true,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
  };
  const handler = createRelayHandler({
    config,
    directory,
    limiter: new MemoryRateLimitStore(),
    upstream: createUpstream({
      url: UPSTREAM_URL,
      cluster: 'devnet',
      secretFragments: secretFragments(UPSTREAM_URL),
      fetch: fetchFake,
      timeoutMs: options.timeoutMs ?? 2_000,
      deadlineMs: 5_000,
      retryDelayMs: 1,
      sleep: () => Promise.resolve(),
      ...(options.maxResponseBytes !== undefined
        ? { maxResponseBytes: options.maxResponseBytes }
        : {}),
    }),
    logger,
    clientIp: (req) => req.headers.get('x-test-ip') ?? '198.51.100.1',
  });
  return {
    handler,
    logger,
    upstreamPayloads,
    genesisCalls: () => genesisCalls,
  };
}

interface PostOptions {
  origin?: string | null;
  token?: string;
  ip?: string;
  contentType?: string;
  raw?: string;
}

function request(body: unknown, opts: PostOptions = {}): Request {
  const headers: Record<string, string> = {
    'content-type': opts.contentType ?? 'application/json',
    'x-test-ip': opts.ip ?? '198.51.100.1',
  };
  const origin = opts.origin === undefined ? CLIENT : opts.origin;
  if (origin !== null) headers.origin = origin;
  if (opts.token) headers[RELAY_TOKEN_HEADER] = opts.token;
  return new Request('https://forge.example/api/rpc', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

async function send(relay: ReturnType<typeof makeRelay>, body: unknown, opts: PostOptions = {}) {
  const res = await relay.handler.post(request(body, opts));
  const text = await res.text();
  responses.push(text);
  return { res, text, json: text ? (JSON.parse(text) as unknown) : null };
}

afterEach(() => {
  // Whatever a test did, the provider key never reached a caller.
  for (const text of responses) expect(text).not.toContain(FAKE_KEY);
  responses.length = 0;
});

function expectNoKeyInLogs(logger: MemoryLogger) {
  expect(JSON.stringify(logger.entries)).not.toContain(FAKE_KEY);
  expect(JSON.stringify(logger.entries)).not.toContain('helius-rpc.com');
}

describe('CORS', () => {
  it('answers an allowed client site with its origin', async () => {
    const relay = makeRelay();
    const { res, json } = await send(relay, call('getSlot', [], 'a'));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(CLIENT);
    expect(res.headers.get('vary')).toContain('Origin');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(json).toEqual({ jsonrpc: '2.0', id: 'a', result: 'getSlot:0' });
  });

  it.each([FORGE, 'https://forge-moonpad-abc-team.vercel.app', 'https://sun-pad.forge-sites.app'])(
    'allows %s',
    async (origin) => {
      const relay = makeRelay();
      const { res } = await send(relay, call('getSlot'), { origin });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    },
  );

  it.each([
    'https://ghost.forge-sites.app',
    'https://evil.example',
    'https://moonpad.forge-sites.app.evil.example',
    'null',
    'http://localhost:3000',
  ])('refuses %s without CORS headers and without calling upstream', async (origin) => {
    const relay = makeRelay();
    const { res, json } = await send(relay, call('getSlot'), { origin });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(json).toMatchObject({ error: { code: -32098 } });
    expect(relay.upstreamPayloads).toHaveLength(0);
    expect(relay.genesisCalls()).toBe(0);
  });

  it('refuses client origins when the directory is not configured', async () => {
    const relay = makeRelay({ directory: null });
    expect((await send(relay, call('getSlot'))).res.status).toBe(403);
    expect((await send(relay, call('getSlot'), { origin: FORGE })).res.status).toBe(200);
  });

  it('answers preflights for allowed origins only', async () => {
    const relay = makeRelay();
    const preflight = (origin: string | null, method = 'POST') =>
      relay.handler.options(
        new Request('https://forge.example/api/rpc', {
          method: 'OPTIONS',
          headers: {
            ...(origin ? { origin } : {}),
            'access-control-request-method': method,
            'access-control-request-headers': 'content-type,solana-client',
          },
        }),
      );
    const ok = await preflight(CLIENT);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(CLIENT);
    expect(ok.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(ok.headers.get('access-control-allow-headers')).toBe('content-type, solana-client');
    expect(ok.headers.get('access-control-allow-headers')).not.toContain(RELAY_TOKEN_HEADER);
    expect(ok.headers.get('access-control-max-age')).toBe('600');

    const evil = await preflight('https://evil.example');
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    expect((await preflight(CLIENT, 'GET')).status).toBe(403);
    const none = await preflight(null);
    expect(none.status).toBe(204);
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('caller tiers', () => {
  it('serves non-browser callers on the anonymous tier, or refuses them when disabled', async () => {
    const on = makeRelay();
    const a = await send(on, call('getSlot'), { origin: null });
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get('access-control-allow-origin')).toBeNull();

    const off = makeRelay({ allowAnonymous: false });
    expect((await send(off, call('getSlot'), { origin: null })).res.status).toBe(403);
  });

  it('accepts a valid server token of an active launchpad', async () => {
    const relay = makeRelay();
    const { res } = await send(relay, call('getSlot'), {
      origin: null,
      token: deriveRelayToken(SECRET, 'moonpad'),
    });
    expect(res.status).toBe(200);
  });

  it('refuses invalid, foreign, inactive or browser-borne tokens', async () => {
    const relay = makeRelay();
    const other = deriveRelayToken(Buffer.from('o'.repeat(48)), 'moonpad');
    const forged = `${deriveRelayToken(SECRET, 'moonpad').slice(0, -1)}0`;
    expect((await send(relay, call('getSlot'), { origin: null, token: other })).res.status).toBe(
      401,
    );
    expect((await send(relay, call('getSlot'), { origin: null, token: forged })).res.status).toBe(
      401,
    );
    expect(
      (await send(relay, call('getSlot'), { origin: null, token: 'garbage' })).res.status,
    ).toBe(401);
    const inactive = deriveRelayToken(SECRET, 'sleepy');
    expect((await send(relay, call('getSlot'), { origin: null, token: inactive })).res.status).toBe(
      403,
    );
    const withOrigin = await send(relay, call('getSlot'), {
      origin: CLIENT,
      token: deriveRelayToken(SECRET, 'moonpad'),
    });
    expect(withOrigin.res.status).toBe(403);
    expect(relay.upstreamPayloads).toHaveLength(0);
    expectNoKeyInLogs(relay.logger);
    expect(JSON.stringify(relay.logger.entries)).not.toContain(forged);
  });

  it('refuses the server token of a sleeping launchpad (no uploads while sleeping)', async () => {
    const relay = makeRelay();
    const token = deriveRelayToken(SECRET, 'sleepy');
    const { res } = await send(relay, call('getBalance', [PK]), { origin: null, token });
    expect(res.status).toBe(403);
    expect(relay.upstreamPayloads).toHaveLength(0);
    expect(relay.logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'caller_refused',
        fields: expect.objectContaining({ reason: 'token_inactive', slug: 'sleepy' }),
      }),
    );
  });

  it('serves a sleeping site the creator fee claim methods only', async () => {
    const relay = makeRelay();
    const claim = [
      call('getProgramAccounts', CREATOR_POOLS_PARAMS, 1),
      call('getAccountInfo', [PK, { encoding: 'base64', commitment: 'confirmed' }], 2),
      call('getMultipleAccounts', [[PK, PK2], { encoding: 'base64' }], 3),
      call('getMinimumBalanceForRentExemption', [165], 4),
      call('getLatestBlockhash', [{ commitment: 'confirmed' }], 5),
      call('getBalance', [PK, { commitment: 'confirmed' }], 6),
      call('sendTransaction', [TX, { encoding: 'base64', maxRetries: 3 }], 7),
      call('getSignatureStatuses', [[SIG], { searchTransactionHistory: false }], 8),
    ];
    const ok = await send(relay, claim, { origin: SLEEPING });
    expect(ok.res.status).toBe(200);
    expect(ok.res.headers.get('access-control-allow-origin')).toBe(SLEEPING);
    expect((ok.json as { error?: unknown }[]).every((r) => r.error === undefined)).toBe(true);
    expect(relay.upstreamPayloads).toHaveLength(1);

    // Trading, simulation, history and token listing are refused like unknown methods.
    const others = [
      call('simulateTransaction', [TX, { encoding: 'base64', sigVerify: false }], 1),
      call('getTokenAccountsByOwner', [PK, { mint: PK2 }], 2),
      call('getSlot', [], 3),
      call('getBlockTime', [5], 4),
      call('getFeeForMessage', [TX], 5),
      call('getEpochInfo', [], 6),
      call('getBlockHeight', [], 7),
      call('getTokenAccountBalance', [PK], 8),
    ];
    const refused = await send(relay, others, { origin: SLEEPING });
    expect(refused.res.status).toBe(200);
    for (const answer of refused.json as { error?: { code: number } }[]) {
      expect(answer.error?.code).toBe(-32601);
    }
    expect(relay.upstreamPayloads).toHaveLength(1);
    // The same calls pass for a live site.
    const live = await send(relay, others, { origin: CLIENT });
    expect((live.json as { error?: unknown }[]).every((r) => r.error === undefined)).toBe(true);
    expect(relay.upstreamPayloads).toHaveLength(2);
  });

  it('answers the preflight of a sleeping site, never of a disabled one', async () => {
    const relay = makeRelay();
    const preflight = (origin: string) =>
      relay.handler.options(
        new Request('https://forge.example/api/rpc', {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST' },
        }),
      );
    const ok = await preflight(SLEEPING);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SLEEPING);
    expect((await preflight('https://cut-pad.forge-sites.app')).status).toBe(403);
  });

  it('refuses tokens when the server tier is disabled', async () => {
    const relay = makeRelay({ tokenSecret: null });
    const token = deriveRelayToken(SECRET, 'moonpad');
    expect((await send(relay, call('getSlot'), { origin: null, token })).res.status).toBe(403);
  });
});

describe('request bounds', () => {
  it('requires a JSON content type', async () => {
    const relay = makeRelay();
    const { res } = await send(relay, call('getSlot'), { contentType: 'text/plain' });
    expect(res.status).toBe(415);
    expect(res.headers.get('access-control-allow-origin')).toBe(CLIENT);
    expect(
      (await send(relay, call('getSlot'), { contentType: 'application/json; charset=utf-8' })).res
        .status,
    ).toBe(200);
  });

  it('caps the body size, declared or streamed', async () => {
    const relay = makeRelay();
    const big = JSON.stringify({ ...call('getSlot'), pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect((await send(relay, null, { raw: big })).res.status).toBe(413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 40; i++) controller.enqueue(new Uint8Array(1024).fill(32));
        controller.close();
      },
    });
    const res = await relay.handler.post(
      new Request('https://forge.example/api/rpc', {
        method: 'POST',
        headers: { origin: CLIENT, 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(relay.upstreamPayloads).toHaveLength(0);
  });

  it('answers parse errors and oversized batches', async () => {
    const relay = makeRelay();
    const parse = await send(relay, null, { raw: '{"jsonrpc":"2.0",' });
    expect(parse.res.status).toBe(400);
    expect(parse.json).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    const batch = Array.from({ length: 11 }, (_, i) => call('getSlot', [], i));
    expect((await send(relay, batch)).res.status).toBe(400);
    expect(relay.upstreamPayloads).toHaveLength(0);
  });

  it('refuses requests that are too expensive as a whole', async () => {
    const relay = makeRelay();
    const sendCall = (id: number) => call('sendTransaction', [TX, { encoding: 'base64' }], id);
    const { res, json } = await send(relay, [sendCall(1), sendCall(2), sendCall(3)]);
    expect(res.status).toBe(400);
    expect(json).toHaveLength(3);
    expect(relay.upstreamPayloads).toHaveLength(0);
  });
});

describe('forwarding', () => {
  it('forwards the creator pool query of the claim widget, as sent', async () => {
    const relay = makeRelay();
    const { res, json } = await send(relay, call('getProgramAccounts', CREATOR_POOLS_PARAMS, 4));
    expect(res.status).toBe(200);
    expect(json).toEqual({ jsonrpc: '2.0', id: 4, result: 'getProgramAccounts:0' });
    expect(relay.upstreamPayloads).toEqual([
      { jsonrpc: '2.0', id: 0, method: 'getProgramAccounts', params: CREATOR_POOLS_PARAMS },
    ]);
  });

  it('refuses any other program scan without calling upstream', async () => {
    const relay = makeRelay();
    const config = CREATOR_POOLS_PARAMS[1] as { filters: unknown[] };
    const byConfig = [
      DBC_PROGRAM_ID,
      { ...config, filters: [config.filters[0], { memcmp: { offset: 72, bytes: PK2 } }] },
    ];
    for (const params of [[PK], byConfig, [DBC_PROGRAM_ID, { encoding: 'base64' }]]) {
      const { res, json } = await send(relay, call('getProgramAccounts', params, 5));
      expect(res.status).toBe(200);
      expect(json).toMatchObject({ id: 5, error: { code: -32601 } });
    }
    expect(relay.upstreamPayloads).toHaveLength(0);
  });

  it('refuses disallowed methods without calling upstream', async () => {
    const relay = makeRelay();
    const { res, json } = await send(relay, call('getProgramAccounts', [PK], 9));
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ id: 9, error: { code: -32601 } });
    expect(relay.upstreamPayloads).toHaveLength(0);
    expect(relay.logger.events()).toContain('calls_refused');
  });

  it('rewrites ids upstream and maps answers back in request order', async () => {
    const relay = makeRelay({
      // Answers out of order, as JSON-RPC allows.
      respond: (payload) => {
        const list = payload as UpstreamBody[];
        return okJson(
          [...list]
            .reverse()
            .map((c) => ({ jsonrpc: '2.0', id: c.id, result: `${c.method}:${c.id}` })),
        );
      },
    });
    const batch = [
      call('getSlot', [], 'dup'),
      call('getProgramAccounts', [PK], 'bad'),
      call('getBalance', [PK], 'dup'),
      call('getBlockHeight', [], null),
    ];
    const { res, json } = await send(relay, batch);
    expect(res.status).toBe(200);
    expect(relay.upstreamPayloads[0]).toEqual([
      { jsonrpc: '2.0', id: 0, method: 'getSlot', params: [] },
      { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [PK] },
      { jsonrpc: '2.0', id: 2, method: 'getBlockHeight', params: [] },
    ]);
    expect(json).toEqual([
      { jsonrpc: '2.0', id: 'dup', result: 'getSlot:0' },
      {
        jsonrpc: '2.0',
        id: 'bad',
        error: { code: -32601, message: 'Method not allowed by the FORGE relay' },
      },
      { jsonrpc: '2.0', id: 'dup', result: 'getBalance:1' },
      { jsonrpc: '2.0', id: null, result: 'getBlockHeight:2' },
    ]);
  });

  it('sends a single call as an object with id 0', async () => {
    const relay = makeRelay();
    await send(relay, call('getBalance', [PK, { commitment: 'confirmed' }], 'uuid-1'));
    expect(relay.upstreamPayloads[0]).toEqual({
      jsonrpc: '2.0',
      id: 0,
      method: 'getBalance',
      params: [PK, { commitment: 'confirmed' }],
    });
  });

  it('forwards upstream JSON-RPC errors (simulation logs included)', async () => {
    const data = {
      logs: ['Program log: insufficient funds'],
      err: { InstructionError: [0, 'Custom'] },
    };
    const relay = makeRelay({
      respond: (p) =>
        okJson({
          jsonrpc: '2.0',
          id: (p as UpstreamBody).id,
          error: { code: -32002, message: 'Transaction simulation failed', data },
        }),
    });
    const { res, json } = await send(
      relay,
      call('sendTransaction', [TX, { encoding: 'base64' }], 4),
    );
    expect(res.status).toBe(200);
    expect(json).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32002, message: 'Transaction simulation failed', data },
    });
  });

  it('maps a missing batch item to an upstream error for that call only', async () => {
    const relay = makeRelay({
      respond: (p) => {
        const first = (p as UpstreamBody[])[0]!;
        return okJson([{ jsonrpc: '2.0', id: first.id, result: 1 }]);
      },
    });
    const { json } = await send(relay, [call('getSlot', [], 'a'), call('getBlockHeight', [], 'b')]);
    expect(json).toEqual([
      { jsonrpc: '2.0', id: 'a', result: 1 },
      { jsonrpc: '2.0', id: 'b', error: { code: -32603, message: 'RPC upstream unavailable' } },
    ]);
  });

  it('checks the cluster once, and refuses for good on a genesis mismatch', async () => {
    const ok = makeRelay();
    await send(ok, call('getSlot'));
    await send(ok, call('getSlot'));
    expect(ok.genesisCalls()).toBe(1);

    const wrong = makeRelay({ genesis: GENESIS_HASH['mainnet-beta'] });
    const first = await send(wrong, call('getSlot'));
    expect(first.res.status).toBe(503);
    const second = await send(wrong, call('getSlot'));
    expect(second.res.status).toBe(503);
    expect(wrong.genesisCalls()).toBe(1);
    expect(wrong.upstreamPayloads).toHaveLength(0);
    expect(wrong.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        event: 'upstream_failed',
        fields: expect.objectContaining({ reason: 'wrong_cluster' }),
      }),
    );
  });
});

describe('upstream failures and the provider key', () => {
  it.each([
    [
      'in a result',
      (id: number) => okJson({ jsonrpc: '2.0', id, result: { note: `see ${UPSTREAM_URL}` } }),
    ],
    ['as a bare key', (id: number) => okJson({ jsonrpc: '2.0', id, result: FAKE_KEY })],
    [
      'in an error message',
      (id: number) =>
        okJson({ jsonrpc: '2.0', id, error: { code: -32000, message: `bad key ${FAKE_KEY}` } }),
    ],
    [
      'url-encoded in error data',
      (id: number) =>
        okJson({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'x', data: encodeURIComponent(UPSTREAM_URL) },
        }),
    ],
  ])('never forwards a body echoing the key %s', async (_label, answer) => {
    const relay = makeRelay({ respond: (p) => answer((p as UpstreamBody).id) });
    const { res, text, json } = await send(relay, call('getSlot', [], 1));
    expect(res.status).toBe(502);
    expect(text).not.toContain(FAKE_KEY);
    expect(json).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'RPC upstream unavailable' },
    });
    expect(relay.logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'upstream_failed',
        fields: expect.objectContaining({ reason: 'secret_echo' }),
      }),
    );
    expectNoKeyInLogs(relay.logger);
  });

  it('hides upstream HTTP errors and thrown fetch errors', async () => {
    const http = makeRelay({
      respond: () =>
        new Response(`invalid api key ${FAKE_KEY} for ${UPSTREAM_URL}`, { status: 401 }),
    });
    const a = await send(http, call('getSlot'));
    expect(a.res.status).toBe(502);
    expect(a.text).not.toContain(FAKE_KEY);

    const thrown = makeRelay({
      respond: () => {
        throw new TypeError(`fetch failed: ${UPSTREAM_URL}`);
      },
    });
    const b = await send(thrown, call('getSlot'));
    expect(b.res.status).toBe(502);
    expect(b.json).toMatchObject({ error: { message: 'RPC upstream unavailable' } });
    expectNoKeyInLogs(http.logger);
    expectNoKeyInLogs(thrown.logger);
  });

  it('maps upstream 429 to 503 with Retry-After, retrying reads once but never sends', async () => {
    const relay = makeRelay({
      respond: () => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
    });
    const read = await send(relay, call('getSlot'));
    expect(read.res.status).toBe(503);
    expect(read.res.headers.get('retry-after')).toBe('3');
    expect(read.json).toMatchObject({ error: { code: -32005 } });
    expect(relay.upstreamPayloads).toHaveLength(2);

    const sendRes = await send(relay, call('sendTransaction', [TX, { encoding: 'base64' }]));
    expect(sendRes.res.status).toBe(503);
    expect(relay.upstreamPayloads).toHaveLength(3);
  });

  it('maps 5xx, invalid JSON and oversized answers to 502', async () => {
    const five = makeRelay({ respond: () => new Response('oops', { status: 500 }) });
    expect((await send(five, call('getSlot'))).res.status).toBe(502);

    const invalid = makeRelay({ respond: () => new Response('<html>', { status: 200 }) });
    expect((await send(invalid, call('getSlot'))).res.status).toBe(502);

    const large = makeRelay({
      maxResponseBytes: 1024,
      respond: (p) =>
        okJson({ jsonrpc: '2.0', id: (p as UpstreamBody).id, result: 'x'.repeat(5000) }),
    });
    const tooLarge = await send(large, call('getAccountInfo', [PK]));
    expect(tooLarge.res.status).toBe(502);
    expect(tooLarge.json).toMatchObject({
      error: { message: 'RPC response too large (use dataSlice)' },
    });
    // The creator pool query keeps the same response cap.
    const scan = await send(large, call('getProgramAccounts', CREATOR_POOLS_PARAMS));
    expect(scan.res.status).toBe(502);
    expect(scan.json).toMatchObject({
      error: { message: 'RPC response too large (use dataSlice)' },
    });
  });

  it('maps a timeout to 504', async () => {
    const relay = makeRelay({
      timeoutMs: 20,
      respond: (_p, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    const { res, json } = await send(
      relay,
      call('sendTransaction', [TX, { encoding: 'base64' }], 2),
    );
    expect(res.status).toBe(504);
    expect(json).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32603, message: 'RPC upstream timeout' },
    });
  });

  it('answers per-call errors in a batch with refused calls when upstream fails', async () => {
    const relay = makeRelay({ respond: () => new Response('down', { status: 503 }) });
    const { res, json } = await send(relay, [
      call('getSlot', [], 1),
      call('getProgramAccounts', [PK], 2),
    ]);
    expect(res.status).toBe(200);
    expect(json).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'RPC upstream unavailable' } },
      {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32601, message: 'Method not allowed by the FORGE relay' },
      },
    ]);
  });
});

describe('rate limits', () => {
  const rule = (capacity: number, perMinute = 1) => ({ capacity, refillPerSecond: perMinute / 60 });

  it('limits per client IP, with Retry-After and CORS headers on the 429', async () => {
    const relay = makeRelay({ limits: { ip: rule(4) } });
    // Each getSlot costs overhead 1 + weight 1.
    expect((await send(relay, call('getSlot'))).res.status).toBe(200);
    expect((await send(relay, call('getSlot'))).res.status).toBe(200);
    const limited = await send(relay, call('getSlot', [], 'x'));
    expect(limited.res.status).toBe(429);
    expect(Number(limited.res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.res.headers.get('access-control-allow-origin')).toBe(CLIENT);
    expect(limited.json).toMatchObject({ jsonrpc: '2.0', error: { code: -32005 } });
    // Another IP is not affected.
    expect((await send(relay, call('getSlot'), { ip: '203.0.113.9' })).res.status).toBe(200);
    expect(relay.logger.events()).toContain('rate_limited');
    expect(JSON.stringify(relay.logger.entries)).not.toContain('198.51.100.1');
  });

  it('never refuses per origin (anyone can send it): the origin bucket only alerts', async () => {
    const relay = makeRelay({ limits: { origin: rule(2) } });
    for (let i = 1; i <= 5; i++) {
      expect((await send(relay, call('getSlot'), { ip: `203.0.113.${i}` })).res.status).toBe(200);
    }
    // One alert per bucket per minute, naming the bucket family only.
    const alerts = relay.logger.entries.filter((e) => e.event === 'budget_alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.fields).toMatchObject({ bucket: 'origin', tier: 'browser', origin: CLIENT });
    expect(relay.logger.events()).not.toContain('rate_limited');
  });

  it('charges a creator pool query its high weight', async () => {
    const perRequest = 1 + CREATOR_POOLS_WEIGHT;
    const relay = makeRelay({ limits: { ip: rule(2 * perRequest) } });
    const scan = () => send(relay, call('getProgramAccounts', CREATOR_POOLS_PARAMS));
    expect((await scan()).res.status).toBe(200);
    expect((await scan()).res.status).toBe(200);
    expect((await scan()).res.status).toBe(429);
    expect(relay.upstreamPayloads).toHaveLength(2);
  });

  it('is stricter for sendTransaction than for reads', async () => {
    const relay = makeRelay({ limits: { sendPerCaller: rule(2) } });
    const sendTx = () => send(relay, call('sendTransaction', [TX, { encoding: 'base64' }]));
    expect((await sendTx()).res.status).toBe(200);
    expect((await sendTx()).res.status).toBe(200);
    expect((await sendTx()).res.status).toBe(429);
    expect((await send(relay, call('getSignatureStatuses', [[SIG]]))).res.status).toBe(200);
  });

  it('keys the server tier by launchpad, not by the shared egress IP', async () => {
    const relay = makeRelay({ limits: { server: rule(4), ip: rule(1_000) } });
    const moon = deriveRelayToken(SECRET, 'moonpad');
    const sun = deriveRelayToken(SECRET, 'sun-pad');
    const viaServer = (token: string, ip: string) =>
      send(relay, call('getSlot'), { origin: null, token, ip });
    expect((await viaServer(moon, '76.76.21.1')).res.status).toBe(200);
    expect((await viaServer(moon, '76.76.21.2')).res.status).toBe(200);
    expect((await viaServer(moon, '76.76.21.3')).res.status).toBe(429);
    expect((await viaServer(sun, '76.76.21.1')).res.status).toBe(200);
  });

  it('gives browser and anonymous callers the same per-IP bucket', async () => {
    const relay = makeRelay({ limits: { ip: rule(6) } });
    const ip = '192.0.2.1';
    // 2 units per getSlot: anonymous, then with an Origin header, then anonymous again.
    expect((await send(relay, call('getSlot'), { origin: null, ip })).res.status).toBe(200);
    expect((await send(relay, call('getSlot'), { ip })).res.status).toBe(200);
    expect((await send(relay, call('getSlot'), { origin: null, ip })).res.status).toBe(200);
    // The budget is spent whatever the caller claims to be.
    expect((await send(relay, call('getSlot'), { ip })).res.status).toBe(429);
    expect((await send(relay, call('getSlot'), { origin: null, ip })).res.status).toBe(429);
    expect((await send(relay, call('getSlot'), { origin: null, ip: '192.0.2.2' })).res.status).toBe(
      200,
    );
  });

  it('only alerts on the shared anonymous bucket', async () => {
    const relay = makeRelay({ limits: { anonymousGlobal: rule(2) } });
    for (let i = 1; i <= 4; i++) {
      const anon = await send(relay, call('getSlot'), { origin: null, ip: `192.0.2.${i}` });
      expect(anon.res.status).toBe(200);
    }
    const alerts = relay.logger.entries.filter((e) => e.event === 'budget_alert');
    expect(alerts.map((e) => e.fields.bucket)).toEqual(['anon']);
  });

  it('keeps the global cost ceiling for every tier', async () => {
    const relay = makeRelay({ limits: { global: rule(4) } });
    expect((await send(relay, call('getSlot'), { ip: '192.0.2.1' })).res.status).toBe(200);
    expect((await send(relay, call('getSlot'), { origin: null, ip: '192.0.2.2' })).res.status).toBe(
      200,
    );
    expect((await send(relay, call('getSlot'), { ip: '192.0.2.3' })).res.status).toBe(429);
    const token = deriveRelayToken(SECRET, 'moonpad');
    expect(
      (await send(relay, call('getSlot'), { origin: null, token, ip: '76.76.21.1' })).res.status,
    ).toBe(429);
  });

  it('charges invalid requests too', async () => {
    const relay = makeRelay({ limits: { ip: rule(3) } });
    for (let i = 0; i < 3; i++) {
      expect((await send(relay, null, { raw: 'not json' })).res.status).toBe(400);
    }
    expect((await send(relay, null, { raw: 'not json' })).res.status).toBe(429);
  });
});
