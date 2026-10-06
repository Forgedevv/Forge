import { describe, expect, it } from 'vitest';
import { CLIENT_BOUNDS } from './constants.js';
import {
  LaunchpadSpec,
  SolanaAddress,
  validateSpecDraft,
  type LaunchpadSpecDraft,
  type LaunchpadSpecInput,
} from './spec.js';

const OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function moonPad(): LaunchpadSpecInput {
  return {
    version: 1,
    ownerWallet: OWNER,
    name: 'MoonPad',
    slug: 'moonpad',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0.01,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: 'To the moon, one coin at a time',
      logoUrl: 'https://example.com/logo.png',
      designNotes: 'Space theme, rounded cards.',
    },
    launchpadCoin: {
      name: 'Moon',
      symbol: 'MOON',
      description: 'The coin of MoonPad.',
      imageUrl: 'https://example.com/moon.png',
      firstBuySol: 1,
    },
  };
}

function withOverride(patch: (spec: LaunchpadSpecInput) => void): LaunchpadSpecInput {
  const spec = moonPad();
  patch(spec);
  return spec;
}

const ok = (spec: unknown) => LaunchpadSpec.safeParse(spec).success;

describe('LaunchpadSpec', () => {
  it('accepts a valid MoonPad spec', () => {
    expect(LaunchpadSpec.parse(moonPad())).toMatchObject({ name: 'MoonPad', slug: 'moonpad' });
  });

  it('applies defaults for coinCreatorSharePct and antiSniper', () => {
    const spec = moonPad();
    delete spec.coinCreatorSharePct;
    delete spec.antiSniper;
    const parsed = LaunchpadSpec.parse(spec);
    expect(parsed.coinCreatorSharePct).toBe(25);
    expect(parsed.coinCreatorSharePct).toBe(CLIENT_BOUNDS.coinCreatorSharePct.default);
    expect(parsed.antiSniper).toBe(true);
  });

  it('enforces tradingFeeBps bounds', () => {
    expect(ok(withOverride((s) => (s.tradingFeeBps = 49)))).toBe(false);
    expect(ok(withOverride((s) => (s.tradingFeeBps = 50)))).toBe(true);
    expect(ok(withOverride((s) => (s.tradingFeeBps = 200)))).toBe(true);
    expect(ok(withOverride((s) => (s.tradingFeeBps = 201)))).toBe(false);
    expect(ok(withOverride((s) => (s.tradingFeeBps = 100.5)))).toBe(false);
  });

  it('enforces coinCreatorSharePct bounds', () => {
    expect(ok(withOverride((s) => (s.coinCreatorSharePct = 0)))).toBe(true);
    expect(ok(withOverride((s) => (s.coinCreatorSharePct = 50)))).toBe(true);
    expect(ok(withOverride((s) => (s.coinCreatorSharePct = 51)))).toBe(false);
    expect(ok(withOverride((s) => (s.coinCreatorSharePct = -1)))).toBe(false);
  });

  it('enforces poolCreationFeeSol: 0 or [0.001, 1]', () => {
    expect(ok(withOverride((s) => (s.poolCreationFeeSol = 0)))).toBe(true);
    expect(ok(withOverride((s) => (s.poolCreationFeeSol = 0.0005)))).toBe(false);
    expect(ok(withOverride((s) => (s.poolCreationFeeSol = 0.001)))).toBe(true);
    expect(ok(withOverride((s) => (s.poolCreationFeeSol = 1)))).toBe(true);
    expect(ok(withOverride((s) => (s.poolCreationFeeSol = 1.01)))).toBe(false);
    expect(ok(withOverride((s) => (s.poolCreationFeeSol = -0.5)))).toBe(false);
  });

  it('rejects a bad slug', () => {
    for (const slug of ['Moonpad', 'mo', 'moon pad', 'moon_pad', 'a'.repeat(33)]) {
      expect(ok(withOverride((s) => (s.slug = slug)))).toBe(false);
    }
  });

  it('rejects a bad symbol', () => {
    for (const symbol of ['moon', 'M', 'MOON!', 'ABCDEFGHIJK']) {
      expect(ok(withOverride((s) => (s.launchpadCoin.symbol = symbol)))).toBe(false);
    }
  });

  it('rejects bad colors', () => {
    for (const color of ['7C3AED', '#7C3AE', '#7C3AEDFF', '#GGGGGG', 'purple']) {
      expect(ok(withOverride((s) => (s.theme.primaryColor = color)))).toBe(false);
      expect(ok(withOverride((s) => (s.theme.accentColor = color)))).toBe(false);
    }
  });

  it('rejects a bad ownerWallet', () => {
    for (const wallet of ['', 'short', '0xabc0000000000000000000000000000000000000', `${OWNER}O`]) {
      expect(ok(withOverride((s) => (s.ownerWallet = wallet)))).toBe(false);
    }
  });

  it('rejects non-http image URLs', () => {
    expect(ok(withOverride((s) => (s.launchpadCoin.imageUrl = 'javascript:alert(1)')))).toBe(false);
    expect(ok(withOverride((s) => (s.theme.logoUrl = 'not a url')))).toBe(false);
  });

  it('rejects wrong version and quote', () => {
    expect(LaunchpadSpec.safeParse({ ...moonPad(), version: 2 }).success).toBe(false);
    expect(LaunchpadSpec.safeParse({ ...moonPad(), quote: 'USDC' }).success).toBe(false);
  });
});

describe('SolanaAddress', () => {
  it('accepts base58 addresses and rejects others', () => {
    expect(SolanaAddress.safeParse(OWNER).success).toBe(true);
    expect(SolanaAddress.safeParse('11111111111111111111111111111111').success).toBe(true);
    expect(SolanaAddress.safeParse('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl').success).toBe(false);
  });
});

describe('validateSpecDraft', () => {
  it('reports complete for a full spec', () => {
    const draft: LaunchpadSpecDraft = moonPad();
    delete draft.version;
    delete draft.quote;
    expect(validateSpecDraft(draft)).toEqual({ complete: true, errors: {} });
  });

  it('keys errors by dotted field path', () => {
    const result = validateSpecDraft({ name: 'MoonPad', launchpadCoin: { symbol: 'moon' } });
    expect(result.complete).toBe(false);
    expect(result.errors).toHaveProperty(['launchpadCoin.symbol']);
    expect(result.errors).toHaveProperty(['slug']);
    expect(result.errors).not.toHaveProperty(['name']);
  });
});
