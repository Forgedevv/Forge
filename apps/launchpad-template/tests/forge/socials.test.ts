import { describe, expect, it } from 'vitest';
import { canonicalXUrl, parseXLink, xHandle } from '@/forge/socials';

describe('parseXLink', () => {
  it('treats an empty field as no link', () => {
    expect(parseXLink('')).toEqual({ ok: true, url: null });
    expect(parseXLink('   ')).toEqual({ ok: true, url: null });
  });

  it('normalises handles and x.com / twitter.com profile links', () => {
    for (const raw of [
      'moon_coin',
      '@moon_coin',
      ' moon_coin ',
      'x.com/moon_coin',
      'www.x.com/moon_coin',
      'twitter.com/moon_coin',
      'https://x.com/moon_coin',
      'https://x.com/moon_coin/',
      'https://twitter.com/moon_coin',
      'https://www.twitter.com/moon_coin?s=21',
      'https://mobile.twitter.com/moon_coin#top',
      'http://x.com/moon_coin',
      'HTTPS://X.COM/moon_coin',
    ]) {
      expect(parseXLink(raw)).toEqual({ ok: true, url: 'https://x.com/moon_coin' });
    }
    expect(parseXLink('A')).toEqual({ ok: true, url: 'https://x.com/A' });
    expect(parseXLink('a'.repeat(15))).toEqual({ ok: true, url: `https://x.com/${'a'.repeat(15)}` });
  });

  it('refuses anything that is not an X profile', () => {
    for (const raw of [
      '@',
      'a'.repeat(16),
      'moon-coin',
      'moon coin',
      'https://x.com/',
      'https://x.com/moon_coin/status/123',
      'https://x.com//moon_coin',
      'https://x.com/@moon_coin',
      'https://x.com.evil.example/moon_coin',
      'https://evil.example/x.com/moon_coin',
      'https://user:pass@x.com/moon_coin',
      'https://x.com:8443/moon_coin',
      'ftp://x.com/moon_coin',
      'javascript:alert(1)',
      'https://t.me/moon_coin',
      `https://x.com/${'a'.repeat(300)}`,
    ]) {
      expect(parseXLink(raw)).toEqual({ ok: false });
    }
  });
});

describe('canonicalXUrl', () => {
  it('accepts exactly https://x.com/<handle>', () => {
    expect(canonicalXUrl('https://x.com/moon_coin')).toBe('https://x.com/moon_coin');
    for (const value of [
      undefined,
      null,
      42,
      '',
      'https://twitter.com/moon_coin',
      'http://x.com/moon_coin',
      'https://x.com/moon_coin/',
      'https://x.com/moon_coin?x=1',
      'https://x.com/moon-coin',
      ' https://x.com/moon_coin',
      'https://x.com/moon_coin\n',
      'javascript:alert(1)//https://x.com/a',
    ]) {
      expect(canonicalXUrl(value)).toBeNull();
    }
  });

  it('gives the handle of a canonical link only', () => {
    expect(xHandle('https://x.com/moon_coin')).toBe('moon_coin');
    expect(xHandle('https://twitter.com/moon_coin')).toBeNull();
  });
});
