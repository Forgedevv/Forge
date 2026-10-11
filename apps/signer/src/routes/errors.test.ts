import { describe, expect, it } from 'vitest';
import { LaunchCoinError, PaymentError, type LaunchCoinErrorCode } from '@forge/core';
import { RouteError, classifyError } from './errors.js';

describe('route error classification', () => {
  it('maps a refused first-buy referral to an alerted 500 (the routes never pass one)', () => {
    // REFERRAL_UNSUPPORTED is the code of the core branch that refuses any first-buy referral.
    const err = new LaunchCoinError('REFERRAL_UNSUPPORTED' as LaunchCoinErrorCode, 'no referral');
    expect(classifyError(err)).toEqual({
      status: 500,
      code: 'referral_unsupported',
      alert: true,
    });
    const removed = new LaunchCoinError('REFERRAL_INVALID' as LaunchCoinErrorCode, 'old code');
    expect(classifyError(removed).code).toBe('launch_build_failed');
  });

  it('maps core payment errors: bad input is a refusal, configuration a 500', () => {
    expect(classifyError(new PaymentError('invalid_job_id', 'x'))).toEqual({
      status: 409,
      code: 'payment_not_verified',
      alert: true,
    });
    expect(classifyError(new PaymentError('wrong_cluster', 'x'))).toEqual({
      status: 500,
      code: 'payment_verifier_error',
      alert: true,
    });
  });

  it('keeps the status and code of a RouteError, alerting 5xx only', () => {
    expect(classifyError(new RouteError(409, 'payment_refunded'))).toEqual({
      status: 409,
      code: 'payment_refunded',
      alert: false,
    });
    expect(classifyError(new RouteError(503, 'account_not_final')).alert).toBe(true);
  });
});
