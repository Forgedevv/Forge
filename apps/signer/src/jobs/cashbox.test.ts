import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openKeystore, type Keystore } from '../keystore.js';
import {
  SWEEP_FEE_BUFFER_LAMPORTS,
  SweepJournalEntry,
  cashboxConfigFromEnv,
  createCashboxJob,
  createPostgrestCashboxStore,
  planSweep,
  sumAnomalies,
  sumLiabilities,
  type CashboxConfig,
  type CashboxDeps,
} from './cashbox.js';
import {
  RefundJournalEntry,
  RefundLedgerEntry,
  RefundManualMark,
  createRefundLedger,
  createRefundsJob,
} from './refunds.js';
import {
  Mutex,
  createMemoryJournal,
  createPostgrestClient,
  silentJobLogger,
  type RetryOptions,
} from './shared.js';
import {
  FakeChain,
  FakeClock,
  FakeDbc,
  MemoryRefundDb,
  RecordingAlerter,
  TransientRpcError,
  chainSleep,
  memoryFlags,
  randomAddress,
  uuid,
} from './testing.js';

const FAST = { N: 1 << 14, r: 8, p: 1 };
const PASSPHRASE = 'cashbox job test passphrase, long enough for the keystore';
const SOL = 1_000_000_000n;
const RESERVE = 100_000_000n;
const MIN_SWEEP = 50_000_000n;

let dir: string;
let keystore: Keystore;
let cashbox: PublicKey;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cashbox-'));
  keystore = await openKeystore({ dir, passphrase: PASSPHRASE, scrypt: FAST });
  cashbox = (await keystore.createKey('cashbox')).publicKey;
});

afterEach(async () => {
  await keystore.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function setup(config: Partial<CashboxConfig> = {}, deps: Partial<CashboxDeps> = {}) {
  const chain = new FakeChain();
  const dbc = new FakeDbc(chain);
  const core = dbc.core({ cashbox });
  const db = new MemoryRefundDb();
  const journal = createMemoryJournal(SweepJournalEntry);
  const alerter = new RecordingAlerter();
  const flags = memoryFlags();
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const sleep = chainSleep(chain, sleeps, clock);
  const retry: RetryOptions = { attempts: 4, baseDelayMs: 500, maxDelayMs: 8_000, sleep };
  const vault = randomAddress();
  chain.setBalance(vault, SOL);
  const rent = chain.rentExempt(0);
  const fullConfig: CashboxConfig = {
    cashbox,
    vault,
    reserveLamports: RESERVE,
    minSweepLamports: MIN_SWEEP,
    dryRun: false,
    ...config,
  };
  const job = (extra: Partial<CashboxDeps> = {}) =>
    createCashboxJob({
      store: db,
      rpc: chain,
      core,
      keystore,
      journal,
      flags,
      alerter,
      logger: silentJobLogger,
      config: fullConfig,
      retry,
      walletLock: new Mutex(),
      onBeforeSend: () => undefined,
      sleep,
      now: clock.now,
      ...deps,
      ...extra,
    });
  const floor = (liabilities = 0n) => rent + RESERVE + liabilities + SWEEP_FEE_BUFFER_LAMPORTS;
  return {
    chain,
    core,
    db,
    journal,
    alerter,
    flags,
    clock,
    sleeps,
    vault,
    rent,
    job,
    floor,
    retry,
    sleep,
  };
}

describe('planSweep', () => {
  const base = {
    rentExemptLamports: 890_880n,
    reserveLamports: RESERVE,
    liabilitiesLamports: 300_000_000n,
    feeBufferLamports: 10_000n,
    minSweepLamports: MIN_SWEEP,
  };
  const floor = 890_880n + RESERVE + 300_000_000n + 10_000n;

  it('never sweeps at or below the floor', () => {
    expect(planSweep({ ...base, balance: floor })).toMatchObject({
      sweep: false,
      reason: 'below_reserve',
    });
    expect(planSweep({ ...base, balance: 0n })).toMatchObject({
      sweep: false,
      reason: 'below_reserve',
    });
  });

  it('sweeps only from the threshold, exactly the excess', () => {
    expect(planSweep({ ...base, balance: floor + MIN_SWEEP - 1n })).toMatchObject({
      sweep: false,
      reason: 'below_threshold',
      excess: MIN_SWEEP - 1n,
    });
    expect(planSweep({ ...base, balance: floor + MIN_SWEEP })).toEqual({
      sweep: true,
      amount: MIN_SWEEP,
      floor,
      excess: MIN_SWEEP,
    });
  });

  it('caps a sweep', () => {
    const plan = planSweep({ ...base, balance: floor + 5n * SOL, maxSweepLamports: SOL });
    expect(plan).toMatchObject({ sweep: true, amount: SOL });
  });

  it('keeps balance - amount >= floor for any input (property)', () => {
    let seed = 42;
    const rand = (max: bigint) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return (BigInt(seed) * max) / 2_147_483_648n;
    };
    for (let i = 0; i < 2_000; i++) {
      const input = {
        balance: rand(20n * SOL),
        rentExemptLamports: rand(3_000_000n),
        reserveLamports: rand(SOL),
        liabilitiesLamports: rand(5n * SOL),
        feeBufferLamports: rand(20_000n),
        minSweepLamports: rand(SOL) + 1n,
        maxSweepLamports: i % 3 === 0 ? rand(3n * SOL) + 1n : null,
      };
      const plan = planSweep(input);
      if (plan.sweep) {
        expect(input.balance - plan.amount).toBeGreaterThanOrEqual(plan.floor);
        expect(plan.amount).toBeGreaterThanOrEqual(
          input.maxSweepLamports ? 1n : input.minSweepLamports,
        );
      }
    }
  });

  it('rejects negative inputs and a zero threshold', () => {
    expect(() => planSweep({ ...base, balance: -1n })).toThrow();
    expect(() => planSweep({ ...base, balance: SOL, minSweepLamports: 0n })).toThrow();
  });
});

describe('cashbox job', () => {
  it('sweeps the excess to the vault and keeps the floor (rent + reserve + liabilities)', async () => {
    const t = setup();
    const owed = t.db.addJob({ status: 'building', attempts: 1, failedStage: null });
    t.db.addPayment(owed, { lamports: 300_000_000n });
    const done = t.db.addJob({ status: 'live', failedStage: null });
    t.db.addPayment(done, { lamports: 300_000_000n }); // not refundable any more
    const floor = t.floor(300_000_000n);
    t.chain.setBalance(cashbox, floor + 2n * SOL);

    const report = await t.job().runOnce();

    expect(report.outcome).toMatchObject({ result: 'swept', lamports: 2n * SOL });
    expect(t.chain.receivedBy(t.vault)).toBe(2n * SOL);
    expect(t.chain.balanceOf(cashbox)).toBe(floor - 5_000n);
    expect(t.chain.balanceOf(cashbox)).toBeGreaterThanOrEqual(t.rent + RESERVE + 300_000_000n);
    expect((await t.journal.get('sweep'))?.lastSweep?.lamports).toBe((2n * SOL).toString());

    const again = await t.job().runOnce();
    expect(again.outcome).toMatchObject({ result: 'below_reserve' });
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('keeps the unresolved payment anomalies on the cashbox (money refunded by hand)', async () => {
    const t = setup();
    t.db.anomalies.push(
      { id: uuid(), lamports: 300_000_000n, resolvedAt: null },
      { id: uuid(), lamports: 50_000_000n, resolvedAt: null },
      { id: uuid(), lamports: 700_000_000n, resolvedAt: '2026-10-01T00:00:00.000Z' }, // done
    );
    const floor = t.floor(350_000_000n);
    t.chain.setBalance(cashbox, floor + 2n * SOL);
    const report = await t.job().runOnce();
    expect(report.outcome).toMatchObject({ result: 'swept', lamports: 2n * SOL });
    expect(t.chain.balanceOf(cashbox)).toBe(floor - 5_000n);
    expect(t.alerter.codes()).not.toContain('cashbox_anomaly_amount_unknown');

    // Below the floor once the anomalies count: alerted with the amount, nothing swept.
    t.chain.setBalance(cashbox, t.rent + RESERVE + 349_999_999n);
    expect((await t.job().runOnce()).outcome).toMatchObject({ result: 'below_reserve' });
    const low = t.alerter.alerts.find((a) => a.code === 'cashbox_low_balance');
    expect(low?.details).toMatchObject({ anomalies: '0.35 SOL', liabilities: '0 SOL' });
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('alerts on an unresolved anomaly whose amount is unknown (not counted in the floor)', async () => {
    const t = setup();
    t.db.anomalies.push({ id: uuid(), lamports: null, resolvedAt: null });
    t.chain.setBalance(cashbox, t.floor() + 2n * SOL);
    const report = await t.job().runOnce();
    expect(report.outcome).toMatchObject({ result: 'swept', lamports: 2n * SOL });
    const alert = t.alerter.alerts.find((a) => a.code === 'cashbox_anomaly_amount_unknown');
    expect(alert?.level).toBe('high');
    expect(alert?.details).toMatchObject({ unknownAmounts: 1, unresolved: 1 });
  });

  it('threshold edge: one lamport short does nothing, exactly the threshold sweeps it', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + MIN_SWEEP - 1n);
    expect((await t.job().runOnce()).outcome).toMatchObject({ result: 'below_threshold' });
    expect(t.chain.calls).not.toContain('sendRawTransaction');
    t.chain.setBalance(cashbox, t.floor() + MIN_SWEEP);
    expect((await t.job().runOnce()).outcome).toMatchObject({
      result: 'swept',
      lamports: MIN_SWEEP,
    });
  });

  it('below the reserve: alerts, never sweeps', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.rent + RESERVE - 1n);
    const report = await t.job().runOnce();
    expect(report.outcome).toMatchObject({ result: 'below_reserve' });
    expect(t.alerter.codes()).toContain('cashbox_low_balance');
    expect(t.chain.transfers).toHaveLength(0);
  });

  it('computes from the lower of confirmed and finalized balances', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + SOL);
    t.chain.finalizedBalances.set(cashbox.toBase58(), t.floor() + MIN_SWEEP);
    expect((await t.job().runOnce()).outcome).toMatchObject({
      result: 'swept',
      lamports: MIN_SWEEP,
    });
  });

  it('reads rent from the cluster', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + MIN_SWEEP);
    t.chain.rentPerByteYear = 4_000n; // rent went up: the same balance is now below the threshold
    expect((await t.job().runOnce()).outcome).toMatchObject({ result: 'below_threshold' });
  });

  it('dry run: computes the sweep, never signs or sends', async () => {
    const t = setup({ dryRun: true });
    t.chain.setBalance(cashbox, t.floor() + SOL);
    const signSpy = vi.spyOn(keystore, 'withSigner');
    const report = await t.job().runOnce();
    expect(report.outcome).toMatchObject({ result: 'dry_run', lamports: SOL });
    expect(signSpy).not.toHaveBeenCalled();
    expect(t.chain.calls).not.toContain('sendRawTransaction');
    expect(t.chain.calls).not.toContain('getLatestBlockhash');
  });

  it('a sweep in flight blocks the next one until it settles', async () => {
    const t = setup({ settle: { timeoutMs: 4_000 } });
    t.chain.setBalance(cashbox, t.floor() + SOL);
    t.chain.defaultBehavior = 'drop';
    const first = await t.job().runOnce();
    expect(first.outcome).toMatchObject({ result: 'in_flight' });
    const sig = (first.outcome as { signature: string }).signature;
    // More payments arrive: still no second sweep while the first can land.
    t.chain.setBalance(cashbox, t.chain.balanceOf(cashbox) + SOL);
    const second = await t.job().runOnce();
    expect(second.outcome).toMatchObject({ result: 'in_flight', signature: sig });
    expect(new Set(t.chain.sendAttempts)).toEqual(new Set([sig]));

    t.chain.advance(400);
    t.chain.defaultBehavior = 'land';
    const third = await t
      .job({
        config: {
          cashbox,
          vault: t.vault,
          reserveLamports: RESERVE,
          minSweepLamports: MIN_SWEEP,
          dryRun: false,
        },
      })
      .runOnce();
    expect(third.outcome).toMatchObject({ result: 'swept', lamports: 2n * SOL });
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('records a sweep that landed while the job was not waiting', async () => {
    const t = setup({ settle: { timeoutMs: 2_000 } });
    t.chain.setBalance(cashbox, t.floor() + SOL);
    t.chain.behaviors.push('drop');
    await t.job().runOnce();
    const entry = await t.journal.get('sweep');
    await t.chain.sendRawTransaction(Buffer.from(entry!.inFlight!.rawTx, 'base64'));
    t.chain.advance(100);
    const report = await t.job().runOnce();
    expect(report.outcome).toMatchObject({
      result: 'swept',
      signature: entry!.inFlight!.signature,
    });
    expect(t.chain.transfers).toHaveLength(1);
  });

  it('alerts on an on-chain failure; nothing moved', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + SOL);
    t.chain.behaviors.push('fail_onchain');
    const report = await t.job().runOnce();
    expect(report.outcome).toMatchObject({ result: 'failed' });
    expect(t.alerter.codes()).toContain('cashbox_sweep_failed');
    expect(t.chain.receivedBy(t.vault)).toBe(0n);
  });

  it('does not sweep to a vault that would stay below rent', async () => {
    const t = setup({ minSweepLamports: 1n });
    t.chain.setBalance(t.vault, 0n);
    t.chain.setBalance(cashbox, t.floor() + 1_000n);
    expect((await t.job().runOnce()).outcome).toMatchObject({
      result: 'skipped',
      reason: 'vault_not_rent_exempt',
    });
  });

  it('refuses a transfer from core that does not go to the vault, before signing', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + SOL);
    t.core.buildSolTransferTx = (p) =>
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: p.from,
          toPubkey: randomAddress(),
          lamports: p.lamports,
        }),
      );
    const signSpy = vi.spyOn(keystore, 'withSigner');
    const report = await t.job().runOnce();
    expect(report.status).toBe('error');
    expect(t.alerter.codes()).toContain('cashbox_policy_violation');
    expect(signSpy).not.toHaveBeenCalled();
    expect(t.chain.calls).not.toContain('sendRawTransaction');
  });

  it('refuses to run with a cashbox key that is not FORGE_CASHBOX_WALLET', async () => {
    const t = setup({ cashbox: randomAddress() });
    const report = await t.job().runOnce();
    expect(report).toMatchObject({ status: 'error', reason: 'cashbox_key' });
  });

  it('refuses a vault equal to the cashbox', () => {
    expect(() => setup({ vault: cashbox }).job()).toThrow();
  });

  it('honours the pause flag and fails closed', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + SOL);
    t.flags.values.cashbox_sweep_paused = true;
    expect((await t.job().runOnce()).status).toBe('paused');
    t.flags.values.cashbox_sweep_paused = false;
    t.flags.fail = true;
    expect((await t.job().runOnce()).reason).toBe('flags_unavailable');
    expect(t.chain.calls).toHaveLength(0);
  });

  it('re-reads the kill switch once the wallet lock is held (paused while waiting: nothing done)', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + SOL);
    const lock = new Mutex();
    let release!: () => void;
    const holder = lock.runExclusive(() => new Promise<void>((r) => (release = r)));
    const signSpy = vi.spyOn(keystore, 'withSigner');
    const run = t.job({ walletLock: lock }).runOnce();
    // The run passed the first check and now waits on the lock held by the refunds job.
    await new Promise((r) => setImmediate(r));
    t.flags.values.cashbox_sweep_paused = true;
    release();
    await holder;
    expect(await run).toEqual({ status: 'paused', reason: 'flag' });
    expect(signSpy).not.toHaveBeenCalled();
    expect(t.chain.calls).toHaveLength(0);
    expect(await t.journal.get('sweep')).toBeUndefined();
  });

  it('re-reads the kill switch right before signing (paused mid-run: nothing signed)', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + SOL);
    const build = t.core.buildSolTransferTx.bind(t.core);
    t.core.buildSolTransferTx = (p) => {
      // Turned on after planning, before the signature.
      t.flags.values.cashbox_sweep_paused = true;
      return build(p);
    };
    const signSpy = vi.spyOn(keystore, 'withSigner');
    expect(await t.job().runOnce()).toEqual({ status: 'paused', reason: 'flag' });
    expect(signSpy).not.toHaveBeenCalled();
    expect(t.chain.calls).not.toContain('sendRawTransaction');
    expect((await t.journal.get('sweep'))?.inFlight ?? null).toBeNull();
    expect(t.chain.transfers).toHaveLength(0);
  });

  it('fails closed before signing when the flags become unreadable mid-run (and alerts)', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + SOL);
    const build = t.core.buildSolTransferTx.bind(t.core);
    t.core.buildSolTransferTx = (p) => {
      t.flags.fail = true;
      return build(p);
    };
    const signSpy = vi.spyOn(keystore, 'withSigner');
    expect(await t.job().runOnce()).toEqual({ status: 'paused', reason: 'flags_unavailable' });
    expect(t.alerter.codes()).toContain('cashbox_paused_flags_unavailable');
    expect(signSpy).not.toHaveBeenCalled();
    expect(t.chain.calls).not.toContain('sendRawTransaction');
  });

  it('retries transient RPC errors with backoff and stops on exhaustion', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + SOL);
    t.chain.failNext('getBalance', new TransientRpcError(), 2);
    expect((await t.job().runOnce()).outcome).toMatchObject({ result: 'swept' });
    expect(t.sleeps.slice(0, 2)).toEqual([500, 1_000]);

    const u = setup();
    u.chain.setBalance(cashbox, u.floor() + SOL);
    u.chain.failNext('getMinimumBalanceForRentExemption', new TransientRpcError(), 4);
    const report = await u.job().runOnce();
    expect(report.status).toBe('error');
    expect(u.alerter.codes()).toContain('cashbox_run_failed');
    expect(u.chain.transfers).toHaveLength(0);
  });

  it('calls onBeforeSend before the broadcast', async () => {
    const t = setup();
    t.chain.setBalance(cashbox, t.floor() + SOL);
    const seen: number[] = [];
    await t.job({ onBeforeSend: () => seen.push(t.chain.sendAttempts.length) }).runOnce();
    expect(seen).toEqual([0]);
  });

  it('shares a wallet lock with the refunds job: never both at once, and refunds stay covered', async () => {
    const t = setup();
    const job = t.db.addJob();
    const payment = t.db.addPayment(job, { lamports: 300_000_000n });
    const payer = new PublicKey(job.ownerWallet);
    t.chain.setBalance(payer, 10_000_000n);
    t.chain.setBalance(cashbox, t.floor(300_000_000n) + SOL);
    const lock = new Mutex();
    const order: string[] = [];
    const wrap = (name: string) => {
      const run = lock.runExclusive.bind(lock);
      return {
        runExclusive: async <T>(fn: () => Promise<T>) =>
          run(async () => {
            order.push(`${name}:start`);
            try {
              return await fn();
            } finally {
              order.push(`${name}:end`);
            }
          }),
      } as unknown as Mutex;
    };
    const refunds = createRefundsJob({
      store: t.db,
      rpc: t.chain,
      core: t.core,
      keystore,
      journal: createMemoryJournal(RefundJournalEntry),
      manualMarks: createMemoryJournal(RefundManualMark),
      ledger: createRefundLedger(createMemoryJournal(RefundLedgerEntry)),
      flags: memoryFlags(),
      alerter: new RecordingAlerter(),
      logger: silentJobLogger,
      config: { cashbox, maxRefundLamports: SOL },
      retry: t.retry,
      sleep: t.sleep,
      now: t.clock.now,
      walletLock: wrap('refunds'),
      onBeforeSend: () => undefined,
    });
    const sweep = t.job({ walletLock: wrap('cashbox') });
    await Promise.all([sweep.runOnce(), refunds.runOnce()]);
    expect(order[1]).toMatch(/:end$/);
    expect(order[3]).toMatch(/:end$/);
    expect(t.chain.receivedBy(payer)).toBe(300_000_000n);
    expect(t.db.payments.get(payment.id)!.status).toBe('refunded');
    expect(t.chain.balanceOf(cashbox)).toBeGreaterThanOrEqual(t.rent + RESERVE);
  });
});

describe('cashbox config and store', () => {
  it('defaults to dry run', () => {
    const vault = randomAddress();
    const c = cashboxConfigFromEnv({}, { cashbox, vault });
    expect(c.config.dryRun).toBe(true);
    expect(c.config.maxSweepLamports).toBeNull();
    expect(c.intervalMs).toBe(24 * 60 * 60_000);
    const live = cashboxConfigFromEnv(
      {
        SIGNER_CASHBOX_DRY_RUN: 'false',
        SIGNER_CASHBOX_RESERVE_LAMPORTS: '500000000',
        SIGNER_CASHBOX_MAX_SWEEP_LAMPORTS: '1000000000',
      },
      { cashbox, vault },
    );
    expect(live.config).toMatchObject({
      dryRun: false,
      reserveLamports: 500_000_000n,
      maxSweepLamports: SOL,
    });
    expect(() =>
      cashboxConfigFromEnv({ SIGNER_CASHBOX_DRY_RUN: 'off' }, { cashbox, vault }),
    ).toThrow();
  });

  it('sums the liabilities of refundable jobs only', () => {
    expect(
      sumLiabilities([
        { lamports: '100', jobs: { status: 'paid', failed_stage: null } },
        { lamports: 200, jobs: { status: 'building', failed_stage: null } },
        { lamports: '400', jobs: { status: 'failed', failed_stage: 'build' } },
        { lamports: '800', jobs: { status: 'failed', failed_stage: 'deploy' } },
        { lamports: '1600', jobs: { status: 'spec_ready', failed_stage: null } },
      ]),
    ).toBe(2_300n);
  });

  it('queries confirmed payments joined with refundable jobs, page by page', async () => {
    const urls: string[] = [];
    const pages = [
      [
        { id: uuid(), lamports: '300', jobs: { status: 'paid', failed_stage: null } },
        { id: uuid(), lamports: '5', jobs: { status: 'failed', failed_stage: 'onchain' } },
      ],
      [{ id: uuid(), lamports: '7', jobs: { status: 'failed', failed_stage: 'build' } }],
    ];
    const client = createPostgrestClient({
      url: 'https://project.supabase.co',
      serviceRoleKey: 'service-role-key-for-tests-0123456789',
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(pages.shift() ?? []), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await createPostgrestCashboxStore(client, 2).outstandingRefundLiabilities()).toBe(307n);
    const q = new URL(urls[0]!).searchParams;
    expect(q.get('status')).toBe('eq.confirmed');
    expect(q.get('select')).toContain('jobs!inner');
    expect(q.get('jobs.status')).toBe('in.(spec_ready,paid,building,failed)');
  });

  it('sums the unresolved anomalies with a known amount and counts the unknown ones', () => {
    expect(
      sumAnomalies([
        { id: 'a', lamports: '100' },
        { id: 'b', lamports: 7 },
        { id: 'c', lamports: null },
      ]),
    ).toEqual({ lamports: 107n, count: 3, unknownAmounts: 1 });
    expect(sumAnomalies([])).toEqual({ lamports: 0n, count: 0, unknownAmounts: 0 });
  });

  it('queries the unresolved payment anomalies, page by page', async () => {
    const pages: unknown[][] = [
      [
        { id: 'a', lamports: '100' },
        { id: 'b', lamports: null },
      ],
      [{ id: 'c', lamports: '7' }],
    ];
    const urls: string[] = [];
    const client = createPostgrestClient({
      url: 'https://project.supabase.co',
      serviceRoleKey: 'service-role-key-for-tests-0123456789',
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(pages.shift() ?? []), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await createPostgrestCashboxStore(client, 2).unresolvedPaymentAnomalies()).toEqual({
      lamports: 107n,
      count: 3,
      unknownAmounts: 1,
    });
    expect(urls).toHaveLength(2);
    const q = new URL(urls[0]!).searchParams;
    expect(new URL(urls[0]!).pathname).toBe('/rest/v1/payment_anomalies');
    expect(q.get('resolved_at')).toBe('is.null');
    expect(q.get('select')).toBe('id,lamports::text');
  });
});
