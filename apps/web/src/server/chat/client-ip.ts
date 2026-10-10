/*
 * Client IP for rate-limit keys (chat, spec confirmation and payment routes). Never used for
 * anything but a counter key.
 *
 * Trust model: the app runs behind one trusted proxy (Vercel). In order of preference:
 *  1. `x-vercel-forwarded-for`: set by the Vercel edge to the address it received the connection
 *     from; a value sent by the client is overwritten.
 *  2. `x-real-ip`: also set by the platform proxy.
 *  3. The LAST `x-forwarded-for` entry: a client can put anything at the start of this header, but
 *     each proxy APPENDS the address it saw, so the last entry is the one written by the proxy in
 *     front of the app. (The first entry, used before, was spoofable behind an appending proxy.)
 * Values that do not look like an IP address are ignored. Falls back to "unknown" (one shared
 * bucket, so a missing header never disables the per-IP limit).
 */

const IP_LIKE = /^[0-9A-Fa-f:.]{2,45}$/;

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v && IP_LIKE.test(v) ? v : null;
}

export function clientIp(request: Request): string {
  const h = request.headers;
  const platform =
    clean(h.get('x-vercel-forwarded-for')?.split(',')[0]) ?? clean(h.get('x-real-ip') ?? undefined);
  if (platform) return platform;
  const forwarded = h.get('x-forwarded-for')?.split(',');
  return clean(forwarded?.[forwarded.length - 1]) ?? 'unknown';
}
