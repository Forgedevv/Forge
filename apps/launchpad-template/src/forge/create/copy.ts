/**
 * LOCKED ZONE. Every visible text of the coin creation flow (`CreateCoin` and its parts), in one
 * place so the wording stays consistent and other languages can be added later. Like the other
 * locked-zone copy (`trade/copy.ts`, `claims/copy.ts`, `chart/copy.ts`, `SLEEPING_TEXT`), it lives
 * next to the code that renders it and imports nothing from the free zones, so a site redesign can
 * never break the flow.
 *
 * Plain strings, or small functions for the texts that carry a value. The form validation messages
 * are `VALIDATION_TEXT` (validation.ts, shared with the server); the error sentences live in
 * errors.ts (its tables are re-exported here) and flow.ts.
 */

export { VALIDATION_TEXT } from './validation';
export { CHAIN_FAILURE_TEXT, SEND_ERROR_TEXT, WALLET_ERROR_TEXT } from './errors';

export const CREATE_COIN_TEXT = {
  details: {
    title: 'Coin details',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Moon Coin',
    symbolLabel: 'Symbol',
    symbolPlaceholder: 'MOON',
    symbolHint: 'Letters and digits only. Traders search for it.',
    descriptionLabel: 'Description',
    descriptionPlaceholder: 'What is this coin about?',
    optional: 'optional',
    required: 'required',
    /** Screen reader text of a counter (`12 of 32`). */
    counter: (used: number, max: number) => `${used} of ${max} characters used`,
    /** Shown when a name holds characters that take more than one byte (accents, emoji). */
    counterBytes: (used: number, max: number) =>
      `${used} of ${max} bytes used. Accents and emoji count as more than one.`,
  },
  image: {
    label: 'Coin image',
    dropTitle: 'Drop your image here',
    dropAction: 'or click to browse',
    dropActive: 'Release to use this image',
    formats: 'PNG, JPEG, WebP or GIF, 2 MB max. Square works best.',
    replace: 'Replace',
    remove: 'Remove',
    previewAlt: 'Selected coin image',
    cropNote: 'The circle shows how it appears in the market.',
  },
  preview: {
    title: 'Preview',
    intro: 'How traders will see your coin in the market.',
    namePlaceholder: 'Coin name',
    symbolPlaceholder: 'TICKER',
    descriptionPlaceholder: 'Your description appears here.',
    age: 'just now',
    creator: 'by you',
  },
  firstBuy: {
    title: 'First buy',
    label: 'First buy (SOL, optional)',
    unit: 'SOL',
    hint: (maxSol: number) =>
      `Buy your own coin in the same transaction, up to ${maxSol} SOL. Leave it empty for none.`,
    presets: 'Quick amounts',
    none: 'None',
  },
  costs: {
    title: 'Estimated cost',
    creationFee: (siteName: string) => `Creation fee (paid to ${siteName})`,
    creationFeeLater: 'shown in the review',
    firstBuy: 'First buy',
    platformFee: (percent: string) => `FORGE platform fee (${percent} of the first buy)`,
    note: (percent: string) =>
      `A first buy pays the ${percent} FORGE platform fee, like every trade on this site. The network fee and the deposit for new accounts are added in the review. You always see the full total before anything is signed.`,
  },
  actions: {
    connect: 'Connect wallet',
    review: 'Review launch',
    reviewHint:
      'Next, your wallet asks for a free signature (not a transaction), then you see every cost before you launch.',
    preparing: 'Preparing...',
    updating: 'Updating...',
    back: 'Back',
    edit: 'Edit coin',
    sign: 'Sign and launch',
    tryAgain: 'Try again',
    checkAgain: 'Check again',
    startOver: 'Start over',
    another: 'Create another coin',
    updateFirstBuy: 'Update first buy',
    useAmount: (sol: string) => `Use ${sol} SOL`,
  },
  steps: {
    label: 'Preparing your coin',
    sign: 'Sign a free message',
    signNote:
      'Your wallet asks you to sign a message. It is free: it is not a transaction and moves no funds. It proves the upload comes from you.',
    upload: 'Upload the image',
    check: 'Check the transaction',
    review: 'Review and launch',
    rebuilding: 'Updating the transaction with your new amount...',
    refreshing: 'Refreshing the transaction so it does not expire...',
    done: 'done',
    current: 'in progress',
    pending: 'to do',
  },
  errors: {
    summary: (count: number) =>
      count === 1 ? 'Fix 1 field to continue:' : `Fix ${count} fields to continue:`,
    unavailable: 'Coin creation is not available on this site right now. Please come back later.',
    notConfigured: 'Coin creation is not open on this site yet. Please come back later.',
    noMessageSigning:
      'Your wallet cannot sign messages. Creating a coin needs one free message signature to protect your upload: connect a wallet that supports it, such as Phantom or Solflare.',
    walletDisconnected: 'Your wallet disconnected. Reconnect it to sign the launch.',
    walletChanged:
      'You switched wallets. Your coin details are kept: review the launch again with this wallet.',
    reviewOutdated:
      'This review is out of date. Your coin details are kept: review the launch again to get a fresh transaction.',
    totalChanged:
      'The network fee changed while you were reviewing. Check the new total, then sign again.',
    retryKept: 'Your coin details are kept. Review the launch again to get a fresh transaction.',
    unexpected: 'Something went wrong. Nothing was signed. Try again.',
  },
  review: {
    title: 'Review your launch',
    intro:
      'Check every line. The transaction was decoded and simulated in your browser and matches this summary. Your wallet will ask you to sign once; nothing is charged before that.',
    coin: 'Coin',
    creationFee: (siteName: string) => `Creation fee (paid to ${siteName})`,
    firstBuy: 'First buy',
    platformFee: (percent: string) => `FORGE platform fee (${percent} of the first buy)`,
    receiveAtLeast: 'You receive at least',
    metadataFee: 'Metadata fee (Metaplex)',
    networkFee: 'Network fee (priority fee included)',
    deposit: 'Deposit for new accounts',
    total: 'Total',
    creatorWallet: 'Creator wallet (receives the creator fee share)',
    mint: 'Coin address',
    notEnoughSol: (needed: string, held: string) =>
      `Not enough SOL: this launch needs ${needed} SOL and your wallet holds ${held} SOL.`,
    lowerFirstBuy: 'Add SOL to your wallet, or lower the first buy and update the transaction.',
    newFirstBuy: 'New first buy (SOL)',
    affordable: (sol: string) => `With this balance, a first buy of up to about ${sol} SOL fits.`,
    signing: 'Waiting for your signature in your wallet...',
    sending: 'Sending to the network...',
  },
  status: {
    confirming: 'Waiting for the network to confirm your coin...',
    transaction: 'Transaction',
  },
  success: {
    title: 'Your coin is live',
    body: (siteName: string) =>
      `The transaction is confirmed. Your coin can now be traded on ${siteName}.`,
    view: 'View your coin',
    viewTransaction: 'View transaction',
    share: 'Share on X',
    shareText: (name: string, symbol: string, siteName: string) =>
      `I just launched ${name} ($${symbol}) on ${siteName}.`,
    mint: 'Coin address',
    copy: 'Copy address',
    copied: 'Copied',
    feesTitle: 'You earn creator fees',
    feesBody:
      'As the creator, you earn a share of the trading fees of your coin. They add up with every trade; claim them whenever you like.',
    feesLink: 'Go to creator fees',
  },
} as const;

/** Route of the creator fee claim page (locked page, `src/forge/pages/CreatorFeesPage.tsx`). */
export const CREATOR_FEES_HREF = '/creator-fees';
