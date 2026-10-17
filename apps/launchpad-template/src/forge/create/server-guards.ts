import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { PublicKey, type Keypair } from '@solana/web3.js';

/**
 * LOCKED ZONE. Server-only guards of the coin preparation route: per-IP rate limit, single-use
 * nonces and ed25519 verification of the wallet authorization.
 *
 * The limiter and the nonce store live in the memory of one server instance. On a serverless host
 * they are best effort (instances do not share them); the FORGE upload endpoint enforces both
 * again durably (per wallet, per launchpad, `(wallet, nonce)` consumed once).
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the next request is accepted (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  take(key: string): RateLimitDecision;
}

export interface RateLimitOptions {
  /** Requests allowed per key per window. */
  limit: number;
  windowMs: number;
  /** Keys tracked at most (oldest dropped first) so memory stays bounded. */
  maxKeys?: number;
  now?: () => number;
}

/** Sliding-window limiter (timestamps per key). */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const hits = new Map<string, number[]>();
  return {
    take(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < options.windowMs);
      if (recent.length >= options.limit) {
        hits.set(key, recent);
        const oldest = recent[0] as number;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + options.windowMs - t) / 1000)),
        };
      }
      recent.push(t);
      hits.delete(key);
      hits.set(key, recent);
      while (hits.size > maxKeys) {
        const first = hits.keys().next().value as string;
        hits.delete(first);
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

export interface NonceStore {
  /** True the first time `(wallet, nonce)` is seen within the TTL, false on a replay. */
  consume(wallet: string, nonce: string): boolean;
}

export function createNonceStore(options: {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}): NonceStore {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 50_000;
  const seen = new Map<string, number>();
  return {
    consume(wallet, nonce) {
      const t = now();
      for (const [key, expiry] of seen) {
        if (expiry > t) break;
        seen.delete(key);
      }
      const key = `${wallet}:${nonce}`;
      const expiry = seen.get(key);
      if (expiry !== undefined && expiry > t) return false;
      seen.set(key, t + options.ttlMs);
      while (seen.size > maxEntries) {
        const first = seen.keys().next().value as string;
        seen.delete(first);
      }
      return true;
    },
  };
}

/** Client IP: first `X-Forwarded-For` hop (set by the hosting proxy), else the socket address. */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  socketAddress?: string,
): string {
  const header = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const forwarded = header('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  const real = header('x-real-ip')?.trim();
  if (real) return real.slice(0, 64);
  return (socketAddress ?? 'unknown').slice(0, 64);
}

export function sha256HexNode(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// DER prefix of an ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Verifies an ed25519 signature by a Solana wallet (base58 address) over `message`. */
export function verifyWalletSignature(
  wallet: string,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  let raw: Uint8Array;
  try {
    raw = new PublicKey(wallet).toBytes();
  } catch {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** A launch the server prepared, kept so it can be rebuilt without a new upload. */
export interface PreparedLaunch {
  wallet: string;
  name: string;
  symbol: string;
  /** The fresh mint generated for this launch (it only signs this coin's creation). */
  mint: Keypair;
  metadataUri: string;
  /** Rebuilds served so far (bounded by `maxRebuilds`). */
  rebuilds: number;
}

export interface PreparedLaunchStore {
  /** Stores a prepared launch and returns the rebuild capability (43 base64url characters). */
  put(launch: Omit<PreparedLaunch, 'rebuilds'>): string;
  /**
   * The launch of `mint` when `token` is its capability and it has not expired, else null.
   * Comparison in constant time.
   */
  get(mint: string, token: string): PreparedLaunch | null;
}

/**
 * Prepared launches by mint, in the memory of one server instance, for `ttlMs`. The capability is
 * a random 256-bit token handed to the browser that prepared the launch (it already proved the
 * wallet with a signed message); only its SHA-256 is stored. A miss (another instance, a restart,
 * an expiry) only means the browser prepares the launch again: nothing depends on this store.
 */
export function createPreparedLaunchStore(options: {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}): PreparedLaunchStore {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1_000;
  const entries = new Map<
    string,
    { launch: PreparedLaunch; tokenHash: Buffer; expiresAt: number }
  >();
  const prune = (t: number) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt > t) break;
      entries.delete(key);
    }
  };
  return {
    put(launch) {
      const t = now();
      prune(t);
      const token = randomBytes(32).toString('base64url');
      const key = launch.mint.publicKey.toBase58();
      entries.delete(key);
      entries.set(key, {
        launch: { ...launch, rebuilds: 0 },
        tokenHash: createHash('sha256').update(token).digest(),
        expiresAt: t + options.ttlMs,
      });
      while (entries.size > maxEntries) {
        const first = entries.keys().next().value as string;
        entries.delete(first);
      }
      return token;
    },
    get(mint, token) {
      const t = now();
      prune(t);
      const entry = entries.get(mint);
      if (!entry || entry.expiresAt <= t) return null;
      const hash = createHash('sha256').update(token).digest();
      return timingSafeEqual(hash, entry.tokenHash) ? entry.launch : null;
    },
  };
}
