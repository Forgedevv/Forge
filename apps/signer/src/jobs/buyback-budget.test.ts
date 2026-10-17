import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBuybackBudgetSource,
  createFileBuybackBudgetSource,
  rpcClaimFinality,
  type BuybackBudgetDeps,
  type ClaimFinality,
} from './buyback-budget.js';
import {
  BuybackJournalEntry,
  dayJournalKey,
  type BuybackBudgetSource,
  type BuybackDayEntry,
  type BuybackRevenueFigures,
} from './buyback.js';
import { ClaimReceiptEntry } from './claims.js';
import { RevenueForwardEntry, type RevenueSource } from './revenue.js';
import { JobError, createMemoryJournal, type Journal, type SignatureLookup } from './shared.js';
import { RecordingLogger, randomAddress } from './testing.js';

const SOL = 1_000_000_000n;
const SINCE = '2026-11-01T00:00:00Z';
const NOW = Date.UTC(2026, 10, 5, 12);
const VAULT = randomAddress();

function forward(
  signature: string,
  finalizedAt: string,
  amounts: Partial<Record<RevenueSource, bigint>>,
): RevenueForwardEntry {
  const breakdown = {
    meteora_referral: amounts.meteora_referral ?? 0n,
    jupiter_referral: amounts.jupiter_referral ?? 0n,
    platform_fee: amounts.platform_fee ?? 0n,
    other: amounts.other ?? 0n,
  };
  const lamports = Object.values(breakdown).reduce((a, b) => a + b, 0n);
  return {
    v: 1,
    signature,
    lamports: lamports.toString(),
    sentAt: finalizedAt,
    finalizedAt,
    breakdown: {
      meteora_referral: breakdown.meteora_referral.toString(),
      jupiter_referral: breakdown.jupiter_referral.toString(),
      platform_fee: breakdown.platform_fee.toString(),
      other: breakdown.other.toString(),
    },
    relatedSignatures: [],
  };
}

function receipt(
  signature: string,
  settledAt: string,
  lamports: bigint,
  over: Partial<ClaimReceiptEntry> = {},
): ClaimReceiptEntry {
  return {
    v: 1,
    signature,
    kind: 'dbc',
    pool: 'pool',
    launchpadId: 'lp',
    receiver: VAULT.toBase58(),
    lamports: lamports.toString(),
    settledAt,
    commitment: 'finalized',
    finalizedAt: settledAt,
    positions: [],
    ...over,
  };
}

function day(
  date: string,
  funding: BuybackDayEntry['funding'],
  over: Partial<BuybackDayEntry> = {},
): BuybackDayEntry {
  return {
    kind: 'day',
    v: 1,
    day: date,
    mode: 'live',
    createdAt: `${date}T00:00:05.000Z`,
    budgetLamports: '0',
    capLamports: '5000000000',
    slots: [],
    funding,
    ...over,
  };
}

const at = (date: string, time = '00:01:00') => `${date}T${time}.000Z`;

function harness(over: Partial<BuybackBudgetDeps> = {}) {
  const forwards = createMemoryJournal(RevenueForwardEntry);
  const receipts = createMemoryJournal(ClaimReceiptEntry);
  const buyback = createMemoryJournal(BuybackJournalEntry);
  const logger = new RecordingLogger();
  const finality = vi.fn<(signature: string) => Promise<ClaimFinality>>(async () => 'finalized');
  const source = createBuybackBudgetSource({
    since: SINCE,
    vault: VAULT,
    forwards,
    receipts,
    buyback,
    finality,
    logger,
    now: () => NOW,
    ...over,
  });
  return { forwards, receipts, buyback, logger, finality, source };
}

async function ok(source: BuybackBudgetSource): Promise<BuybackRevenueFigures> {
  const r = await source.backlog();
  if (r.status !== 'ok') throw new Error(`${r.status}: ${r.reason}`);
  return r.figures;
}

describe('buyback budget: revenue backlog', () => {
  it('sums the forwards by source and the vault claims by kind, from the instant on', async () => {
    const h = harness();
    // Before the instant: never bought back, whatever it was.
    await h.forwards.put('old', forward('old', '2026-10-31T23:59:59.999Z', { platform_fee: 9n * SOL }));
    await h.receipts.put('oldClaim', receipt('oldClaim', '2026-10-31T12:00:00.000Z', 4n * SOL));
    // From the instant (inclusive).
    await h.forwards.put('f1', forward('f1', SINCE, { meteora_referral: SOL, platform_fee: 3n }));
    await h.forwards.put(
      'f2',
      forward('f2', at('2026-11-03'), { jupiter_referral: 200_000_000n, other: 5n }),
    );
    await h.receipts.put('c1', receipt('c1', SINCE, 50_000_000n));
    await h.receipts.put(
      'c2',
      receipt('c2', at('2026-11-04'), 70_000_000n, { kind: 'position', positions: ['p'] }),
    );
    const f = await ok(h.source);
    expect(f).toEqual({
      since: SINCE,
      forwards: {
        count: 2,
        lamports: SOL + 3n + 200_000_000n + 5n,
        breakdown: {
          meteora_referral: SOL,
          jupiter_referral: 200_000_000n,
          platform_fee: 3n,
          other: 5n,
        },
      },
      claims: { count: 2, lamports: 120_000_000n, dbc: 50_000_000n, position: 70_000_000n, awaitingFinality: 0 },
      revenueLamports: SOL + 3n + 200_000_000n + 5n + 120_000_000n,
      spent: { withdrawals: 0, lamports: 0n },
      backlogLamports: SOL + 3n + 200_000_000n + 5n + 120_000_000n,
    });
    // Finalized receipts are counted without asking the ledger.
    expect(h.finality).not.toHaveBeenCalled();
  });

  it('is 0 with nothing journaled, and identical on every call (restart)', async () => {
    const h = harness();
    expect((await ok(h.source)).backlogLamports).toBe(0n);
    await h.forwards.put('f1', forward('f1', at('2026-11-02'), { platform_fee: 7n }));
    expect(await h.source.backlog()).toEqual(await h.source.backlog());
    expect((await ok(h.source)).backlogLamports).toBe(7n);
  });

  it('ignores claims another receiver got', async () => {
    const h = harness();
    await h.receipts.put('c1', receipt('c1', at('2026-11-02'), 50_000_000n));
    await h.receipts.put(
      'c2',
      receipt('c2', at('2026-11-02'), 80_000_000n, { receiver: randomAddress().toBase58() }),
    );
    const f = await ok(h.source);
    expect(f.claims).toMatchObject({ count: 1, lamports: 50_000_000n });
    expect(f.backlogLamports).toBe(50_000_000n);
    expect(h.logger.lines.some((l) => l.msg === 'claim receipt not for the vault')).toBe(true);
  });

  it('subtracts the withdrawals the buyback journaled since the instant, never below zero', async () => {
    const h = harness();
    await h.forwards.put('f1', forward('f1', at('2026-11-02'), { meteora_referral: 2n * SOL }));
    const fundings: Array<[string, BuybackDayEntry['funding']]> = [
      // Before the instant: not this budget's business.
      ['2026-10-30', { status: 'confirmed', lamports: '900000000', signature: 's0', at: at('2026-10-30') }],
      ['2026-11-02', { status: 'confirmed', lamports: '500000000', signature: 's1', at: at('2026-11-02') }],
      // Interrupted and unknown: the SOL may have left the vault, counted.
      ['2026-11-03', { status: 'requested', lamports: '100000000', at: at('2026-11-03') }],
      ['2026-11-04', { status: 'unknown', lamports: '200000000', signature: 's3', at: at('2026-11-04') }],
      // Failed (nothing moved) and not needed: not counted.
      ['2026-11-05', { status: 'failed', lamports: '300000000', signature: 's4', note: 'x', at: at('2026-11-05') }],
      ['2026-11-06', { status: 'not_needed', lamports: '0', at: at('2026-11-06') }],
      ['2026-11-07', null],
    ];
    for (const [d, funding] of fundings) await h.buyback.put(dayJournalKey(d), day(d, funding));
    await h.buyback.put('inflight', { kind: 'inflight', v: 1, tx: null });
    const f = await ok(h.source);
    expect(f.spent).toEqual({ withdrawals: 3, lamports: 800_000_000n });
    expect(f.backlogLamports).toBe(1_200_000_000n);
    // More withdrawn than received (e.g. the fee allowance): floored at zero, never negative.
    await h.buyback.put(
      dayJournalKey('2026-11-08'),
      day('2026-11-08', { status: 'confirmed', lamports: '1300000000', signature: 's8', at: at('2026-11-08') }),
    );
    const g = await ok(h.source);
    expect(g.spent.lamports).toBe(2_100_000_000n);
    expect(g.backlogLamports).toBe(0n);
  });

  it('carries the revenue over the days: what the cap leaves out is still there tomorrow', async () => {
    const h = harness();
    // Day 1: 7 SOL of revenue, the day takes the 5 SOL cap.
    await h.forwards.put('f1', forward('f1', at('2026-11-01', '08:00:00'), { meteora_referral: 7n * SOL }));
    expect((await ok(h.source)).backlogLamports).toBe(7n * SOL);
    await h.buyback.put(
      dayJournalKey('2026-11-01'),
      day('2026-11-01', { status: 'confirmed', lamports: '5000000000', signature: 'w1', at: at('2026-11-01', '09:00:00') }),
    );
    // Day 2: 2 SOL left; taken.
    expect((await ok(h.source)).backlogLamports).toBe(2n * SOL);
    await h.buyback.put(
      dayJournalKey('2026-11-02'),
      day('2026-11-02', { status: 'confirmed', lamports: '2000000000', signature: 'w2', at: at('2026-11-02') }),
    );
    expect((await ok(h.source)).backlogLamports).toBe(0n);
    // Day 3: a claim lands; only that is owed.
    await h.receipts.put('c1', receipt('c1', at('2026-11-03'), 300_000_000n));
    expect((await ok(h.source)).backlogLamports).toBe(300_000_000n);
  });

  it('counts a confirmed claim only once the ledger shows it finalized, promoting the receipt once', async () => {
    const h = harness();
    await h.receipts.put(
      'c1',
      receipt('c1', at('2026-11-02'), 50_000_000n, { commitment: 'confirmed', finalizedAt: undefined }),
    );
    h.finality.mockResolvedValueOnce('pending');
    let f = await ok(h.source);
    expect(f.claims).toMatchObject({ count: 0, lamports: 0n, awaitingFinality: 1 });
    expect(f.backlogLamports).toBe(0n);
    expect((await h.receipts.get('c1'))?.commitment).toBe('confirmed');

    // Finalized now: counted, and the receipt is promoted (idempotent: asked once).
    f = await ok(h.source);
    expect(f.claims).toMatchObject({ count: 1, lamports: 50_000_000n, awaitingFinality: 0 });
    expect(await h.receipts.get('c1')).toMatchObject({
      commitment: 'finalized',
      finalizedAt: new Date(NOW).toISOString(),
      settledAt: at('2026-11-02'),
    });
    expect(h.finality).toHaveBeenCalledTimes(2);
    await ok(h.source);
    expect(h.finality).toHaveBeenCalledTimes(2);
    // A confirmed receipt from before the instant is neither counted nor looked up.
    await h.receipts.put(
      'c0',
      receipt('c0', '2026-10-01T00:00:00.000Z', 9n * SOL, { commitment: 'confirmed', finalizedAt: undefined }),
    );
    expect((await ok(h.source)).claims.lamports).toBe(50_000_000n);
    expect(h.finality).toHaveBeenCalledTimes(2);
  });

  it('never counts a claim whose finality cannot be read or that shows an error', async () => {
    const h = harness();
    await h.receipts.put('c1', receipt('c1', at('2026-11-02'), 50_000_000n, { commitment: 'confirmed' }));
    await h.receipts.put('c2', receipt('c2', at('2026-11-02'), 60_000_000n, { commitment: 'confirmed' }));
    h.finality.mockImplementation(async (signature) => {
      if (signature === 'c1') throw new JobError('RPC', 'down', { transient: true });
      return 'failed';
    });
    const f = await ok(h.source);
    expect(f.claims).toMatchObject({ count: 0, lamports: 0n, awaitingFinality: 1 });
    expect((await h.receipts.get('c1'))?.commitment).toBe('confirmed');
    expect((await h.receipts.get('c2'))?.commitment).toBe('confirmed');
    expect(h.logger.lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining([
        'claim finality unavailable: not counted yet',
        'a confirmed claim shows an error: not counted',
      ]),
    );
  });

  it('is unconfigured without BUYBACK_REVENUE_SINCE', async () => {
    expect(await harness({ since: null }).source.backlog()).toEqual({
      status: 'unconfigured',
      reason: 'BUYBACK_REVENUE_SINCE is not set',
    });
    expect((await harness({ since: 'soon' }).source.backlog()).status).toBe('unconfigured');
  });

  it('is unavailable, never a partial sum, on an unreadable journal or a corrupt entry', async () => {
    const failing = <T>(journal: Journal<T>): Journal<T> => ({
      ...journal,
      list: async () => {
        throw new JobError('JOURNAL_IO', 'EACCES');
      },
    });
    const io = harness({ forwards: failing(createMemoryJournal(RevenueForwardEntry)) });
    await io.forwards.put('f1', forward('f1', at('2026-11-02'), { platform_fee: 7n }));
    expect(await io.source.backlog()).toEqual({
      status: 'unavailable',
      reason: 'JOURNAL_IO: EACCES',
    });
    expect(io.logger.lines.some((l) => l.msg === 'buyback budget unavailable')).toBe(true);

    const probe = harness({
      probe: async () => {
        throw new JobError('JOURNAL_IO', 'ENOENT');
      },
    });
    expect((await probe.source.backlog()).status).toBe('unavailable');

    const badDate = harness();
    await badDate.forwards.put('f1', forward('f1', at('2026-11-02'), { platform_fee: 7n }));
    await badDate.receipts.put('c1', receipt('c1', 'not a date', 1n));
    expect(await badDate.source.backlog()).toMatchObject({ status: 'unavailable' });

    const badKey = harness();
    await badKey.buyback.put(dayJournalKey('2026-11-02'), day('2026-11-03', null));
    expect(await badKey.source.backlog()).toEqual({
      status: 'unavailable',
      reason: 'JOURNAL_CORRUPT: buyback day entry does not match its key',
    });

    const mismatch = harness();
    await mismatch.receipts.put('other', receipt('c1', at('2026-11-02'), 1n));
    expect(await mismatch.source.backlog()).toEqual({
      status: 'unavailable',
      reason: 'JOURNAL_CORRUPT: claim receipt does not match its key',
    });
  });
});

describe('rpcClaimFinality', () => {
  const lookup = (state: SignatureLookup['state']): SignatureLookup => ({ state, contextSlot: 10 });
  it('reports finalized only when the node says so without an error', async () => {
    const answers = new Map<string, SignatureLookup>([
      ['fin', lookup({ slot: 1, confirmationStatus: 'finalized', err: null })],
      ['conf', lookup({ slot: 1, confirmationStatus: 'confirmed', err: null })],
      ['proc', lookup({ slot: 1, confirmationStatus: 'processed', err: null })],
      ['bad', lookup({ slot: 1, confirmationStatus: 'finalized', err: { InstructionError: [0, 'x'] } })],
      ['gone', lookup(null)],
    ]);
    const finality = rpcClaimFinality(
      { getSignatureState: async (s) => answers.get(s)! },
      { attempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined },
    );
    expect(await finality('fin')).toBe('finalized');
    expect(await finality('conf')).toBe('pending');
    expect(await finality('proc')).toBe('pending');
    expect(await finality('bad')).toBe('failed');
    expect(await finality('gone')).toBe('pending');
  });
});

describe('buyback budget over the journal directory', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-buyback-budget-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, value: unknown) =>
    fs.writeFile(path.join(dir, name), JSON.stringify(value, null, 2));

  function fileSource(journalDir = dir, since: string | null = SINCE) {
    return createFileBuybackBudgetSource({
      journalDir,
      since,
      vault: VAULT,
      rpc: {
        getSignatureState: async () => ({
          state: { slot: 1, confirmationStatus: 'finalized', err: null },
          contextSlot: 1,
        }),
      },
      logger: new RecordingLogger(),
      now: () => NOW,
    });
  }

  it('reads only the forward, claim-receipt and buyback journals: a cashbox sweep is not revenue', async () => {
    await write('revenue-forward.f1.json', forward('f1', at('2026-11-02'), { platform_fee: 300_000_000n }));
    await write('claim-receipt.c1.json', receipt('c1', at('2026-11-02'), 100_000_000n, { commitment: 'confirmed', finalizedAt: undefined }));
    await write(
      'buyback.day-2026-11-02.json',
      day('2026-11-02', { status: 'confirmed', lamports: '50000000', signature: 'w', at: at('2026-11-02') }),
    );
    // Client payments reaching the vault (cashbox sweeps), spending-limit records, other jobs.
    await write('cashbox.sweep-2026-11-02.json', { lamports: '9000000000', to: VAULT.toBase58() });
    await write('squads.buyback-funding-2026-11-02.json', { lamports: '50000000' });
    await write('refund-ledger.x.json', { lamports: '1' });
    await fs.writeFile(path.join(dir, 'signer.lock'), 'pid');
    const f = await ok(fileSource());
    expect(f.revenueLamports).toBe(400_000_000n);
    expect(f.spent).toEqual({ withdrawals: 1, lamports: 50_000_000n });
    expect(f.backlogLamports).toBe(350_000_000n);
    // The promotion reached the file, so a restart does not ask the ledger again.
    const promoted = JSON.parse(await fs.readFile(path.join(dir, 'claim-receipt.c1.json'), 'utf8'));
    expect(promoted).toMatchObject({ commitment: 'finalized', finalizedAt: new Date(NOW).toISOString() });
    expect(await ok(fileSource())).toEqual(f);
  });

  it('is unavailable when the directory is missing or an entry is corrupt (no guess)', async () => {
    const missing = await fileSource(path.join(dir, 'nowhere')).backlog();
    expect(missing).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('JOURNAL_IO') });
    await write('revenue-forward.f1.json', forward('f1', at('2026-11-02'), { platform_fee: 7n }));
    expect((await ok(fileSource())).backlogLamports).toBe(7n);
    await fs.writeFile(path.join(dir, 'revenue-forward.f2.json'), '{ not json');
    expect(await fileSource().backlog()).toEqual({
      status: 'unavailable',
      reason: 'JOURNAL_CORRUPT: revenue-forward entry is not JSON',
    });
    await write('revenue-forward.f2.json', { v: 1, signature: 'f2' });
    expect(await fileSource().backlog()).toEqual({
      status: 'unavailable',
      reason: 'JOURNAL_CORRUPT: revenue-forward entry is invalid',
    });
  });
});
