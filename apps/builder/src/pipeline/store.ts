/// <reference types="node" />
import { LaunchpadStatus } from '@forge/shared';
import { z } from 'zod';

/**
 * Launchpad rows the pipeline reads and writes (Supabase, service role). The job rows themselves
 * belong to the worker (src/db.ts); the pipeline only touches `launchpads` and, for the gateway,
 * `jobs.api_cost_usd`.
 *
 * Plain `fetch` against PostgREST, like src/db.ts. Error messages never contain the key.
 */

export interface LaunchpadRecord {
  id: string;
  owner_wallet: string;
  slug: string;
  /** Raw jsonb; parsed with `LaunchpadSpec` by the pipeline. */
  spec: unknown;
  github_repo: string | null;
  vercel_project_id: string | null;
  launchpad_config: string | null;
  launchpad_coin_config: string | null;
  launchpad_coin_mint: string | null;
  status: LaunchpadStatus;
  last_trade_at: string | null;
  created_at: string | null;
}

/** Statuses the builder may write: `disabled` is set by the FORGE team only. */
export type BuilderLaunchpadStatus = Exclude<LaunchpadStatus, 'disabled'>;

/** Columns the builder writes. */
export interface LaunchpadPatch {
  github_repo?: string;
  vercel_project_id?: string;
  launchpad_config?: string;
  launchpad_coin_config?: string;
  launchpad_coin_mint?: string;
  status?: BuilderLaunchpadStatus;
}

export interface LaunchpadWriteOptions {
  /**
   * The write applies only while the row is in one of these statuses (never `disabled`). Without
   * it, a patch that sets `status` applies to any status but `disabled`.
   */
  expectStatus?: readonly BuilderLaunchpadStatus[];
}

export interface LaunchpadStore {
  getLaunchpad(id: string): Promise<LaunchpadRecord | null>;
  /**
   * Updates one row; throws when it does not exist. A status write is conditional: it never
   * applies to a `disabled` launchpad (or, with `expectStatus`, to one that left the expected
   * statuses) and throws when no row matched, so the builder never overwrites a FORGE cut.
   */
  updateLaunchpad(id: string, patch: LaunchpadPatch, opts?: LaunchpadWriteOptions): Promise<void>;
}

/** Thrown when a conditional status write matched no row (launchpad disabled or moved on). */
export class LaunchpadStatusChangedError extends Error {
  constructor() {
    super('the launchpad status changed (disabled by FORGE?): status not written');
    this.name = 'LaunchpadStatusChangedError';
  }
}

/** PostgREST status filter of a launchpad write (see `LaunchpadStore.updateLaunchpad`). */
export function launchpadStatusFilter(
  patch: LaunchpadPatch,
  opts: LaunchpadWriteOptions = {},
): string | null {
  if ((patch.status as LaunchpadStatus | undefined) === 'disabled') {
    throw new StoreError('the builder never writes the disabled status');
  }
  if (opts.expectStatus !== undefined) {
    const allowed = opts.expectStatus.filter((s) => LaunchpadStatus.safeParse(s).success);
    if (
      allowed.length === 0 ||
      allowed.length !== opts.expectStatus.length ||
      allowed.includes('disabled' as BuilderLaunchpadStatus)
    ) {
      throw new StoreError('invalid expected launchpad status');
    }
    return `in.(${[...new Set(allowed)].join(',')})`;
  }
  return patch.status !== undefined ? 'neq.disabled' : null;
}

/**
 * Queries of the sleep cycle (src/sleep.ts). Lists are pages ordered by id: `afterId` is the last
 * id of the previous page (keyset pagination, stable while rows leave the list).
 */
export interface SleepStore extends LaunchpadStore {
  /** `live` launchpads with no trade (or, never traded, created) before `cutoff`. */
  listDormant(cutoffIso: string, limit: number, afterId?: string): Promise<LaunchpadRecord[]>;
  /** `sleeping` launchpads that traded again since `cutoff`. */
  listWoken(cutoffIso: string, limit: number, afterId?: string): Promise<LaunchpadRecord[]>;
  /** `disabled` launchpads (cut by the FORGE team), whose deployed site must be cut. */
  listDisabled(limit: number, afterId?: string): Promise<LaunchpadRecord[]>;
  /**
   * True when a job of the launchpad is in flight, changed since `sinceIso`, or failed after
   * approval (stage `onchain` or `deploy`, whenever: manual handling, never redeployed around).
   */
  hasJobActivity(launchpadId: string, sinceIso: string): Promise<boolean>;
}

/** Per-job API cost, for the gateway (`jobs.api_cost_usd`). */
export interface JobCostStore {
  getJobCost(jobId: string): Promise<number>;
  setJobCost(jobId: string, usd: number): Promise<void>;
}

export class StoreError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

const LaunchpadRowSchema = z.looseObject({
  id: z.string().min(1),
  owner_wallet: z.string().min(1),
  slug: z.string().min(1),
  spec: z.unknown(),
  github_repo: z.string().nullable(),
  vercel_project_id: z.string().nullable(),
  launchpad_config: z.string().nullable(),
  launchpad_coin_config: z.string().nullable(),
  launchpad_coin_mint: z.string().nullable(),
  status: LaunchpadStatus,
  last_trade_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});

const LAUNCHPAD_COLUMNS =
  'id,owner_wallet,slug,spec,github_repo,vercel_project_id,launchpad_config,launchpad_coin_config,launchpad_coin_mint,status,last_trade_at,created_at';

/** Failed stages that need the team (D18): the site is not redeployed automatically after them. */
export const BLOCKING_FAILED_STAGES = ['onchain', 'deploy'] as const;

/** Statuses of a job that is still going somewhere (sleeping its site would race with it). */
export const IN_FLIGHT_JOB_STATUSES = [
  'paid',
  'building',
  'preview_ready',
  'approved',
  'onchain_setup',
  'awaiting_owner_signature',
  'owner_signed',
  'deploying',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function assertId(id: string, what: string): void {
  // Test fixtures use short slugs; production ids are UUIDs. Never anything PostgREST would parse.
  if (typeof id !== 'string' || !(UUID_RE.test(id) || /^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    throw new StoreError(`invalid ${what} id`);
  }
}

function assertIso(value: string): void {
  if (!ISO_RE.test(value)) throw new StoreError('invalid timestamp');
}

/** Ordering, keyset cursor and limit of a launchpad list page. */
function page(limit: number, afterId: string | undefined): string {
  const n = Math.max(1, Math.min(500, Math.trunc(limit)));
  if (afterId !== undefined) assertId(afterId, 'cursor');
  const cursor = afterId !== undefined ? `&id=gt.${afterId}` : '';
  return `${cursor}&order=id.asc&limit=${n}&select=${LAUNCHPAD_COLUMNS}`;
}

export interface SupabaseStoreOptions {
  url: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createSupabaseStore(opts: SupabaseStoreOptions): SleepStore & JobCostStore {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const base = opts.url.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Supabase URL must be http(s)');
  if (opts.serviceRoleKey.length === 0) throw new Error('Supabase service role key is required');

  async function request(
    label: string,
    method: 'GET' | 'PATCH',
    pathAndQuery: string,
    body?: unknown,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}/rest/v1/${pathAndQuery}`, {
        method,
        headers: {
          apikey: opts.serviceRoleKey,
          authorization: `Bearer ${opts.serviceRoleKey}`,
          'content-type': 'application/json',
          ...(method === 'PATCH' ? { prefer: 'return=representation' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new StoreError(
        `${label}: request failed (${err instanceof Error ? err.name : 'error'})`,
      );
    }
    const text = await res.text().catch(() => '');
    if (!res.ok)
      throw new StoreError(`${label}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new StoreError(`${label}: invalid JSON response`, res.status);
    }
  }

  function rows(label: string, json: unknown): LaunchpadRecord[] {
    if (!Array.isArray(json)) throw new StoreError(`${label}: unexpected response shape`);
    return json.map((item) => {
      const parsed = LaunchpadRowSchema.safeParse(item);
      if (!parsed.success) throw new StoreError(`${label}: unexpected launchpad row shape`);
      const r = parsed.data;
      return {
        id: r.id,
        owner_wallet: r.owner_wallet,
        slug: r.slug,
        spec: r.spec,
        github_repo: r.github_repo,
        vercel_project_id: r.vercel_project_id,
        launchpad_config: r.launchpad_config,
        launchpad_coin_config: r.launchpad_coin_config,
        launchpad_coin_mint: r.launchpad_coin_mint,
        status: r.status,
        last_trade_at: r.last_trade_at ?? null,
        created_at: r.created_at ?? null,
      };
    });
  }

  return {
    async getLaunchpad(id) {
      assertId(id, 'launchpad');
      const found = rows(
        'get_launchpad',
        await request('get_launchpad', 'GET', `launchpads?id=eq.${id}&select=${LAUNCHPAD_COLUMNS}`),
      );
      return found[0] ?? null;
    },

    async updateLaunchpad(id, patch, opts) {
      assertId(id, 'launchpad');
      const statusFilter = launchpadStatusFilter(patch, opts);
      if (Object.keys(patch).length === 0) return;
      const updated = await request(
        'update_launchpad',
        'PATCH',
        `launchpads?id=eq.${id}${statusFilter ? `&status=${statusFilter}` : ''}&select=id`,
        patch,
      );
      if (!Array.isArray(updated) || updated.length !== 1) {
        if (statusFilter === null) throw new StoreError('update_launchpad: launchpad not found');
        throw new LaunchpadStatusChangedError();
      }
    },

    async listDormant(cutoffIso, limit, afterId) {
      assertIso(cutoffIso);
      return rows(
        'list_dormant',
        await request(
          'list_dormant',
          'GET',
          `launchpads?status=eq.live&or=(last_trade_at.lt.${cutoffIso},and(last_trade_at.is.null,created_at.lt.${cutoffIso}))${page(limit, afterId)}`,
        ),
      );
    },

    async listWoken(cutoffIso, limit, afterId) {
      assertIso(cutoffIso);
      return rows(
        'list_woken',
        await request(
          'list_woken',
          'GET',
          `launchpads?status=eq.sleeping&last_trade_at=gte.${cutoffIso}${page(limit, afterId)}`,
        ),
      );
    },

    async listDisabled(limit, afterId) {
      return rows(
        'list_disabled',
        await request(
          'list_disabled',
          'GET',
          `launchpads?status=eq.disabled${page(limit, afterId)}`,
        ),
      );
    },

    async hasJobActivity(launchpadId, sinceIso) {
      assertId(launchpadId, 'launchpad');
      assertIso(sinceIso);
      const json = await request(
        'job_activity',
        'GET',
        `jobs?launchpad_id=eq.${launchpadId}&or=(updated_at.gte.${sinceIso},status.in.(${IN_FLIGHT_JOB_STATUSES.join(',')}),and(status.eq.failed,failed_stage.in.(${BLOCKING_FAILED_STAGES.join(',')})))&select=id&limit=1`,
      );
      if (!Array.isArray(json)) throw new StoreError('job_activity: unexpected response shape');
      return json.length > 0;
    },

    async getJobCost(jobId) {
      assertId(jobId, 'job');
      const json = await request('get_job_cost', 'GET', `jobs?id=eq.${jobId}&select=api_cost_usd`);
      const parsed = z
        .array(z.object({ api_cost_usd: z.union([z.number(), z.string()]) }))
        .safeParse(json);
      if (!parsed.success) throw new StoreError('get_job_cost: unexpected response shape');
      const raw = parsed.data[0]?.api_cost_usd;
      const value = raw === undefined ? 0 : Number(raw);
      return Number.isFinite(value) ? value : 0;
    },

    async setJobCost(jobId, usd) {
      assertId(jobId, 'job');
      if (!Number.isFinite(usd) || usd < 0) throw new StoreError('invalid cost');
      await request('set_job_cost', 'PATCH', `jobs?id=eq.${jobId}&select=id`, {
        api_cost_usd: Number(usd.toFixed(6)),
      });
    },
  };
}
