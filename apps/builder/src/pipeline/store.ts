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

/** Columns the builder writes. */
export interface LaunchpadPatch {
  github_repo?: string;
  vercel_project_id?: string;
  launchpad_config?: string;
  launchpad_coin_config?: string;
  launchpad_coin_mint?: string;
  status?: LaunchpadStatus;
}

export interface LaunchpadStore {
  getLaunchpad(id: string): Promise<LaunchpadRecord | null>;
  /** Updates one row; throws when it does not exist. */
  updateLaunchpad(id: string, patch: LaunchpadPatch): Promise<void>;
}

/** Queries of the sleep cycle (src/sleep.ts). */
export interface SleepStore extends LaunchpadStore {
  /** `live` launchpads with no trade (or, never traded, created) before `cutoff`. */
  listDormant(cutoffIso: string, limit: number): Promise<LaunchpadRecord[]>;
  /** `sleeping` launchpads that traded again since `cutoff`. */
  listWoken(cutoffIso: string, limit: number): Promise<LaunchpadRecord[]>;
  /** True when a job of the launchpad is in flight, or changed since `sinceIso`. */
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

    async updateLaunchpad(id, patch) {
      assertId(id, 'launchpad');
      if (Object.keys(patch).length === 0) return;
      const updated = await request(
        'update_launchpad',
        'PATCH',
        `launchpads?id=eq.${id}&select=id`,
        patch,
      );
      if (!Array.isArray(updated) || updated.length !== 1) {
        throw new StoreError('update_launchpad: launchpad not found');
      }
    },

    async listDormant(cutoffIso, limit) {
      assertIso(cutoffIso);
      const n = Math.max(1, Math.min(500, Math.trunc(limit)));
      return rows(
        'list_dormant',
        await request(
          'list_dormant',
          'GET',
          `launchpads?status=eq.live&or=(last_trade_at.lt.${cutoffIso},and(last_trade_at.is.null,created_at.lt.${cutoffIso}))&order=created_at.asc&limit=${n}&select=${LAUNCHPAD_COLUMNS}`,
        ),
      );
    },

    async listWoken(cutoffIso, limit) {
      assertIso(cutoffIso);
      const n = Math.max(1, Math.min(500, Math.trunc(limit)));
      return rows(
        'list_woken',
        await request(
          'list_woken',
          'GET',
          `launchpads?status=eq.sleeping&last_trade_at=gte.${cutoffIso}&order=created_at.asc&limit=${n}&select=${LAUNCHPAD_COLUMNS}`,
        ),
      );
    },

    async hasJobActivity(launchpadId, sinceIso) {
      assertId(launchpadId, 'launchpad');
      assertIso(sinceIso);
      const json = await request(
        'job_activity',
        'GET',
        `jobs?launchpad_id=eq.${launchpadId}&or=(updated_at.gte.${sinceIso},status.in.(${IN_FLIGHT_JOB_STATUSES.join(',')}))&select=id&limit=1`,
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
