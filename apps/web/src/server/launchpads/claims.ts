import {
  ClaimError,
  DbcReadError,
  MAX_TRANSACTION_BYTES,
  serializeTransactionBase64,
  transactionSize,
  type ClaimTxResult,
  type CoinOfConfig,
  type PoolCreationFeeClaimTxResult,
} from '@forge/core';
import { LaunchpadSpec, SolanaAddress } from '@forge/shared';
import { PublicKey, Transaction } from '@solana/web3.js';
import { NOT_FOUND_MESSAGES, RouteError } from '../jobs/http';
import { errorName, type RoutesLogger } from '../jobs/log';
import type { LaunchpadRecord, RoutesStore } from '../jobs/store';
import type { ClaimsChain } from './chain';

/*
 * GET /api/launchpads/:id/claim-transaction — the client's partner fees (docs/DECISIONS.md D19:
 * the client wallet is `feeClaimer` and `leftoverReceiver` of both configs of its launchpad).
 *
 * The owner wallet signs, pays the network fee and receives the fees. One transaction per call,
 * for one pool: the one with the most partner trading fees (`buildPartnerClaimTx` of
 * @forge/core), plus, when it fits in the same transaction, the partner share of that pool's
 * creation fee (`buildPartnerPoolCreationFeeClaimTx`). Both instruction sets are taken unchanged
 * from @forge/core; they are only placed in one transaction with the same fee payer. When no pool
 * has trading fees worth claiming, the first unclaimed pool creation fee is returned instead.
 * `remainingPools` tells the dashboard whether another claim is left after this one.
 *
 * A claim that would cost the owner more than it collects (`minNetLamports: 0`) is skipped.
 */

/** Pools tried for trading fees before giving up (an empty build is cheap, but bounded). */
export const MAX_TRADING_CLAIM_ATTEMPTS = 3;
/** Pools scanned for an unclaimed pool creation fee (one account read each). */
export const MAX_POOL_CREATION_FEE_SCAN = 10;

export interface ClaimTransactionView {
  /** Unsigned transaction (base64), fee payer = the owner. */
  transaction: string;
  summary: {
    pool: string;
    /** SOL partner trading fees collected (lower bound: the claim is uncapped). */
    tradingFeesLamports: string;
    /** Partner share of the pool creation fee collected by this transaction. */
    poolCreationFeeLamports: string;
    /** Network fee plus one-time account rent the owner pays. */
    ownerCostLamports: string;
    /** Other pools with fees left to claim after this transaction (at least). */
    remainingPools: number;
  };
}

export interface ClaimsServiceDeps {
  store: RoutesStore;
  chain: ClaimsChain;
  logger: RoutesLogger;
}

export interface ClaimsService {
  getClaimTransaction(input: {
    wallet: string;
    launchpadId: string;
    pool?: string;
  }): Promise<ClaimTransactionView>;
}

function key(value: string | null): PublicKey | null {
  if (!value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function hasTradingFees(coin: CoinOfConfig): boolean {
  const { quote, base } = coin.fees.claimable.partner;
  return quote > 0n || base > 0n;
}

function byClaimable(a: CoinOfConfig, b: CoinOfConfig): number {
  const qa = a.fees.claimable.partner.quote;
  const qb = b.fees.claimable.partner.quote;
  if (qa !== qb) return qa > qb ? -1 : 1;
  const ba = a.fees.claimable.partner.base;
  const bb = b.fees.claimable.partner.base;
  if (ba !== bb) return ba > bb ? -1 : 1;
  const pa = a.pool.toBase58();
  const pb = b.pool.toBase58();
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/** Appends the pool creation fee instructions when the result still fits in one packet. */
function combine(
  trading: Transaction,
  pcf: Transaction | null,
  owner: PublicKey,
): Transaction | null {
  if (!pcf || !trading.recentBlockhash) return null;
  const merged = new Transaction({
    feePayer: owner,
    blockhash: trading.recentBlockhash,
    lastValidBlockHeight: trading.lastValidBlockHeight ?? 0,
  });
  merged.add(...trading.instructions, ...pcf.instructions);
  return transactionSize(merged) <= MAX_TRANSACTION_BYTES ? merged : null;
}

export function createClaimsService(deps: ClaimsServiceDeps): ClaimsService {
  const { store, chain, logger } = deps;

  function mapCoreError(error: unknown, launchpad: LaunchpadRecord): never {
    if (error instanceof ClaimError) {
      logger.log('warn', 'claim.refused', { launchpadId: launchpad.id, code: error.code });
      if (error.code === 'claimer_wsol_not_empty') {
        throw new RouteError(
          409,
          'TRANSACTION_REJECTED',
          'Your wallet holds wrapped SOL: unwrap it before claiming your fees.',
          { reason: error.code },
        );
      }
      if (error.code === 'receiver_not_rent_exempt') {
        throw new RouteError(
          409,
          'TRANSACTION_REJECTED',
          'Your wallet needs a small SOL balance before it can receive these fees.',
          { reason: error.code },
        );
      }
      throw new RouteError(
        409,
        'NOTHING_TO_CLAIM',
        'These fees cannot be claimed with this wallet.',
        { reason: error.code },
      );
    }
    if (error instanceof DbcReadError) {
      throw new RouteError(409, 'NOTHING_TO_CLAIM', 'This coin could not be found on-chain.');
    }
    throw error;
  }

  async function getClaimTransaction(input: {
    wallet: string;
    launchpadId: string;
    pool?: string;
  }): Promise<ClaimTransactionView> {
    const launchpad = await store.getOwnedLaunchpad(input.launchpadId, input.wallet);
    if (!launchpad) throw new RouteError(404, 'NOT_FOUND', NOT_FOUND_MESSAGES.launchpad);
    const spec = LaunchpadSpec.safeParse(launchpad.spec);
    if (!spec.success || spec.data.ownerWallet !== input.wallet) {
      logger.log('error', 'launchpad.owner_mismatch', { launchpadId: launchpad.id });
      throw new RouteError(
        403,
        'WRONG_WALLET',
        'This action must be signed with the wallet that owns the launchpad.',
      );
    }
    const configs = [key(launchpad.launchpadCoinConfig), key(launchpad.launchpadConfig)].filter(
      (k): k is PublicKey => k !== null,
    );
    if (configs.length === 0) {
      throw new RouteError(409, 'NOTHING_TO_CLAIM', 'This launchpad has no fees to claim yet.');
    }
    const owner = new PublicKey(input.wallet);

    try {
      await chain.assertCluster();
      const seen = new Set<string>();
      let coins: CoinOfConfig[] = [];
      for (const config of configs) {
        for (const coin of await chain.listCoins(config)) {
          const id = coin.pool.toBase58();
          if (seen.has(id)) continue;
          seen.add(id);
          coins.push(coin);
        }
      }
      if (input.pool !== undefined) {
        coins = coins.filter((c) => c.pool.toBase58() === input.pool);
        if (coins.length === 0) {
          throw new RouteError(404, 'NOT_FOUND', 'This coin does not belong to this launchpad.');
        }
      }
      coins.sort(byClaimable);

      // 1. Trading fees, richest pool first.
      let trading: { coin: CoinOfConfig; result: ClaimTxResult } | null = null;
      let belowCost = false;
      for (const coin of coins.filter(hasTradingFees).slice(0, MAX_TRADING_CLAIM_ATTEMPTS)) {
        const result = await chain.buildPartnerClaim(coin.pool, owner);
        if (result.transaction) {
          trading = { coin, result };
          break;
        }
        if (result.skipReason === 'not_worthwhile') belowCost = true;
      }

      // 2. Pool creation fee: same pool when trading fees were found, otherwise the first pool
      //    with an unclaimed one. Only when the launchpad charges a creation fee.
      let pcf: { coin: CoinOfConfig; result: PoolCreationFeeClaimTxResult } | null = null;
      if (spec.data.poolCreationFeeSol > 0) {
        const targets = trading ? [trading.coin] : coins.slice(0, MAX_POOL_CREATION_FEE_SCAN);
        for (const coin of targets) {
          const result = await chain.buildPoolCreationFeeClaim(coin.pool, owner);
          if (result.transaction) {
            pcf = { coin, result };
            break;
          }
        }
      }

      let transaction: Transaction;
      let tradingLamports = 0n;
      let pcfLamports = 0n;
      let ownerCost = 0n;
      let pool: CoinOfConfig;
      if (trading) {
        pool = trading.coin;
        const merged = combine(trading.result.transaction!, pcf?.result.transaction ?? null, owner);
        transaction = merged ?? trading.result.transaction!;
        tradingLamports = trading.result.summary.receiverQuoteLamports;
        // The owner is the only signer of both claims: merging adds no signature fee.
        ownerCost = trading.result.summary.costs.payerTotalLamports;
        if (merged && pcf) pcfLamports = pcf.result.summary.claimableLamports;
      } else if (pcf) {
        pool = pcf.coin;
        transaction = pcf.result.transaction!;
        pcfLamports = pcf.result.summary.claimableLamports;
        ownerCost = pcf.result.summary.networkFeeLamports;
      } else {
        throw new RouteError(
          409,
          'NOTHING_TO_CLAIM',
          belowCost
            ? 'Your fees are still smaller than the cost of claiming them.'
            : 'There are no fees to claim right now.',
        );
      }
      const poolId = pool.pool.toBase58();
      const remainingPools = coins.filter(
        (c) => c.pool.toBase58() !== poolId && hasTradingFees(c),
      ).length;
      logger.log('info', 'claim.prepared', {
        launchpadId: launchpad.id,
        pool: poolId,
        tradingLamports: tradingLamports.toString(),
        poolCreationFeeLamports: pcfLamports.toString(),
      });
      return {
        transaction: serializeTransactionBase64(transaction),
        summary: {
          pool: SolanaAddress.parse(poolId),
          tradingFeesLamports: tradingLamports.toString(),
          poolCreationFeeLamports: pcfLamports.toString(),
          ownerCostLamports: ownerCost.toString(),
          remainingPools,
        },
      };
    } catch (error) {
      if (error instanceof RouteError) throw error;
      if (error instanceof ClaimError || error instanceof DbcReadError) {
        mapCoreError(error, launchpad);
      }
      logger.log('warn', 'claim.failed', { launchpadId: launchpad.id, error: errorName(error) });
      throw error;
    }
  }

  return { getClaimTransaction };
}
