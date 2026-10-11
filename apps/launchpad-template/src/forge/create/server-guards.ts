import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

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
