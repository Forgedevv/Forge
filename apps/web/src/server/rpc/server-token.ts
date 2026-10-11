import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Server-to-server tier of the relay.
 *
 * Calls from a client site's SERVER (the template route /api/upload builds the launch transaction
 * through the relay) come from Vercel egress IPs, shared by every project: a per-IP limit is
 * meaningless there and the request carries no Origin. Such calls may present a per-launchpad
 * token in the `X-Forge-Relay-Token` header:
 *
 *   token = "v1." + slug + "." + hex(HMAC-SHA256(RPC_RELAY_TOKEN_SECRET, "forge-rpc-relay:v1:" + slug))
 *
 * - RPC_RELAY_TOKEN_SECRET (>= 32 bytes) lives only in the FORGE web project and in the builder,
 *   one value per environment (development / preview / production).
 * - The builder derives the token of each launchpad and injects it into that client project as the
 *   server-only variable FORGE_RPC_RELAY_TOKEN (never NEXT_PUBLIC_).
 * - A client project's environment must be assumed readable (it runs generated code), so the token
 *   grants nothing but a higher, per-launchpad rate limit on the same method allowlist. It only
 *   works while the launchpad is active (draft or live), so disabling a site revokes it; rotating
 *   the secret revokes all tokens at once.
 * - Browsers cannot send it cross-origin (the header is not in Access-Control-Allow-Headers), and a
 *   request carrying both an Origin and a token is refused.
 */

export const RELAY_TOKEN_HEADER = 'x-forge-relay-token';
const VERSION = 'v1';
const SLUG_RE = /^[a-z0-9-]{3,32}$/;
const MAX_TOKEN_LENGTH = 128;

function mac(secret: Buffer, slug: string): Buffer {
  return createHmac('sha256', secret).update(`forge-rpc-relay:${VERSION}:${slug}`).digest();
}

/** Token of one launchpad (used by tests; the builder computes the same value). */
export function deriveRelayToken(secret: Buffer, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error('invalid slug');
  return `${VERSION}.${slug}.${mac(secret, slug).toString('hex')}`;
}

/** Returns the slug of a well-formed, correctly signed token, or null. Constant-time compare. */
export function verifyRelayToken(secret: Buffer, token: string): string | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, slug, hex] = parts as [string, string, string];
  if (version !== VERSION || !SLUG_RE.test(slug) || !/^[0-9a-f]{64}$/.test(hex)) return null;
  const expected = mac(secret, slug);
  const given = Buffer.from(hex, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return slug;
}
