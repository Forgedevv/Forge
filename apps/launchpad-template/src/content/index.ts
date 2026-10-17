import { siteConfig } from '@/forge/config';

/**
 * Texts of the site (FREE ZONE). Values come from forge.config.json#content; UI copy is centralised
 * here so other languages can be added later. Every section component reads its copy from here:
 * rewrite these values to match the brand voice of the launchpad.
 */
export { siteConfig };

export const content = {
  name: siteConfig.name,
  tagline: siteConfig.content.tagline,
  about: siteConfig.content.about,
  strings: {
    createCoin: 'Create a coin',
    createPoolCompact: 'Create',
    connectWallet: 'Connect wallet',
    connectShort: 'Connect',
    aboutTitle: 'About',
    creatorFees: 'Creator fees',
    explore: 'Explore',
    footerNote: 'Built with FORGE',
    homeEyebrow: 'TOKEN LAUNCHPAD',
    homeAction: 'Explore',
    marketEyebrow: 'EXPLORE',
    marketTitle: 'The market',
    network: 'Solana',
    columns: { new: 'New coins', soon: 'Near graduation', bonded: 'Graduated' },
    emptyTokens: 'Nothing here yet.',
    emptyTokensBody: 'The next coin could be yours.',
    unavailableTokens: 'The market is taking a moment.',
    unavailableTokensBody: 'Token data is unavailable. Try again shortly.',
    unavailableHolders: 'Holders temporarily unavailable',
    unavailableHoldersBody: 'The holder list could not be loaded. Prices and trading still work.',
    unavailableTxns: 'Transactions temporarily unavailable',
    unavailableTxnsBody: 'Recent trades could not be loaded. Prices and trading still work.',
    devnetHolders: 'No holder list on devnet',
    devnetHoldersBody:
      'Holder data comes from Jupiter, which does not index devnet. Prices and trading still work.',
    devnetTxns: 'No transaction history on devnet',
    devnetTxnsBody:
      'Trade history comes from Jupiter, which does not index devnet. Prices and trading still work.',
    retry: 'Retry',
    auditEnabled: 'Enabled',
    auditDisabled: 'Disabled',
    auditUnknown: 'Unknown',
    readMore: 'Read more',
    showLess: 'Show less',
    tokenAddress: 'Token address',
    backToMarket: 'Back to market',
    lightMode: 'Switch to light mode',
    darkMode: 'Switch to dark mode',
    colorMode: 'Switch colour mode',
    aboutEyebrow: 'THE PEOPLE BEHIND IT',
    createEyebrow: 'NEW COIN',
    createIntro: 'Name it. Add its image. Set it in motion.',
    homeLabel: 'Home',
    mainNavLabel: 'Main',
    footerNavLabel: 'Site',
    valuesLabel: 'Why launch here',
  },
  /** Short selling points under the hero. */
  values: [
    {
      icon: 'ph--lightning-bold',
      title: 'Live in a minute',
      body: 'Name, ticker, image. Your coin trades the moment it is created.',
    },
    {
      icon: 'ph--chart-line-up-bold',
      title: 'Fair from the first trade',
      body: 'Every coin starts on the same public bonding curve. No presale, no hidden allocation.',
    },
    {
      icon: 'ph--coins-bold',
      title: 'Creators earn',
      body: 'Coin creators earn a share of the trading fees and claim it whenever they like.',
    },
  ],
  market: {
    empty: {
      title: 'The market opens with the first coin.',
      body: 'No coin has launched here yet. Create one now and it becomes the first name on this board.',
      action: 'Launch the first coin',
      stagesLabel: 'How coins move through the market',
      stages: [
        { title: 'New coins', body: 'Fresh launches, newest first.' },
        { title: 'Near graduation', body: 'Coins close to filling their curve.' },
        { title: 'Graduated', body: 'Coins that moved to an open pool.' },
      ],
    },
  },
  howItWorks: {
    eyebrow: 'HOW IT WORKS',
    title: 'From idea to market in three steps.',
    steps: [
      {
        title: 'Create your coin',
        body: 'Pick a name, a ticker and an image. Review every cost before you sign.',
      },
      {
        title: 'Trade on the curve',
        body: 'Anyone can buy and sell right away. The price follows a transparent bonding curve.',
      },
      {
        title: 'Graduate',
        body: 'When the curve fills, liquidity moves to an open pool and trading carries on.',
      },
    ],
  },
  /** The launchpad's own coin. Fill it from the brief. */
  launchpadCoin: {
    eyebrow: 'THE LAUNCHPAD COIN',
    name: `${siteConfig.name} Coin`,
    symbol: '',
    description: 'The coin of this launchpad. It goes live with the launchpad itself.',
    tradeAction: 'Trade the coin',
    pendingNote: 'Trading opens at launch.',
  },
  faq: {
    eyebrow: 'QUESTIONS',
    title: 'Good to know',
    items: [
      {
        question: 'What does it cost to create a coin?',
        answer: 'The create page shows every fee and the network cost before you sign anything.',
      },
      {
        question: 'What is a bonding curve?',
        answer:
          'A price formula: each buy raises the price a little and each sell lowers it, so there is always a price to trade at.',
      },
      {
        question: 'What happens at graduation?',
        answer:
          'Once enough has been bought on the curve, the coin migrates to an open liquidity pool where trading continues.',
      },
      {
        question: 'I created a coin. How do I get my fees?',
        answer:
          'Open the creator fees page, connect the wallet you created the coin with and claim.',
      },
    ],
  },
  closing: {
    title: 'Your coin could be next.',
    body: 'It takes a minute to launch, and every trade after that happens in the open.',
    primaryAction: 'Create a coin',
    secondaryAction: 'Browse the market',
  },
  create: {
    notesTitle: 'Before you launch',
    notes: [
      {
        title: 'A name and a ticker',
        body: 'Short and memorable. The ticker is how traders find it.',
      },
      { title: 'A square image', body: 'PNG, JPEG, WebP or GIF, up to 2 MB.' },
      {
        title: 'A wallet with SOL',
        body: 'Enough for the creation fee and the network cost, shown before you sign.',
      },
    ],
  },
  footer: {
    note: 'Built with FORGE',
    disclaimer: 'Coins are volatile. Only trade what you can afford to lose.',
  },
} as const;
