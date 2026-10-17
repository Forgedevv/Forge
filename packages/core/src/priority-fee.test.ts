import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ComputeBudgetCheckError,
  DEFAULT_PRIORITY_FEE_POLICY,
  MAX_PRIORITY_FEE_ACCOUNTS,
  MAX_PRIORITY_FEE_LAMPORTS,
  MAX_PRIORITY_FEE_MICRO_LAMPORTS,
  MAX_TRANSACTION_COMPUTE_UNITS,
  checkComputeBudgetInstructions,
  computePriorityFee,
  estimatePriorityFee,
  feePercentile,
  fixedPriorityFee,
  maxPriceForBudget,
  priorityFeeInstructions,
  readRecentPriorityFees,
  resolvePriorityFeePolicy,
  writableAccountsOf,
  type RecentPrioritizationFee,
} from './priority-fee.js';

const fees = (values: number[]): RecentPrioritizationFee[] =>
  values.map((prioritizationFee, i) => ({ slot: 1_000 + i, prioritizationFee }));

const key = () => Keypair.generate().publicKey;

describe('feePercentile', () => {
  it('takes the nearest rank, zeros included', () => {
    const values = [0, 0, 10, 20, 30, 40, 50, 60, 70, 80];
    expect(feePercentile(values, 0)).toBe(0);
    expect(feePercentile(values, 50)).toBe(30);
    expect(feePercentile(values, 75)).toBe(60);
    expect(feePercentile(values, 90)).toBe(70);
    expect(feePercentile(values, 100)).toBe(80);
  });

  it('does not depend on the order and is 0 for an empty list', () => {
    expect(feePercentile([80, 0, 30, 10], 75)).toBe(30);
    expect(feePercentile([], 75)).toBe(0);
    expect(feePercentile([7], 1)).toBe(7);
  });

  it('refuses a percentile outside 0..100', () => {
    expect(() => feePercentile([1], 101)).toThrow(RangeError);
    expect(() => feePercentile([1], -1)).toThrow(RangeError);
    expect(() => feePercentile([1], 50.5)).toThrow(RangeError);
  });
});

describe('resolvePriorityFeePolicy', () => {
  it('fills the mainnet defaults', () => {
    expect(resolvePriorityFeePolicy()).toEqual({
      percentile: 75,
      floorMicroLamports: 10_000,
      maxMicroLamports: 1_000_000,
      maxLamports: 500_000n,
    });
    expect(DEFAULT_PRIORITY_FEE_POLICY.maxLamports).toBe(500_000n); // 0.0005 SOL
  });

  it('keeps the floor under a lower maximum and accepts a disabled fee', () => {
    expect(resolvePriorityFeePolicy({ maxMicroLamports: 0 })).toMatchObject({
      floorMicroLamports: 0,
      maxMicroLamports: 0,
    });
    expect(resolvePriorityFeePolicy({ maxLamports: 0n }).maxLamports).toBe(0n);
  });

  it('refuses values beyond the hard ceilings or inconsistent bounds', () => {
    const bad = [
      { percentile: 101 },
      { floorMicroLamports: -1 },
      { floorMicroLamports: 2_000_000 },
      { maxMicroLamports: MAX_PRIORITY_FEE_MICRO_LAMPORTS + 1 },
      { maxLamports: MAX_PRIORITY_FEE_LAMPORTS + 1n },
      { maxLamports: -1n },
      { maxLamports: 500_000 as unknown as bigint },
    ];
    for (const setting of bad) expect(() => resolvePriorityFeePolicy(setting)).toThrow(RangeError);
  });
});

describe('computePriorityFee', () => {
  it('uses the percentile of the recent fees', () => {
    const quote = computePriorityFee({
      recentFees: fees([0, 0, 20_000, 40_000, 60_000, 80_000, 100_000, 120_000]),
      computeUnitLimit: 150_000,
    });
    expect(quote).toEqual({
      computeUnitLimit: 150_000,
      microLamports: 80_000,
      priorityFeeLamports: 12_000n,
      maxLamports: 500_000n,
      source: 'recent_fees',
    });
  });

  it('applies the floor to quiet slots', () => {
    const quote = computePriorityFee({ recentFees: fees([0, 0, 0, 5]), computeUnitLimit: 150_000 });
    expect(quote.microLamports).toBe(10_000);
    expect(quote.priorityFeeLamports).toBe(1_500n);
    expect(quote.source).toBe('recent_fees');
  });

  it('falls back to the floor on an empty list or an unreadable cluster', () => {
    const empty = computePriorityFee({ recentFees: [], computeUnitLimit: 200_000 });
    expect(empty).toMatchObject({ microLamports: 10_000, source: 'no_recent_fees' });
    const unavailable = computePriorityFee({ recentFees: null, computeUnitLimit: 200_000 });
    expect(unavailable).toMatchObject({ microLamports: 10_000, source: 'rpc_unavailable' });
    expect(
      computePriorityFee({
        recentFees: null,
        computeUnitLimit: 200_000,
        policy: { floorMicroLamports: 0 },
      }).microLamports,
    ).toBe(0);
  });

  it('caps the price per compute unit', () => {
    const quote = computePriorityFee({
      recentFees: fees([50_000_000, 60_000_000]),
      computeUnitLimit: 100_000,
    });
    expect(quote.microLamports).toBe(1_000_000);
    expect(quote.priorityFeeLamports).toBe(100_000n);
  });

  it('caps the fee of the whole transaction, rounding included', () => {
    const quote = computePriorityFee({
      recentFees: fees([1_000_000]),
      computeUnitLimit: 1_400_000,
    });
    // 500,000 lamports / 1.4M CU = 357,142.857... micro-lamports: rounded down.
    expect(quote.microLamports).toBe(357_142);
    expect(quote.priorityFeeLamports).toBeLessThanOrEqual(500_000n);
    for (const units of [1, 3, 7, 150_000, 299_999, 1_399_999]) {
      const q = computePriorityFee({
        recentFees: fees([MAX_PRIORITY_FEE_MICRO_LAMPORTS]),
        computeUnitLimit: units,
        policy: { maxMicroLamports: MAX_PRIORITY_FEE_MICRO_LAMPORTS, maxLamports: 1_234n },
      });
      expect(q.priorityFeeLamports).toBeLessThanOrEqual(1_234n);
    }
  });

  it('lets the cost guard win over the floor', () => {
    const quote = computePriorityFee({
      recentFees: [],
      computeUnitLimit: 1_000_000,
      policy: { floorMicroLamports: 900_000, maxLamports: 100_000n },
    });
    expect(quote.microLamports).toBe(100_000);
    expect(quote.priorityFeeLamports).toBe(100_000n);
  });

  it('ignores malformed entries', () => {
    const quote = computePriorityFee({
      recentFees: [
        { slot: 1, prioritizationFee: -5 },
        { slot: 2, prioritizationFee: Number.NaN },
        { slot: 3, prioritizationFee: 1.5 },
        { slot: 4, prioritizationFee: 30_000 },
      ],
      computeUnitLimit: 100_000,
    });
    expect(quote.microLamports).toBe(30_000);
  });

  it('refuses an invalid compute unit limit', () => {
    for (const units of [0, -1, 1.5, MAX_TRANSACTION_COMPUTE_UNITS + 1]) {
      expect(() => computePriorityFee({ recentFees: [], computeUnitLimit: units })).toThrow(
        RangeError,
      );
    }
  });
});

describe('maxPriceForBudget and fixedPriorityFee', () => {
  it('bounds the price by the fee budget', () => {
    expect(maxPriceForBudget(150_000, 500_000n)).toBe(3_333_333);
    expect(maxPriceForBudget(1, MAX_PRIORITY_FEE_LAMPORTS)).toBe(MAX_PRIORITY_FEE_MICRO_LAMPORTS);
  });

  it('reports a fixed price as is', () => {
    expect(fixedPriorityFee(300_000, 1_000)).toEqual({
      computeUnitLimit: 300_000,
      microLamports: 1_000,
      priorityFeeLamports: 300n,
      maxLamports: 300n,
      source: 'fixed',
    });
  });
});

describe('priorityFeeInstructions', () => {
  it('puts the limit then the price', () => {
    const [limit, price, ...rest] = priorityFeeInstructions({
      computeUnitLimit: 150_000,
      microLamports: 25_000,
    });
    expect(rest).toHaveLength(0);
    expect(limit!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect([...limit!.data]).toEqual([2, 0xf0, 0x49, 0x02, 0x00]);
    expect(price!.data[0]).toBe(3);
    expect(price!.data.readBigUInt64LE(1)).toBe(25_000n);
  });

  it('adds no price instruction for a zero price', () => {
    expect(priorityFeeInstructions({ computeUnitLimit: 150_000, microLamports: 0 })).toHaveLength(
      1,
    );
    expect(
      priorityFeeInstructions({ computeUnitLimit: 150_000, microLamports: 0 }, { priceOnly: true }),
    ).toHaveLength(0);
  });

  it('can put the price alone', () => {
    const ixs = priorityFeeInstructions(
      { computeUnitLimit: MAX_TRANSACTION_COMPUTE_UNITS, microLamports: 300 },
      { priceOnly: true },
    );
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.data[0]).toBe(3);
  });
});

describe('writableAccountsOf', () => {
  it('lists the writable accounts once, in order', () => {
    const [a, b, c] = [key(), key(), key()];
    const ixs = [
      SystemProgram.transfer({ fromPubkey: a, toPubkey: b, lamports: 1 }),
      new TransactionInstruction({
        programId: key(),
        keys: [
          { pubkey: c, isSigner: false, isWritable: false },
          { pubkey: b, isSigner: false, isWritable: true },
        ],
      }),
    ];
    expect(writableAccountsOf(ixs).map((k) => k.toBase58())).toEqual([a.toBase58(), b.toBase58()]);
  });

  it('keeps at most MAX_PRIORITY_FEE_ACCOUNTS', () => {
    const ix = new TransactionInstruction({
      programId: key(),
      keys: Array.from({ length: 40 }, () => ({
        pubkey: key(),
        isSigner: false,
        isWritable: true,
      })),
    });
    expect(writableAccountsOf([ix])).toHaveLength(MAX_PRIORITY_FEE_ACCOUNTS);
  });
});

describe('readRecentPriorityFees / estimatePriorityFee', () => {
  function reader(answer: RecentPrioritizationFee[] | Error) {
    const calls: unknown[] = [];
    return {
      calls,
      connection: {
        getRecentPrioritizationFees: async (config?: { lockedWritableAccounts?: PublicKey[] }) => {
          calls.push(config);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    };
  }

  it('asks for the writable accounts, deduplicated', async () => {
    const a = key();
    const { connection, calls } = reader(fees([1, 2]));
    expect(await readRecentPriorityFees(connection, [a, a])).toHaveLength(2);
    expect((calls[0] as { lockedWritableAccounts: PublicKey[] }).lockedWritableAccounts).toEqual([
      a,
    ]);
    await readRecentPriorityFees(connection, []);
    expect(calls[1]).toBeUndefined();
  });

  it('estimates from the cluster', async () => {
    const { connection } = reader(fees([0, 40_000, 50_000, 60_000]));
    const quote = await estimatePriorityFee({
      connection,
      writableAccounts: [key()],
      computeUnitLimit: 150_000,
    });
    expect(quote).toMatchObject({ microLamports: 50_000, source: 'recent_fees' });
  });

  it('falls back to the floor when the cluster refuses, and says so', async () => {
    const { connection } = reader(new Error('method not allowed'));
    const quote = await estimatePriorityFee({
      connection,
      writableAccounts: [key()],
      computeUnitLimit: 150_000,
      setting: { floorMicroLamports: 20_000 },
    });
    expect(quote).toMatchObject({ microLamports: 20_000, source: 'rpc_unavailable' });
  });

  it('refuses a bad setting before any network call', async () => {
    const { connection, calls } = reader(fees([1]));
    await expect(
      estimatePriorityFee({
        connection,
        writableAccounts: [],
        computeUnitLimit: 150_000,
        setting: { percentile: 200 },
      }),
    ).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe('checkComputeBudgetInstructions', () => {
  const transfer = SystemProgram.transfer({ fromPubkey: key(), toPubkey: key(), lamports: 1 });
  const limit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
  const price = (microLamports: number) =>
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  const code = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ComputeBudgetCheckError);
      return (error as ComputeBudgetCheckError).code;
    }
    return null;
  };

  it('accepts what the builders put and sums the fee', () => {
    expect(checkComputeBudgetInstructions([limit(150_000), price(80_000), transfer])).toEqual({
      computeUnitLimit: 150_000,
      microLamports: 80_000n,
      priorityFeeLamports: 12_000n,
    });
    expect(checkComputeBudgetInstructions([transfer])).toEqual({
      computeUnitLimit: null,
      microLamports: 0n,
      priorityFeeLamports: 0n,
    });
  });

  it('bounds a price without a limit at the transaction compute ceiling', () => {
    expect(checkComputeBudgetInstructions([price(1_000)]).priorityFeeLamports).toBe(1_400n);
    expect(
      code(() =>
        checkComputeBudgetInstructions([price(400_000)], { maxPriorityFeeLamports: 500_000n }),
      ),
    ).toBe('fee_too_high');
  });

  it('refuses duplicates', () => {
    expect(code(() => checkComputeBudgetInstructions([limit(1), limit(2)]))).toBe(
      'duplicate_instruction',
    );
    expect(code(() => checkComputeBudgetInstructions([price(1), limit(1), price(1)]))).toBe(
      'duplicate_instruction',
    );
  });

  it('refuses values above the bounds', () => {
    expect(code(() => checkComputeBudgetInstructions([limit(0)]))).toBe('limit_out_of_range');
    expect(code(() => checkComputeBudgetInstructions([limit(1_400_001)]))).toBe(
      'limit_out_of_range',
    );
    expect(
      code(() =>
        checkComputeBudgetInstructions([limit(1_000), price(2_000_000)], {
          maxMicroLamports: 1_000_000,
        }),
      ),
    ).toBe('price_too_high');
    expect(
      code(() =>
        checkComputeBudgetInstructions([limit(1_000_000), price(1_000_000)], {
          maxPriorityFeeLamports: 999_999n,
        }),
      ),
    ).toBe('fee_too_high');
  });

  it('refuses any other compute budget instruction or encoding', () => {
    const heap = ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 });
    expect(code(() => checkComputeBudgetInstructions([heap]))).toBe('unexpected_instruction');
    const withKey = new TransactionInstruction({
      programId: ComputeBudgetProgram.programId,
      keys: [{ pubkey: key(), isSigner: false, isWritable: false }],
      data: limit(1).data,
    });
    expect(code(() => checkComputeBudgetInstructions([withKey]))).toBe('unexpected_instruction');
    const padded = new TransactionInstruction({
      programId: ComputeBudgetProgram.programId,
      keys: [],
      data: Buffer.concat([price(1).data, Buffer.from([0])]),
    });
    expect(code(() => checkComputeBudgetInstructions([padded]))).toBe('unexpected_instruction');
  });

  it('leaves the same bytes under another program to the caller policy', () => {
    const lookalike = new TransactionInstruction({
      programId: key(),
      keys: [],
      data: price(MAX_PRIORITY_FEE_MICRO_LAMPORTS * 10).data,
    });
    // Not a compute budget instruction: not counted (the caller refuses the unknown program).
    expect(checkComputeBudgetInstructions([lookalike]).microLamports).toBe(0n);
  });
});
