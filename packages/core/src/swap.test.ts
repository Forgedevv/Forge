import { readFileSync } from 'node:fs';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
  createDbcProgram,
  deriveDbcEventAuthority,
  deriveDbcPoolAuthority,
  swapQuote,
  type PoolConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ForgeAddressError } from './addresses.js';
import { FEES } from './constants.js';
import {
  DEFAULT_SWAP_COMPUTE_UNIT_LIMIT,
  MAX_SWAP_SLIPPAGE_BPS,
  PLATFORM_FEE_BPS,
  SWAP_MAX_TRANSACTION_BYTES,
  SwapError,
  assertPlatformFeeWalletReady,
  assertPoolConfigAllowed,
  assertReferralAccountReady,
  assertSwapFeeAccountsReady,
  buildBuyTx,
  buildDbcSwapInstruction,
  buildSellTx,
  buildSwapTransaction,
  compileSwapTransaction,
  computeSwapQuote,
  estimateSwapNetworkFeeLamports,
  fetchSwapPoolState,
  minAmountOutForSlippage,
  platformFeeLamports,
  poolSwapStatus,
  quoteSwap,
  requiredSwapLamports,
  swapFeeAddresses,
  swapPriceImpactBps,
  type SwapAccountSnapshot,
  type SwapContext,
  type SwapErrorCode,
  type SwapPoolState,
} from './swap.js';

// ---------------------------------------------------------------------------------------------
// Fixtures: real devnet DBC accounts (public data), decoded offline.
// ---------------------------------------------------------------------------------------------

interface FixtureAccount {
  address: string;
  lamports: string;
  owner: string;
  data: string;
}
const fixture = JSON.parse(
  readFileSync(new URL('./swap.fixtures.json', import.meta.url), 'utf8'),
) as {
  accounts: Record<
    'activePool' | 'activeConfig' | 'migratedPool' | 'migratedConfig',
    FixtureAccount
  >;
};

// A connection that is never used to send anything: only needed to build the SDK's Anchor coder.
const offlineConnection = new Connection('http://127.0.0.1:1');
const coder = createDbcProgram(offlineConnection).program.coder;

const accountInfo = (a: FixtureAccount): AccountInfo<Buffer> => ({
  lamports: Number(a.lamports),
  owner: new PublicKey(a.owner),
  executable: false,
  data: Buffer.from(a.data, 'base64'),
});
const decodePool = (a: FixtureAccount) =>
  coder.accounts.decode<VirtualPool>('virtualPool', Buffer.from(a.data, 'base64'));
const decodeConfig = (a: FixtureAccount) =>
  coder.accounts.decode<PoolConfig>('poolConfig', Buffer.from(a.data, 'base64'));

const ACTIVE_POOL = new PublicKey(fixture.accounts.activePool.address);
const MIGRATED_POOL = new PublicKey(fixture.accounts.migratedPool.address);

/** Point well after the anti-sniper phase of the fixture pool. */
function laterPoint(virtualPool: VirtualPool): BN {
  return virtualPool.poolState.activationPoint.add(new BN(30 * 86_400));
}

function activeState(): SwapPoolState {
  const virtualPool = decodePool(fixture.accounts.activePool);
  return {
    pool: ACTIVE_POOL,
    virtualPool,
    config: decodeConfig(fixture.accounts.activeConfig),
    currentPoint: laterPoint(virtualPool),
  };
}

function migratedState(): SwapPoolState {
  const virtualPool = decodePool(fixture.accounts.migratedPool);
  return {
    pool: MIGRATED_POOL,
    virtualPool,
    config: decodeConfig(fixture.accounts.migratedConfig),
    currentPoint: laterPoint(virtualPool),
  };
}

const RENT = { system: 890_880n, tokenAccount: 2_039_280n };
const key = () => Keypair.generate().publicKey;

function tokenAccountData(o: {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  state?: number;
  isNative?: bigint | null;
}): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: o.mint,
      owner: o.owner,
      amount: o.amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: o.state ?? 1,
      isNativeOption: o.isNative == null ? 0 : 1,
      isNative: o.isNative ?? 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

const systemAccount = (lamports: bigint): SwapAccountSnapshot => ({
  lamports,
  owner: SystemProgram.programId,
  data: Buffer.alloc(0),
});

function referralSnapshot(
  overrides: Partial<{ owner: PublicKey; mint: PublicKey; state: number; holder: PublicKey }> = {},
) {
  return {
    lamports: RENT.tokenAccount,
    owner: overrides.owner ?? TOKEN_PROGRAM_ID,
    data: tokenAccountData({
      mint: overrides.mint ?? NATIVE_MINT,
      owner: overrides.holder ?? key(),
      amount: 0n,
      state: overrides.state ?? 1,
      isNative: RENT.tokenAccount,
    }),
  };
}

function makeContext(overrides: Partial<SwapContext> & { coinHeld?: bigint } = {}): SwapContext {
  const state = activeState();
  const user = overrides.user ?? key();
  const baseMint = state.virtualPool.poolState.baseMint;
  const userCoinAta = getAssociatedTokenAddressSync(baseMint, user, true, TOKEN_PROGRAM_ID);
  const userWrappedSolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    user,
    true,
    TOKEN_PROGRAM_ID,
  );
  const { coinHeld, ...rest } = overrides;
  return {
    ...state,
    configAddress: state.virtualPool.poolState.config,
    user,
    userLamports: 1_000_000_000n,
    userCoinAta,
    userCoinAtaAccount:
      coinHeld === undefined
        ? null
        : {
            lamports: RENT.tokenAccount,
            owner: TOKEN_PROGRAM_ID,
            data: tokenAccountData({ mint: baseMint, owner: user, amount: coinHeld }),
          },
    userWrappedSolAta,
    userWrappedSolAtaAccount: null,
    platformFeeWallet: key(),
    platformFeeWalletAccount: systemAccount(10_000_000n),
    platformFeeWalletRentExemptMinimum: RENT.system,
    referralTokenAccount: key(),
    referralTokenAccountInfo: referralSnapshot(),
    systemAccountRent: RENT.system,
    wrappedSolAtaRent: RENT.tokenAccount,
    coinAtaRent: RENT.tokenAccount,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000,
    ...rest,
  };
}

function expectSwapError(fn: () => unknown, code: SwapErrorCode): SwapError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SwapError);
    expect((error as SwapError).code).toBe(code);
    return error as SwapError;
  }
  throw new Error(`expected SwapError ${code}`);
}

async function expectSwapErrorAsync(p: Promise<unknown>, code: SwapErrorCode): Promise<SwapError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(SwapError);
    expect((error as SwapError).code).toBe(code);
    return error as SwapError;
  }
  throw new Error(`expected SwapError ${code}`);
}

const SOL = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;

// ---------------------------------------------------------------------------------------------
// Fee math
// ---------------------------------------------------------------------------------------------

describe('platformFeeLamports', () => {
  it('uses the shared 30 bps platform fee by default', () => {
    expect(PLATFORM_FEE_BPS).toBe(FEES.platformFeeBps);
    expect(PLATFORM_FEE_BPS).toBe(30);
    expect(platformFeeLamports(SOL)).toBe(3_000_000n);
    expect(platformFeeLamports(SOL / 100n)).toBe(30_000n); // 0.01 SOL
    expect(platformFeeLamports(SOL / 10n)).toBe(300_000n); // devnet test 4 buy
  });

  it('rounds up, in favour of FORGE, by strictly less than one lamport', () => {
    expect(platformFeeLamports(0n)).toBe(0n);
    expect(platformFeeLamports(1n)).toBe(1n);
    expect(platformFeeLamports(333n)).toBe(1n); // 0.999
    expect(platformFeeLamports(334n)).toBe(2n); // 1.002
    expect(platformFeeLamports(10_000n)).toBe(30n); // exact: no rounding
    // devnet test 4 sell: 98,009,999 lamports quoted out -> 294,029.997 -> 294,030
    expect(platformFeeLamports(98_009_999n)).toBe(294_030n);
    let seed = 0x2545f4914f6cdd1dn;
    for (let i = 0; i < 500; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & U64_MAX;
      const amount = seed >> BigInt(i % 40);
      const fee = platformFeeLamports(amount);
      expect(fee * 10_000n >= amount * 30n).toBe(true);
      expect((fee - 1n) * 10_000n < amount * 30n).toBe(true);
    }
  });

  it('is exact on the largest u64 amounts (bigint, no overflow or float rounding)', () => {
    const fee = platformFeeLamports(U64_MAX);
    expect(fee).toBe((U64_MAX * 30n + 9_999n) / 10_000n);
    expect(fee).toBe(55_340_232_221_128_655n);
    expect(fee > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(platformFeeLamports(U64_MAX, 10_000)).toBe(U64_MAX);
  });

  it('rejects amounts and rates outside their domain', () => {
    expectSwapError(() => platformFeeLamports(-1n), 'INVALID_PARAMS');
    expectSwapError(() => platformFeeLamports(U64_MAX + 1n), 'INVALID_PARAMS');
    expectSwapError(() => platformFeeLamports(1000 as unknown as bigint), 'INVALID_PARAMS');
    expectSwapError(() => platformFeeLamports(1n, -1), 'INVALID_PARAMS');
    expectSwapError(() => platformFeeLamports(1n, 10_001), 'INVALID_PARAMS');
    expectSwapError(() => platformFeeLamports(1n, 2.5), 'INVALID_PARAMS');
  });
});

describe('minAmountOutForSlippage', () => {
  it('rounds down like the SDK quote', () => {
    expect(minAmountOutForSlippage(1_000n, 0)).toBe(1_000n);
    expect(minAmountOutForSlippage(1_000n, 100)).toBe(990n);
    expect(minAmountOutForSlippage(999n, 100)).toBe(989n); // 989.01
    expect(minAmountOutForSlippage(1_000n, 10_000)).toBe(0n);
    expect(minAmountOutForSlippage(U64_MAX, 1)).toBe((U64_MAX * 9_999n) / 10_000n);
  });

  it('matches the minimumAmountOut of the SDK swapQuote', () => {
    const s = activeState();
    const q = swapQuote(
      s.virtualPool,
      s.config,
      false,
      new BN(10_000_000),
      250,
      true,
      s.currentPoint,
      false,
    );
    expect(minAmountOutForSlippage(BigInt(q.outputAmount.toString()), 250)).toBe(
      BigInt(q.minimumAmountOut.toString()),
    );
  });
});

describe('network fee and SOL requirement', () => {
  it('estimates the base fee plus the priority fee, rounded up', () => {
    expect(estimateSwapNetworkFeeLamports(150_000, 0)).toBe(5_000n);
    expect(estimateSwapNetworkFeeLamports(150_000, 1_000)).toBe(5_150n);
    expect(estimateSwapNetworkFeeLamports(1, 1)).toBe(5_001n);
  });

  it('takes the peak before the wrapped SOL close and the rent-exempt final balance', () => {
    const base = {
      amountIn: 10_000_000n,
      platformFee: 30_000n,
      minAmountOut: 0n,
      networkFee: 5_000n,
      wrappedSolAtaRent: RENT.tokenAccount,
      coinAtaRent: RENT.tokenAccount,
      systemAccountRent: RENT.system,
    };
    // the temporary wrapped SOL rent makes the peak higher than the final requirement
    expect(requiredSwapLamports({ side: 'buy', ...base })).toBe(
      5_000n + RENT.tokenAccount + RENT.tokenAccount + 10_000_000n,
    );
    // wrapped SOL ATA already there: the final balance (fee + rent-exempt minimum) decides
    expect(requiredSwapLamports({ side: 'buy', ...base, wrappedSolAtaRent: 0n })).toBe(
      5_000n + RENT.tokenAccount + 10_000_000n + 30_000n + RENT.system,
    );
    // sell: the proceeds cover the platform fee, only the peak matters
    expect(
      requiredSwapLamports({ side: 'sell', ...base, minAmountOut: 50_000_000n, coinAtaRent: 0n }),
    ).toBe(5_000n + RENT.tokenAccount);
  });
});

// ---------------------------------------------------------------------------------------------
// Pool status and quotes
// ---------------------------------------------------------------------------------------------

describe('poolSwapStatus and graduated refusal', () => {
  it('reads the fixture pools', () => {
    const active = activeState();
    expect(poolSwapStatus(active.virtualPool, active.config)).toBe('tradable');
    const migrated = migratedState();
    expect(migrated.virtualPool.poolState.isMigrated).not.toBe(0);
    expect(poolSwapStatus(migrated.virtualPool, migrated.config)).toBe('migrated');
  });

  it('refuses to quote or build on a migrated pool', () => {
    const migrated = migratedState();
    const e = expectSwapError(
      () =>
        computeSwapQuote(migrated, {
          side: 'buy',
          amountIn: SOL / 100n,
          slippage: { slippageBps: 100 },
        }),
      'POOL_GRADUATED',
    );
    expect(e.details.status).toBe('migrated');
    const ctx = { ...makeContext(), ...migrated };
    expectSwapError(
      () =>
        buildSwapTransaction(ctx, {
          side: 'buy',
          amountIn: SOL / 100n,
          slippage: { slippageBps: 100 },
        }),
      'POOL_GRADUATED',
    );
  });

  it('refuses a pool whose curve is complete but not migrated yet', () => {
    const s = activeState();
    s.virtualPool.poolState.quoteReserve = s.config.migrationQuoteThreshold.clone();
    expect(poolSwapStatus(s.virtualPool, s.config)).toBe('curve_complete');
    const e = expectSwapError(
      () =>
        computeSwapQuote(s, { side: 'sell', amountIn: 1_000_000n, slippage: { slippageBps: 100 } }),
      'POOL_GRADUATED',
    );
    expect(e.details.status).toBe('curve_complete');
    const t = activeState();
    t.virtualPool.poolState.migrationProgress = 1;
    expect(poolSwapStatus(t.virtualPool, t.config)).toBe('curve_complete');
  });

  it('refuses a pool that is not quoted in SOL', () => {
    const s = activeState();
    s.config.quoteMint = key();
    expectSwapError(
      () =>
        computeSwapQuote(s, { side: 'buy', amountIn: SOL / 100n, slippage: { slippageBps: 100 } }),
      'UNSUPPORTED_POOL',
    );
  });
});

describe('computeSwapQuote', () => {
  it('quotes a buy with the SDK and adds the platform fee on the SOL spent', () => {
    const s = activeState();
    const amountIn = SOL / 100n;
    const q = computeSwapQuote(s, { side: 'buy', amountIn, slippage: { slippageBps: 100 } });
    const sdk = swapQuote(
      s.virtualPool,
      s.config,
      false,
      new BN(amountIn.toString()),
      100,
      true,
      s.currentPoint,
      false,
    );
    expect(q.expectedAmountOut).toBe(BigInt(sdk.outputAmount.toString()));
    expect(q.minAmountOut).toBe(BigInt(sdk.minimumAmountOut.toString()));
    expect(q.fees.tradingFee).toBe(BigInt(sdk.tradingFee.toString()));
    expect(q.fees.protocolFee).toBe(BigInt(sdk.protocolFee.toString()));
    expect(q.fees.referralFee).toBe(BigInt(sdk.referralFee.toString()));
    expect(q.fees.poolFeeToken).toBe('quote');
    // 1% pool fee on 0.01 SOL: 100,000; protocol 20% = 20,000, of which the referral gets 20% = 4,000
    expect(q.fees.totalPoolFee).toBe(100_000n);
    expect(q.fees.referralFee).toBe(4_000n);
    expect(q.fees.protocolFee).toBe(16_000n);
    expect(q.fees.tradingFee).toBe(80_000n);
    expect(q.fees.platformFee).toBe(30_000n);
    expect(q.fees.platformFeeBps).toBe(30);
    expect(q.expectedSolDelta).toBe(-(amountIn + 30_000n));
    expect(q.worstCaseSolDelta).toBe(q.expectedSolDelta);
    expect(q.slippageBps).toBe(100);
    expect(q.baseMint.equals(s.virtualPool.poolState.baseMint)).toBe(true);
  });

  it('computes the sell platform fee on the quoted SOL out, rounded up', () => {
    const s = activeState();
    const buy = computeSwapQuote(s, {
      side: 'buy',
      amountIn: SOL / 10n,
      slippage: { slippageBps: 0 },
    });
    const amountIn = buy.expectedAmountOut / 3n;
    const q = computeSwapQuote(s, { side: 'sell', amountIn, slippage: { slippageBps: 200 } });
    const sdk = swapQuote(
      s.virtualPool,
      s.config,
      true,
      new BN(amountIn.toString()),
      200,
      true,
      s.currentPoint,
      false,
    );
    expect(q.expectedAmountOut).toBe(BigInt(sdk.outputAmount.toString()));
    expect(q.fees.platformFee).toBe((q.expectedAmountOut * 30n + 9_999n) / 10_000n);
    expect(q.expectedSolDelta).toBe(q.expectedAmountOut - q.fees.platformFee);
    expect(q.worstCaseSolDelta).toBe(q.minAmountOut - q.fees.platformFee);
    expect(q.fees.totalPoolFee).toBe(q.fees.tradingFee + q.fees.protocolFee + q.fees.referralFee);
    expect(q.fees.referralFee).toBe(((q.fees.protocolFee + q.fees.referralFee) * 20n) / 100n);
  });

  it('accepts an explicit minimum output within the slippage cap', () => {
    const s = activeState();
    const ref = computeSwapQuote(s, {
      side: 'buy',
      amountIn: SOL / 100n,
      slippage: { slippageBps: 0 },
    });
    const q = computeSwapQuote(s, {
      side: 'buy',
      amountIn: SOL / 100n,
      slippage: { minAmountOut: ref.expectedAmountOut - 5n },
    });
    expect(q.minAmountOut).toBe(ref.expectedAmountOut - 5n);
    expect(q.slippageBps).toBeNull();
    expectSwapError(
      () =>
        computeSwapQuote(s, {
          side: 'buy',
          amountIn: SOL / 100n,
          slippage: { minAmountOut: ref.expectedAmountOut + 1n },
        }),
      'MIN_AMOUNT_OUT_ABOVE_QUOTE',
    );
    expectSwapError(
      () =>
        computeSwapQuote(s, { side: 'buy', amountIn: SOL / 100n, slippage: { minAmountOut: 1n } }),
      'SLIPPAGE_TOO_HIGH',
    );
  });

  it('validates the slippage input', () => {
    const s = activeState();
    const q = (slippage: unknown) =>
      computeSwapQuote(s, { side: 'buy', amountIn: SOL / 100n, slippage: slippage as never });
    expectSwapError(() => q({}), 'INVALID_PARAMS');
    expectSwapError(() => q(undefined), 'INVALID_PARAMS');
    expectSwapError(() => q({ slippageBps: 100, minAmountOut: 1n }), 'INVALID_PARAMS');
    expectSwapError(() => q({ slippageBps: MAX_SWAP_SLIPPAGE_BPS + 1 }), 'INVALID_PARAMS');
    expectSwapError(() => q({ slippageBps: 1.5 }), 'INVALID_PARAMS');
    expectSwapError(() => q({ minAmountOut: 0n }), 'INVALID_PARAMS');
    expect(q({ slippageBps: MAX_SWAP_SLIPPAGE_BPS }).slippageBps).toBe(MAX_SWAP_SLIPPAGE_BPS);
  });

  it('handles edge amounts: zero, 1 lamport, above the curve, above u64', () => {
    const s = activeState();
    const q = (amountIn: bigint, side: 'buy' | 'sell' = 'buy') =>
      computeSwapQuote(s, { side, amountIn, slippage: { slippageBps: 100 } });
    expectSwapError(() => q(0n), 'INVALID_PARAMS');
    expectSwapError(() => q(U64_MAX + 1n), 'INVALID_PARAMS');
    // 1 lamport: the pool fee (rounded up) eats it, nothing comes out
    expectSwapError(() => q(1n), 'AMOUNT_TOO_SMALL');
    // a 1-raw-unit sale returns nothing either
    expectSwapError(() => q(1n, 'sell'), 'AMOUNT_TOO_SMALL');
    // more SOL than the curve can take before graduation
    expectSwapError(() => q(100n * SOL), 'INSUFFICIENT_LIQUIDITY');
    expectSwapError(
      () =>
        computeSwapQuote(s, { side: 'swap' as never, amountIn: 1n, slippage: { slippageBps: 0 } }),
      'INVALID_PARAMS',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Fee accounts
// ---------------------------------------------------------------------------------------------

describe('swapPriceImpactBps', () => {
  const Q64 = 1n << 64n;

  it('is 0 at the spot price and counts what the trade loses against it', () => {
    // Spot price 1 (sqrtPrice = 2^64): 1,000 lamports buy 1,000 units at spot.
    expect(
      swapPriceImpactBps({
        side: 'buy',
        sqrtPrice: Q64,
        curveAmountIn: 1000n,
        curveAmountOut: 1000n,
      }),
    ).toBe(0);
    expect(
      swapPriceImpactBps({
        side: 'buy',
        sqrtPrice: Q64,
        curveAmountIn: 1000n,
        curveAmountOut: 990n,
      }),
    ).toBe(100);
    // Spot price 4 (sqrtPrice = 2^65): 1,000 units sell for 4,000 lamports at spot.
    expect(
      swapPriceImpactBps({
        side: 'sell',
        sqrtPrice: 2n * Q64,
        curveAmountIn: 1000n,
        curveAmountOut: 4000n,
      }),
    ).toBe(0);
    expect(
      swapPriceImpactBps({
        side: 'sell',
        sqrtPrice: 2n * Q64,
        curveAmountIn: 1000n,
        curveAmountOut: 3600n,
      }),
    ).toBe(1000);
    // Same trade, price 1/4: a buy of 1,000 lamports gets 4,000 units at spot.
    expect(
      swapPriceImpactBps({
        side: 'buy',
        sqrtPrice: Q64 / 2n,
        curveAmountIn: 1000n,
        curveAmountOut: 3000n,
      }),
    ).toBe(2500);
  });

  it('rounds up to the next bps and clamps to 0..10,000', () => {
    // 2/3 of the spot output: 33.33...% impact, shown as 3,334 bps.
    expect(
      swapPriceImpactBps({ side: 'buy', sqrtPrice: Q64, curveAmountIn: 3n, curveAmountOut: 2n }),
    ).toBe(3334);
    expect(
      swapPriceImpactBps({
        side: 'buy',
        sqrtPrice: Q64,
        curveAmountIn: 100_000n,
        curveAmountOut: 99_999n,
      }),
    ).toBe(1);
    // Better than spot (cannot happen on a curve): 0, never negative.
    expect(
      swapPriceImpactBps({
        side: 'buy',
        sqrtPrice: Q64,
        curveAmountIn: 1000n,
        curveAmountOut: 2000n,
      }),
    ).toBe(0);
    expect(
      swapPriceImpactBps({
        side: 'sell',
        sqrtPrice: Q64,
        curveAmountIn: 1000n,
        curveAmountOut: 0n,
      }),
    ).toBe(10_000);
  });

  it('is exact on u64 amounts and a u128 sqrt price (bigint, no float)', () => {
    const U64 = (1n << 64n) - 1n;
    const big = (1n << 127n) + 12345n;
    expect(
      swapPriceImpactBps({ side: 'sell', sqrtPrice: big, curveAmountIn: U64, curveAmountOut: U64 }),
    ).toBe(10_000);
    expect(
      swapPriceImpactBps({ side: 'buy', sqrtPrice: 1n, curveAmountIn: U64, curveAmountOut: U64 }),
    ).toBe(10_000);
    // At a huge price one raw unit for all the SOL is still better than spot: no impact.
    expect(
      swapPriceImpactBps({ side: 'buy', sqrtPrice: big, curveAmountIn: U64, curveAmountOut: 1n }),
    ).toBe(0);
  });

  it('refuses inputs outside its domain', () => {
    const base = { side: 'buy' as const, sqrtPrice: Q64, curveAmountIn: 1n, curveAmountOut: 1n };
    for (const bad of [
      { ...base, sqrtPrice: 0n },
      { ...base, curveAmountIn: 0n },
      { ...base, curveAmountOut: -1n },
      { ...base, side: 'swap' as never },
    ]) {
      expect(() => swapPriceImpactBps(bad)).toThrow(SwapError);
    }
  });
});

describe('computeSwapQuote — priceImpactBps', () => {
  /** `ceil(10_000 * (1 - a / b))` for `a <= b`: the single-segment closed form. */
  const closedForm = (a: bigint, b: bigint) => Number(10_000n - (a * 10_000n) / b);

  it('matches 1 - sqrtPrice / nextSqrtPrice on a buy (single curve segment)', () => {
    const s = activeState();
    for (const amountIn of [SOL / 1000n, SOL / 100n, SOL / 10n, SOL]) {
      const q = computeSwapQuote(s, { side: 'buy', amountIn, slippage: { slippageBps: 0 } });
      const sdk = swapQuote(
        s.virtualPool,
        s.config,
        false,
        new BN(amountIn.toString()),
        0,
        true,
        s.currentPoint,
        false,
      );
      const s0 = BigInt(s.virtualPool.poolState.sqrtPrice.toString());
      const s1 = BigInt(sdk.nextSqrtPrice.toString());
      expect(Math.abs(q.priceImpactBps - closedForm(s0, s1))).toBeLessThanOrEqual(1);
    }
  });

  it('matches 1 - nextSqrtPrice / sqrtPrice on a sell', () => {
    const s = activeState();
    // What a 0.01 SOL buy gets: the fixture pool holds little SOL to pay sells with.
    const held = computeSwapQuote(s, {
      side: 'buy',
      amountIn: SOL / 100n,
      slippage: { slippageBps: 0 },
    });
    for (const amountIn of [held.expectedAmountOut / 1000n, held.expectedAmountOut / 10n]) {
      const q = computeSwapQuote(s, { side: 'sell', amountIn, slippage: { slippageBps: 0 } });
      const sdk = swapQuote(
        s.virtualPool,
        s.config,
        true,
        new BN(amountIn.toString()),
        0,
        true,
        s.currentPoint,
        false,
      );
      const s0 = BigInt(s.virtualPool.poolState.sqrtPrice.toString());
      const s1 = BigInt(sdk.nextSqrtPrice.toString());
      expect(Math.abs(q.priceImpactBps - closedForm(s1, s0))).toBeLessThanOrEqual(1);
    }
  });

  it('grows with the trade size and leaves the pool fee out', () => {
    const s = activeState();
    const impacts = [SOL / 10_000n, SOL / 100n, SOL / 10n, SOL, 3n * SOL].map(
      (amountIn) =>
        computeSwapQuote(s, { side: 'buy', amountIn, slippage: { slippageBps: 0 } }).priceImpactBps,
    );
    for (let i = 1; i < impacts.length; i++)
      expect(impacts[i]!).toBeGreaterThanOrEqual(impacts[i - 1]!);
    expect(impacts[impacts.length - 1]!).toBeGreaterThan(impacts[0]!);
    // A tiny buy pays the 1% pool fee (100 bps) but moves the price by at most 1 bps.
    expect(impacts[0]!).toBeLessThanOrEqual(1);
  });

  it('adds output-side fees back on a sell (they are fees, not impact)', () => {
    const s = activeState();
    const held = computeSwapQuote(s, {
      side: 'buy',
      amountIn: SOL / 10n,
      slippage: { slippageBps: 0 },
    });
    const q = computeSwapQuote(s, {
      side: 'sell',
      amountIn: held.expectedAmountOut / 100n,
      slippage: { slippageBps: 0 },
    });
    const sdk = swapQuote(
      s.virtualPool,
      s.config,
      true,
      new BN((held.expectedAmountOut / 100n).toString()),
      0,
      true,
      s.currentPoint,
      false,
    );
    expect(q.priceImpactBps).toBe(
      swapPriceImpactBps({
        side: 'sell',
        sqrtPrice: BigInt(s.virtualPool.poolState.sqrtPrice.toString()),
        curveAmountIn: BigInt(sdk.actualInputAmount.toString()),
        curveAmountOut: q.expectedAmountOut + q.fees.totalPoolFee,
      }),
    );
    // The 1% fee on the output alone would read as about 100 bps.
    expect(q.priceImpactBps).toBeLessThan(50);
  });
});

describe('fee account checks', () => {
  it('refuses a platform fee wallet that is missing or not rent-exempt', () => {
    const wallet = key();
    expectSwapError(
      () => assertPlatformFeeWalletReady(wallet, null, RENT.system),
      'PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT',
    );
    const e = expectSwapError(
      () => assertPlatformFeeWalletReady(wallet, systemAccount(RENT.system - 1n), RENT.system),
      'PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT',
    );
    expect(e.details.platformFeeWallet).toBe(wallet.toBase58());
    expect(() =>
      assertPlatformFeeWalletReady(wallet, systemAccount(RENT.system), RENT.system),
    ).not.toThrow();
    const ctx = makeContext({ platformFeeWalletAccount: systemAccount(1n) });
    expectSwapError(
      () =>
        buildSwapTransaction(ctx, {
          side: 'buy',
          amountIn: SOL / 100n,
          slippage: { slippageBps: 100 },
        }),
      'PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT',
    );
  });

  it('refuses a referral account that is not an initialized wrapped SOL token account', () => {
    const a = key();
    expect(() => assertReferralAccountReady(a, referralSnapshot())).not.toThrow();
    expectSwapError(() => assertReferralAccountReady(a, null), 'REFERRAL_ACCOUNT_INVALID');
    expectSwapError(
      () => assertReferralAccountReady(a, referralSnapshot({ owner: SystemProgram.programId })),
      'REFERRAL_ACCOUNT_INVALID',
    );
    expectSwapError(
      () => assertReferralAccountReady(a, referralSnapshot({ mint: key() })),
      'REFERRAL_ACCOUNT_INVALID',
    );
    expectSwapError(
      () => assertReferralAccountReady(a, referralSnapshot({ state: 2 })), // frozen
      'REFERRAL_ACCOUNT_INVALID',
    );
    expectSwapError(
      () => assertReferralAccountReady(a, { ...referralSnapshot(), data: Buffer.alloc(10) }),
      'REFERRAL_ACCOUNT_INVALID',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Instructions and transaction layout
// ---------------------------------------------------------------------------------------------

function transferOf(ix: TransactionInstruction) {
  expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
  return SystemInstruction.decodeTransfer(ix);
}

/** Instructions of a built v0 transaction, decompiled (no lookup tables). */
function instructionsOf(built: { transaction: VersionedTransaction }): TransactionInstruction[] {
  return TransactionMessage.decompile(built.transaction.message).instructions;
}

describe('buildDbcSwapInstruction', () => {
  const accounts = () => ({
    config: key(),
    pool: key(),
    inputTokenAccount: key(),
    outputTokenAccount: key(),
    baseVault: key(),
    quoteVault: key(),
    baseMint: key(),
    quoteMint: NATIVE_MINT,
    payer: key(),
    tokenBaseProgram: TOKEN_PROGRAM_ID,
    tokenQuoteProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: key(),
  });

  it('matches the SDK Anchor encoding (accounts, order, flags, data)', async () => {
    const a = accounts();
    const program = createDbcProgram(offlineConnection).program;
    for (const sysvar of [false, true]) {
      const ours = buildDbcSwapInstruction(a, 123_456_789n, 987_654n, sysvar);
      const sdk = await program.methods
        .swap({ amountIn: new BN(123_456_789), minimumAmountOut: new BN(987_654) })
        .accountsStrict({
          poolAuthority: deriveDbcPoolAuthority(),
          eventAuthority: deriveDbcEventAuthority(),
          program: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
          ...a,
        })
        .remainingAccounts(
          sysvar
            ? [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }]
            : [],
        )
        .instruction();
      expect(ours.programId.equals(sdk.programId)).toBe(true);
      expect(ours.data.equals(sdk.data)).toBe(true);
      expect(ours.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
        sdk.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      );
    }
  });

  it('follows the account order of the SDK IDL', () => {
    const ix = DynamicBondingCurveIdl.instructions.find((i) => i.name === 'swap');
    const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    expect(ix?.accounts.map((acc) => camel(acc.name))).toEqual([
      'poolAuthority',
      'config',
      'pool',
      'inputTokenAccount',
      'outputTokenAccount',
      'baseVault',
      'quoteVault',
      'baseMint',
      'quoteMint',
      'payer',
      'tokenBaseProgram',
      'tokenQuoteProgram',
      'referralTokenAccount',
      'eventAuthority',
      'program',
    ]);
  });

  it('refuses amounts that do not fit a u64', () => {
    expectSwapError(
      () => buildDbcSwapInstruction(accounts(), U64_MAX + 1n, 0n, false),
      'INVALID_PARAMS',
    );
    expectSwapError(() => buildDbcSwapInstruction(accounts(), 0n, 0n, false), 'INVALID_PARAMS');
    const ix = buildDbcSwapInstruction(accounts(), U64_MAX, U64_MAX, false);
    expect(ix.data.readBigUInt64LE(8)).toBe(U64_MAX);
  });
});

describe('buildSwapTransaction', () => {
  it('lays out a buy: compute budget, ATAs, wrap, swap, unwrap, platform fee', () => {
    const ctx = makeContext();
    const amountIn = SOL / 100n;
    const built = buildSwapTransaction(ctx, {
      side: 'buy',
      amountIn,
      slippage: { slippageBps: 100 },
    });
    const ixs = instructionsOf(built);
    expect(ixs.map((ix) => ix.programId.toBase58())).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), // wrapped SOL ATA
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), // coin ATA
      SystemProgram.programId.toBase58(), // wrap
      TOKEN_PROGRAM_ID.toBase58(), // sync native
      DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(), // close (unwrap)
      SystemProgram.programId.toBase58(), // platform fee
    ]);
    // compute unit limit
    expect(ixs[0]!.data[0]).toBe(2);
    expect(ixs[0]!.data.readUInt32LE(1)).toBe(DEFAULT_SWAP_COMPUTE_UNIT_LIMIT);
    // ATAs
    expect(ixs[1]!.keys[1]!.pubkey.equals(ctx.userWrappedSolAta)).toBe(true);
    expect(ixs[2]!.keys[1]!.pubkey.equals(ctx.userCoinAta)).toBe(true);
    // wrap exactly amountIn into the user's wrapped SOL ATA
    const wrap = transferOf(ixs[3]!);
    expect(wrap.toPubkey.equals(ctx.userWrappedSolAta)).toBe(true);
    expect(wrap.lamports).toBe(amountIn);
    expect(ixs[4]!.data[0]).toBe(17); // SyncNative
    // swap: amounts and accounts
    const swap = ixs[5]!;
    expect(swap.data.readBigUInt64LE(8)).toBe(amountIn);
    expect(swap.data.readBigUInt64LE(16)).toBe(built.quote.minAmountOut);
    expect(swap.keys[2]!.pubkey.equals(ctx.pool)).toBe(true);
    expect(swap.keys[3]!.pubkey.equals(ctx.userWrappedSolAta)).toBe(true);
    expect(swap.keys[4]!.pubkey.equals(ctx.userCoinAta)).toBe(true);
    expect(swap.keys[9]!.pubkey.equals(ctx.user)).toBe(true);
    expect(swap.keys[12]!.pubkey.equals(ctx.referralTokenAccount)).toBe(true);
    // the fixture config has enableFirstSwapWithMinFee: the instructions sysvar is appended
    expect(swap.keys[15]!.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)).toBe(true);
    // unwrap to the user
    expect(ixs[6]!.data[0]).toBe(9); // CloseAccount
    expect(ixs[6]!.keys[0]!.pubkey.equals(ctx.userWrappedSolAta)).toBe(true);
    expect(ixs[6]!.keys[1]!.pubkey.equals(ctx.user)).toBe(true);
    // platform fee: exactly 30 bps of the SOL spent, to the platform fee wallet
    const fee = transferOf(ixs[7]!);
    expect(fee.fromPubkey.equals(ctx.user)).toBe(true);
    expect(fee.toPubkey.equals(ctx.platformFeeWallet)).toBe(true);
    expect(fee.lamports).toBe(30_000n);
    expect(built.quote.fees.platformFee).toBe(30_000n);

    // one signer (the user, fee payer), v0 message, within the size limit
    const message = built.transaction.message;
    expect(message.version).toBe(0);
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(message.staticAccountKeys[0]!.equals(ctx.user)).toBe(true);
    expect(built.sizeBytes).toBe(built.transaction.serialize().length);
    expect(built.sizeBytes).toBeLessThanOrEqual(SWAP_MAX_TRANSACTION_BYTES);
    expect(built.transaction.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    expect(built.recentBlockhash).toBe(ctx.recentBlockhash);
    expect(built.newCoinAccountRentLamports).toBe(RENT.tokenAccount);
    expect(built.estimatedNetworkFeeLamports).toBe(5_000n);
  });

  it('skips the coin ATA when it exists and adds the priority fee when given', () => {
    const ctx = makeContext({ coinHeld: 0n });
    const built = buildSwapTransaction(ctx, {
      side: 'buy',
      amountIn: SOL / 100n,
      slippage: { slippageBps: 100 },
      priorityFeeMicroLamports: 50_000,
      computeUnitLimit: 120_000,
    });
    const ixs = instructionsOf(built);
    expect(ixs.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))).toHaveLength(1);
    expect(ixs[0]!.data.readUInt32LE(1)).toBe(120_000);
    expect(ixs[1]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ixs[1]!.data[0]).toBe(3); // SetComputeUnitPrice
    expect(ixs[1]!.data.readBigUInt64LE(1)).toBe(50_000n);
    expect(built.newCoinAccountRentLamports).toBe(0n);
    expect(built.estimatedNetworkFeeLamports).toBe(5_000n + 6_000n);
  });

  it('lays out a sell: compute budget, wrapped SOL ATA, swap, unwrap, platform fee on the quote', () => {
    const held = 50_000_000_000n;
    const ctx = makeContext({ coinHeld: held });
    const amountIn = held / 2n;
    const built = buildSwapTransaction(ctx, {
      side: 'sell',
      amountIn,
      slippage: { slippageBps: 100 },
    });
    const ixs = instructionsOf(built);
    expect(ixs.map((ix) => ix.programId.toBase58())).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    const swap = ixs[2]!;
    expect(swap.data.readBigUInt64LE(8)).toBe(amountIn);
    expect(swap.keys[3]!.pubkey.equals(ctx.userCoinAta)).toBe(true);
    expect(swap.keys[4]!.pubkey.equals(ctx.userWrappedSolAta)).toBe(true);
    expect(swap.keys[12]!.pubkey.equals(ctx.referralTokenAccount)).toBe(true);
    const fee = transferOf(ixs[4]!);
    expect(fee.toPubkey.equals(ctx.platformFeeWallet)).toBe(true);
    expect(fee.lamports).toBe(platformFeeLamports(built.quote.expectedAmountOut));
    expect(built.sizeBytes).toBeLessThanOrEqual(SWAP_MAX_TRANSACTION_BYTES);
  });

  it('refuses to sell more coins than held, and buys the wallet cannot pay for', () => {
    expectSwapError(
      () =>
        buildSwapTransaction(makeContext({ coinHeld: 1_000_000_000n }), {
          side: 'sell',
          amountIn: 1_000_000_001n,
          slippage: { slippageBps: 100 },
        }),
      'INSUFFICIENT_TOKEN_BALANCE',
    );
    expectSwapError(
      () =>
        buildSwapTransaction(makeContext(), {
          side: 'sell',
          amountIn: 1_000_000_000n,
          slippage: { slippageBps: 100 },
        }),
      'INSUFFICIENT_TOKEN_BALANCE',
    );
    const amountIn = SOL / 100n;
    const peak = 5_000n + RENT.tokenAccount + RENT.tokenAccount + amountIn;
    const final =
      5_000n + RENT.tokenAccount + amountIn + platformFeeLamports(amountIn) + RENT.system;
    const exact = peak > final ? peak : final;
    expectSwapError(
      () =>
        buildSwapTransaction(makeContext({ userLamports: exact - 1n }), {
          side: 'buy',
          amountIn,
          slippage: { slippageBps: 100 },
        }),
      'INSUFFICIENT_SOL_BALANCE',
    );
    const built = buildSwapTransaction(makeContext({ userLamports: exact }), {
      side: 'buy',
      amountIn,
      slippage: { slippageBps: 100 },
    });
    expect(built.requiredLamports).toBe(exact);
  });

  it('validates the build options', () => {
    const run = (o: object) =>
      buildSwapTransaction(makeContext(), {
        side: 'buy',
        amountIn: SOL / 100n,
        slippage: { slippageBps: 100 },
        ...o,
      });
    expectSwapError(() => run({ computeUnitLimit: 0 }), 'INVALID_PARAMS');
    expectSwapError(() => run({ computeUnitLimit: 1_400_001 }), 'INVALID_PARAMS');
    expectSwapError(() => run({ priorityFeeMicroLamports: -1 }), 'INVALID_PARAMS');
    expectSwapError(() => run({ priorityFeeMicroLamports: 10_000_001 }), 'INVALID_PARAMS');
  });
});

describe('transaction size check', () => {
  const payer = key();
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const manyTransfers = (recipients: PublicKey[]) =>
    recipients.map((toPubkey) =>
      SystemProgram.transfer({ fromPubkey: payer, toPubkey, lamports: 1n }),
    );

  it('refuses a transaction above 1,232 bytes', () => {
    const recipients = Array.from({ length: 40 }, key);
    const e = expectSwapError(
      () =>
        compileSwapTransaction({ payer, instructions: manyTransfers(recipients), recentBlockhash }),
      'TRANSACTION_TOO_LARGE',
    );
    expect(e.details.limit).toBe(1232);
    expect(e.message).toMatch(/addressLookupTables/);
  });

  it('measures just over the limit, signature placeholder included', () => {
    // 1 signature (65) + v0 message: find a recipient count that lands just above 1,232 bytes.
    let n = 1;
    let last = 0;
    for (; n < 40; n++) {
      try {
        last = compileSwapTransaction({
          payer,
          instructions: manyTransfers(Array.from({ length: n }, key)),
          recentBlockhash,
        }).sizeBytes;
      } catch (error) {
        expect((error as SwapError).code).toBe('TRANSACTION_TOO_LARGE');
        break;
      }
    }
    expect(last).toBeLessThanOrEqual(1232);
    expect(last).toBeGreaterThan(1232 - 80);
  });

  it('fits once compiled against an address lookup table', () => {
    const recipients = Array.from({ length: 40 }, key);
    const table = new AddressLookupTableAccount({
      key: key(),
      state: {
        deactivationSlot: BigInt('18446744073709551615'),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: recipients,
      },
    });
    const { sizeBytes, transaction } = compileSwapTransaction({
      payer,
      instructions: manyTransfers(recipients),
      recentBlockhash,
      addressLookupTables: [table],
    });
    expect(sizeBytes).toBeLessThanOrEqual(1232);
    expect(transaction.message.addressTableLookups).toHaveLength(1);
  });

  it('passes lookup tables through the swap builder', () => {
    const ctx = makeContext();
    const plain = buildSwapTransaction(ctx, {
      side: 'buy',
      amountIn: SOL / 100n,
      slippage: { slippageBps: 100 },
    });
    const table = new AddressLookupTableAccount({
      key: key(),
      state: {
        deactivationSlot: BigInt('18446744073709551615'),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: [
          DYNAMIC_BONDING_CURVE_PROGRAM_ID,
          deriveDbcPoolAuthority(),
          deriveDbcEventAuthority(),
          ctx.platformFeeWallet,
          ctx.referralTokenAccount,
          NATIVE_MINT,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ],
      },
    });
    const withTable = buildSwapTransaction(ctx, {
      side: 'buy',
      amountIn: SOL / 100n,
      slippage: { slippageBps: 100 },
      addressLookupTables: [table],
    });
    expect(withTable.sizeBytes).toBeLessThan(plain.sizeBytes);
  });
});

// ---------------------------------------------------------------------------------------------
// Addresses: never hard-coded, always from addresses.ts
// ---------------------------------------------------------------------------------------------

describe('no hard-coded address', () => {
  it('has no base58 address literal in swap.ts', () => {
    const source = readFileSync(new URL('./swap.ts', import.meta.url), 'utf8');
    const literals = source.match(/(['"`])[1-9A-HJ-NP-Za-km-z]{32,44}\1/g) ?? [];
    expect(literals).toEqual([]);
    expect(source).not.toMatch(/new PublicKey\(\s*['"`]/);
    expect(source).toMatch(
      /requireAddresses\(\['FORGE_PLATFORM_FEE_WALLET', 'FORGE_METEORA_REFERRAL_ACCOUNT'\]/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Network layer with a mocked connection (no network)
// ---------------------------------------------------------------------------------------------

interface MockChain {
  accounts: Map<string, AccountInfo<Buffer>>;
  calls: string[];
  failOnce?: string;
  /** Answer of getRecentPrioritizationFees (an Error is thrown). */
  priorityFees?: { slot: number; prioritizationFee: number }[] | Error;
  /** Writable accounts the priority fees were asked for. */
  priorityFeeAccounts?: string[];
}

function mockConnection(chain: MockChain) {
  const state = activeState();
  const track = <T>(name: string, value: () => T): Promise<T> => {
    chain.calls.push(name);
    if (chain.failOnce === name) {
      chain.failOnce = undefined;
      return Promise.reject(new TypeError('fetch failed'));
    }
    return Promise.resolve(value());
  };
  return {
    getAccountInfo: (k: PublicKey) =>
      track('getAccountInfo', () => chain.accounts.get(k.toBase58()) ?? null),
    getMultipleAccountsInfo: (ks: PublicKey[]) =>
      track('getMultipleAccountsInfo', () =>
        ks.map((k) => chain.accounts.get(k.toBase58()) ?? null),
      ),
    getLatestBlockhash: () =>
      track('getLatestBlockhash', () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 500,
      })),
    getSlot: () => track('getSlot', () => 1_000),
    getBlockTime: () => track('getBlockTime', () => laterPoint(state.virtualPool).toNumber()),
    getMinimumBalanceForRentExemption: (size: number) =>
      track('getMinimumBalanceForRentExemption', () => (size === 0 ? 890_880 : 2_039_280)),
    getRecentPrioritizationFees: (config?: { lockedWritableAccounts?: PublicKey[] }) =>
      track('getRecentPrioritizationFees', () => {
        chain.priorityFeeAccounts = (config?.lockedWritableAccounts ?? []).map((k) => k.toBase58());
        if (chain.priorityFees instanceof Error) throw chain.priorityFees;
        return chain.priorityFees ?? [];
      }),
  } as unknown as Connection;
}

function chainWithFeeAccounts(
  env: { platform: PublicKey; referral: PublicKey },
  user: PublicKey,
  referralHolder?: PublicKey,
): MockChain {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  accounts.set(ACTIVE_POOL.toBase58(), accountInfo(fixture.accounts.activePool));
  accounts.set(fixture.accounts.activeConfig.address, accountInfo(fixture.accounts.activeConfig));
  accounts.set(MIGRATED_POOL.toBase58(), accountInfo(fixture.accounts.migratedPool));
  accounts.set(
    fixture.accounts.migratedConfig.address,
    accountInfo(fixture.accounts.migratedConfig),
  );
  const r = referralSnapshot(referralHolder ? { holder: referralHolder } : {});
  accounts.set(env.referral.toBase58(), {
    lamports: Number(r.lamports),
    owner: r.owner,
    executable: false,
    data: r.data,
  });
  accounts.set(env.platform.toBase58(), {
    lamports: 10_000_000,
    owner: SystemProgram.programId,
    executable: false,
    data: Buffer.alloc(0),
  });
  accounts.set(user.toBase58(), {
    lamports: 1_000_000_000,
    owner: SystemProgram.programId,
    executable: false,
    data: Buffer.alloc(0),
  });
  return { accounts, calls: [] };
}

function feeEnv() {
  const platform = key();
  const referral = key();
  return {
    platform,
    referral,
    env: {
      FORGE_PLATFORM_FEE_WALLET: platform.toBase58(),
      FORGE_METEORA_REFERRAL_ACCOUNT: referral.toBase58(),
    },
  };
}

describe('buildBuyTx / buildSellTx — priority fee', () => {
  const recent = (values: number[]) =>
    values.map((prioritizationFee, i) => ({ slot: 10 + i, prioritizationFee }));

  async function buy(chain: MockChain, f: ReturnType<typeof feeEnv>, user: PublicKey, extra = {}) {
    return buildBuyTx({
      connection: mockConnection(chain),
      pool: ACTIVE_POOL,
      user,
      amountInLamports: SOL / 100n,
      slippageBps: 100,
      env: f.env,
      ...extra,
    });
  }

  it('reads the recent fees of the accounts the swap writes and prices the swap', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    chain.priorityFees = recent([0, 0, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000]);
    const plain = await buy(chainWithFeeAccounts(f, user), f, user);
    const built = await buy(chain, f, user, { priority: {} });

    const ixs = instructionsOf(built);
    expect(ixs[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect([...ixs[0]!.data.subarray(0, 1)]).toEqual([2]);
    expect(ixs[0]!.data.readUInt32LE(1)).toBe(DEFAULT_SWAP_COMPUTE_UNIT_LIMIT);
    expect(ixs[1]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ixs[1]!.data[0]).toBe(3);
    expect(ixs[1]!.data.readBigUInt64LE(1)).toBe(80_000n);
    expect(ixs.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId))).toHaveLength(2);
    // Everything else is the same swap.
    expect(ixs.slice(2).map((ix) => ix.programId.toBase58())).toEqual(
      instructionsOf(plain)
        .slice(1)
        .map((ix) => ix.programId.toBase58()),
    );

    expect(built.priorityFeeMicroLamports).toBe(80_000);
    expect(built.priorityFee).toEqual({
      computeUnitLimit: DEFAULT_SWAP_COMPUTE_UNIT_LIMIT,
      microLamports: 80_000,
      priorityFeeLamports: 12_000n,
      maxLamports: 500_000n,
      source: 'recent_fees',
    });
    expect(built.estimatedNetworkFeeLamports).toBe(5_000n + 12_000n);
    expect(built.requiredLamports - plain.requiredLamports).toBe(12_000n);
    // The price instruction costs 12 bytes: the swap stays far below 1,232 bytes.
    expect(built.sizeBytes).toBe(plain.sizeBytes + 12);
    expect(built.sizeBytes).toBeLessThan(SWAP_MAX_TRANSACTION_BYTES - 300);

    const asked = chain.priorityFeeAccounts!;
    for (const shared of [ACTIVE_POOL, f.platform, f.referral]) {
      expect(asked).toContain(shared.toBase58());
    }
    expect(asked).not.toContain(DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58());
  });

  it('bounds the price by the setting (cost guard)', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    chain.priorityFees = recent([9_000_000]);
    const built = await buy(chain, f, user, { priority: { maxLamports: 30_000n } });
    expect(built.priorityFee.microLamports).toBe(200_000);
    expect(built.priorityFee.priorityFeeLamports).toBe(30_000n);
    expect(built.priorityFee.maxLamports).toBe(30_000n);
  });

  it('prices a sell the same way', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    const state = activeState();
    const coinAta = getAssociatedTokenAddressSync(state.virtualPool.poolState.baseMint, user, true);
    chain.accounts.set(coinAta.toBase58(), {
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM_ID,
      executable: false,
      data: tokenAccountData({
        mint: state.virtualPool.poolState.baseMint,
        owner: user,
        amount: 10n ** 12n,
      }),
    });
    chain.priorityFees = recent([40_000]);
    const built = await buildSellTx({
      connection: mockConnection(chain),
      pool: ACTIVE_POOL,
      user,
      amountInTokens: 10n ** 11n,
      slippageBps: 300,
      env: f.env,
      priority: {},
    });
    expect(built.priorityFee).toMatchObject({ microLamports: 40_000, source: 'recent_fees' });
    expect(instructionsOf(built)[1]!.data.readBigUInt64LE(1)).toBe(40_000n);
  });

  it('falls back to the floor when the relay refuses the fee read', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    chain.priorityFees = new Error('method not allowed');
    const built = await buy(chain, f, user, { priority: {} });
    expect(built.priorityFee).toMatchObject({ microLamports: 10_000, source: 'rpc_unavailable' });
  });

  it('keeps the legacy shape without a setting, and refuses two prices or a bad setting', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    const plain = await buy(chain, f, user);
    expect(chain.calls).not.toContain('getRecentPrioritizationFees');
    expect(instructionsOf(plain)[1]!.programId.equals(ComputeBudgetProgram.programId)).toBe(false);
    expect(plain.priorityFee).toMatchObject({ microLamports: 0, source: 'fixed' });

    const before = chain.calls.length;
    await expectSwapErrorAsync(
      buy(chain, f, user, { priority: {}, priorityFeeMicroLamports: 1 }),
      'INVALID_PARAMS',
    );
    await expectSwapErrorAsync(
      buy(chain, f, user, { priority: { percentile: 101 } }),
      'INVALID_PARAMS',
    );
    expect(chain.calls.length).toBe(before);
  });

  it('refuses a priority setting in the pure builder (it has no connection)', () => {
    const user = key();
    const ctx = makeContext({ user });
    expectSwapError(
      () =>
        buildSwapTransaction(ctx, {
          side: 'buy',
          amountIn: SOL / 100n,
          slippage: { slippageBps: 100 },
          priority: {},
        }),
      'INVALID_PARAMS',
    );
  });
});

describe('buildBuyTx / buildSellTx / quoteSwap (mocked RPC)', () => {
  it('builds a buy with the fee accounts read from the environment', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    const built = await buildBuyTx({
      connection: mockConnection(chain),
      pool: ACTIVE_POOL.toBase58(),
      user,
      amountInLamports: SOL / 100n,
      slippageBps: 100,
      env: f.env,
    });
    expect(built.platformFeeWallet.equals(f.platform)).toBe(true);
    expect(built.referralTokenAccount.equals(f.referral)).toBe(true);
    const ixs = instructionsOf(built);
    const fee = transferOf(ixs[ixs.length - 1]!);
    expect(fee.toPubkey.equals(f.platform)).toBe(true);
    expect(fee.lamports).toBe(30_000n);
    const swap = ixs.find((ix) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))!;
    expect(swap.keys[12]!.pubkey.equals(f.referral)).toBe(true);
    expect(chain.calls).toContain('getBlockTime');
  });

  it('builds a sell and refuses one on a migrated pool', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    const state = activeState();
    const coinAta = getAssociatedTokenAddressSync(state.virtualPool.poolState.baseMint, user, true);
    const data = tokenAccountData({
      mint: state.virtualPool.poolState.baseMint,
      owner: user,
      amount: 10n ** 12n,
    });
    chain.accounts.set(coinAta.toBase58(), {
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM_ID,
      executable: false,
      data,
    });
    const connection = mockConnection(chain);
    const built = await buildSellTx({
      connection,
      pool: ACTIVE_POOL,
      user,
      amountInTokens: 10n ** 11n,
      minAmountOut: 1n,
      env: f.env,
    }).catch((e: unknown) => e);
    // minAmountOut: 1 is far below the 25% slippage cap
    expect((built as SwapError).code).toBe('SLIPPAGE_TOO_HIGH');
    const ok = await buildSellTx({
      connection,
      pool: ACTIVE_POOL,
      user,
      amountInTokens: 10n ** 11n,
      slippageBps: 300,
      env: f.env,
    });
    expect(ok.quote.side).toBe('sell');
    await expectSwapErrorAsync(
      buildSellTx({
        connection,
        pool: MIGRATED_POOL,
        user,
        amountInTokens: 1_000n,
        slippageBps: 100,
        env: f.env,
      }),
      'POOL_GRADUATED',
    );
  });

  it('fails fast without the FORGE addresses or with bad parameters, before any RPC call', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    const connection = mockConnection(chain);
    await expect(
      buildBuyTx({
        connection,
        pool: ACTIVE_POOL,
        user,
        amountInLamports: SOL / 100n,
        slippageBps: 100,
        env: {},
      }),
    ).rejects.toBeInstanceOf(ForgeAddressError);
    await expectSwapErrorAsync(
      buildBuyTx({
        connection,
        pool: ACTIVE_POOL,
        user,
        amountInLamports: 0n,
        slippageBps: 100,
        env: f.env,
      }),
      'INVALID_PARAMS',
    );
    await expectSwapErrorAsync(
      buildBuyTx({
        connection,
        pool: ACTIVE_POOL,
        user,
        amountInLamports: SOL,
        env: f.env,
      } as never),
      'INVALID_PARAMS',
    );
    expect(chain.calls).toEqual([]);
    await expectSwapErrorAsync(
      buildBuyTx({
        connection,
        pool: 'not-a-key',
        user,
        amountInLamports: SOL / 100n,
        slippageBps: 100,
        env: f.env,
      }),
      'INVALID_PARAMS',
    );
  });

  it('refuses a platform fee wallet that is not rent-exempt (devnet finding)', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    chain.accounts.delete(f.platform.toBase58());
    const connection = mockConnection(chain);
    await expectSwapErrorAsync(
      buildBuyTx({
        connection,
        pool: ACTIVE_POOL,
        user,
        amountInLamports: SOL / 100n,
        slippageBps: 100,
        env: f.env,
      }),
      'PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT',
    );
    await expectSwapErrorAsync(
      assertSwapFeeAccountsReady({ connection, env: f.env }),
      'PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT',
    );
    chain.accounts.set(f.platform.toBase58(), {
      lamports: 890_880,
      owner: SystemProgram.programId,
      executable: false,
      data: Buffer.alloc(0),
    });
    await expect(assertSwapFeeAccountsReady({ connection, env: f.env })).resolves.toBeUndefined();
  });

  it('refuses accounts that are not plain DBC pools', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    const fake = key();
    chain.accounts.set(fake.toBase58(), {
      ...accountInfo(fixture.accounts.activePool),
      owner: SystemProgram.programId,
    });
    const configAsPool = new PublicKey(fixture.accounts.activeConfig.address);
    const connection = mockConnection(chain);
    await expectSwapErrorAsync(fetchSwapPoolState(connection, fake), 'UNSUPPORTED_POOL');
    await expectSwapErrorAsync(fetchSwapPoolState(connection, configAsPool), 'UNSUPPORTED_POOL');
    await expectSwapErrorAsync(fetchSwapPoolState(connection, key()), 'POOL_NOT_FOUND');
  });

  it('quotes for display and retries a transient RPC failure', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    chain.failOnce = 'getAccountInfo';
    const q = await quoteSwap({
      connection: mockConnection(chain),
      pool: ACTIVE_POOL,
      side: 'buy',
      amountIn: SOL / 100n,
    });
    expect(q.fees.platformFee).toBe(30_000n);
    expect(q.fees.referralFee).toBe(4_000n);
    expect(q.minAmountOut).toBe(q.expectedAmountOut);
    expect(chain.calls.filter((c) => c === 'getAccountInfo').length).toBe(3); // 1 failed + pool + config
  });

  it('does not retry a non-transient RPC error and keeps it as the cause', async () => {
    const connection = {
      getAccountInfo: vi.fn().mockRejectedValue(new Error('Invalid param: WrongSize')),
    } as unknown as Connection;
    const e = await expectSwapErrorAsync(fetchSwapPoolState(connection, ACTIVE_POOL), 'RPC_ERROR');
    expect((e.cause as Error).message).toMatch(/WrongSize/);
    expect(connection.getAccountInfo).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Slippage cap, allowed configs, fee account ownership
// ---------------------------------------------------------------------------------------------

describe('slippage cap', () => {
  it('is 25%, given in bps or implied by a minimum output', () => {
    expect(MAX_SWAP_SLIPPAGE_BPS).toBe(2_500);
    const state = activeState();
    const request = { side: 'buy' as const, amountIn: SOL / 100n };
    expectSwapError(
      () => computeSwapQuote(state, { ...request, slippage: { slippageBps: 2_501 } }),
      'INVALID_PARAMS',
    );
    const quote = computeSwapQuote(state, { ...request, slippage: { slippageBps: 2_500 } });
    const floor = minAmountOutForSlippage(quote.expectedAmountOut, 2_500);
    expect(quote.minAmountOut).toBe(floor);
    expect(
      computeSwapQuote(state, { ...request, slippage: { minAmountOut: floor } }).minAmountOut,
    ).toBe(floor);
    expectSwapError(
      () => computeSwapQuote(state, { ...request, slippage: { minAmountOut: floor - 1n } }),
      'SLIPPAGE_TOO_HIGH',
    );
  });
});

describe('allowedConfigs', () => {
  const activeConfig = () => new PublicKey(fixture.accounts.activeConfig.address);

  it('builds and quotes a pool whose config is allowed (key or base58)', async () => {
    const f = feeEnv();
    const user = key();
    const connection = mockConnection(chainWithFeeAccounts(f, user));
    const built = await buildBuyTx({
      connection,
      pool: ACTIVE_POOL,
      user,
      amountInLamports: SOL / 100n,
      slippageBps: 100,
      env: f.env,
      allowedConfigs: [key(), activeConfig()],
    });
    expect(built.quote.side).toBe('buy');
    const quote = await quoteSwap({
      connection,
      pool: ACTIVE_POOL,
      side: 'buy',
      amountIn: SOL / 100n,
      allowedConfigs: [activeConfig().toBase58()],
    });
    expect(quote.amountIn).toBe(SOL / 100n);
  });

  it('refuses a pool of another config before reading it, on every entry point', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    const connection = mockConnection(chain);
    const other = [key()];
    const buy = await expectSwapErrorAsync(
      buildBuyTx({
        connection,
        pool: ACTIVE_POOL,
        user,
        amountInLamports: SOL / 100n,
        slippageBps: 100,
        env: f.env,
        allowedConfigs: other,
      }),
      'POOL_NOT_ALLOWED',
    );
    expect(buy.details.config).toBe(activeConfig().toBase58());
    // Only the first batch (pool, fee accounts, user) was read: never the pool's config.
    expect(chain.calls.filter((c) => c === 'getMultipleAccountsInfo')).toHaveLength(1);
    await expectSwapErrorAsync(
      buildSellTx({
        connection,
        pool: ACTIVE_POOL,
        user,
        amountInTokens: 1_000n,
        slippageBps: 100,
        env: f.env,
        allowedConfigs: other,
      }),
      'POOL_NOT_ALLOWED',
    );
    await expectSwapErrorAsync(
      quoteSwap({
        connection,
        pool: ACTIVE_POOL,
        side: 'buy',
        amountIn: 1_000n,
        allowedConfigs: other,
      }),
      'POOL_NOT_ALLOWED',
    );
    await expectSwapErrorAsync(
      fetchSwapPoolState(connection, ACTIVE_POOL, 'confirmed', { allowedConfigs: [] }),
      'POOL_NOT_ALLOWED',
    );
  });

  it('refuses an invalid allowed config before any RPC call', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    await expectSwapErrorAsync(
      buildBuyTx({
        connection: mockConnection(chain),
        pool: ACTIVE_POOL,
        user,
        amountInLamports: SOL / 100n,
        slippageBps: 100,
        env: f.env,
        allowedConfigs: ['not-a-key'],
      }),
      'INVALID_PARAMS',
    );
    expect(chain.calls).toEqual([]);
    expect(() => assertPoolConfigAllowed(ACTIVE_POOL, activeConfig(), undefined)).not.toThrow();
  });
});

describe('fee account ownership', () => {
  it('requires the exact platform fee wallet, as a system account, when it is expected', () => {
    const wallet = key();
    expect(() =>
      assertPlatformFeeWalletReady(wallet, systemAccount(RENT.system), RENT.system, wallet),
    ).not.toThrow();
    expectSwapError(
      () => assertPlatformFeeWalletReady(wallet, systemAccount(RENT.system), RENT.system, key()),
      'PLATFORM_FEE_WALLET_MISMATCH',
    );
    expectSwapError(
      () =>
        assertPlatformFeeWalletReady(
          wallet,
          { ...systemAccount(RENT.tokenAccount), owner: TOKEN_PROGRAM_ID },
          RENT.system,
          wallet,
        ),
      'PLATFORM_FEE_WALLET_MISMATCH',
    );
    const ctx = makeContext();
    const request = { side: 'buy' as const, amountIn: SOL / 100n, slippage: { slippageBps: 100 } };
    expectSwapError(
      () => buildSwapTransaction(ctx, request, { platformFeeWallet: key() }),
      'PLATFORM_FEE_WALLET_MISMATCH',
    );
    expect(
      buildSwapTransaction(ctx, request, { platformFeeWallet: ctx.platformFeeWallet })
        .platformFeeWallet,
    ).toBe(ctx.platformFeeWallet);
  });

  it('requires the referral account to be held by the expected owner', () => {
    const multisig = key();
    const a = key();
    expect(() =>
      assertReferralAccountReady(a, referralSnapshot({ holder: multisig }), multisig),
    ).not.toThrow();
    expectSwapError(
      () => assertReferralAccountReady(a, referralSnapshot({ holder: key() }), multisig),
      'REFERRAL_ACCOUNT_INVALID',
    );
    // Without an expected owner (no FORGE_REVENUE_WALLET), any holder is accepted.
    expect(() => assertReferralAccountReady(a, referralSnapshot(), null)).not.toThrow();
    const ctx = makeContext({ referralTokenAccountInfo: referralSnapshot({ holder: key() }) });
    expectSwapError(
      () =>
        buildSwapTransaction(
          ctx,
          { side: 'buy', amountIn: SOL / 100n, slippage: { slippageBps: 100 } },
          { referralOwner: multisig },
        ),
      'REFERRAL_ACCOUNT_INVALID',
    );
  });

  it('checks the referral holder against FORGE_REVENUE_WALLET when the env has it', async () => {
    const f = feeEnv();
    const user = key();
    // The revenue wallet is the platform fee wallet (D34): it must hold the referral account.
    const revenue = f.platform;
    const env = { ...f.env, FORGE_REVENUE_WALLET: revenue.toBase58() };
    const params = {
      pool: ACTIVE_POOL,
      user,
      amountInLamports: SOL / 100n,
      slippageBps: 100,
      env,
    };
    const held = mockConnection(chainWithFeeAccounts(f, user, revenue));
    await expect(buildBuyTx({ ...params, connection: held })).resolves.toBeDefined();
    await expect(assertSwapFeeAccountsReady({ connection: held, env })).resolves.toBeUndefined();
    expect(swapFeeAddresses(env).revenueWallet?.equals(revenue)).toBe(true);
    expect(swapFeeAddresses(f.env).revenueWallet).toBeNull();

    const foreign = mockConnection(chainWithFeeAccounts(f, user, key()));
    await expectSwapErrorAsync(
      buildBuyTx({ ...params, connection: foreign }),
      'REFERRAL_ACCOUNT_INVALID',
    );
    await expectSwapErrorAsync(
      assertSwapFeeAccountsReady({ connection: foreign, env }),
      'REFERRAL_ACCOUNT_INVALID',
    );
    // Without FORGE_REVENUE_WALLET the holder is not checked (a browser that was not given it).
    await expect(buildBuyTx({ ...params, env: f.env, connection: foreign })).resolves.toBeDefined();
    // A value that is set must be a valid key.
    await expect(
      buildBuyTx({ ...params, env: { ...f.env, FORGE_REVENUE_WALLET: 'nope' }, connection: held }),
    ).rejects.toBeInstanceOf(ForgeAddressError);
  });

  it('refuses a platform fee wallet that is not the revenue wallet when the env has it', async () => {
    const f = feeEnv();
    const user = key();
    const other = key();
    const env = { ...f.env, FORGE_REVENUE_WALLET: other.toBase58() };
    const error = expectSwapError(() => swapFeeAddresses(env), 'PLATFORM_FEE_WALLET_MISMATCH');
    expect(error.message).toContain('FORGE_REVENUE_WALLET');
    expect(error.message).not.toContain(other.toBase58());
    // Even with every account in order on-chain: the configuration itself is refused.
    const held = mockConnection(chainWithFeeAccounts(f, user, other));
    await expectSwapErrorAsync(
      buildBuyTx({
        pool: ACTIVE_POOL,
        user,
        amountInLamports: SOL / 100n,
        slippageBps: 100,
        env,
        connection: held,
      }),
      'PLATFORM_FEE_WALLET_MISMATCH',
    );
    await expectSwapErrorAsync(
      assertSwapFeeAccountsReady({ connection: held, env }),
      'PLATFORM_FEE_WALLET_MISMATCH',
    );
  });

  it('refuses a platform fee wallet owned by a program', async () => {
    const f = feeEnv();
    const user = key();
    const chain = chainWithFeeAccounts(f, user);
    chain.accounts.set(f.platform.toBase58(), {
      lamports: 10_000_000,
      owner: TOKEN_PROGRAM_ID,
      executable: false,
      data: Buffer.alloc(0),
    });
    await expectSwapErrorAsync(
      buildBuyTx({
        connection: mockConnection(chain),
        pool: ACTIVE_POOL,
        user,
        amountInLamports: SOL / 100n,
        slippageBps: 100,
        env: f.env,
      }),
      'PLATFORM_FEE_WALLET_MISMATCH',
    );
  });
});
