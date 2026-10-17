import { describe, expect, it } from 'vitest';
import { FIXED_ROLES, parseRole, roleFileName, roleFromFileName } from './roles.js';

describe('fixed roles', () => {
  it('knows the payer, cashbox, buyback and revenue wallets, each with its own file', () => {
    expect([...FIXED_ROLES]).toEqual(['payer', 'cashbox', 'buyback', 'revenue']);
    for (const role of FIXED_ROLES) {
      expect(parseRole(role)).toBe(role);
      expect(roleFileName(role)).toBe(`${role}.json`);
      expect(roleFromFileName(`${role}.json`)).toBe(role);
    }
    expect(() => parseRole('treasury')).toThrow();
    expect(roleFromFileName('revenue.txt')).toBeUndefined();
  });
});
