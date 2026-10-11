/// <reference types="node" />
import { createHmac } from 'node:crypto';

/**
 * Per-launchpad server token of the FORGE RPC relay and upload routes (apps/web). Each client
 * project gets its own, as a server-only Vercel variable: the web side recomputes it from the slug
 * and the shared secret, so a token only ever opens the routes for its own launchpad.
 *
 *   token = "v1." + slug + "." + hex(HMAC-SHA256(RPC_RELAY_TOKEN_SECRET, "forge-rpc-relay:v1:" + slug))
 *
 * Local implementation until the shared helper exists (same formula).
 */

/** Server-only variable of a client project (type `sensitive`, never `NEXT_PUBLIC_*`). */
export const RELAY_TOKEN_ENV = 'FORGE_RPC_RELAY_TOKEN';

/** Builder variable holding the secret. Never sent to a client project. */
export const RELAY_TOKEN_SECRET_ENV = 'RPC_RELAY_TOKEN_SECRET';

export const RELAY_TOKEN_SECRET_MIN_BYTES = 32;

/** Shape of a token (the slug rule of LaunchpadSpec). */
export const RELAY_TOKEN_RE = /^v1\.[a-z0-9-]{3,32}\.[0-9a-f]{64}$/;

const SLUG_RE = /^[a-z0-9-]{3,32}$/;

/** True when the secret is long enough to sign tokens. */
export function isRelayTokenSecret(secret: unknown): secret is string {
  return (
    typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= RELAY_TOKEN_SECRET_MIN_BYTES
  );
}

/** The relay token of one launchpad. Throws (without the secret) on bad input. */
export function rpcRelayToken(secret: string, slug: string): string {
  if (!isRelayTokenSecret(secret)) {
    throw new Error(
      `${RELAY_TOKEN_SECRET_ENV} must be at least ${RELAY_TOKEN_SECRET_MIN_BYTES} bytes`,
    );
  }
  if (!SLUG_RE.test(slug)) throw new Error('invalid launchpad slug for the relay token');
  const mac = createHmac('sha256', secret).update(`forge-rpc-relay:v1:${slug}`).digest('hex');
  return `v1.${slug}.${mac}`;
}
