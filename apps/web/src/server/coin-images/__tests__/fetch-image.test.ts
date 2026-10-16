// @vitest-environment node
import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import {
  fetchPublicImage,
  ImageFetchError,
  MAX_BYTES,
  pinnedLookup,
  USER_AGENT,
  type FetchImageOptions,
  type ImageFetchFailure,
} from '../fetch-image';
import {
  fakeResolver,
  fakeTransport,
  jpegBytes,
  pngBytes,
  PUBLIC_V4,
  type FakeReply,
} from './fakes';

const URL_A = 'https://images.example.com/moon.png';
const PNG_OK: FakeReply = {
  status: 200,
  headers: { 'content-type': 'image/png' },
  body: pngBytes(),
};

function setup(
  replies: Record<string, FakeReply>,
  dns: Record<string, string[]> = { 'images.example.com': [PUBLIC_V4] },
  extra: Partial<FetchImageOptions> = {},
) {
  const resolve = fakeResolver(dns);
  const transport = fakeTransport(replies);
  return {
    resolve,
    transport,
    fetch: (url = URL_A) => fetchPublicImage(url, { resolve, transport, ...extra }),
  };
}

async function failure(promise: Promise<unknown>): Promise<ImageFetchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImageFetchError) return error;
    throw error;
  }
  throw new Error('expected an ImageFetchError');
}

async function reason(promise: Promise<unknown>): Promise<ImageFetchFailure> {
  return (await failure(promise)).reason;
}

describe('fetchPublicImage', () => {
  it('downloads a PNG over a connection pinned to the checked address', async () => {
    const t = setup({ [URL_A]: PNG_OK });
    const image = await t.fetch();
    expect(image.contentType).toBe('image/png');
    expect(image.bytes).toEqual(pngBytes());
    expect(t.resolve.calls).toEqual(['images.example.com']);
    expect(t.transport.calls).toHaveLength(1);
    const [call] = t.transport.calls;
    expect(call?.address).toEqual({ address: PUBLIC_V4, family: 4 });
    expect(call?.headers['User-Agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/FORGE/);
    expect(call?.headers['Accept-Encoding']).toBe('identity');
  });

  it('prefers an IPv4 address when the host has both families', async () => {
    const t = setup({ [URL_A]: PNG_OK }, { 'images.example.com': ['2606:4700::1111', PUBLIC_V4] });
    await t.fetch();
    expect(t.transport.calls[0]?.address).toEqual({ address: PUBLIC_V4, family: 4 });
  });

  it('detects the type from the bytes when the server sends a generic type or none', async () => {
    const generic = setup({
      [URL_A]: {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: jpegBytes(),
      },
    });
    expect((await generic.fetch()).contentType).toBe('image/jpeg');
    const none = setup({ [URL_A]: { status: 200, body: pngBytes() } });
    expect((await none.fetch()).contentType).toBe('image/png');
    const alias = setup({
      [URL_A]: { status: 200, headers: { 'content-type': 'image/jpg' }, body: jpegBytes() },
    });
    expect((await alias.fetch()).contentType).toBe('image/jpeg');
  });

  it('follows up to three redirects, each one checked', async () => {
    const hops = [
      'https://images.example.com/moon.png',
      'https://cdn-1.example.net/a',
      'https://cdn-2.example.net/b',
      'https://cdn-3.example.net/c.png',
    ];
    const replies: Record<string, FakeReply> = {};
    hops.slice(0, -1).forEach((hop, i) => {
      replies[hop] = { status: i === 1 ? 302 : 301, headers: { location: hops[i + 1]! } };
    });
    replies[hops[3]!] = PNG_OK;
    const t = setup(replies, {
      'images.example.com': [PUBLIC_V4],
      'cdn-1.example.net': ['1.1.1.1'],
      'cdn-2.example.net': ['8.8.8.8'],
      'cdn-3.example.net': ['9.9.9.9'],
    });
    expect((await t.fetch()).contentType).toBe('image/png');
    expect(t.resolve.calls).toEqual([
      'images.example.com',
      'cdn-1.example.net',
      'cdn-2.example.net',
      'cdn-3.example.net',
    ]);
    expect(t.transport.calls.map((c) => c.address.address)).toEqual([
      PUBLIC_V4,
      '1.1.1.1',
      '8.8.8.8',
      '9.9.9.9',
    ]);
    // Every redirect response was closed without reading its body.
    expect(t.transport.discarded).toBe(3);
  });

  it('resolves a relative redirect against the current URL', async () => {
    const t = setup({
      [URL_A]: { status: 307, headers: { location: '/v2/moon.png' } },
      'https://images.example.com/v2/moon.png': PNG_OK,
    });
    await t.fetch();
    expect(t.transport.calls.map((c) => c.url)).toEqual([
      URL_A,
      'https://images.example.com/v2/moon.png',
    ]);
  });

  it('refuses a fourth redirect', async () => {
    const replies: Record<string, FakeReply> = {};
    for (let i = 0; i < 5; i++) {
      replies[`https://images.example.com/${i}`] = {
        status: 302,
        headers: { location: `https://images.example.com/${i + 1}` },
      };
    }
    const t = setup(replies);
    expect(await reason(t.fetch('https://images.example.com/0'))).toBe('too_many_redirects');
    expect(t.transport.calls).toHaveLength(4);
  });

  it.each([
    ['10.0.0.8'],
    ['127.0.0.1'],
    ['169.254.169.254'],
    ['100.64.1.2'],
    ['172.20.0.3'],
    ['192.168.1.1'],
    ['224.0.0.1'],
    ['0.0.0.0'],
    ['::1'],
    ['fd00:ec2::254'],
    ['fe80::1'],
    ['::ffff:127.0.0.1'],
  ])('refuses a host resolving to %s, before any connection', async (address) => {
    const t = setup({ [URL_A]: PNG_OK }, { 'images.example.com': [address] });
    expect(await reason(t.fetch())).toBe('blocked_address');
    expect(t.transport.calls).toHaveLength(0);
  });

  it('refuses a host when any one of its addresses is private', async () => {
    const t = setup({ [URL_A]: PNG_OK }, { 'images.example.com': [PUBLIC_V4, '10.1.2.3'] });
    expect(await reason(t.fetch())).toBe('blocked_address');
    expect(t.transport.calls).toHaveLength(0);
  });

  it('refuses a redirect to a host resolving to a private address', async () => {
    const t = setup(
      {
        [URL_A]: { status: 302, headers: { location: 'https://evil.example.org/meta' } },
        'https://evil.example.org/meta': PNG_OK,
      },
      { 'images.example.com': [PUBLIC_V4], 'evil.example.org': ['169.254.169.254'] },
    );
    expect(await reason(t.fetch())).toBe('blocked_address');
    expect(t.transport.calls.map((c) => c.url)).toEqual([URL_A]);
  });

  it.each([
    ['http downgrade', 'http://images.example.com/moon.png'],
    ['IP literal', 'https://169.254.169.254/latest/meta-data'],
    ['IPv6 literal', 'https://[::1]/x.png'],
    ['numeric host', 'https://2130706433/x.png'],
    ['localhost', 'https://localhost/x.png'],
    ['local name', 'https://printer.local/x.png'],
    ['explicit port', 'https://images.example.com:8443/x.png'],
    ['credentials', 'https://user:pass@images.example.com/x.png'],
    ['other scheme', 'file:///etc/passwd'],
  ])('refuses a redirect target that is not a public https URL: %s', async (_label, target) => {
    const t = setup({ [URL_A]: { status: 301, headers: { location: target } } });
    expect(await reason(t.fetch())).toBe('redirect');
    expect(t.transport.calls).toHaveLength(1);
  });

  it('refuses a redirect without a Location', async () => {
    const t = setup({ [URL_A]: { status: 302 } });
    expect(await reason(t.fetch())).toBe('redirect');
  });

  it.each([
    ['http', 'http://images.example.com/moon.png'],
    ['IP literal', 'https://8.8.8.8/moon.png'],
    ['not a URL', 'moon.png'],
  ])('refuses a first URL that is not a public https URL: %s', async (_label, url) => {
    const t = setup({ [url]: PNG_OK });
    expect(await reason(t.fetch(url))).toBe('invalid_url');
    expect(t.resolve.calls).toHaveLength(0);
  });

  it('reports a host that does not resolve', async () => {
    const t = setup({}, {});
    expect(await reason(t.fetch())).toBe('dns');
  });

  it('refuses an HTTP error status', async () => {
    const t = setup({ [URL_A]: { status: 400, headers: { 'content-type': 'text/html' } } });
    const error = await failure(t.fetch());
    expect(error.reason).toBe('http_status');
    expect(error.status).toBe(400);
  });

  it('refuses a declared Content-Length above the cap without reading the body', async () => {
    const t = setup({
      [URL_A]: {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(MAX_BYTES + 1) },
        body: pngBytes(),
      },
    });
    expect(await reason(t.fetch())).toBe('too_large');
    expect(t.transport.discarded).toBe(1);
  });

  it('stops reading a streamed body as soon as it passes the cap', async () => {
    const chunk = pngBytes(1024 * 1024);
    const t = setup({
      [URL_A]: {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: Array(6).fill(chunk),
      },
    });
    expect(await reason(t.fetch())).toBe('too_large');
    expect(t.transport.discarded).toBe(1);
  });

  it('accepts an image of exactly the cap', async () => {
    const t = setup({
      [URL_A]: { status: 200, headers: { 'content-type': 'image/png' }, body: pngBytes(MAX_BYTES) },
    });
    expect((await t.fetch()).bytes.byteLength).toBe(MAX_BYTES);
  });

  it('refuses bytes that are not a PNG, JPEG, WebP or GIF', async () => {
    const html = new TextEncoder().encode('<html><body>not an image</body></html>');
    const t = setup({
      [URL_A]: { status: 200, headers: { 'content-type': 'image/png' }, body: html },
    });
    expect(await reason(t.fetch())).toBe('not_an_image');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const generic = setup({ [URL_A]: { status: 200, body: svg } });
    expect(await reason(generic.fetch())).toBe('not_an_image');
  });

  it('refuses bytes that do not match the declared image type', async () => {
    const t = setup({
      [URL_A]: { status: 200, headers: { 'content-type': 'image/png' }, body: jpegBytes() },
    });
    expect(await reason(t.fetch())).toBe('not_an_image');
  });

  it('refuses a declared type that is not an accepted image before reading', async () => {
    for (const type of ['text/html; charset=utf-8', 'image/svg+xml', 'image/avif']) {
      const t = setup({
        [URL_A]: { status: 200, headers: { 'content-type': type }, body: pngBytes() },
      });
      expect(await reason(t.fetch())).toBe('unsupported_type');
    }
  });

  it('gives up at the deadline', async () => {
    const t = setup({ [URL_A]: { status: 200, hang: true } }, undefined, { timeoutMs: 20 });
    expect(await reason(t.fetch())).toBe('timeout');
  });

  it('reports a connection failure as a network error', async () => {
    const t = setup({});
    expect(await reason(t.fetch())).toBe('network');
  });

  it('never puts the URL in its error', async () => {
    const t = setup({ [URL_A]: { status: 404 } });
    const error = await failure(t.fetch('https://images.example.com/moon.png?token=s3cr3t'));
    expect(error.message).not.toContain('s3cr3t');
    expect(error.message).not.toContain('example');
  });
});

describe('pinnedLookup', () => {
  it('answers the pinned address whatever the host name, in both callback styles', () => {
    const lookup = pinnedLookup({ address: PUBLIC_V4, family: 4 });
    const single: unknown[] = [];
    lookup('rebind.example.com', {}, (err, address, family) => single.push(err, address, family));
    expect(single).toEqual([null, PUBLIC_V4, 4]);
    const all: unknown[] = [];
    lookup('rebind.example.com', { all: true }, (err, addresses) => all.push(err, addresses));
    expect(all).toEqual([null, [{ address: PUBLIC_V4, family: 4 } satisfies LookupAddress]]);
  });
});
