// @vitest-environment node
import { sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildLaunchAuthMessage,
  decodeSignature,
  isFreshIssuedAt,
  LAUNCH_AUTH_MAX_SKEW_MS,
  LAUNCH_AUTH_TTL_MS,
  verifyLaunchAuth,
} from '../launch-auth';
import { newWallet } from './helpers';

const FIELDS = {
  host: 'moonpad.forge-sites.app',
  wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  name: 'Moon Coin',
  symbol: 'MOON',
  firstBuyLamports: '100000000',
  imageSha256: 'a'.repeat(64),
  descriptionSha256: 'b'.repeat(64),
  nonce: '0123456789abcdef0123456789abcdef',
  issuedAt: '2026-10-11T12:00:00.000Z',
};

describe('buildLaunchAuthMessage (v1, same text as the client sites)', () => {
  it('produces the exact signed text', () => {
    expect(buildLaunchAuthMessage(FIELDS)).toBe(
      'moonpad.forge-sites.app asks you to sign in to create a coin.\n' +
        '\n' +
        'This signature authorizes the upload of the coin image and metadata. It does not move funds\n' +
        'and is not a transaction.\n' +
        '\n' +
        'Version: 1\n' +
        'Wallet: 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin\n' +
        'Coin: Moon Coin (MOON)\n' +
        'First buy (lamports): 100000000\n' +
        `Image SHA-256: ${'a'.repeat(64)}\n` +
        `Description SHA-256: ${'b'.repeat(64)}\n` +
        'Nonce: 0123456789abcdef0123456789abcdef\n' +
        'Issued at: 2026-10-11T12:00:00.000Z',
    );
  });
});

describe('isFreshIssuedAt', () => {
  const at = Date.parse(FIELDS.issuedAt);

  it('accepts up to 5 minutes old and 60 seconds ahead', () => {
    expect(isFreshIssuedAt(FIELDS.issuedAt, at)).toBe(true);
    expect(isFreshIssuedAt(FIELDS.issuedAt, at + LAUNCH_AUTH_TTL_MS)).toBe(true);
    expect(isFreshIssuedAt(FIELDS.issuedAt, at + LAUNCH_AUTH_TTL_MS + 1)).toBe(false);
    expect(isFreshIssuedAt(FIELDS.issuedAt, at - LAUNCH_AUTH_MAX_SKEW_MS)).toBe(true);
    expect(isFreshIssuedAt(FIELDS.issuedAt, at - LAUNCH_AUTH_MAX_SKEW_MS - 1)).toBe(false);
  });

  it('accepts only ISO 8601 UTC timestamps', () => {
    expect(isFreshIssuedAt('2026-10-11T12:00:00Z', at)).toBe(true);
    expect(isFreshIssuedAt('2026-10-11T12:00:00+00:00', at)).toBe(false);
    expect(isFreshIssuedAt('1791806400000', at)).toBe(false);
    expect(isFreshIssuedAt('2026-13-45T99:00:00Z', at)).toBe(false);
  });
});

describe('signature', () => {
  it('verifies an ed25519 signature sent as base64 and nothing else', () => {
    const wallet = newWallet();
    const message = buildLaunchAuthMessage({ ...FIELDS, wallet: wallet.address });
    const raw = sign(null, Buffer.from(message, 'utf8'), wallet.privateKey);
    const signature = raw.toString('base64');
    expect(verifyLaunchAuth(wallet.address, message, signature)).toBe(true);
    expect(verifyLaunchAuth(wallet.address, `${message} `, signature)).toBe(false);
    expect(verifyLaunchAuth(newWallet().address, message, signature)).toBe(false);
    expect(verifyLaunchAuth(wallet.address, message, raw.toString('base64url'))).toBe(false);
    expect(verifyLaunchAuth(wallet.address, message, signature.replace(/=+$/, ''))).toBe(false);
    expect(decodeSignature(Buffer.alloc(63).toString('base64'))).toBeNull();
    expect(decodeSignature(Buffer.alloc(64).toString('base64'))).toHaveLength(64);
  });
});
