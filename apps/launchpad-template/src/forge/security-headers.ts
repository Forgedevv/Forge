/**
 * LOCKED ZONE. HTTP security headers applied by next.config.ts.
 *
 * The Content-Security-Policy is an allowlist. Every origin below is a deliberate decision:
 * adding one is a security change and must go through FORGE, never through the site builder.
 */

type Directive = Record<string, string[]>;

/** Jupiter: plugin script + widget assets, data API and websocket stream, TradingView assets. */
const JUPITER = [
  'https://plugin.jup.ag',
  'https://static.jup.ag',
  'https://*.jup.ag',
  'https://datapi.jup.ag',
  'wss://trench-stream.jup.ag',
];

/** Image proxy used for token icons. */
const IMAGE_PROXY = 'https://wsrv.nl';

/** Origin of a configured URL env variable, or nothing when unset/invalid. */
function originOf(value: string | undefined): string[] {
  if (!value) return [];
  try {
    return [new URL(value).origin];
  } catch {
    return [];
  }
}

export function buildCsp(isDev: boolean, env: NodeJS.ProcessEnv = process.env): string {
  // Public R2 bucket serving coin images and metadata.
  const r2Public = originOf(env.R2_PUBLIC_URL);
  // PLACEHOLDER: FORGE RPC relay origin (browser never talks to the RPC provider directly).
  const rpcRelay = originOf(env.NEXT_PUBLIC_FORGE_RPC_RELAY_URL);

  const directives: Directive = {
    'default-src': ["'self'"],
    // Next.js (Pages Router) emits inline bootstrap scripts; dev needs eval for fast refresh.
    'script-src': ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : []), ...JUPITER],
    'style-src': ["'self'", "'unsafe-inline'", ...JUPITER],
    'img-src': ["'self'", 'data:', 'blob:', IMAGE_PROXY, ...r2Public, ...JUPITER],
    'font-src': ["'self'", 'data:', ...JUPITER],
    'connect-src': [
      "'self'",
      ...JUPITER,
      ...rpcRelay,
      ...(isDev ? ['ws://localhost:*', 'http://localhost:*'] : []),
    ],
    'frame-src': ['https://plugin.jup.ag'],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

export function securityHeaders(isDev: boolean): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: buildCsp(isDev) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ];
}
