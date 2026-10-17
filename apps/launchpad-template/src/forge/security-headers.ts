/**
 * LOCKED ZONE. HTTP security headers applied by next.config.ts.
 *
 * The Content-Security-Policy is an allowlist. Every origin below is a deliberate decision:
 * adding one is a security change and must go through FORGE, never through the site builder.
 *
 * Production policy: no `unsafe-eval`, framing forbidden (`frame-ancestors 'none'`), `connect-src`
 * limited to the FORGE RPC relay and the Jupiter hosts the site actually calls, `img-src` limited
 * to the storage domain (R2), the image proxy and the Jupiter assets.
 *
 * Jupiter hosts, checked against the live Jupiter Plugin bundle (plugin-v1.js) and this template's
 * sources on 2026-10-17: the plugin loads its script and stylesheets from plugin.jup.ag, calls
 * ultra-api.jup.ag, datapi.jup.ag and worker.jup.ag, loads the Inter font from Google Fonts, the
 * Jupiter logo from jup.ag and token icons through wsrv.nl; it uses no iframe. The legacy hosts
 * (quote-api, price, tokens.jup.ag, retired in 2025) and the hosts nothing calls (api, lite-api,
 * img-cdn.jup.ag) are not listed.
 *
 * Known limit: Next.js (Pages Router) emits inline bootstrap scripts, so `script-src` keeps
 * `'unsafe-inline'`. Moving to nonces needs a middleware and dynamic rendering of every page.
 */

type Directives = Record<string, string[]>;

/**
 * Jupiter scripts and their assets (script-src, style-src, font-src, img-src):
 * - plugin.jup.ag: the Jupiter Plugin script and its stylesheets (JupiterTrade);
 * - static.jup.ag: the TradingView charting library, its bundles and its stylesheet (chart/).
 */
const JUPITER_ASSETS = ['https://plugin.jup.ag', 'https://static.jup.ag'];

/** Jupiter hosts the browser calls with fetch/XHR. */
const JUPITER_API = [
  'https://datapi.jup.ag', // coin list, chart and holders data (src/forge/data); plugin: tokens
  'https://ultra-api.jup.ag', // plugin: Ultra swap flow (order, execute, balances)
  'https://worker.jup.ag', // plugin: helper endpoints
];

/** Jupiter websocket stream of live coin data. */
const JUPITER_STREAM = ['wss://trench-stream.jup.ag'];

/** Jupiter logo shown by the plugin. */
const JUPITER_IMAGES = ['https://jup.ag'];

/** Google Fonts, used by the plugin only: its stylesheet (style-src) and font files (font-src). */
const PLUGIN_FONT_STYLESHEETS = ['https://fonts.googleapis.com'];
const PLUGIN_FONT_FILES = ['https://fonts.gstatic.com'];

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
    'style-src': ["'self'", "'unsafe-inline'", ...JUPITER_ASSETS, ...PLUGIN_FONT_STYLESHEETS],
    'img-src': [
      "'self'",
      'data:',
      'blob:',
      IMAGE_PROXY,
      ...storage,
      ...JUPITER_ASSETS,
      ...JUPITER_IMAGES,
    ],
    'font-src': ["'self'", 'data:', ...JUPITER_ASSETS, ...PLUGIN_FONT_FILES],
    'connect-src': [
      "'self'",
      ...rpcRelay,
      ...JUPITER_API,
      ...JUPITER_STREAM,
      ...(isDev ? ['ws://localhost:*', 'http://localhost:*'] : []),
    ],
    // The Jupiter Plugin renders in the page (no iframe). The TradingView chart library (chart/)
    // renders its widget in an iframe loaded from a blob: URL it creates (its default loading
    // mode); a blob: document inherits this policy. No other origin can be framed.
    'frame-src': ['blob:'],
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
