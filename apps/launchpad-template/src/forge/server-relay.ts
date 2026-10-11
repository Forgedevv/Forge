import { Connection, type ConnectionConfig } from '@solana/web3.js';

/**
 * LOCKED ZONE. SERVER ONLY (imported by `pages/api/*`, never by a browser component).
 *
 * The FORGE builder injects a per-launchpad server token as the server-only variable
 * `FORGE_RPC_RELAY_TOKEN` (never `NEXT_PUBLIC_`). Calls from this site's server to the FORGE RPC
 * relay and to the FORGE upload endpoint carry it in the `X-Forge-Relay-Token` header: it grants a
 * per-launchpad rate limit instead of the shared per-IP one (Vercel egress IPs are shared). It is
 * never sent to a browser, to storage (presigned PUT) or to any other host, and never logged.
 */

export const RELAY_TOKEN_HEADER = 'X-Forge-Relay-Token';
export const RELAY_TOKEN_ENV = 'FORGE_RPC_RELAY_TOKEN';

/** Printable ASCII without spaces, bounded: anything else could split or forge a header. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,128}$/;

/** The server token, or null when unset or malformed. */
export function readServerRelayToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[RELAY_TOKEN_ENV]?.trim();
  if (!raw || !TOKEN_SHAPE.test(raw)) return null;
  return raw;
}

/** Headers for server-to-FORGE calls: the token header when a token is set, otherwise none. */
export function serverRelayHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const token = readServerRelayToken(env);
  return token ? { [RELAY_TOKEN_HEADER]: token } : {};
}

/** Relay connection for the site server, with the server token header when set. */
export function createServerRelayConnection(
  relayUrl: string,
  env: Record<string, string | undefined> = process.env,
  extra: Pick<ConnectionConfig, 'fetch'> = {},
): Connection {
  const headers = serverRelayHeaders(env);
  return new Connection(relayUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    ...(Object.keys(headers).length > 0 ? { httpHeaders: headers } : {}),
    ...extra,
  });
}
