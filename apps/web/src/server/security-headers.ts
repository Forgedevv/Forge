/*
 * HTTP security headers of the FORGE site, applied to every route by next.config.ts.
 *
 * Enforced: framing is forbidden (`frame-ancestors 'none'` and X-Frame-Options DENY), no MIME
 * sniffing, a strict referrer policy and a minimal Permissions-Policy.
 *
 * Content-Security-Policy-Report-Only: the full source allowlist (scripts, connections, frames,
 * images) is reported by browsers but not enforced yet, so that a missing origin shows up as a
 * console report instead of breaking the app. Enforce it once the reports are clean.
 *
 * Origins come from public build-time variables; only https origins are accepted (plus http on
 * localhost in development), so a malformed value can never widen the policy.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export interface Header {
  key: string;
  value: string;
}

type Directives = Record<string, string[]>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Client previews are Vercel deployment URLs (`https://<project>-<hash>-<team>.vercel.app`),
 * shown in an iframe of the job page.
 */
const PREVIEW_HOSTS = ['https://*.vercel.app'];

/** Origin of a configured URL, or nothing when unset, invalid or not https. */
export function originOf(value: string | undefined, isDev = false): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.origin;
    if (isDev && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return url.origin;
    return null;
  } catch {
    return null;
  }
}

/** The websocket origin of an http(s) origin (Supabase Realtime). */
function websocketOf(origin: string): string {
  return origin.replace(/^http/, 'ws');
}

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function buildCspDirectives(isDev: boolean, env: Env): Directives {
  const app = originOf(env.NEXT_PUBLIC_APP_URL, isDev);
  const supabase =
    originOf(env.NEXT_PUBLIC_SUPABASE_URL, isDev) ?? originOf(env.SUPABASE_URL, isDev);
  // Public bucket of the coin images (the browser renders them).
  const storage = originOf(env.R2_PUBLIC_URL, isDev);
  const clientsDomain = env.CLIENTS_DOMAIN?.trim().toLowerCase();
  const clientSites =
    clientsDomain && DOMAIN_RE.test(clientsDomain) ? [`https://*.${clientsDomain}`] : [];

  const only = (...values: (string | null)[]) => values.filter((v): v is string => v !== null);
  return {
    'default-src': ["'self'"],
    // The App Router emits inline bootstrap scripts; only development needs eval (fast refresh).
    'script-src': ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...only(storage)],
    'font-src': ["'self'", 'data:'],
    // The RPC relay is served by this site (/api/rpc): the browser never calls the provider.
    'connect-src': [
      "'self'",
      ...only(app),
      ...only(supabase),
      ...(supabase ? [websocketOf(supabase)] : []),
      ...(isDev ? ['ws://localhost:*', 'http://localhost:*'] : []),
    ],
    'frame-src': ["'self'", ...PREVIEW_HOSTS, ...clientSites],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
}

export function serializeCsp(directives: Directives): string {
  return Object.entries(directives)
    .map(([name, sources]) => (sources.length ? `${name} ${sources.join(' ')}` : name))
    .join('; ');
}

export function securityHeaders(isDev: boolean, env: Env = process.env): Header[] {
  return [
    // Enforced now: nobody may frame the site (clickjacking of the payment and launch steps).
    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    {
      key: 'Content-Security-Policy-Report-Only',
      value: serializeCsp(buildCspDirectives(isDev, env)),
    },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=()',
    },
  ];
}
