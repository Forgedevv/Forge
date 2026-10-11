import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Keypair, type Connection } from '@solana/web3.js';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLUSTER_GENESIS_HASH } from '@forge/core';
import { openKeystore } from '../keystore.js';
import { signRequest } from '../server.js';
import { RuntimeConfigError, parseRuntimeEnv } from './env.js';
import { buybackJobModule, type BuybackDepsLike, type BuybackLibrary } from './buyback.js';
import type { SignerJobContext, SignerJobModule } from './modules.js';
import { createSignerRuntime, type SignerRuntime } from './runtime.js';
import { JobScheduler, statusOf } from './scheduler.js';

vi.setConfig({ testTimeout: 60_000 });

const PASSPHRASE = 'correct horse battery staple correct horse battery staple';
const HMAC = 'runtime-test-hmac-secret-0123456789-abcdef';
const SERVICE_KEY = 'service-role-key-for-tests-only-000000';
const FAST = { N: 1 << 14, r: 8, p: 1 };

let dir: string;
let cashbox: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-runtime-'));
  const keystore = await openKeystore({
    dir: path.join(dir, 'keystore'),
    passphrase: PASSPHRASE,
    scrypt: FAST,
  });
  await keystore.createKey('payer');
  cashbox = (await keystore.createKey('cashbox')).publicKey.toBase58();
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
    FORGE_PLATFORM_FEE_WALLET: address(),
    FORGE_METEORA_REFERRAL_ACCOUNT: address(),
    FORGE_JUPITER_REFERRAL_ACCOUNT: address(),
    LOG_LEVEL: 'silent',
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
].map((key) => ({ key, value: false }));

function mockFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    calls.push(url.hostname + url.pathname);
    if (url.hostname !== 'supabase.test') {
      return new Response('{}', { status: 503 });
    }
    const body = url.pathname.endsWith('/flags') ? flagsRows : [];
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
  options: { extraJobs?: SignerJobModule[]; connection?: Connection } = {},
): Promise<SignerRuntime> {
  const runtime = await createSignerRuntime({
    env: baseEnv(overrides),
    connection: options.connection ?? mockConnection(),
    fetch: mockFetch(),
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
      'cashbox',
      'refunds',
      'watch',
      'convert',
      'spy',
    ]);
    const ctx = seen[0]!;
    expect(ctx).toBe(runtime.context);
    expect(ctx.walletLock).not.toBe(ctx.payerLock);
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
    const headers = signRequest(HMAC, '');
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
    expect(Object.keys(body.jobs)).toEqual(['claims', 'cashbox', 'refunds', 'watch', 'convert']);
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

describe('buyback module', () => {
  it('wires the buyback job with the shared lock, the watcher hook and its own tick', async () => {
    const captured: Array<BuybackDepsLike<{ maxPriorityFeeLamports: bigint }>> = [];
    const lib: BuybackLibrary<{ maxPriorityFeeLamports: bigint }> = {
      buybackConfigFromEnv: (_env, addresses) => {
        expect(addresses.forgeMint).toBeNull();
        return {
          config: { maxPriorityFeeLamports: 100_000n },
          tickMs: 45_000,
          jupiter: { baseUrl: 'https://jup.test', minRequestIntervalMs: 1_100, timeoutMs: 15_000 },
        };
      },
      createBuybackJournal: (journalDir) => ({ journalDir }),
      createJupiterBuybackClient: (opts) => ({ quotes: opts.baseUrl }),
      createRpcBuybackSwapPreparer: () => ({ preparer: true }),
      createRpcForgeTokenReader: () => ({ tokens: true }),
      createBuybackJob: (deps) => {
        captured.push(deps);
        return { mode: 'simulation', runOnce: async () => ({ status: 'paused' }) };
      },
    };
    const runtime = await create({}, { extraJobs: [buybackJobModule(lib)] });
    expect(runtime.scheduler.names()).toContain('buyback');
    const deps = captured[0]!;
    expect(deps.walletLock).toBe(runtime.context.walletLock);
    expect(deps.onBeforeSend).toBe(runtime.context.onBeforeSend);
    expect(deps.flags).toBe(runtime.context.flags);
    expect(deps.keystore).toBe(runtime.context.keystore);
    expect(deps.tickMs).toBe(45_000);
    expect(await runtime.scheduler.runNow('buyback')).toEqual({ status: 'paused' });
    expect(runtime.scheduler.states().buyback).toMatchObject({ lastStatus: 'paused', runs: 1 });
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
    expect(runtime.scheduler.names()).toHaveLength(5);
    expect(runtime.config.convertRoles).toEqual(['cashbox']);
  });
});
