import {
  ClaimError,
  DbcReadError,
  MAX_TRANSACTION_BYTES,
  MAX_TRANSACTION_COMPUTE_UNITS,
  maxPriceForBudget,
  priorityFeeInstructions,
  priorityFeeLamports,
  serializeTransactionBase64,
  transactionSize,
  type ClaimTxResult,
  type CoinOfConfig,
  type PoolCreationFeeClaimTxResult,
} from '@forge/core';
import { LaunchpadSpec, SolanaAddress } from '@forge/shared';
import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import { NOT_FOUND_MESSAGES, RouteError } from '../jobs/http';
import { errorName, type RoutesLogger } from '../jobs/log';
import type { LaunchpadRecord, RoutesStore } from '../jobs/store';
import type { ClaimsChain } from './chain';
import { officialCoinsOfCoinConfig } from './coins';

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
 *
 * Both claims carry a priority fee (chain.ts, `CLAIM_PRIORITY_FEE`). Merged, they keep one unit
 * limit (the sum of both) and one unit price (the trading claim's, lowered if needed so the
 * priority fee stays within the same cap): a transaction with two of either would fail.
 *
 * Pools: every pool of the launchpad config, and on the coin config only the launchpad's own coin
 * (`launchpads.launchpad_coin_mint`, coins.ts). A look-alike pool someone created on the coin
 * config is never claimed nor accepted as `pool` (404, like a foreign pool).
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
const isComputeBudget = (ix: Transaction['instructions'][number]) =>
  ix.programId.equals(ComputeBudgetProgram.programId);

/**
 * The trading claim and the pool creation fee claim in one transaction, with one compute budget
 * (see the top of this file), or null when it does not fit. `extraPriorityFeeLamports`: what the
 * merged priority fee costs more than the trading claim's alone.
 */
function combine(
  trading: ClaimTxResult,
  pcf: PoolCreationFeeClaimTxResult | null,
  owner: PublicKey,
): { transaction: Transaction; extraPriorityFeeLamports: bigint } | null {
  const first = trading.transaction;
  const second = pcf?.transaction ?? null;
  if (!first || !second || !first.recentBlockhash) return null;
  const merged = new Transaction({
    feePayer: owner,
    blockhash: first.recentBlockhash,
    lastValidBlockHeight: first.lastValidBlockHeight ?? 0,
  });
  const a = trading.summary.priorityFee;
  const b = pcf!.summary.priorityFee;
  let extraPriorityFeeLamports = 0n;
  if (a || b) {
    const priced = (a ?? b)!;
    const units = Math.min(
      MAX_TRANSACTION_COMPUTE_UNITS,
      (a?.computeUnitLimit ?? 0) + (b?.computeUnitLimit ?? 0),
    );
    const microLamports = Math.min(
      priced.microLamports,
      maxPriceForBudget(units, priced.maxLamports),
    );
    merged.add(...priorityFeeInstructions({ computeUnitLimit: units, microLamports }));
    extraPriorityFeeLamports =
      priorityFeeLamports({ units, microLamports }) - (a?.priorityFeeLamports ?? 0n);
  }
  merged.add(
    ...first.instructions.filter((ix) => !isComputeBudget(ix)),
    ...second.instructions.filter((ix) => !isComputeBudget(ix)),
  );
  return transactionSize(merged) <= MAX_TRANSACTION_BYTES
    ? { transaction: merged, extraPriorityFeeLamports }
    : null;
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
    const coinConfig = key(launchpad.launchpadCoinConfig);
    const launchpadConfig = key(launchpad.launchpadConfig);
    if (!coinConfig && !launchpadConfig) {
      throw new RouteError(409, 'NOTHING_TO_CLAIM', 'This launchpad has no fees to claim yet.');
    }
    const owner = new PublicKey(input.wallet);

    try {
      await chain.assertCluster();
      const seen = new Set<string>();
      let coins: CoinOfConfig[] = [];
      const add = (list: readonly CoinOfConfig[]) => {
        for (const coin of list) {
          const id = coin.pool.toBase58();
          if (seen.has(id)) continue;
          seen.add(id);
          coins.push(coin);
        }
      };
      if (coinConfig) {
        // The coin config's only coin is the launchpad's own (coins.ts): look-alikes are left out.
        const launchCoins = officialCoinsOfCoinConfig(
          await chain.listCoins(coinConfig),
          launchpad.launchpadCoinMint,
        );
        if (launchCoins.lookalikes > 0) {
          logger.log('warn', 'coin_config.lookalikes', {
            launchpadId: launchpad.id,
            count: launchCoins.lookalikes,
          });
        }
        add(launchCoins.official);
      }
      if (launchpadConfig) add(await chain.listCoins(launchpadConfig));
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
        const merged = combine(trading.result, pcf?.result ?? null, owner);
        transaction = merged?.transaction ?? trading.result.transaction!;
        tradingLamports = trading.result.summary.receiverQuoteLamports;
        // The owner is the only signer of both claims: merging adds no signature fee, only the
        // priority fee of the larger compute unit limit.
        ownerCost =
          trading.result.summary.costs.payerTotalLamports +
          (merged?.extraPriorityFeeLamports ?? 0n);
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
