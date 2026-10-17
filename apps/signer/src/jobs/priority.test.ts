import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { buildSolTransferTx } from '../core-adapter.js';
import { buildRevokeNonceTx, REVOKE_COMPUTE_UNITS } from '../routes/revoke.js';
import { assertRevokeNonceTx } from '../routes/policy.js';
import { parseRuntimeEnv } from '../runtime/env.js';
import {
  DEFAULT_SIGNER_PRIORITY_FEE,
  NO_PRIORITY_FEES,
  PRIORITY_FEES_OFF,
  SOL_TRANSFER_COMPUTE_UNITS,
  createPriorityFees,
  signerBudgetInstructions,
} from './priority.js';
import {
  JobError,
  MAX_SIGNER_PRIORITY_FEE_LAMPORTS,
  assertComputeBudgetSet,
  assertSolTransferTx,
} from './shared.js';

const key = () => Keypair.generate().publicKey;
const recent = (...values: number[]) =>
  values.map((prioritizationFee, slot) => ({ slot, prioritizationFee }));

function reader(answer: ReturnType<typeof recent> | Error) {
  const calls: PublicKey[][] = [];
  return {
    calls,
    getRecentPrioritizationFees: vi.fn(
      async (config?: { lockedWritableAccounts?: PublicKey[] }) => {
        calls.push(config?.lockedWritableAccounts ?? []);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    ),
  };
}

describe('createPriorityFees', () => {
  it('prices from the recent fees of the accounts a transaction writes, within the caps', async () => {
    const fees = reader(recent(0, 200_000, 300_000, 5_000_000));
    const priority = createPriorityFees(fees);
    const a = key();
    const b = key();
    const quote = await priority.quote([a, b], SOL_TRANSFER_COMPUTE_UNITS);
    expect(fees.calls).toEqual([[a, b]]);
    // 75th percentile 300,000, under the 1,000,000 cap per CU.
    expect(quote).toMatchObject({ microLamports: 300_000, source: 'recent_fees' });
    expect(quote.priorityFeeLamports).toBe(9_000n);
    expect(priority.setting).toEqual({
      percentile: 75,
      floorMicroLamports: 0,
      maxMicroLamports: 1_000_000,
      maxLamports: 500_000n,
    });
    expect(priority.maxFeeLamports(SOL_TRANSFER_COMPUTE_UNITS)).toBe(30_000n);
    // The cap of the whole transaction binds (price rounded down: 499,999 lamports).
    expect(priority.maxFeeLamports(1_400_000)).toBe(499_999n);
  });

  it('falls back to the floor (SIGNER_PRIORITY_FEE_MICRO_LAMPORTS) when the fees cannot be read', async () => {
    const config = { ...DEFAULT_SIGNER_PRIORITY_FEE, floorMicroLamports: 5_000 };
    const failing = createPriorityFees(reader(new Error('429')), config);
    expect(await failing.quote([key()], 100_000)).toMatchObject({
      microLamports: 5_000,
      source: 'rpc_unavailable',
    });
    const none = createPriorityFees(null, config);
    expect((await none.quote([key()], 100_000)).microLamports).toBe(5_000);
  });

  it('gives a fixed price when the floor is the cap', async () => {
    const fixed = createPriorityFees(reader(recent(900_000)), {
      ...DEFAULT_SIGNER_PRIORITY_FEE,
      floorMicroLamports: 20_000,
      maxMicroLamports: 20_000,
    });
    expect((await fixed.quote([key()], 100_000)).microLamports).toBe(20_000);
  });

  it('is off with a zero cap: no setting for core, no price, no buffer', async () => {
    const fees = reader(recent(500_000));
    const off = createPriorityFees(fees, PRIORITY_FEES_OFF);
    expect(off.setting).toBeUndefined();
    const quote = await off.quote([key()], 100_000);
    expect(quote.microLamports).toBe(0);
    expect(fees.calls).toHaveLength(0);
    expect(off.maxFeeLamports(100_000)).toBe(0n);
    expect(signerBudgetInstructions(quote)).toEqual([]);
    expect(NO_PRIORITY_FEES.setting).toBeUndefined();
  });

  it('refuses a configuration beyond the hard ceilings', () => {
    for (const config of [
      { ...DEFAULT_SIGNER_PRIORITY_FEE, maxMicroLamports: 1_000_001 },
      { ...DEFAULT_SIGNER_PRIORITY_FEE, floorMicroLamports: 2_000_000 },
      { ...DEFAULT_SIGNER_PRIORITY_FEE, percentile: 101 },
      { ...DEFAULT_SIGNER_PRIORITY_FEE, maxLamports: MAX_SIGNER_PRIORITY_FEE_LAMPORTS + 1n },
    ]) {
      expect(() => createPriorityFees(null, config)).toThrow(JobError);
    }
  });
});

describe('priority fees on the signer transactions and their policies', () => {
  const from = key();
  const to = key();
  const blockhash = key().toBase58();

  async function pricedTransfer(): Promise<Transaction> {
    const quote = await createPriorityFees(reader(recent(40_000))).quote(
      [from, to],
      SOL_TRANSFER_COMPUTE_UNITS,
    );
    const tx = buildSolTransferTx({ from, to, lamports: 1_000n, memo: 'm' });
    tx.instructions.unshift(...signerBudgetInstructions(quote));
    tx.feePayer = from;
    tx.recentBlockhash = blockhash;
    return tx;
  }

  it('puts the unit limit then the price first, accepted by the transfer policy', async () => {
    const tx = await pricedTransfer();
    expect(tx.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(tx.instructions[0]!.data.readUInt32LE(1)).toBe(SOL_TRANSFER_COMPUTE_UNITS);
    expect(tx.instructions[1]!.data.readBigUInt64LE(1)).toBe(40_000n);
    expect(() => assertSolTransferTx(tx, { from, to, lamports: 1_000n, memo: 'm' })).not.toThrow();
  });

  it.each([
    ['a second price', ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), /duplicate/],
    ['a second limit', ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }), /duplicate/],
    [
      'a heap frame request',
      ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 }),
      /not allowed/,
    ],
  ])('refuses %s', async (_name, extra, message) => {
    const tx = await pricedTransfer();
    tx.instructions.splice(2, 0, extra);
    expect(() => assertSolTransferTx(tx, { from, to, lamports: 1_000n, memo: 'm' })).toThrow(
      message,
    );
  });

  it('refuses a priority fee above the ceiling of a signer transaction', () => {
    // 1.4M CU at 1,000,000 micro-lamports: 0.0014 SOL, above 0.001 SOL.
    const expensive = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
    ];
    expect(() => assertComputeBudgetSet(expensive)).toThrow(/priority fee too high/);
    // Without a limit the fee is counted for 1.4M CU.
    expect(() =>
      assertComputeBudgetSet([
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 800_000 }),
      ]),
    ).toThrow(/priority fee too high/);
    expect(() =>
      assertComputeBudgetSet([
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 700_000 }),
      ]),
    ).not.toThrow();
  });

  it('prices the launch revocation, accepted by its policy', async () => {
    const payer = key();
    const nonceAccount = key();
    const authority = key();
    const priorityFee = await createPriorityFees(reader(recent(100_000))).quote(
      [payer, nonceAccount],
      REVOKE_COMPUTE_UNITS,
    );
    const tx = buildRevokeNonceTx({
      payer,
      nonceAccount,
      authority,
      blockhash,
      lastValidBlockHeight: 10,
      priorityFee,
    });
    expect(tx.instructions).toHaveLength(3);
    expect(() => assertRevokeNonceTx(tx, { payer, nonceAccount, authority })).not.toThrow();
    const doubled = buildRevokeNonceTx({
      payer,
      nonceAccount,
      authority,
      blockhash,
      lastValidBlockHeight: 10,
      priorityFee,
    });
    doubled.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
    expect(() => assertRevokeNonceTx(doubled, { payer, nonceAccount, authority })).toThrow(
      /duplicate/,
    );
  });
});

describe('SIGNER_PRIORITY_FEE_* environment', () => {
  const base = {
    RPC_URL: 'https://api.devnet.solana.com',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests-only',
    SIGNER_KEYSTORE_PASSPHRASE: 'p'.repeat(40),
    SIGNER_COIN_METADATA_URL: 'https://meta.forge.test/{slug}.json',
    NODE_ENV: 'test',
  };

  it('parses the floor, the caps and the percentile', () => {
    expect(
      parseRuntimeEnv({
        ...base,
        SIGNER_PRIORITY_FEE_MICRO_LAMPORTS: '1000',
        SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS: '200000',
        SIGNER_PRIORITY_FEE_PERCENTILE: '90',
        SIGNER_PRIORITY_FEE_MAX_LAMPORTS: '250000',
      }).priorityFee,
    ).toEqual({
      floorMicroLamports: 1_000,
      maxMicroLamports: 200_000,
      percentile: 90,
      maxLamports: 250_000n,
    });
    expect(parseRuntimeEnv(base).priorityFee).toEqual(DEFAULT_SIGNER_PRIORITY_FEE);
  });

  it('refuses a floor above the cap and caps beyond the ceilings, naming the variables', () => {
    for (const [overrides, name] of [
      [
        {
          SIGNER_PRIORITY_FEE_MICRO_LAMPORTS: '5000',
          SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS: '10',
        },
        'SIGNER_PRIORITY_FEE_MICRO_LAMPORTS',
      ],
      [
        { SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS: '1000001' },
        'SIGNER_PRIORITY_FEE_MAX_MICRO_LAMPORTS',
      ],
      [{ SIGNER_PRIORITY_FEE_PERCENTILE: '101' }, 'SIGNER_PRIORITY_FEE_PERCENTILE'],
      [{ SIGNER_PRIORITY_FEE_MAX_LAMPORTS: '1000001' }, 'SIGNER_PRIORITY_FEE_MAX_LAMPORTS'],
    ] as const) {
      expect(() => parseRuntimeEnv({ ...base, ...overrides })).toThrow(name);
    }
  });
});
