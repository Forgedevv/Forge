import { describe, expect, it } from 'vitest';
import { validateCreateCoin, type CreateCoinInput } from '@/forge/create/validation';

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
    for (const firstBuySol of ['-1', '1e2', 'abc', '0.0000000001', '100.000000001']) {
      const r = validateCreateCoin({ ...valid, firstBuySol });
      expect(r.ok === false && r.errors.firstBuySol).toBeTruthy();
    }
    const max = validateCreateCoin({ ...valid, firstBuySol: '100' });
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
