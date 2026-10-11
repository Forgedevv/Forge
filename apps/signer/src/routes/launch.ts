/**
 * POST /v1/launch-coin/prepare { jobId } -> { partiallySignedTx, mint, summary, details }
 * (docs/INTERFACES.md §7; devnet test 3; core pool.ts).
 *
 * 1. Same checks as /v1/configs (context.ts, the payment proven on-chain by payment.ts); the two
 *    configs must be created (journal) and the coin config must still match the spec.
 * 2. The launchpad's durable nonce account is created once (accounts.ts), paid by the payer
 *    wallet, with the creator wallet as nonce authority (it already signs: no extra signature).
 * 3. core builds the launch transaction (pool + the client's first buy, durable nonce, FORGE
 *    referral by default); the launch policy checks it; a one-time mint key and the creator
 *    wallet sign; the client (fee payer, buyer) is the only signature left.
 * 4. The partially signed transaction is journaled per job, the mint is written to the launchpad
 *    row (compare-and-set), and the transaction is returned with the owner summary.
 *
 * Idempotent per job: while the nonce has not moved, a retry returns the SAME transaction (two
 * transactions on one nonce value are mutually exclusive anyway: the first to land advances it).
 * Once the nonce advanced, the stored transaction can never land: a new one (new mint) is built,
 * but only after proving, at finalized commitment from a node past the slot the advance was seen
 * at, that the advance was not the launch itself (mint and pool absent, no successful transaction
 * on the mint). A launched coin is refused (409), never prepared twice. The signer never sends
 * this transaction: the client signs and sends it (apps/web).
 */
import { PublicKey } from '@solana/web3.js';
import {
  missingSigners,
  serializeTransactionBase64,
  solToLamports,
  toOwnerTransactionSummary,
} from '@forge/core';
import { JobError, withRetry } from '../jobs/shared.js';
import { ensureAccountCreated } from './accounts.js';
import {
  assertRoutesNotPaused,
  creationEnv,
  ensureCreatorWallet,
  metadataUriFor,
  payerOf,
  recordLaunchpadColumns,
  type KeyRefWithAddress,
  type RouteRuntime,
  withLaunchpadLock,
} from './context.js';
import { createEphemeralKey } from './ephemeral.js';
import { fail } from './errors.js';
import type { LaunchJournalEntry, NonceJournalEntry } from './journal.js';
import { canonicalJson, sha256Hex } from './onchain.js';
import { assertCreationPaid } from './payment.js';
import { assertLaunchCoinTx } from './policy.js';
import type { SignerLaunchPrepareResult } from './schemas.js';
import { nonceCreationTarget, nonceParamsHash } from './targets.js';

function resultOf(entry: LaunchJournalEntry): SignerLaunchPrepareResult {
  return {
    partiallySignedTx: entry.partiallySignedTx,
    mint: entry.mint,
    summary: entry.summary,
    details: entry.details,
  };
}

/** The launchpad's durable nonce account, created once (journal `nonce.<launchpadId>`). */
async function ensureNonceAccount(
  rt: RouteRuntime,
  launchpadId: string,
  creator: KeyRefWithAddress,
  payer: KeyRefWithAddress,
): Promise<PublicKey> {
  let entry: NonceJournalEntry = (await rt.journals.nonces.get(launchpadId)) ?? {
    v: 1,
    launchpadId,
    authority: creator.publicKey.toBase58(),
    creation: null,
  };
  if (entry.launchpadId !== launchpadId) fail(500, 'journal_error');
  if (entry.authority !== creator.publicKey.toBase58()) fail(500, 'nonce_authority_mismatch');
  const target = nonceCreationTarget(rt, {
    launchpadId,
    payer: payer.publicKey,
    authority: creator.publicKey,
  });
  if (target.paramsHash !== nonceParamsHash(creator.publicKey)) fail(500, 'journal_error');
  const record = await ensureAccountCreated(
    creationEnv(rt, payer),
    target,
    entry.creation,
    async (next) => {
      entry = { ...entry, creation: next };
      await rt.journals.nonces.put(launchpadId, entry);
    },
  );
  return new PublicKey(record.address);
}

export async function handlePrepareLaunch(
  rt: RouteRuntime,
  jobId: string,
): Promise<SignerLaunchPrepareResult> {
  return withLaunchpadLock(rt, jobId, async (setup) => {
    const { launchpad, spec, owner } = setup;
    const launchpadId = launchpad.id;
    const { core } = rt;
    await assertCreationPaid(rt, setup);

    // 1. The configs this launch depends on.
    const configs = await rt.journals.configs.get(launchpadId);
    if (
      !configs ||
      configs.launchpad?.status !== 'confirmed' ||
      configs.launchpadCoin?.status !== 'confirmed' ||
      !configs.launchpadCoin.address
    ) {
      fail(409, 'configs_not_ready');
    }
    if (configs.jobId !== jobId) fail(409, 'configs_belong_to_another_job');
    if (configs.ownerWallet !== owner.toBase58()) fail(409, 'owner_changed');
    if (configs.launchpadCoin.paramsHash !== core.configParamsHash(spec, 'launchpadCoin')) {
      await rt.alert(
        'high',
        'launch_spec_changed',
        'The spec of a launchpad no longer matches its coin config: launch refused, manual check needed',
        { launchpadId },
        `launch_spec_changed:${launchpadId}`,
      );
      fail(409, 'spec_changed');
    }
    const coinConfig = new PublicKey(configs.launchpadCoin.address);
    if (
      launchpad.launchpadCoinConfig !== null &&
      launchpad.launchpadCoinConfig !== coinConfig.toBase58()
    ) {
      fail(409, 'launchpad_address_conflict');
    }

    const creator = await ensureCreatorWallet(rt, launchpad);
    if (configs.creator !== creator.publicKey.toBase58() || configs.creatorRef !== creator.ref) {
      fail(500, 'creator_mismatch');
    }

    // 2. A mint on the row, or a nonce in use, without the journal entries: never build blind.
    let entry = await rt.journals.launches.get(jobId);
    const nonceJournal = await rt.journals.nonces.get(launchpadId);
    if ((entry || launchpad.launchpadCoinMint !== null) && !nonceJournal) {
      await rt.alert(
        'high',
        'nonce_journal_missing',
        'A launch was prepared for this launchpad but the signer nonce journal is missing: manual check needed',
        { launchpadId, jobId },
        `nonce_journal_missing:${launchpadId}`,
      );
      fail(409, 'nonce_journal_missing');
    }
    if (!entry && launchpad.launchpadCoinMint !== null) {
      await rt.alert(
        'high',
        'launch_journal_missing',
        'A launchpad row holds a coin mint the signer journal does not know: manual check needed',
        { launchpadId, jobId },
        `launch_journal_missing:${launchpadId}`,
      );
      fail(409, 'launch_journal_missing');
    }

    const payer = await payerOf(rt);
    const nonceAccount = await ensureNonceAccount(rt, launchpadId, creator, payer);
    const current = await withRetry(
      () => core.readNonce(nonceAccount, creator.publicKey, 'confirmed'),
      rt.retry,
    );
    if (!current) fail(503, 'nonce_not_visible');

    const metadataUri = metadataUriFor(rt.metadataUriTemplate, launchpad);
    const firstBuyLamports = solToLamports(spec.launchpadCoin.firstBuySol);
    const coin = spec.launchpadCoin;
    const inputsHash = sha256Hex(
      canonicalJson({
        config: coinConfig,
        owner,
        creator: creator.publicKey,
        nonceAccount,
        name: coin.name,
        symbol: coin.symbol,
        metadataUri,
        firstBuyLamports,
        referral: core.firstBuyReferral,
      }),
    );

    // 3. An existing transaction: same nonce -> same transaction; advanced -> prove, then rebuild.
    let replacedMints: string[] = [];
    let builds = 0;
    if (entry) {
      if (
        entry.launchpadId !== launchpadId ||
        entry.owner !== owner.toBase58() ||
        entry.details.nonceAccount !== nonceAccount.toBase58() ||
        entry.details.config !== coinConfig.toBase58()
      ) {
        fail(500, 'launch_journal_mismatch');
      }
      const previousMint = new PublicKey(entry.mint);
      const previousPool = core.poolAddress(coinConfig, previousMint);
      if (current.nonce === entry.nonceValue) {
        if (entry.inputsHash !== inputsHash) {
          await rt.alert(
            'high',
            'launch_inputs_changed',
            'The inputs of a prepared launch changed while its transaction is still valid: manual check needed',
            { launchpadId, jobId },
            `launch_inputs_changed:${jobId}`,
          );
          fail(409, 'launch_inputs_changed');
        }
        await recordLaunchpadColumns(
          rt,
          launchpadId,
          { launchpad_coin_mint: entry.mint },
          { launchpad_coin_mint: entry.replacedMints },
        );
        rt.log.info(
          { launchpadId, jobId, mint: entry.mint },
          'prepared launch returned again (nonce unchanged)',
        );
        return resultOf(entry);
      }

      const finalized = await withRetry(
        () => core.readNonce(nonceAccount, creator.publicKey, 'finalized'),
        rt.retry,
      );
      if (!finalized || finalized.nonce === entry.nonceValue) fail(503, 'launch_settling');
      const [mintExists, poolExists] = await withRetry(
        () => core.accountsExist([previousMint, previousPool], 'finalized', finalized.slot),
        rt.retry,
      );
      const landed =
        mintExists ||
        poolExists ||
        (await withRetry(() => core.hasSuccessfulTransaction(previousMint), rt.retry));
      if (landed) {
        await recordLaunchpadColumns(
          rt,
          launchpadId,
          { launchpad_coin_mint: entry.mint },
          { launchpad_coin_mint: entry.replacedMints },
        );
        await rt.alert(
          'normal',
          'coin_already_launched',
          'A launch was requested again for a launchpad whose coin is already launched',
          { launchpadId, jobId, mint: entry.mint },
          `coin_already_launched:${jobId}`,
        );
        fail(409, 'coin_already_launched');
      }
      replacedMints = [...entry.replacedMints, entry.mint].slice(-50);
      builds = entry.builds;
      if (builds >= rt.maxLaunchBuilds) {
        await rt.alert(
          'high',
          'launch_rebuilds_exhausted',
          'A launch transaction was rebuilt too many times: manual check needed',
          { launchpadId, jobId, builds },
          `launch_rebuilds_exhausted:${jobId}`,
        );
        fail(409, 'launch_rebuilds_exhausted');
      }
      rt.log.warn(
        { launchpadId, jobId, mint: entry.mint },
        'nonce advanced without a launch: rebuilding the launch transaction',
      );
    }

    // 4. Build (core), check (policy), sign (mint + creator), journal, record, return.
    await assertRoutesNotPaused(rt);
    const mintKey = createEphemeralKey();
    try {
      const mint = mintKey.publicKey;
      const built = await withRetry(
        () =>
          core.buildLaunchCoinTx({
            config: coinConfig,
            creator: creator.publicKey,
            owner,
            mint,
            name: coin.name,
            symbol: coin.symbol,
            metadataUri,
            firstBuyLamports,
            nonceAccount,
          }),
        rt.retry,
      );
      const { transaction: tx, summary } = built;
      const pool = core.poolAddress(coinConfig, mint);
      if (
        !summary.durableNonce ||
        !summary.durableNonce.nonceAccount.equals(nonceAccount) ||
        !summary.durableNonce.authority.equals(creator.publicKey)
      ) {
        throw new JobError('TX_POLICY', 'launch transaction without the launchpad nonce');
      }
      if (summary.durableNonce.nonce !== current.nonce) fail(503, 'nonce_moved');
      if (
        !summary.pool.equals(pool) ||
        !summary.mint.equals(mint) ||
        !summary.config.equals(coinConfig) ||
        !summary.owner.equals(owner) ||
        !summary.creator.equals(creator.publicKey) ||
        summary.costs.firstBuyLamports !== firstBuyLamports ||
        summary.costs.creatorTotalLamports !== 0n
      ) {
        throw new JobError('TX_POLICY', 'launch summary does not match the request');
      }
      assertLaunchCoinTx(tx, {
        dbcProgramId: core.dbcProgramId,
        owner,
        creator: creator.publicKey,
        mint,
        config: coinConfig,
        pool,
        nonceAccount,
        nonceValue: current.nonce,
        firstBuy: firstBuyLamports > 0n,
      });

      await assertRoutesNotPaused(rt);
      mintKey.signTransaction(tx);
      mintKey.destroy();
      await rt.keystore.withSigner(creator.ref, (signer) => {
        if (!signer.publicKey.equals(creator.publicKey)) throw new JobError('SIGNER_MISMATCH');
        signer.signTransaction(tx);
      });
      const missing = missingSigners(tx);
      if (missing.length !== 1 || !missing[0]!.equals(owner)) {
        throw new JobError('TX_POLICY', 'only the client signature may be missing');
      }
      const partiallySignedTx = serializeTransactionBase64(tx);

      const next: LaunchJournalEntry = {
        v: 1,
        jobId,
        launchpadId,
        owner: owner.toBase58(),
        mint: mint.toBase58(),
        nonceValue: current.nonce,
        inputsHash,
        partiallySignedTx,
        summary: toOwnerTransactionSummary(summary),
        details: {
          pool: pool.toBase58(),
          config: coinConfig.toBase58(),
          nonceAccount: nonceAccount.toBase58(),
          creator: creator.publicKey.toBase58(),
          expectedTokensOut: summary.expectedTokensOut.toString(),
          minimumTokensOut: summary.minimumTokensOut.toString(),
          referral: summary.referralSource,
          metadataUri,
        },
        builtAt: new Date(rt.now()).toISOString(),
        builds: builds + 1,
        replacedMints,
      };
      await rt.journals.launches.put(jobId, next);
      entry = next;
      await recordLaunchpadColumns(
        rt,
        launchpadId,
        { launchpad_coin_mint: next.mint },
        { launchpad_coin_mint: replacedMints },
      );
      rt.log.info(
        {
          launchpadId,
          jobId,
          mint: next.mint,
          pool: next.details.pool,
          nonceAccount: next.details.nonceAccount,
          referral: summary.referralSource,
          referralOmittedForSize: summary.referralOmittedForSize,
          txBytes: summary.txBytes,
        },
        'launch transaction prepared',
      );
      if (summary.referralOmittedForSize) {
        await rt.alert(
          'normal',
          'launch_referral_omitted',
          'The FORGE referral was left out of a launch transaction to fit the size limit',
          { launchpadId, jobId },
          `launch_referral_omitted:${jobId}`,
        );
      }
      return resultOf(next);
    } finally {
      mintKey.destroy();
    }
  });
}
