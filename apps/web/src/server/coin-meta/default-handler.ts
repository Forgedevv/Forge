import { createClient } from '@supabase/supabase-js';
import { createCoinMetaHandler, type CoinMetaSource } from './handler';
import { CoinMetaReadError, createSupabaseCoinMetaSource } from './supabase-source';

/*
 * Production wiring of GET /api/coin-meta/:slug, built from the environment at the first request
 * (a build without secrets succeeds):
 * - SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY: launchpad reads;
 * - CLIENTS_DOMAIN (optional): `external_url` = https://<slug>.<CLIENTS_DOMAIN>.
 * Log lines name variables and error names, never values or database messages.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export class CoinMetaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoinMetaConfigError';
  }
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** CLIENTS_DOMAIN as a lowercase host name; an invalid value is ignored (no external_url). */
export function readClientsDomain(env: Env): string | null {
  const value = env.CLIENTS_DOMAIN?.trim().toLowerCase();
  return value && HOST_RE.test(value) ? value : null;
}

export function readSupabaseEnv(env: Env): { url: string; serviceRoleKey: string } {
  const url = env.SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url) throw new CoinMetaConfigError('SUPABASE_URL is not set');
  if (!serviceRoleKey) throw new CoinMetaConfigError('SUPABASE_SERVICE_ROLE_KEY is not set');
  return { url, serviceRoleKey };
}

let handler: ((slug: string) => Promise<Response>) | null = null;
let source: CoinMetaSource | null = null;

export function handleCoinMeta(slug: string): Promise<Response> {
  handler ??= createCoinMetaHandler({
    source: () => {
      if (source) return source;
      const { url, serviceRoleKey } = readSupabaseEnv(process.env);
      source = createSupabaseCoinMetaSource(
        createClient(url, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        }),
      );
      return source;
    },
    clientsDomain: () => readClientsDomain(process.env),
    onError: (event, error) => {
      console.error(
        JSON.stringify({
          scope: 'coin-meta',
          level: 'error',
          event,
          error: error instanceof Error ? error.name : typeof error,
          // Config messages name the variable only; read errors carry the Postgres code only.
          detail: error instanceof CoinMetaConfigError ? error.message : undefined,
          dbCode: error instanceof CoinMetaReadError ? (error.dbCode ?? null) : undefined,
        }),
      );
    },
  });
  return handler(slug);
}
