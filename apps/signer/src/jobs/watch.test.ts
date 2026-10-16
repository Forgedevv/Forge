/// <reference types="node" />
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { Alerter } from '../alerts.js';
import { createMemoryJournal } from './shared.js';
import {
  EXPECTED_SIGNATURE_LOG_FILE,
  SerializedWatchState,
  buildCreatorAccounts,
  buildStaticAccounts,
  createExpectedSignatureLog,
  createExpectedSignatures,
  createSupabaseTargetSource,
  createWatchState,
  detectLowBalance,
  detectMissingPoolRows,
  detectNotRentExempt,
  detectOutflows,
  detectPoolChanges,
  detectRpcErrorStreak,
  exportWatchState,
  formatSol,
  importWatchState,
  nextDelayMs,
  outflowOf,
  parseWatchConfig,
  recipientsOf,
  restoreWatchState,
  runWatchCycle,
  startWatch,
  type AccountSnapshot,
  type PoolSnapshot,
  type TxLite,
  type WatchDeps,
  type WatchRpc,
  type WatchTargets,
  type WatchedAccount,
  type WatchedPool,
} from './watch.js';

const VAULT = Keypair.generate().publicKey.toBase58();
const FEE = Keypair.generate().publicKey.toBase58();
const CASHBOX = Keypair.generate().publicKey.toBase58();
const PAYER = Keypair.generate().publicKey.toBase58();
const REFERRAL = Keypair.generate().publicKey.toBase58();
const ATTACKER = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const BOT = Keypair.generate().publicKey.toBase58();
const SOL = 1_000_000_000n;
const RENT_0 = 890_880n;

const config = parseWatchConfig({});

function snap(address: string, lamports: bigint, dataLength = 0): AccountSnapshot {
  return { address, exists: true, lamports, dataLength };
}

function tx(
  signature: string,
  moves: Record<string, [bigint, bigint]>,
  opts: { fee?: bigint; failed?: boolean; feePayer?: string } = {},
): TxLite {
  const keys = Object.keys(moves);
  if (opts.feePayer)
    keys.splice(0, keys.length, opts.feePayer, ...keys.filter((k) => k !== opts.feePayer));
  return {
    signature,
    failed: opts.failed ?? false,
    fee: opts.fee ?? 5000n,
    accountKeys: keys,
    preBalances: keys.map((k) => moves[k]![0]),
    postBalances: keys.map((k) => moves[k]![1]),
  };
}

const vaultAccount: WatchedAccount = {
  address: VAULT,
  label: 'multisig vault',
  role: 'vault',
  watchOutflows: true,
  allowedDestinations: [],
};
const cashboxAccount: WatchedAccount = {
  address: CASHBOX,
  label: 'cashbox',
  role: 'cashbox',
  minLamports: SOL,
  requireRentExempt: true,
  watchOutflows: true,
  allowedDestinations: [VAULT],
};

describe('configuration', () => {
  it('has sane defaults', () => {
    expect(config.intervalMs).toBe(60_000);
    expect(config.rpcErrorStreak).toBe(5);
    expect(config.minLamports.cashbox).toBe(100_000_000n);
  });

  it('does not watch the creator wallet balances while the payer wallet pays the claims', () => {
    // SIGNER_CLAIMS_FEE_PAYER defaults to `payer`: creator wallets hold 0 SOL by design.
    expect(config.minLamports.creator).toBe(0n);
    expect(parseWatchConfig({ SIGNER_CLAIMS_FEE_PAYER: 'payer' }).minLamports.creator).toBe(0n);
    expect(parseWatchConfig({ SIGNER_CLAIMS_FEE_PAYER: 'creator' }).minLamports.creator).toBe(
      5_000_000n,
    );
    // An explicit value always wins.
    expect(
      parseWatchConfig({ SIGNER_CLAIMS_FEE_PAYER: 'payer', WATCH_MIN_CREATOR_LAMPORTS: '7' })
        .minLamports.creator,
    ).toBe(7n);
    expect(
      parseWatchConfig({ SIGNER_CLAIMS_FEE_PAYER: 'creator', WATCH_MIN_CREATOR_LAMPORTS: '0' })
        .minLamports.creator,
    ).toBe(0n);
    expect(buildCreatorAccounts([{ address: OTHER, label: 'c' }], config)[0]!.minLamports).toBe(0n);
  });

  it('reads overrides and rejects malformed values', () => {
    const c = parseWatchConfig({
      WATCH_INTERVAL_MS: '30000',
      WATCH_MIN_PAYER_LAMPORTS: '42',
      WATCH_MAX_BACKOFF_MS: '10000',
    });
    expect(c.intervalMs).toBe(30_000);
    expect(c.minLamports.payer).toBe(42n);
    expect(c.maxBackoffMs).toBe(30_000); // never below the interval
    expect(() => parseWatchConfig({ WATCH_INTERVAL_MS: '10' })).toThrow();
    expect(() => parseWatchConfig({ WATCH_MIN_PAYER_LAMPORTS: '1.5' })).toThrow();
  });

  it('builds the static account list', () => {
    const accounts = buildStaticAccounts(
      { vault: VAULT, platformFee: FEE, cashbox: CASHBOX, payer: PAYER, referrals: [REFERRAL] },
      config,
    );
    expect(accounts.map((a) => a.role)).toEqual([
      'vault',
      'platformFee',
      'cashbox',
      'payer',
      'referral',
    ]);
    const vault = accounts.find((a) => a.role === 'vault')!;
    expect(vault.watchOutflows).toBe(true);
    expect(vault.allowedDestinations).toEqual([]);
    expect(accounts.find((a) => a.role === 'platformFee')!.requireRentExempt).toBe(true);
    expect(accounts.find((a) => a.role === 'cashbox')!.allowedDestinations).toEqual([VAULT]);
    expect(buildCreatorAccounts([{ address: OTHER, label: 'c' }], config)[0]!.minLamports).toBe(
      config.minLamports.creator,
    );
  });
});

describe('payer and buyback bot wallets', () => {
  it('watches both for outflows, the bot one with the vault as its only destination', () => {
    const accounts = buildStaticAccounts(
      {
        vault: VAULT,
        platformFee: FEE,
        cashbox: CASHBOX,
        payer: PAYER,
        buyback: BOT,
        referrals: [REFERRAL],
      },
      config,
    );
    expect(accounts.map((a) => a.role)).toEqual([
      'vault',
      'platformFee',
      'cashbox',
      'payer',
      'buyback',
      'referral',
    ]);
    expect(accounts.find((a) => a.role === 'payer')).toMatchObject({
      watchOutflows: true,
      watchTokenAccounts: true,
      // The claims the payer pays for forward their fees to the vault.
      allowedDestinations: [VAULT],
      requireRentExempt: true,
    });
    expect(accounts.find((a) => a.role === 'buyback')).toMatchObject({
      address: BOT,
      watchOutflows: true,
      watchTokenAccounts: true,
      allowedDestinations: [VAULT],
      minLamports: 0n,
    });
    expect(parseWatchConfig({ WATCH_MIN_BUYBACK_LAMPORTS: '5' }).minLamports.buyback).toBe(5n);
    // Without a bot wallet (before --init-keys): no entry for it.
    expect(
      buildStaticAccounts({ vault: VAULT, platformFee: FEE, cashbox: CASHBOX }, config).map(
        (a) => a.role,
      ),
    ).toEqual(['vault', 'platformFee', 'cashbox']);
  });
});

describe('detectMissingPoolRows', () => {
  it('flags a remembered pool the database no longer lists, keeps quiet otherwise', () => {
    const remembered = new Map([
      ['P1', { creator: 'C', isMigrated: false }],
      ['P2', { creator: 'D', isMigrated: true }],
    ]);
    const loaded: WatchedPool[] = [{ address: 'P1', label: 'alpha' }];
    const out = detectMissingPoolRows(remembered, loaded);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      code: 'POOL_ROW_MISSING',
      level: 'high',
      dedupKey: 'row-missing:P2',
      details: { pool: 'P2', referenceCreator: 'D' },
    });
    expect(detectMissingPoolRows(new Map(), loaded)).toEqual([]);
    expect(
      detectMissingPoolRows(remembered, [...loaded, { address: 'P2', label: 'beta' }]),
    ).toEqual([]);
  });
});

describe('formatSol', () => {
  it('formats lamports exactly', () => {
    expect(formatSol(0n)).toBe('0 SOL');
    expect(formatSol(1_500_000_000n)).toBe('1.5 SOL');
    expect(formatSol(890_880n)).toBe('0.00089088 SOL');
    expect(formatSol(-SOL)).toBe('-1 SOL');
  });
});

describe('detectLowBalance', () => {
  it('flags a balance below the threshold', () => {
    const d = detectLowBalance(cashboxAccount, snap(CASHBOX, SOL / 2n))!;
    expect(d.code).toBe('LOW_BALANCE');
    expect(d.level).toBe('high');
    expect(d.dedupKey).toBe(`low:${CASHBOX}`);
    expect(d.message).toContain('0.5 SOL');
  });

  it('accepts a balance at the threshold and ignores accounts without one', () => {
    expect(detectLowBalance(cashboxAccount, snap(CASHBOX, SOL))).toBeNull();
    expect(detectLowBalance(vaultAccount, snap(VAULT, 0n))).toBeNull();
  });

  it('treats a missing account as empty', () => {
    const d = detectLowBalance(cashboxAccount, {
      address: CASHBOX,
      exists: false,
      lamports: 0n,
      dataLength: 0,
    });
    expect(d?.code).toBe('LOW_BALANCE');
  });

  it('uses a lower level for creator wallets', () => {
    const creator: WatchedAccount = {
      address: OTHER,
      label: 'c',
      role: 'creator',
      minLamports: 5n,
    };
    expect(detectLowBalance(creator, snap(OTHER, 1n))?.level).toBe('normal');
  });
});

describe('detectNotRentExempt', () => {
  const fee: WatchedAccount = {
    address: FEE,
    label: 'platform fee wallet',
    role: 'platformFee',
    requireRentExempt: true,
  };

  it('flags an account holding less than the rent minimum (devnet finding)', () => {
    const d = detectNotRentExempt(fee, snap(FEE, 500_000n), RENT_0)!;
    expect(d.code).toBe('NOT_RENT_EXEMPT');
    expect(d.level).toBe('high');
    expect(d.details.rentMinimum).toBe(formatSol(RENT_0));
  });

  it('flags a missing account', () => {
    const d = detectNotRentExempt(
      fee,
      { address: FEE, exists: false, lamports: 0n, dataLength: 0 },
      RENT_0,
    )!;
    expect(d.message).toContain('does not exist');
  });

  it('accepts exactly the minimum and skips accounts that do not require it', () => {
    expect(detectNotRentExempt(fee, snap(FEE, RENT_0), RENT_0)).toBeNull();
    expect(
      detectNotRentExempt({ ...fee, requireRentExempt: false }, snap(FEE, 1n), RENT_0),
    ).toBeNull();
  });
});

describe('outflow detection', () => {
  it('computes an outflow, adding the fee back for the fee payer', () => {
    const t = tx(
      's1',
      { [CASHBOX]: [5n * SOL, 4n * SOL - 5000n], [ATTACKER]: [0n, SOL] },
      {
        feePayer: CASHBOX,
      },
    );
    expect(outflowOf(t, CASHBOX)).toBe(SOL);
    // a plain fee payment is no outflow
    const feeOnly = tx('s2', { [CASHBOX]: [SOL, SOL - 5000n] }, { feePayer: CASHBOX });
    expect(outflowOf(feeOnly, CASHBOX)).toBe(0n);
  });

  it('ignores failed transactions, unrelated ones and incoming transfers', () => {
    expect(outflowOf(tx('f', { [CASHBOX]: [SOL, 0n] }, { failed: true }), CASHBOX)).toBe(0n);
    expect(outflowOf(tx('u', { [OTHER]: [SOL, 0n] }), CASHBOX)).toBe(0n);
    expect(outflowOf(tx('i', { [CASHBOX]: [0n, SOL], [OTHER]: [SOL, 0n] }), CASHBOX)).toBe(0n);
  });

  it('lists the recipients', () => {
    const t = tx('r', {
      [CASHBOX]: [SOL, 0n],
      [ATTACKER]: [0n, SOL / 2n],
      [OTHER]: [0n, SOL / 2n],
    });
    expect(recipientsOf(t, CASHBOX).sort()).toEqual([ATTACKER, OTHER].sort());
  });

  it('flags any real outflow from the vault as immediate', () => {
    const t = tx('out1', { [VAULT]: [10n * SOL, 9n * SOL], [ATTACKER]: [0n, SOL] });
    const [d] = detectOutflows(vaultAccount, [t], { toleranceLamports: 20_000n });
    expect(d?.code).toBe('UNEXPECTED_OUTFLOW');
    expect(d?.level).toBe('immediate');
    expect(d?.dedupKey).toBe('outflow:out1');
    expect(d?.details.signature).toBe('out1');
    expect(d?.details.recipients).toEqual([ATTACKER]);
  });

  it('accepts a cashbox sweep to the vault but flags a transfer to anyone else', () => {
    const sweep = tx('sweep', { [CASHBOX]: [5n * SOL, 3n * SOL], [VAULT]: [SOL, 3n * SOL] });
    const theft = tx('theft', { [CASHBOX]: [5n * SOL, 3n * SOL], [ATTACKER]: [0n, 2n * SOL] });
    const mixed = tx('mixed', {
      [CASHBOX]: [5n * SOL, 3n * SOL],
      [VAULT]: [SOL, 2n * SOL],
      [ATTACKER]: [0n, SOL],
    });
    const out = detectOutflows(cashboxAccount, [sweep, theft, mixed], {
      toleranceLamports: 20_000n,
    });
    expect(out.map((d) => d.details.signature)).toEqual(['theft', 'mixed']);
  });

  it('ignores outflows within the fee tolerance', () => {
    const dust = tx('dust', { [VAULT]: [SOL, SOL - 10_000n], [OTHER]: [0n, 10_000n] });
    expect(detectOutflows(vaultAccount, [dust], { toleranceLamports: 20_000n })).toEqual([]);
  });

  it('skips signatures registered by FORGE jobs', () => {
    const expected = createExpectedSignatures();
    expected.expect('refund1');
    const refund = tx('refund1', { [CASHBOX]: [5n * SOL, 4n * SOL], [OTHER]: [0n, SOL] });
    const out = detectOutflows(cashboxAccount, [refund], {
      toleranceLamports: 20_000n,
      isExpectedSignature: (s) => expected.has(s),
    });
    expect(out).toEqual([]);
  });

  it('flags an outflow without a visible recipient', () => {
    const burn = tx('burn', { [VAULT]: [SOL, 0n] });
    expect(detectOutflows(vaultAccount, [burn], { toleranceLamports: 0n })).toHaveLength(1);
  });
});

describe('expected signatures', () => {
  it('expire after the ttl', () => {
    let t = 0;
    const e = createExpectedSignatures(1000, () => t);
    e.expect('a');
    expect(e.has('a')).toBe(true);
    t = 1001;
    expect(e.has('a')).toBe(false);
    expect(e.has('never')).toBe(false);
  });
});

describe('detectPoolChanges', () => {
  const pool: WatchedPool = { address: 'P1', label: 'alpha', expectedCreator: 'CREATOR' };
  const ok: PoolSnapshot = { address: 'P1', exists: true, creator: 'CREATOR', isMigrated: false };

  it('is silent for a healthy pool, on first sight and after', () => {
    expect(detectPoolChanges(pool, ok, undefined)).toEqual([]);
    expect(detectPoolChanges(pool, ok, { creator: 'CREATOR', isMigrated: false })).toEqual([]);
  });

  it('flags a creator transfer immediately', () => {
    const moved = { ...ok, creator: 'THIEF' };
    const [d] = detectPoolChanges(pool, moved, { creator: 'CREATOR', isMigrated: false });
    expect(d?.code).toBe('POOL_CREATOR_CHANGED');
    expect(d?.level).toBe('immediate');
    expect(d?.details).toMatchObject({ expected: 'CREATOR', actual: 'THIEF' });
    // also on first sight, since the expected creator is known
    expect(detectPoolChanges(pool, moved, undefined)).toHaveLength(1);
  });

  it('uses the creator seen first when none is expected', () => {
    const open: WatchedPool = { address: 'P1', label: 'alpha' };
    expect(detectPoolChanges(open, ok, undefined)).toEqual([]);
    const moved = { ...ok, creator: 'THIEF' };
    expect(detectPoolChanges(open, moved, { creator: 'CREATOR', isMigrated: false })[0]?.code).toBe(
      'POOL_CREATOR_CHANGED',
    );
  });

  it('flags graduation only on the transition', () => {
    const grad = { ...ok, isMigrated: true };
    expect(detectPoolChanges(pool, grad, { creator: 'CREATOR', isMigrated: false })[0]?.code).toBe(
      'POOL_MIGRATED',
    );
    expect(detectPoolChanges(pool, grad, { creator: 'CREATOR', isMigrated: true })).toEqual([]);
    expect(detectPoolChanges(pool, grad, undefined)).toEqual([]);
  });

  it('flags a pool that disappeared, but not one never seen', () => {
    const gone: PoolSnapshot = { address: 'P1', exists: false, creator: '', isMigrated: false };
    expect(detectPoolChanges(pool, gone, { creator: 'CREATOR', isMigrated: false })[0]?.code).toBe(
      'POOL_MISSING',
    );
    expect(detectPoolChanges(pool, gone, undefined)).toEqual([]);
  });
});

describe('RPC streak and backoff', () => {
  it('alerts at the threshold only', () => {
    expect(detectRpcErrorStreak(4, 5, 'x')).toBeNull();
    expect(detectRpcErrorStreak(5, 5, 'TypeError')?.level).toBe('high');
  });

  it('backs off exponentially up to the cap', () => {
    const c = { intervalMs: 1000, maxBackoffMs: 10_000 };
    const mid = () => 0.5; // no jitter
    expect(nextDelayMs(c, 0, mid)).toBe(1000);
    expect(nextDelayMs(c, 1, mid)).toBe(2000);
    expect(nextDelayMs(c, 3, mid)).toBe(8000);
    expect(nextDelayMs(c, 4, mid)).toBe(10_000);
    expect(nextDelayMs(c, 50, mid)).toBe(10_000);
    expect(nextDelayMs(c, 0, () => 0)).toBe(900);
    expect(nextDelayMs(c, 0, () => 1)).toBe(1100);
  });
});

describe('state serialization', () => {
  it('round-trips', () => {
    const s = createWatchState();
    s.outflowCursor.set(VAULT, 'sig');
    s.pools.set('P1', { creator: 'C', isMigrated: true });
    const back = importWatchState(JSON.parse(JSON.stringify(exportWatchState(s))));
    expect(back.outflowCursor.get(VAULT)).toBe('sig');
    expect(back.pools.get('P1')).toEqual({ creator: 'C', isMigrated: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Cycle with a fake RPC

interface FakeChain {
  accounts: Map<string, AccountSnapshot>;
  pools: Map<string, PoolSnapshot>;
  /** newest first */
  signatures: Map<string, string[]>;
  txs: Map<string, TxLite>;
  failAll: boolean;
  failTx: Set<string>;
}

function makeChain(): FakeChain {
  return {
    accounts: new Map(),
    pools: new Map(),
    signatures: new Map(),
    txs: new Map(),
    failAll: false,
    failTx: new Set(),
  };
}

function makeRpc(chain: FakeChain): WatchRpc {
  const guard = () => {
    if (chain.failAll) throw new TypeError('network down');
  };
  return {
    async getAccounts(addresses) {
      guard();
      return addresses.map((a) => chain.accounts.get(a) ?? null);
    },
    async getRentExemptMinimum(len) {
      guard();
      return len === 0 ? RENT_0 : 2_039_280n;
    },
    async getSignatures(address, opts) {
      guard();
      const all = chain.signatures.get(address) ?? [];
      const stop = opts.until ? all.indexOf(opts.until) : -1;
      const fresh = stop >= 0 ? all.slice(0, stop) : all;
      return fresh.slice(0, opts.limit).map((signature) => ({ signature, failed: false }));
    },
    async getTransaction(signature) {
      guard();
      if (chain.failTx.has(signature)) throw new TypeError('rpc error');
      return chain.txs.get(signature) ?? null;
    },
    async getPools(addresses) {
      guard();
      return addresses.map(
        (a) => chain.pools.get(a) ?? { address: a, exists: false, creator: '', isMigrated: false },
      );
    },
    async getTokenAccounts() {
      guard();
      return [];
    },
  };
}

function makeDeps(
  chain: FakeChain,
  targets: WatchTargets,
  overrides: Partial<WatchDeps> = {},
): { deps: WatchDeps; alerts: ReturnType<typeof vi.fn> } {
  const alerts = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
  const alerter: Alerter = { alert: alerts as unknown as Alerter['alert'] };
  const deps: WatchDeps = {
    rpc: makeRpc(chain),
    targets: { load: async () => targets },
    alerter,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config,
    state: createWatchState(),
    ...overrides,
  };
  return { deps, alerts };
}

describe('runWatchCycle', () => {
  const targets: WatchTargets = {
    accounts: [
      vaultAccount,
      cashboxAccount,
      { address: FEE, label: 'platform fee wallet', role: 'platformFee', requireRentExempt: true },
    ],
    pools: [{ address: 'P1', label: 'alpha', expectedCreator: 'CREATOR' }],
  };

  function healthyChain(): FakeChain {
    const chain = makeChain();
    chain.accounts.set(VAULT, snap(VAULT, 50n * SOL));
    chain.accounts.set(CASHBOX, snap(CASHBOX, 3n * SOL));
    chain.accounts.set(FEE, snap(FEE, RENT_0));
    chain.pools.set('P1', { address: 'P1', exists: true, creator: 'CREATOR', isMigrated: false });
    chain.signatures.set(VAULT, ['v0']);
    chain.signatures.set(CASHBOX, ['c0']);
    return chain;
  }

  it('raises nothing on a healthy system and sets cursors silently', async () => {
    const chain = healthyChain();
    const { deps, alerts } = makeDeps(chain, targets);
    const r = await runWatchCycle(deps);
    expect(r.detections).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(alerts).not.toHaveBeenCalled();
    expect(deps.state.outflowCursor.get(VAULT)).toBe('v0');
  });

  it('alerts on low balance, rent, outflow, creator change and migration across cycles', async () => {
    const chain = healthyChain();
    const { deps, alerts } = makeDeps(chain, targets);
    await runWatchCycle(deps);

    chain.accounts.set(CASHBOX, snap(CASHBOX, SOL / 10n));
    chain.accounts.set(FEE, snap(FEE, 100_000n));
    chain.signatures.set(VAULT, ['v1', 'v0']);
    chain.txs.set('v1', tx('v1', { [VAULT]: [50n * SOL, 49n * SOL], [ATTACKER]: [0n, SOL] }));
    chain.pools.set('P1', { address: 'P1', exists: true, creator: 'THIEF', isMigrated: true });

    const r = await runWatchCycle(deps);
    const codes = r.detections.map((d) => d.code).sort();
    expect(codes).toEqual(
      [
        'LOW_BALANCE',
        'NOT_RENT_EXEMPT',
        'POOL_CREATOR_CHANGED',
        'POOL_MIGRATED',
        'UNEXPECTED_OUTFLOW',
      ].sort(),
    );
    expect(alerts).toHaveBeenCalledTimes(5);
    const immediate = alerts.mock.calls.filter((c) => c[0] === 'immediate').map((c) => c[1]);
    expect(immediate.sort()).toEqual(['POOL_CREATOR_CHANGED', 'UNEXPECTED_OUTFLOW']);
    expect(deps.state.outflowCursor.get(VAULT)).toBe('v1');
    // the reference creator did not follow the thief
    expect(deps.state.pools.get('P1')?.creator).toBe('CREATOR');
  });

  it('does not alert twice for the same outflow', async () => {
    const chain = healthyChain();
    const { deps } = makeDeps(chain, targets);
    await runWatchCycle(deps);
    chain.signatures.set(VAULT, ['v1', 'v0']);
    chain.txs.set('v1', tx('v1', { [VAULT]: [50n * SOL, 49n * SOL], [ATTACKER]: [0n, SOL] }));
    expect((await runWatchCycle(deps)).detections).toHaveLength(1);
    expect((await runWatchCycle(deps)).detections).toHaveLength(0);
  });

  it('ignores outflows registered as expected', async () => {
    const chain = healthyChain();
    const expected = createExpectedSignatures();
    const { deps } = makeDeps(chain, targets, { expected });
    await runWatchCycle(deps);
    chain.signatures.set(CASHBOX, ['c1', 'c0']);
    chain.txs.set('c1', tx('c1', { [CASHBOX]: [3n * SOL, 2n * SOL], [OTHER]: [0n, SOL] }));
    expected.expect('c1');
    const r = await runWatchCycle(deps);
    expect(r.detections.map((d) => d.code)).toEqual([]);
  });

  it('counts a failed cycle, alerts at the streak, and resets on success', async () => {
    const chain = healthyChain();
    const { deps, alerts } = makeDeps(chain, targets, {
      config: { ...config, rpcErrorStreak: 2 },
    });
    chain.failAll = true;
    const first = await runWatchCycle(deps);
    expect(first.errors.length).toBeGreaterThan(0);
    expect(deps.state.rpcErrorStreak).toBe(1);
    expect(alerts).not.toHaveBeenCalled();
    await runWatchCycle(deps);
    expect(alerts.mock.calls.map((c) => c[1])).toEqual(['RPC_ERRORS']);
    chain.failAll = false;
    await runWatchCycle(deps);
    expect(deps.state.rpcErrorStreak).toBe(0);
  });

  it('keeps the cursor before a transaction it could not read and retries it', async () => {
    const chain = healthyChain();
    const { deps } = makeDeps(chain, targets);
    await runWatchCycle(deps);
    chain.signatures.set(VAULT, ['v2', 'v1', 'v0']);
    chain.txs.set('v1', tx('v1', { [VAULT]: [50n * SOL, 49n * SOL], [ATTACKER]: [0n, SOL] }));
    chain.txs.set('v2', tx('v2', { [VAULT]: [49n * SOL, 48n * SOL], [ATTACKER]: [0n, SOL] }));
    chain.failTx.add('v2');
    const r1 = await runWatchCycle(deps);
    expect(r1.errors).toHaveLength(1);
    expect(r1.detections.map((d) => d.details.signature)).toEqual(['v1']);
    expect(deps.state.outflowCursor.get(VAULT)).toBe('v1');
    chain.failTx.clear();
    const r2 = await runWatchCycle(deps);
    expect(r2.detections.map((d) => d.details.signature)).toEqual(['v2']);
    expect(deps.state.outflowCursor.get(VAULT)).toBe('v2');
  });

  it('warns when a cycle hits the signature limit', async () => {
    const chain = healthyChain();
    const { deps } = makeDeps(chain, targets, { config: { ...config, signatureLimit: 2 } });
    await runWatchCycle(deps);
    chain.signatures.set(VAULT, ['v2', 'v1', 'v0']);
    chain.txs.set('v1', tx('v1', { [VAULT]: [1n, 1n] }));
    chain.txs.set('v2', tx('v2', { [VAULT]: [1n, 1n] }));
    const r = await runWatchCycle(deps);
    expect(r.detections.map((d) => d.code)).toContain('OUTFLOW_BACKLOG');
  });

  it('survives a failing target source and still counts the failure', async () => {
    const chain = healthyChain();
    const { deps } = makeDeps(chain, targets, {
      targets: {
        load: async () => {
          throw new TypeError('supabase down');
        },
      },
    });
    const r = await runWatchCycle(deps);
    expect(r.errors).toEqual(['targets: TypeError']);
    expect(deps.state.rpcErrorStreak).toBe(1);
  });

  it('never includes a secret in an alert', async () => {
    const chain = healthyChain();
    const { deps, alerts } = makeDeps(chain, targets);
    await runWatchCycle(deps);
    chain.accounts.set(CASHBOX, snap(CASHBOX, 0n));
    await runWatchCycle(deps);
    expect(JSON.stringify(alerts.mock.calls)).not.toMatch(/secret|passphrase|private/i);
  });

  it('alerts when a tracked pool row disappears from the database, not when the database is unreachable', async () => {
    const chain = healthyChain();
    let rows: WatchTargets = targets;
    let down = false;
    const { deps, alerts } = makeDeps(chain, targets, {
      targets: {
        load: async () => {
          if (down) throw new TypeError('supabase down');
          return rows;
        },
      },
    });
    await runWatchCycle(deps);
    expect(deps.state.pools.has('P1')).toBe(true);

    down = true;
    expect((await runWatchCycle(deps)).detections.map((d) => d.code)).not.toContain(
      'POOL_ROW_MISSING',
    );
    down = false;
    rows = { ...targets, pools: [] };
    const r = await runWatchCycle(deps);
    expect(r.detections.map((d) => d.code)).toEqual(['POOL_ROW_MISSING']);
    expect(alerts.mock.calls.map((c) => [c[0], c[1]])).toContainEqual(['high', 'POOL_ROW_MISSING']);
    // The memory stays, reference creator included: the row coming back with a moved creator is
    // still caught against the original reference.
    expect(deps.state.pools.get('P1')?.creator).toBe('CREATOR');
    rows = targets;
    chain.pools.set('P1', { address: 'P1', exists: true, creator: 'THIEF', isMigrated: false });
    expect((await runWatchCycle(deps)).detections.map((d) => d.code)).toEqual([
      'POOL_CREATOR_CHANGED',
    ]);
  });

  it('flags an outflow from the payer wallet unless the signer announced it, and a bot return to the vault never', async () => {
    const chain = healthyChain();
    chain.accounts.set(PAYER, snap(PAYER, 5n * SOL));
    chain.accounts.set(BOT, snap(BOT, SOL));
    chain.signatures.set(PAYER, ['p0']);
    chain.signatures.set(BOT, ['b0']);
    const expected = createExpectedSignatures();
    const staticAccounts = buildStaticAccounts(
      { vault: VAULT, platformFee: FEE, cashbox: CASHBOX, payer: PAYER, buyback: BOT },
      config,
    );
    const { deps } = makeDeps(chain, { accounts: [], pools: [] }, { staticAccounts, expected });
    expect((await runWatchCycle(deps)).detections).toEqual([]);

    chain.signatures.set(PAYER, ['p2', 'p1', 'p0']);
    // p1: a config creation paid by the payer, announced before its broadcast.
    chain.txs.set('p1', tx('p1', { [PAYER]: [5n * SOL, 4n * SOL], [OTHER]: [0n, SOL] }));
    expected.expect('p1');
    // p2: nobody announced it.
    chain.txs.set('p2', tx('p2', { [PAYER]: [4n * SOL, 3n * SOL], [ATTACKER]: [0n, SOL] }));
    chain.signatures.set(BOT, ['b1', 'b0']);
    chain.txs.set('b1', tx('b1', { [BOT]: [SOL, 0n], [VAULT]: [50n * SOL, 51n * SOL] }));

    const r = await runWatchCycle(deps);
    const outflows = r.detections.filter((d) => d.code === 'UNEXPECTED_OUTFLOW');
    expect(outflows.map((d) => d.details.signature)).toEqual(['p2']);
    expect(outflows[0]!.details).toMatchObject({ role: 'payer', account: PAYER });
    expect(outflows[0]!.level).toBe('immediate');
  });
});

describe('startWatch', () => {
  it('runs cycles with the computed delay and stops cleanly', async () => {
    const chain = makeChain();
    const { deps } = makeDeps(chain, { accounts: [], pools: [] });
    const delays: number[] = [];
    let cycles = 0;
    const handle = startWatch(
      deps,
      async (ms) => {
        delays.push(ms);
        cycles += 1;
        if (cycles === 3) handle.stop();
      },
      () => 0.5,
    );
    await handle.done;
    expect(delays).toEqual([60_000, 60_000, 60_000]);
  });

  it('backs off while cycles fail', async () => {
    const chain = makeChain();
    chain.failAll = true;
    const { deps } = makeDeps(chain, {
      accounts: [{ address: VAULT, label: 'v', role: 'vault', minLamports: 1n }],
      pools: [],
    });
    const delays: number[] = [];
    const handle = startWatch(
      deps,
      async (ms) => {
        delays.push(ms);
        if (delays.length === 3) handle.stop();
      },
      () => 0.5,
    );
    await handle.done;
    expect(delays).toEqual([120_000, 240_000, 480_000]);
  });
});

// ---------------------------------------------------------------------------------------------
// Supabase source

describe('createSupabaseTargetSource', () => {
  const mintA = Keypair.generate().publicKey.toBase58();
  const cfgA = Keypair.generate().publicKey.toBase58();
  const mintB = Keypair.generate().publicKey.toBase58();
  const cfgB = Keypair.generate().publicKey.toBase58();
  const creatorA = Keypair.generate().publicKey.toBase58();

  it('derives pools and creator wallets from launchpad rows', async () => {
    const rows = [
      {
        slug: 'alpha',
        launchpad_coin_mint: mintA,
        launchpad_coin_config: cfgA,
        creator_wallet_ref: 'creator-1',
      },
      {
        slug: 'beta',
        launchpad_coin_mint: mintB,
        launchpad_coin_config: cfgB,
        creator_wallet_ref: null,
      },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }));
    const derive = vi.fn((mint: PublicKey) => mint);
    const source = createSupabaseTargetSource({
      supabaseUrl: 'https://db.example.test/',
      serviceRoleKey: 'service-role-secret',
      fetch: fetchMock as unknown as typeof fetch,
      derivePoolAddress: derive,
      resolveCreator: async (ref) => (ref === 'creator-1' ? creatorA : undefined),
      config,
    });
    const targets = await source.load();
    expect(targets.pools).toEqual([
      { address: mintA, label: 'alpha', expectedCreator: creatorA },
      { address: mintB, label: 'beta' },
    ]);
    expect(targets.accounts.map((a) => a.address)).toEqual([creatorA]);
    expect(targets.accounts[0]?.role).toBe('creator');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('https://db.example.test/rest/v1/launchpads?select=');
    expect(url).toContain('launchpad_coin_mint=not.is.null');
    expect((init.headers as Record<string, string>).apikey).toBe('service-role-secret');
  });

  it('fails loudly on an HTTP error and on a malformed answer', async () => {
    const make = (res: () => Response) =>
      createSupabaseTargetSource({
        supabaseUrl: 'https://db.example.test',
        serviceRoleKey: 'k',
        fetch: (async () => res()) as unknown as typeof fetch,
        derivePoolAddress: (m) => m,
        resolveCreator: async () => undefined,
        config,
      });
    await expect(make(() => new Response('no', { status: 500 })).load()).rejects.toThrow(/500/);
    await expect(make(() => new Response('{"a":1}', { status: 200 })).load()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Announced signatures: durable before the broadcast, loaded at start

describe('expected signature log', () => {
  async function tmp(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'forge-expected-'));
  }
  const DAY = 24 * 60 * 60_000;

  function payerChain(): FakeChain {
    const chain = makeChain();
    chain.accounts.set(VAULT, snap(VAULT, 50n * SOL));
    chain.accounts.set(FEE, snap(FEE, RENT_0));
    chain.accounts.set(CASHBOX, snap(CASHBOX, 3n * SOL));
    chain.accounts.set(PAYER, snap(PAYER, 5n * SOL));
    chain.signatures.set(VAULT, ['v0']);
    chain.signatures.set(CASHBOX, ['c0']);
    chain.signatures.set(PAYER, ['p0']);
    return chain;
  }
  const payerAccounts = () =>
    buildStaticAccounts({ vault: VAULT, platformFee: FEE, cashbox: CASHBOX, payer: PAYER }, config);

  it('appends each announced signature before expect() returns and loads them back', async () => {
    const dir = await tmp();
    try {
      let t = 1_000;
      const log = createExpectedSignatureLog(dir, { now: () => t });
      const expected = createExpectedSignatures(DAY, () => t, log);
      expected.expect('sig1');
      t = 2_000;
      expected.expect('sig2');
      expect(await fs.readFile(path.join(dir, EXPECTED_SIGNATURE_LOG_FILE), 'utf8')).toBe(
        '1000 sig1\n2000 sig2\n',
      );
      // A restart: a fresh set knows nothing until the log is loaded.
      const fresh = createExpectedSignatures(DAY, () => t, log);
      expect(fresh.has('sig1')).toBe(false);
      fresh.restore(log.load());
      expect(fresh.has('sig1')).toBe(true);
      expect(fresh.has('sig2')).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('is empty without a file, skips malformed lines and drops expired entries at load', async () => {
    const dir = await tmp();
    try {
      let t = 10 * DAY;
      const log = createExpectedSignatureLog(dir, { ttlMs: DAY, now: () => t });
      expect(log.load()).toEqual([]);
      const file = path.join(dir, EXPECTED_SIGNATURE_LOG_FILE);
      await fs.writeFile(
        file,
        `${t - DAY - 1} old\n${t - DAY} edge\ngarbage line\n\n${t} two words\n${t} fresh\r\n`,
      );
      expect(log.load()).toEqual([
        { at: t - DAY, signature: 'edge' },
        { at: t, signature: 'fresh' },
      ]);
      // Compacted on disk too.
      expect(await fs.readFile(file, 'utf8')).toBe(`${t - DAY} edge\n${t} fresh\n`);
      t += DAY + 1;
      expect(log.load()).toEqual([]);
      expect(await fs.readFile(file, 'utf8')).toBe('');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('prunes the expired entries once the file grows past the bound, and never grows unbounded', async () => {
    const dir = await tmp();
    try {
      let t = 0;
      const log = createExpectedSignatureLog(dir, { ttlMs: 1_000, maxBytes: 200, now: () => t });
      const file = path.join(dir, EXPECTED_SIGNATURE_LOG_FILE);
      for (let i = 0; i < 20; i++) {
        t = i * 100;
        log.append({ signature: `signature-${String(i).padStart(3, '0')}`, at: t });
      }
      const content = await fs.readFile(file, 'utf8');
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(200);
      // The newest entry is always kept; the expired ones (older than 1 s) are gone.
      expect(content).toContain('signature-019');
      expect(content).not.toContain('signature-000');
      expect(log.load().every((e) => t - e.at <= 1_000)).toBe(true);
      // No temp file left behind.
      expect((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an invalid signature and a directory it cannot write, so nothing is broadcast', async () => {
    const dir = await tmp();
    try {
      const log = createExpectedSignatureLog(dir);
      expect(() => log.append({ signature: 'two words', at: 1 })).toThrow(/invalid signature/);
      expect(() => log.append({ signature: '', at: 1 })).toThrow(/invalid signature/);
      // A file where the directory should be: the append cannot create the log.
      const blocked = path.join(dir, 'blocked');
      await fs.writeFile(blocked, 'not a directory');
      const broken = createExpectedSignatureLog(blocked);
      const expected = createExpectedSignatures(DAY, Date.now, broken);
      expect(() => expected.expect('sig')).toThrow();
      expect(expected.has('sig')).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not flag a payer spend announced before a restart that lost the state save', async () => {
    const dir = await tmp();
    try {
      const chain = payerChain();
      const staticAccounts = payerAccounts();
      const journal = createMemoryJournal(SerializedWatchState);
      const log = createExpectedSignatureLog(dir);

      // First life: a cycle saves the state, then a config creation is announced and sent...
      const before = createExpectedSignatures(DAY, Date.now, log);
      const first = makeDeps(chain, { accounts: [], pools: [] }, {
        staticAccounts,
        expected: before,
        journal,
        expectedLog: log,
      });
      await restoreWatchState(first.deps);
      expect((await runWatchCycle(first.deps)).detections).toEqual([]);
      before.expect('p1');
      chain.signatures.set(PAYER, ['p1', 'p0']);
      chain.txs.set('p1', tx('p1', { [PAYER]: [5n * SOL, 4n * SOL], [OTHER]: [0n, SOL] }));
      // ...and the signer dies before the next cycle saves the state with that signature.

      // Second life: a fresh set, the state of the first cycle, the log.
      const after = createExpectedSignatures(DAY, Date.now, log);
      const second = makeDeps(chain, { accounts: [], pools: [] }, {
        staticAccounts,
        expected: after,
        journal,
        expectedLog: log,
      });
      await restoreWatchState(second.deps);
      expect(after.has('p1')).toBe(true);
      const r = await runWatchCycle(second.deps);
      expect(r.detections.filter((d) => d.code === 'UNEXPECTED_OUTFLOW')).toEqual([]);
      expect(second.alerts).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('alerts once when the log cannot be read, and the watcher still starts', async () => {
    const dir = await tmp();
    try {
      const journal = createMemoryJournal(SerializedWatchState);
      const log = createExpectedSignatureLog(dir);
      await fs.mkdir(path.join(dir, EXPECTED_SIGNATURE_LOG_FILE)); // a directory, not a file
      const { deps, alerts } = makeDeps(makeChain(), { accounts: [], pools: [] }, {
        expected: createExpectedSignatures(),
        journal,
        expectedLog: log,
      });
      expect(await restoreWatchState(deps)).toBe(false);
      expect(alerts.mock.calls.map((c) => c[1])).toEqual(['WATCH_EXPECTED_LOG_UNREADABLE']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('lets the payer forward SOL to the vault (claims it pays for) without an alert', async () => {
    const chain = payerChain();
    const { deps } = makeDeps(chain, { accounts: [], pools: [] }, { staticAccounts: payerAccounts() });
    expect((await runWatchCycle(deps)).detections).toEqual([]);
    chain.signatures.set(PAYER, ['p2', 'p1', 'p0']);
    // p1: nobody announced it, but every lamport went to the vault.
    chain.txs.set('p1', tx('p1', { [PAYER]: [5n * SOL, 4n * SOL], [VAULT]: [50n * SOL, 51n * SOL] }));
    // p2: part of it went elsewhere.
    chain.txs.set(
      'p2',
      tx('p2', {
        [PAYER]: [4n * SOL, 2n * SOL],
        [VAULT]: [51n * SOL, 52n * SOL],
        [ATTACKER]: [0n, SOL],
      }),
    );
    const r = await runWatchCycle(deps);
    const outflows = r.detections.filter((d) => d.code === 'UNEXPECTED_OUTFLOW');
    expect(outflows.map((d) => d.details.signature)).toEqual(['p2']);
  });
});
