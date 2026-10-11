/*
 * The payment API of @forge/core (packages/core/src/payments.ts) as used by the payment routes.
 * Nothing is reimplemented here: the routes build and verify payments with the core functions,
 * and the cashbox address is resolved by `requireAddresses` of the core (see config.ts).
 */

export {
  assertCluster,
  buildPaymentInstructions,
  buildPaymentTx,
  checkPaymentTransaction,
  CLUSTER_GENESIS_HASH,
  ForgeAddressError,
  MAX_PAYMENT_LAMPORTS,
  MEMO_PROGRAM_ID,
  MEMO_V1_PROGRAM_ID,
  PAYMENT_MEMO_PREFIX,
  PaymentError,
  paymentMemo,
  requireAddresses,
  verifyPayment,
} from '@forge/core';
export type {
  AddressEnv,
  ExpectedPayment,
  PaymentCheck,
  PaymentCluster,
  PaymentErrorCode,
  PaymentParams,
  PaymentRejectReason,
  PaymentTxOptions,
  PaymentTxResult,
  PaymentVerification,
  RetryOptions,
  VerifyPaymentOptions,
} from '@forge/core';
