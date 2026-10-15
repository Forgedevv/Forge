import { describe, expect, it } from 'vitest';
import { OwnerTransactionLaunch } from './api.js';
import { isSiteHost, isVercelAppHost, JobOwnerTxDetails, SiteHost } from './db.js';

const details = {
  config: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  pool: 'So11111111111111111111111111111111111111112',
  creator: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  nonceAccount: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  metadataUri: 'https://forge.example/api/coin-meta/moonpad',
};

describe('JobOwnerTxDetails (jobs.owner_tx_details)', () => {
  it('keeps the five launch accounts and drops anything else the signer adds', () => {
    expect(
      JobOwnerTxDetails.parse({
        ...details,
        expectedTokensOut: '123',
        minimumTokensOut: '100',
        referral: 'none',
      }),
    ).toEqual(details);
  });

  it('refuses missing accounts, invalid addresses and a non-https metadata URI', () => {
    const bad = (over: Record<string, unknown>) =>
      JobOwnerTxDetails.safeParse({ ...details, ...over }).success;
    for (const key of Object.keys(details)) expect(bad({ [key]: undefined }), key).toBe(false);
    expect(bad({ creator: 'not-an-address' })).toBe(false);
    expect(bad({ nonceAccount: '' })).toBe(false);
    expect(bad({ pool: 42 })).toBe(false);
    expect(bad({ metadataUri: 'http://forge.example/api/coin-meta/moonpad' })).toBe(false);
    expect(bad({ metadataUri: 'moonpad.json' })).toBe(false);
    expect(JobOwnerTxDetails.safeParse(null).success).toBe(false);
  });

  it('fills the launch accounts the browser pins, with the mint of the launchpad row', () => {
    const stored = JobOwnerTxDetails.parse(details);
    const mint = 'Dr1ftZrJ3rWuSyMBkQd9ZtDwvS8nGXCP2G4ZbGfcHLte';
    expect(OwnerTransactionLaunch.parse({ ...stored, mint })).toEqual({
      config: details.config,
      mint,
      creator: details.creator,
      nonceAccount: details.nonceAccount,
      metadataUri: details.metadataUri,
    });
  });
});

describe('isSiteHost (launchpads.site_host)', () => {
  it('accepts lowercase host names and one label under vercel.app', () => {
    for (const host of [
      'lp-moonpad.vercel.app',
      'lp-moonpad-forge-team.vercel.app',
      'moonpad.forge-sites.app',
      'a.b.example.com',
    ]) {
      expect(isSiteHost(host), host).toBe(true);
      expect(SiteHost.safeParse(host).success, host).toBe(true);
    }
  });

  it('refuses schemes, ports, paths, upper case, trailing dots and nested vercel.app names', () => {
    for (const value of [
      '',
      'vercel.app',
      'a.b.vercel.app',
      'https://lp-moonpad.vercel.app',
      'lp-moonpad.vercel.app:443',
      'lp-moonpad.vercel.app/',
      'LP-moonpad.vercel.app',
      'lp-moonpad.vercel.app.',
      '-lp.vercel.app',
      'lp-.vercel.app',
      'localhost',
      '127.0.0.1',
      `${'a'.repeat(64)}.vercel.app`,
      'lp moonpad.vercel.app',
      42,
      null,
    ]) {
      expect(isSiteHost(value), String(value)).toBe(false);
    }
  });

  it('tells vercel.app hosts apart', () => {
    expect(isVercelAppHost('lp-moonpad.vercel.app')).toBe(true);
    expect(isVercelAppHost('moonpad.forge-sites.app')).toBe(false);
    expect(isVercelAppHost('a.b.vercel.app')).toBe(false);
    expect(isVercelAppHost('lp-moonpad.vercel.app.evil.com')).toBe(false);
  });
});
