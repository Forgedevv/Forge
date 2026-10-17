import { describe, expect, it } from 'vitest';
import { MAX_FIRST_BUY_SOL, METADATA_LIMITS } from '@forge/core';
import {
  FIRST_BUY_MAX_SOL,
  NAME_MAX_BYTES,
  SYMBOL_MAX,
  invalidFields,
  nameUsage,
  utf8ByteLength,
  validateCreateCoin,
  validateImageFile,
  type CreateCoinInput,
} from '@/forge/create/validation';

const valid: CreateCoinInput = {
  name: 'Moon Coin',
  symbol: 'moon',
  description: 'A coin.',
  image: { name: 'logo.png', type: 'image/png', size: 1024 },
  firstBuySol: '0.5',
};

describe('validateCreateCoin', () => {
  it('accepts a valid form and normalizes it', () => {
    const result = validateCreateCoin({ ...valid, name: '  Moon Coin  ' });
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Moon Coin',
        symbol: 'MOON',
        description: 'A coin.',
        firstBuyLamports: BigInt(500000000),
      },
    });
  });

  it('treats an empty first buy as zero', () => {
    const result = validateCreateCoin({ ...valid, firstBuySol: '' });
    expect(result.ok && result.value.firstBuyLamports).toBe(BigInt(0));
  });

  it('rejects short and long names, and control characters', () => {
    expect(validateCreateCoin({ ...valid, name: 'ab' })).toMatchObject({ ok: false });
    expect(validateCreateCoin({ ...valid, name: 'x'.repeat(33) })).toMatchObject({ ok: false });
    const r = validateCreateCoin({ ...valid, name: 'Bad‮Name' });
    expect(r.ok === false && r.errors.name).toMatch(/unsupported/);
  });

  it('rejects invalid symbols', () => {
    for (const symbol of ['A', 'TOOLONGSYMBOL', 'MO ON', 'MO-ON', '']) {
      const r = validateCreateCoin({ ...valid, symbol });
      expect(r.ok === false && r.errors.symbol).toBeTruthy();
    }
  });

  it('requires an image of an allowed type and size', () => {
    const missing = validateCreateCoin({ ...valid, image: null });
    expect(missing.ok === false && missing.errors.image).toMatch(/required/);
    const svg = validateCreateCoin({
      ...valid,
      image: { name: 'a.svg', type: 'image/svg+xml', size: 10 },
    });
    expect(svg.ok === false && svg.errors.image).toMatch(/PNG/);
    const big = validateCreateCoin({
      ...valid,
      image: { name: 'a.png', type: 'image/png', size: 2 * 1024 * 1024 + 1 },
    });
    expect(big.ok === false && big.errors.image).toMatch(/2 MB/);
  });

  it('bounds the description', () => {
    const r = validateCreateCoin({ ...valid, description: 'x'.repeat(501) });
    expect(r.ok === false && r.errors.description).toBeTruthy();
  });

  it('validates the first buy amount', () => {
    for (const firstBuySol of ['-1', '1e2', 'abc', '0.0000000001', '10.000000001', '100']) {
      const r = validateCreateCoin({ ...valid, firstBuySol });
      expect(r.ok === false && r.errors.firstBuySol).toBeTruthy();
    }
    // The bound is core's: a larger first buy would be refused by buildUserCoinLaunchTx.
    expect(FIRST_BUY_MAX_SOL).toBe(MAX_FIRST_BUY_SOL);
    const max = validateCreateCoin({ ...valid, firstBuySol: '10' });
    expect(max.ok).toBe(true);
  });

  it('reports every invalid field at once', () => {
    const r = validateCreateCoin({
      name: '',
      symbol: '',
      description: '',
      image: null,
      firstBuySol: 'x',
    });
    expect(r.ok === false && Object.keys(r.errors).sort()).toEqual(
      ['firstBuySol', 'image', 'name', 'symbol'].sort(),
    );
  });
});

describe('UTF-8 limits (same count as @forge/core)', () => {
  it('takes the name and symbol limits from core', () => {
    expect(NAME_MAX_BYTES).toBe(METADATA_LIMITS.name);
    expect(SYMBOL_MAX).toBe(METADATA_LIMITS.symbol);
  });

  it('counts bytes, not characters, for the name', () => {
    expect(utf8ByteLength('Moon')).toBe(4);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('🚀')).toBe(4);
    // 32 ASCII characters: exactly at the limit.
    expect(validateCreateCoin({ ...valid, name: 'N'.repeat(32) }).ok).toBe(true);
    // 16 accented letters = 32 bytes: accepted; 17 = 34 bytes: refused with the byte message.
    expect(validateCreateCoin({ ...valid, name: 'é'.repeat(16) }).ok).toBe(true);
    const accents = validateCreateCoin({ ...valid, name: 'é'.repeat(17) });
    expect(accents.ok === false && accents.errors.name).toMatch(/bytes/);
    // 21 characters, 35 bytes with the emoji.
    const emoji = validateCreateCoin({ ...valid, name: 'Rocket 🚀🚀🚀🚀🚀🚀🚀' });
    expect(emoji.ok === false && emoji.errors.name).toMatch(/accents or emoji/);
  });

  it('reports the live name usage in bytes', () => {
    expect(nameUsage('  Moon  ')).toEqual({ used: 4, max: 32, multibyte: false });
    expect(nameUsage('Café')).toEqual({ used: 5, max: 32, multibyte: true });
  });

  it('refuses a symbol with accented letters', () => {
    const r = validateCreateCoin({ ...valid, symbol: 'CAFÉ' });
    expect(r.ok === false && r.errors.symbol).toBeTruthy();
  });

  it('counts the description in characters, like the metadata contract', () => {
    expect(validateCreateCoin({ ...valid, description: 'é'.repeat(500) }).ok).toBe(true);
  });
});

describe('validateImageFile (checked as soon as a file is picked)', () => {
  it('accepts PNG, JPEG, WebP and GIF up to 2 MB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(validateImageFile({ name: 'a', type, size: 2 * 1024 * 1024 })).toBeNull();
    }
  });

  it('refuses other types, empty and oversized files', () => {
    expect(validateImageFile({ name: 'a.svg', type: 'image/svg+xml', size: 10 })).toMatch(/PNG/);
    expect(validateImageFile({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toMatch(/PNG/);
    expect(validateImageFile({ name: 'a.png', type: 'image/png', size: 0 })).toMatch(/empty/);
    expect(validateImageFile({ name: 'a.png', type: 'image/png', size: 2 * 1024 * 1024 + 1 })).toMatch(
      /2 MB/,
    );
    expect(validateImageFile(null)).toMatch(/required/);
  });
});

describe('invalidFields', () => {
  it('lists the invalid fields in form order (image first, first buy last)', () => {
    const r = validateCreateCoin({ name: '', symbol: '', description: '', image: null, firstBuySol: 'x' });
    expect(r.ok === false && invalidFields(r.errors)).toEqual(['image', 'name', 'symbol', 'firstBuySol']);
  });
});
