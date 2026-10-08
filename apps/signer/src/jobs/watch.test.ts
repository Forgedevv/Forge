/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { Alerter } from '../alerts.js';
import {
  buildCreatorAccounts,
  buildStaticAccounts,
  createExpectedSignatures,
  createSupabaseTargetSource,
  createWatchState,
  detectLowBalance,
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
      staticAccounts: [vaultAccount],
    });
    const targets = await source.load();
    expect(targets.pools).toEqual([
      { address: mintA, label: 'alpha', expectedCreator: creatorA },
      { address: mintB, label: 'beta' },
    ]);
    expect(targets.accounts.map((a) => a.address)).toEqual([VAULT, creatorA]);
    expect(targets.accounts[1]?.role).toBe('creator');
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
        staticAccounts: [],
      });
    await expect(make(() => new Response('no', { status: 500 })).load()).rejects.toThrow(/500/);
    await expect(make(() => new Response('{"a":1}', { status: 200 })).load()).rejects.toThrow();
  });
});
