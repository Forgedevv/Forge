import type { JobRow } from '@forge/shared';
import type { JobContext, JobOutcome } from '../worker.js';
import { runBuildStep } from './build.js';
import type { PipelineDeps } from './context.js';
import { runDeployStep } from './deploy.js';
import { PipelineError } from './errors.js';
import { runOnchainStep } from './onchain.js';

/**
 * `create_launchpad` (docs/INTERFACES.md §4):
 *
 *   building       repo from the template, agent, scan, local build, preview  -> preview_ready
 *   onchain_setup  signer configs + launch transaction, addresses committed    -> awaiting_owner_signature
 *   deploying      merge, production deployment, promotion, subdomain          -> live
 */
export async function handleCreateJob(
  deps: PipelineDeps,
  job: JobRow,
  ctx: JobContext,
): Promise<JobOutcome> {
  if (job.type !== 'create_launchpad') throw new PipelineError('not a creation job');
  switch (job.status) {
    case 'building':
      return runBuildStep(deps, job, ctx, 'create');
    case 'onchain_setup':
      return runOnchainStep(deps, job, ctx);
    case 'deploying':
      return runDeployStep(deps, job, ctx, 'create');
    default:
      throw new PipelineError(`no creation step for status ${job.status}`);
  }
}
