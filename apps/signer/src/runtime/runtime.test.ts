import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLUSTER_GENESIS_HASH } from '@forge/core';
import { openKeystore } from '../keystore.js';
import { JobError } from '../jobs/shared.js';
import { signRequest } from '../server.js';
import { RuntimeConfigError, parseRuntimeEnv } from './env.js';
import { buybackJobModule, type BuybackDepsLike, type BuybackLibrary } from './buyback.js';
import { INSTANCE_LOCK_FILE } from './instance.js';
import type { SignerJobContext, SignerJobModule } from './modules.js';
import { runRevokeLaunch } from './operator.js';
import { createSignerRuntime, type SignerRuntime } from './runtime.js';
import { JobScheduler, statusOf } from './scheduler.js';

vi.setConfig({ testTimeout: 60_000 });

const PASSPHRASE = 'correct horse battery staple correct horse battery staple';
const HMAC = 'runtime-test-hmac-secret-0123456789-abcdef';
const SERVICE_KEY = 'service-role-key-for-tests-only-000000';
const FAST = { N: 1 << 14, r: 8, p: 1 };

let dir: string;
let cashbox: string;
let revenue: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-runtime-'));
  const keystore = await openKeystore({
    dir: path.join(dir, 'keystore'),
    passphrase: PASSPHRASE,
    scrypt: FAST,
  });
  await keystore.createKey('payer');
  cashbox = (await keystore.createKey('cashbox')).publicKey.toBase58();
  revenue = (await keystore.createKey('revenue')).publicKey.toBase58();
  await keystore.close();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const address = () => Keypair.generate().publicKey.toBase58();

function baseEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    SOLANA_CLUSTER: 'devnet',
    RPC_URL: 'https://devnet.rpc.test',
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    SIGNER_KEYSTORE_PASSPHRASE: PASSPHRASE,
    SIGNER_KEYSTORE_DIR: path.join(dir, 'keystore'),
    SIGNER_JOURNAL_DIR: path.join(dir, 'journal'),
    SIGNER_HMAC_SECRET: HMAC,
    SIGNER_HOST: '127.0.0.1',
    SIGNER_COIN_METADATA_URL: 'https://meta.forge.test/coins/{slug}.json',
    FORGE_MULTISIG_VAULT: address(),
    FORGE_CASHBOX_WALLET: cashbox,
    // The platform fee wallet is the revenue wallet (D34).
    FORGE_PLATFORM_FEE_WALLET: revenue,
    FORGE_REVENUE_WALLET: revenue,
    FORGE_METEORA_REFERRAL_ACCOUNT: address(),
    FORGE_JUPITER_REFERRAL_ACCOUNT: address(),
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

/** A mainnet-beta environment: mainnet RPC host and the alerting it requires. */
function mainnetOverrides(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    SOLANA_CLUSTER: 'mainnet-beta',
    RPC_URL: 'https://mainnet.rpc.test',
    TELEGRAM_BOT_TOKEN: 'bot-token-test',
    TELEGRAM_CHAT_ID: '-100123',
    ...overrides,
  };
}

/** Offline Connection: the reads the startup checks and the jobs make, with empty answers. */
function mockConnection(genesis: string = CLUSTER_GENESIS_HASH.devnet): Connection {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    getGenesisHash: async () => genesis,
    getMultipleAccountsInfo: async (keys) => (keys as unknown[]).map(() => null),
    getMultipleAccountsInfoAndContext: async (keys) => ({
      context: { slot: 1 },
      value: (keys as unknown[]).map(() => null),
    }),
    getAccountInfo: async () => null,
    getAccountInfoAndContext: async () => ({ context: { slot: 1 }, value: null }),
    getMinimumBalanceForRentExemption: async () => 890_880,
    getBalance: async () => 0,
    getSlot: async () => 1,
    getBlockHeight: async () => 1,
    getLatestBlockhash: async () => ({ blockhash: address(), lastValidBlockHeight: 200 }),
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
    getSignaturesForAddress: async () => [],
    getTransaction: async () => null,
    getTokenAccountsByOwner: async () => ({ context: { slot: 1 }, value: [] }),
    getParsedTokenAccountsByOwner: async () => ({ context: { slot: 1 }, value: [] }),
  };
  return new Proxy({} as Connection, {
    get(_target, name: string) {
      const handler = handlers[name];
      if (handler) return handler;
      return () => {
        throw new Error(`unexpected RPC call ${name}`);
      };
    },
  });
}

/** Offline fetch: PostgREST answers (all kill switches off, no rows), nothing else. */
const flagsRows = [
  'deploys_paused',
  'buyback_paused',
  'signups_paused',
  'claims_paused',
  'cashbox_sweep_paused',
  'refunds_paused',
  'jupiter_claims_paused',
  'convert_paused',
  'revenue_paused',
].map((key) => ({ key, value: false }));

function mockFetch(calls: string[] = [], flags = flagsRows): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    calls.push(url.hostname + url.pathname);
    if (url.hostname !== 'supabase.test') {
      return new Response('{}', { status: 503 });
    }
    const body = url.pathname.endsWith('/flags') ? flags : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const runtimes: SignerRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});

async function create(
  overrides: Record<string, string | undefined> = {},
  options: { extraJobs?: SignerJobModule[]; connection?: Connection; fetch?: typeof fetch } = {},
): Promise<SignerRuntime> {
  const runtime = await createSignerRuntime({
    env: baseEnv(overrides),
    connection: options.connection ?? mockConnection(),
    fetch: options.fetch ?? mockFetch(),
    logger: pino({ level: 'silent' }),
    serverLogger: pino({ level: 'silent' }),
    port: 0,
    ...(options.extraJobs ? { extraJobs: options.extraJobs } : {}),
  });
  runtimes.push(runtime);
  return runtime;
}

function spyModule(seen: SignerJobContext[]): SignerJobModule {
  return {
    name: 'spy',
    create(ctx) {
      seen.push(ctx);
      return { runOnce: async () => ({ status: 'ran' }), delayMs: () => 60_000 };
    },
  };
}

describe('runtime environment', () => {
  it('names every missing or malformed variable, never a value', () => {
    let error: unknown;
    try {
      parseRuntimeEnv({
        RPC_URL: 'http://rpc.example.com/?api-key=SECRETVALUE',
        SIGNER_KEYSTORE_PASSPHRASE: 'short',
        SIGNER_ROUTES_PAUSED: 'maybe',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RuntimeConfigError);
    const text = (error as RuntimeConfigError).problems.join('\n');
    for (const name of [
      'RPC_URL',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SIGNER_KEYSTORE_PASSPHRASE',
      'SIGNER_COIN_METADATA_URL',
      'SIGNER_ROUTES_PAUSED',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain('SECRETVALUE');
    expect(text).not.toContain('short');
  });

  it('defaults to devnet and never converts the buyback wallet', () => {
    const env = baseEnv({ SOLANA_CLUSTER: '' });
    expect(parseRuntimeEnv(env)).toMatchObject({
      cluster: 'devnet',
      convertRoles: ['cashbox'],
      routesPaused: false,
      priorityFeeMicroLamports: 0,
    });
    expect(() => parseRuntimeEnv({ ...env, SIGNER_CONVERT_ROLES: 'cashbox,buyback' })).toThrow(
      /never the buyback wallet/,
    );
    expect(() => parseRuntimeEnv({ ...env, SOLANA_CLUSTER: 'testnet' })).toThrow(/SOLANA_CLUSTER/);
  });

  it('refuses mainnet-beta or production without Telegram alerting, naming no value', () => {
    const telegram = { TELEGRAM_BOT_TOKEN: 'bot-token-SECRETVALUE', TELEGRAM_CHAT_ID: '-100123' };
    // development / test on devnet: alerts may stay in the log.
    expect(() => parseRuntimeEnv(baseEnv())).not.toThrow();
    expect(() => parseRuntimeEnv(baseEnv({ NODE_ENV: 'development' }))).not.toThrow();
    for (const overrides of [
      { NODE_ENV: 'production' },
      { NODE_ENV: undefined }, // unset = production (fail closed)
      { NODE_ENV: 'staging' },
      { SOLANA_CLUSTER: 'mainnet-beta', NODE_ENV: 'test' },
    ]) {
      let error: unknown;
      try {
        parseRuntimeEnv(baseEnv(overrides));
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(overrides)).toBeInstanceOf(RuntimeConfigError);
      const text = (error as RuntimeConfigError).problems.join('\n');
      expect(text).toContain('TELEGRAM_BOT_TOKEN');
      expect(text).toContain('TELEGRAM_CHAT_ID');
      // One of the two set: only the other is reported, never the value.
      expect(() =>
        parseRuntimeEnv(baseEnv({ ...overrides, TELEGRAM_BOT_TOKEN: telegram.TELEGRAM_BOT_TOKEN })),
      ).toThrow(/TELEGRAM_CHAT_ID/);
      try {
        parseRuntimeEnv(baseEnv({ ...overrides, TELEGRAM_BOT_TOKEN: telegram.TELEGRAM_BOT_TOKEN }));
      } catch (e) {
        expect((e as Error).message).not.toContain('SECRETVALUE');
        expect((e as Error).message).not.toMatch(/TELEGRAM_BOT_TOKEN is required/);
      }
      expect(() => parseRuntimeEnv(baseEnv({ ...overrides, ...telegram }))).not.toThrow();
      // Blank values are unset.
      expect(() =>
        parseRuntimeEnv(baseEnv({ ...overrides, TELEGRAM_BOT_TOKEN: ' ', TELEGRAM_CHAT_ID: '' })),
      ).toThrow(/TELEGRAM_BOT_TOKEN/);
    }
  });

  it('fails to start in production without Telegram, before opening the keystore', async () => {
    await expect(create({ NODE_ENV: 'production' })).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
    await expect(create({ SOLANA_CLUSTER: 'mainnet-beta' })).rejects.toThrow(/TELEGRAM_CHAT_ID/);
  });

  it('reads the payment floors with safe defaults, as integers only', () => {
    const env = baseEnv();
    // $33 and $5.5 at the web's highest quotable SOL price ($5 000), with a 10% margin.
    expect(parseRuntimeEnv(env).minPaymentLamports).toEqual({
      creation: 5_940_000n,
      modification: 990_000n,
    });
    expect(
      parseRuntimeEnv({
        ...env,
        SIGNER_MIN_CREATION_PAYMENT_LAMPORTS: '150000000',
        SIGNER_MIN_MODIFICATION_PAYMENT_LAMPORTS: '0',
      }).minPaymentLamports,
    ).toEqual({ creation: 150_000_000n, modification: 0n });
    for (const value of ['0.5', '-1', 'many', '1e9']) {
      expect(() =>
        parseRuntimeEnv({ ...env, SIGNER_MIN_CREATION_PAYMENT_LAMPORTS: value }),
      ).toThrow(/SIGNER_MIN_CREATION_PAYMENT_LAMPORTS/);
    }
  });

  it('caps the new launchpads per day: 20 by default, bounded, never unlimited', () => {
    const env = baseEnv();
    expect(parseRuntimeEnv(env).maxLaunchpadsPerDay).toBe(20);
    expect(
      parseRuntimeEnv({ ...env, SIGNER_MAX_LAUNCHPADS_PER_DAY: '5' }).maxLaunchpadsPerDay,
    ).toBe(5);
    for (const value of ['0', '1001', '-1', 'many']) {
      expect(() => parseRuntimeEnv({ ...env, SIGNER_MAX_LAUNCHPADS_PER_DAY: value })).toThrow(
        /SIGNER_MAX_LAUNCHPADS_PER_DAY/,
      );
    }
  });
});

describe('signer runtime wiring', () => {
  it('registers every job over one shared context', async () => {
    const seen: SignerJobContext[] = [];
    const runtime = await create({}, { extraJobs: [spyModule(seen)] });
    expect(runtime.scheduler.names()).toEqual([
      'claims',
      'jupiter-claims',
      'cashbox',
      'refunds',
      'watch',
      'convert',
      'revenue',
      'spy',
    ]);
    const ctx = seen[0]!;
    expect(ctx).toBe(runtime.context);
    expect(ctx.walletLock).not.toBe(ctx.payerLock);
    expect(ctx.payerReservations.size).toBe(0);
    // One expected-signature set: what a job announces, the watcher knows.
    ctx.onBeforeSend('5'.repeat(88));
    expect(ctx.expected.has('5'.repeat(88))).toBe(true);
    expect(ctx.cashbox.publicKey.toBase58()).toBe(cashbox);
  });

  it('makes the cashbox and refunds jobs wait for the shared wallet lock', async () => {
    const runtime = await create();
    let release!: () => void;
    const held = runtime.context.walletLock.runExclusive(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const settled: string[] = [];
    const cashboxRun = runtime.scheduler.runNow('cashbox').then(() => settled.push('cashbox'));
    const refundsRun = runtime.scheduler.runNow('refunds').then(() => settled.push('refunds'));
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toEqual([]);
    release();
    await held;
    await Promise.all([cashboxRun, refundsRun]);
    expect(settled.sort()).toEqual(['cashbox', 'refunds']);
  });

  it('serves the health route behind HMAC with job states and no secret', async () => {
    const runtime = await create();
    expect(runtime.health().ok).toBe(false);
    const { port } = await runtime.start();
    const headers = signRequest(HMAC, { method: 'GET', path: '/v1/health' });
    const reply = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, method: 'GET', path: '/v1/health', headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.text) as {
      ok: boolean;
      cluster: string;
      jobs: Record<string, { state: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.cluster).toBe('devnet');
    expect(Object.keys(body.jobs)).toEqual([
      'claims',
      'jupiter-claims',
      'cashbox',
      'refunds',
      'watch',
      'convert',
      'revenue',
    ]);
    for (const secret of [PASSPHRASE, HMAC, SERVICE_KEY]) expect(reply.text).not.toContain(secret);

    // Unsigned: refused.
    const unsigned = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/v1/health' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(unsigned).toBe(401);

    await runtime.stop();
    expect(runtime.health().ok).toBe(false);
    expect(Object.values(runtime.health().jobs!).every((j) => j.state === 'stopped')).toBe(true);
  });

  it('disables an optional job whose configuration is refused, alerts, and runs everything else', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) });
    const broken: SignerJobModule = {
      name: 'buyback',
      create() {
        throw new JobError(
          'CONFIG',
          'live buyback refused: no Squads spending limit withdrawer is wired',
        );
      },
    };
    const seen: SignerJobContext[] = [];
    const runtime = await createSignerRuntime({
      env: baseEnv(),
      connection: mockConnection(),
      fetch: mockFetch(),
      logger,
      serverLogger: pino({ level: 'silent' }),
      port: 0,
      extraJobs: [broken, spyModule(seen)],
    });
    runtimes.push(runtime);
    expect(runtime.disabledJobs).toEqual(['buyback']);
    expect(runtime.scheduler.names()).toEqual([
      'claims',
      'jupiter-claims',
      'cashbox',
      'refunds',
      'watch',
      'convert',
      'revenue',
      'spy',
    ]);
    const alertLine = lines.find((l) => l.includes('"code":"job_module_disabled"'));
    expect(alertLine).toBeDefined();
    expect(alertLine).toContain('"level":"high"');
    expect(alertLine).toContain('buyback');
    await runtime.start();
    expect(runtime.health().ok).toBe(true);
    expect(Object.keys(runtime.health().jobs!)).not.toContain('buyback');
  });

  it('still fails closed when a built-in job is misconfigured', async () => {
    await expect(create({ SIGNER_REFUNDS_MAX_LAMPORTS: '0.5' })).rejects.toThrow(
      /SIGNER_REFUNDS_MAX_LAMPORTS/,
    );
  });

  it('reports the conversion as paused while its kill switch is on or its row is missing', async () => {
    const running = await create();
    expect(await running.scheduler.runNow('convert')).toEqual({ status: 'ran' });
    await running.stop();
    const on = flagsRows.map((row) =>
      row.key === 'convert_paused' ? { ...row, value: true } : row,
    );
    const paused = await create({}, { fetch: mockFetch([], on) });
    expect(await paused.scheduler.runNow('convert')).toEqual({ status: 'paused' });
    expect(paused.scheduler.states().convert).toMatchObject({ lastStatus: 'paused', runs: 1 });
    await paused.stop();
    const missing = flagsRows.filter((row) => row.key !== 'convert_paused');
    const unseeded = await create({}, { fetch: mockFetch([], missing) });
    expect(await unseeded.scheduler.runNow('convert')).toEqual({ status: 'paused' });
  });

  it('refuses a live conversion on mainnet-beta without the Jupiter API key', async () => {
    const onMainnet = { connection: mockConnection(CLUSTER_GENESIS_HASH['mainnet-beta']) };
    await expect(
      create(mainnetOverrides({ FORGE_CONVERT_LIVE: 'true' }), onMainnet),
    ).rejects.toThrow(/JUPITER_API_KEY is required/);
    // With the key it starts; without the live flag (dry run) no key is needed.
    const live = await create(
      mainnetOverrides({ FORGE_CONVERT_LIVE: 'true', JUPITER_API_KEY: 'jupiter-key-test' }),
      onMainnet,
    );
    expect(live.scheduler.names()).toContain('convert');
    await live.stop();
    const dryRun = await create(mainnetOverrides(), onMainnet);
    expect(dryRun.scheduler.names()).toContain('convert');
  });

  it('removes the keystore passphrase and the service role key from the process environment once parsed', async () => {
    const env = baseEnv({ JUPITER_API_KEY: 'jupiter-key-test' });
    const previous = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      const runtime = await createSignerRuntime({
        env: process.env,
        connection: mockConnection(),
        fetch: mockFetch(),
        logger: pino({ level: 'silent' }),
        serverLogger: pino({ level: 'silent' }),
        port: 0,
      });
      runtimes.push(runtime);
      expect(process.env.SIGNER_KEYSTORE_PASSPHRASE).toBeUndefined();
      expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
      expect(runtime.context.env.SIGNER_KEYSTORE_PASSPHRASE).toBeUndefined();
      expect(runtime.context.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
      // The secrets consumed by the server, the alerter and the Jupiter clients are gone too.
      for (const name of ['SIGNER_HMAC_SECRET', 'TELEGRAM_BOT_TOKEN', 'JUPITER_API_KEY']) {
        expect(process.env[name]).toBeUndefined();
        expect(runtime.context.env[name]).toBeUndefined();
      }
      // Behaviour kept: the keystore is open and the database client holds the key.
      expect(runtime.context.supabase.serviceRoleKey).toBe(SERVICE_KEY);
      expect(runtime.context.cashbox.publicKey.toBase58()).toBe(cashbox);
      expect(process.env.RPC_URL).toBe(env.RPC_URL);
      // The server still authenticates with the secret it holds.
      const { port } = await runtime.start();
      const headers = signRequest(HMAC, { method: 'GET', path: '/v1/health' });
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, method: 'GET', path: '/v1/health', headers },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(200);
    } finally {
      for (const [k, v] of previous) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('fails closed at startup', async () => {
    await expect(create({ FORGE_CASHBOX_WALLET: address() })).rejects.toThrow(
      /cashbox key does not match/,
    );
    await expect(
      create({}, { connection: mockConnection(CLUSTER_GENESIS_HASH['mainnet-beta']) }),
    ).rejects.toThrow(/does not serve SOLANA_CLUSTER/);
    await expect(create({ FORGE_MULTISIG_VAULT: undefined })).rejects.toThrow(
      /FORGE_MULTISIG_VAULT/,
    );
    await expect(create({ SIGNER_KEYSTORE_PASSPHRASE: `${PASSPHRASE}x` })).rejects.toThrow();
    await expect(create({ SIGNER_HMAC_SECRET: 'too-short' })).rejects.toThrow(/SIGNER_HMAC_SECRET/);
    await expect(create({ WATCH_INTERVAL_MS: 'fast' })).rejects.toThrow();
  });
});

describe('single instance', () => {
  const lockFile = () => path.join(dir, 'journal', INSTANCE_LOCK_FILE);

  it('refuses a second signer over the same journal directory until the first one stops', async () => {
    const first = await create();
    await expect(create()).rejects.toThrow(/another signer instance/);
    expect(await fs.readFile(lockFile(), 'utf8')).toMatch(new RegExp(`^${process.pid}\\n`));
    await first.stop();
    await expect(fs.access(lockFile())).rejects.toThrow();
    const second = await create();
    expect(second.config.cluster).toBe('devnet');
  });

  it('takes over a lock left by a process that is gone', async () => {
    const gone = spawnSync(process.execPath, ['-e', '0']).pid;
    expect(gone).toBeGreaterThan(0);
    await fs.mkdir(path.dirname(lockFile()), { recursive: true });
    await fs.writeFile(lockFile(), `${gone}\nsigner\n`);
    await create();
    expect(await fs.readFile(lockFile(), 'utf8')).toMatch(new RegExp(`^${process.pid}\\n`));
  });

  it('the operator command refuses to run next to the service and runs once it stopped', async () => {
    const runtime = await create();
    const run = () =>
      runRevokeLaunch({
        env: baseEnv(),
        jobId: '0f8fad5b-d9cb-469f-a165-70867728950e',
        connection: mockConnection(),
        fetch: mockFetch(),
        logger: pino({ level: 'silent' }),
      });
    await expect(run()).rejects.toThrow(/another signer instance/);
    await runtime.stop();
    await expect(run()).rejects.toThrow(/launch_not_prepared/);
    // Released by the command too.
    await expect(fs.access(lockFile())).rejects.toThrow();
  });
});

describe('operator command --revoke-launch', () => {
  const jobId = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('runs with the service environment and refuses a job without a prepared launch', async () => {
    await expect(
      runRevokeLaunch({
        env: baseEnv(),
        jobId,
        connection: mockConnection(),
        fetch: mockFetch(),
        logger: pino({ level: 'silent' }),
      }),
    ).rejects.toThrow(/launch_not_prepared/);
  });

  it('fails closed on the wrong cluster or a bad environment', async () => {
    await expect(
      runRevokeLaunch({
        env: baseEnv(),
        jobId,
        connection: mockConnection(CLUSTER_GENESIS_HASH['mainnet-beta']),
        fetch: mockFetch(),
        logger: pino({ level: 'silent' }),
      }),
    ).rejects.toThrow(/does not serve SOLANA_CLUSTER/);
    await expect(
      runRevokeLaunch({
        env: baseEnv({ NODE_ENV: 'production' }),
        jobId,
        connection: mockConnection(),
        logger: pino({ level: 'silent' }),
      }),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

describe('buyback module', () => {
  it('wires the buyback job with the shared lock, the watcher hook and its own tick', async () => {
    type Cfg = {
      maxPriorityFeeLamports: bigint;
      route: 'jupiter';
      devnetPool: null;
      revenueSince: string | null;
    };
    const captured: Array<BuybackDepsLike<Cfg>> = [];
    const budgets: Array<{ journalDir: string; since: string | null; vault: string }> = [];
    const lib: BuybackLibrary<Cfg> = {
      buybackConfigFromEnv: (_env, addresses, options) => {
        expect(addresses.forgeMint).toBeNull();
        // The runtime's resolved cluster (devnet by default), not the raw SOLANA_CLUSTER.
        expect(options).toEqual({ cluster: 'devnet' });
        return {
          config: {
            maxPriorityFeeLamports: 100_000n,
            route: 'jupiter',
            devnetPool: null,
            revenueSince: '2026-11-01T00:00:00Z',
          },
          tickMs: 45_000,
          jupiter: { baseUrl: 'https://jup.test', minRequestIntervalMs: 1_100, timeoutMs: 15_000 },
        };
      },
      createBuybackJournal: (journalDir) => ({ journalDir }),
      createJupiterBuybackClient: (opts) => ({ quotes: opts.baseUrl }),
      createRpcBuybackSwapPreparer: () => ({ preparer: true }),
      createRpcForgeTokenReader: () => ({ tokens: true }),
      createFileBuybackBudgetSource: (opts) => {
        expect(opts.rpc).toBeDefined();
        budgets.push({ journalDir: opts.journalDir, since: opts.since, vault: opts.vault.toBase58() });
        return { budget: true };
      },
      createBuybackJob: (deps) => {
        captured.push(deps);
        return { mode: 'simulation', runOnce: async () => ({ status: 'paused' }) };
      },
      squadsConfigFromEnv: () => null,
      createSquadsJournal: (journalDir) => ({ journalDir }),
      createSquadsSpendingLimitWithdrawer: () => ({ withdrawer: true }),
      createDbcDevnetBuybackRoute: () => ({ quotes: null, swapPreparer: null }),
    };
    const runtime = await create({}, { extraJobs: [buybackJobModule(lib)] });
    expect(runtime.scheduler.names()).toContain('buyback');
    const deps = captured[0]!;
    expect(deps.walletLock).toBe(runtime.context.walletLock);
    expect(deps.onBeforeSend).toBe(runtime.context.onBeforeSend);
    expect(deps.flags).toBe(runtime.context.flags);
    expect(deps.keystore).toBe(runtime.context.keystore);
    expect(deps.tickMs).toBe(45_000);
    // The revenue budget source: the journal directory, the configured instant, the vault.
    expect(deps.budget).toEqual({ budget: true });
    expect(budgets).toEqual([
      {
        journalDir: runtime.context.journalDir,
        since: '2026-11-01T00:00:00Z',
        vault: runtime.context.addresses.vault.toBase58(),
      },
    ]);
    expect(await runtime.scheduler.runNow('buyback')).toEqual({ status: 'paused' });
    expect(runtime.scheduler.states().buyback).toMatchObject({ lastStatus: 'paused', runs: 1 });
  });

  it('is required on mainnet-beta once FORGE_BUYBACK_LIVE asks for live mode', () => {
    const required = (cluster: 'devnet' | 'mainnet-beta', live: string | undefined) =>
      buybackJobModule().required!({
        cluster,
        env: live === undefined ? {} : { FORGE_BUYBACK_LIVE: live },
      } as SignerJobContext);
    expect(required('mainnet-beta', 'true')).toBe(true);
    // A malformed value is a live request too (fail closed).
    expect(required('mainnet-beta', 'TRUE')).toBe(true);
    expect(required('mainnet-beta', 'false')).toBe(false);
    expect(required('mainnet-beta', undefined)).toBe(false);
    expect(required('devnet', 'true')).toBe(false);
  });

  it('stops the signer at startup when a live buyback on mainnet-beta is refused', async () => {
    const onMainnet = { connection: mockConnection(CLUSTER_GENESIS_HASH['mainnet-beta']) };
    const live = mainnetOverrides({ FORGE_BUYBACK_LIVE: 'true', FORGE_MINT: address() });
    // No Jupiter API key, then no revenue instant (D35), then no Squads spending limit (no
    // withdrawer): all refused.
    await expect(create(live, { ...onMainnet, extraJobs: [buybackJobModule()] })).rejects.toThrow(
      /JUPITER_API_KEY is required/,
    );
    await expect(
      create(
        { ...live, JUPITER_API_KEY: 'jupiter-key-test' },
        { ...onMainnet, extraJobs: [buybackJobModule()] },
      ),
    ).rejects.toThrow(/BUYBACK_REVENUE_SINCE is required when FORGE_BUYBACK_LIVE=true/);
    await expect(
      create(
        {
          ...live,
          JUPITER_API_KEY: 'jupiter-key-test',
          BUYBACK_REVENUE_SINCE: '2026-11-01T00:00:00Z',
        },
        { ...onMainnet, extraJobs: [buybackJobModule()] },
      ),
    ).rejects.toThrow(/live buyback refused: no Squads spending limit withdrawer/);
    // A malformed live flag stops it too.
    await expect(
      create(mainnetOverrides({ FORGE_BUYBACK_LIVE: 'yes' }), {
        ...onMainnet,
        extraJobs: [buybackJobModule()],
      }),
    ).rejects.toThrow(/FORGE_BUYBACK_LIVE/);
    // The failed startups released the instance lock.
    const simulation = await create(mainnetOverrides({ FORGE_BUYBACK_LIVE: 'false' }), {
      ...onMainnet,
      extraJobs: [buybackJobModule()],
    });
    expect(simulation.scheduler.names()).toContain('buyback');
  });

  it('only disables a refused buyback on mainnet-beta without the live flag, and on devnet', async () => {
    const onMainnet = { connection: mockConnection(CLUSTER_GENESIS_HASH['mainnet-beta']) };
    // Simulation on mainnet-beta: the devnet route is refused, the module disabled, alerted.
    const mainnet = await create(mainnetOverrides({ BUYBACK_ROUTE: 'dbc-devnet' }), {
      ...onMainnet,
      extraJobs: [buybackJobModule()],
    });
    expect(mainnet.disabledJobs).toEqual(['buyback']);
    await mainnet.stop();
    // Devnet behaviour unchanged: a refused live devnet test disables the module only.
    const devnet = await create(
      {
        FORGE_BUYBACK_LIVE: 'true',
        FORGE_BUYBACK_DEVNET_TEST: 'true',
        BUYBACK_ROUTE: 'dbc-devnet',
      },
      { extraJobs: [buybackJobModule()] },
    );
    expect(devnet.disabledJobs).toEqual(['buyback']);
    expect(devnet.scheduler.names()).not.toContain('buyback');
  });
});

describe('job scheduler', () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };

  it('runs each job on start, records statuses and failures, and stops cleanly', async () => {
    const sleeps: number[] = [];
    const scheduler = new JobScheduler({
      logger: quiet,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    const init = vi.fn(async () => undefined);
    scheduler.register('good', {
      init,
      runOnce: async () => ({ status: 'ran' }),
      delayMs: () => 5,
    });
    scheduler.register('bad', {
      runOnce: async () => {
        throw new Error('boom');
      },
      delayMs: () => 120_000,
    });
    scheduler.register('late', {
      runOnce: async () => ({ status: 'ran' }),
      delayMs: () => 30_000,
      runOnStart: false,
    });
    expect(() =>
      scheduler.register('good', { runOnce: async () => 1, delayMs: () => 1 }),
    ).toThrow();
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    const states = scheduler.states();
    expect(init).toHaveBeenCalledTimes(1);
    expect(states.good).toMatchObject({ runs: 1, lastStatus: 'ran', consecutiveFailures: 0 });
    expect(states.bad).toMatchObject({ runs: 1, lastStatus: 'error', consecutiveFailures: 1 });
    expect(states.late).toMatchObject({ runs: 0, lastStatus: null });
    // Delays are floored at 1 s (no hot loop) and taken from each job.
    expect(sleeps.sort((a, b) => a - b)).toEqual([1_000, 30_000, 120_000]);
    await scheduler.stop();
    expect(Object.values(scheduler.states()).every((s) => s.state === 'stopped')).toBe(true);
  });

  it('never runs a job concurrently with itself', async () => {
    const scheduler = new JobScheduler({ logger: quiet });
    let active = 0;
    let maxActive = 0;
    scheduler.register('job', {
      runOnce: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { status: 'ran' };
      },
      delayMs: () => 60_000,
    });
    await Promise.all([scheduler.runNow('job'), scheduler.runNow('job'), scheduler.runNow('job')]);
    expect(maxActive).toBe(1);
    expect(scheduler.states().job!.runs).toBe(3);
  });

  it('reads the status code of a report', () => {
    expect(statusOf({ status: 'paused' })).toBe('paused');
    expect(statusOf({ status: 'Not a code!' })).toBe('ran');
    expect(statusOf(undefined)).toBe('ran');
  });
});

describe('production command', () => {
  it('is the start script: the entry point without a file watcher', async () => {
    const pkg = JSON.parse(
      await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe('tsx src/index.ts');
    expect(pkg.scripts.dev).toContain('watch');
    const example = await fs.readFile(new URL('../../.env.example', import.meta.url), 'utf8');
    expect(example).toContain('pnpm --filter @forge/signer start');
  });
});

describe('runtime environment file', () => {
  it('starts with every variable of .env.example present, blanks meaning unset', async () => {
    const example = await fs.readFile(new URL('../../.env.example', import.meta.url), 'utf8');
    const fromExample: Record<string, string> = {};
    for (const line of example.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match) fromExample[match[1]!] = match[2]!;
    }
    expect(Object.keys(fromExample).length).toBeGreaterThan(60);
    // Example values, with the required ones filled in (as an operator would).
    const filled = Object.fromEntries(
      Object.entries(fromExample).map(([k, v]) => [k, baseEnv()[k] ?? v]),
    );
    const runtime = await create({ ...filled, NODE_ENV: 'test' });
    expect(runtime.scheduler.names()).toHaveLength(7);
    expect(runtime.config.convertRoles).toEqual(['cashbox']);
  });
});

describe('revenue wallet wiring', () => {
  /** A classic SPL token account (wrapped SOL) held by `owner`, as `getAccountInfo` returns it. */
  function wsolAccountOwnedBy(owner: string) {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint: NATIVE_MINT,
        owner: new PublicKey(owner),
        amount: 0n,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 1,
        isNative: 2_039_280n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 2_039_280 };
  }

  /** The offline connection, with the Meteora referral account held by `holder`. */
  function connectionWithReferral(genesis: string, holder: string): Connection {
    const base = mockConnection(genesis);
    return new Proxy(base, {
      get(target, name: string) {
        if (name === 'getAccountInfo') return async () => wsolAccountOwnedBy(holder);
        return (target as unknown as Record<string, unknown>)[name];
      },
    });
  }

  it('refuses to start on mainnet-beta when the addresses disagree with the revenue key', async () => {
    const onMainnet = { connection: mockConnection(CLUSTER_GENESIS_HASH['mainnet-beta']) };
    const other = address();
    await expect(
      create(
        mainnetOverrides({ FORGE_REVENUE_WALLET: other, FORGE_PLATFORM_FEE_WALLET: other }),
        onMainnet,
      ),
    ).rejects.toThrow(/revenue wallet wiring refused.*keystore revenue key/);
    await expect(
      create(mainnetOverrides({ FORGE_PLATFORM_FEE_WALLET: address() }), onMainnet),
    ).rejects.toThrow(/FORGE_PLATFORM_FEE_WALLET is not FORGE_REVENUE_WALLET/);
    await expect(
      create(mainnetOverrides(), {
        connection: connectionWithReferral(CLUSTER_GENESIS_HASH['mainnet-beta'], address()),
      }),
    ).rejects.toThrow(/FORGE_METEORA_REFERRAL_ACCOUNT is not held by FORGE_REVENUE_WALLET/);
    // Wired: it starts, the revenue job is scheduled.
    const ok = await create(mainnetOverrides(), {
      connection: connectionWithReferral(CLUSTER_GENESIS_HASH['mainnet-beta'], revenue),
    });
    expect(ok.scheduler.names()).toContain('revenue');
    expect(ok.context.revenue?.publicKey.toBase58()).toBe(revenue);
    await ok.stop();
  });

  it('on devnet alerts and runs the revenue job off until the wiring is fixed', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) });
    const other = address();
    const runtime = await createSignerRuntime({
      env: baseEnv({ FORGE_REVENUE_WALLET: other, FORGE_PLATFORM_FEE_WALLET: other }),
      connection: mockConnection(),
      fetch: mockFetch(),
      logger,
      serverLogger: pino({ level: 'silent' }),
      port: 0,
    });
    runtimes.push(runtime);
    expect(runtime.context.revenue).toBeNull();
    const alertLine = lines.find((l) => l.includes('"code":"revenue_wiring"'));
    expect(alertLine).toBeDefined();
    expect(alertLine).toContain('"level":"high"');
    expect(alertLine).toContain('keystore revenue key');
    expect(alertLine).not.toContain(other);
    expect(await runtime.scheduler.runNow('revenue')).toEqual({ status: 'off' });
  });

  it('runs the revenue job on devnet (dry run by default) and fails closed on its flag', async () => {
    const running = await create();
    expect(running.context.revenue?.publicKey.toBase58()).toBe(revenue);
    expect(await running.scheduler.runNow('revenue')).toMatchObject({
      status: 'ran',
      outcome: { result: 'dry_run' },
    });
    await running.stop();
    const on = flagsRows.map((row) =>
      row.key === 'revenue_paused' ? { ...row, value: true } : row,
    );
    const paused = await create({}, { fetch: mockFetch([], on) });
    expect(await paused.scheduler.runNow('revenue')).toMatchObject({
      status: 'paused',
      reason: 'flag',
    });
    await paused.stop();
    const missing = flagsRows.filter((row) => row.key !== 'revenue_paused');
    const unseeded = await create({}, { fetch: mockFetch([], missing) });
    expect(await unseeded.scheduler.runNow('revenue')).toMatchObject({
      status: 'paused',
      reason: 'flag_missing',
    });
    await unseeded.stop();
    await expect(create({ SIGNER_REVENUE_RESERVE_LAMPORTS: '0.5' })).rejects.toThrow(
      /SIGNER_REVENUE_RESERVE_LAMPORTS/,
    );
  });
});
