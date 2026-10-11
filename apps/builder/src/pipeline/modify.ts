import type { JobRow } from '@forge/shared';
import type { JobContext, JobOutcome } from '../worker.js';
import { runBuildStep } from './build.js';
import type { PipelineDeps } from './context.js';
import { runDeployStep } from './deploy.js';
import { PipelineError } from './errors.js';

/**
 * `modify_launchpad` (docs/INTERFACES.md §4): the same building path with the client's request,
 * no on-chain step, released on approval.
 *
 *   building   agent on the live site, scan + forge.config.json check, local build, preview -> preview_ready
 *   deploying  merge, production deployment, promotion                                    -> live
 *
 * Only `theme` and `content` of forge.config.json may change: enforced by the scan and the
 * forge.config.json check at build time, and checked again (onchain, name, slug) before the merge.
 */
export async function handleModifyJob(
  deps: PipelineDeps,
  job: JobRow,
  ctx: JobContext,
): Promise<JobOutcome> {
  if (job.type !== 'modify_launchpad') throw new PipelineError('not a modification job');
  switch (job.status) {
    case 'building':
      return runBuildStep(deps, job, ctx, 'modify');
    case 'deploying':
      return runDeployStep(deps, job, ctx, 'modify');
    case 'onchain_setup':
      throw new PipelineError('modification jobs have no on-chain step');
    default:
      throw new PipelineError(`no modification step for status ${job.status}`);
  }
}
