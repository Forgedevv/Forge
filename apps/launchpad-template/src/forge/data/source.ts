import ky, { HTTPError } from 'ky';
import type {
  GetGemsTokenListIndividualResponse,
  GetGemsTokenListRequest,
  GetTokenDescriptionResponse,
  GetTokenResponse,
  Pool,
} from '@/components/Explore/types';
import { cluster } from '../config';

/**
 * LOCKED ZONE. Where the coin data of the site comes from.
 *
 * - Mainnet: the Jupiter data API (`datapi.jup.ag`) is the primary source. When a request fails
 *   (network error, timeout, 5xx, 429), or a coin list or coin comes back empty, the same data is
 *   read on-chain from this site's `/api/coins` route (`onchain/`). After a failure the data API
 *   is skipped for `JUPITER_COOLDOWN_MS`, then tried again: it stays the primary source.
 * - Devnet: Jupiter does not index devnet, so the data API is never called; the coin data comes
 *   from `/api/coins` only.
 *
 * Chart candles, holders and transactions have no on-chain equivalent here: when the data API is
 * unavailable they fail with `DataUnavailableError`, and the UI shows a "temporarily unavailable"
 * state. Every switch of source is logged once with `console.debug` (no telemetry).
 */

export type DataSource = 'jupiter' | 'chain';

/** The primary source of this site: Jupiter on mainnet, the chain on devnet. */
export function primarySource(value: string = cluster): DataSource {
  return value === 'mainnet-beta' ? 'jupiter' : 'chain';
}

/** Coin data that cannot be served right now (no source answered). Never retried at once. */
export class DataUnavailableError extends Error {
  constructor(message = 'Coin data is temporarily unavailable.') {
    super(message);
    this.name = 'DataUnavailableError';
  }
}

export function isDataUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === 'DataUnavailableError';
}

/** A data API request taking longer than this falls back to the chain. */
export const JUPITER_TIMEOUT_MS = 6_000;
/** After a data API failure, it is skipped for this long, then tried again. */
export const JUPITER_COOLDOWN_MS = 30_000;
/** Timeout of a request to this site's `/api/coins`. */
export const ONCHAIN_TIMEOUT_MS = 15_000;
/** One coin read from `/api/coins` is reused this long (coin info and description share it). */
const COIN_REUSE_MS = 5_000;

const COINS_ROUTE = '/api/coins';

const state = {
  jupiterDownUntil: 0,
  lastSource: new Map<string, DataSource>(),
  coins: new Map<string, { at: number; promise: Promise<OnchainCoinAnswer> }>(),
};

/** Test helper: forgets the cooldown, the logged sources and the reused coins. */
export function resetDataSource(): void {
  state.jupiterDownUntil = 0;
  state.lastSource.clear();
  state.coins.clear();
}

/** True when the data API may be called now (mainnet, outside a cooldown). */
export function jupiterAvailable(now = Date.now()): boolean {
  return primarySource() === 'jupiter' && now >= state.jupiterDownUntil;
}

/** Logs a change of source for one kind of data (once per change). */
export function noteSource(kind: string, source: DataSource, reason?: string): void {
  if (state.lastSource.get(kind) === source) return;
  state.lastSource.set(kind, source);
  console.debug(
    `[forge data] ${kind}: ${source === 'jupiter' ? 'Jupiter data API' : 'on-chain'}${reason ? ` (${reason})` : ''}`,
  );
}

function isAbort(error: unknown, signal?: AbortSignal | null): boolean {
  return !!signal?.aborted || (error instanceof Error && error.name === 'AbortError');
}

/** A data API failure that says the service is down (not a 4xx about this request). */
function isOutage(error: unknown): boolean {
  if (error instanceof HTTPError) {
    const status = error.response.status;
    return status >= 500 || status === 429 || status === 408;
  }
  return true; // network error, timeout, invalid JSON
}

function reasonOf(error: unknown): string {
  if (error instanceof HTTPError) return `HTTP ${error.response.status}`;
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  return 'unreachable';
}

/** Records a failed data API request; an outage starts the cooldown. */
function jupiterFailed(error: unknown): string {
  const reason = reasonOf(error);
  if (isOutage(error)) state.jupiterDownUntil = Date.now() + JUPITER_COOLDOWN_MS;
  return reason;
}

export interface FallbackOptions {
  signal?: AbortSignal | null;
}

/**
 * Runs `primary` (the data API) and falls back to `fallback` (on-chain) on failure, on timeout or
 * when `isEmpty` says the answer holds nothing. An empty answer is kept when the fallback fails.
 * On devnet, or during a cooldown, `fallback` runs alone. A request cancelled by its caller is
 * rethrown as is.
 */
export async function withFallback<T>(
  kind: string,
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  isEmpty: (value: T) => boolean,
  options: FallbackOptions = {},
): Promise<T> {
  if (!jupiterAvailable()) {
    noteSource(kind, 'chain', primarySource() === 'chain' ? 'devnet' : 'data API cooling down');
    return fallback();
  }
  let answer: T;
  try {
    answer = await primary();
  } catch (error) {
    if (isAbort(error, options.signal)) throw error;
    noteSource(kind, 'chain', `data API ${jupiterFailed(error)}`);
    return fallback();
  }
  if (!isEmpty(answer)) {
    noteSource(kind, 'jupiter');
    return answer;
  }
  try {
    const onchain = await fallback();
    noteSource(kind, 'chain', 'data API returned nothing');
    return onchain;
  } catch {
    return answer;
  }
}

/**
 * Runs a data API request that has no on-chain fallback (chart, holders, transactions): fails at
 * once with `DataUnavailableError` on devnet or during a cooldown, and turns any failure into one.
 */
export async function jupiterOnly<T>(
  kind: string,
  primary: () => Promise<T>,
  options: FallbackOptions = {},
): Promise<T> {
  if (!jupiterAvailable()) {
    noteSource(kind, 'chain', primarySource() === 'chain' ? 'devnet' : 'data API cooling down');
    throw new DataUnavailableError();
  }
  try {
    const answer = await primary();
    noteSource(kind, 'jupiter');
    return answer;
  } catch (error) {
    if (isAbort(error, options.signal)) throw error;
    noteSource(kind, 'chain', `data API ${jupiterFailed(error)}`);
    throw new DataUnavailableError();
  }
}

// --- On-chain reads (this site's /api/coins) ------------------------------------------------------

type OnchainListsAnswer = {
  recent?: GetGemsTokenListIndividualResponse;
  aboutToGraduate?: GetGemsTokenListIndividualResponse;
  graduated?: GetGemsTokenListIndividualResponse;
};

interface OnchainCoinAnswer {
  pool: Pool | null;
  description: string | null;
}

function poolsOf(value: unknown): Pool[] {
  const pools = (value as { pools?: unknown } | undefined)?.pools;
  return Array.isArray(pools) ? (pools as Pool[]) : [];
}

/** The requested lists, read on-chain. @throws DataUnavailableError */
export async function onchainLists<T extends GetGemsTokenListRequest>(
  req: T,
): Promise<Record<string, GetGemsTokenListIndividualResponse | undefined>> {
  let answer: OnchainListsAnswer;
  try {
    answer = await ky.get(COINS_ROUTE, { timeout: ONCHAIN_TIMEOUT_MS, retry: 0 }).json();
  } catch {
    throw new DataUnavailableError();
  }
  const lists: Record<string, GetGemsTokenListIndividualResponse | undefined> = {};
  for (const [tab, value] of Object.entries(req)) {
    lists[tab] = value ? { pools: poolsOf(answer[tab as keyof OnchainListsAnswer]) } : undefined;
  }
  return lists;
}

function onchainCoin(mint: string): Promise<OnchainCoinAnswer> {
  const now = Date.now();
  const reused = state.coins.get(mint);
  if (reused && now - reused.at < COIN_REUSE_MS) return reused.promise;
  const promise = ky
    .get(COINS_ROUTE, { searchParams: { mint }, timeout: ONCHAIN_TIMEOUT_MS, retry: 0 })
    .json<OnchainCoinAnswer>()
    .catch(() => {
      state.coins.delete(mint);
      throw new DataUnavailableError();
    });
  state.coins.set(mint, { at: now, promise });
  if (state.coins.size > 50) state.coins.delete(state.coins.keys().next().value as string);
  return promise;
}

/** One coin, read on-chain (empty when it is not a coin of this launchpad). */
export async function onchainToken(mint: string): Promise<GetTokenResponse> {
  const { pool } = await onchainCoin(mint);
  return { pools: pool ? [pool] : [] };
}

/** The description of a coin from its metadata JSON, read on-chain. */
export async function onchainDescription(mint: string): Promise<GetTokenDescriptionResponse> {
  const { description } = await onchainCoin(mint);
  return description ? { description } : {};
}
