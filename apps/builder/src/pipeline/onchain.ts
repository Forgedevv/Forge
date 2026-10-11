import type { JobRow } from '@forge/shared';
import type { JobContext, JobOutcome } from '../worker.js';
import { guard, jobBranch, jobFields, loadLaunchpad, say, type PipelineDeps } from './context.js';
import { PipelineError } from './errors.js';
import { STEP_EVENTS } from './messages.js';
import {
  onchainBlock,
  parseSiteConfig,
  sameOnchain,
  serializeSiteConfig,
  SITE_CONFIG_PATH,
  typedSiteConfig,
  withOnchain,
} from './site-config.js';
import type { LaunchpadPatch } from './store.js';

/**
 * The `onchain_setup` step of a creation job (after the client approved the preview):
 *
 *   signer /v1/configs -> signer /v1/launch-coin/prepare
 *   -> forge.config.json#onchain on forge/<jobId> (builder-owned commit, never the agent)
 *   -> launchpad row -> owner_tx
 *
 * The mint comes from the prepare call, so the addresses are written once both calls answered.
 * The signer re-reads everything from Supabase and both routes are idempotent, so a re-run after a
 * crash (the team puts the job back to `approved`) creates nothing twice. A failure here is never
 * retried automatically (D18): the worker marks the job failed (stage `onchain`) and alerts.
 */
export async function runOnchainStep(
  deps: PipelineDeps,
  job: JobRow,
  jobCtx: JobContext,
): Promise<JobOutcome> {
  if (job.type !== 'create_launchpad') {
    throw new PipelineError('only creation jobs have an on-chain step');
  }
  const { signal } = jobCtx;
  const { launchpad, spec, repoName } = await loadLaunchpad(deps, job);
  if (launchpad.status !== 'draft') {
    throw new PipelineError(
      `the on-chain step needs a draft launchpad (status ${launchpad.status})`,
    );
  }
  const repo = await deps.github.getRepo(repoName);
  if (!repo) throw new PipelineError('the launchpad repository does not exist');
  const branch = jobBranch(job.id);
  if ((await deps.github.getBranchHead(repo.name, branch)) === null) {
    throw new PipelineError('the job branch does not exist: the preview was never built');
  }
  // Read and validate the branch's config before anything is created on-chain.
  const text = await deps.github.readFile(repo.name, SITE_CONFIG_PATH, branch);
  if (text === null) throw new PipelineError('forge.config.json is missing from the job branch');
  const config = parseSiteConfig(text);
  const typed = typedSiteConfig(config);
  if (typed.slug !== spec.slug) throw new PipelineError('forge.config.json slug does not match');
  // Re-entry guard: this step already completed for the job (addresses on the branch and on the
  // launchpad, launch transaction handed out). The client may have signed it: never prepare
  // another one. A failed release is retried from `owner_signed`; rebuilding a launch transaction
  // that was never signed is a deliberate team action (clear `jobs.owner_tx` first).
  if (
    typed.onchain !== undefined &&
    launchpad.launchpad_coin_mint !== null &&
    job.owner_tx !== null
  ) {
    throw new PipelineError(
      'the on-chain step already completed for this job: retry a failed release from owner_signed (or clear owner_tx to rebuild an unsigned launch transaction)',
    );
  }

  await say(jobCtx, STEP_EVENTS.createConfigs);
  guard(signal);
  const configs = await deps.signer.createConfigs(job.id);
  await say(jobCtx, STEP_EVENTS.prepareLaunch);
  guard(signal);
  const prepared = await deps.signer.prepareLaunchCoin(job.id);

  const onchain = onchainBlock({
    cluster: deps.config.cluster,
    launchpadConfig: configs.launchpadConfig,
    launchpadCoinConfig: configs.launchpadCoinConfig,
    launchpadCoinMint: prepared.mint,
    spec,
  });
  const recorded: Array<[string | null, string, string]> = [
    [launchpad.launchpad_config, onchain.launchpadConfig, 'launchpad config'],
    [launchpad.launchpad_coin_config, onchain.launchpadCoinConfig, 'launchpad coin config'],
    [launchpad.launchpad_coin_mint, onchain.launchpadCoinMint, 'launchpad coin mint'],
  ];
  for (const [stored, fresh, what] of recorded) {
    if (stored !== null && stored !== fresh) {
      throw new PipelineError(`the signer returned a ${what} that differs from the recorded one`);
    }
  }

  if (typed.onchain !== undefined) {
    if (!sameOnchain(typed.onchain, onchain)) {
      throw new PipelineError('forge.config.json already holds different on-chain addresses');
    }
  } else {
    guard(signal);
    const commit = await deps.github.commitFiles({
      repo: repo.name,
      branch,
      message: `Record the on-chain addresses (job ${job.id})`,
      files: [
        { path: SITE_CONFIG_PATH, content: serializeSiteConfig(withOnchain(config, onchain)) },
      ],
    });
    jobCtx.logger.info(
      jobFields(job, { commit: commit.commitSha }),
      'on-chain addresses committed',
    );
  }

  const patch: LaunchpadPatch = {};
  if (launchpad.launchpad_config === null) patch.launchpad_config = onchain.launchpadConfig;
  if (launchpad.launchpad_coin_config === null) {
    patch.launchpad_coin_config = onchain.launchpadCoinConfig;
  }
  if (launchpad.launchpad_coin_mint === null) patch.launchpad_coin_mint = onchain.launchpadCoinMint;
  if (Object.keys(patch).length > 0) {
    guard(signal);
    await deps.store.updateLaunchpad(launchpad.id, patch);
  }
  return { patch: { owner_tx: prepared.partiallySignedTx } };
}
