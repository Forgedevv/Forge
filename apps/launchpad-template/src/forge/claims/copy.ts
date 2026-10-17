/**
 * LOCKED ZONE. Every visible text of the creator fee claims (`ClaimCreatorFees`) and of the
 * creator fee page (`pages/CreatorFeesPage`), in one place so the wording stays consistent and
 * other languages can be added later. Like the other locked-zone copy (`create/copy.ts`,
 * `trade/copy.ts`), it lives next to the code that renders it and imports nothing from the free
 * zones, so a site redesign can never break the flow.
 *
 * Plain strings, or small functions for the texts that carry a value. The error sentences of a
 * failed transaction come from `create/errors.ts` and `create/flow.ts` (shared with coin creation).
 */

export const CREATOR_FEES_TEXT = {
  title: 'Creator fees',
  intro: 'Created a coin on this launchpad? Claim the creator fees it earned for you.',
  backHome: 'Back to the launchpad',
} as const;

/** One claimed or claimable amount: `1.5 SOL`, `1000 MOON`. */
type Amount = string;

export const CLAIM_TEXT = {
  connectIntro: 'Connect your wallet to see the coins you created.',
  connect: 'Connect wallet',
  notConfigured: 'Fee claims are not configured on this site (RPC relay missing).',
  title: 'Your creator fees',
  intro:
    'You earn a share of the trading fees of every coin you created. Claims are sent to your connected wallet.',
  /** Success line: every amount the claim sent to the wallet (SOL, then the coin's tokens). */
  claimed: (amounts: readonly Amount[]) => `Claimed ${joinAmounts(amounts)}.`,
  viewTransaction: 'View transaction',
  loadFailed: 'Could not load your coins right now. Check your connection and retry.',
  prepareFailed: 'Could not prepare the claim. Try again in a moment.',
  signFailed: 'Something went wrong. Nothing was sent. Try again.',
  checkFailed: 'Could not check the transaction. Try again in a moment.',
  retry: 'Retry',
  loading: 'Loading your coins...',
  empty: 'You have not created any coin on this launchpad yet.',
  claimable: (amounts: readonly Amount[]) => `Claimable: ${amounts.join(' + ')}`,
  claim: 'Claim',
  claimLabel: (coin: string) => `Claim fees for ${coin}`,
  preparing: 'Preparing...',
  /** Unit of the coin's tokens when it has no ticker. */
  tokenUnit: 'tokens',
  review: {
    label: 'Claim summary',
    title: 'Review your claim',
    coin: 'Coin',
    youReceive: 'You receive',
    and: 'And',
    networkFee: 'Network fee (priority fee included)',
    coinAccountRent: 'Coin account rent (first claim, one time)',
    totalCost: 'Total cost',
    temporaryDeposit: 'Temporary deposit (refunded in the same transaction)',
    needed: 'Needed in your wallet',
    receiver: (address: string) => `Sent to your wallet: ${address}`,
    insufficient: (amount: Amount) => `Your wallet needs at least ${amount} to sign this claim.`,
    signing: 'Waiting for your signature...',
    sending: 'Sending to the network...',
    confirming: 'Waiting for the network to confirm...',
    checkAgain: 'Check again',
    cancel: 'Cancel',
    sign: 'Sign and claim',
  },
} as const;

function joinAmounts(amounts: readonly Amount[]): string {
  if (amounts.length <= 1) return amounts[0] ?? '';
  return `${amounts.slice(0, -1).join(', ')} and ${amounts[amounts.length - 1]}`;
}
