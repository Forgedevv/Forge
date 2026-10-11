import type { BetaAccess, ForgeClientExtensions, ForgeClientInput, ForgeWebClient } from './types';

/*
 * Fills the extension methods a client does not implement with neutral defaults. The result
 * delegates to `client` through its prototype, so methods replaced on `client` later (test spies)
 * are still the ones called. No wallet or network dependency: safe for the UI mocks.
 */

const NO_BETA_NOTICE: BetaAccess = { notInvited: false, dismiss() {} };

const DEFAULTS: ForgeClientExtensions = {
  useBetaAccess: () => NO_BETA_NOTICE,
  getPendingPayment: () => null,
  resumePayment: async () => ({ phase: 'idle' }),
};

export function withClientExtensions(client: ForgeClientInput): ForgeWebClient {
  const extended = Object.create(client) as ForgeWebClient;
  for (const key of Object.keys(DEFAULTS) as (keyof ForgeClientExtensions)[]) {
    if (typeof client[key] !== 'function') {
      Object.defineProperty(extended, key, { value: DEFAULTS[key], enumerable: true });
    }
  }
  return extended;
}
