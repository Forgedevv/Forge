import type {
  Connection,
  Finality,
  PublicKey,
  VersionedTransactionResponse,
} from '@solana/web3.js';
import {
  assertCluster,
  buildPaymentTx,
  encodeBase58,
  ForgeAddressError,
  PaymentError as CorePaymentError,
  retryRpc,
  verifyPayment,
  type AddressEnv,
  type ExpectedPayment,
  type PaymentCluster,
  type PaymentParams,
  type PaymentVerification,
  type RetryOptions,
} from './core-adapter';
import { ClusterMismatchError, PaymentConfigError, RpcUnavailableError } from './errors';

/*
 * The payment routes' view of the chain: the core functions bound to one connection, cluster and
 * cashbox, with errors translated so that no RPC error message (which may echo the endpoint and
 * its API key) ever travels further.
 *
 * The cashbox is the address parsed once by the route configuration (config.ts). The core reads
 * addresses from an environment object, so the gateway hands it an environment holding exactly
 * that parsed address: building and verifying can never use two different cashboxes.
 */

/**
 * A payment moves the job to `paid` (and starts paid work) only once its transaction is
 * finalized: a `confirmed` block can still be dropped by a fork. Until then the confirm route
 * answers 202 and the client asks again with the same signature.
 */
export const PAYMENT_COMMITMENT: Finality = 'finalized';

export interface BuiltPayment {
  /** Unsigned transaction, base64 wire format (docs/INTERFACES.md §6 encodings). */
  transaction: string;
  lastValidBlockHeight: number;
}

export interface PaymentGateway {
  buildPayment(params: PaymentParams): Promise<BuiltPayment>;
  verify(signature: string, expected: ExpectedPayment): Promise<PaymentVerification>;
  /**
   * Lamports the cashbox balance grew by in the transaction `signature` (post - pre balance, at
   * PAYMENT_COMMITMENT; 0n when it did not grow), or null when the transaction is not served. Read
   * for a confirmation that is rejected, so that money that reached the cashbox anyway is recorded.
   */
  cashboxReceived(signature: string): Promise<bigint | null>;
}

/**
 * Pure: what the cashbox balance grew by in `tx` (0n when it did not grow), or null when the
 * transaction served is not the one of `signature` (its first signature) or has no status meta.
 */
export function cashboxBalanceGrowth(
  tx: VersionedTransactionResponse,
  signature: string,
  cashbox: PublicKey,
): bigint | null {
  const first: unknown = tx.transaction?.signatures?.[0];
  const served = first instanceof Uint8Array ? encodeBase58(first) : first;
  if (served !== signature) return null;
  const meta = tx.meta;
  if (!meta) return null;
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: meta.loadedAddresses ?? undefined,
  });
  for (let i = 0; i < keys.length; i++) {
    if (!keys.get(i)?.equals(cashbox)) continue;
    const pre = meta.preBalances[i];
    const post = meta.postBalances[i];
    if (pre === undefined || post === undefined) return null;
    const growth = BigInt(post) - BigInt(pre);
    return growth > 0n ? growth : 0n;
  }
  return 0n;
}

export interface CorePaymentGatewayOptions {
  connection: Connection;
  cluster: PaymentCluster;
  /** The parsed FORGE_CASHBOX_WALLET of the route configuration. */
  cashbox: PublicKey;
  retry?: RetryOptions;
}

/** Maps core and RPC errors to the route errors (messages of RPC errors are dropped). */
export function translateCoreError(error: unknown): Error {
  if (error instanceof CorePaymentError) {
    if (error.code === 'wrong_cluster') return new ClusterMismatchError();
    if (error.code === 'cashbox_not_rent_exempt') {
      return new PaymentConfigError('FORGE_CASHBOX_WALLET is not rent-exempt');
    }
    return error;
  }
  if (error instanceof ForgeAddressError) {
    // Lists variable names only.
    return new PaymentConfigError(error.message);
  }
  if (error instanceof TypeError || error instanceof RangeError) return error;
  return new RpcUnavailableError();
}

export function createCorePaymentGateway(options: CorePaymentGatewayOptions): PaymentGateway {
  const { connection, cluster } = options;
  const env: AddressEnv = {
    FORGE_CASHBOX_WALLET: options.cashbox.toBase58(),
    SOLANA_CLUSTER: cluster,
  };
  const common = { env, ...(options.retry ? { retry: options.retry } : {}) };
  return {
    async buildPayment(params) {
      try {
        // buildPaymentTx does not check the cluster: never hand out a transaction for another one.
        await assertCluster(connection, cluster, options.retry);
        const built = await buildPaymentTx(connection, params, common);
        const wire = built.transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        });
        return {
          transaction: Buffer.from(wire).toString('base64'),
          lastValidBlockHeight: built.lastValidBlockHeight,
        };
      } catch (error) {
        throw translateCoreError(error);
      }
    },

    async verify(signature, expected) {
      try {
        return await verifyPayment(connection, signature, expected, {
          ...common,
          cluster,
          commitment: PAYMENT_COMMITMENT,
        });
      } catch (error) {
        throw translateCoreError(error);
      }
    },

    async cashboxReceived(signature) {
      try {
        await assertCluster(connection, cluster, options.retry);
        const tx = await retryRpc(
          () =>
            connection.getTransaction(signature, {
              commitment: PAYMENT_COMMITMENT,
              maxSupportedTransactionVersion: 0,
            }),
          options.retry,
        );
        return tx ? cashboxBalanceGrowth(tx, signature, options.cashbox) : null;
      } catch (error) {
        throw translateCoreError(error);
      }
    },
  };
}
