import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  DEFAULT_PRIORITY_FEE_POLICY,
  DEFAULT_SWAP_COMPUTE_UNIT_LIMIT,
  maxPriorityFeeLamports,
} from '@forge/core';
import { describe, expect, it } from 'vitest';
import { SITE_PRIORITY_FEE, SWAP_MAX_PRIORITY_FEE_LAMPORTS } from '../../src/forge/priority-fee';
import { decodeTransaction } from '../../src/forge/tx/decode';
import { VerificationError } from '../../src/forge/tx/errors';
import {
  LAMPORTS_PER_SIGNATURE,
  MAX_PRIORITY_FEE_LAMPORTS,
  networkFeeLamports,
  readComputeBudget,
} from '../../src/forge/tx/fees';
import { MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS } from '../../src/forge/tx/parse';

const payer = Keypair.generate().publicKey;
const transfer = SystemProgram.transfer({
  fromPubkey: payer,
  toPubkey: Keypair.generate().publicKey,
  lamports: 1,
});
const limit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const price = (microLamports: number) =>
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports });

function decoded(instructions: TransactionInstruction[]) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions,
  }).compileToV0Message();
  return decodeTransaction(new VersionedTransaction(message));
}

function refused(instructions: TransactionInstruction[]): string {
  try {
    readComputeBudget(decoded(instructions));
  } catch (error) {
    expect(error).toBeInstanceOf(VerificationError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('site priority fee', () => {
  it('is the core default policy, fixed at build time', () => {
    expect(SITE_PRIORITY_FEE).toEqual({});
    expect(Object.isFrozen(SITE_PRIORITY_FEE)).toBe(true);
    expect(SWAP_MAX_PRIORITY_FEE_LAMPORTS).toBe(
      maxPriorityFeeLamports(DEFAULT_SWAP_COMPUTE_UNIT_LIMIT),
    );
  });

  it('is bounded in the browser checks by the same caps as core', () => {
    expect(MAX_PRIORITY_FEE_LAMPORTS).toBe(DEFAULT_PRIORITY_FEE_POLICY.maxLamports);
    expect(MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS).toBe(
      BigInt(DEFAULT_PRIORITY_FEE_POLICY.maxMicroLamports),
    );
  });
});

describe('readComputeBudget / networkFeeLamports', () => {
  it('accepts a limit and a price within the caps and counts the fee', () => {
    const tx = decoded([limit(300_000), price(1_000_000), transfer]);
    expect(readComputeBudget(tx)).toEqual({ unitLimit: 300_000, microLamports: BigInt(1_000_000) });
    expect(networkFeeLamports(tx)).toBe(LAMPORTS_PER_SIGNATURE + BigInt(300_000));
    expect(networkFeeLamports(decoded([limit(1_000), transfer]))).toBe(LAMPORTS_PER_SIGNATURE);
  });

  it('refuses a duplicated limit or price', () => {
    expect(refused([limit(1_000), limit(2_000), transfer])).toMatch(/Duplicate compute unit limit/);
    expect(refused([limit(1_000), price(1), price(1), transfer])).toMatch(/Duplicate priority fee/);
  });

  it('refuses a price above the cap per compute unit, or a fee above the cap per transaction', () => {
    expect(refused([limit(1_000), price(1_000_001), transfer])).toMatch(/priority fee above/);
    // 600,000 CU x 1,000,000 micro-lamports = 0.0006 SOL > 0.0005 SOL.
    expect(refused([limit(600_000), price(1_000_000), transfer])).toMatch(/above the maximum/);
  });

  it('refuses a price without a limit and any other compute budget instruction', () => {
    expect(refused([price(1_000), transfer])).toMatch(/without a compute unit limit/);
    expect(
      refused([ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 }), transfer]),
    ).toMatch(/compute budget variant/);
    const withAccount = new TransactionInstruction({
      programId: ComputeBudgetProgram.programId,
      keys: [{ pubkey: payer, isSigner: false, isWritable: false }],
      data: limit(1_000).data,
    });
    expect(refused([withAccount, transfer])).toMatch(/compute budget with accounts/);
  });
});
