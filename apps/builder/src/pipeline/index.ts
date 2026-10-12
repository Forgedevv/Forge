import type { JobHandler } from '../worker.js';
import type { PipelineDeps } from './context.js';
import { handleCreateJob } from './create.js';
import { handleModifyJob } from './modify.js';

export { AGENT_DEFAULTS, agentCommand, interpretAgentRun, runAgent } from './agent.js';
export type { AgentConfig, AgentGateway, AgentOutcome } from './agent.js';
export { PersistentCostGatewayStore } from './cost-store.js';
export type { DailyCostSeed } from './cost-store.js';
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
  DailyCostSource,
  JobCostStore,
  LaunchpadPatch,
  LaunchpadRecord,
  LaunchpadStore,
  SleepStore,
} from './store.js';
export { removeStaleWorkdirs } from './workdir.js';

/** The builder's job handler: routes a claimed job to the creation or modification pipeline. */
export function createPipelineHandler(deps: PipelineDeps): JobHandler {
  return {
    handle(job, ctx) {
      return job.type === 'create_launchpad'
        ? handleCreateJob(deps, job, ctx)
        : handleModifyJob(deps, job, ctx);
    },
  };
}
