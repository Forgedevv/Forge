import { describe, expect, it } from 'vitest';
import { walletEnv, walletMetadata } from '@/forge/AppProviders';

describe('wallet provider config', () => {
  it('follows the configured cluster', () => {
    expect(walletEnv('devnet')).toBe('devnet');
    expect(walletEnv('mainnet-beta')).toBe('mainnet-beta');
  });

  it('describes this site, from its config and its own origin', () => {
    const site = { name: 'Moon Pad', content: { tagline: 'To the moon', about: '' } };
    expect(walletMetadata(site, 'https://moonpad.example')).toEqual({
      name: 'Moon Pad',
      description: 'To the moon',
      url: 'https://moonpad.example',
      iconUrls: ['https://moonpad.example/favicon.ico'],
    });
    expect(walletMetadata(site, '').iconUrls).toEqual([]);
  });
});
