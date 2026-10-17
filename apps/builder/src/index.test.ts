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
  pipelineGateway,
  startBuilder,
  visualReviewSetup,
} from './index.js';
import { REVIEW_DEFAULTS } from './pipeline/index.js';
import { address, silentLogger } from './pipeline/test-fakes.js';
import { fakeDocker } from './sandbox/test-helpers.js';

const SECRET_VALUES = {
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value',
  ANTHROPIC_API_KEY: 'sk-ant-api-key-secret-value-0123',
  SIGNER_HMAC_SECRET: 'h'.repeat(48),
  RPC_RELAY_TOKEN_SECRET: 'r'.repeat(40),
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

  it('requires the Telegram alert variables on mainnet-beta only, naming no value', () => {
    const telegram = { TELEGRAM_BOT_TOKEN: 'bot-token-SECRETVALUE', TELEGRAM_CHAT_ID: '-100123' };
    const mainnet = (over: Record<string, string | undefined> = {}) =>
      baseEnv({ SOLANA_CLUSTER: 'mainnet-beta', ...over });
    // Devnet: alerts may stay in the log.
    expect(() => loadBuilderEnv(baseEnv())).not.toThrow();
    expect(errorOf(() => loadBuilderEnv(mainnet()))).toMatch(
      /TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID required on mainnet-beta/,
    );
    // One set: only the other is named, never the value.
    const one = errorOf(() =>
      loadBuilderEnv(mainnet({ TELEGRAM_BOT_TOKEN: telegram.TELEGRAM_BOT_TOKEN })),
    );
    expect(one).toContain('TELEGRAM_CHAT_ID');
    expect(one).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(one).not.toContain('SECRETVALUE');
    // Blank values are unset.
    expect(
      errorOf(() => loadBuilderEnv(mainnet({ TELEGRAM_BOT_TOKEN: ' ', TELEGRAM_CHAT_ID: '' }))),
    ).toMatch(/TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID required/);
    // Other problems are still named next to them.
    const both = errorOf(() => loadBuilderEnv(mainnet({ SUPABASE_URL: undefined })));
    expect(both).toMatch(/^invalid builder environment: SUPABASE_URL; TELEGRAM_BOT_TOKEN/);
    expect(loadBuilderEnv(mainnet(telegram)).SOLANA_CLUSTER).toBe('mainnet-beta');
  });

  it('requires the relay token secret, at least 32 bytes, without printing it', () => {
    for (const value of [undefined, '', 'short-relay-secret']) {
      const message = errorOf(() => loadBuilderEnv(baseEnv({ RPC_RELAY_TOKEN_SECRET: value })));
      expect(message).toContain('RPC_RELAY_TOKEN_SECRET');
      if (value) expect(message).not.toContain(value);
    }
  });

  it('never copies the relay token or its secret from the environment into client projects', () => {
    const { projectEnv } = checkStartupConfig(
      baseEnv({ FORGE_RPC_RELAY_TOKEN: `v1.moonpad.${'a'.repeat(64)}` }),
    );
    expect(Object.keys(projectEnv)).not.toContain('FORGE_RPC_RELAY_TOKEN');
    expect(Object.keys(projectEnv)).not.toContain('RPC_RELAY_TOKEN_SECRET');
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

describe('registry token (decision D26: @forge/core is public on npm)', () => {
  it('regression: the builder reads no GitHub Packages token and passes none to the pipeline', async () => {
    expect(BUILDER_ENV_NAMES).not.toContain('GITHUB_PACKAGES_TOKEN');
    const config = loadBuilderEnv(
      baseEnv({ GITHUB_PACKAGES_TOKEN: `ghp_${'a'.repeat(36)}`, NPM_TOKEN: 'npm-token-value' }),
    ) as Record<string, unknown>;
    expect(config.GITHUB_PACKAGES_TOKEN).toBeUndefined();
    expect(config.NPM_TOKEN).toBeUndefined();
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/packagesToken|GITHUB_PACKAGES_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN/);
    const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    expect(example).not.toMatch(/^(?:GITHUB_PACKAGES_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN)=/m);
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
      'FORGE_SANDBOX_REVIEW_IMAGE',
      'BUILDER_VISUAL_REVIEW',
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

describe('visual review setting', () => {
  const IMAGE = `sha256:${'c'.repeat(64)}`;
  const recorder = () => {
    const lines: Array<{ level: string; msg: string | undefined }> = [];
    return {
      lines,
      logger: {
        info: (_: object, msg?: string) => lines.push({ level: 'info', msg }),
        warn: (_: object, msg?: string) => lines.push({ level: 'warn', msg }),
      },
    };
  };

  it('is off unless asked for, and needs the review image', () => {
    const off = recorder();
    expect(visualReviewSetup({}, IMAGE, off.logger)).toBeUndefined();
    expect(off.lines).toEqual([{ level: 'info', msg: 'visual review off' }]);

    const on = recorder();
    expect(visualReviewSetup({ BUILDER_VISUAL_REVIEW: 'on' }, IMAGE, on.logger)).toEqual(
      REVIEW_DEFAULTS,
    );
    expect(on.lines[0]).toEqual({ level: 'info', msg: 'visual review enabled for new sites' });

    const missing = recorder();
    expect(
      visualReviewSetup({ BUILDER_VISUAL_REVIEW: 'on' }, null, missing.logger),
    ).toBeUndefined();
    expect(missing.lines[0]!.level).toBe('warn');
    expect(missing.lines[0]!.msg).toMatch(/FORGE_SANDBOX_REVIEW_IMAGE is not set/);

    expect(() => visualReviewSetup({ BUILDER_VISUAL_REVIEW: 'yes' }, IMAGE, off.logger)).toThrow(
      /BUILDER_VISUAL_REVIEW/,
    );
  });

  it('gives the pipeline the job cost from the gateway accounting', async () => {
    const calls: string[] = [];
    const gateway = pipelineGateway(
      {
        issueToken: async (jobId) => {
          calls.push(`issue ${jobId}`);
          return 'forge_gw_x';
        },
        revokeToken: async (token) => {
          calls.push(`revoke ${token}`);
        },
      },
      { getJobCost: async (jobId) => (jobId === 'job-1' ? 2.5 : 0) },
    );
    expect(await gateway.issueToken('job-1', { budgetUsd: 3 })).toBe('forge_gw_x');
    await gateway.revokeToken('forge_gw_x');
    expect(await gateway.jobCostUsd!('job-1')).toBe(2.5);
    expect(calls).toEqual(['issue job-1', 'revoke forge_gw_x']);
  });
});

describe('builder process', () => {
  let jobsRoot: string | undefined;
  const sandboxEnv = (root: string) =>
    baseEnv({
      FORGE_SANDBOX_IMAGE: `sha256:${'a'.repeat(64)}`,
      FORGE_SANDBOX_PROXY_IMAGE: `sha256:${'b'.repeat(64)}`,
      FORGE_SANDBOX_JOBS_ROOT: root,
      FORGE_SANDBOX_GATEWAY_UPSTREAM: 'host.docker.internal:8787',
    });
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
      { method: 'GET', path: '/rest/v1/launchpads', handler: () => json([]) },
      {
        method: 'GET',
        path: '/rest/v1/jobs',
        handler: () => json([{ id: 'job-1', api_cost_usd: '1.5' }]),
      },
      { method: 'GET', path: '/v1/health', handler: () => json({ ok: true, cluster: 'devnet' }) },
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
      // The signer's cluster was checked once, through the signed health route.
      const health = stub.find('GET', '/v1/health');
      expect(health).toHaveLength(1);
      expect(health[0]!.headers['x-forge-signature']).toMatch(/^[0-9a-f]{64}$/);
      // Stale sandbox resources were looked up before anything else.
      expect(docker.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(
        expect.arrayContaining(['ps --all', 'network ls']),
      );
      const address = builder.gateway.server.address();
      expect(address && typeof address === 'object' ? address.address : '').toBe('127.0.0.1');
      // The daily API budget was seeded from today's jobs before the gateway listened.
      const seed = stub.find('GET', '/rest/v1/jobs');
      expect(seed).toHaveLength(1);
      expect(seed[0]!.query.get('updated_at')).toBe(
        `gte.${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
      );
      for (
        let i = 0;
        i < 100 && stub.find('POST', '/rest/v1/rpc/take_build_job').length === 0;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(stub.find('POST', '/rest/v1/rpc/take_build_job').length).toBeGreaterThan(0);
      expect(builder.scheduler).toBeDefined();
      // Disabled launchpads are swept at startup.
      for (let i = 0; i < 100 && stub.find('GET', '/rest/v1/launchpads').length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const sweep = stub.find('GET', '/rest/v1/launchpads');
      expect(sweep.length).toBeGreaterThan(0);
      expect(sweep[0]!.query.get('status')).toBe('eq.disabled');
    } finally {
      await builder.stop();
    }
    expect(builder.gateway.server.listening).toBe(false);
  });

  it('refuses to start when the sandbox step timeouts do not fit in one job', async () => {
    jobsRoot = await mkdtemp(path.join(tmpdir(), 'forge-builder-start-'));
    // The step timeouts are read once, when the sandbox module loads: a fresh module graph.
    vi.resetModules();
    vi.stubEnv('FORGE_SANDBOX_INSTALL_TIMEOUT_MINUTES', '30');
    vi.stubEnv('FORGE_SANDBOX_BUILD_TIMEOUT_MINUTES', '30');
    try {
      const fresh = await import('./index.js');
      const docker = fakeDocker();
      const env = baseEnv({
        FORGE_SANDBOX_IMAGE: `sha256:${'a'.repeat(64)}`,
        FORGE_SANDBOX_PROXY_IMAGE: `sha256:${'b'.repeat(64)}`,
        FORGE_SANDBOX_JOBS_ROOT: jobsRoot,
        FORGE_SANDBOX_GATEWAY_UPSTREAM: 'host.docker.internal:8787',
      });
      await expect(
        fresh.startBuilder({
          env,
          logger: silentLogger(),
          handleSignals: false,
          spawn: docker.spawn,
          gatewayPort: 0,
        }),
      ).rejects.toThrow(
        /2 x \(install 30 \+ build 30\) \+ agent 30 = 150 minutes, above the 90-minute limit/,
      );
      // Refused before anything runs.
      expect(docker.calls).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('refuses to start when the signer runs on another cluster, before anything runs', async () => {
    jobsRoot = await mkdtemp(path.join(tmpdir(), 'forge-builder-start-'));
    const stub = stubFetch([
      {
        method: 'GET',
        path: '/v1/health',
        handler: () => json({ ok: true, cluster: 'mainnet-beta' }),
      },
    ]);
    vi.stubGlobal('fetch', stub.fetch);
    const docker = fakeDocker();
    await expect(
      startBuilder({
        env: sandboxEnv(jobsRoot),
        logger: silentLogger(),
        handleSignals: false,
        spawn: docker.spawn,
        gatewayPort: 0,
      }),
    ).rejects.toThrow('the signer runs on mainnet-beta while the builder runs on devnet');
    // No retry for a mismatch, and nothing else ran: no sandbox cleanup, no database call.
    expect(stub.calls.map((c) => c.path)).toEqual(['/v1/health']);
    expect(docker.calls).toEqual([]);
  });

  it('retries an unreachable signer at startup, then refuses to start', async () => {
    jobsRoot = await mkdtemp(path.join(tmpdir(), 'forge-builder-start-'));
    const stub = stubFetch([
      { method: 'GET', path: '/v1/health', handler: () => json({ error: 'down' }, 503) },
    ]);
    vi.stubGlobal('fetch', stub.fetch);
    const docker = fakeDocker();
    const sleeps: number[] = [];
    await expect(
      startBuilder({
        env: sandboxEnv(jobsRoot),
        logger: silentLogger(),
        handleSignals: false,
        spawn: docker.spawn,
        gatewayPort: 0,
        signerCheck: { attempts: 3, sleep: async (ms) => void sleeps.push(ms) },
      }),
    ).rejects.toThrow('signer unreachable at startup after 3 attempts (signer error 503)');
    // One request per attempt (the startup client does not retry on its own).
    expect(stub.find('GET', '/v1/health')).toHaveLength(3);
    expect(sleeps).toEqual([2_000, 4_000]);
    expect(docker.calls).toEqual([]);
  });

  it('refuses to start on mainnet-beta without Telegram alerting, before anything runs', async () => {
    const docker = fakeDocker();
    await expect(
      startBuilder({
        env: baseEnv({ SOLANA_CLUSTER: 'mainnet-beta' }),
        logger: silentLogger(),
        handleSignals: false,
        spawn: docker.spawn,
      }),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID required on mainnet-beta/);
    expect(docker.calls).toEqual([]);
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
