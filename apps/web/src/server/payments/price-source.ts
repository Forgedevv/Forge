import { z } from 'zod';
import { PriceUnavailableError } from './errors';
import { assertSaneSolUsdPrice } from './pricing';
import { withRetry } from './retry';

/*
 * SOL/USD rate from Jupiter's price API (docs/tasks/03-WEB.md). Jupiter does not index devnet,
 * but the SOL rate is the same on every cluster, so devnet quotes use the mainnet rate.
 */

export interface SolUsdPriceSource {
  /** Dollars per SOL. Throws PriceUnavailableError when no sane price can be obtained. */
  getSolUsdPrice(): Promise<number>;
}

/** Wrapped SOL mint: the id Jupiter uses for SOL (a well-known program-owned mint, not a FORGE address). */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Keyed endpoint (JUPITER_API_KEY) and the free fallback. */
export const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v3';
export const JUPITER_LITE_PRICE_URL = 'https://lite-api.jup.ag/price/v3';

const PriceV3Response = z.record(z.string(), z.object({ usdPrice: z.number() }).loose().nullable());

export interface JupiterPriceSourceOptions {
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  /** A fetched price is reused for this long (the quote itself stays valid 120 s). */
  cacheMs?: number;
  timeoutMs?: number;
  attempts?: number;
  baseDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class JupiterPriceSource implements SolUsdPriceSource {
  private cached: { price: number; at: number } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: JupiterPriceSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getSolUsdPrice(): Promise<number> {
    const cacheMs = this.options.cacheMs ?? 15_000;
    const now = this.now();
    if (this.cached && now - this.cached.at < cacheMs) return this.cached.price;

    const price = await withRetry(() => this.fetchOnce(), {
      attempts: this.options.attempts ?? 3,
      baseDelayMs: this.options.baseDelayMs ?? 300,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
    }).catch((error: unknown) => {
      if (error instanceof PriceUnavailableError) throw error;
      throw new PriceUnavailableError('SOL/USD price request failed');
    });
    this.cached = { price, at: this.now() };
    return price;
  }

  private async fetchOnce(): Promise<number> {
    const apiKey = this.options.apiKey;
    const base = apiKey ? JUPITER_PRICE_URL : JUPITER_LITE_PRICE_URL;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const res = await this.fetchImpl(`${base}?ids=${WSOL_MINT}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      cache: 'no-store',
    });
    if (!res.ok) throw new PriceUnavailableError(`price API responded ${res.status}`);
    const parsed = PriceV3Response.safeParse(await res.json());
    const entry = parsed.success ? parsed.data[WSOL_MINT] : undefined;
    if (!entry) throw new PriceUnavailableError('price API response has no SOL price');
    assertSaneSolUsdPrice(entry.usdPrice);
    return entry.usdPrice;
  }
}

/** Fixed rate (tests and the devnet smoke script). */
export class FixedPriceSource implements SolUsdPriceSource {
  constructor(private readonly price: number) {}

  async getSolUsdPrice(): Promise<number> {
    assertSaneSolUsdPrice(this.price);
    return this.price;
  }
}
