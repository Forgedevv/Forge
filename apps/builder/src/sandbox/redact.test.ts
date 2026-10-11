import { describe, expect, it } from 'vitest';
import {
  capText,
  createRedactor,
  OutputCollector,
  REDACTED,
  stripControl,
  TRUNCATION_MARGIN,
} from './redact.js';

const TOKEN = `forge_gw_${'Q'.repeat(43)}`;
const PACKAGES = `ghp_${'z'.repeat(36)}`;
const VERCEL = 'vercelExactValue987654';

describe('createRedactor', () => {
  const redact = createRedactor([TOKEN, PACKAGES, VERCEL, undefined, 'abc']);

  it('redacts exact values and their common encodings', () => {
    const b64 = Buffer.from(VERCEL).toString('base64');
    const hex = Buffer.from(VERCEL).toString('hex');
    const out = redact(`a ${VERCEL} b ${b64} c ${hex} d ${encodeURIComponent(VERCEL)}`);
    expect(out).not.toContain(VERCEL);
    expect(out).not.toContain(b64.replace(/=+$/, ''));
    expect(out).not.toContain(hex);
    expect(out.split(REDACTED).length - 1).toBe(4);
  });

  it('redacts well-known secret formats', () => {
    const samples = [
      'forge_gw_someOtherTokenNotGiven123',
      'sk-ant-api03-AbCdEf0123456789',
      `ghs_${'x'.repeat(36)}`,
      `github_pat_${'y'.repeat(60)}`,
      `npm_${'n'.repeat(36)}`,
      'sb_secret_abcdefghij123',
      'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl',
      'AKIAABCDEFGHIJKLMNOP',
      '1234567890:AAH9xYzAbCdEfGhIjKlMnOpQrStUvWxYz12',
    ];
    for (const s of samples) expect(redact(`x ${s} y`), s).toBe(`x ${REDACTED} y`);
    expect(redact('-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----')).toBe(
      REDACTED,
    );
    expect(redact('-----BEGIN OPENSSH PRIVATE KEY-----\nabc')).toBe(REDACTED);
  });

  it('redacts credentials in headers, npmrc lines and URLs', () => {
    expect(redact('Authorization: Bearer abc.def')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redact('x-api-key: something')).toBe(`x-api-key: ${REDACTED}`);
    expect(redact('//npm.pkg.github.com/:_authToken=whatever')).toBe(
      `//npm.pkg.github.com/:_authToken=${REDACTED}`,
    );
    expect(redact('git clone https://user:pass@github.com/x')).toBe(
      `git clone https://${REDACTED}@github.com/x`,
    );
  });

  it('strips terminal control sequences', () => {
    expect(stripControl('\u001b[31mred\u001b[0m\r\nnext\u0007\u0000')).toBe('red\nnext');
    expect(stripControl('\u001b]0;title\u0007ok')).toBe('ok');
    // A secret split by control characters is still found.
    expect(redact(`${TOKEN.slice(0, 20)}\u0000${TOKEN.slice(20)}`)).toBe(REDACTED);
  });

  it('ignores very short secrets', () => {
    expect(redact('abc abd')).toBe('abc abd');
  });
});

describe('OutputCollector', () => {
  const redact = createRedactor([VERCEL]);

  it('keeps short output whole', () => {
    const c = new OutputCollector(1024);
    c.push(Buffer.from('hello '));
    c.push(Buffer.from(`${VERCEL}\n`));
    expect(c.truncated).toBe(false);
    expect(c.text(redact)).toBe(`hello ${REDACTED}\n`);
    expect(c.totalBytes).toBe(6 + VERCEL.length + 1);
  });

  it('keeps head and tail within the cap and counts everything', () => {
    const c = new OutputCollector(1000);
    c.push(Buffer.from('HEAD-'));
    for (let i = 0; i < 1000; i += 1) c.push(Buffer.from('m'.repeat(100)));
    c.push(Buffer.from('-TAIL'));
    expect(c.truncated).toBe(true);
    expect(c.totalBytes).toBe(5 + 100_000 + 5);
    const text = c.text(redact);
    expect(text.startsWith('HEAD-')).toBe(true);
    expect(text.endsWith('-TAIL')).toBe(true);
    expect(text).toContain('bytes omitted');
    expect(text.length).toBeLessThan(1100);
  });

  it('never shows part of a secret cut by the truncation', () => {
    const max = 2000;
    const headLimit = Math.ceil(max / 2) + TRUNCATION_MARGIN;
    for (const offset of [-VERCEL.length + 1, -5, -1, 0]) {
      const c = new OutputCollector(max);
      // A secret straddling the end of the kept head.
      c.push(Buffer.from('h'.repeat(headLimit + offset)));
      c.push(Buffer.from(VERCEL));
      c.push(Buffer.from('m'.repeat(50_000)));
      // A secret straddling the start of the kept tail.
      c.push(Buffer.from(VERCEL));
      c.push(Buffer.from('t'.repeat(Math.floor(max / 2) + TRUNCATION_MARGIN - 3)));
      const text = c.text(redact);
      for (let n = 4; n < VERCEL.length; n += 1) {
        expect(text, `offset ${offset}, prefix ${n}`).not.toContain(VERCEL.slice(0, n));
        expect(text, `offset ${offset}, suffix ${n}`).not.toContain(VERCEL.slice(-n));
      }
    }
  });

  it('caps text', () => {
    expect(capText('abcdef', 10)).toBe('abcdef');
    const capped = capText('a'.repeat(50) + 'b'.repeat(50), 20);
    expect(capped.startsWith('a'.repeat(10))).toBe(true);
    expect(capped.endsWith('b'.repeat(10))).toBe(true);
  });
});
