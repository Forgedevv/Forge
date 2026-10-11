import type { JobHandler } from '../worker.js';
import type { PipelineDeps } from './context.js';
import { handleCreateJob } from './create.js';
import { PipelineError } from './errors.js';

export { AGENT_DEFAULTS, agentCommand, interpretAgentRun, runAgent } from './agent.js';
export type { AgentConfig, AgentGateway, AgentOutcome } from './agent.js';
export { PersistentCostGatewayStore } from './cost-store.js';
export { jobBranch, PIPELINE_DEFAULTS, StepAbortedError } from './context.js';
export type {
  BuildSiteFn,
  PipelineConfig,
  PipelineDeps,
  PipelineGithub,
  PipelineSigner,
  PipelineVercel,
  ScanFn,
} from './context.js';
export { AgentFailedError, PipelineError, PolicyViolationError, SiteBuildError } from './errors.js';
export { createGithubRepoSource } from './repo-snapshot.js';
export type { RepoSnapshot, RepoSource } from './repo-snapshot.js';
export { createSupabaseStore } from './store.js';
export type {
  JobCostStore,
  LaunchpadPatch,
  LaunchpadRecord,
  LaunchpadStore,
  SleepStore,
} from './store.js';
export { removeStaleWorkdirs } from './workdir.js';

/** The builder's job handler: routes a claimed job to its pipeline. */
export function createPipelineHandler(deps: PipelineDeps): JobHandler {
  return {
    async handle(job, ctx) {
      if (job.type !== 'create_launchpad') {
        throw new PipelineError('modification jobs are not handled yet');
      }
      return handleCreateJob(deps, job, ctx);
    },
  };
}
