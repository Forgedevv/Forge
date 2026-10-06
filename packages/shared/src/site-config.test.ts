import { describe, expect, it } from 'vitest';
import { ForgeSiteConfig, toSiteConfig } from './site-config.js';

const ADDR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

const example = {
  version: 1,
  name: 'MoonPad',
  slug: 'moonpad',
  mode: 'live',
  onchain: {
    cluster: 'mainnet-beta',
    launchpadConfig: ADDR,
    launchpadCoinConfig: ADDR,
    launchpadCoinMint: ADDR,
    ownerWallet: ADDR,
  },
  theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
  content: { tagline: 'To the moon', about: 'A launchpad for moon coins.' },
};

describe('ForgeSiteConfig', () => {
  it('accepts the documented example', () => {
    expect(ForgeSiteConfig.parse(example)).toEqual(example);
  });

  it('accepts a config without the onchain block', () => {
    const { onchain, ...rest } = example;
    expect(onchain).toBeDefined();
    expect(ForgeSiteConfig.safeParse(rest).success).toBe(true);
  });

  it('rejects an invalid mode', () => {
    expect(ForgeSiteConfig.safeParse({ ...example, mode: 'paused' }).success).toBe(false);
  });

  it('rejects an invalid cluster', () => {
    const bad = { ...example, onchain: { ...example.onchain, cluster: 'testnet' } };
    expect(ForgeSiteConfig.safeParse(bad).success).toBe(false);
  });

  it('projects to SiteConfig without onchain data', () => {
    const site = toSiteConfig(ForgeSiteConfig.parse(example));
    expect(site).toEqual({
      name: 'MoonPad',
      slug: 'moonpad',
      theme: example.theme,
      content: example.content,
      mode: 'live',
    });
    expect(site).not.toHaveProperty('onchain');
  });
});
