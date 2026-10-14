import {
  FailedStage,
  JobStatus,
  JobType,
  Lamports,
  LaunchpadStatus,
  WEB_API_ROUTES,
  type LaunchpadSpecDraft,
} from '@forge/shared';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApiError } from './errors';
import { request, route } from './http';
import { getSessionSnapshot } from './session-store';
import type { LaunchpadDetailView, LaunchpadSummaryView } from './types';

/*
 * Dashboard reads go through the owner-scoped API (`GET /api/launchpads`, `GET /api/launchpads/:id`):
 * it adds what the database alone cannot give (site URL, coins and partner fees read from the
 * chain, whether the chain could be read). Supabase Realtime only says *when* to read again.
 */

const Coin = z.object({
  name: z.string(),
  symbol: z.string(),
  mint: z.string().nullable(),
  imageUrl: z.string(),
});

export const LaunchpadSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string(),
  siteUrl: z.string().nullable(),
  status: LaunchpadStatus,
  coin: Coin,
  coinsCount: z.number().int().nonnegative(),
  claimablePartnerFeesLamports: Lamports,
  includedModificationsLeft: z.number().int(),
  activeJobId: z.string().nullable(),
  /** Absent from older servers (then unknown: the job page decides where to go). */
  activeJobStatus: JobStatus.nullable().optional(),
  /** Absent from older servers: then "start again" is not offered. */
  canStartAgain: z.boolean().optional(),
  /** Absent from older servers: then the figures are taken as read. */
  onchainAvailable: z.boolean().optional(),
});

const JobSchema = z.object({
  id: z.string().min(1),
  launchpadId: z.string().min(1),
  type: JobType,
  status: JobStatus,
  attempts: z.number().int().nonnegative(),
  failedStage: FailedStage.nullable(),
  error: z.string().nullable(),
  previewUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  refund: z.object({ lamports: Lamports, signature: z.string() }).nullable().optional(),
});

export const LaunchpadDetailSchema = LaunchpadSummarySchema.extend({
  spec: z.record(z.string(), z.unknown()),
  onchain: z.object({
    launchpadConfig: z.string().nullable(),
    launchpadCoinConfig: z.string().nullable(),
    launchpadCoinMint: z.string().nullable(),
  }),
  versions: z.array(
    z.object({
      jobId: z.string(),
      createdAt: z.string(),
      request: z.string().nullable(),
      previewUrl: z.string().nullable(),
    }),
  ),
  jobs: z.array(JobSchema),
});

const ListSchema = z.object({ launchpads: z.array(LaunchpadSummarySchema) });

// ---------------------------------------------------------------------------------------------
// Shared reads: one request for every component that needs the same data at the same time
// ---------------------------------------------------------------------------------------------

/** A read started this recently is reused by a component that mounts (many cards, one page). */
export const SHARED_READ_MS = 2_000;

const reads = new Map<string, { startedAt: number; promise: Promise<unknown> }>();

/**
 * Reuses a read of `key` (per signed-in wallet) started at or after `notBefore`; failed reads are
 * never reused.
 */
function shared<T>(name: string, load: () => Promise<T>, notBefore: number): Promise<T> {
  const key = `${getSessionSnapshot()?.wallet ?? ''}:${name}`;
  const hit = reads.get(key);
  if (hit && hit.startedAt >= notBefore) return hit.promise as Promise<T>;
  const entry = { startedAt: Date.now(), promise: load() as Promise<unknown> };
  reads.set(key, entry);
  entry.promise.catch(() => {
    if (reads.get(key) === entry) reads.delete(key);
  });
  return entry.promise as Promise<T>;
}

/** Forgets every shared read (tests, sign-out). */
export function resetLaunchpadReads(): void {
  reads.clear();
}

export interface ReadOptions {
  /** Only reuse a read started at or after this time (ms). Defaults to `SHARED_READ_MS` ago. */
  notBefore?: number;
}

export function fetchLaunchpadList(options: ReadOptions = {}): Promise<LaunchpadSummaryView[]> {
  return shared(
    'list',
    async () => (await request(WEB_API_ROUTES.launchpadsList.path, ListSchema)).launchpads,
    options.notBefore ?? Date.now() - SHARED_READ_MS,
  );
}

/** `null` when the launchpad does not exist or belongs to another wallet (404). */
export function fetchLaunchpadDetail(
  id: string,
  options: ReadOptions = {},
): Promise<LaunchpadDetailView | null> {
  return shared(
    `detail:${id}`,
    async () => {
      try {
        const detail = await request(
          route(WEB_API_ROUTES.launchpadGet.path, { id }),
          LaunchpadDetailSchema,
        );
        return { ...detail, spec: detail.spec as LaunchpadSpecDraft };
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    options.notBefore ?? Date.now() - SHARED_READ_MS,
  );
}

// ---------------------------------------------------------------------------------------------
// Realtime: one channel for all dashboard components
// ---------------------------------------------------------------------------------------------

export interface LaunchpadChange {
  table: 'jobs' | 'launchpads';
  /** The launchpad the changed row belongs to, when the payload says. */
  launchpadId: string | null;
  /** When the change was received (ms): reads started before it are stale. */
  at: number;
}

type ChangeListener = (change: LaunchpadChange) => void;

let live: { sb: SupabaseClient; channel: RealtimeChannel; listeners: Set<ChangeListener> } | null =
  null;

function idOf(row: unknown, key: string): string | null {
  if (!row || typeof row !== 'object') return null;
  const v = (row as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function emitChange(table: LaunchpadChange['table'], payload: { new?: unknown; old?: unknown }) {
  if (!live) return;
  const key = table === 'jobs' ? 'launchpad_id' : 'id';
  const change: LaunchpadChange = {
    table,
    launchpadId: idOf(payload.new, key) ?? idOf(payload.old, key),
    at: Date.now(),
  };
  for (const l of [...live.listeners]) {
    try {
      l(change);
    } catch {
      // a faulty listener must not stop the others
    }
  }
}

/** Calls `listener` on every change of the owner's launchpads and jobs (RLS-scoped). */
export function subscribeLaunchpadChanges(
  sb: SupabaseClient,
  listener: ChangeListener,
): () => void {
  if (live && live.sb !== sb) {
    void live.sb.removeChannel(live.channel);
    live = null;
  }
  if (!live) {
    const channel = sb
      .channel('launchpads-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'launchpads' }, (p) =>
        emitChange('launchpads', p),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, (p) =>
        emitChange('jobs', p),
      )
      .subscribe();
    live = { sb, channel, listeners: new Set() };
  }
  const current = live;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0 && live === current) {
      void current.sb.removeChannel(current.channel);
      live = null;
    }
  };
}
