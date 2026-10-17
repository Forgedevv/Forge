import { randomBytes } from 'node:crypto';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SWAP_COMPUTE_UNIT_LIMIT,
  PLATFORM_FEE_BPS,
  buildDbcSwapInstruction,
  computePriorityFee,
  platformFeeLamports,
  type QuoteSwapParams,
} from '@forge/core';
import {
  DBC_SWAP_DISCRIMINATOR,
  DEFAULT_DBC_COMPUTE_UNIT_LIMIT,
  checkDbcBuyInstructions,
  createDbcDevnetBuybackRoute,
  dbcBuyPrioritySetting,
  type DbcBuyExpectation,
  type DbcRouteCore,
} from './buyback-dbc.js';
import { validateBuyQuote } from './buyback.js';
import { DEFAULT_SIGNER_PRIORITY_FEE, createPriorityFees } from './priority.js';
import type { KeystoreLike } from './shared.js';
import { randomAddress } from './testing.js';

const BOT = Keypair.generate();
const TAKER = BOT.publicKey.toBase58();
const POOL = randomAddress();
const FORGE = randomAddress();
const PLATFORM = randomAddress();
const REFERRAL = randomAddress();
const IN = 20_000_000n;
const MIN_OUT = 995_000n;

const expected: DbcBuyExpectation = {
  bot: BOT.publicKey,
  pool: POOL,
  forgeMint: FORGE,
  platformFeeWallet: PLATFORM,
  referralTokenAccount: REFERRAL,
  inLamports: IN,
  minOutAmount: MIN_OUT,
  maxPriorityFeeLamports: 100_000n,
};

const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, BOT.publicKey, true, TOKEN_PROGRAM_ID);
const coinAta = getAssociatedTokenAddressSync(FORGE, BOT.publicKey, true, TOKEN_PROGRAM_ID);

/** Core's buy layout (swap.ts header), hand-assembled from the same primitives. */
function layout(over: {
  amountIn?: bigint;
  minOut?: bigint;
  fee?: bigint | null;
  price?: number;
  coinAta?: boolean;
} = {}): TransactionInstruction[] {
  const amountIn = over.amountIn ?? IN;
  const fee = over.fee === undefined ? platformFeeLamports(IN, PLATFORM_FEE_BPS) : over.fee;
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 })];
  if (over.price) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: over.price }));
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      BOT.publicKey,
      wsolAta,
      BOT.publicKey,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    ),
  );
  if (over.coinAta ?? true) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        BOT.publicKey,
        coinAta,
        BOT.publicKey,
        FORGE,
        TOKEN_PROGRAM_ID,
      ),
    );
  }
  ixs.push(
    SystemProgram.transfer({ fromPubkey: BOT.publicKey, toPubkey: wsolAta, lamports: amountIn }),
    createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
    buildDbcSwapInstruction(
      {
        config: randomAddress(),
        pool: POOL,
        inputTokenAccount: wsolAta,
        outputTokenAccount: coinAta,
        baseVault: randomAddress(),
        quoteVault: randomAddress(),
        baseMint: FORGE,
        quoteMint: NATIVE_MINT,
        payer: BOT.publicKey,
        tokenBaseProgram: TOKEN_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: REFERRAL,
      },
      amountIn,
      over.minOut ?? MIN_OUT,
      true,
    ),
    createCloseAccountInstruction(wsolAta, BOT.publicKey, BOT.publicKey, [], TOKEN_PROGRAM_ID),
  );
  if (fee !== null && fee > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: BOT.publicKey, toPubkey: PLATFORM, lamports: fee }));
  }
  return ixs;
}

describe('checkDbcBuyInstructions', () => {
  it('accepts core\'s layout and bounds the fees', () => {
    const r = checkDbcBuyInstructions(layout(), expected);
    expect(r).toEqual({
      ok: true,
      feeBoundLamports: 5_000n,
      platformFeeLamports: 60_000n,
      coinProgram: TOKEN_PROGRAM_ID,
    });
    expect(checkDbcBuyInstructions(layout({ coinAta: false }), expected)).toMatchObject({ ok: true });
    expect(checkDbcBuyInstructions(layout({ price: 100 }), expected)).toMatchObject({
      ok: true,
      feeBoundLamports: 5_000n + 15n,
    });
    expect(DBC_SWAP_DISCRIMINATOR).toHaveLength(8);
  });

  it.each<[string, TransactionInstruction[], string]>([
    ['another swap amount', layout({ amountIn: IN + 1n }), 'wrap_transfer'],
    ['a lower minimum output', layout({ minOut: MIN_OUT - 1n }), 'swap_min_out'],
    ['a missing platform fee', layout({ fee: null }), 'platform_fee'],
    ['a wrong platform fee', layout({ fee: 1n }), 'platform_fee'],
    ['a priority fee above the cap', layout({ price: 1_000_000 }), 'priority_fee_too_high'],
    [
      'an extra transfer',
      [
        ...layout(),
        SystemProgram.transfer({ fromPubkey: BOT.publicKey, toPubkey: randomAddress(), lamports: 1n }),
      ],
      'program_not_allowed',
    ],
    [
      'the platform fee before the swap',
      (() => {
        const l = layout();
        const fee = l.pop()!;
        return [l[0]!, fee, ...l.slice(1)];
      })(),
      'instruction_order',
    ],
    [
      'a token approval',
      [
        ...layout(),
        createApproveInstruction(coinAta, randomAddress(), BOT.publicKey, 1n, [], TOKEN_PROGRAM_ID),
      ],
      'program_not_allowed',
    ],
    // Without the swap, the unwrap comes before any swap: refused on order before the final check.
    ['a missing swap', layout().filter((ix) => !ix.data.subarray(0, 8).equals(DBC_SWAP_DISCRIMINATOR)), 'instruction_order'],
  ])('refuses %s', (_name, ixs, reason) => {
    expect(checkDbcBuyInstructions(ixs, expected)).toEqual({ ok: false, reason });
  });

  it('accepts the highest price core can set under the bounded setting, and not one more', () => {
    // The signer's setting with its cap lowered to the buyback's (100,000 lamports): at the
    // route's 150,000 CU core never prices above 666,666 micro-lamports (99,999.9 lamports).
    const setting = dbcBuyPrioritySetting(createPriorityFees(null).setting, 100_000n)!;
    const highest = computePriorityFee({
      recentFees: [{ slot: 1, prioritizationFee: 10_000_000 }],
      computeUnitLimit: DEFAULT_DBC_COMPUTE_UNIT_LIMIT,
      policy: setting,
    });
    expect(highest).toMatchObject({ microLamports: 666_666, priorityFeeLamports: 100_000n });
    expect(checkDbcBuyInstructions(layout({ price: highest.microLamports }), expected)).toEqual({
      ok: true,
      feeBoundLamports: 5_000n + 100_000n,
      platformFeeLamports: 60_000n,
      coinProgram: TOKEN_PROGRAM_ID,
    });
    expect(checkDbcBuyInstructions(layout({ price: 666_667 }), expected)).toEqual({
      ok: false,
      reason: 'priority_fee_too_high',
    });
    expect(DEFAULT_DBC_COMPUTE_UNIT_LIMIT).toBe(DEFAULT_SWAP_COMPUTE_UNIT_LIMIT);
  });

  it('counts a price without a unit limit for the most compute the runtime may apply', () => {
    // 1,400,000 CU at 100 micro-lamports: 140 lamports.
    const noLimit = layout({ price: 100 }).slice(1);
    expect(checkDbcBuyInstructions(noLimit, expected)).toMatchObject({
      ok: true,
      feeBoundLamports: 5_000n + 140n,
    });
    // 1,400,000 CU at 100,000 micro-lamports: 140,000 lamports, above the cap.
    expect(checkDbcBuyInstructions(layout({ price: 100_000 }).slice(1), expected)).toEqual({
      ok: false,
      reason: 'priority_fee_too_high',
    });
  });

  it('refuses a duplicated or misplaced compute budget instruction', () => {
    const l = layout({ price: 100 });
    expect(checkDbcBuyInstructions([l[0]!, ...l], expected)).toEqual({
      ok: false,
      reason: 'duplicate_instruction',
    });
    expect(checkDbcBuyInstructions([l[0]!, l[2]!, l[1]!, ...l.slice(3)], expected)).toEqual({
      ok: false,
      reason: 'instruction_order',
    });
    expect(
      checkDbcBuyInstructions(
        [ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 }), ...l],
        expected,
      ),
    ).toEqual({ ok: false, reason: 'compute_budget' });
  });

  it('refuses a swap on another pool, with another referral account, or paid by another signer', () => {
    const onPool = (pool: PublicKey) => checkDbcBuyInstructions(layout(), { ...expected, pool });
    expect(onPool(randomAddress())).toEqual({ ok: false, reason: 'swap_accounts' });
    expect(
      checkDbcBuyInstructions(layout(), { ...expected, referralTokenAccount: randomAddress() }),
    ).toEqual({ ok: false, reason: 'swap_accounts' });
  });
});

describe('dbcBuyPrioritySetting', () => {
  it('lowers the signer cap per transaction to the buyback cap, never raises it', () => {
    const setting = createPriorityFees(null).setting;
    expect(dbcBuyPrioritySetting(setting, 100_000n)).toEqual({
      percentile: DEFAULT_SIGNER_PRIORITY_FEE.percentile,
      floorMicroLamports: DEFAULT_SIGNER_PRIORITY_FEE.floorMicroLamports,
      maxMicroLamports: DEFAULT_SIGNER_PRIORITY_FEE.maxMicroLamports,
      maxLamports: 100_000n,
    });
    // A buyback cap above the signer's (0.0005 SOL): the signer's stands.
    expect(dbcBuyPrioritySetting(setting, 5_000_000n)?.maxLamports).toBe(500_000n);
    expect(dbcBuyPrioritySetting({ percentile: 90 }, 5_000_000n)?.maxLamports).toBe(500_000n);
  });

  it('gives no price when priority fees are off or the buyback cap is 0', () => {
    expect(dbcBuyPrioritySetting(undefined, 100_000n)).toBeUndefined();
    expect(dbcBuyPrioritySetting(createPriorityFees(null).setting, 0n)).toBeUndefined();
  });
});

describe('createDbcDevnetBuybackRoute', () => {
  function fakeCore(): DbcRouteCore & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      assertCluster: vi.fn(async () => undefined),
      quoteSwap: vi.fn(async (p: QuoteSwapParams) => {
        calls.push(p);
        return {
          side: 'buy' as const,
          pool: POOL,
          baseMint: FORGE,
          amountIn: p.amountIn,
          expectedAmountOut: 1_000_000n,
          minAmountOut: 995_000n,
          slippageBps: 50,
          priceImpactBps: 12,
          fees: {
            poolFeeToken: 'quote' as const,
            tradingFee: 1n,
            protocolFee: 1n,
            referralFee: 1n,
            totalPoolFee: 3n,
            platformFee: platformFeeLamports(p.amountIn, PLATFORM_FEE_BPS),
            platformFeeBps: PLATFORM_FEE_BPS,
          },
          expectedSolDelta: 0n - p.amountIn,
          worstCaseSolDelta: 0n - p.amountIn,
          currentPoint: 1n,
        };
      }),
      buildBuyTx: vi.fn(async (p) => {
        calls.push(p);
        const message = new TransactionMessage({
          payerKey: new PublicKey(p.user),
          recentBlockhash: PublicKey.default.toBase58(),
          instructions: layout({ minOut: p.minAmountOut }),
        }).compileToV0Message();
        return {
          transaction: new VersionedTransaction(message),
          recentBlockhash: PublicKey.default.toBase58(),
          lastValidBlockHeight: 1_150,
        } as never;
      }),
    };
  }

  const env = {
    FORGE_PLATFORM_FEE_WALLET: PLATFORM.toBase58(),
    FORGE_METEORA_REFERRAL_ACCOUNT: REFERRAL.toBase58(),
  };

  it('refuses any cluster but devnet at construction', () => {
    expect(() =>
      createDbcDevnetBuybackRoute({
        connection: {} as Connection,
        pool: POOL,
        forgeMint: FORGE,
        env,
        keystore: {} as KeystoreLike,
        cluster: 'mainnet-beta',
        maxPriorityFeeLamports: 1n,
      }),
    ).toThrow(/only runs on devnet/);
  });

  it('maps a core quote to the shape the job validates and pins the swap to its minimum', async () => {
    const core = fakeCore();
    const route = createDbcDevnetBuybackRoute({
      connection: {} as Connection,
      pool: POOL,
      forgeMint: FORGE,
      env,
      keystore: {} as KeystoreLike,
      cluster: 'devnet',
      maxPriorityFeeLamports: 100_000n,
      core,
    });
    const quote = await route.quotes.quote({
      outputMint: FORGE.toBase58(),
      lamports: IN,
      slippageBps: 50,
      taker: TAKER,
    });
    expect(quote).toMatchObject({
      inputMint: NATIVE_MINT.toBase58(),
      outputMint: FORGE.toBase58(),
      inAmount: IN.toString(),
      outAmount: '1000000',
      otherAmountThreshold: '995000',
      swapMode: 'ExactIn',
      slippageBps: 50,
      priceImpactPct: '0.001200',
    });
    expect(
      validateBuyQuote(quote, { forgeMint: FORGE.toBase58(), lamports: IN }, { maxSlippageBps: 50, maxPriceImpactBps: 100 }),
    ).toBeNull();
    const swap = await route.quotes.swap({ quote, userPublicKey: BOT.publicKey.toBase58() });
    expect(swap.lastValidBlockHeight).toBe(1_150);
    expect(core.buildBuyTx).toHaveBeenCalledWith(
      expect.objectContaining({ amountInLamports: IN, minAmountOut: 995_000n, pool: POOL }),
    );
    // Without the signer's priority fees: no priority setting, core sets the unit limit only.
    expect(core.buildBuyTx).toHaveBeenCalledWith(
      expect.not.objectContaining({ priority: expect.anything() }),
    );
    await expect(
      route.quotes.quote({
        outputMint: randomAddress().toBase58(),
        lamports: IN,
        slippageBps: 50,
        taker: TAKER,
      }),
    ).rejects.toThrow(/another mint/);
  });

  it('has core price the buy with the signer setting bounded by the buyback cap', async () => {
    const core = fakeCore();
    const route = createDbcDevnetBuybackRoute({
      connection: {} as Connection,
      pool: POOL,
      forgeMint: FORGE,
      env,
      keystore: {} as KeystoreLike,
      cluster: 'devnet',
      maxPriorityFeeLamports: 100_000n,
      priorityFees: createPriorityFees(null),
      core,
    });
    const quote = await route.quotes.quote({
      outputMint: FORGE.toBase58(),
      lamports: IN,
      slippageBps: 50,
      taker: TAKER,
    });
    await route.quotes.swap({ quote, userPublicKey: BOT.publicKey.toBase58() });
    expect(core.buildBuyTx).toHaveBeenCalledWith(
      expect.objectContaining({
        computeUnitLimit: DEFAULT_DBC_COMPUTE_UNIT_LIMIT,
        priority: {
          percentile: 75,
          floorMicroLamports: 0,
          maxMicroLamports: 1_000_000,
          maxLamports: 100_000n,
        },
      }),
    );
    // Priority fees off on the signer: no setting reaches core.
    const offFees = createPriorityFees(null, {
      ...DEFAULT_SIGNER_PRIORITY_FEE,
      maxMicroLamports: 0,
    });
    const offCore = fakeCore();
    const off = createDbcDevnetBuybackRoute({
      connection: {} as Connection,
      pool: POOL,
      forgeMint: FORGE,
      env,
      keystore: {} as KeystoreLike,
      cluster: 'devnet',
      maxPriorityFeeLamports: 100_000n,
      priorityFees: offFees,
      core: offCore,
    });
    await off.quotes.swap({ quote, userPublicKey: BOT.publicKey.toBase58() });
    expect(offCore.buildBuyTx).toHaveBeenCalledWith(
      expect.not.objectContaining({ priority: expect.anything() }),
    );
  });

  it('refuses a negative priority fee cap at construction', () => {
    expect(() =>
      createDbcDevnetBuybackRoute({
        connection: {} as Connection,
        pool: POOL,
        forgeMint: FORGE,
        env,
        keystore: {} as KeystoreLike,
        cluster: 'devnet',
        maxPriorityFeeLamports: -1n,
      }),
    ).toThrow(/negative priority fee cap/);
  });

  it('checks the built transaction, simulates it and signs with the keystore', async () => {
    const core = fakeCore();
    const signed: string[] = [];
    const keystore = {
      withSigner: vi.fn(async (_ref: string, fn: (s: unknown) => void) =>
        fn({
          publicKey: BOT.publicKey,
          signTransaction: (tx: VersionedTransaction) => {
            tx.sign([BOT]);
            signed.push('yes');
          },
        }),
      ),
      getPublicKey: vi.fn(),
      findRef: vi.fn(),
    } as unknown as KeystoreLike;
    const simulateTransaction = vi.fn(async (_tx: unknown, cfg: { accounts: { addresses: string[] } }) => ({
      value: {
        err: null,
        accounts: cfg.accounts.addresses.map((address) =>
          address === BOT.publicKey.toBase58()
            ? { owner: SystemProgram.programId.toBase58(), lamports: 79_935_000, data: ['', 'base64'] }
            : null,
        ),
      },
    }));
    const connection = {
      simulateTransaction,
      getTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
      getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({
        context: { slot: 5 },
        value: keys.map((k) =>
          k.equals(BOT.publicKey)
            ? { owner: SystemProgram.programId, lamports: 100_000_000, data: Buffer.alloc(0) }
            : null,
        ),
      })),
    } as unknown as Connection;
    const route = createDbcDevnetBuybackRoute({
      connection,
      pool: POOL,
      forgeMint: FORGE,
      env,
      keystore,
      cluster: 'devnet',
      maxPriorityFeeLamports: 100_000n,
      core,
    });
    const quote = await route.quotes.quote({
      outputMint: FORGE.toBase58(),
      lamports: IN,
      slippageBps: 50,
      taker: TAKER,
    });
    const swap = await route.quotes.swap({ quote, userPublicKey: BOT.publicKey.toBase58() });
    const prepared = await route.swapPreparer.prepare({
      owner: BOT.publicKey,
      ownerRef: 'ks_00000000000000000000000000000000',
      swapTransaction: swap.swapTransaction,
      lastValidBlockHeight: swap.lastValidBlockHeight,
      expected: {
        forgeMint: FORGE.toBase58(),
        inLamports: IN,
        minOutAmount: 995_000n,
        quotedOutAmount: 1_000_000n,
        maxSlippageBps: 50,
      },
    });
    // The simulation shows no $FORGE arriving: refused after the static checks passed.
    expect(prepared).toEqual({ status: 'refused', reason: 'output_below_minimum' });
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(signed).toEqual([]);

    // A transaction built for another amount than the validated quote is refused statically.
    const other = await route.swapPreparer.prepare({
      owner: BOT.publicKey,
      ownerRef: 'ks_00000000000000000000000000000000',
      swapTransaction: swap.swapTransaction,
      expected: {
        forgeMint: FORGE.toBase58(),
        inLamports: IN + 1n,
        minOutAmount: 995_000n,
        quotedOutAmount: 1_000_000n,
        maxSlippageBps: 50,
      },
    });
    expect(other).toEqual({ status: 'refused', reason: 'wrap_transfer' });
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(randomBytes(1)).toHaveLength(1);
  });
});
