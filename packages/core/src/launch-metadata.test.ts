import { describe, expect, it } from 'vitest';
import type { LaunchpadSpec } from '@forge/shared';
import {
  LAUNCH_METADATA_BUDGET_BYTES,
  LaunchCoinError,
  METADATA_LIMITS,
  assertSpecLaunchable,
  launchMetadataBytes,
  type LaunchCoinErrorCode,
} from './launch-metadata.js';

const OWNER = '3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75';

function spec(coin: Partial<LaunchpadSpec['launchpadCoin']> = {}): LaunchpadSpec {
  return {
    version: 1,
    ownerWallet: OWNER,
    name: 'MoonPad',
    slug: 'moonpad',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: '',
      designNotes: '',
    },
    launchpadCoin: {
      name: 'Moon',
      symbol: 'MOON',
      description: '',
      imageUrl: 'https://example.com/moon.png',
      firstBuySol: 0.5,
      ...coin,
    },
  };
}

function codeOf(fn: () => void): LaunchCoinErrorCode | null {
  try {
    fn();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(LaunchCoinError);
    return (error as LaunchCoinError).code;
  }
}

/** A canonical https URI of exactly `bytes` bytes. */
const uri = (bytes: number) => `https://example.com/${'a'.repeat(bytes - 25)}.json`;

describe('LAUNCH_METADATA_BUDGET_BYTES', () => {
  it('is tighter than the Metaplex limits together (a 200-byte URI never fits the launch)', () => {
    expect(LAUNCH_METADATA_BUDGET_BYTES).toBe(148);
    expect(METADATA_LIMITS.name + METADATA_LIMITS.symbol + METADATA_LIMITS.uri).toBeGreaterThan(
      LAUNCH_METADATA_BUDGET_BYTES,
    );
    // The longest URI that fits next to the longest name and symbol.
    expect(LAUNCH_METADATA_BUDGET_BYTES - METADATA_LIMITS.name - METADATA_LIMITS.symbol).toBe(106);
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(launchMetadataBytes('é', 'AB', 'https://x.io/')).toBe(2 + 2 + 13);
    expect(launchMetadataBytes('🚀', 'AB', '')).toBe(6);
  });
});

describe('assertSpecLaunchable', () => {
  it('accepts a coin at exactly the budget and refuses one byte more (TX_TOO_LARGE)', () => {
    const longest = spec({ name: 'N'.repeat(32), symbol: 'S'.repeat(10) });
    expect(codeOf(() => assertSpecLaunchable(longest, uri(106)))).toBeNull();
    expect(codeOf(() => assertSpecLaunchable(longest, uri(107)))).toBe('TX_TOO_LARGE');
    // A Metaplex-valid 200-byte URI is refused for the launchpad coin even with a short name.
    expect(codeOf(() => assertSpecLaunchable(spec(), uri(200)))).toBe('TX_TOO_LARGE');
    expect(codeOf(() => assertSpecLaunchable(spec(), uri(140)))).toBeNull();
    expect(codeOf(() => assertSpecLaunchable(spec(), uri(141)))).toBe('TX_TOO_LARGE');
  });

  it('says what to shorten', () => {
    try {
      assertSpecLaunchable(spec({ name: 'N'.repeat(32), symbol: 'S'.repeat(10) }), uri(110));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('152 bytes');
      expect((error as Error).message).toContain('148');
    }
  });

  it.each([
    [{ name: ' Moon' }, 'https://example.com/a.json'],
    [{ name: 'Moon ' }, 'https://example.com/a.json'],
    [{ name: '' }, 'https://example.com/a.json'],
    [{ name: 'x'.repeat(33) }, 'https://example.com/a.json'],
    [{ symbol: 'moon' }, 'https://example.com/a.json'],
    [{}, 'http://example.com/a.json'],
    [{}, 'https://EXAMPLE.com/a.json'],
    [{}, 'not a url'],
    [{ firstBuySol: 0.1 + 0.2 }, 'https://example.com/a.json'],
    [{ firstBuySol: 10.5 }, 'https://example.com/a.json'],
    [{ firstBuySol: -1 }, 'https://example.com/a.json'],
  ])('refuses %j with %j (INVALID_INPUT)', (coin, metadataUri) => {
    expect(codeOf(() => assertSpecLaunchable(spec(coin), metadataUri))).toBe('INVALID_INPUT');
  });

  it('without a URI, checks the name, symbol and first buy only', () => {
    expect(
      codeOf(() =>
        assertSpecLaunchable(spec({ name: 'N'.repeat(32), symbol: 'S'.repeat(10) }), null),
      ),
    ).toBeNull();
    expect(codeOf(() => assertSpecLaunchable(spec({ name: ' Moon' }), null))).toBe('INVALID_INPUT');
    expect(codeOf(() => assertSpecLaunchable(spec({ firstBuySol: 0.1 + 0.2 }), null))).toBe(
      'INVALID_INPUT',
    );
  });

  it('refuses a spec without a launchpad coin', () => {
    expect(codeOf(() => assertSpecLaunchable({} as LaunchpadSpec, null))).toBe('INVALID_INPUT');
  });
});
