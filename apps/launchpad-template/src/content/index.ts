import { siteConfig } from '@/forge/config';

/**
 * Texts of the site (FREE ZONE). Values come from forge.config.json#content; UI copy is centralised
 * here so other languages can be added later.
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
    retry: 'Retry',
    tokenAddress: 'Token address',
    backToMarket: 'Back to market',
    lightMode: 'Switch to light mode',
    darkMode: 'Switch to dark mode',
    aboutEyebrow: 'THE PEOPLE BEHIND IT',
    createEyebrow: 'NEW COIN',
    createIntro: 'Name it. Add its image. Set it in motion.',
  },
} as const;
