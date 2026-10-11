import type { SupabaseClient } from '@supabase/supabase-js';
import type { SnapshotLoader } from './origins';

/*
 * Loads the launchpad directory snapshot from Supabase (service role: `launchpads` is not readable
 * by anon under RLS). Two bounded queries per refresh, whatever the traffic:
 * - active launchpads (`draft` or `live`): id + slug, paged;
 * - jobs waiting for the client's approval (`preview_ready`) with their preview URL.
 */

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const MAX_PREVIEWS = 1000;
const ACTIVE_STATUSES = ['draft', 'live'];
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

export function createSupabaseSnapshotLoader(db: SupabaseClient): SnapshotLoader {
  return async () => {
    const slugById = new Map<string, string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE_SIZE;
      const { data, error } = await db
        .from('launchpads')
        .select('id, slug')
        .in('status', ACTIVE_STATUSES)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new DirectoryLoadError('launchpads select');
      const rows = (data ?? []) as { id?: unknown; slug?: unknown }[];
      for (const row of rows) {
        if (typeof row.id === 'string' && typeof row.slug === 'string' && SLUG_RE.test(row.slug)) {
          slugById.set(row.id, row.slug);
        }
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

    return { activeSlugs: new Set(slugById.values()), previewOrigins };
  };
}
