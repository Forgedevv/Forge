import {
  CLUSTER_GENESIS_HASH,
  ConfirmationTimeoutError,
  TransactionFailedError,
  confirmSignature,
  retryRpc,
  type RetryOptions,
} from '@forge/core';
import {
  SendTransactionError,
  VersionedTransaction,
  type Connection,
  type PublicKey,
  type Transaction,
} from '@solana/web3.js';
import type { Cluster } from './config';

/*
 * The owner-transaction routes' view of the chain (Helius through the server RPC_URL). Nothing
 * here signs: it only simulates, sends a transaction the owner already signed, and polls its
 * status (`confirmSignature` of @forge/core, polling `getSignatureStatuses` with a deadline;
 * no websocket subscription).
 *
 * RPC error messages may echo the endpoint (and its API key): they never leave this module.
 * Network failures become `RpcUnavailableError`; a cluster other than SOLANA_CLUSTER becomes
 * `ClusterMismatchError`, checked before anything is sent.
 */

export class RpcUnavailableError extends Error {
  constructor() {
    super('RPC request failed after retries');
    this.name = 'RpcUnavailableError';
  }
}

export class ClusterMismatchError extends Error {
  constructor() {
    super('RPC_URL does not serve the cluster named by SOLANA_CLUSTER');
    this.name = 'ClusterMismatchError';
  }
}

export interface OwnerCostEstimate {
  /** Network fee of the message (cluster `getFeeForMessage`, else signatures x 5000). */
  networkFeeLamports: bigint;
  /**
   * How much the owner's balance decreases when the transaction executes, from a simulation of
   * the exact message (null when the simulation failed or returned no account).
   */
  ownerDebitLamports: bigint | null;
  /** True when the simulation reported an error (e.g. the owner cannot pay). */
  simulationFailed: boolean;
}

export type SignatureState = 'unknown' | 'pending' | 'confirmed' | 'failed';

export type SendOutcome =
  | { status: 'sent' }
  /** The cluster refused it in preflight; nothing landed. */
  | { status: 'rejected'; reason: 'insufficient_funds' | 'simulation_failed' }
  /** The durable nonce (or blockhash) is no longer valid: it can never land. */
  | { status: 'expired' };

export type ConfirmOutcome = 'confirmed' | 'failed' | 'timeout';

/** Size of an SPL Token account (the owner's temporary WSOL account), in bytes. */
export const TOKEN_ACCOUNT_SIZE = 165;

export interface LaunchChain {
  /** @throws ClusterMismatchError, RpcUnavailableError */
  assertCluster(): Promise<void>;
  estimateOwnerCosts(transaction: Transaction, owner: PublicKey): Promise<OwnerCostEstimate>;
  /**
   * Rent-exempt minimum of an SPL Token account, read from the cluster
   * (`getMinimumBalanceForRentExemption(165)`, never hardcoded): what the owner holds for the
   * temporary WSOL account of the first buy while the launch runs.
   * @throws RpcUnavailableError
   */
  getTokenAccountRentLamports(): Promise<bigint>;
  getSignatureState(signature: string): Promise<SignatureState>;
  send(transaction: Transaction): Promise<SendOutcome>;
  confirm(signature: string, deadlineMs: number): Promise<ConfirmOutcome>;
}

const LAMPORTS_PER_SIGNATURE = 5000n;

/** Wraps an RPC call: transient errors are retried, any failure loses its message. */
async function rpc<T>(fn: () => Promise<T>, retry: RetryOptions | undefined): Promise<T> {
  try {
    return await retryRpc(fn, retry);
  } catch {
    throw new RpcUnavailableError();
  }
}

/** Preflight error classification, from the RPC message (never forwarded). */
export function classifySendError(error: SendTransactionError): SendOutcome | 'already_processed' {
  const text = `${error.message} ${(error.logs ?? []).join(' ')}`;
  if (/already been processed|AlreadyProcessed/i.test(text)) return 'already_processed';
  if (/blockhash not found|BlockhashNotFound|nonce/i.test(text)) return { status: 'expired' };
  if (/insufficient (funds|lamports)|no record of a prior credit|InsufficientFunds/i.test(text)) {
    return { status: 'rejected', reason: 'insufficient_funds' };
  }
  return { status: 'rejected', reason: 'simulation_failed' };
}

export interface ConnectionLaunchChainOptions {
  connection: Connection;
  cluster: Cluster;
  retry?: RetryOptions;
  /** Poll interval of the confirmation (default 1500 ms). */
  pollIntervalMs?: number;
}

export function createConnectionLaunchChain(options: ConnectionLaunchChainOptions): LaunchChain {
  const { connection, cluster, retry } = options;
  let genesisChecked = false;

  return {
    async assertCluster() {
      if (genesisChecked) return;
      const genesis = await rpc(() => connection.getGenesisHash(), retry);
      if (genesis !== CLUSTER_GENESIS_HASH[cluster]) throw new ClusterMismatchError();
      genesisChecked = true;
    },

    async estimateOwnerCosts(transaction, owner) {
      const wire = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      const versioned = VersionedTransaction.deserialize(wire);
      const fee = await rpc(
        () => connection.getFeeForMessage(versioned.message, 'confirmed'),
        retry,
      );
      const signatures = BigInt(versioned.message.header.numRequiredSignatures);
      const networkFeeLamports =
        fee.value !== null && fee.value !== undefined
          ? BigInt(fee.value)
          : signatures * LAMPORTS_PER_SIGNATURE;
      const before = await rpc(() => connection.getBalance(owner, 'confirmed'), retry);
      const simulation = await rpc(
        () =>
          connection.simulateTransaction(versioned, {
            sigVerify: false,
            // A durable nonce transaction must be simulated with its own nonce value.
            replaceRecentBlockhash: false,
            commitment: 'confirmed',
            accounts: { encoding: 'base64', addresses: [owner.toBase58()] },
          }),
        retry,
      );
      if (simulation.value.err) {
        return { networkFeeLamports, ownerDebitLamports: null, simulationFailed: true };
      }
      const after = simulation.value.accounts?.[0]?.lamports;
      if (typeof after !== 'number') {
        return { networkFeeLamports, ownerDebitLamports: null, simulationFailed: false };
      }
      return {
        networkFeeLamports,
        ownerDebitLamports: BigInt(before) - BigInt(after),
        simulationFailed: false,
      };
    },

    async getTokenAccountRentLamports() {
      const rent = await rpc(
        () => connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE, 'confirmed'),
        retry,
      );
      return BigInt(rent);
    },

    async getSignatureState(signature) {
      const res = await rpc(
        () => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
        retry,
      );
      const status = res.value[0];
      if (!status) return 'unknown';
      const final =
        status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
      if (!final) return 'pending';
      return status.err ? 'failed' : 'confirmed';
    },

    async send(transaction) {
      const wire = transaction.serialize({ requireAllSignatures: true, verifySignatures: true });
      try {
        await retryRpc(
          () =>
            connection.sendRawTransaction(wire, {
              skipPreflight: false,
              preflightCommitment: 'confirmed',
              maxRetries: 5,
            }),
          retry,
        );
        return { status: 'sent' };
      } catch (error) {
        if (error instanceof SendTransactionError) {
          const outcome = classifySendError(error);
          return outcome === 'already_processed' ? { status: 'sent' } : outcome;
        }
        // Network failure: the transaction may or may not have reached the cluster. Callers
        // check its status on the next attempt (the durable nonce keeps it valid meanwhile).
        throw new RpcUnavailableError();
      }
    },

    async confirm(signature, deadlineMs) {
      try {
        await confirmSignature(connection, signature, {
          deadlineMs,
          pollIntervalMs: options.pollIntervalMs ?? 1500,
          commitment: 'confirmed',
        });
        return 'confirmed';
      } catch (error) {
        if (error instanceof TransactionFailedError) return 'failed';
        if (error instanceof ConfirmationTimeoutError) return 'timeout';
        throw new RpcUnavailableError();
      }
    },
  };
}
