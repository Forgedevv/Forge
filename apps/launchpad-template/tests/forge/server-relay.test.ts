import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createUploadClient, type UploadFetch } from '../../src/forge/create/upload-client';
import {
  RELAY_TOKEN_HEADER,
  createServerRelayConnection,
  readServerRelayToken,
  serverRelayHeaders,
} from '../../src/forge/server-relay';

const TOKEN = `v1.moon.${'ab'.repeat(32)}`;
const root = fileURLToPath(new URL('../../', import.meta.url));

describe('server relay token', () => {
  it('reads FORGE_RPC_RELAY_TOKEN only, trimmed, and refuses a malformed value', () => {
    expect(readServerRelayToken({ FORGE_RPC_RELAY_TOKEN: ` ${TOKEN}\n` })).toBe(TOKEN);
    expect(readServerRelayToken({})).toBeNull();
    expect(readServerRelayToken({ FORGE_RPC_RELAY_TOKEN: '' })).toBeNull();
    expect(readServerRelayToken({ NEXT_PUBLIC_FORGE_RPC_RELAY_TOKEN: TOKEN })).toBeNull();
    expect(readServerRelayToken({ FORGE_RPC_RELAY_TOKEN: 'a\r\nX-Evil: 1' })).toBeNull();
    expect(readServerRelayToken({ FORGE_RPC_RELAY_TOKEN: 'x'.repeat(129) })).toBeNull();
  });

  it('builds the header only when the token is set', () => {
    expect(serverRelayHeaders({ FORGE_RPC_RELAY_TOKEN: TOKEN })).toEqual({
      'X-Forge-Relay-Token': TOKEN,
    });
    expect(serverRelayHeaders({})).toEqual({});
  });

  it('sends the header on every relay JSON-RPC call', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch = vi.fn(async (url: unknown, init?: { headers?: unknown }) => {
      calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const connection = createServerRelayConnection(
      'https://forge.example/api/rpc',
      { FORGE_RPC_RELAY_TOKEN: TOKEN },
      { fetch: fetch as never },
    );
    await expect(connection.getSlot()).resolves.toBe(42);
    expect(calls[0]?.url).toBe('https://forge.example/api/rpc');
    const headers = Object.fromEntries(
      Object.entries(calls[0]?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(headers[RELAY_TOKEN_HEADER.toLowerCase()]).toBe(TOKEN);
  });

  it('sends no token header without a token', async () => {
    const seen: Record<string, string>[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: { headers?: unknown }) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: 1 }), { status: 200 });
    });
    const connection = createServerRelayConnection(
      'https://forge.example/api/rpc',
      {},
      {
        fetch: fetch as never,
      },
    );
    await connection.getSlot();
    expect(Object.keys(seen[0] ?? {}).map((k) => k.toLowerCase())).not.toContain(
      'x-forge-relay-token',
    );
  });
});

describe('upload client with the server token', () => {
  it('sends the token to the FORGE API calls, never to the storage PUT', async () => {
    const fetch = vi.fn<UploadFetch>().mockRejectedValue(new Error('offline'));
    const client = createUploadClient({
      apiBase: 'https://forge.example',
      slug: 'moon',
      fetch,
      retries: 0,
      sleep: async () => {},
      forgeHeaders: { [RELAY_TOKEN_HEADER]: TOKEN },
    });
    const request = {
      version: 1 as const,
      mint: '11111111111111111111111111111111',
      wallet: '11111111111111111111111111111111',
      coin: { name: 'Moon', symbol: 'MOON', description: '' },
      firstBuyLamports: '0',
      image: { contentType: 'image/png' as const, size: 1, sha256: 'a'.repeat(64) },
      auth: { host: 'moon.example', nonce: 'b'.repeat(32), issuedAt: 'now', signature: 'sig' },
    };
    await expect(client.uploadCoin(request, new Uint8Array(1))).rejects.toBeTruthy();
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.headers[RELAY_TOKEN_HEADER]).toBe(TOKEN);
    expect(init?.headers['Content-Type']).toBe('application/json');
  });
});

describe('server token wiring', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it('the upload route uses the token for the relay connection and the upload client', () => {
    const route = readFileSync(join(root, 'src/pages/api/upload.ts'), 'utf8');
    expect(route).toMatch(/connection: createServerRelayConnection\(relay\)/);
    expect(route).toMatch(/forgeHeaders: serverRelayHeaders\(\)/);
    expect(route).not.toMatch(/new Connection\(/);
  });

  it('the coins route uses the token for its relay connection', () => {
    const route = readFileSync(join(root, 'src/pages/api/coins.ts'), 'utf8');
    expect(route).toMatch(/connection: createServerRelayConnection\(relay\)/);
    expect(route).not.toMatch(/new Connection\(/);
  });

  it('only server code reads the token, and never under a NEXT_PUBLIC_ name', () => {
    const readers = sourceFiles(join(root, 'src'))
      .filter((file) =>
        /FORGE_RPC_RELAY_TOKEN|from '[^']*server-relay'/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(root, file).split('\\').join('/'))
      .sort();
    expect(readers).toEqual([
      'src/forge/server-relay.ts',
      'src/pages/api/coins.ts',
      'src/pages/api/upload.ts',
    ]);
    for (const file of sourceFiles(join(root, 'src'))) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/NEXT_PUBLIC_FORGE_RPC_RELAY_TOKEN/);
    }
  });

  it('documents the token as server only in .env.example', () => {
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    expect(example).toMatch(/^FORGE_RPC_RELAY_TOKEN=$/m);
    expect(example).not.toMatch(/NEXT_PUBLIC_FORGE_RPC_RELAY_TOKEN/);
  });
});
