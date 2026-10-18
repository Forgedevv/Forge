import { describe, expect, it } from 'vitest';
import { buildLaunchAuthMessage } from '@/forge/create/auth';

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

// Same text as apps/web src/server/uploads/launch-auth.ts (pinned by its tests too).
const BASE =
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
  `Description SHA-256: ${'b'.repeat(64)}\n`;
const TAIL = 'Nonce: 0123456789abcdef0123456789abcdef\n' + 'Issued at: 2026-10-11T12:00:00.000Z';

describe('buildLaunchAuthMessage', () => {
  it('produces the exact v1 text without an X link', () => {
    expect(buildLaunchAuthMessage(FIELDS)).toBe(BASE + TAIL);
    expect(buildLaunchAuthMessage({ ...FIELDS, twitter: null })).toBe(BASE + TAIL);
  });

  it('signs the X link on its own line when there is one', () => {
    expect(buildLaunchAuthMessage({ ...FIELDS, twitter: 'https://x.com/moon_coin' })).toBe(
      BASE + 'X: https://x.com/moon_coin\n' + TAIL,
    );
  });
});
