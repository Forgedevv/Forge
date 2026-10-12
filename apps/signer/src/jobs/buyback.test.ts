import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openKeystore, type Keystore } from '../keystore.js';
import {
  BUYBACK_FLAG,
  BuybackJournalEntry,
  DAY_MS,
  INFLIGHT_KEY,
  MAX_BUYBACK_SLIPPAGE_BPS,
  RETURN_MEMO,
  assertForgeReturnTx,
  buildForgeReturnTx,
  buybackConfigFromEnv,
  committedLamports,
  compareBuybackStates,
  createBuybackJob,
  createJupiterBuybackClient,
  createRpcBuybackSwapPreparer,
  dayJournalKey,
  planDay,
  resolveBuybackMode,
  utcDay,
  validateBuyQuote,
  type BuybackConfig,
  type BuybackDayEntry,
  type BuybackDeps,
  type BuybackQuoteSource,
  type BuybackSwapPreparer,
  type BuyExpectation,
  type ForgeTokenReader,
  type Rng,
  type SpendingLimitWithdrawer,
} from './buyback.js';
import {
  JUPITER_PROGRAM_ID,
  WSOL_MINT,
  type AccountDelta,
  type JupiterQuote,
  type SwapConnection,
} from './convert.js';
import {
  Mutex,
  base58Encode,
  createMemoryJournal,
  type KeystoreLike,
  type RecentSignature,
  type SignatureLookup,
  type SolanaRpc,
} from './shared.js';
import { RecordingAlerter, RecordingLogger, memoryFlags, randomAddress } from './testing.js';

const SOL = 1_000_000_000n;
const DAY_START = Date.UTC(2026, 9, 11);
const DAY = utcDay(DAY_START);
const FORGE = randomAddress();
const VAULT = randomAddress();

/** Deterministic RNG (mulberry32). */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseConfig(over: Partial<BuybackConfig> = {}): BuybackConfig {
  return {
    cluster: 'devnet',
    live: false,
    forgeMint: FORGE,
    vault: VAULT,
    dailyCapLamports: 1n * SOL,
    ordersPerDay: 6,
    minOrderLamports: 50_000_000n,
    maxOrderLamports: 300_000_000n,
    slippageBps: 50,
    maxPriceImpactBps: 100,
    feeReserveLamports: 20_000_000n,
    maxLatenessMs: 30 * 60_000,
    dayMarginMs: 10 * 60_000,
    maxPriorityFeeLamports: 100_000n,
    settle: { timeoutMs: 10_000, pollMs: 1_000, rebroadcastMs: 3_000 },
    ...over,
  };
}

function buyQuote(lamports: bigint, over: Partial<Record<keyof JupiterQuote, unknown>> = {}) {
  return {
    inputMint: WSOL_MINT,
    outputMint: FORGE.toBase58(),
    inAmount: lamports.toString(),
    outAmount: '1000000',
    otherAmountThreshold: '995000',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0.001',
    routePlan: [],
    ...over,
  } as JupiterQuote;
}

class Clock {
  constructor(public t: number) {}
  readonly now = () => this.t;
}

// ---------------------------------------------------------------------------------------
// Mode and configuration

describe('resolveBuybackMode', () => {
  const full = { cluster: 'mainnet-beta', live: true, forgeMint: FORGE, hasWithdrawer: true };
  it('is live only with mainnet-beta, the flag, the mint and a withdrawer', () => {
    expect(resolveBuybackMode(full).mode).toBe('live');
  });
  it.each([
    [{ cluster: 'devnet' }, false],
    [{ cluster: undefined }, false],
    [{ live: false }, false],
    [{ forgeMint: null }, false],
    [{ hasWithdrawer: false }, true],
  ])('is simulation for %o (live requested: %s)', (over, requested) => {
    const d = resolveBuybackMode({ ...full, ...over });
    expect(d.mode).toBe('simulation');
    expect(d.liveRequested).toBe(requested);
  });
});

describe('buybackConfigFromEnv', () => {
  const addresses = { vault: VAULT, forgeMint: FORGE };
  it('has safe defaults: simulation, nothing bought, slippage within 1%', () => {
    const { config, tickMs } = buybackConfigFromEnv({}, addresses);
    expect(config.live).toBe(false);
    expect(config.dailyCapLamports).toBe(0n);
    expect(config.slippageBps).toBeLessThanOrEqual(MAX_BUYBACK_SLIPPAGE_BPS);
    expect(config.paused).toBe(false);
    expect(tickMs).toBe(60_000);
  });
  it('refuses a slippage above 100 bps and malformed values', () => {
    expect(() => buybackConfigFromEnv({ BUYBACK_SLIPPAGE_BPS: '101' }, addresses)).toThrow(
      /too large/,
    );
    expect(() => buybackConfigFromEnv({ FORGE_BUYBACK_LIVE: 'yes' }, addresses)).toThrow(
      /FORGE_BUYBACK_LIVE/,
    );
    expect(() =>
      buybackConfigFromEnv(
        { BUYBACK_MIN_ORDER_LAMPORTS: '100', BUYBACK_MAX_ORDER_LAMPORTS: '50' },
        addresses,
      ),
    ).toThrow(/MAX_ORDER/);
    expect(() => buybackConfigFromEnv({ BUYBACK_DAILY_CAP_LAMPORTS: '1.5' }, addresses)).toThrow();
    expect(() => buybackConfigFromEnv({ JUPITER_API_URL: 'http://x.test' }, addresses)).toThrow(
      /https/,
    );
  });
  it('reads the live flag strictly', () => {
    expect(buybackConfigFromEnv({ FORGE_BUYBACK_LIVE: 'true' }, addresses).config.live).toBe(true);
    expect(buybackConfigFromEnv({ FORGE_BUYBACK_LIVE: 'false' }, addresses).config.live).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------------------
// Schedule

describe('planDay', () => {
  const input = {
    dayStartMs: DAY_START,
    budgetLamports: 1n * SOL,
    orders: 8,
    minOrderLamports: 50_000_000n,
    maxOrderLamports: 300_000_000n,
    marginMs: 10 * 60_000,
  };

  it('keeps every slot inside its own segment of the day, sorted, away from midnight', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const slots = planDay({ ...input, rng: seeded(seed) });
      expect(slots).toHaveLength(8);
      const segment = Math.floor((DAY_MS - 2 * input.marginMs) / 8);
      slots.forEach((s, i) => {
        const lo = DAY_START + input.marginMs + i * segment;
        expect(s.at).toBeGreaterThanOrEqual(lo);
        expect(s.at).toBeLessThan(lo + segment);
        expect(s.at).toBeLessThan(DAY_START + DAY_MS - input.marginMs);
        if (i > 0) expect(s.at).toBeGreaterThan(slots[i - 1]!.at);
      });
    }
  });

  it('keeps amounts within the order bounds and the total within the budget', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const slots = planDay({ ...input, rng: seeded(seed) });
      const total = slots.reduce((a, s) => a + s.lamports, 0n);
      expect(total).toBeLessThanOrEqual(input.budgetLamports);
      for (const s of slots) {
        expect(s.lamports).toBeGreaterThanOrEqual(input.minOrderLamports);
        expect(s.lamports).toBeLessThanOrEqual(input.maxOrderLamports);
      }
      // Never a predictable amount: the orders differ from each other.
      expect(new Set(slots.map((s) => s.lamports)).size).toBeGreaterThan(1);
    }
  });

  it('caps the large orders at the maximum and never exceeds the budget', () => {
    const slots = planDay({ ...input, orders: 2, budgetLamports: 10n * SOL, rng: seeded(3) });
    expect(slots.map((s) => s.lamports)).toEqual([300_000_000n, 300_000_000n]);
  });

  it('is deterministic for a given RNG and differs across seeds', () => {
    const a = planDay({ ...input, rng: seeded(42) });
    expect(planDay({ ...input, rng: seeded(42) })).toEqual(a);
    expect(planDay({ ...input, rng: seeded(43) })).not.toEqual(a);
  });

  it('places fewer orders when the budget only covers a few minimum orders', () => {
    expect(planDay({ ...input, budgetLamports: 120_000_000n, rng: seeded(1) })).toHaveLength(2);
    expect(planDay({ ...input, budgetLamports: 49_999_999n, rng: seeded(1) })).toEqual([]);
    expect(planDay({ ...input, budgetLamports: 0n, rng: seeded(1) })).toEqual([]);
  });

  it('refuses a broken random source', () => {
    expect(() => planDay({ ...input, rng: () => 1 })).toThrow(/random/);
    expect(() => planDay({ ...input, rng: () => Number.NaN })).toThrow(/random/);
  });
});

// ---------------------------------------------------------------------------------------
// Quote validation

describe('validateBuyQuote', () => {
  const req = { forgeMint: FORGE.toBase58(), lamports: 100n };
  const limits = { maxSlippageBps: 50, maxPriceImpactBps: 100 };
  it('accepts a good quote', () => {
    expect(validateBuyQuote(buyQuote(100n), req, limits)).toBeNull();
  });
  it.each([
    ['input_not_sol', { inputMint: FORGE.toBase58() }],
    ['output_mint_mismatch', { outputMint: randomAddress().toBase58() }],
    ['amount_mismatch', { inAmount: '99' }],
    ['not_exact_in', { swapMode: 'ExactOut' }],
    ['slippage_too_high', { slippageBps: 51 }],
    // The quote claims 50 bps but its guaranteed minimum is 2% below the output.
    ['slippage_too_high', { otherAmountThreshold: '980000' }],
    ['price_impact_too_high', { priceImpactPct: '0.011' }],
    ['invalid_price_impact', { priceImpactPct: 'NaN' }],
    ['zero_output', { outAmount: '0', otherAmountThreshold: '0' }],
    ['threshold_inconsistent', { otherAmountThreshold: '1000001' }],
  ])('rejects: %s', (reason, over) => {
    expect(validateBuyQuote(buyQuote(100n, over), req, limits)).toBe(reason);
  });
  it('never accepts more than 1% slippage whatever the configuration says', () => {
    const q = buyQuote(100n, { slippageBps: 150, otherAmountThreshold: '985000' });
    expect(validateBuyQuote(q, req, { maxSlippageBps: 500, maxPriceImpactBps: 100 })).toBe(
      'slippage_too_high',
    );
  });
});

// ---------------------------------------------------------------------------------------
// Simulation check

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, lamports = 2_039_280n) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return { owner: TOKEN_PROGRAM_ID.toBase58(), lamports, data };
}

describe('compareBuybackStates', () => {
  const bot = Keypair.generate().publicKey;
  const forgeAta = getAssociatedTokenAddressSync(FORGE, bot, true, TOKEN_PROGRAM_ID);
  const expected = {
    forgeMint: FORGE.toBase58(),
    inLamports: 100_000_000n,
    minOutAmount: 995_000n,
  };
  const wallet = (lamports: bigint) => ({
    owner: SystemProgram.programId.toBase58(),
    lamports,
    data: Buffer.alloc(0),
  });

  function good(): AccountDelta[] {
    return [
      {
        address: bot.toBase58(),
        pre: wallet(SOL),
        post: wallet(SOL - 100_000_000n - 2_039_280n - 5_000n),
      },
      { address: forgeAta.toBase58(), pre: null, post: tokenAccount(FORGE, bot, 1_000_000n) },
    ];
  }

  it('accepts a buy that spends at most the quoted SOL and receives at least the minimum', () => {
    expect(compareBuybackStates(bot.toBase58(), expected, 10_000n, good())).toBeNull();
  });

  it('refuses a swap that pays out another mint', () => {
    const other = randomAddress();
    const otherAta = getAssociatedTokenAddressSync(other, bot, true, TOKEN_PROGRAM_ID);
    const deltas: AccountDelta[] = [
      good()[0]!,
      { address: otherAta.toBase58(), pre: null, post: tokenAccount(other, bot, 1_000_000n) },
    ];
    expect(compareBuybackStates(bot.toBase58(), expected, 10_000n, deltas)).toBe(
      'token_account_changed',
    );
    // Same with an existing account of another mint growing.
    const existing: AccountDelta[] = [
      good()[0]!,
      {
        address: otherAta.toBase58(),
        pre: tokenAccount(other, bot, 5n),
        post: tokenAccount(other, bot, 1_000_005n),
      },
    ];
    expect(compareBuybackStates(bot.toBase58(), expected, 10_000n, existing)).toBe(
      'token_account_changed',
    );
    // And with nothing received at all (tokens sent elsewhere).
    const nothing: AccountDelta[] = [
      { address: bot.toBase58(), pre: wallet(SOL), post: wallet(SOL - 100_000_000n - 5_000n) },
    ];
    expect(compareBuybackStates(bot.toBase58(), expected, 10_000n, nothing)).toBe(
      'output_below_minimum',
    );
  });

  it('refuses a buy spending more SOL than quoted', () => {
    const deltas = good();
    deltas[0] = { ...deltas[0]!, post: wallet(SOL - 200_000_000n) };
    expect(compareBuybackStates(bot.toBase58(), expected, 10_000n, deltas)).toBe('sol_overspent');
  });

  it('refuses an output below the guaranteed minimum', () => {
    const deltas = good();
    deltas[1] = { ...deltas[1]!, post: tokenAccount(FORGE, bot, 994_999n) };
    expect(compareBuybackStates(bot.toBase58(), expected, 10_000n, deltas)).toBe(
      'output_below_minimum',
    );
  });

  it('refuses a $FORGE account handed to another owner', () => {
    const deltas = good();
    deltas[1] = { ...deltas[1]!, post: tokenAccount(FORGE, randomAddress(), 1_000_000n) };
    expect(compareBuybackStates(bot.toBase58(), expected, 10_000n, deltas)).toBe(
      'token_account_changed',
    );
  });

  it('needs the bot wallet in the simulation', () => {
    expect(compareBuybackStates(bot.toBase58(), expected, 10_000n, [good()[1]!])).toBe(
      'simulation_incomplete',
    );
  });
});

describe('createRpcBuybackSwapPreparer', () => {
  /** Hand-built Jupiter v6 `route` data: one Whirlpool step, then the amounts (IDL layout). */
  function routeData(inAmount: bigint, quotedOutAmount: bigint, slippageBps: number): Buffer {
    const out = Buffer.alloc(8 + 4 + 2 + 3 + 8 + 8 + 2 + 1);
    let o = 0;
    createHash('sha256').update('global:route').digest().copy(out, o, 0, 8);
    o += 8;
    o = out.writeUInt32LE(1, o); // route_plan: 1 step
    out[o++] = 17; // Swap::Whirlpool
    out[o++] = 1; // a_to_b
    out[o++] = 100; // percent
    out[o++] = 0; // input_index
    out[o++] = 1; // output_index
    o = out.writeBigUInt64LE(inAmount, o);
    o = out.writeBigUInt64LE(quotedOutAmount, o);
    o = out.writeUInt16LE(slippageBps, o);
    out[o] = 0; // platform_fee_bps
    return out;
  }

  function preparerFor(owner: Keypair) {
    const withSigner = vi.fn();
    const keystore = {
      withSigner,
      getPublicKey: vi.fn(),
      findRef: vi.fn(),
    } as unknown as KeystoreLike;
    const simulateTransaction = vi.fn();
    const preparer = createRpcBuybackSwapPreparer({
      connection: {
        simulateTransaction,
        getAddressLookupTable: vi.fn(),
        getTokenAccountsByOwner: vi.fn(async () => {
          throw new Error('stop after the static checks');
        }),
      } as unknown as SwapConnection,
      keystore,
      maxPriorityFeeLamports: 100_000n,
    });
    const prepare = (data: Buffer, expected: BuyExpectation) => {
      const message = MessageV0.compile({
        payerKey: owner.publicKey,
        instructions: [
          new TransactionInstruction({
            programId: new PublicKey(JUPITER_PROGRAM_ID),
            keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }],
            data,
          }),
        ],
        recentBlockhash: PublicKey.default.toBase58(),
      });
      return preparer.prepare({
        owner: owner.publicKey,
        ownerRef: 'ks_00000000000000000000000000000000',
        swapTransaction: Buffer.from(new VersionedTransaction(message).serialize()).toString(
          'base64',
        ),
        expected,
      });
    };
    return { prepare, withSigner, simulateTransaction };
  }

  const buy: BuyExpectation = {
    forgeMint: FORGE.toBase58(),
    inLamports: 100_000_000n,
    minOutAmount: 995_000n,
    quotedOutAmount: 1_000_000n,
    maxSlippageBps: 50,
  };

  it('refuses a Jupiter route above the buyback slippage cap before anything is signed', async () => {
    const owner = Keypair.generate();
    const p = preparerFor(owner);
    expect(await p.prepare(routeData(100_000_000n, 1_000_000n, 51), buy)).toEqual({
      status: 'refused',
      reason: 'jupiter_route_slippage_too_high',
    });
    // The hard 1% ceiling applies even if a caller asks for more.
    expect(
      await p.prepare(routeData(100_000_000n, 1_000_000n, 101), { ...buy, maxSlippageBps: 500 }),
    ).toEqual({ status: 'refused', reason: 'jupiter_route_slippage_too_high' });
    expect(p.withSigner).not.toHaveBeenCalled();
    expect(p.simulateTransaction).not.toHaveBeenCalled();
  });

  it('refuses a Jupiter route quoting less $FORGE or selling another amount than the quote', async () => {
    const owner = Keypair.generate();
    const p = preparerFor(owner);
    expect(await p.prepare(routeData(100_000_000n, 999_999n, 50), buy)).toEqual({
      status: 'refused',
      reason: 'jupiter_route_quoted_out_too_low',
    });
    expect(await p.prepare(routeData(200_000_000n, 1_000_000n, 50), buy)).toEqual({
      status: 'refused',
      reason: 'jupiter_route_amount_mismatch',
    });
    expect(p.withSigner).not.toHaveBeenCalled();
  });

  it('lets a matching Jupiter route through to the simulation', async () => {
    const owner = Keypair.generate();
    const p = preparerFor(owner);
    // The static checks pass; the (stubbed) simulation step is reached and fails loudly.
    await expect(p.prepare(routeData(100_000_000n, 1_000_000n, 50), buy)).rejects.toThrow(
      /static checks/,
    );
    expect(p.withSigner).not.toHaveBeenCalled();
  });

  it('refuses a transaction outside the allowlist before anything is signed', async () => {
    const owner = Keypair.generate();
    const message = MessageV0.compile({
      payerKey: owner.publicKey,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: randomAddress(),
          lamports: 1,
        }),
      ],
      recentBlockhash: PublicKey.default.toBase58(),
    });
    const tx = new VersionedTransaction(message);
    const withSigner = vi.fn();
    const keystore = {
      withSigner,
      getPublicKey: vi.fn(),
      findRef: vi.fn(),
    } as unknown as KeystoreLike;
    const simulateTransaction = vi.fn();
    const preparer = createRpcBuybackSwapPreparer({
      connection: {
        simulateTransaction,
        getAddressLookupTable: vi.fn(),
      } as unknown as SwapConnection,
      keystore,
      maxPriorityFeeLamports: 100_000n,
    });
    const res = await preparer.prepare({
      owner: owner.publicKey,
      ownerRef: 'ks_00000000000000000000000000000000',
      swapTransaction: Buffer.from(tx.serialize()).toString('base64'),
      expected: {
        forgeMint: FORGE.toBase58(),
        inLamports: 1n,
        minOutAmount: 1n,
        quotedOutAmount: 1n,
        maxSlippageBps: 50,
      },
    });
    expect(res).toEqual({ status: 'refused', reason: 'system_instruction_not_allowed' });
    expect(withSigner).not.toHaveBeenCalled();
    expect(simulateTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// Return transfer policy

describe('assertForgeReturnTx', () => {
  const bot = randomAddress();
  const params = {
    bot,
    vault: VAULT,
    mint: FORGE,
    programId: TOKEN_PROGRAM_ID,
    decimals: 6,
    amount: 1234n,
  };
  const built = () => {
    const tx = buildForgeReturnTx(params);
    tx.recentBlockhash = PublicKey.default.toBase58();
    return tx;
  };
  it('accepts the transaction it builds', () => {
    expect(() => assertForgeReturnTx(built(), params)).not.toThrow();
  });
  it('refuses another amount, another destination or an extra instruction', () => {
    expect(() => assertForgeReturnTx(built(), { ...params, amount: 1n })).toThrow(/amount/);
    expect(() => assertForgeReturnTx(built(), { ...params, vault: randomAddress() })).toThrow(
      /TX_POLICY/,
    );
    const extra = built();
    extra.add(SystemProgram.transfer({ fromPubkey: bot, toPubkey: randomAddress(), lamports: 1 }));
    expect(() => assertForgeReturnTx(extra, params)).toThrow(/program not allowed/);
  });
});

// ---------------------------------------------------------------------------------------
// Job: simulation

function simHarness(over: Partial<BuybackDeps> = {}, configOver: Partial<BuybackConfig> = {}) {
  const journal = createMemoryJournal(BuybackJournalEntry);
  const flags = memoryFlags({ [BUYBACK_FLAG]: false });
  const alerter = new RecordingAlerter();
  const logger = new RecordingLogger();
  const clock = new Clock(DAY_START);
  const quote = vi.fn(async ({ lamports }: { lamports: bigint }) => buyQuote(lamports));
  const swap = vi.fn(async () => ({ swapTransaction: 'AAAA' }));
  const quotes: BuybackQuoteSource = { quote, swap };
  // Any keystore use in simulation is a failure.
  const keystore = new Proxy(
    {},
    {
      get() {
        throw new Error('the keystore must not be touched in simulation');
      },
    },
  ) as KeystoreLike;
  const make = (extra: Partial<BuybackDeps> = {}, cfg: Partial<BuybackConfig> = {}) =>
    createBuybackJob({
      config: baseConfig({ ...configOver, ...cfg }),
      journal,
      flags,
      alerter,
      logger,
      quotes,
      keystore,
      rng: seeded(7),
      now: clock.now,
      ...over,
      ...extra,
    });
  return { journal, flags, alerter, logger, clock, quote, swap, make };
}

async function plan(journal: ReturnType<typeof simHarness>['journal']): Promise<BuybackDayEntry> {
  const e = await journal.get(dayJournalKey(DAY));
  if (e?.kind !== 'day') throw new Error('no plan');
  return e;
}

describe('buyback job, simulation', () => {
  it('defaults to simulation and plans the day once, journaled before any order', async () => {
    const h = simHarness();
    const job = h.make();
    expect(job.mode).toBe('simulation');
    const r = await job.runOnce();
    expect(r.status).toBe('ran');
    expect(r.outcome?.result).toBe('idle');
    const p = await plan(h.journal);
    expect(p.mode).toBe('simulation');
    expect(p.slots.length).toBeGreaterThan(0);
    expect(committedLamports(p.slots)).toBe(0n);
    expect(h.quote).not.toHaveBeenCalled();
  });

  it('logs the would-be order with a quote and never signs or sends', async () => {
    const h = simHarness();
    const job = h.make();
    await job.runOnce();
    const first = (await plan(h.journal)).slots[0]!;
    h.clock.t = first.at;
    const r = await job.runOnce();
    expect(r.outcome).toMatchObject({ result: 'simulated', slot: 0, quotedOut: 1_000_000n });
    expect(h.quote).toHaveBeenCalledWith({
      outputMint: FORGE.toBase58(),
      lamports: BigInt(first.lamports),
      slippageBps: 50,
    });
    expect(h.swap).not.toHaveBeenCalled();
    expect((await plan(h.journal)).slots[0]!.status).toBe('simulated');
    expect(h.logger.lines.some((l) => /would buy/.test(l.msg))).toBe(true);
  });

  it('simulates without quoting when FORGE_MINT is absent', async () => {
    const h = simHarness({}, { forgeMint: null });
    const job = h.make();
    await job.runOnce();
    h.clock.t = (await plan(h.journal)).slots[0]!.at;
    const r = await job.runOnce();
    expect(r.outcome).toMatchObject({ result: 'simulated', note: 'no_forge_mint' });
    expect(h.quote).not.toHaveBeenCalled();
  });

  it('logs a quote failure (devnet: Jupiter does not index it) without failing the run', async () => {
    const h = simHarness({
      quotes: {
        quote: async () => {
          throw new Error('fetch failed');
        },
        swap: vi.fn(),
      },
    });
    const job = h.make();
    await job.runOnce();
    h.clock.t = (await plan(h.journal)).slots[0]!.at;
    const r = await job.runOnce();
    expect(r.outcome).toMatchObject({ result: 'simulated', note: 'quote_unavailable:Error' });
  });

  it('is idempotent after a crash: the plan is reused and a done slot never runs again', async () => {
    const h = simHarness();
    await h.make().runOnce();
    const before = await plan(h.journal);
    h.clock.t = before.slots[1]!.at + 1_000;
    // A new process, with another random source: same plan.
    const restarted = h.make({ rng: seeded(999) });
    const r1 = await restarted.runOnce();
    expect(r1.outcome).toMatchObject({ result: 'simulated', slot: 1 });
    const again = h.make({ rng: seeded(12345) });
    const r2 = await again.runOnce();
    expect(r2.outcome?.result).toBe('idle');
    expect(h.quote).toHaveBeenCalledTimes(1);
    const after = await plan(h.journal);
    expect(after.slots.map((s) => [s.at, s.lamports])).toEqual(
      before.slots.map((s) => [s.at, s.lamports]),
    );
    expect(after.slots[0]!.status).toBe('missed');
  });

  it('marks the past slots missed when the plan is created mid-day (no catch-up burst)', async () => {
    const h = simHarness();
    h.clock.t = DAY_START + 18 * 3_600_000;
    await h.make().runOnce();
    const p = await plan(h.journal);
    const past = p.slots.filter((s) => s.at < h.clock.t);
    expect(past.length).toBeGreaterThan(0);
    expect(past.every((s) => s.status === 'missed')).toBe(true);
    expect(h.quote).not.toHaveBeenCalled();
  });

  it('runs at most one order per run and skips slots later than the lateness bound', async () => {
    const h = simHarness();
    const job = h.make();
    await job.runOnce();
    const p = await plan(h.journal);
    h.clock.t = p.slots[2]!.at + 1;
    const r = await job.runOnce();
    expect(r.outcome).toMatchObject({ result: 'simulated', slot: 2 });
    const after = await plan(h.journal);
    expect(after.slots[0]!.status).toBe('missed');
    expect(after.slots[1]!.status).toBe('missed');
    expect(h.quote).toHaveBeenCalledTimes(1);
  });

  it('enforces the daily cap again at execution time (a lowered cap applies at once)', async () => {
    const h = simHarness();
    await h.make().runOnce();
    const p = await plan(h.journal);
    h.clock.t = p.slots[0]!.at;
    await h.make().runOnce();
    const spent = BigInt(p.slots[0]!.lamports);
    // Restart with a cap that only covers what was already committed.
    const capped = h.make({}, { dailyCapLamports: spent });
    h.clock.t = p.slots[1]!.at;
    const r = await capped.runOnce();
    expect(r.outcome).toEqual({ result: 'skipped', slot: 1, reason: 'daily_cap' });
    expect((await plan(h.journal)).slots[1]!.status).toBe('skipped');
    expect(h.quote).toHaveBeenCalledTimes(1);
  });

  it('plans no order without a budget', async () => {
    const h = simHarness({}, { dailyCapLamports: 0n });
    const r = await h.make().runOnce();
    expect(r.outcome?.result).toBe('no_budget');
  });

  it('caps the plan by the injected budget source', async () => {
    const h = simHarness({ budget: { budgetLamports: async () => 120_000_000n } });
    await h.make().runOnce();
    const p = await plan(h.journal);
    expect(p.budgetLamports).toBe('120000000');
    expect(p.slots.reduce((a, s) => a + BigInt(s.lamports), 0n)).toBeLessThanOrEqual(120_000_000n);
  });

  it('stops when buyback_paused is set, missing or unreadable (fail closed)', async () => {
    const h = simHarness();
    h.flags.values[BUYBACK_FLAG] = true;
    expect(await h.make().runOnce()).toMatchObject({ status: 'paused', reason: 'flag' });
    delete h.flags.values[BUYBACK_FLAG];
    expect(await h.make().runOnce()).toMatchObject({ status: 'paused', reason: 'flag_missing' });
    h.flags.fail = true;
    expect(await h.make().runOnce()).toMatchObject({
      status: 'paused',
      reason: 'flags_unavailable',
    });
    expect(await h.journal.list()).toEqual([]);
    expect(h.alerter.codes()).toEqual([
      'buyback_paused_flag_missing',
      'buyback_paused_flags_unavailable',
    ]);
    const local = simHarness({}, { paused: true });
    expect(await local.make().runOnce()).toMatchObject({ status: 'paused', reason: 'config' });
  });
});

// ---------------------------------------------------------------------------------------
// Job: live refusal

describe('buyback job, live refusal', () => {
  const liveCfg = { cluster: 'mainnet-beta', live: true };
  it('refuses live mode without a spending limit withdrawer', () => {
    const h = simHarness();
    expect(() => h.make({}, liveCfg)).toThrow(
      /live buyback refused: no Squads spending limit withdrawer/,
    );
  });
  it('refuses live mode when another live dependency is missing', () => {
    const h = simHarness();
    const withdrawer: SpendingLimitWithdrawer = { remainingLamports: vi.fn(), withdraw: vi.fn() };
    expect(() => h.make({ withdrawer }, liveCfg)).toThrow(
      /missing rpc, swapPreparer, tokens, walletLock, onBeforeSend/,
    );
  });
  it('stays in simulation on devnet even with the live flag and a withdrawer', () => {
    const h = simHarness();
    const withdrawer: SpendingLimitWithdrawer = { remainingLamports: vi.fn(), withdraw: vi.fn() };
    expect(h.make({ withdrawer }, { live: true }).mode).toBe('simulation');
    expect(withdrawer.remainingLamports).not.toHaveBeenCalled();
  });
  it('refuses a slippage configuration above 1%', () => {
    const h = simHarness();
    expect(() => h.make({}, { slippageBps: 101 })).toThrow(/100 bps/);
  });
});

// ---------------------------------------------------------------------------------------
// Job: live flow with fakes (no network)

/** First signature of serialized transaction bytes (one signature, compact length 1). */
function firstSignature(raw: Uint8Array): string {
  return base58Encode(raw.subarray(1, 65));
}

class FakeRpc implements SolanaRpc {
  height = 1_000;
  readonly balances = new Map<string, bigint>();
  readonly sent: Uint8Array[] = [];
  readonly landed = new Set<string>();
  readonly order: string[];
  constructor(order: string[]) {
    this.order = order;
  }
  async getLatestBlockhash() {
    return { blockhash: base58Encode(randomBytes(32)), lastValidBlockHeight: this.height + 150 };
  }
  async sendRawTransaction(raw: Uint8Array) {
    const sig = firstSignature(raw);
    this.order.push(`send:${sig}`);
    this.sent.push(raw);
    this.landed.add(sig);
    return sig;
  }
  async getBalance(address: PublicKey) {
    return this.balances.get(address.toBase58()) ?? 0n;
  }
  async getMinimumBalanceForRentExemption() {
    return 890_880n;
  }
  async getRecentSignatures(): Promise<RecentSignature[]> {
    return [];
  }
  async getBlockHeight() {
    return this.height;
  }
  async getSlot() {
    return this.height;
  }
  async getSignatureState(signature: string): Promise<SignatureLookup> {
    return {
      state: this.landed.has(signature)
        ? { slot: this.height, confirmationStatus: 'confirmed', err: null }
        : null,
      contextSlot: this.height,
    };
  }
  async hasFinalizedTransaction() {
    return false;
  }
}

describe('buyback job, live flow', () => {
  const FAST = { N: 1 << 14, r: 8, p: 1 };
  let dir: string;
  let keystore: Keystore;
  let bot: PublicKey;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-buyback-'));
    keystore = await openKeystore({
      dir,
      passphrase: 'buyback job test passphrase, long enough here',
      scrypt: FAST,
    });
    bot = (await keystore.createKey('buyback')).publicKey;
  });

  afterEach(async () => {
    await keystore.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function liveHarness(prepare?: BuybackSwapPreparer['prepare']) {
    const order: string[] = [];
    const rpc = new FakeRpc(order);
    rpc.balances.set(bot.toBase58(), 30_000_000n);
    const journal = createMemoryJournal(BuybackJournalEntry);
    const flags = memoryFlags({ [BUYBACK_FLAG]: false });
    const alerter = new RecordingAlerter();
    const clock = new Clock(DAY_START);
    const withdraw = vi.fn<SpendingLimitWithdrawer['withdraw']>(
      async ({ lamports, destination, onBeforeSend }) => {
        const signature = base58Encode(randomBytes(64));
        onBeforeSend(signature);
        order.push(`withdraw:${signature}`);
        rpc.balances.set(
          destination.toBase58(),
          (rpc.balances.get(destination.toBase58()) ?? 0n) + lamports,
        );
        return { status: 'confirmed', signature };
      },
    );
    const withdrawer: SpendingLimitWithdrawer = {
      remainingLamports: async () => 5n * SOL,
      withdraw,
    };
    let forgeBalance = 0n;
    const tokens: ForgeTokenReader = {
      mintInfo: async () => ({ programId: TOKEN_PROGRAM_ID, decimals: 6 }),
      tokenBalance: async () => forgeBalance,
    };
    const defaultPrepare: BuybackSwapPreparer['prepare'] = async ({ expected }) => {
      // Stand-in for a verified and signed Jupiter transaction (raw = 1 signature + payload).
      const sig = randomBytes(64);
      const raw = Buffer.concat([Buffer.from([1]), sig, Buffer.from('swap')]);
      forgeBalance = expected.minOutAmount;
      return {
        status: 'ready',
        signature: base58Encode(sig),
        raw,
        lastValidBlockHeight: rpc.height + 150,
      };
    };
    const swapPreparer: BuybackSwapPreparer = { prepare: vi.fn(prepare ?? defaultPrepare) };
    const quotes: BuybackQuoteSource = {
      quote: vi.fn(async ({ lamports }: { lamports: bigint }) => buyQuote(lamports)),
      swap: vi.fn(async () => ({ swapTransaction: 'AAAA', lastValidBlockHeight: 1_150 })),
    };
    const onBeforeSend = vi.fn((sig: string) => {
      order.push(`announce:${sig}`);
    });
    const make = (cfg: Partial<BuybackConfig> = {}) =>
      createBuybackJob({
        config: baseConfig({ cluster: 'mainnet-beta', live: true, ...cfg }),
        journal,
        flags,
        alerter,
        logger: new RecordingLogger(),
        quotes,
        rng: seeded(5),
        now: clock.now,
        sleep: async () => {
          rpc.height += 1;
        },
        retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined },
        withdrawer,
        keystore,
        rpc,
        swapPreparer,
        tokens,
        walletLock: new Mutex(),
        onBeforeSend,
      });
    return {
      rpc,
      journal,
      flags,
      alerter,
      clock,
      withdraw,
      swapPreparer,
      quotes,
      onBeforeSend,
      order,
      make,
      setForge: (v: bigint) => (forgeBalance = v),
    };
  }

  it('funds once, buys at the slot, journals before sending and returns the tokens to the vault', async () => {
    const h = liveHarness();
    const job = h.make();
    expect(job.mode).toBe('live');
    const r0 = await job.runOnce();
    expect(r0.outcome?.result).toBe('idle');
    const p = await plan(h.journal);
    expect(p.mode).toBe('live');
    expect(h.withdraw).toHaveBeenCalledTimes(1);
    const planned = p.slots.reduce((a, s) => a + BigInt(s.lamports), 0n);
    // The bot had 0.03 SOL with a 0.02 reserve: 0.01 already available.
    expect(h.withdraw.mock.calls[0]![0]).toMatchObject({
      lamports: planned - 10_000_000n,
      destination: bot,
      idempotencyKey: `buyback-funding-${DAY}`,
    });
    expect(p.funding?.status).toBe('confirmed');

    h.clock.t = p.slots[0]!.at;
    const r1 = await job.runOnce();
    expect(r1.outcome).toMatchObject({ result: 'swapped', slot: 0 });
    const swapSig = (r1.outcome as { signature: string }).signature;
    // Announced before the first broadcast.
    expect(h.order.indexOf(`announce:${swapSig}`)).toBeLessThan(h.order.indexOf(`send:${swapSig}`));
    expect((await plan(h.journal)).slots[0]).toMatchObject({
      status: 'swapped',
      signature: swapSig,
    });
    expect(await h.journal.get(INFLIGHT_KEY)).toEqual({ kind: 'inflight', v: 1, tx: null });

    // Next run: the bought $FORGE goes to the vault's associated token account.
    const r2 = await job.runOnce();
    expect(r2.outcome).toMatchObject({ result: 'returned', amount: 995_000n });
    const ret = Transaction.from(h.rpc.sent.at(-1)!);
    const vaultAta = getAssociatedTokenAddressSync(FORGE, VAULT, true, TOKEN_PROGRAM_ID);
    expect(() =>
      assertForgeReturnTx(ret, {
        bot,
        vault: VAULT,
        mint: FORGE,
        programId: TOKEN_PROGRAM_ID,
        decimals: 6,
        amount: 995_000n,
      }),
    ).not.toThrow();
    expect(ret.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(vaultAta)))).toBe(
      true,
    );
    expect(
      ret.instructions.some((ix) => Buffer.from(ix.data).toString('utf8') === RETURN_MEMO),
    ).toBe(true);
    h.setForge(0n);

    // Same slot time again, new process: nothing is bought twice, no second withdrawal.
    const r3 = await h.make().runOnce();
    expect(r3.outcome?.result).toBe('idle');
    expect(h.swapPreparer.prepare).toHaveBeenCalledTimes(1);
    expect(h.withdraw).toHaveBeenCalledTimes(1);
  });

  it('binds the swap transaction check to the validated quote and the slippage cap', async () => {
    const h = liveHarness();
    await h.make().runOnce();
    const p = await plan(h.journal);
    h.clock.t = p.slots[0]!.at;
    await h.make().runOnce();
    expect(h.swapPreparer.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: {
          forgeMint: FORGE.toBase58(),
          inLamports: BigInt(p.slots[0]!.lamports),
          minOutAmount: 995_000n,
          quotedOutAmount: 1_000_000n,
          maxSlippageBps: 50,
        },
      }),
    );
  });

  it('never repeats an interrupted withdrawal (crash after the request was journaled)', async () => {
    const h = liveHarness();
    h.withdraw.mockImplementationOnce(async () => {
      throw new Error('process killed');
    });
    expect((await h.make().runOnce()).status).toBe('error');
    expect((await plan(h.journal)).funding?.status).toBe('requested');
    await h.make().runOnce();
    expect((await plan(h.journal)).funding?.status).toBe('unknown');
    expect(h.alerter.codes()).toContain('buyback_funding_unknown');
    await h.make().runOnce();
    expect(h.withdraw).toHaveBeenCalledTimes(1);
  });

  it('settles a buy left in flight by a crash instead of buying again', async () => {
    const h = liveHarness();
    await h.make().runOnce();
    const p = await plan(h.journal);
    h.clock.t = p.slots[0]!.at;
    // The process dies right after the in-flight record, before sending.
    h.onBeforeSend.mockImplementationOnce(() => {
      throw new Error('watcher down');
    });
    const r1 = await h.make().runOnce();
    expect(r1.outcome).toMatchObject({ result: 'in_flight', state: 'not_announced' });
    expect(h.rpc.sent).toHaveLength(0);
    const inflight = await h.journal.get(INFLIGHT_KEY);
    expect(inflight).toMatchObject({ kind: 'inflight', tx: { purpose: 'swap', slotIndex: 0 } });
    // Restart: the same signed bytes are rebroadcast (same signature), no new order.
    const r2 = await h.make().runOnce();
    expect(r2.outcome).toMatchObject({ result: 'in_flight', state: 'pending' });
    expect(h.rpc.sent).toHaveLength(1);
    const r3 = await h.make().runOnce();
    expect(r3.outcome).toMatchObject({ result: 'swapped', slot: 0 });
    expect(h.swapPreparer.prepare).toHaveBeenCalledTimes(1);
  });

  it('refuses a swap whose transaction pays out the wrong mint: nothing is sent', async () => {
    const h = liveHarness(async () => ({ status: 'refused', reason: 'token_account_changed' }));
    await h.make().runOnce();
    h.clock.t = (await plan(h.journal)).slots[0]!.at;
    const r = await h.make().runOnce();
    expect(r.outcome).toMatchObject({
      result: 'skipped',
      reason: 'tx_refused:token_account_changed',
    });
    expect(h.rpc.sent).toHaveLength(0);
    expect(h.alerter.codes()).toContain('buyback_order_skipped');
  });

  it('refuses a quote for the wrong output mint before asking for a transaction', async () => {
    const h = liveHarness();
    vi.mocked(h.quotes.quote).mockImplementation(async ({ lamports }) =>
      buyQuote(lamports, { outputMint: randomAddress().toBase58() }),
    );
    await h.make().runOnce();
    h.clock.t = (await plan(h.journal)).slots[0]!.at;
    const r = await h.make().runOnce();
    expect(r.outcome).toMatchObject({ reason: 'quote_rejected:output_mint_mismatch' });
    expect(h.quotes.swap).not.toHaveBeenCalled();
    expect(h.swapPreparer.prepare).not.toHaveBeenCalled();
  });

  it('re-reads the kill switch right before signing (paused mid-run: nothing signed)', async () => {
    const h = liveHarness();
    await h.make().runOnce();
    h.clock.t = (await plan(h.journal)).slots[0]!.at;
    vi.mocked(h.quotes.swap).mockImplementationOnce(async () => {
      h.flags.values[BUYBACK_FLAG] = true;
      return { swapTransaction: 'AAAA' };
    });
    const r = await h.make().runOnce();
    expect(r.outcome).toMatchObject({ result: 'skipped', reason: 'paused' });
    expect(h.swapPreparer.prepare).not.toHaveBeenCalled();
    expect((await plan(h.journal)).slots[0]!.status).toBe('planned');
  });

  it('skips an order the bot cannot pay while keeping its reserve', async () => {
    const h = liveHarness();
    h.withdraw.mockImplementationOnce(async () => ({ status: 'failed', error: 'limit exhausted' }));
    await h.make().runOnce();
    expect(h.alerter.codes()).toContain('buyback_funding_failed');
    h.clock.t = (await plan(h.journal)).slots[0]!.at;
    const r = await h.make().runOnce();
    expect(r.outcome).toMatchObject({ result: 'skipped', reason: 'insufficient_funds' });
    expect(h.quotes.quote).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// Jupiter client

describe('createJupiterBuybackClient', () => {
  it('asks an ExactIn quote from wrapped SOL to $FORGE', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(buyQuote(5n)), { status: 200 }),
    );
    const client = createJupiterBuybackClient({
      baseUrl: 'https://jup.example.test/swap/v1',
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
      minRequestIntervalMs: 0,
      timeoutMs: 1_000,
      maxPriorityFeeLamports: 100_000n,
    });
    await client.quote({ outputMint: FORGE.toBase58(), lamports: 5n, slippageBps: 50 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.searchParams.get('inputMint')).toBe(NATIVE_MINT.toBase58());
    expect(u.searchParams.get('outputMint')).toBe(FORGE.toBase58());
    expect(u.searchParams.get('swapMode')).toBe('ExactIn');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });
  it('refuses plain http', () => {
    expect(() =>
      createJupiterBuybackClient({
        baseUrl: 'http://jup.example.test',
        minRequestIntervalMs: 0,
        timeoutMs: 1_000,
        maxPriorityFeeLamports: 1n,
      }),
    ).toThrow(/https/);
  });
});
