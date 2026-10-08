import type { PaymentStatus } from '@forge/shared';

/*
 * Errors of the payment routes. Every PaymentError maps to one HTTP response whose body follows
 * the ClientError shape `{ code, message }`; `message` is safe to show to the end user and never
 * contains an address, an amount from the environment, a URL or a secret.
 */

export type PaymentErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'WRONG_WALLET'
  | 'NOT_FOUND'
  | 'KIND_MISMATCH'
  | 'JOB_NOT_PAYABLE'
  | 'ALREADY_PAID'
  | 'LAUNCHPAD_DISABLED'
  | 'SIGNUPS_PAUSED'
  | 'RATE_LIMITED'
  | 'QUOTE_EXPIRED'
  | 'SIGNATURE_ALREADY_USED'
  | 'PAYMENT_ALREADY_CONFIRMED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_INVALID'
  | 'PAYMENT_AMOUNT_MISMATCH'
  | 'PRICE_UNAVAILABLE'
  | 'RPC_UNAVAILABLE'
  | 'WRONG_CLUSTER'
  | 'SERVER_ERROR';

export class PaymentError extends Error {
  readonly httpStatus: number;
  readonly code: PaymentErrorCode;
  /** Payment status to include in the body (e.g. `expired`), when meaningful. */
  readonly paymentStatus: PaymentStatus | undefined;

  constructor(
    httpStatus: number,
    code: PaymentErrorCode,
    message: string,
    paymentStatus?: PaymentStatus,
  ) {
    super(message);
    this.name = 'PaymentError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.paymentStatus = paymentStatus;
  }
}

/** Configuration problem. The message names variables only, never their values. */
export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigError';
  }
}

/** The RPC endpoint is unreachable or kept failing after retries. */
export class RpcUnavailableError extends Error {
  constructor(message = 'RPC request failed after retries') {
    super(message);
    this.name = 'RpcUnavailableError';
  }
}

/** The RPC endpoint serves another cluster than SOLANA_CLUSTER (genesis hash mismatch). */
export class ClusterMismatchError extends Error {
  constructor(message = 'RPC_URL does not serve the cluster named by SOLANA_CLUSTER') {
    super(message);
    this.name = 'ClusterMismatchError';
  }
}

/** The SOL/USD price could not be obtained or failed the sanity bounds. */
export class PriceUnavailableError extends Error {
  constructor(message = 'SOL/USD price unavailable') {
    super(message);
    this.name = 'PriceUnavailableError';
  }
}

/** Database error with its Postgres/PostgREST code (never the message, which may echo values). */
export class StoreError extends Error {
  readonly dbCode: string | undefined;

  constructor(operation: string, dbCode?: string) {
    super(`database operation failed: ${operation}${dbCode ? ` (${dbCode})` : ''}`);
    this.name = 'StoreError';
    this.dbCode = dbCode;
  }
}
