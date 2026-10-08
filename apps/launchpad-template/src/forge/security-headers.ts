/**
 * LOCKED ZONE. HTTP security headers applied by next.config.ts.
 *
 * The Content-Security-Policy is an allowlist. Every origin below is a deliberate decision:
 * adding one is a security change and must go through FORGE, never through the site builder.
 *
 * Production policy: no `unsafe-eval`, framing forbidden (`frame-ancestors 'none'`), `connect-src`
 * limited to the FORGE RPC relay and the Jupiter hosts the site actually calls, `img-src` limited
 * to the storage domain (R2) and the image proxy.
 *
 * Known limit: Next.js (Pages Router) emits inline bootstrap scripts, so `script-src` keeps
 * `'unsafe-inline'`. Moving to nonces needs a middleware and dynamic rendering of every page.
 */

type Directives = Record<string, string[]>;

/** Jupiter Plugin script and its widget assets (script-src, style-src, font-src, img-src). */
const JUPITER_ASSETS = ['https://plugin.jup.ag', 'https://static.jup.ag'];

/** Jupiter hosts the browser calls with fetch/XHR (data API, quotes, prices, tokens). */
const JUPITER_API = [
  'https://datapi.jup.ag', // coin list, chart and holders data (src/forge/data)
  'https://api.jup.ag', // plugin: quotes, swaps, prices
  'https://lite-api.jup.ag', // plugin: public tier of the same APIs
  'https://ultra-api.jup.ag', // plugin: Ultra swap flow
  'https://quote-api.jup.ag', // plugin: legacy quote host
  'https://price.jup.ag', // plugin: prices
  'https://tokens.jup.ag', // plugin: token lists
  'https://worker.jup.ag', // plugin: helper endpoints
];

/** Jupiter websocket stream of live coin data. */
const JUPITER_STREAM = ['wss://trench-stream.jup.ag'];

/** Jupiter image CDN (token icons shown by the plugin). */
const JUPITER_IMAGES = ['https://img-cdn.jup.ag'];

/** Image proxy used for token icons. */
const IMAGE_PROXY = 'https://wsrv.nl';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Origin of a configured URL env variable, or nothing when unset/invalid. Only https is accepted
 * (plus http on localhost in development), so a malformed or hostile value cannot widen the CSP.
 */
export function originOf(value: string | undefined, isDev = false): string[] {
  if (!value) return [];
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return [url.origin];
    if (isDev && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return [url.origin];
    return [];
  } catch {
    return [];
  }
}

export function buildCspDirectives(
  isDev: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Directives {
  // Public R2 bucket serving coin images and metadata (the storage domain).
  const storage = originOf(env.R2_PUBLIC_URL, isDev);
  // FORGE RPC relay: the browser never talks to the RPC provider directly.
  const rpcRelay = originOf(env.NEXT_PUBLIC_FORGE_RPC_RELAY_URL, isDev);

  const directives: Directives = {
    'default-src': ["'self'"],
    // Pages Router emits inline bootstrap scripts; only development needs eval (fast refresh).
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      ...(isDev ? ["'unsafe-eval'"] : []),
      ...JUPITER_ASSETS,
    ],
    'style-src': ["'self'", "'unsafe-inline'", ...JUPITER_ASSETS],
    'img-src': [
      "'self'",
      'data:',
      'blob:',
      IMAGE_PROXY,
      ...storage,
      ...JUPITER_ASSETS,
      ...JUPITER_IMAGES,
    ],
    'font-src': ["'self'", 'data:', ...JUPITER_ASSETS],
    'connect-src': [
      "'self'",
      ...rpcRelay,
      ...JUPITER_API,
      ...JUPITER_STREAM,
      ...(isDev ? ['ws://localhost:*', 'http://localhost:*'] : []),
    ],
    'frame-src': ['https://plugin.jup.ag'],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'media-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return directives;
}

export function buildCsp(isDev: boolean, env: NodeJS.ProcessEnv = process.env): string {
  return Object.entries(buildCspDirectives(isDev, env))
    .map(([name, sources]) => (sources.length ? `${name} ${sources.join(' ')}` : name))
    .join('; ');
}

export function securityHeaders(
  isDev: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: buildCsp(isDev, env) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    ...(isDev
      ? []
      : [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ]),
  ];
}
