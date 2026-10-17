import {
  curveProgress,
  graduationStatus,
  poolSpotPrice,
  type DbcPoolState,
  type GraduationStatus,
} from '@forge/core';
import type { GetGemsTokenListResponse, Pool } from '@/components/Explore/types';
import { WSOL_MINT } from '../../tx/programs';
import type { MintInfo, TokenMetadata } from './accounts';

/**
 * LOCKED ZONE. SERVER ONLY (pulls @forge/core and the DBC SDK). Pure: turns decoded DBC pool
 * states into the coin entries (`Pool`, the data API shape the free zones render) of the on-chain
 * fallback, and splits them into the three market lists.
 *
 * What the chain gives, and what it does not: price, market cap and liquidity come from the pool's
 * `sqrtPrice`, quote reserve and the mint supply (USD through the Pyth SOL/USD price); curve
 * progress and graduation from core (`curveProgress`, `graduationStatus`); the creation time from
 * the pool's activation point. Volumes, price changes, holders and audits need an indexer: they
 * are left undefined (the cards then show no value).
 */

/** Largest number of coins in each on-chain list (the data API pages its lists too). */
export const ONCHAIN_LIST_LIMIT = 30;

/** A trading coin shows in "near graduation" from this curve progress (percent). */
export const NEAR_GRADUATION_MIN_PERCENT = 10;

/** BN (anchor decodes u64 as BN) to bigint. */
function toBigint(value: { toString(): string }): bigint {
  return BigInt(value.toString());
}

/** Average slot time, to date a slot-activated pool (FORGE configs activate by timestamp). */
const SLOT_MS = 400;

/** DBC `ActivationType::Timestamp` (0 is slots). */
const ACTIVATION_TIMESTAMP = 1;

/** The current slot and when it was read, to date slot-activated pools. */
export interface SlotClock {
  slot: number;
  atMs: number;
}

/** Off-chain metadata JSON fields the fallback shows (FORGE writes `{ name, symbol, description, image }`). */
export interface OffchainMetadata {
  image?: string;
  description?: string;
}

/** Everything one coin entry is built from. */
export interface OnchainCoin {
  state: DbcPoolState;
  mint: MintInfo;
  metadata: TokenMetadata | null;
  offchain: OffchainMetadata | null;
}

export interface PoolContext {
  /** SOL price in USD, or null when unknown (USD values are then undefined). */
  solUsd: number | null;
  nowMs: number;
  slotClock?: SlotClock | null;
}

/** Creation time of a pool (ms), from its activation point; null when it cannot be dated. */
export function poolCreatedAtMs(state: DbcPoolState, slotClock?: SlotClock | null): number | null {
  const point = Number(toBigint(state.virtualPool.poolState.activationPoint));
  if (!Number.isFinite(point) || point <= 0) return null;
  if (state.config.activationType === ACTIVATION_TIMESTAMP) return point * 1000;
  if (!slotClock) return null;
  return slotClock.atMs - Math.max(0, slotClock.slot - point) * SLOT_MS;
}

function iso(ms: number | null | undefined): string | undefined {
  return ms === null || ms === undefined || !Number.isFinite(ms)
    ? undefined
    : new Date(ms).toISOString();
}

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/** Whole-token amount of a raw amount, as a float (display only). */
function whole(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** The coin entry of one pool, in the data API shape. */
export function toPool(coin: OnchainCoin, ctx: PoolContext): Pool {
  const { state, mint, metadata, offchain } = coin;
  const poolState = state.virtualPool.poolState;
  const graduation = graduationStatus(state);
  const progress = curveProgress(state);
  const isSolQuote = state.config.quoteMint.toBase58() === WSOL_MINT;
  const priceInSol = poolSpotPrice(poolState.sqrtPrice, mint.decimals, 9);
  const usdPrice = isSolQuote && ctx.solUsd !== null ? priceInSol * ctx.solUsd : undefined;
  const supply = whole(mint.supply, mint.decimals);
  const mcap = usdPrice === undefined ? undefined : usdPrice * supply;
  const liquidity =
    isSolQuote && ctx.solUsd !== null && graduation !== 'migrated'
      ? whole(toBigint(poolState.quoteReserve), 9) * ctx.solUsd
      : undefined;
  const createdAt = iso(poolCreatedAtMs(state, ctx.slotClock)) ?? iso(ctx.nowMs)!;
  const finished = Number(toBigint(poolState.finishCurveTimestamp));
  const graduatedAt =
    graduation === 'trading' ? undefined : finished > 0 ? iso(finished * 1000) : createdAt;
  const id = poolState.baseMint.toBase58();

  return {
    id: state.address.toBase58(),
    chain: 'solana',
    dex: 'met-dbc',
    type: 'dbc',
    createdAt,
    bondingCurve: progress.bps / 100,
    volume24h: undefined,
    isUnreliable: undefined,
    updatedAt: iso(ctx.nowMs)!,
    baseAsset: {
      id,
      name: metadata?.name || shortMint(id),
      symbol: metadata?.symbol || shortMint(id),
      icon: offchain?.image,
      decimals: mint.decimals,
      dev: poolState.creator.toBase58(),
      circSupply: supply,
      totalSupply: supply,
      tokenProgram: mint.tokenProgram,
      launchpad: 'met-dbc',
      graduatedAt,
      usdPrice,
      mcap,
      fdv: mcap,
      liquidity,
      organicScoreLabel: 'low',
    },
  };
}

/** The pools each list shows, before any metadata is read (the lists are bounded). */
export interface ListedStates {
  recent: DbcPoolState[];
  aboutToGraduate: DbcPoolState[];
  graduated: DbcPoolState[];
}

/**
 * Splits pools into the three market lists, as the data API does: `recent` the trading coins,
 * newest first; `aboutToGraduate` the trading coins from `NEAR_GRADUATION_MIN_PERCENT`, highest
 * progress first; `graduated` the coins whose curve is complete (migrated or migrating), latest
 * first. Each list holds at most `limit` pools.
 */
export function selectListed(
  states: readonly DbcPoolState[],
  options: { limit?: number; slotClock?: SlotClock | null } = {},
): ListedStates {
  const limit = options.limit ?? ONCHAIN_LIST_LIMIT;
  const rows = states.map((state) => ({
    state,
    graduation: graduationStatus(state) as GraduationStatus,
    bps: curveProgress(state).bps,
    created: poolCreatedAtMs(state, options.slotClock) ?? 0,
    finished: Number(toBigint(state.virtualPool.poolState.finishCurveTimestamp)) * 1000,
  }));
  const trading = rows.filter((r) => r.graduation === 'trading');
  const recent = [...trading].sort((a, b) => b.created - a.created);
  const near = trading
    .filter((r) => r.bps >= NEAR_GRADUATION_MIN_PERCENT * 100)
    .sort((a, b) => b.bps - a.bps || b.created - a.created);
  const graduated = rows
    .filter((r) => r.graduation !== 'trading')
    .sort((a, b) => (b.finished || b.created) - (a.finished || a.created));
  const take = (list: typeof rows) => list.slice(0, limit).map((r) => r.state);
  return { recent: take(recent), aboutToGraduate: take(near), graduated: take(graduated) };
}

/** The three lists as coin entries; a pool without its built entry (mint unreadable) is dropped. */
export function toLists(
  listed: ListedStates,
  entries: ReadonlyMap<string, Pool>,
): Required<GetGemsTokenListResponse> {
  const pick = (states: DbcPoolState[]) => ({
    pools: states
      .map((s) => entries.get(s.address.toBase58()))
      .filter((p): p is Pool => p !== undefined),
  });
  return {
    recent: pick(listed.recent),
    aboutToGraduate: pick(listed.aboutToGraduate),
    graduated: pick(listed.graduated),
  };
}
