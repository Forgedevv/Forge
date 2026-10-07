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
    connectWallet: 'Connect Wallet',
    aboutTitle: 'About',
    sleepingTitle: 'This launchpad is sleeping',
    sleepingBody: 'Trading is paused here. You can still find the coin on Jupiter.',
    viewOnJupiter: 'View the coin on Jupiter',
    disabledTitle: 'This site is unavailable.',
  },
} as const;
