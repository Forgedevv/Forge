import { SupabaseTokenResponse, WEB_API_ROUTES } from '@forge/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { request } from './http';

let client: SupabaseClient | null = null;
let currentToken: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by start/stop so a token fetch started earlier can tell it was superseded. */
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeSupabase(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getSupabaseSnapshot(): SupabaseClient | null {
  return client;
}

export function getServerSupabaseSnapshot(): SupabaseClient | null {
  return null;
}

/** Expiry of the token in ms since epoch, or null when unparsable. */
export function tokenExpiryMs(res: SupabaseTokenResponse): number | null {
  const t = Date.parse(res.expiresAt);
  return Number.isNaN(t) ? null : t;
}

function ensureClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  client = createClient(url, anon, {
    accessToken: async () => currentToken,
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

async function fetchToken(gen: number): Promise<void> {
  const res = await request(WEB_API_ROUTES.authSupabaseToken.path, SupabaseTokenResponse);
  // stopSupabaseAuth/startSupabaseAuth ran while waiting: drop this response.
  if (gen !== generation) return;
  currentToken = res.accessToken;
  const created = client === null;
  const sb = ensureClient();
  if (!sb) return;
  sb.realtime.setAuth(res.accessToken);
  if (created) emit();
  const exp = tokenExpiryMs(res);
  // refresh 60 s before expiry (at least in 10 s, at most in 50 min)
  const delay = exp === null ? 50 * 60_000 : Math.min(50 * 60_000, Math.max(10_000, exp - Date.now() - 60_000));
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    void fetchToken(gen).catch(() => {
      if (gen !== generation) return;
      refreshTimer = setTimeout(() => void fetchToken(gen).catch(() => undefined), 15_000);
    });
  }, delay);
}

/** Authenticates the browser Supabase client with the server-issued token. */
export async function startSupabaseAuth(): Promise<void> {
  stopSupabaseAuth();
  await fetchToken(generation);
}

export function stopSupabaseAuth(): void {
  generation += 1;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  currentToken = null;
  if (client) {
    void client.removeAllChannels();
    client = null;
    emit();
  }
}

export function getSupabase(): SupabaseClient | null {
  return client;
}
