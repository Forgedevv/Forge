import { trustedSiteHost } from '@forge/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SnapshotLoader } from './origins';

/*
 * Loads the launchpad directory snapshot from Supabase (service role: `launchpads` is not readable
 * by anon under RLS). Two bounded queries per refresh, whatever the traffic:
 * - launchpads whose site may call the relay: id + slug + status + site_host, paged. Active ones
 *   (`draft` or `live`) get every tier; sleeping ones only the browser origin of their site, for
 *   the creator fee claim (decision D29). A recorded `site_host` (migration 0011) adds the exact
 *   origin `https://<site_host>` for that launchpad only, when it is one the builder records:
 *   `<one label>.vercel.app`, or exactly `<slug>.<CLIENTS_DOMAIN>` (trustedSiteHost); any other
 *   value is ignored. A host listed for two launchpads is dropped for both (the column is unique:
 *   never expected);
 * - jobs waiting for the client's approval (`preview_ready`) with their preview URL (active
 *   launchpads only).
 */

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const MAX_PREVIEWS = 1000;
const ACTIVE_STATUSES = ['draft', 'live'];
const SLEEPING_STATUS = 'sleeping';
const LISTED_STATUSES = [...ACTIVE_STATUSES, SLEEPING_STATUS];
const SLUG_RE = /^[a-z0-9-]{3,32}$/;

export class DirectoryLoadError extends Error {
  constructor(what: string) {
    // Never the Supabase error message (it can echo the request).
    super(`launchpad directory: ${what} failed`);
    this.name = 'DirectoryLoadError';
  }
}

/** Exact https origin of a stored preview URL, or null. */
export function previewOriginOf(previewUrl: unknown): string | null {
  if (typeof previewUrl !== 'string') return null;
  try {
    const url = new URL(previewUrl);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * `https://<site_host>` of the stored `launchpads.site_host` of launchpad `slug`, or null when
 * absent, malformed or not a host the launchpad may have (trustedSiteHost).
 */
export function siteOriginOf(
  siteHost: unknown,
  slug: string,
  clientsDomain: string | null,
): string | null {
  const host = trustedSiteHost(siteHost, slug, clientsDomain);
  return host === null ? null : `https://${host}`;
}

export interface SnapshotLoaderOptions {
  /** CLIENTS_DOMAIN: a recorded `<slug>.<domain>` host is trusted only for its own slug. */
  clientsDomain?: string | null;
}

export function createSupabaseSnapshotLoader(
  db: SupabaseClient,
  options: SnapshotLoaderOptions = {},
): SnapshotLoader {
  const clientsDomain = options.clientsDomain ?? null;
  return async () => {
    const slugById = new Map<string, string>();
    const sleepingSlugs = new Set<string>();
    const siteOrigins = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE_SIZE;
      const { data, error } = await db
        .from('launchpads')
        .select('id, slug, status, site_host')
        .in('status', LISTED_STATUSES)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new DirectoryLoadError('launchpads select');
      const rows = (data ?? []) as {
        id?: unknown;
        slug?: unknown;
        status?: unknown;
        site_host?: unknown;
      }[];
      for (const row of rows) {
        if (typeof row.id !== 'string' || typeof row.slug !== 'string') continue;
        if (!SLUG_RE.test(row.slug)) continue;
        if (typeof row.status === 'string' && ACTIVE_STATUSES.includes(row.status)) {
          slugById.set(row.id, row.slug);
        } else if (row.status === SLEEPING_STATUS) {
          sleepingSlugs.add(row.slug);
        } else {
          continue;
        }
        const origin = siteOriginOf(row.site_host, row.slug, clientsDomain);
        if (origin === null) continue;
        const other = siteOrigins.get(origin);
        if (other !== undefined && other !== row.slug) ambiguous.add(origin);
        siteOrigins.set(origin, row.slug);
      }
      if (rows.length < PAGE_SIZE) break;
    }

    const { data, error } = await db
      .from('jobs')
      .select('launchpad_id, preview_url')
      .eq('status', 'preview_ready')
      .not('preview_url', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(MAX_PREVIEWS);
    if (error) throw new DirectoryLoadError('jobs select');
    const previewOrigins = new Map<string, string>();
    for (const row of (data ?? []) as { launchpad_id?: unknown; preview_url?: unknown }[]) {
      const slug =
        typeof row.launchpad_id === 'string' ? slugById.get(row.launchpad_id) : undefined;
      const origin = previewOriginOf(row.preview_url);
      if (slug && origin) previewOrigins.set(origin, slug);
    }

    const activeSlugs = new Set(slugById.values());
    // Slugs are unique; should a row ever say otherwise, the active status wins.
    for (const slug of activeSlugs) sleepingSlugs.delete(slug);
    for (const origin of ambiguous) siteOrigins.delete(origin);
    return { activeSlugs, sleepingSlugs, siteOrigins, previewOrigins };
  };
}
