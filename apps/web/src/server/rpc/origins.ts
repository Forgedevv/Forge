/*
 * Which browser origins may call the relay (CORS), and the cached launchpad directory behind it.
 *
 * Allowed origins:
 * - the FORGE site (origin of NEXT_PUBLIC_APP_URL);
 * - outside production only: http://localhost:<port>, http://127.0.0.1:<port>, http://[::1]:<port>;
 * - client sites: exactly `https://<slug>.<CLIENTS_DOMAIN>` (one label, default port) where `slug`
 *   is an active launchpad (status draft or live), or a sleeping one (kind `sleeping`): a sleeping
 *   site serves a static page whose one action is the creator fee claim (decision D29), so the
 *   relay serves it the claim's methods only (handler.ts, SLEEPING_SITE_METHODS). Disabled sites
 *   are cut off;
 * - client sites at their recorded host: exactly `https://<site_host>` (default port), where
 *   `launchpads.site_host` is the production host the builder read from the Vercel API for the
 *   launchpad's own project (migration 0011): the verified subdomain, else a `*.vercel.app` alias of
 *   that project. Same status rules as the slug: draft and live sites get every method, sleeping
 *   ones the claim's methods only, disabled ones nothing; a host only ever speaks for its own
 *   launchpad;
 * - client previews: the exact origin of `jobs.preview_url` for jobs waiting for the client's
 *   approval (`preview_ready`). Vercel URLs are never matched by pattern: anyone can create a
 *   `*.vercel.app` project with a look-alike name.
 *
 * Everything else, including `Origin: null`, is refused. Origins are compared after exact
 * canonicalisation (`new URL(origin).origin === origin`).
 */

export interface DirectorySnapshot {
  /** Slugs of launchpads whose site may call the relay (draft or live). */
  activeSlugs: ReadonlySet<string>;
  /**
   * Slugs of sleeping launchpads: their site may call the relay from the browser for the creator
   * fee claim only. Never used by the server-token tier (no uploads while sleeping).
   */
  sleepingSlugs: ReadonlySet<string>;
  /**
   * Exact site origin `https://<site_host>` -> slug of its launchpad, for listed launchpads (active
   * or sleeping) with a recorded host. Which tier the origin gets is decided by the slug's status
   * (activeSlugs / sleepingSlugs), exactly as for `https://<slug>.<CLIENTS_DOMAIN>`.
   */
  siteOrigins: ReadonlyMap<string, string>;
  /** Exact preview origin -> slug of its launchpad. */
  previewOrigins: ReadonlyMap<string, string>;
  loadedAt: number;
}

export interface LaunchpadDirectory {
  /**
   * The current snapshot (cached). Throws DirectoryUnavailableError when no snapshot fresh
   * enough could be loaded: client origins are then refused (fail closed).
   */
  snapshot(): Promise<DirectorySnapshot>;
}

export class DirectoryUnavailableError extends Error {
  constructor() {
    super('launchpad directory unavailable');
    this.name = 'DirectoryUnavailableError';
  }
}

export type SnapshotLoader = () => Promise<Omit<DirectorySnapshot, 'loadedAt'>>;

export interface CachedDirectoryOptions {
  /** A snapshot younger than this is served without a refresh. */
  ttlMs?: number;
  /** When refreshing fails, an older snapshot is still served up to this age. */
  maxStaleMs?: number;
  /** After a failed load, no new attempt before this delay (protects a struggling database). */
  failureBackoffMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/** Snapshot cache with single-flight refresh and stale-on-error. */
export class CachedLaunchpadDirectory implements LaunchpadDirectory {
  private current: DirectorySnapshot | null = null;
  private pending: Promise<DirectorySnapshot> | null = null;
  private lastFailureAt = Number.NEGATIVE_INFINITY;
  private readonly ttlMs: number;
  private readonly maxStaleMs: number;
  private readonly failureBackoffMs: number;
  private readonly now: () => number;

  constructor(
    private readonly loader: SnapshotLoader,
    private readonly options: CachedDirectoryOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxStaleMs = options.maxStaleMs ?? 15 * 60_000;
    this.failureBackoffMs = options.failureBackoffMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  async snapshot(): Promise<DirectorySnapshot> {
    const now = this.now();
    const current = this.current;
    if (current && now - current.loadedAt < this.ttlMs) return current;
    const usableStale = current && now - current.loadedAt < this.maxStaleMs ? current : null;
    if (now - this.lastFailureAt < this.failureBackoffMs) {
      if (usableStale) return usableStale;
      throw new DirectoryUnavailableError();
    }
    // A stale snapshot is served while a refresh runs in the background.
    const refresh = this.refresh();
    if (usableStale) {
      refresh.catch(() => undefined);
      return usableStale;
    }
    try {
      return await refresh;
    } catch {
      throw new DirectoryUnavailableError();
    }
  }

  private refresh(): Promise<DirectorySnapshot> {
    if (this.pending) return this.pending;
    const run = (async () => {
      try {
        const loaded = await this.loader();
        const snapshot: DirectorySnapshot = { ...loaded, loadedAt: this.now() };
        this.current = snapshot;
        return snapshot;
      } catch (error) {
        this.lastFailureAt = this.now();
        this.options.onError?.(error);
        throw error;
      } finally {
        this.pending = null;
      }
    })();
    this.pending = run;
    return run;
  }
}

export interface OriginPolicy {
  appOrigin: string | null;
  clientsDomain: string | null;
  allowLocalhost: boolean;
}

export type OriginDecision =
  | { allowed: true; kind: 'forge' | 'local'; origin: string }
  | { allowed: true; kind: 'client' | 'sleeping' | 'preview'; origin: string; slug: string }
  | { allowed: false; reason: 'malformed' | 'unknown' | 'directory_unavailable' };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SLUG_RE = /^[a-z0-9-]{3,32}$/;

/** Canonical origin or null when the header is not exactly `scheme://host[:port]`. */
export function canonicalOrigin(raw: string): URL | null {
  if (raw.length > 300 || raw === 'null') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.origin !== raw) return null;
  return url;
}

/** Slug of a client-site origin `https://<slug>.<clientsDomain>`, or null. */
export function clientSlugOf(url: URL, clientsDomain: string | null): string | null {
  if (!clientsDomain || url.protocol !== 'https:' || url.port !== '') return null;
  const suffix = `.${clientsDomain}`;
  const host = url.hostname;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return SLUG_RE.test(label) ? label : null;
}

/** Draft and live: every tier of a client site; sleeping: the claim only; anything else: refused. */
function bySlugStatus(snapshot: DirectorySnapshot, origin: string, slug: string): OriginDecision {
  if (snapshot.activeSlugs.has(slug)) return { allowed: true, kind: 'client', origin, slug };
  if (snapshot.sleepingSlugs.has(slug)) return { allowed: true, kind: 'sleeping', origin, slug };
  return { allowed: false, reason: 'unknown' };
}

export async function decideOrigin(
  raw: string,
  policy: OriginPolicy,
  directory: LaunchpadDirectory | null,
): Promise<OriginDecision> {
  const url = canonicalOrigin(raw);
  if (!url) return { allowed: false, reason: 'malformed' };
  const origin = url.origin;
  if (policy.appOrigin !== null && origin === policy.appOrigin) {
    return { allowed: true, kind: 'forge', origin };
  }
  if (policy.allowLocalhost && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) {
    return { allowed: true, kind: 'local', origin };
  }
  const slug = clientSlugOf(url, policy.clientsDomain);
  const maybePreview = url.protocol === 'https:';
  if (slug === null && !maybePreview) return { allowed: false, reason: 'unknown' };
  if (!directory) return { allowed: false, reason: 'directory_unavailable' };
  let snapshot: DirectorySnapshot;
  try {
    snapshot = await directory.snapshot();
  } catch {
    return { allowed: false, reason: 'directory_unavailable' };
  }
  if (slug !== null) return bySlugStatus(snapshot, origin, slug);
  // A recorded site host (exact origin, https, default port): the status rules of its own slug.
  const siteSlug = url.port === '' ? snapshot.siteOrigins.get(origin) : undefined;
  if (siteSlug !== undefined) return bySlugStatus(snapshot, origin, siteSlug);
  const previewSlug = snapshot.previewOrigins.get(origin);
  return previewSlug !== undefined
    ? { allowed: true, kind: 'preview', origin, slug: previewSlug }
    : { allowed: false, reason: 'unknown' };
}
