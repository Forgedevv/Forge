/// <reference types="node" />
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from './http-mock.js';
import {
  BUILDER_ADDRESSES,
  BUILDER_ENV_NAMES,
  checkStartupConfig,
  loadBuilderEnv,
  startBuilder,
} from './index.js';
import { address, silentLogger } from './pipeline/test-fakes.js';
import { fakeDocker } from './sandbox/test-helpers.js';

const SECRET_VALUES = {
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value',
  ANTHROPIC_API_KEY: 'sk-ant-api-key-secret-value-0123',
  SIGNER_HMAC_SECRET: 'h'.repeat(48),
  VERCEL_TOKEN: 'vercel-token-secret-value',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
};

function baseEnv(
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    SOLANA_CLUSTER: 'devnet',
    SUPABASE_URL: 'https://db.example.supabase.co',
    SIGNER_URL: 'http://10.0.0.2:8080',
    CLIENTS_DOMAIN: 'clients.test',
    GITHUB_APP_ID: '12345',
    GITHUB_ORG: 'forge-org',
    VERCEL_TEAM_ID: 'team_abcdefgh12',
    FORGE_MULTISIG_VAULT: address(10),
    FORGE_METEORA_REFERRAL_ACCOUNT: address(11),
    FORGE_PLATFORM_FEE_WALLET: address(12),
    FORGE_JUPITER_REFERRAL_ACCOUNT: address(13),
    NEXT_PUBLIC_FORGE_RPC_RELAY_URL: 'https://forge.test/api/rpc',
    R2_PUBLIC_URL: 'https://cdn.forge.test',
    ...SECRET_VALUES,
    ...over,
  };
}

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected an error');
}

describe('builder environment', () => {
  it('parses a complete environment with defaults', () => {
    const env = loadBuilderEnv(baseEnv({ SOLANA_CLUSTER: undefined }));
    expect(env).toMatchObject({
      SOLANA_CLUSTER: 'devnet',
      FORGE_GATEWAY_HOST: '127.0.0.1',
      FORGE_GATEWAY_PORT: 8787,
      BUILDER_AGENT_MODEL: 'claude-sonnet-5-5',
      BUILDER_SLEEP_ENABLED: true,
    });
  });

  it('names missing or invalid variables without their values', () => {
    const message = errorOf(() =>
      loadBuilderEnv(
        baseEnv({
          SUPABASE_URL: undefined,
          SIGNER_HMAC_SECRET: 'too-short',
          ANTHROPIC_API_KEY: '',
          BUILDER_AGENT_MODEL: 'some-unpriced-model',
        }),
      ),
    );
    expect(message).toContain('SUPABASE_URL');
    expect(message).toContain('SIGNER_HMAC_SECRET');
    expect(message).toContain('ANTHROPIC_API_KEY');
    expect(message).toContain('BUILDER_AGENT_MODEL');
    expect(message).not.toContain('too-short');
    for (const value of Object.values(SECRET_VALUES)) expect(message).not.toContain(value);
  });

  it('checks the FORGE addresses with @forge/core', () => {
    const message = errorOf(() =>
      checkStartupConfig(
        baseEnv({ FORGE_PLATFORM_FEE_WALLET: undefined, FORGE_MULTISIG_VAULT: 'not-a-key' }),
      ),
    );
    expect(message).toMatch(/missing: FORGE_PLATFORM_FEE_WALLET/);
    expect(message).toMatch(/invalid Solana public key: FORGE_MULTISIG_VAULT/);
    expect(message).not.toContain('not-a-key');
  });

  it('refuses to start without the public variables of client projects', () => {
    expect(errorOf(() => checkStartupConfig(baseEnv({ R2_PUBLIC_URL: undefined })))).toMatch(
      /missing: R2_PUBLIC_URL/,
    );
    // The relay must be a FORGE endpoint, never the RPC provider itself.
    expect(
      errorOf(() =>
        checkStartupConfig(
          baseEnv({
            RPC_URL: 'https://devnet.helius-rpc.com/?api-key=abc',
            NEXT_PUBLIC_FORGE_RPC_RELAY_URL: 'https://devnet.helius-rpc.com/relay',
          }),
        ),
      ),
    ).toMatch(/invalid: NEXT_PUBLIC_FORGE_RPC_RELAY_URL/);
  });

  it('gives client projects public values only, on the builder cluster', () => {
    const { projectEnv } = checkStartupConfig(
      baseEnv({ JUPITER_API_KEY: 'jup-secret', R2_SECRET_ACCESS_KEY: 'r2-secret' }),
    );
    expect(projectEnv.SOLANA_CLUSTER).toBe('devnet');
    expect(projectEnv.NEXT_PUBLIC_SOLANA_CLUSTER).toBe('devnet');
    expect(projectEnv.FORGE_PLATFORM_FEE_WALLET).toBe(address(12));
    expect(Object.keys(projectEnv)).not.toContain('JUPITER_API_KEY');
    expect(Object.keys(projectEnv)).not.toContain('R2_SECRET_ACCESS_KEY');
    expect(Object.keys(projectEnv)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});

describe('.env.example', () => {
  it('documents every variable of the builder, with no value for secrets', async () => {
    const text = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
    const names = new Set(lines.map((l) => l.slice(0, l.indexOf('='))));
    const expected = [
      ...BUILDER_ENV_NAMES,
      ...BUILDER_ADDRESSES,
      'SUPABASE_URL',
      'BUILDER_CONCURRENCY',
      'BUILDER_POLL_INTERVAL_MS',
      'BUILDER_WORKER_ID',
      'FORGE_SANDBOX_IMAGE',
      'FORGE_SANDBOX_PROXY_IMAGE',
      'FORGE_SANDBOX_JOBS_ROOT',
      'FORGE_SANDBOX_GATEWAY_UPSTREAM',
      'GITHUB_APP_ID',
      'GITHUB_ORG',
      'GITHUB_APP_PRIVATE_KEY_PATH',
      'GITHUB_APP_PRIVATE_KEY',
      'VERCEL_TOKEN',
      'VERCEL_TEAM_ID',
      'NEXT_PUBLIC_FORGE_RPC_RELAY_URL',
      'R2_PUBLIC_URL',
    ];
    for (const name of expected) expect(names.has(name), name).toBe(true);
    for (const line of lines) {
      const [name, value] = [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)];
      if (/KEY|SECRET|TOKEN|PRIVATE/.test(name)) expect(value, name).toBe('');
    }
  });
});

describe('builder process', () => {
  let jobsRoot: string | undefined;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (jobsRoot) await rm(jobsRoot, { recursive: true, force: true });
  });

  it('cleans the sandbox, listens, polls jobs and stops cleanly', async () => {
    jobsRoot = await mkdtemp(path.join(tmpdir(), 'forge-builder-start-'));
    const stub = stubFetch([
      { method: 'POST', path: '/rest/v1/rpc/fail_stale_jobs', handler: () => json([]) },
      { method: 'POST', path: '/rest/v1/rpc/take_post_approval_job', handler: () => json([]) },
      { method: 'POST', path: '/rest/v1/rpc/take_build_job', handler: () => json([]) },
      { method: 'GET', path: '/rest/v1/flags', handler: () => json([]) },
    ]);
    vi.stubGlobal('fetch', stub.fetch);
    const docker = fakeDocker();
    const env = baseEnv({
      FORGE_SANDBOX_IMAGE: `sha256:${'a'.repeat(64)}`,
      FORGE_SANDBOX_PROXY_IMAGE: `sha256:${'b'.repeat(64)}`,
      FORGE_SANDBOX_JOBS_ROOT: jobsRoot,
      FORGE_SANDBOX_GATEWAY_UPSTREAM: 'host.docker.internal:8787',
      BUILDER_POLL_INTERVAL_MS: '500',
      // Lines copied empty from .env.example are ignored by every loader.
      BUILDER_WORKER_ID: '',
      GITHUB_TEMPLATE_REPO: '',
      GITHUB_APP_PRIVATE_KEY_PATH: '',
      VERCEL_TEAM: '',
      FORGE_SANDBOX_RUNTIME: '',
      FORGE_GATEWAY_UPSTREAM_URL: '',
    });

    const builder = await startBuilder({
      env,
      logger: silentLogger(),
      handleSignals: false,
      spawn: docker.spawn,
      gatewayPort: 0,
    });
    try {
      // Stale sandbox resources were looked up before anything else.
      expect(docker.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(
        expect.arrayContaining(['ps --all', 'network ls']),
      );
      const address = builder.gateway.server.address();
      expect(address && typeof address === 'object' ? address.address : '').toBe('127.0.0.1');
      for (
        let i = 0;
        i < 100 && stub.find('POST', '/rest/v1/rpc/take_build_job').length === 0;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(stub.find('POST', '/rest/v1/rpc/take_build_job').length).toBeGreaterThan(0);
      expect(builder.scheduler).toBeDefined();
    } finally {
      await builder.stop();
    }
    expect(builder.gateway.server.listening).toBe(false);
  });

  it('refuses to start without the sandbox gateway upstream', async () => {
    jobsRoot = await mkdtemp(path.join(tmpdir(), 'forge-builder-start-'));
    const env = baseEnv({
      FORGE_SANDBOX_IMAGE: `sha256:${'a'.repeat(64)}`,
      FORGE_SANDBOX_PROXY_IMAGE: `sha256:${'b'.repeat(64)}`,
      FORGE_SANDBOX_JOBS_ROOT: jobsRoot,
    });
    await expect(
      startBuilder({
        env,
        logger: silentLogger(),
        handleSignals: false,
        spawn: fakeDocker().spawn,
      }),
    ).rejects.toThrow(/FORGE_SANDBOX_GATEWAY_UPSTREAM/);
  });
});
