import {
  LaunchTransactionCheckError,
  TransactionEncodingError,
  assertSignedCopyOf,
  deserializeTransactionBase64,
  missingSigners,
  requiredSigners,
  solToLamports,
  transactionSignature,
  verifyLaunchCoinTransaction,
  type VerifiedLaunchCoinTransaction,
} from '@forge/core';
import {
  LaunchpadSpec,
  OwnerTransactionLaunch,
  type JobStatus,
  type OwnerTransactionSummary,
} from '@forge/shared';
import type { Transaction } from '@solana/web3.js';
import { RpcUnavailableError, type LaunchChain } from './chain';
import { RouteError } from './http';
import { errorName, type RoutesLogger } from './log';
import { addJobEventSafe, requireOwnedJob } from './service';
import type { OwnedJob, RoutesStore } from './store';

/*
 * The client's launch signature (docs/INTERFACES.md §4 and §6; devnet test 3).
 *
 * The signer prepares the launch transaction (pool creation + the client's first buy, durable
 * nonce), signs it as creator and mint, and the builder stores it in `jobs.owner_tx`. Here:
 *
 * GET  — hands that exact transaction to the owner, with a summary (coin, first buy, what the
 *        owner pays besides it, expected wallet) and the launch accounts the browser pins
 *        (`launch`), after checking it is complete except for the owner's signature, that the
 *        owner is its fee payer, and that it is exactly the launch of this launchpad's coin
 *        (`verifyLaunchCoinTransaction` of @forge/core).
 * POST — receives the owner-signed copy and accepts it only if it is the stored transaction byte
 *        for byte with every signature valid (`assertSignedCopyOf` of @forge/core): any other
 *        transaction is refused. It is sent through the server RPC, confirmed by polling, and the
 *        job moves `awaiting_owner_signature -> owner_signed` with a conditional update.
 *
 * Idempotency: the owner signature is deterministic (ed25519) and the durable nonce keeps the
 * transaction valid, so a retry carries the same signature. Before sending, its status is read:
 * a confirmed transaction is never sent again; a job already past `owner_signed` answers with the
 * signature without touching the chain.
 */

const SIGNED_OR_LATER: ReadonlySet<JobStatus> = new Set(['owner_signed', 'deploying', 'live']);

/** How long a POST waits for the confirmation (the route allows 60 s). */
export const OWNER_TX_CONFIRM_DEADLINE_MS = 25_000;

export interface OwnerTransactionView {
  transaction: string;
  summary: OwnerTransactionSummary;
  /**
   * The accounts the browser passes to `verifyLaunchCoinTransaction` before the owner signs:
   * config and mint from the launchpad row (the transaction was checked against them), creator
   * wallet, durable nonce account and metadata URI as verified in the stored transaction.
   */
  launch: OwnerTransactionLaunch;
  /**
   * `ok`: the summary comes from a simulation of the exact transaction; `failed`: the simulation
   * failed (e.g. the wallet cannot pay), the fee is the network fee only; `unavailable`: no
   * simulation result.
   */
  simulation: 'ok' | 'failed' | 'unavailable';
}

export interface OwnerTransactionServiceDeps {
  store: RoutesStore;
  chain: LaunchChain;
  logger: RoutesLogger;
  confirmDeadlineMs?: number;
}

export interface OwnerTransactionService {
  get(input: { wallet: string; jobId: string }): Promise<OwnerTransactionView>;
  submit(input: {
    wallet: string;
    jobId: string;
    signedTransaction: string;
  }): Promise<{ signature: string }>;
}

const UNAVAILABLE_MESSAGE =
  'The launch transaction is not available right now. Our team has been notified.';

export function createOwnerTransactionService(
  deps: OwnerTransactionServiceDeps,
): OwnerTransactionService {
  const { store, chain, logger } = deps;
  const confirmDeadlineMs = deps.confirmDeadlineMs ?? OWNER_TX_CONFIRM_DEADLINE_MS;

  function unavailable(owned: OwnedJob, reason: string): never {
    logger.log('error', 'owner_tx.unusable', { jobId: owned.job.id, reason });
    throw new RouteError(503, 'OWNER_TX_UNAVAILABLE', UNAVAILABLE_MESSAGE);
  }

  /** Checks job type, owner consistency and launchpad state common to GET and POST. */
  function assertLaunchJob(owned: OwnedJob, wallet: string): LaunchpadSpec {
    const { job, launchpad } = owned;
    if (job.type !== 'create_launchpad') {
      throw new RouteError(409, 'INVALID_STATUS', 'This job has no launch transaction.', {
        status: job.status,
      });
    }
    const spec = LaunchpadSpec.safeParse(launchpad.spec);
    if (!spec.success) unavailable(owned, 'spec_invalid');
    // Session wallet = launchpads.owner_wallet = spec.ownerWallet (the store filtered on the first).
    if (launchpad.ownerWallet !== wallet || spec.data.ownerWallet !== wallet) {
      logger.log('error', 'launchpad.owner_mismatch', { launchpadId: launchpad.id });
      throw new RouteError(
        403,
        'WRONG_WALLET',
        'This action must be signed with the wallet that owns the launchpad.',
      );
    }
    return spec.data;
  }

  /**
   * The stored transaction, checked: decodes, present signatures valid, the owner is the fee
   * payer and the only missing signer, and it is exactly the launch of this launchpad's coin
   * (`verifyLaunchCoinTransaction` of @forge/core): the launchpad coin config and mint of the
   * row, the coin name and symbol and the exact first buy of the spec, SOL moved only between the
   * owner and its own wrapped SOL account, nothing else. Otherwise it is never handed out.
   * Returns it with the launch accounts the browser pins (`OwnerTransactionLaunch`).
   */
  function storedTransaction(
    owned: OwnedJob,
    wallet: string,
    spec: LaunchpadSpec,
  ): { tx: Transaction; launch: OwnerTransactionLaunch } {
    const ownerTx = owned.job.ownerTx;
    if (!ownerTx) unavailable(owned, 'missing');
    let tx: Transaction;
    try {
      tx = deserializeTransactionBase64(ownerTx);
    } catch (error) {
      unavailable(owned, error instanceof TransactionEncodingError ? error.code : errorName(error));
    }
    const signers = requiredSigners(tx);
    const missing = missingSigners(tx);
    if (signers[0]?.toBase58() !== wallet) unavailable(owned, 'fee_payer_not_owner');
    if (missing.length !== 1 || missing[0]?.toBase58() !== wallet) {
      unavailable(owned, 'unexpected_missing_signers');
    }
    const { launchpadCoinConfig, launchpadCoinMint } = owned.launchpad;
    if (!launchpadCoinConfig || !launchpadCoinMint) unavailable(owned, 'launch_addresses_missing');
    let verified: VerifiedLaunchCoinTransaction;
    try {
      verified = verifyLaunchCoinTransaction(tx, {
        owner: wallet,
        firstBuyLamports: solToLamports(spec.launchpadCoin.firstBuySol),
        config: launchpadCoinConfig,
        mint: launchpadCoinMint,
        name: spec.launchpadCoin.name,
        symbol: spec.launchpadCoin.symbol,
      });
    } catch (error) {
      unavailable(
        owned,
        error instanceof LaunchTransactionCheckError
          ? `launch_check_${error.code.toLowerCase()}`
          : errorName(error),
      );
    }
    // What the browser pins in turn. The creator wallet and the nonce account are not stored
    // outside the signer: they are the ones the check above found consistent in the transaction.
    const launch = OwnerTransactionLaunch.safeParse({
      config: launchpadCoinConfig,
      mint: launchpadCoinMint,
      creator: verified.creator.toBase58(),
      nonceAccount: verified.nonceAccount.toBase58(),
      metadataUri: verified.metadataUri,
    });
    if (!launch.success) unavailable(owned, 'launch_details_invalid');
    return { tx, launch: launch.data };
  }

  /**
   * Rent of the owner's temporary WSOL account: held only with a first buy (the account is
   * created and closed by the launch). Null when the cluster cannot be read: the summary then
   * omits the required balance rather than understating it.
   */
  async function temporaryWsolRent(
    jobId: string,
    firstBuyLamports: bigint,
  ): Promise<bigint | null> {
    if (firstBuyLamports === 0n) return 0n;
    try {
      return await chain.getTokenAccountRentLamports();
    } catch (error) {
      if (!(error instanceof RpcUnavailableError)) throw error;
      logger.log('warn', 'owner_tx.rent_unavailable', { jobId });
      return null;
    }
  }

  async function get(input: { wallet: string; jobId: string }): Promise<OwnerTransactionView> {
    const owned = await requireOwnedJob(store, input.jobId, input.wallet);
    const spec = assertLaunchJob(owned, input.wallet);
    const { job, launchpad } = owned;
    if (SIGNED_OR_LATER.has(job.status)) {
      throw new RouteError(409, 'ALREADY_SIGNED', 'This launch has already been signed.', {
        status: job.status,
      });
    }
    if (job.status !== 'awaiting_owner_signature') {
      throw new RouteError(409, 'INVALID_STATUS', 'The launch transaction is not ready yet.', {
        status: job.status,
      });
    }
    if (launchpad.status === 'disabled') {
      throw new RouteError(403, 'LAUNCHPAD_DISABLED', 'This launchpad has been disabled.');
    }
    const { tx, launch } = storedTransaction(owned, input.wallet, spec);
    const owner = requiredSigners(tx)[0]!;
    const firstBuyLamports = solToLamports(spec.launchpadCoin.firstBuySol);
    const [estimate, temporaryLamports] = await Promise.all([
      chain.estimateOwnerCosts(tx, owner),
      temporaryWsolRent(job.id, firstBuyLamports),
    ]);
    // Everything the owner pays besides the first buy (network fee, rents, Metaplex fee, pool
    // creation fee), as `toOwnerTransactionSummary` of @forge/core defines it. Upper bound: the
    // network fee is added even though the simulated balance may already include it.
    let others = estimate.networkFeeLamports;
    let simulation: OwnerTransactionView['simulation'] = 'unavailable';
    if (estimate.simulationFailed) simulation = 'failed';
    else if (
      estimate.ownerDebitLamports !== null &&
      estimate.ownerDebitLamports >= firstBuyLamports
    ) {
      others = estimate.ownerDebitLamports - firstBuyLamports + estimate.networkFeeLamports;
      simulation = 'ok';
    }
    if (simulation !== 'ok') {
      logger.log('warn', 'owner_tx.simulation', { jobId: job.id, simulation });
    }
    // What the wallet must hold to sign, as `toOwnerTransactionSummary` of @forge/core defines it:
    // first buy + everything else the owner pays + the temporary WSOL account rent (refunded
    // within the transaction, but held while it runs).
    const required =
      temporaryLamports === null ? null : firstBuyLamports + others + temporaryLamports;
    return {
      transaction: job.ownerTx!,
      summary: {
        coinName: spec.launchpadCoin.name,
        coinSymbol: spec.launchpadCoin.symbol,
        firstBuyLamports: firstBuyLamports.toString(),
        estimatedNetworkFeeLamports: others.toString(),
        ownerWallet: input.wallet,
        ...(required === null ? {} : { ownerRequiredBalanceLamports: required.toString() }),
      },
      simulation,
      launch,
    };
  }

  async function markSigned(owned: OwnedJob, signature: string): Promise<void> {
    const { job, launchpad } = owned;
    if (
      await store.transitionJob(job.id, launchpad.id, 'awaiting_owner_signature', 'owner_signed')
    ) {
      logger.log('info', 'job.owner_signed', { jobId: job.id, signature });
      await addJobEventSafe(store, logger, job.id, 'Launch transaction confirmed on-chain.');
      return;
    }
    const fresh = await store.getOwnedJob(job.id, launchpad.ownerWallet);
    if (fresh && SIGNED_OR_LATER.has(fresh.job.status)) return;
    // Confirmed on-chain but the job moved elsewhere (e.g. put back by the team): flag it.
    logger.log('error', 'job.owner_signed_not_applied', {
      jobId: job.id,
      signature,
      status: fresh?.job.status ?? null,
    });
    throw new RouteError(
      409,
      'INVALID_STATUS',
      'The launch was confirmed but this job changed state. Our team has been notified.',
      { signature },
    );
  }

  async function failedOnChain(owned: OwnedJob, signature: string): Promise<never> {
    // With a durable nonce, a failed transaction still advanced the nonce: the stored
    // transaction can no longer land and must be prepared again (manual handling, D18).
    logger.log('error', 'owner_tx.failed_onchain', { jobId: owned.job.id, signature });
    await addJobEventSafe(
      store,
      logger,
      owned.job.id,
      'The launch transaction failed on-chain. Our team has been notified.',
    );
    throw new RouteError(422, 'TRANSACTION_FAILED', 'The launch transaction failed on-chain.', {
      signature,
    });
  }

  async function submit(input: {
    wallet: string;
    jobId: string;
    signedTransaction: string;
  }): Promise<{ signature: string }> {
    const owned = await requireOwnedJob(store, input.jobId, input.wallet);
    const spec = assertLaunchJob(owned, input.wallet);
    const { job, launchpad } = owned;
    if (!SIGNED_OR_LATER.has(job.status) && job.status !== 'awaiting_owner_signature') {
      throw new RouteError(409, 'INVALID_STATUS', 'The launch transaction is not ready yet.', {
        status: job.status,
      });
    }
    const { tx: stored } = storedTransaction(owned, input.wallet, spec);

    // The only transaction ever accepted: the stored one, byte for byte, fully signed.
    let signed: Transaction;
    try {
      signed = assertSignedCopyOf(stored, input.signedTransaction);
    } catch (error) {
      const code = error instanceof TransactionEncodingError ? error.code : errorName(error);
      if (code === 'MESSAGE_MISMATCH') {
        logger.log('warn', 'owner_tx.substitution_rejected', { jobId: job.id });
        throw new RouteError(
          422,
          'TRANSACTION_MISMATCH',
          'This is not the launch transaction prepared for this job.',
        );
      }
      logger.log('warn', 'owner_tx.signed_invalid', { jobId: job.id, code });
      throw new RouteError(
        400,
        'TRANSACTION_INVALID',
        code === 'MISSING_SIGNATURE'
          ? 'The launch transaction is missing your signature.'
          : 'The signed launch transaction is invalid.',
      );
    }
    const signature = transactionSignature(signed);
    if (!signature) throw new RouteError(400, 'TRANSACTION_INVALID', 'The signature is missing.');

    // Retry after success: same transaction, nothing to send.
    if (SIGNED_OR_LATER.has(job.status)) return { signature };

    if (launchpad.status === 'disabled') {
      throw new RouteError(403, 'LAUNCHPAD_DISABLED', 'This launchpad has been disabled.');
    }

    await chain.assertCluster();
    const state = await chain.getSignatureState(signature);
    if (state === 'failed') return failedOnChain(owned, signature);
    if (state !== 'confirmed') {
      if (state === 'unknown') {
        const sent = await chain.send(signed);
        if (sent.status === 'expired') {
          logger.log('error', 'owner_tx.expired', { jobId: job.id, signature });
          throw new RouteError(
            422,
            'TRANSACTION_EXPIRED',
            'This launch transaction is no longer valid. Our team has been notified.',
          );
        }
        if (sent.status === 'rejected') {
          logger.log('warn', 'owner_tx.rejected', { jobId: job.id, reason: sent.reason });
          throw new RouteError(
            422,
            'TRANSACTION_REJECTED',
            sent.reason === 'insufficient_funds'
              ? 'Your wallet does not hold enough SOL for this launch.'
              : 'The network rejected the launch transaction. Please try again.',
            { reason: sent.reason },
          );
        }
        logger.log('info', 'owner_tx.sent', { jobId: job.id, signature });
      }
      const outcome = await chain.confirm(signature, confirmDeadlineMs);
      if (outcome === 'failed') return failedOnChain(owned, signature);
      if (outcome === 'timeout') {
        logger.log('warn', 'owner_tx.confirmation_pending', { jobId: job.id, signature });
        throw new RouteError(
          503,
          'CONFIRMATION_PENDING',
          'The launch transaction was sent but is not confirmed yet. Retry in a moment.',
          { signature },
          { 'Retry-After': '5' },
        );
      }
    }
    await markSigned(owned, signature);
    return { signature };
  }

  return { get, submit };
}
