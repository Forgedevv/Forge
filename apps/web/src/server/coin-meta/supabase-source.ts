import { FailedStage, JobStatus, LaunchpadStatus } from '@forge/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { CoinMetaSource } from './handler';
import type { CoinMetaRecord } from './metadata';

/*
 * Reads of GET /api/coin-meta/:slug with the service role (launchpads are not readable by anon
 * under RLS). Only the columns the metadata needs are selected.
 */

export class CoinMetaReadError extends Error {
  readonly dbCode: string | undefined;

  constructor(operation: string, dbCode?: string) {
    // Never the Supabase error text.
    super(`coin metadata read failed: ${operation}`);
    this.name = 'CoinMetaReadError';
    this.dbCode = dbCode;
  }
}

const LaunchpadRow = z.object({
  id: z.string(),
  slug: z.string(),
  status: LaunchpadStatus,
  spec: z.unknown(),
});

const JobRow = z.object({ status: JobStatus, failed_stage: FailedStage.nullable() });

export function createSupabaseCoinMetaSource(db: SupabaseClient): CoinMetaSource {
  return {
    async find(slug): Promise<CoinMetaRecord | null> {
      const lp = await db
        .from('launchpads')
        .select('id, slug, status, spec')
        .eq('slug', slug)
        .maybeSingle();
      if (lp.error) throw new CoinMetaReadError('launchpad', lp.error.code);
      if (!lp.data) return null;
      const launchpad = LaunchpadRow.safeParse(lp.data);
      if (!launchpad.success) throw new CoinMetaReadError('parse launchpad');

      // The newest creation job: a launchpad started again (POST /api/launchpads/:id/retry)
      // keeps its refunded attempts, which were never approved.
      const jobs = await db
        .from('jobs')
        .select('status, failed_stage')
        .eq('launchpad_id', launchpad.data.id)
        .eq('type', 'create_launchpad')
        .order('created_at', { ascending: false })
        .limit(1);
      if (jobs.error) throw new CoinMetaReadError('job', jobs.error.code);
      const first = (jobs.data ?? [])[0];
      const job = first === undefined ? null : JobRow.safeParse(first);
      if (job && !job.success) throw new CoinMetaReadError('parse job');

      return {
        slug: launchpad.data.slug,
        status: launchpad.data.status,
        spec: launchpad.data.spec,
        createJob: job ? { status: job.data.status, failedStage: job.data.failed_stage } : null,
      };
    },
  };
}
