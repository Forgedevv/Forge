import { FlagsResponse } from '@forge/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/*
 * GET /api/flags — public kill-switch state needed by the UI (docs/INTERFACES.md §6,
 * docs/OPERATIONS.md). Only `signups_paused` is exposed; the other flags concern back-office
 * services and stay private.
 *
 * Freshness: services must see a flag change within a minute. The value is cached in memory for
 * CACHE_TTL_MS and by the CDN for at most `s-maxage` + `stale-while-revalidate` seconds, so a
 * change shows within about 40 s. The UI flag is advisory: the chat, spec confirmation and payment
 * routes re-read `signups_paused` themselves.
 *
 * Read with the anon key (the `flags` table is readable by anon under RLS): this public route
 * holds no privileged credential.
 */

export const CACHE_TTL_MS = 10_000;
/** On a read failure, a cached value is served up to this age, then the route answers 503. */
export const MAX_STALE_MS = 5 * 60_000;
export const CACHE_CONTROL = 'public, max-age=5, s-maxage=10, stale-while-revalidate=20';

export type Env = Readonly<Record<string, string | undefined>>;

export class FlagsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlagsConfigError';
  }
}

export class FlagsReadError extends Error {
  constructor() {
    // Never the Supabase error text.
    super('flags read failed');
    this.name = 'FlagsReadError';
  }
}

export interface FlagsSource {
  /** Values of the flags table (missing keys are not paused). */
  read(): Promise<ReadonlyMap<string, boolean>>;
}

export function createSupabaseFlagsSource(db: SupabaseClient): FlagsSource {
  return {
    async read() {
      const { data, error } = await db.from('flags').select('key, value');
      if (error) throw new FlagsReadError();
      const out = new Map<string, boolean>();
      for (const row of (data ?? []) as { key?: unknown; value?: unknown }[]) {
        if (typeof row.key === 'string') out.set(row.key, row.value === true);
      }
      return out;
    },
  };
}

export function readFlagsEnv(env: Env = process.env): { url: string; anonKey: string } {
  const url = env.SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.SUPABASE_ANON_KEY?.trim() || env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url) throw new FlagsConfigError('SUPABASE_URL is not set');
  if (!anonKey) throw new FlagsConfigError('SUPABASE_ANON_KEY is not set');
  return { url, anonKey };
}

export function toFlagsResponse(values: ReadonlyMap<string, boolean>): FlagsResponse {
  return FlagsResponse.parse({ signupsPaused: values.get('signups_paused') === true });
}

export interface FlagsHandlerDeps {
  /** Lazily built source (a configuration error is answered with a 503). */
  source: () => FlagsSource;
  now?: () => number;
  onError?: (event: string, error: unknown) => void;
}

export function createFlagsHandler(deps: FlagsHandlerDeps): () => Promise<Response> {
  const now = deps.now ?? Date.now;
  let cached: { value: FlagsResponse; at: number } | null = null;
  let pending: Promise<FlagsResponse> | null = null;

  const load = (): Promise<FlagsResponse> => {
    pending ??= (async () => {
      try {
        const value = toFlagsResponse(await deps.source().read());
        cached = { value, at: now() };
        return value;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

  return async () => {
    const t = now();
    if (cached && t - cached.at < CACHE_TTL_MS) return ok(cached.value);
    try {
      return ok(await load());
    } catch (error) {
      deps.onError?.(error instanceof FlagsConfigError ? 'config_error' : 'read_failed', error);
      if (cached && t - cached.at < MAX_STALE_MS) return ok(cached.value);
      return Response.json(
        { code: 'NETWORK', message: 'Service status is temporarily unavailable.' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
  };
}

function ok(value: FlagsResponse): Response {
  return Response.json(value, { status: 200, headers: { 'cache-control': CACHE_CONTROL } });
}

let defaultHandler: (() => Promise<Response>) | null = null;
let defaultSource: FlagsSource | null = null;

/** Production wiring. */
export function handleFlags(): Promise<Response> {
  defaultHandler ??= createFlagsHandler({
    source: () => {
      if (defaultSource) return defaultSource;
      const { url, anonKey } = readFlagsEnv();
      defaultSource = createSupabaseFlagsSource(
        createClient(url, anonKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        }),
      );
      return defaultSource;
    },
    onError: (event, error) => {
      console.error(
        JSON.stringify({
          scope: 'flags',
          level: 'error',
          event,
          error: error instanceof Error ? error.name : typeof error,
          // FlagsConfigError messages name the variable only.
          detail: error instanceof FlagsConfigError ? error.message : undefined,
        }),
      );
    },
  });
  return defaultHandler();
}
