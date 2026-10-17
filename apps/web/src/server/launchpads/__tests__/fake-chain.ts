import {
  ClaimError,
  priorityFeeInstructions,
  type ClaimTxResult,
  type CoinOfConfig,
  type PoolCreationFeeClaimTxResult,
  type PriorityFeeQuote,
} from '@forge/core';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { RpcUnavailableError } from '../../jobs/chain';
import type { ClaimsChain } from '../chain';

/* In-memory ClaimsChain: coins per config, claim results per pool. No network. */

export function coin(
  config: PublicKey,
  partnerQuote: bigint,
  overrides: { pool?: PublicKey; partnerBase?: bigint; baseMint?: PublicKey | string } = {},
): CoinOfConfig {
  const zero = { base: 0n, quote: 0n };
  return {
    pool: overrides.pool ?? Keypair.generate().publicKey,
    config,
    baseMint:
      overrides.baseMint === undefined
        ? Keypair.generate().publicKey
        : new PublicKey(overrides.baseMint),
    creator: Keypair.generate().publicKey,
    graduation: 'trading',
    progress: { bps: 0, quoteReserve: 0n, migrationQuoteThreshold: 10_000_000_000n },
    fees: {
      claimable: {
        partner: { base: overrides.partnerBase ?? 0n, quote: partnerQuote },
        creator: zero,
      },
      protocolUnclaimed: zero,
      lifetime: { trading: zero, protocol: zero },
      creatorTradingFeePercentage: 25,
    },
    poolCreationFee: {
      totalLamports: 0n,
      partnerShareLamports: 0n,
      partnerClaimed: false,
      partnerUnclaimedLamports: 0n,
    },
  };
}

function claimTx(
  owner: PublicKey,
  instructions: number,
  priorityFee: PriorityFeeQuote | null = null,
): Transaction {
  const tx = new Transaction({
    feePayer: owner,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  });
  if (priorityFee) tx.add(...priorityFeeInstructions(priorityFee));
  for (let i = 0; i < instructions; i++) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: Keypair.generate().publicKey,
        lamports: i + 1,
      }),
    );
  }
  return tx;
}

export class FakeClaimsChain implements ClaimsChain {
  coins = new Map<string, CoinOfConfig[]>();
  /** Pools whose trading claim is skipped as not worthwhile. */
  belowCost = new Set<string>();
  /** Partner pool creation fee claimable per pool (lamports). */
  poolCreationFees = new Map<string, bigint>();
  /** Instructions of a pool creation fee claim (to exceed the size limit in tests). */
  pcfInstructions = 1;
  /** Priority fees the core would have put on the trading and pool creation fee claims. */
  priorityFees: { trading: PriorityFeeQuote | null; pcf: PriorityFeeQuote | null } = {
    trading: null,
    pcf: null,
  };
  calls: string[] = [];
  failList: Error | null = null;
  claimError: ClaimError | null = null;

  async assertCluster(): Promise<void> {
    this.calls.push('assertCluster');
  }

  async listCoins(config: PublicKey): Promise<CoinOfConfig[]> {
    this.calls.push(`list:${config.toBase58()}`);
    if (this.failList) throw this.failList;
    return this.coins.get(config.toBase58()) ?? [];
  }

  private find(pool: PublicKey): CoinOfConfig | undefined {
    for (const list of this.coins.values()) {
      const hit = list.find((c) => c.pool.equals(pool));
      if (hit) return hit;
    }
    return undefined;
  }

  async buildPartnerClaim(pool: PublicKey, owner: PublicKey): Promise<ClaimTxResult> {
    this.calls.push(`partner:${pool.toBase58()}`);
    if (this.claimError) throw this.claimError;
    const found = this.find(pool);
    const claimable = found?.fees.claimable.partner ?? { base: 0n, quote: 0n };
    // Like core: the priority fee is part of the network fee the payer pays.
    const networkFee = 5000n + (this.priorityFees.trading?.priorityFeeLamports ?? 0n);
    const costs = {
      networkFeeLamports: networkFee,
      receiverTokenAccountRentLamports: 0n,
      temporaryLamports: 2_039_280n,
      payerTotalLamports: networkFee,
      payerRequiredBalanceLamports: networkFee + 2_039_280n,
    };
    const summary = {
      kind: 'partner' as const,
      pool,
      baseMint: found?.baseMint ?? pool,
      claimer: owner,
      receiver: owner,
      payer: owner,
      claimable,
      receiverQuoteLamports: claimable.quote,
      quoteIsExact: false,
      costs,
      netLamports: claimable.quote - networkFee,
      existingWsolLamports: 0n,
      priorityFee: this.priorityFees.trading,
    };
    const skip = this.belowCost.has(pool.toBase58())
      ? 'not_worthwhile'
      : claimable.quote === 0n && claimable.base === 0n
        ? 'nothing_to_claim'
        : null;
    if (skip) return { transaction: null, lastValidBlockHeight: null, skipReason: skip, summary };
    return {
      transaction: claimTx(owner, 4, this.priorityFees.trading),
      lastValidBlockHeight: 100,
      skipReason: null,
      summary,
    };
  }

  async buildPoolCreationFeeClaim(
    pool: PublicKey,
    owner: PublicKey,
  ): Promise<PoolCreationFeeClaimTxResult> {
    this.calls.push(`pcf:${pool.toBase58()}`);
    if (this.failList instanceof RpcUnavailableError) throw this.failList;
    const fee = this.poolCreationFees.get(pool.toBase58()) ?? 0n;
    const summary = {
      pool,
      config: pool,
      feeClaimer: owner,
      receiver: owner,
      payer: owner,
      poolCreationFeeLamports: fee,
      partnerShareLamports: fee,
      alreadyClaimed: fee === 0n,
      claimableLamports: fee,
      networkFeeLamports: fee > 0n ? 5000n : 0n,
      netLamports: fee > 0n ? fee - 5000n : 0n,
      priorityFee: fee > 0n ? this.priorityFees.pcf : null,
    };
    if (fee === 0n) {
      return {
        transaction: null,
        lastValidBlockHeight: null,
        skipReason: 'already_claimed',
        summary,
      };
    }
    return {
      transaction: claimTx(owner, this.pcfInstructions, this.priorityFees.pcf),
      lastValidBlockHeight: 100,
      skipReason: null,
      summary,
    };
  }
}
