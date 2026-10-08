/*
 * Token gate for the design chat (docs/PRODUCT.md: hold FORGE_GATING_AMOUNT of FORGE_MINT,
 * rechecked on each use). Disabled while FORGE_MINT is not set. Read-only: one JSON-RPC call
 * (`getTokenAccountsByOwner`) through the server RPC URL. The balance is cached briefly.
 */

export interface GatingResult {
  enabled: boolean;
  ok: boolean;
}

export type GatingCheck = (wallet: string) => Promise<GatingResult>;

export class GatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatingError';
  }
}

const CACHE_TTL_MS = 30_000;
const RPC_TIMEOUT_MS = 8_000;
const RAW_AMOUNT = /^\d{1,30}$/;

interface TokenAccountsResponse {
  result?: {
    value?: {
      account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: unknown } } } } };
    }[];
  };
  error?: unknown;
}

export function createGatingCheck(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): GatingCheck {
  const cache = new Map<string, { at: number; balance: bigint }>();

  return async (wallet) => {
    const mint = env.FORGE_MINT;
    if (mint === undefined || mint === '') return { enabled: false, ok: true };

    const requiredRaw = env.FORGE_GATING_AMOUNT;
    if (requiredRaw === undefined || !RAW_AMOUNT.test(requiredRaw)) {
      throw new GatingError('FORGE_GATING_AMOUNT is not configured');
    }
    const required = BigInt(requiredRaw);
    if (required === 0n) return { enabled: true, ok: true };

    const hit = cache.get(wallet);
    if (hit && now() - hit.at < CACHE_TTL_MS) return { enabled: true, ok: hit.balance >= required };

    const rpcUrl = env.RPC_URL;
    if (rpcUrl === undefined || rpcUrl === '') throw new GatingError('RPC_URL is not configured');

    let json: TokenAccountsResponse;
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!res.ok) throw new GatingError('RPC request failed');
      json = (await res.json()) as TokenAccountsResponse;
    } catch (error) {
      if (error instanceof GatingError) throw error;
      throw new GatingError('RPC request failed');
    }
    if (json.error !== undefined || !Array.isArray(json.result?.value)) {
      throw new GatingError('Unexpected RPC response');
    }

    let balance = 0n;
    for (const entry of json.result.value) {
      const amount = entry.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (typeof amount === 'string' && RAW_AMOUNT.test(amount)) balance += BigInt(amount);
    }
    cache.set(wallet, { at: now(), balance });
    return { enabled: true, ok: balance >= required };
  };
}
