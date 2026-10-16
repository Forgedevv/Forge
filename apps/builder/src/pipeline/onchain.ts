import { JobOwnerTxDetails, type JobRow } from '@forge/shared';
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
 *   -> launchpad row -> owner_tx + owner_tx_details (one update, by the worker)
 *
 * The mint comes from the prepare call, so the addresses are written once both calls answered.
 * The launch accounts of the prepare answer (`details`) are required: they are stored with the
 * transaction so that apps/web pins them instead of reading them back from it.
 * The signer re-reads everything from Supabase and both routes are idempotent, so a re-run after a
 * crash (the team puts the job back to `approved`) creates nothing twice. A failure here is never
 * retried automatically (D18): the worker marks the job failed (stage `onchain`) and alerts.
 *
 * After an operator revocation of the handed-out launch (signer `--revoke-launch`, then the team
 * clears `owner_tx` / `owner_tx_details` and puts the job back), prepare builds a new launch with
 * a NEW mint and records it on the launchpad row itself. The row is re-read after the call: a mint
 * the signer replaced that way is accepted, and `onchain.launchpadCoinMint` is rewritten in a
 * builder-owned commit. Any other difference (a config address, a mint the row does not hold)
 * stops the step.
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
  // that was never signed is a deliberate team action (clear `jobs.owner_tx` and
  // `jobs.owner_tx_details` first).
  if (
    typed.onchain !== undefined &&
    launchpad.launchpad_coin_mint !== null &&
    job.owner_tx !== null
  ) {
    throw new PipelineError(
      'the on-chain step already completed for this job: retry a failed release from owner_signed (or clear owner_tx and owner_tx_details to rebuild an unsigned launch transaction)',
    );
  }

  await say(jobCtx, STEP_EVENTS.createConfigs);
  guard(signal);
  const configs = await deps.signer.createConfigs(job.id);
  await say(jobCtx, STEP_EVENTS.prepareLaunch);
  guard(signal);
  const prepared = await deps.signer.prepareLaunchCoin(job.id);
  // Checked before anything is written: no details, no stored launch transaction.
  const details = launchDetails(prepared.details, configs.launchpadCoinConfig);

  const onchain = onchainBlock({
    cluster: deps.config.cluster,
    launchpadConfig: configs.launchpadConfig,
    launchpadCoinConfig: configs.launchpadCoinConfig,
    launchpadCoinMint: prepared.mint,
    spec,
  });
  // The row as the signer left it: prepare records the mint it handed out (compare-and-set).
  const current = await deps.store.getLaunchpad(launchpad.id);
  if (!current) throw new PipelineError('launchpad not found after the launch was prepared');
  const rebuilt = launchRebuilt(
    launchpad.launchpad_coin_mint,
    current.launchpad_coin_mint,
    onchain,
  );
  const recorded: Array<[Array<string | null>, string, string]> = [
    [
      [launchpad.launchpad_config, current.launchpad_config],
      onchain.launchpadConfig,
      'launchpad config',
    ],
    [
      [launchpad.launchpad_coin_config, current.launchpad_coin_config],
      onchain.launchpadCoinConfig,
      'launchpad coin config',
    ],
    [
      rebuilt
        ? [current.launchpad_coin_mint]
        : [launchpad.launchpad_coin_mint, current.launchpad_coin_mint],
      onchain.launchpadCoinMint,
      'launchpad coin mint',
    ],
  ];
  for (const [stored, fresh, what] of recorded) {
    if (stored.some((value) => value !== null && value !== fresh)) {
      throw new PipelineError(`the signer returned a ${what} that differs from the recorded one`);
    }
  }

  let message: string | null = `Record the on-chain addresses (job ${job.id})`;
  if (typed.onchain !== undefined) {
    if (sameOnchain(typed.onchain, onchain)) {
      message = null;
    } else if (
      rebuilt &&
      typed.onchain.launchpadCoinMint === launchpad.launchpad_coin_mint &&
      sameOnchain({ ...typed.onchain, launchpadCoinMint: onchain.launchpadCoinMint }, onchain)
    ) {
      // Only the mint of the rebuilt launch changes; any other address stays refused.
      message = `Record the rebuilt launch coin mint (job ${job.id})`;
    } else {
      throw new PipelineError('forge.config.json already holds different on-chain addresses');
    }
  }
  if (message !== null) {
    guard(signal);
    const commit = await deps.github.commitFiles({
      repo: repo.name,
      branch,
      message,
      files: [
        { path: SITE_CONFIG_PATH, content: serializeSiteConfig(withOnchain(config, onchain)) },
      ],
    });
    jobCtx.logger.info(
      jobFields(job, { commit: commit.commitSha }),
      'on-chain addresses committed',
    );
  }
  if (rebuilt) {
    jobCtx.logger.warn(
      jobFields(job, { mint: onchain.launchpadCoinMint }),
      'the signer rebuilt the launch transaction with a new mint (previous one revoked)',
    );
  }

  const patch: LaunchpadPatch = {};
  if (current.launchpad_config === null) patch.launchpad_config = onchain.launchpadConfig;
  if (current.launchpad_coin_config === null) {
    patch.launchpad_coin_config = onchain.launchpadCoinConfig;
  }
  if (current.launchpad_coin_mint === null) patch.launchpad_coin_mint = onchain.launchpadCoinMint;
  if (Object.keys(patch).length > 0) {
    guard(signal);
    await deps.store.updateLaunchpad(launchpad.id, patch);
  }
  return { patch: { owner_tx: prepared.partiallySignedTx, owner_tx_details: details } };
}

/**
 * True when the signer rebuilt the launch with a new mint during this prepare call: the row held
 * mint `before` when the step started, and the signer replaced it with the mint it just returned.
 * The signer replaces a recorded mint only after proving that the previous launch transaction can
 * never land (its durable nonce moved without a launch, e.g. after an operator revocation with
 * `--revoke-launch`), through a compare-and-set that accepts only the mints it replaced itself
 * (apps/signer routes/launch.ts). The prepare answer has no rebuild field: that row write is the
 * signer's report. The configs are never accepted as changed.
 */
function launchRebuilt(
  before: string | null,
  after: string | null,
  onchain: { launchpadCoinMint: string },
): boolean {
  return (
    before !== null && before !== onchain.launchpadCoinMint && after === onchain.launchpadCoinMint
  );
}

/**
 * The `details` of the prepare answer as stored in `jobs.owner_tx_details`: required, validated
 * with the shared schema (unknown fields dropped), and naming the launchpad coin config the
 * signer returned. Otherwise the launch transaction is not stored.
 */
function launchDetails(raw: unknown, launchpadCoinConfig: string): JobOwnerTxDetails {
  if (raw === undefined || raw === null) {
    throw new PipelineError(
      'the signer returned no launch details: the launch transaction is not stored',
    );
  }
  const parsed = JobOwnerTxDetails.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))];
    throw new PipelineError(
      `the signer returned invalid launch details (${fields.join(', ')}): the launch transaction is not stored`,
    );
  }
  if (parsed.data.config !== launchpadCoinConfig) {
    throw new PipelineError(
      'the signer returned launch details for another launchpad coin config: the launch transaction is not stored',
    );
  }
  return parsed.data;
}
