// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base58Encode } from '../auth/base58';
import { checkBetaAccess, currentBetaPolicy, isWalletAddress, parseBetaPolicy } from './config';

function newAddress(): string {
  const x = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;
  return base58Encode(Buffer.from(x, 'base64url'));
}

const A = newAddress();
const B = newAddress();
const C = newAddress();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isWalletAddress', () => {
  it('accepts canonical 32-byte base58 keys only', () => {
    expect(isWalletAddress(A)).toBe(true);
    expect(isWalletAddress('11111111111111111111111111111111')).toBe(true);
    expect(isWalletAddress('')).toBe(false);
    expect(isWalletAddress('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl')).toBe(false);
    // Valid alphabet, wrong length once decoded.
    expect(isWalletAddress('1111111111111111111111111111111')).toBe(false);
    expect(isWalletAddress(`${A}0`)).toBe(false);
    expect(isWalletAddress(`${A}${A}`)).toBe(false);
  });
});

describe('parseBetaPolicy', () => {
  it('defaults to on in production and off elsewhere', () => {
    expect(parseBetaPolicy({ NODE_ENV: 'development' })).toEqual({ mode: 'off' });
    expect(parseBetaPolicy({ NODE_ENV: 'test' })).toEqual({ mode: 'off' });
    expect(parseBetaPolicy({ NODE_ENV: 'production', FORGE_BETA_ALLOWLIST: A })).toEqual({
      mode: 'on',
      allowlist: new Set([A]),
    });
  });

  it('honours an explicit mode, case and spaces aside', () => {
    expect(parseBetaPolicy({ NODE_ENV: 'production', FORGE_BETA_MODE: ' OFF ' })).toEqual({
      mode: 'off',
    });
    expect(
      parseBetaPolicy({ NODE_ENV: 'test', FORGE_BETA_MODE: 'on', FORGE_BETA_ALLOWLIST: B }),
    ).toEqual({ mode: 'on', allowlist: new Set([B]) });
  });

  it('parses a comma-separated list with spaces, blank entries and duplicates', () => {
    const policy = parseBetaPolicy({
      FORGE_BETA_MODE: 'on',
      FORGE_BETA_ALLOWLIST: ` ${A}, ${B} ,,${A},\n${C}\n,`,
    });
    expect(policy).toEqual({ mode: 'on', allowlist: new Set([A, B, C]) });
  });

  it('fails closed on an unknown mode, an empty list or one invalid entry', () => {
    expect(parseBetaPolicy({ FORGE_BETA_MODE: 'maybe', FORGE_BETA_ALLOWLIST: A }).mode).toBe(
      'closed',
    );
    expect(parseBetaPolicy({ FORGE_BETA_MODE: 'on' }).mode).toBe('closed');
    expect(parseBetaPolicy({ FORGE_BETA_MODE: 'on', FORGE_BETA_ALLOWLIST: ' , ,' }).mode).toBe(
      'closed',
    );
    expect(parseBetaPolicy({ NODE_ENV: 'production' }).mode).toBe('closed');
    const bad = parseBetaPolicy({ FORGE_BETA_MODE: 'on', FORGE_BETA_ALLOWLIST: `${A},nope,${B}` });
    expect(bad).toEqual({
      mode: 'closed',
      problem: 'FORGE_BETA_ALLOWLIST entry #2 is not a valid wallet address',
    });
  });

  it('ignores the list when the beta is off', () => {
    expect(parseBetaPolicy({ FORGE_BETA_MODE: 'off', FORGE_BETA_ALLOWLIST: 'garbage' })).toEqual({
      mode: 'off',
    });
  });
});

describe('checkBetaAccess', () => {
  it('lets in allowlisted wallets only, and everyone when off', () => {
    const on = { FORGE_BETA_MODE: 'on', FORGE_BETA_ALLOWLIST: `${A},${B}` };
    expect(checkBetaAccess(A, on)).toBe('allowed');
    expect(checkBetaAccess(B, on)).toBe('allowed');
    expect(checkBetaAccess(C, on)).toBe('not_invited');
    expect(checkBetaAccess(C, { FORGE_BETA_MODE: 'off' })).toBe('allowed');
  });

  it('applies a changed list on the next call', () => {
    const env: Record<string, string> = {
      FORGE_BETA_MODE: 'on',
      FORGE_BETA_ALLOWLIST: `${A},${B}`,
    };
    expect(checkBetaAccess(B, env)).toBe('allowed');
    env.FORGE_BETA_ALLOWLIST = A;
    expect(checkBetaAccess(B, env)).toBe('not_invited');
    expect(checkBetaAccess(A, env)).toBe('allowed');
  });

  it('refuses everyone when misconfigured and logs the problem without any address', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = { FORGE_BETA_MODE: 'on', FORGE_BETA_ALLOWLIST: `${A},${B}0` };
    expect(checkBetaAccess(A, env)).toBe('unavailable');
    expect(checkBetaAccess(B, env)).toBe('unavailable');
    // Logged once per configuration, never with a value from the list.
    expect(errors).toHaveBeenCalledTimes(1);
    const logged = errors.mock.calls.flat().join(' ');
    expect(logged).toContain('FORGE_BETA_ALLOWLIST entry #2');
    expect(logged).not.toContain(A);
    expect(logged).not.toContain(B);
  });

  it('caches the parsed policy per configuration', () => {
    const env = { FORGE_BETA_MODE: 'on', FORGE_BETA_ALLOWLIST: `${C}` };
    const first = currentBetaPolicy(env);
    expect(currentBetaPolicy({ ...env })).toBe(first);
  });
});
