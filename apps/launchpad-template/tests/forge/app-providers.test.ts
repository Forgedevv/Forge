import { describe, expect, it } from 'vitest';
import { walletEnv, walletMetadata } from '@/forge/AppProviders';

describe('wallet provider config', () => {
  it('follows the configured cluster, devnet unless mainnet-beta is explicit', () => {
    expect(walletEnv('devnet')).toBe('devnet');
    expect(walletEnv('mainnet-beta')).toBe('mainnet-beta');
    expect(walletEnv('testnet' as never)).toBe('devnet');
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
