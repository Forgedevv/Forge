// @vitest-environment node
import { CLUSTER_GENESIS_HASH } from '@forge/core';
import { describe, expect, it } from 'vitest';
import { readRelayConfig, RelayConfigError, upstreamSelectionLog } from '../config';
import { containsSecret, secretFragments } from '../redact';
import { deriveRelayToken, readServerTokenSecret, verifyRelayToken } from '../server-token';
import { GENESIS_HASH } from '../upstream';
import { FAKE_KEY, UPSTREAM_URL } from './helpers';

/** The relay's own provider URL (a key distinct from RPC_URL's). */
const RELAY_URL = `https://devnet.relay-provider.example/?api-key=${FAKE_KEY}`;
const MAINNET_RPC = 'https://mainnet.helius-rpc.com/?api-key=x';
const MAINNET_RELAY = 'https://mainnet.relay-provider.example/?api-key=y';

/** Our devnet deployment: NODE_ENV=production on devnet, with the relay's own upstream. */
const BASE = {
  RPC_URL: UPSTREAM_URL,
  RPC_RELAY_UPSTREAM_URL: RELAY_URL,
  NEXT_PUBLIC_APP_URL: 'https://forge.example/some/path',
  CLIENTS_DOMAIN: 'Forge-Sites.app',
  NODE_ENV: 'production',
};
/** Local development: not strict, the relay may fall back to RPC_URL. */
const DEV = { ...BASE, NODE_ENV: 'development', RPC_RELAY_UPSTREAM_URL: '' };

function expectConfigError(env: Record<string, string>, message: string) {
  let caught: unknown;
  try {
    readRelayConfig(env);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RelayConfigError);
  expect((caught as Error).message).toContain(message);
  // Error messages name variables, never values.
  expect((caught as Error).message).not.toContain(FAKE_KEY);
}

describe('readRelayConfig', () => {
  it('reads the devnet production configuration', () => {
    const config = readRelayConfig(BASE);
    expect(config.cluster).toBe('devnet');
    expect(config.upstreamUrl).toBe(RELAY_URL);
    expect(config.upstreamSource).toBe('RPC_RELAY_UPSTREAM_URL');
    expect(config.upstreamSharesRpcUrl).toBe(false);
    expect(config.appOrigin).toBe('https://forge.example');
    expect(config.clientsDomain).toBe('forge-sites.app');
    expect(config.allowLocalhost).toBe(false);
    expect(config.allowAnonymous).toBe(false);
    expect(config.tokenSecret).toBeNull();
    expect(config.supabase).toBeNull();
  });

  it('defaults to devnet and guards the cluster on the RPC host', () => {
    expectConfigError(
      { ...DEV, RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=x&c=devnet' },
      'devnet',
    );
    expectConfigError(
      { ...DEV, SOLANA_CLUSTER: 'mainnet-beta', RPC_RELAY_UPSTREAM_URL: RELAY_URL },
      'RPC_RELAY_UPSTREAM_URL host looks like a test cluster',
    );
    expect(
      readRelayConfig({
        ...BASE,
        SOLANA_CLUSTER: 'mainnet-beta',
        RPC_URL: MAINNET_RPC,
        RPC_RELAY_UPSTREAM_URL: MAINNET_RELAY,
      }).cluster,
    ).toBe('mainnet-beta');
    expectConfigError({ ...BASE, SOLANA_CLUSTER: 'testnet' }, 'SOLANA_CLUSTER');
  });

  it('validates every variable without echoing values', () => {
    expectConfigError({ ...DEV, RPC_URL: '' }, 'RPC_URL is not set');
    expectConfigError({ ...DEV, RPC_URL: `ftp://devnet.example/${FAKE_KEY}` }, 'RPC_URL must be');
    expectConfigError({ ...DEV, RPC_URL: `devnet ${FAKE_KEY}` }, 'RPC_URL is not a valid URL');
    expectConfigError({ ...BASE, CLIENTS_DOMAIN: 'https://forge-sites.app' }, 'CLIENTS_DOMAIN');
    expectConfigError({ ...BASE, RPC_RELAY_TOKEN_SECRET: 'short' }, 'at least 32 bytes');
    expectConfigError({ ...BASE, RPC_RELAY_ANONYMOUS: 'maybe' }, 'RPC_RELAY_ANONYMOUS');
    expectConfigError({ ...BASE, NEXT_PUBLIC_APP_URL: 'nope' }, 'NEXT_PUBLIC_APP_URL');
  });

  it('requires RPC_RELAY_UPSTREAM_URL in production and on mainnet, never falling back to RPC_URL', () => {
    for (const env of [
      { ...BASE, RPC_RELAY_UPSTREAM_URL: '' },
      { ...BASE, RPC_RELAY_UPSTREAM_URL: '  ' },
      { ...DEV, SOLANA_CLUSTER: 'mainnet-beta', RPC_URL: MAINNET_RPC },
      { ...BASE, SOLANA_CLUSTER: 'mainnet-beta', RPC_URL: MAINNET_RPC, RPC_RELAY_UPSTREAM_URL: '' },
    ]) {
      expectConfigError(
        env,
        'RPC_RELAY_UPSTREAM_URL is required in production and on mainnet-beta',
      );
    }
    // Our devnet deployment (NODE_ENV=production on devnet, its own relay upstream) keeps working.
    expect(readRelayConfig(BASE).upstreamSource).toBe('RPC_RELAY_UPSTREAM_URL');
  });

  it('uses RPC_URL outside production only, when RPC_RELAY_UPSTREAM_URL is not set', () => {
    for (const env of [
      DEV,
      { ...DEV, RPC_RELAY_UPSTREAM_URL: '  ' },
      { ...DEV, NODE_ENV: 'test' },
    ]) {
      const config = readRelayConfig(env);
      expect(config.upstreamUrl).toBe(UPSTREAM_URL);
      expect(config.upstreamSource).toBe('RPC_URL');
      expect(config.upstreamSharesRpcUrl).toBe(true);
    }
  });

  it('prefers RPC_RELAY_UPSTREAM_URL, validated like RPC_URL and https only', () => {
    const config = readRelayConfig({ ...DEV, RPC_RELAY_UPSTREAM_URL: RELAY_URL });
    expect(config.upstreamUrl).toBe(RELAY_URL);
    expect(config.upstreamSource).toBe('RPC_RELAY_UPSTREAM_URL');
    // RPC_URL is not even required then.
    expect(readRelayConfig({ ...BASE, RPC_URL: '' }).upstreamSource).toBe('RPC_RELAY_UPSTREAM_URL');

    // A set but invalid value is an error, never a silent fallback to RPC_URL.
    for (const env of [BASE, DEV]) {
      expectConfigError(
        { ...env, RPC_RELAY_UPSTREAM_URL: `http://devnet.example/?api-key=${FAKE_KEY}` },
        'RPC_RELAY_UPSTREAM_URL must be an https URL',
      );
      expectConfigError(
        { ...env, RPC_RELAY_UPSTREAM_URL: `devnet ${FAKE_KEY}` },
        'RPC_RELAY_UPSTREAM_URL is not a valid URL',
      );
      expectConfigError(
        {
          ...env,
          RPC_RELAY_UPSTREAM_URL: `https://mainnet.helius-rpc.com/?api-key=${FAKE_KEY}&c=devnet`,
        },
        'RPC_RELAY_UPSTREAM_URL host does not look like a devnet endpoint',
      );
    }
    expectConfigError(
      {
        ...BASE,
        SOLANA_CLUSTER: 'mainnet-beta',
        RPC_URL: MAINNET_RPC,
        RPC_RELAY_UPSTREAM_URL: RELAY_URL,
      },
      'RPC_RELAY_UPSTREAM_URL host looks like a test cluster',
    );
    expect(
      readRelayConfig({
        ...BASE,
        SOLANA_CLUSTER: 'mainnet-beta',
        RPC_URL: MAINNET_RPC,
        RPC_RELAY_UPSTREAM_URL: MAINNET_RELAY,
      }).upstreamSource,
    ).toBe('RPC_RELAY_UPSTREAM_URL');
  });

  it('flags a relay upstream that is the very same URL as RPC_URL', () => {
    const config = readRelayConfig({ ...BASE, RPC_RELAY_UPSTREAM_URL: UPSTREAM_URL });
    expect(config.upstreamSource).toBe('RPC_RELAY_UPSTREAM_URL');
    expect(config.upstreamSharesRpcUrl).toBe(true);
  });

  it('turns anonymous callers off by default in production and on mainnet', () => {
    expect(readRelayConfig(BASE).allowAnonymous).toBe(false);
    expect(
      readRelayConfig({
        ...DEV,
        SOLANA_CLUSTER: 'mainnet-beta',
        RPC_URL: MAINNET_RPC,
        RPC_RELAY_UPSTREAM_URL: MAINNET_RELAY,
      }).allowAnonymous,
    ).toBe(false);
    expect(readRelayConfig(DEV).allowAnonymous).toBe(true);
    // Explicit choices win in every mode.
    expect(readRelayConfig({ ...BASE, RPC_RELAY_ANONYMOUS: 'on' }).allowAnonymous).toBe(true);
    expect(readRelayConfig({ ...BASE, RPC_RELAY_ANONYMOUS: ' ON ' }).allowAnonymous).toBe(true);
    expect(readRelayConfig({ ...DEV, RPC_RELAY_ANONYMOUS: 'off' }).allowAnonymous).toBe(false);
  });

  it('describes the upstream choice by variable name only', () => {
    expect(upstreamSelectionLog({ upstreamSource: 'RPC_RELAY_UPSTREAM_URL' }, BASE)).toEqual({
      level: 'info',
      event: 'upstream_selected',
      fields: { upstream: 'RPC_RELAY_UPSTREAM_URL', sharedWithServerRoutes: false },
    });
    expect(upstreamSelectionLog({ upstreamSource: 'RPC_URL' }, BASE)).toMatchObject({
      level: 'warn',
      fields: { upstream: 'RPC_URL', sharedWithServerRoutes: true },
    });
    expect(
      upstreamSelectionLog(
        { upstreamSource: 'RPC_RELAY_UPSTREAM_URL', upstreamSharesRpcUrl: true },
        BASE,
      ),
    ).toMatchObject({
      level: 'warn',
      fields: { upstream: 'RPC_RELAY_UPSTREAM_URL', sharedWithServerRoutes: true },
    });
    expect(
      upstreamSelectionLog({ upstreamSource: 'RPC_URL' }, { NODE_ENV: 'development' }).level,
    ).toBe('info');
  });

  it('enables localhost outside production, the token tier and the directory', () => {
    const config = readRelayConfig({
      ...DEV,
      RPC_RELAY_TOKEN_SECRET: 'k'.repeat(32),
      RPC_RELAY_ANONYMOUS: 'off',
      SUPABASE_URL: 'https://db.example',
      SUPABASE_SERVICE_ROLE_KEY: 'service',
    });
    expect(config.allowLocalhost).toBe(true);
    expect(config.tokenSecret?.length).toBe(32);
    expect(config.allowAnonymous).toBe(false);
    expect(config.supabase).toEqual({ url: 'https://db.example', serviceRoleKey: 'service' });
  });
});

describe('genesis hashes', () => {
  it('match the ones of @forge/core', () => {
    expect(GENESIS_HASH).toEqual(CLUSTER_GENESIS_HASH);
  });
});

describe('secret fragments', () => {
  it('extracts query, userinfo and long path tokens', () => {
    expect(secretFragments(UPSTREAM_URL)).toContain(FAKE_KEY);
    expect(secretFragments('https://user:p4ssw0rd@devnet.example/rpc')).toEqual(
      expect.arrayContaining(['p4ssw0rd']),
    );
    const path = 'https://x.solana-devnet.quiknode.pro/0123456789abcdef0123/';
    expect(secretFragments(path)).toContain('0123456789abcdef0123');
    // A keyless public endpoint has nothing to hide (and short route names are ignored).
    expect(secretFragments('https://api.devnet.solana.com')).toEqual([]);
    expect(secretFragments('https://devnet.example/rpc/v1')).toEqual([]);
  });

  it('detects raw, encoded and JSON-escaped forms', () => {
    const fragments = secretFragments('https://devnet.example/?api-key=abc/def+ghi=jk&x=1');
    expect(containsSecret('{"m":"abc/def+ghi=jk"}', fragments)).toBe(true);
    expect(containsSecret(`{"m":"${encodeURIComponent('abc/def+ghi=jk')}"}`, fragments)).toBe(true);
    expect(containsSecret('{"m":"nothing"}', fragments)).toBe(false);
  });
});

describe('server tokens', () => {
  const secret = Buffer.from('z'.repeat(40));

  it('round-trips and binds the slug', () => {
    const token = deriveRelayToken(secret, 'moonpad');
    expect(token).toMatch(/^v1\.moonpad\.[0-9a-f]{64}$/);
    expect(verifyRelayToken(secret, token)).toBe('moonpad');
    const [, , mac] = token.split('.');
    expect(verifyRelayToken(secret, `v1.sunpad.${mac}`)).toBeNull();
  });

  it('refuses malformed tokens and other secrets', () => {
    const token = deriveRelayToken(secret, 'moonpad');
    expect(verifyRelayToken(Buffer.from('y'.repeat(40)), token)).toBeNull();
    expect(verifyRelayToken(secret, token.replace('v1.', 'v2.'))).toBeNull();
    expect(verifyRelayToken(secret, `${token}.x`)).toBeNull();
    expect(verifyRelayToken(secret, token.toUpperCase())).toBeNull();
    expect(verifyRelayToken(secret, `v1.MOON.${'0'.repeat(64)}`)).toBeNull();
    expect(verifyRelayToken(secret, 'x'.repeat(500))).toBeNull();
    expect(() => deriveRelayToken(secret, 'Bad Slug')).toThrow();
  });

  it('reads the shared secret once for every route that takes the token', () => {
    expect(readServerTokenSecret({})).toBeNull();
    expect(readServerTokenSecret({ RPC_RELAY_TOKEN_SECRET: '' })).toBeNull();
    expect(readServerTokenSecret({ RPC_RELAY_TOKEN_SECRET: 'x'.repeat(31) })).toBe('invalid');
    expect(readServerTokenSecret({ RPC_RELAY_TOKEN_SECRET: 'x'.repeat(32) })).toEqual(
      Buffer.from('x'.repeat(32)),
    );
  });
});
