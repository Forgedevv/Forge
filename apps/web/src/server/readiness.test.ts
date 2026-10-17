// @vitest-environment node
import { PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as healthRoute from '../../app/api/health/route';
import { register } from '../../instrumentation';
import {
  browserClusterProblem,
  checkServerReadiness,
  healthResponse,
  logReadiness,
  logStartupReadiness,
} from './readiness';
import type { LogFields, LogLevel, RoutesLogger } from './jobs/log';

const SECRET_MARK = 'SUPERSECRETVALUE';

/** A complete devnet environment (test mode: the relay may fall back to RPC_URL). */
const READY: Record<string, string> = {
  NODE_ENV: 'test',
  SOLANA_CLUSTER: 'devnet',
  RPC_URL: `https://devnet.helius-rpc.com/?api-key=${SECRET_MARK}`,
  RPC_RELAY_UPSTREAM_URL: '',
  FORGE_CASHBOX_WALLET: PublicKey.unique().toBase58(),
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: `service-role-${SECRET_MARK}`,
  SUPABASE_ANON_KEY: 'anon-key-value',
  SESSION_SECRET: 's'.repeat(40),
  SUPABASE_JWT_SECRET: 'j'.repeat(40),
  NEXT_PUBLIC_APP_URL: 'https://forge.test',
  ANTHROPIC_API_KEY: `sk-ant-${SECRET_MARK}`,
  FORGE_BETA_MODE: 'off',
  FORGE_BETA_ALLOWLIST: '',
  NEXT_PUBLIC_SOLANA_CLUSTER: 'devnet',
  SOL_USD_PRICE_MIN: '',
  SOL_USD_PRICE_MAX: '',
  SOL_USD_PRICE_MAX_DEVIATION_PCT: '',
  CLIENTS_DOMAIN: '',
  RPC_RELAY_ANONYMOUS: '',
  RPC_RELAY_TOKEN_SECRET: '',
};

/** A complete mainnet-beta production environment. */
const MAINNET: Record<string, string> = {
  ...READY,
  NODE_ENV: 'production',
  SOLANA_CLUSTER: 'mainnet-beta',
  NEXT_PUBLIC_SOLANA_CLUSTER: 'mainnet-beta',
  RPC_URL: `https://mainnet.helius-rpc.com/?api-key=${SECRET_MARK}`,
  RPC_RELAY_UPSTREAM_URL: `https://mainnet.helius-rpc.com/?api-key=relay-${SECRET_MARK}`,
};

function stubAll(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

class Recorder implements RoutesLogger {
  readonly entries: { level: LogLevel; event: string; fields: LogFields }[] = [];
  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.entries.push({ level, event, fields });
  }
}

const LOGGED_KEY = Symbol.for('forge.web.readiness.logged');

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[LOGGED_KEY];
  stubAll(READY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('checkServerReadiness', () => {
  it('is ready with a complete environment, on its cluster', () => {
    expect(checkServerReadiness()).toEqual({ ok: true, cluster: 'devnet' });
    stubAll(MAINNET);
    expect(checkServerReadiness()).toEqual({ ok: true, cluster: 'mainnet-beta' });
  });

  it('names the missing or invalid variables of every area, never a value', () => {
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('SUPABASE_JWT_SECRET', 'short');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('SUPABASE_ANON_KEY', '');
    vi.stubEnv('FORGE_CASHBOX_WALLET', 'not-a-key');
    expect(checkServerReadiness()).toEqual({
      ok: false,
      code: 'config_invalid',
      problems: [
        'FORGE_CASHBOX_WALLET is not a valid Solana public key',
        'SESSION_SECRET is not set',
        'SUPABASE_JWT_SECRET must be at least 32 bytes',
        'ANTHROPIC_API_KEY is not set',
        'SUPABASE_ANON_KEY is not set',
      ],
    });
    // An RPC endpoint on the wrong cluster is named, its key never shown.
    stubAll({ ...READY, RPC_URL: `https://mainnet.helius-rpc.com/?api-key=${SECRET_MARK}` });
    const rpc = checkServerReadiness();
    expect(rpc).toMatchObject({ ok: false, code: 'config_invalid' });
    const text = rpc.ok ? '' : rpc.problems.join('\n');
    expect(text).toContain('RPC_URL does not look like a devnet endpoint');
    expect(text).not.toContain(SECRET_MARK);
  });

  it('needs the relay upstream and a usable beta policy in production', () => {
    stubAll({ ...MAINNET, RPC_RELAY_UPSTREAM_URL: '' });
    expect(checkServerReadiness()).toMatchObject({
      ok: false,
      code: 'config_invalid',
      problems: [expect.stringContaining('RPC_RELAY_UPSTREAM_URL is required')],
    });
    // Production default: the beta is on, and an empty allowlist lets nobody in.
    stubAll({ ...MAINNET, FORGE_BETA_MODE: '' });
    expect(checkServerReadiness()).toMatchObject({
      ok: false,
      problems: ['FORGE_BETA_ALLOWLIST is empty while the beta is on'],
    });
  });

  it('reports a browser bundle built for another cluster', () => {
    stubAll({ ...MAINNET, NEXT_PUBLIC_SOLANA_CLUSTER: 'devnet' });
    expect(checkServerReadiness()).toEqual({
      ok: false,
      code: 'cluster_mismatch',
      problems: ['NEXT_PUBLIC_SOLANA_CLUSTER does not match SOLANA_CLUSTER'],
    });
    // In production the browser cluster must be set.
    stubAll({ ...MAINNET, NEXT_PUBLIC_SOLANA_CLUSTER: '' });
    expect(checkServerReadiness()).toMatchObject({ ok: false, code: 'cluster_mismatch' });
    // The build-time value can be passed explicitly.
    stubAll(MAINNET);
    expect(checkServerReadiness('devnet')).toMatchObject({ ok: false, code: 'cluster_mismatch' });
    expect(checkServerReadiness('mainnet-beta')).toEqual({ ok: true, cluster: 'mainnet-beta' });
  });
});

describe('browserClusterProblem', () => {
  it('requires the same cluster, set in production, devnet when unset otherwise', () => {
    expect(browserClusterProblem('devnet', 'devnet', true)).toBeNull();
    expect(browserClusterProblem('mainnet-beta', ' mainnet-beta ', true)).toBeNull();
    expect(browserClusterProblem('mainnet-beta', 'devnet', false)).toMatch(/does not match/);
    expect(browserClusterProblem('mainnet-beta', 'mainnet', true)).toMatch(/does not match/);
    expect(browserClusterProblem('devnet', undefined, true)).toBe(
      'NEXT_PUBLIC_SOLANA_CLUSTER is not set',
    );
    expect(browserClusterProblem('devnet', '', false)).toBeNull();
    expect(browserClusterProblem('mainnet-beta', undefined, false)).toMatch(/is not set/);
  });
});

describe('GET /api/health', () => {
  it('is dynamic, on the Node.js runtime', () => {
    expect(healthRoute.runtime).toBe('nodejs');
    expect(healthRoute.dynamic).toBe('force-dynamic');
  });

  it('answers 200 when ready', async () => {
    const res = healthRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('answers 503 with a generic code only, and logs the details server-side', async () => {
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const logger = new Recorder();
    const res = healthResponse(logger);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, code: 'config_invalid' });
    expect(text).not.toMatch(/SESSION|SUPABASE|SECRET|KEY/);
    expect(logger.entries).toEqual([
      {
        level: 'error',
        event: 'server_not_ready',
        fields: {
          phase: 'health',
          code: 'config_invalid',
          problems: expect.stringContaining('SESSION_SECRET is not set'),
        },
      },
    ]);
    expect(String(logger.entries[0]!.fields.problems)).toContain(
      'SUPABASE_SERVICE_ROLE_KEY is not set',
    );
  });

  it('answers 503 cluster_mismatch for a bundle built for another cluster', async () => {
    vi.stubEnv('NEXT_PUBLIC_SOLANA_CLUSTER', 'mainnet-beta');
    const res = healthResponse(new Recorder());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, code: 'cluster_mismatch' });
  });

  it('logs each distinct result once, however often it is polled', () => {
    const logger = new Recorder();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    healthResponse(logger);
    healthResponse(logger);
    vi.stubEnv('ANTHROPIC_API_KEY', READY.ANTHROPIC_API_KEY!);
    healthResponse(logger);
    healthResponse(logger);
    expect(logger.entries.map((e) => e.event)).toEqual(['server_not_ready', 'server_ready']);
  });
});

describe('startup (instrumentation.ts)', () => {
  it('logs the readiness once at startup and never throws', () => {
    vi.stubEnv('SESSION_SECRET', '');
    const logger = new Recorder();
    expect(logStartupReadiness(logger)).toMatchObject({ ok: false, code: 'config_invalid' });
    expect(logger.entries).toMatchObject([
      { level: 'error', event: 'server_not_ready', fields: { phase: 'startup' } },
    ]);
  });

  it('runs on the Node.js runtime only', async () => {
    vi.stubEnv('SESSION_SECRET', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(error).not.toHaveBeenCalled();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await expect(register()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(error.mock.calls[0]![0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      scope: 'readiness',
      level: 'error',
      event: 'server_not_ready',
      phase: 'startup',
      code: 'config_invalid',
    });
    expect(String(line.problems)).toContain('SESSION_SECRET is not set');
    expect(JSON.stringify(line)).not.toContain(SECRET_MARK);
  });

  it('logs a ready instance at info level', () => {
    const logger = new Recorder();
    logReadiness({ ok: true, cluster: 'devnet' }, 'startup', logger);
    expect(logger.entries).toEqual([
      { level: 'info', event: 'server_ready', fields: { phase: 'startup', cluster: 'devnet' } },
    ]);
  });
});
