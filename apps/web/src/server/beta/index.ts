export {
  checkBetaAccess,
  currentBetaPolicy,
  isWalletAddress,
  MAX_BETA_WALLETS,
  parseBetaPolicy,
} from './config';
export type { BetaAccess, BetaEnv, BetaPolicy } from './config';

/** Error code of a wallet refused by the private beta (HTTP 403). */
export const BETA_NOT_INVITED = 'BETA_NOT_INVITED';

/** Shown to the user as is. */
export const BETA_NOT_INVITED_MESSAGE =
  'FORGE is in private beta and this wallet is not on the invite list yet. ' +
  'Connect an invited wallet, or ask the FORGE team for an invite.';

export const BETA_UNAVAILABLE_MESSAGE = 'Sign-in is temporarily unavailable. Try again later.';
