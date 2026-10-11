/**
 * Errors of the signing routes. A `RouteError` carries the HTTP status and a short snake_case
 * code (the only thing the builder sees, see server.ts); everything else is mapped by
 * `classifyError` to a fixed status/code pair. Messages never contain key material: the routes
 * only ever hold public keys, signatures and serialized (partially) signed transactions.
 */
import {
  CreateConfigError,
  DurableNonceError,
  ForgeAddressError,
  LaunchCoinError,
  PaymentError,
  RentExemptionError,
  TransactionEncodingError,
  ValidationError,
} from '@forge/core';
import { isKeystoreError } from '../keystore.js';
import { isJobError, isTransientError } from '../jobs/shared.js';

export class RouteError extends Error {
  override readonly name = 'RouteError';
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;

  constructor(status: number, code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function fail(status: number, code: string, detail?: string): never {
  throw new RouteError(status, code, detail);
}

export interface ClassifiedError {
  status: number;
  code: string;
  /** Worth an operator alert (anything that is not a plain refusal of a bad request). */
  alert: boolean;
}

const LAUNCH_CODES: Record<string, ClassifiedError> = {
  INVALID_INPUT: { status: 422, code: 'launch_input_invalid', alert: true },
  CONFIG_NOT_FOUND: { status: 409, code: 'coin_config_not_found', alert: true },
  CONFIG_MISMATCH: { status: 409, code: 'coin_config_mismatch', alert: true },
  POOL_EXISTS: { status: 409, code: 'pool_exists', alert: true },
  MINT_EXISTS: { status: 409, code: 'mint_exists', alert: true },
  REFERRAL_INVALID: { status: 503, code: 'referral_invalid', alert: true },
  RENT_PAYER_REFUSED: { status: 409, code: 'rent_payer_refused', alert: true },
  FIRST_BUY_EXCEEDS_CURVE: { status: 422, code: 'first_buy_exceeds_curve', alert: false },
  QUOTE_FAILED: { status: 502, code: 'first_buy_quote_failed', alert: true },
  UNEXPECTED_SIGNERS: { status: 500, code: 'launch_tx_signers', alert: true },
  TX_TOO_LARGE: { status: 422, code: 'launch_tx_too_large', alert: true },
};

/** Maps any error thrown inside a route to a status and a code. */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof RouteError) {
    return { status: err.status, code: err.code, alert: err.status >= 500 };
  }
  if (err instanceof ValidationError) return { status: 422, code: 'invalid_spec', alert: false };
  if (err instanceof LaunchCoinError) {
    return LAUNCH_CODES[err.code] ?? { status: 500, code: 'launch_build_failed', alert: true };
  }
  if (err instanceof CreateConfigError) {
    return err.code === 'CONFIG_EXISTS'
      ? { status: 409, code: 'config_address_taken', alert: true }
      : { status: 500, code: 'config_build_failed', alert: true };
  }
  if (err instanceof DurableNonceError) return { status: 409, code: 'nonce_invalid', alert: true };
  if (err instanceof RentExemptionError) {
    return { status: 503, code: 'account_not_rent_exempt', alert: true };
  }
  if (err instanceof TransactionEncodingError) {
    return { status: 500, code: 'tx_encoding_failed', alert: true };
  }
  if (err instanceof ForgeAddressError) return { status: 500, code: 'address_config', alert: true };
  if (err instanceof PaymentError) {
    // Input refused by core (job id, amount): the payment cannot be the one of this job.
    return err.code === 'invalid_job_id' || err.code === 'invalid_amount'
      ? { status: 409, code: 'payment_not_verified', alert: true }
      : { status: 500, code: 'payment_verifier_error', alert: true };
  }
  if (isKeystoreError(err)) return { status: 500, code: 'keystore_error', alert: true };
  if (isJobError(err)) {
    switch (err.code) {
      case 'TX_POLICY':
        return { status: 500, code: 'tx_policy_violation', alert: true };
      case 'SIGNER_MISMATCH':
      case 'NOT_SIGNED':
        return { status: 500, code: 'signing_failed', alert: true };
      case 'JOURNAL_CORRUPT':
      case 'JOURNAL_IO':
        return { status: 500, code: 'journal_error', alert: true };
      case 'DB':
      case 'DB_RESPONSE':
        return { status: 503, code: 'db_unavailable', alert: true };
      case 'CONFIG':
        return { status: 500, code: 'signer_config', alert: true };
      default:
        break;
    }
  }
  if (isTransientError(err)) return { status: 503, code: 'rpc_unavailable', alert: true };
  return { status: 500, code: 'internal_error', alert: true };
}
