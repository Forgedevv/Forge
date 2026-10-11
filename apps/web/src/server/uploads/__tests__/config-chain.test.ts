// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ChainReadError, createRpcMintChecker } from '../chain';
import { readClientsDomain, readR2Options, UploadConfigError } from '../config';

const R2_ENV = {
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_ACCESS_KEY_ID: '0123456789abcdef0123456789abcdef',
  R2_SECRET_ACCESS_KEY: 'super-secret-value-0123456789abcdef0123456789abcdef0123456789ab',
  R2_BUCKET: 'forge-dev',
  R2_PUBLIC_URL: 'https://pub-0123456789abcdef0123456789abcdef.r2.dev/',
};

describe('upload configuration', () => {
  it('reads the R2 settings', () => {
    expect(readR2Options(R2_ENV)).toEqual({
      accountId: R2_ENV.R2_ACCOUNT_ID,
      bucket: 'forge-dev',
      credentials: {
        accessKeyId: R2_ENV.R2_ACCESS_KEY_ID,
        secretAccessKey: R2_ENV.R2_SECRET_ACCESS_KEY,
      },
      publicBaseUrl: 'https://pub-0123456789abcdef0123456789abcdef.r2.dev',
    });
    expect(
      readR2Options({ ...R2_ENV, R2_ENDPOINT: 'https://x.eu.r2.cloudflarestorage.com' }).endpoint,
    ).toBe('https://x.eu.r2.cloudflarestorage.com');
  });

  it('names invalid variables without their values', () => {
    let error: unknown;
    try {
      readR2Options({
        ...R2_ENV,
        R2_PUBLIC_URL: 'http://insecure.example',
        R2_SECRET_ACCESS_KEY: '',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UploadConfigError);
    expect((error as UploadConfigError).variables).toEqual([
      'R2_SECRET_ACCESS_KEY',
      'R2_PUBLIC_URL',
    ]);
    expect((error as Error).message).not.toContain('insecure');
    expect(() => readR2Options({ ...R2_ENV, R2_ENDPOINT: 'https://x.example/path' })).toThrow(
      UploadConfigError,
    );
  });

  it('reads CLIENTS_DOMAIN', () => {
    expect(readClientsDomain({})).toBeNull();
    expect(readClientsDomain({ CLIENTS_DOMAIN: ' Forge-Sites.App ' })).toBe('forge-sites.app');
    expect(() => readClientsDomain({ CLIENTS_DOMAIN: 'https://forge-sites.app' })).toThrow(
      UploadConfigError,
    );
  });
});

describe('RPC mint checker', () => {
  function rpc(responses: (unknown | Error | number)[]) {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'number') return new Response('busy', { status: next });
      return Response.json(next);
    };
    return { fetch: fetchImpl as unknown as typeof fetch, bodies };
  }

  it('reports whether an account exists at the address', async () => {
    const { fetch, bodies } = rpc([
      { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: null } },
      { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { lamports: 1 } } },
    ]);
    const checker = createRpcMintChecker({
      rpcUrl: 'https://rpc.example',
      fetch,
      sleep: async () => undefined,
    });
    await expect(
      checker.accountExists('So11111111111111111111111111111111111111112'),
    ).resolves.toBe(false);
    await expect(
      checker.accountExists('So11111111111111111111111111111111111111112'),
    ).resolves.toBe(true);
    expect(bodies[0]).toMatchObject({
      method: 'getAccountInfo',
      params: ['So11111111111111111111111111111111111111112', { encoding: 'base64' }],
    });
  });

  it('retries network errors, 5xx and RPC errors, then throws ChainReadError', async () => {
    const ok = { jsonrpc: '2.0', id: 1, result: { value: null } };
    let { fetch } = rpc([new TypeError('fetch failed'), 503, ok]);
    const sleep = async () => undefined;
    await expect(
      createRpcMintChecker({ rpcUrl: 'https://rpc.example', fetch, sleep }).accountExists('x'),
    ).resolves.toBe(false);
    ({ fetch } = rpc([
      { jsonrpc: '2.0', id: 1, error: { code: -32005 } },
      500,
      new TypeError('x'),
    ]));
    await expect(
      createRpcMintChecker({ rpcUrl: 'https://rpc.example', fetch, sleep }).accountExists('x'),
    ).rejects.toBeInstanceOf(ChainReadError);
  });
});
