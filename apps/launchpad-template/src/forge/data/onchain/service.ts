import { PublicKey, type Connection } from '@solana/web3.js';
import {
  DbcReadError,
  getDbcPoolState,
  listPoolStatesOfConfig,
  type DbcPoolState,
} from '@forge/core';
import type { GetGemsTokenListResponse, Pool } from '@/components/Explore/types';
import { onchainConfig } from '../../config';
import { canonicalAddress } from '../../tx/programs';
import {
  candidatePools,
  isListedLaunchpadCoin,
  launchpadCoinMint,
  launchpadConfigs,
  listedConfigs,
} from '../../trade/launchpad-pool';
import {
  PYTH_SOL_USD_ACCOUNT,
  decodeMetadata,
  decodeMint,
  decodeSolUsdPrice,
  metadataAddress,
  type MintInfo,
  type RawAccount,
  type TokenMetadata,
} from './accounts';
import { selectListed, toLists, toPool, type OffchainMetadata, type SlotClock } from './pools';

/**
 * LOCKED ZONE. SERVER ONLY. On-chain coin data of this launchpad, read through the FORGE RPC relay
 * (server token) for the `/api/coins` route: the fallback of the Jupiter data API (always used on
 * devnet, which Jupiter does not index).
 *
 * What is read:
 * - the coin list: the DBC pools of the users config, in one config pool scan (core
 *   `listPoolStatesOfConfig`, the SDK's `getPoolsByConfig`; the relay serves it to server tokens
 *   only), plus the launchpad's own coin read directly on the launchpad coin config (that config is
 *   open to anyone: it is never scanned, so look-alikes there cost nothing). Before the on-chain
 *   setup, the configs of `NEXT_PUBLIC_POOL_CONFIG_KEY` are scanned instead (nothing is tradable);
 * - one coin: its pool on this launchpad's configs (derived from the mint, `candidatePools`);
 * - for the listed coins only: the mint (decimals, supply) and its Metaplex metadata (name,
 *   symbol, URI) in `getMultipleAccounts` batches, the Pyth SOL/USD price, and the metadata JSON
 *   (image, description) when it lives on this site's storage (`R2_PUBLIC_URL`): no other host is
 *   ever fetched.
 *
 * Request storms: every result is cached (lists 15 s, one coin 10 s, served stale for up to
 * 5 minutes when the chain cannot be read), concurrent requests share one read, mint metadata is
 * kept 10 minutes and metadata JSON 1 hour, and uncached reads draw from small budgets
 * (`READ_BUDGET`): past them the route answers 503 rather than spend the launchpad's relay quota
 * (which coin creation shares).
 * The route also sets `s-maxage`, so the CDN serves most visitors.
 */

export const LIST_TTL_MS = 15_000;
export const COIN_TTL_MS = 10_000;
/** A cached result is served this long after it expired when a refresh fails. */
export const STALE_MS = 5 * 60_000;
const MINT_TTL_MS = 10 * 60_000;
const OFFCHAIN_TTL_MS = 60 * 60_000;
const SOL_USD_TTL_MS = 30_000;
/** Distinct coins kept in memory (each entry is small). */
const MAX_CACHED_COINS = 500;
/** `getMultipleAccounts` keys per call (the relay's MAX_MULTIPLE_ACCOUNTS). */
export const MAX_KEYS_PER_CALL = 20;
/**
 * Uncached refreshes: a burst, then one every `refillMs`. Lists and coins have their own budget,
 * so requests for unknown mints can never starve the market lists.
 */
export const READ_BUDGET = {
  lists: { capacity: 4, refillMs: 10_000 },
  coins: { capacity: 20, refillMs: 3_000 },
} as const;
const OFFCHAIN_TIMEOUT_MS = 2_500;
const OFFCHAIN_MAX_BYTES = 16 * 1024;
const OFFCHAIN_CONCURRENCY = 4;

/** The chain could not be read (relay error, budget exhausted) and nothing is cached. */
export class OnchainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnchainUnavailableError';
  }
}

export type OnchainLists = Required<GetGemsTokenListResponse>;

export interface OnchainCoinResult {
  pool: Pool | null;
  description: string | null;
}

export interface OnchainCoinService {
  lists(): Promise<OnchainLists>;
  /** Null for an invalid mint address. */
  coin(mint: string): Promise<OnchainCoinResult | null>;
}

export interface OnchainCoinServiceOptions {
  connection: Connection;
  /** Origin of this site's public storage (`R2_PUBLIC_URL`), the only host metadata JSON is read from. */
  storageOrigin: string | null;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Cached<T> {
  value: T;
  at: number;
}

/** Fetches a small JSON document from the storage origin only; null on any failure. */
async function fetchOffchain(
  uri: string,
  storageOrigin: string | null,
  fetchImpl: typeof fetch,
): Promise<OffchainMetadata | null> {
  if (!storageOrigin) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== storageOrigin) return null;
  try {
    const res = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(OFFCHAIN_TIMEOUT_MS),
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > OFFCHAIN_MAX_BYTES) return null;
    const text = await res.text();
    if (text.length > OFFCHAIN_MAX_BYTES) return null;
    const json = JSON.parse(text) as { image?: unknown; description?: unknown };
    const out: OffchainMetadata = {};
    if (typeof json.image === 'string' && /^https:\/\/[^\s]+$/.test(json.image)) {
      try {
        out.image = new URL(json.image).toString();
      } catch {
        // not a URL: no icon
      }
    }
    if (typeof json.description === 'string') out.description = json.description.slice(0, 500);
    return out;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function isMissing(err: unknown): boolean {
  return err instanceof DbcReadError;
}

export function createOnchainCoinService(options: OnchainCoinServiceOptions): OnchainCoinService {
  const { connection, storageOrigin } = options;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  let listCache: Cached<OnchainLists> | null = null;
  let listInFlight: Promise<OnchainLists> | null = null;
  const coinCache = new Map<string, Cached<OnchainCoinResult>>();
  const coinInFlight = new Map<string, Promise<OnchainCoinResult>>();
  const mintCache = new Map<
    string,
    Cached<{ mint: MintInfo | null; metadata: TokenMetadata | null }>
  >();
  const offchainCache = new Map<string, Cached<OffchainMetadata | null>>();
  let solUsdCache: Cached<number | null> | null = null;
  const listBudget = budgetOf(READ_BUDGET.lists, now);
  const coinBudget = budgetOf(READ_BUDGET.coins, now);

  function fresh<T>(entry: Cached<T> | null | undefined, ttl: number): boolean {
    return !!entry && now() - entry.at < ttl;
  }

  async function readAccounts(keys: string[]): Promise<Map<string, RawAccount | null>> {
    const out = new Map<string, RawAccount | null>();
    for (let i = 0; i < keys.length; i += MAX_KEYS_PER_CALL) {
      const chunk = keys.slice(i, i + MAX_KEYS_PER_CALL);
      const infos = await connection.getMultipleAccountsInfo(
        chunk.map((k) => new PublicKey(k)),
        'confirmed',
      );
      chunk.forEach((key, j) => {
        const info = infos[j];
        out.set(key, info ? { owner: info.owner, data: info.data } : null);
      });
    }
    return out;
  }

  /** Builds the coin entries of `states` (mint, metadata, SOL/USD, metadata JSON). */
  async function entries(
    states: readonly DbcPoolState[],
    slotClock: SlotClock | null,
  ): Promise<Map<string, { pool: Pool; description: string | null }>> {
    const mints = [...new Set(states.map((s) => s.virtualPool.poolState.baseMint.toBase58()))];
    const keys: string[] = [];
    for (const mint of mints) {
      if (!fresh(mintCache.get(mint), MINT_TTL_MS)) keys.push(mint, metadataAddress(mint));
    }
    const needSolUsd = !fresh(solUsdCache, SOL_USD_TTL_MS);
    if (needSolUsd) keys.push(PYTH_SOL_USD_ACCOUNT);
    if (keys.length > 0) {
      const accounts = await readAccounts(keys);
      const at = now();
      for (const mint of mints) {
        if (!accounts.has(mint)) continue;
        mintCache.set(mint, {
          value: {
            mint: decodeMint(accounts.get(mint)),
            metadata: decodeMetadata(accounts.get(metadataAddress(mint)), mint),
          },
          at,
        });
      }
      if (needSolUsd) {
        solUsdCache = {
          value: decodeSolUsdPrice(accounts.get(PYTH_SOL_USD_ACCOUNT), Math.floor(at / 1000)),
          at,
        };
      }
      trimCache(mintCache, MAX_CACHED_COINS * 2);
    }

    const uris = new Set<string>();
    for (const mint of mints) {
      const uri = mintCache.get(mint)?.value.metadata?.uri;
      if (uri && !fresh(offchainCache.get(uri), OFFCHAIN_TTL_MS)) uris.add(uri);
    }
    await mapLimit([...uris], OFFCHAIN_CONCURRENCY, async (uri) => {
      offchainCache.set(uri, {
        value: await fetchOffchain(uri, storageOrigin, fetchImpl),
        at: now(),
      });
    });
    trimCache(offchainCache, MAX_CACHED_COINS * 2);

    const ctx = { solUsd: solUsdCache?.value ?? null, nowMs: now(), slotClock };
    const out = new Map<string, { pool: Pool; description: string | null }>();
    for (const state of states) {
      const mintKey = state.virtualPool.poolState.baseMint.toBase58();
      const cached = mintCache.get(mintKey)?.value;
      if (!cached?.mint) continue; // the mint could not be read: the coin is not listed
      const offchain = cached.metadata
        ? (offchainCache.get(cached.metadata.uri)?.value ?? null)
        : null;
      out.set(state.address.toBase58(), {
        pool: toPool({ state, mint: cached.mint, metadata: cached.metadata, offchain }, ctx),
        description: offchain?.description ?? null,
      });
    }
    return out;
  }

  async function slotClockFor(states: readonly DbcPoolState[]): Promise<SlotClock | null> {
    // FORGE configs activate by timestamp: the slot is read only for a slot-activated config.
    if (states.every((s) => s.config.activationType !== 0)) return null;
    const slot = await connection.getSlot('confirmed');
    return { slot, atMs: now() };
  }

  async function readLaunchpadPools(): Promise<DbcPoolState[]> {
    const states: DbcPoolState[] = [];
    const scan = async (config: string) => {
      try {
        states.push(...(await listPoolStatesOfConfig(connection, new PublicKey(config))));
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    };
    if (launchpadConfigs().length > 0) {
      const users = canonicalAddress(onchainConfig?.launchpadConfig);
      if (users) await scan(users);
      // The launchpad coin config is open: only the launchpad coin's own pool is read there.
      const coinMint = launchpadCoinMint();
      if (coinMint) {
        for (const candidate of candidatePools(coinMint)) {
          if (candidate.config === users) continue;
          try {
            states.push(await getDbcPoolState(connection, new PublicKey(candidate.pool)));
          } catch (err) {
            if (!isMissing(err)) throw err;
          }
        }
      }
    } else {
      for (const config of listedConfigs().slice(0, 2)) await scan(config);
    }
    const seen = new Set<string>();
    return states.filter((s) => {
      const id = s.address.toBase58();
      if (seen.has(id)) return false;
      seen.add(id);
      return isListedLaunchpadCoin({
        id,
        baseAsset: { id: s.virtualPool.poolState.baseMint.toBase58() },
      });
    });
  }

  async function buildLists(): Promise<OnchainLists> {
    const states = await readLaunchpadPools();
    const slotClock = await slotClockFor(states);
    const listed = selectListed(states, { slotClock });
    const shown = [
      ...new Map(
        [...listed.recent, ...listed.aboutToGraduate, ...listed.graduated].map((s) => [
          s.address.toBase58(),
          s,
        ]),
      ).values(),
    ];
    const built = await entries(shown, slotClock);
    return toLists(listed, new Map([...built].map(([id, e]) => [id, e.pool])));
  }

  async function buildCoin(mint: string): Promise<OnchainCoinResult> {
    for (const candidate of candidatePools(mint)) {
      let state: DbcPoolState;
      try {
        state = await getDbcPoolState(connection, new PublicKey(candidate.pool));
      } catch (err) {
        if (isMissing(err)) continue;
        throw err;
      }
      if (state.virtualPool.poolState.baseMint.toBase58() !== mint) continue;
      const built = (await entries([state], await slotClockFor([state]))).get(candidate.pool);
      if (built) return built;
    }
    return { pool: null, description: null };
  }

  /** Cached, single-flight, budgeted read with stale-on-error. */
  async function cachedRead<T>(
    cached: Cached<T> | null | undefined,
    ttl: number,
    inFlight: Promise<T> | null | undefined,
    takeBudget: () => boolean,
    start: () => Promise<T>,
  ): Promise<T> {
    if (cached && fresh(cached, ttl)) return cached.value;
    if (inFlight) return inFlight;
    if (!takeBudget()) {
      if (cached && now() - cached.at < ttl + STALE_MS) return cached.value;
      throw new OnchainUnavailableError('on-chain read budget exhausted');
    }
    try {
      return await start();
    } catch (err) {
      if (cached && now() - cached.at < ttl + STALE_MS) return cached.value;
      throw new OnchainUnavailableError(
        err instanceof Error ? `on-chain read failed: ${err.name}` : 'on-chain read failed',
      );
    }
  }

  return {
    lists() {
      return cachedRead(listCache, LIST_TTL_MS, listInFlight, listBudget, () => {
        listInFlight = buildLists()
          .then((value) => {
            listCache = { value, at: now() };
            return value;
          })
          .finally(() => {
            listInFlight = null;
          });
        return listInFlight;
      });
    },

    async coin(raw) {
      const mint = canonicalAddress(raw);
      if (!mint) return null;
      return cachedRead(
        coinCache.get(mint),
        COIN_TTL_MS,
        coinInFlight.get(mint),
        coinBudget,
        () => {
          const promise = buildCoin(mint)
            .then((value) => {
              coinCache.delete(mint);
              coinCache.set(mint, { value, at: now() });
              trimCache(coinCache, MAX_CACHED_COINS);
              return value;
            })
            .finally(() => coinInFlight.delete(mint));
          coinInFlight.set(mint, promise);
          return promise;
        },
      );
    },
  };
}

/** A token bucket of whole refreshes: `take()` is false when it is empty. */
function budgetOf(rule: { capacity: number; refillMs: number }, now: () => number) {
  let tokens = rule.capacity;
  let at = now();
  return (): boolean => {
    const t = now();
    tokens = Math.min(rule.capacity, tokens + Math.max(0, t - at) / rule.refillMs);
    at = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/** Drops the oldest entries (insertion order) past `max`. */
function trimCache<K, V>(cache: Map<K, V>, max: number): void {
  for (const key of cache.keys()) {
    if (cache.size <= max) break;
    cache.delete(key);
  }
}
