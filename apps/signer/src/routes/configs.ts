/**
 * POST /v1/configs { jobId } -> { launchpadConfig, launchpadCoinConfig }
 * (docs/INTERFACES.md §7, tasks/05-SIGNER.md, docs/METEORA.md "the two configs").
 *
 * 1. Re-reads and checks the job, the launchpad, the spec (core validation) and the payment, and
 *    the `deploys_paused` kill switch (context.ts). Nothing from the request but the job id.
 * 2. Creates the launchpad's creator wallet in the keystore if absent (`creator:<launchpadId>`).
 * 3. Creates the launchpad config, then the launchpad coin config, each built by core from the
 *    spec, checked by the config policy, signed by a one-time config key and the payer wallet,
 *    journaled before sending, confirmed by polling (accounts.ts: at most once per account).
 * 4. Writes both addresses and the creator wallet ref to the launchpad row (compare-and-set).
 *
 * Idempotent per launchpad (there is exactly one creation job per launchpad): a retry returns the
 * same configs and never creates a second pair. The journal is the source of truth; a launchpad
 * row that already holds config addresses without a journal entry is refused (manual handling)
 * rather than risking a second pair.
 */
import type { PublicKey } from '@solana/web3.js';
import type { ConfigKind } from '@forge/core';
import type { SignerConfigsResponse } from '@forge/shared';
import { configCreationTarget } from './targets.js';
import { ensureAccountCreated } from './accounts.js';
import {
  creationEnv,
  ensureCreatorWallet,
  loadOnchainSetup,
  payerOf,
  recordLaunchpadColumns,
  type RouteRuntime,
} from './context.js';
import { fail } from './errors.js';
import type { ConfigsJournalEntry } from './journal.js';

const KINDS: ReadonlyArray<{ kind: ConfigKind; field: 'launchpad' | 'launchpadCoin' }> = [
  { kind: 'launchpad', field: 'launchpad' },
  { kind: 'launchpadCoin', field: 'launchpadCoin' },
];

export async function handleCreateConfigs(
  rt: RouteRuntime,
  jobId: string,
): Promise<SignerConfigsResponse> {
  // Cheap refusal before queuing on the launchpad lock; everything is re-read inside it.
  const outside = await loadOnchainSetup(rt, jobId);
  return rt.locks.run(outside.launchpad.id, async () => {
    const { launchpad, spec, owner } = await loadOnchainSetup(rt, jobId);
    const creator = await ensureCreatorWallet(rt, launchpad);
    const key = launchpad.id;

    let entry = await rt.journals.configs.get(key);
    if (!entry) {
      if (launchpad.launchpadConfig !== null || launchpad.launchpadCoinConfig !== null) {
        await rt.alert(
          'high',
          'configs_journal_missing',
          'A launchpad row holds config addresses the signer journal does not know: manual check needed (no second pair is created)',
          { launchpadId: key },
          `configs_journal_missing:${key}`,
        );
        fail(409, 'configs_journal_missing');
      }
      entry = {
        v: 1,
        launchpadId: key,
        jobId,
        ownerWallet: owner.toBase58(),
        creatorRef: creator.ref,
        creator: creator.publicKey.toBase58(),
        launchpad: null,
        launchpadCoin: null,
        recordedAt: null,
      };
    } else {
      assertEntryMatches(entry, { launchpadId: key, jobId, owner, creator });
    }

    const payer = await payerOf(rt);
    const env = creationEnv(rt, payer);
    for (const { kind, field } of KINDS) {
      const target = configCreationTarget(rt, {
        launchpadId: key,
        spec,
        kind,
        payer: payer.publicKey,
        owner,
      });
      let current: ConfigsJournalEntry = entry;
      const record = await ensureAccountCreated(env, target, current[field], async (next) => {
        current = { ...current, [field]: next };
        await rt.journals.configs.put(key, current);
      });
      entry = { ...current, [field]: record };
    }

    const launchpadConfig = entry.launchpad?.address;
    const launchpadCoinConfig = entry.launchpadCoin?.address;
    if (!launchpadConfig || !launchpadCoinConfig) fail(500, 'journal_error');

    await recordLaunchpadColumns(rt, key, {
      launchpad_config: launchpadConfig,
      launchpad_coin_config: launchpadCoinConfig,
      creator_wallet_ref: creator.ref,
    });
    if (entry.recordedAt === null) {
      entry = { ...entry, recordedAt: new Date(rt.now()).toISOString() };
      await rt.journals.configs.put(key, entry);
      rt.log.info(
        { launchpadId: key, jobId, launchpadConfig, launchpadCoinConfig },
        'launchpad configs recorded',
      );
    }
    return { launchpadConfig, launchpadCoinConfig };
  });
}

export function assertEntryMatches(
  entry: ConfigsJournalEntry,
  expected: {
    launchpadId: string;
    jobId: string;
    owner: PublicKey;
    creator: { ref: string; publicKey: PublicKey };
  },
): void {
  if (entry.launchpadId !== expected.launchpadId) fail(500, 'journal_error');
  if (entry.jobId !== expected.jobId) fail(409, 'configs_belong_to_another_job');
  if (entry.ownerWallet !== expected.owner.toBase58()) fail(409, 'owner_changed');
  if (
    entry.creatorRef !== expected.creator.ref ||
    entry.creator !== expected.creator.publicKey.toBase58()
  ) {
    fail(500, 'creator_mismatch');
  }
}
