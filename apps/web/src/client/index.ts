import type { WebClient } from '@forge/shared';
import {
  approvePreview,
  claimPartnerFees,
  confirmSpec,
  getOwnerTransactionSummary,
  getPendingPayment,
  getQuote,
  payQuote,
  reactivateLaunchpad,
  requestModification,
  resumePayment,
  retryLaunchpad,
  signOwnerTransaction,
} from './actions';
import type { ForgeWebClient } from './types';
import { explorerTxUrl, formatSol, formatUsd, shortAddress } from './format';
import {
  useBetaAccess,
  useChat,
  useFlags,
  useGating,
  useJob,
  useLaunchpad,
  useLaunchpads,
  useSession,
} from './hooks';

export { ForgeClientProvider } from './provider';
export {
  approvePreview,
  claimPartnerFees,
  confirmSpec,
  explorerTxUrl,
  formatSol,
  formatUsd,
  getOwnerTransactionSummary,
  getPendingPayment,
  getQuote,
  payQuote,
  reactivateLaunchpad,
  requestModification,
  resumePayment,
  retryLaunchpad,
  shortAddress,
  signOwnerTransaction,
  useBetaAccess,
  useChat,
  useFlags,
  useGating,
  useJob,
  useLaunchpad,
  useLaunchpads,
  useSession,
};

/** The real implementation of the whole client, as one object (swappable with the UI mocks). */
export const realClient: ForgeWebClient = {
  useSession,
  useFlags,
  useGating,
  useChat,
  confirmSpec,
  requestModification,
  getQuote,
  payQuote,
  useJob,
  approvePreview,
  getOwnerTransactionSummary,
  signOwnerTransaction,
  useLaunchpads,
  useLaunchpad,
  claimPartnerFees,
  reactivateLaunchpad,
  retryLaunchpad,
  formatSol,
  formatUsd,
  shortAddress,
  explorerTxUrl,
  getPendingPayment,
  resumePayment,
  useBetaAccess,
};

/** The extended client still implements the shared contract. */
export const sharedContractClient: WebClient = realClient;

/**
 * Dev-only flag: when true, the UI should use its own mocks (src/ui/mocks) instead of
 * `realClient`. This module never imports the mocks: the swap is done by the UI layer.
 */
export const USE_MOCKS: boolean = process.env.NEXT_PUBLIC_USE_MOCKS === '1';
