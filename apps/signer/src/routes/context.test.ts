import { LAUNCH_METADATA_BUDGET_BYTES, assertSpecLaunchable } from '@forge/core';
import { describe, expect, it } from 'vitest';
import { MAX_METADATA_URI_BYTES, assertMetadataTemplate, metadataUriFor } from './context.js';
import type { RouteLaunchpad } from './store.js';
import { testSpec } from './testing.js';

const OWNER = '3zmm4YTrfwU76jBTHg3kQsu323zGLWP4pj9RLdzTSy75';

/** A template whose longest substitution is exactly `bytes` bytes. */
function template(placeholder: '{slug}' | '{launchpadId}', bytes: number): string {
  const longest = placeholder === '{slug}' ? 32 : 36;
  const prefix = 'https://meta.forge.test/';
  const suffix = '.json';
  const padding = bytes - prefix.length - longest - suffix.length;
  return `${prefix}${'p'.repeat(padding)}${placeholder}${suffix}`;
}

function launchpad(slug: string): RouteLaunchpad {
  return { id: 'ffffffff-ffff-4fff-bfff-ffffffffffff', slug } as RouteLaunchpad;
}

describe('assertMetadataTemplate (SIGNER_COIN_METADATA_URL at startup)', () => {
  it('leaves room for the longest coin name and symbol in the launch transaction', () => {
    expect(MAX_METADATA_URI_BYTES).toBe(LAUNCH_METADATA_BUDGET_BYTES - 32 - 10);
    expect(MAX_METADATA_URI_BYTES).toBe(106);
  });

  it.each(['{slug}', '{launchpadId}'] as const)(
    'accepts a %s template up to the limit with the longest value, refuses one byte more',
    (placeholder) => {
      expect(() =>
        assertMetadataTemplate(template(placeholder, MAX_METADATA_URI_BYTES)),
      ).not.toThrow();
      expect(() =>
        assertMetadataTemplate(template(placeholder, MAX_METADATA_URI_BYTES + 1)),
      ).toThrow(/SIGNER_COIN_METADATA_URL is too long: 107 bytes/);
    },
  );

  it('measures the launchpad id at 36 bytes and the slug at 32', () => {
    // 106 bytes with a 32-byte slug, but 110 with a 36-byte launchpad id.
    const withSlug = template('{slug}', MAX_METADATA_URI_BYTES);
    expect(() => assertMetadataTemplate(withSlug)).not.toThrow();
    expect(() => assertMetadataTemplate(withSlug.replace('{slug}', '{launchpadId}'))).toThrow(
      /too long: 110 bytes/,
    );
  });

  it('refuses a template the launch would refuse (not a canonical https URL)', () => {
    for (const bad of [
      'https://META.forge.test/{slug}.json',
      'https://meta.forge.test/a b/{slug}.json',
      'https://meta.forge.test:443/{slug}.json',
    ]) {
      expect(() => assertMetadataTemplate(bad)).toThrow(/SIGNER_COIN_METADATA_URL/);
    }
  });

  it('keeps the existing refusals', () => {
    for (const bad of [
      '',
      'http://meta.forge.test/{slug}.json',
      'https://meta.forge.test/coin.json',
      'https://meta.forge.test/{slug}/{launchpadId}.json',
    ]) {
      expect(() => assertMetadataTemplate(bad)).toThrow(/SIGNER_COIN_METADATA_URL/);
    }
  });

  it('every accepted template fits with any spec the shared schema accepts', () => {
    const longestCoin = testSpec(OWNER, {
      launchpadCoin: {
        ...testSpec(OWNER).launchpadCoin,
        name: 'é'.repeat(16),
        symbol: 'S'.repeat(10),
      },
    });
    for (const placeholder of ['{slug}', '{launchpadId}'] as const) {
      const accepted = template(placeholder, MAX_METADATA_URI_BYTES);
      assertMetadataTemplate(accepted);
      const uri = metadataUriFor(accepted, launchpad('s'.repeat(32)));
      expect(() => assertSpecLaunchable(longestCoin, uri)).not.toThrow();
    }
  });
});
