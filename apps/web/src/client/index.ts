import type { WebClient } from '@forge/shared';
import {
  approvePreview,
  claimPartnerFees,
  confirmSpec,
  getOwnerTransactionSummary,
  getQuote,
  payQuote,
  reactivateLaunchpad,
  requestModification,
  signOwnerTransaction,
} from './actions';
import { explorerTxUrl, formatSol, formatUsd, shortAddress } from './format';
import {
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
  getQuote,
  payQuote,
  reactivateLaunchpad,
  requestModification,
  shortAddress,
  signOwnerTransaction,
  useChat,
  useFlags,
  useGating,
  useJob,
  useLaunchpad,
  useLaunchpads,
  useSession,
};

/** The real implementation of the whole client, as one object (swappable with the UI mocks). */
export const realClient: WebClient = {
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
  formatSol,
  formatUsd,
  shortAddress,
  explorerTxUrl,
};

/**
 * Dev-only flag: when true, the UI should use its own mocks (src/ui/mocks) instead of
 * `realClient`. This module never imports the mocks: the swap is done by the UI layer.
 */
export const USE_MOCKS: boolean = process.env.NEXT_PUBLIC_USE_MOCKS === '1';
