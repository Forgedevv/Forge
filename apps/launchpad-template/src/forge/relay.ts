/**
 * LOCKED ZONE. JSON-RPC endpoint of the FORGE relay. A bare origin gets the relay path appended
 * (docs/INTERFACES.md: `POST /api/rpc`). Returns null when unset or not an http(s) URL. Every
 * browser component (trade, creation, claims) goes through this one normalisation.
 */
export function resolveRelayUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/api/rpc';
    return url.toString();
  } catch {
    return null;
  }
}
