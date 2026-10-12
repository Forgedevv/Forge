// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, DEVNET_GENESIS, FAKE_KEY, UPSTREAM_URL } from './helpers';

/*
 * The route files with the production wiring (environment -> config -> handler), the provider
 * mocked at the fetch level.
 */

const FORGE = 'https://forge.example';

function rpcRequest(body: unknown, origin: string | null = FORGE): Request {
  return new Request(`${FORGE}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  vi.stubEnv('RPC_URL', UPSTREAM_URL);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', FORGE);
  vi.stubEnv('CLIENTS_DOMAIN', 'forge-sites.app');
  vi.stubEnv('SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  vi.stubEnv('RPC_RELAY_TOKEN_SECRET', '');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function loggedText(): string {
  const spies = [console.info, console.warn, console.error] as unknown as {
    mock: { calls: unknown[][] };
  }[];
  return JSON.stringify(spies.map((s) => s.mock.calls));
}

// The dynamic import of the route (fresh module graph per test) can be slow on a loaded machine.
describe('app/api/rpc/route', { timeout: 30_000 }, () => {
  it('relays through the environment-configured upstream', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(UPSTREAM_URL);
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      const result = body.method === 'getGenesisHash' ? DEVNET_GENESIS : 4242;
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { POST, OPTIONS } = await import('../../../../app/api/rpc/route');

    const res = await POST(rpcRequest(call('getSlot', [], 'id-1')));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(FORGE);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 'id-1', result: 4242 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // genesis check + the call

    // Without Supabase, client-site origins are refused (fail closed).
    const client = await POST(rpcRequest(call('getSlot'), 'https://moonpad.forge-sites.app'));
    expect(client.status).toBe(403);
    const preflight = await OPTIONS(
      new Request(`${FORGE}/api/rpc`, {
        method: 'OPTIONS',
        headers: { origin: FORGE, 'access-control-request-method': 'POST' },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(loggedText()).not.toContain(FAKE_KEY);
  });

  it('prefers RPC_RELAY_UPSTREAM_URL and logs once which variable it uses, never the URL', async () => {
    const RELAY_KEY = 'relay-only-key-0123456789abcdef';
    const RELAY_URL = `https://devnet.helius-rpc.com/?api-key=${RELAY_KEY}`;
    vi.stubEnv('RPC_RELAY_UPSTREAM_URL', RELAY_URL);
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(RELAY_URL);
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      const result = body.method === 'getGenesisHash' ? DEVNET_GENESIS : 4242;
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../../../../app/api/rpc/route');
    expect((await POST(rpcRequest(call('getSlot')))).status).toBe(200);
    expect((await POST(rpcRequest(call('getSlot')))).status).toBe(200);

    const lines = (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('upstream_selected'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'upstream_selected',
      upstream: 'RPC_RELAY_UPSTREAM_URL',
      sharedWithServerRoutes: false,
    });
    const logs = loggedText();
    expect(logs).not.toContain(RELAY_KEY);
    expect(logs).not.toContain(FAKE_KEY);
    expect(logs).not.toContain('helius');
  });

  it('warns at startup in production when the relay shares RPC_URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { id: number; method: string };
        const result = body.method === 'getGenesisHash' ? DEVNET_GENESIS : 4242;
        return Response.json({ jsonrpc: '2.0', id: body.id, result });
      }),
    );
    const { POST } = await import('../../../../app/api/rpc/route');
    await POST(rpcRequest(call('getSlot')));
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('upstream_selected'));
    expect(warned).toHaveLength(1);
    expect(JSON.parse(warned[0]!)).toMatchObject({
      upstream: 'RPC_URL',
      sharedWithServerRoutes: true,
    });
    expect(loggedText()).not.toContain(FAKE_KEY);
  });

  it('answers 503 without detail on a configuration error, and names only the variable', async () => {
    vi.stubEnv('RPC_URL', `https://mainnet.helius-rpc.com/?api-key=${FAKE_KEY}`);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../../../../app/api/rpc/route');
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain('helius');
    expect(fetchMock).not.toHaveBeenCalled();
    const logs = loggedText();
    expect(logs).toContain('config_error');
    expect(logs).toContain('RPC_URL');
    expect(logs).not.toContain(FAKE_KEY);
  });
});
