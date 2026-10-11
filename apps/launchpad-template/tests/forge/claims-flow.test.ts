import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_CLAIM_COSTS, createMockClaimsCore, mockCoin } from '@/forge/claims/mock-core';
import { claimCosts, executeClaim, prepareClaim, type ClaimDeps } from '@/forge/claims/flow';
import { FIXTURE_LAUNCHPAD_CONFIG } from '@/forge/create/test-fixtures';
import type { CreatorClaimCosts } from '@/forge/claims/core-adapter';

function txWithSigners(count: number): VersionedTransaction {
  const payer = Keypair.generate().publicKey;
  const others = Array.from({ length: count - 1 }, () => Keypair.generate().publicKey);
  const instructions = others.map((from) =>
    SystemProgram.transfer({ fromPubkey: from, toPubkey: payer, lamports: 1 }),
  );
  if (instructions.length === 0) {
    instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }));
  }
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

const costs = (overrides: Partial<CreatorClaimCosts> = {}): CreatorClaimCosts => ({
  ...MOCK_CLAIM_COSTS,
  ...overrides,
});

describe('claimCosts', () => {
  it('uses the core figures as they are', () => {
    expect(claimCosts(txWithSigners(1), costs())).toEqual({
      networkFeeLamports: BigInt(5000),
      coinAccountRentLamports: BigInt(2039280),
      temporaryLamports: BigInt(2039280),
      totalCostLamports: BigInt(2044280),
      requiredBalanceLamports: BigInt(4083560),
    });
  });

  it('raises the network fee to the signature count of the transaction', () => {
    const view = claimCosts(txWithSigners(2), costs());
    expect(view.networkFeeLamports).toBe(BigInt(10000));
    expect(view.totalCostLamports).toBe(BigInt(2049280));
    expect(view.requiredBalanceLamports).toBe(BigInt(4088560));
  });

  it('rejects costs that do not add up or are negative', () => {
    expect(() => claimCosts(txWithSigners(1), costs({ payerTotalLamports: BigInt(5000) }))).toThrow(
      /do not add up/,
    );
    expect(() =>
      claimCosts(txWithSigners(1), costs({ payerRequiredBalanceLamports: BigInt(2044280) })),
    ).toThrow(/do not add up/);
    expect(() => claimCosts(txWithSigners(1), costs({ temporaryLamports: BigInt(-1) }))).toThrow(
      /invalid/,
    );
  });
});

describe('prepareClaim balance check', () => {
  function deps(balance: bigint, wallet: string): ClaimDeps {
    return {
      core: createMockClaimsCore([coin]),
      wallet,
      launchpadConfigs: [FIXTURE_LAUNCHPAD_CONFIG.toBase58()],
      chain: {
        getBalanceLamports: vi.fn().mockResolvedValue(balance),
        sendRawTransaction: vi.fn(),
        getSignatureStatus: vi.fn(),
      },
      signTransaction: vi.fn(),
    } as unknown as ClaimDeps;
  }
  const coin = mockCoin();
  const wallet = Keypair.generate().publicKey.toBase58();

  it('needs the full required balance, not only the network fee', async () => {
    const short = await prepareClaim(coin, deps(BigInt(4083559), wallet));
    expect(short.insufficientBalance).toBe(true);
    expect(short.requiredBalanceLamports).toBe(BigInt(4083560));
    await expect(executeClaim(short, deps(BigInt(4083559), wallet))).rejects.toMatchObject({
      code: 'insufficient_balance',
    });

    const enough = await prepareClaim(coin, deps(BigInt(4083560), wallet));
    expect(enough.insufficientBalance).toBe(false);
    expect(enough.totalCostLamports).toBe(BigInt(2044280));
    expect(enough.coinAccountRentLamports).toBe(BigInt(2039280));
  });
});
