import { describe, expect, it } from 'vitest';
import { chooseSiteHost, type SiteHostInput } from './site-host.js';

const DOMAIN = 'forge-sites.app';
const unverified = { domain: 'moonpad.forge-sites.app', verified: false };
const verified = { domain: 'moonpad.forge-sites.app', verified: true };

const choose = (input: Omit<SiteHostInput, 'clientsDomain'> & { clientsDomain?: string }) =>
  chooseSiteHost({ clientsDomain: DOMAIN, ...input });

describe('chooseSiteHost', () => {
  it('prefers the client subdomain once Vercel verified it', () => {
    expect(
      choose({
        slug: 'moonpad',
        subdomain: verified,
        productionHosts: ['lp-moonpad.vercel.app'],
      }),
    ).toBe('moonpad.forge-sites.app');
  });

  it('falls back to the project alias while the subdomain is not verified (devnet beta)', () => {
    expect(
      choose({
        slug: 'moonpad',
        subdomain: unverified,
        productionHosts: [
          'lp-moonpad-forge-team.vercel.app',
          'lp-moonpad.vercel.app',
          'moonpad.forge-sites.app',
        ],
      }),
    ).toBe('lp-moonpad.vercel.app');
    expect(
      choose({
        slug: 'moonpad',
        subdomain: null,
        productionHosts: ['lp-moonpad.vercel.app'],
      }),
    ).toBe('lp-moonpad.vercel.app');
  });

  it('takes the shortest lp-<slug>-* alias when lp-<slug>.vercel.app went to someone else', () => {
    const hosts = [
      'cool-coin.vercel.app',
      'lp-moonpad-forge-team.vercel.app',
      'lp-moonpad-forge.vercel.app',
      'lp-moonpad-abcd.vercel.app',
    ];
    expect(choose({ slug: 'moonpad', subdomain: unverified, productionHosts: hosts })).toBe(
      'lp-moonpad-abcd.vercel.app',
    );
    // Same answer whatever the order Vercel lists them in (re-runs record the same host).
    expect(
      choose({
        slug: 'moonpad',
        subdomain: unverified,
        productionHosts: [...hosts].reverse(),
      }),
    ).toBe('lp-moonpad-abcd.vercel.app');
    expect(
      choose({
        slug: 'moonpad',
        subdomain: unverified,
        productionHosts: ['cool-coin.vercel.app', 'zz-coin.vercel.app', 'aa-coin.vercel.app'],
      }),
    ).toBe('aa-coin.vercel.app');
  });

  it('never records a host that is not ours or not a site host', () => {
    // An unverified subdomain, another slug's subdomain, a vercel.app "subdomain" and custom
    // domains are all ignored.
    expect(
      choose({
        slug: 'moonpad',
        subdomain: unverified,
        productionHosts: ['moonpad.forge-sites.app', 'www.moonpad.com', 'a.b.vercel.app'],
      }),
    ).toBeNull();
    expect(
      choose({
        slug: 'moonpad',
        subdomain: { domain: 'other.forge-sites.app', verified: true },
        productionHosts: [],
      }),
    ).toBeNull();
    expect(
      choose({
        slug: 'moonpad',
        subdomain: { domain: 'moonpad.vercel.app', verified: true },
        productionHosts: [],
      }),
    ).toBeNull();
    expect(
      choose({
        slug: 'moonpad',
        subdomain: { domain: 'moonpad.Forge-Sites.app', verified: true },
        productionHosts: [],
      }),
    ).toBeNull();
    expect(choose({ slug: 'moonpad', subdomain: null, productionHosts: [] })).toBeNull();
  });

  it('only trusts a verified subdomain that is exactly <slug>.<CLIENTS_DOMAIN>', () => {
    // Verified by Vercel, starting with the slug, but under another domain than CLIENTS_DOMAIN.
    for (const domain of [
      'moonpad.evil-sites.app',
      'moonpad.forge-sites.app.evil.test',
      'moonpad.sub.forge-sites.app',
      'moonpad.not-forge-sites.app',
    ]) {
      expect(
        choose({ slug: 'moonpad', subdomain: { domain, verified: true }, productionHosts: [] }),
        domain,
      ).toBeNull();
    }
    // The same subdomain under another configured domain is not the one asked for either.
    expect(
      choose({
        slug: 'moonpad',
        clientsDomain: 'other-sites.app',
        subdomain: verified,
        productionHosts: ['lp-moonpad.vercel.app'],
      }),
    ).toBe('lp-moonpad.vercel.app');
    // An invalid clients domain never makes a subdomain trusted.
    expect(
      choose({
        slug: 'moonpad',
        clientsDomain: 'not a domain',
        subdomain: verified,
        productionHosts: [],
      }),
    ).toBeNull();
  });
});
