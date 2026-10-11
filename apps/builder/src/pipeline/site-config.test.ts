import { ForgeSiteConfig } from '@forge/shared';
import { describe, expect, it } from 'vitest';
import {
  checkAgentSiteConfig,
  initialSiteConfig,
  onchainBlock,
  parseSiteConfig,
  serializeSiteConfig,
  withMode,
  withOnchain,
} from './site-config.js';
import {
  LAUNCHPAD_COIN_CONFIG,
  LAUNCHPAD_COIN_MINT,
  LAUNCHPAD_CONFIG,
  OWNER,
  specFixture,
} from './test-fakes.js';

const spec = specFixture();
const onchain = onchainBlock({
  cluster: 'devnet',
  launchpadConfig: LAUNCHPAD_CONFIG,
  launchpadCoinConfig: LAUNCHPAD_COIN_CONFIG,
  launchpadCoinMint: LAUNCHPAD_COIN_MINT,
  spec,
});
const base = serializeSiteConfig(withOnchain(initialSiteConfig(spec), onchain));
const edit = (fn: (c: Record<string, unknown>) => void): string => {
  const c = JSON.parse(base) as Record<string, unknown>;
  fn(c);
  return JSON.stringify(c, null, 2);
};

describe('forge.config.json', () => {
  it('is written from the spec, live, without on-chain section', () => {
    const config = initialSiteConfig(spec);
    expect(ForgeSiteConfig.parse(config)).toEqual(config);
    expect(config).toEqual({
      version: 1,
      name: 'MoonPad',
      slug: 'moonpad',
      mode: 'live',
      theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
      content: { tagline: 'Launch to the moon', about: 'The MoonPad coin.' },
    });
    expect(serializeSiteConfig(config).endsWith('}\n')).toBe(true);
  });

  it('builds the on-chain block from the signer answers and the spec', () => {
    expect(onchain).toEqual({
      cluster: 'devnet',
      launchpadConfig: LAUNCHPAD_CONFIG,
      launchpadCoinConfig: LAUNCHPAD_COIN_CONFIG,
      launchpadCoinMint: LAUNCHPAD_COIN_MINT,
      ownerWallet: OWNER,
      poolCreationFeeSol: 0.01,
    });
    expect(() =>
      onchainBlock({
        cluster: 'devnet',
        launchpadConfig: 'not-an-address',
        launchpadCoinConfig: LAUNCHPAD_COIN_CONFIG,
        launchpadCoinMint: LAUNCHPAD_COIN_MINT,
        spec,
      }),
    ).toThrow(/invalid/);
  });

  it('keeps extra theme keys when the builder sets mode or onchain', () => {
    const raw = parseSiteConfig(edit((c) => ((c.theme as Record<string, unknown>).font = 'Inter')));
    expect((withMode(raw, 'sleeping').theme as Record<string, unknown>).font).toBe('Inter');
  });

  it('rejects invalid files', () => {
    expect(() => parseSiteConfig('{')).toThrow(/invalid/);
    expect(() => parseSiteConfig('[]')).toThrow(/object/);
    expect(() => parseSiteConfig('{"version":1,"version":1}')).toThrow(/duplicate/);
    expect(() => parseSiteConfig(edit((c) => (c.mode = 'party')))).toThrow(/mode/);
  });
});

describe('agent changes to forge.config.json', () => {
  const rules = (next: string | null) => checkAgentSiteConfig(base, next).map((v) => v.reason);

  it('accepts theme and content changes', () => {
    expect(
      rules(
        edit((c) => {
          (c.theme as Record<string, unknown>).accentColor = '#000000';
          (c.content as Record<string, unknown>).about = 'New about text';
        }),
      ),
    ).toEqual([]);
    expect(rules(base)).toEqual([]);
  });

  it('refuses any change to onchain, mode, name, slug or version', () => {
    expect(
      rules(edit((c) => ((c.onchain as Record<string, unknown>).ownerWallet = LAUNCHPAD_CONFIG))),
    ).toEqual(['field "onchain" may only be written by the builder']);
    expect(rules(edit((c) => delete c.onchain))).toEqual([
      'field "onchain" may only be written by the builder',
    ]);
    expect(rules(edit((c) => (c.mode = 'sleeping')))).toEqual([
      'field "mode" may only be written by the builder',
    ]);
    expect(rules(edit((c) => (c.name = 'Other')))).toEqual([
      'field "name" may only be written by the builder',
    ]);
    expect(rules(edit((c) => (c.slug = 'other')))).toEqual([
      'field "slug" may only be written by the builder',
    ]);
    expect(rules(edit((c) => (c.extra = true)))).toEqual([
      'field "extra" may only be written by the builder',
    ]);
  });

  it('refuses a deleted, invalid or off-schema file', () => {
    expect(rules(null)).toEqual(['forge.config.json was deleted']);
    expect(rules('{ nope')[0]).toMatch(/invalid JSON/);
    expect(
      rules(edit((c) => ((c.theme as Record<string, unknown>).primaryColor = 'purple'))),
    ).toEqual(['schema mismatch at theme.primaryColor']);
    expect(rules(edit((c) => delete c.content))[0]).toMatch(/schema mismatch at content/);
  });
});
