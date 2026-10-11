import type { Connection, PublicKey } from '@solana/web3.js';
import {
  assertCluster,
  buildPaymentTx,
  ForgeAddressError,
  PaymentError as CorePaymentError,
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

export interface BuiltPayment {
  /** Unsigned transaction, base64 wire format (docs/INTERFACES.md §6 encodings). */
  transaction: string;
  lastValidBlockHeight: number;
}

export interface PaymentGateway {
  buildPayment(params: PaymentParams): Promise<BuiltPayment>;
  verify(signature: string, expected: ExpectedPayment): Promise<PaymentVerification>;
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
        return await verifyPayment(connection, signature, expected, { ...common, cluster });
      } catch (error) {
        throw translateCoreError(error);
      }
    },
  };
}
