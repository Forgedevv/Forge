// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChainReadError } from '../chain';
import {
  COMPLETE_WINDOW_SECONDS,
  TICKET_TTL_SECONDS,
  UPLOAD_RATE_LIMITS,
  UploadHttpError,
  type UploadTicket,
} from '../contract';
import { SlidingWindowLimiter } from '../rate-limit';
import { createUploadService, toUploadHttpError } from '../service';
import type { TicketRecord } from '../store';
import {
  BUCKET,
  CLIENTS_DOMAIN,
  ENDPOINT,
  freshNonce,
  harness,
  LIVE,
  newWallet,
  pngBytes,
  PUBLIC_BASE,
  putImage,
  sha256Hex,
  signedRequest,
  T0,
  type Harness,
} from './helpers';

async function issueError(promise: Promise<unknown>): Promise<UploadHttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UploadHttpError) return error;
    throw error;
  }
  throw new Error('expected an UploadHttpError');
}

/** The checks the v1 client (apps/launchpad-template upload-client.ts) applies to a ticket. */
const ClientPutHeaders = z
  .object({
    'content-type': z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    'if-none-match': z.literal('*'),
    'x-amz-checksum-sha256': z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    'cache-control': z.string().max(100).optional(),
  })
  .strict();

function assertClientAccepts(ticket: UploadTicket, mint: string, sha256: string, now: number) {
  expect(ticket.uploadId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(Date.parse(ticket.expiresAt) - now).toBeGreaterThanOrEqual(15_000);
  expect(z.string().datetime().safeParse(ticket.expiresAt).success).toBe(true);
  const lower = Object.fromEntries(
    Object.entries(ticket.image.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  expect(ClientPutHeaders.safeParse(lower).success).toBe(true);
  expect(lower['x-amz-checksum-sha256']).toBe(Buffer.from(sha256, 'hex').toString('base64'));
  for (const url of [ticket.image.publicUrl, ticket.metadata.publicUrl]) {
    expect(url).toContain(mint);
    expect(url.startsWith(`${PUBLIC_BASE}/`)).toBe(true);
  }
  expect(Buffer.byteLength(ticket.metadata.publicUrl)).toBeLessThanOrEqual(200);
  expect(new URL(ticket.image.uploadUrl).protocol).toBe('https:');
}

describe('issue a ticket', () => {
  it('returns a presigned write-once PUT, size signed, on the staging key', async () => {
    const h = harness();
    const request = signedRequest();
    const ticket = await h.service.issue('moonpad', request);

    assertClientAccepts(ticket, request.mint, request.image.sha256, T0);
    expect(ticket.image.method).toBe('PUT');
    expect(ticket.expiresAt).toBe(new Date(T0 + TICKET_TTL_SECONDS * 1000).toISOString());
    expect(ticket.image.headers).toEqual({
      'Content-Type': 'image/png',
      'If-None-Match': '*',
      'x-amz-checksum-sha256': Buffer.from(request.image.sha256, 'hex').toString('base64'),
    });
    const url = new URL(ticket.image.uploadUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${ENDPOINT}/${BUCKET}/pending/moonpad/${request.mint}.png`,
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(TICKET_TTL_SECONDS));
    // Content-Length is signed (R2 refuses another size) but not listed: the body sets it.
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match;x-amz-checksum-sha256',
    );
    expect(ticket.image.publicUrl).toBe(
      `${PUBLIC_BASE}/launchpads/moonpad/images/${request.mint}.png`,
    );
    expect(ticket.metadata.publicUrl).toBe(
      `${PUBLIC_BASE}/launchpads/moonpad/metadata/${request.mint}.json`,
    );

    const stored = h.store.tickets.get(ticket.uploadId)!;
    expect(stored).toMatchObject({
      launchpadId: LIVE.id,
      wallet: request.wallet,
      nonce: request.auth.nonce,
      mint: request.mint,
      status: 'issued',
      imageSize: 1024,
    });
    expect(h.mintChecks).toEqual([request.mint]);
    // No storage call at issue time.
    expect(h.r2.calls).toEqual([]);
  });

  it('accepts the launchpad uuid as well as its slug', async () => {
    const h = harness();
    const ticket = await h.service.issue(LIVE.id.toUpperCase(), signedRequest());
    expect(ticket.image.publicUrl).toContain('/launchpads/moonpad/images/');
  });

  it('maps every image type to its extension', async () => {
    const h = harness();
    const jpeg = await h.service.issue('moonpad', signedRequest({ contentType: 'image/jpeg' }));
    expect(jpeg.image.publicUrl).toMatch(/\.jpg$/);
    const webp = await h.service.issue('moonpad', signedRequest({ contentType: 'image/webp' }));
    expect(webp.image.publicUrl).toMatch(/\.webp$/);
  });

  describe('idempotency of (wallet, nonce)', () => {
    it('answers an identical retry with the very same ticket, even minutes later', async () => {
      const h = harness();
      const request = signedRequest();
      const first = await h.service.issue('moonpad', request);
      h.clock.now += 3 * 60_000;
      const again = await h.service.issue('moonpad', structuredClone(request));
      expect(again).toEqual(first);
      expect(h.store.tickets.size).toBe(1);
    });

    it('refuses another body with the same nonce (409), e.g. another mint', async () => {
      const h = harness();
      const wallet = newWallet();
      const nonce = freshNonce();
      await h.service.issue('moonpad', signedRequest({ wallet, nonce }));
      const replay = signedRequest({ wallet, nonce });
      const error = await issueError(h.service.issue('moonpad', replay));
      expect(error.status).toBe(409);
      expect(error.code).toBe('NONCE_USED');
      expect(h.store.tickets.size).toBe(1);
    });

    it('resolves two concurrent identical requests to one ticket', async () => {
      const h = harness();
      const request = signedRequest();
      const [a, b] = await Promise.all([
        h.service.issue('moonpad', request),
        h.service.issue('moonpad', structuredClone(request)),
      ]);
      expect(a).toEqual(b);
      expect(h.store.tickets.size).toBe(1);
    });

    it('keeps the nonce consumed across server instances (durable store)', async () => {
      const h = harness();
      const wallet = newWallet();
      const nonce = freshNonce();
      await h.service.issue('moonpad', signedRequest({ wallet, nonce }));
      const other = createUploadService({
        store: h.store,
        storage: {
          presignPut: () => ({ url: 'https://x.example/a', headers: {} }),
          get: async () => null,
          putIfAbsent: async () => 'created',
          delete: async () => undefined,
          publicUrl: (key) => `${PUBLIC_BASE}/${key}`,
        },
        clientsDomain: CLIENTS_DOMAIN,
        mintChecker: null,
        now: () => h.clock.now,
      });
      const error = await issueError(
        other.issue('moonpad', signedRequest({ wallet, nonce }), { serverSlug: 'moonpad' }),
      );
      expect(error.code).toBe('NONCE_USED');
    });
  });

  describe('wallet signature', () => {
    it('refuses a signature over other values (401 BAD_SIGNATURE)', async () => {
      const h = harness();
      for (const signOverride of [
        { name: 'Other Coin' },
        { symbol: 'RUG' },
        { firstBuyLamports: '1' },
        { imageSha256: sha256Hex('other image') },
        { descriptionSha256: sha256Hex('other text') },
        { host: `rugpad.${CLIENTS_DOMAIN}` },
        { issuedAt: new Date(T0 - 1000).toISOString() },
      ]) {
        const error = await issueError(h.service.issue('moonpad', signedRequest({ signOverride })));
        expect(error.status).toBe(401);
        expect(error.code).toBe('BAD_SIGNATURE');
      }
      expect(h.store.tickets.size).toBe(0);
    });

    it('refuses a signature by another wallet and malformed signatures', async () => {
      const h = harness();
      const request = signedRequest();
      const forged = { ...request, wallet: newWallet().address };
      expect((await issueError(h.service.issue('moonpad', forged))).code).toBe('BAD_SIGNATURE');
      const garbled = { ...request, auth: { ...request.auth, signature: 'A'.repeat(86) + '==' } };
      expect((await issueError(h.service.issue('moonpad', garbled))).code).toBe('BAD_SIGNATURE');
      const short = { ...request, auth: { ...request.auth, signature: 'abc' } };
      expect((await issueError(h.service.issue('moonpad', short))).code).toBe('BAD_SIGNATURE');
    });

    it('enforces the 5 minute TTL and 60 second skew', async () => {
      const h = harness();
      const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
      // Issued 5 minutes ago: still valid. 5 minutes and 1 second: expired.
      await h.service.issue('moonpad', signedRequest({ issuedAt: at(-5 * 60_000) }));
      let error = await issueError(
        h.service.issue('moonpad', signedRequest({ issuedAt: at(-5 * 60_000 - 1000) })),
      );
      expect([error.status, error.code]).toEqual([401, 'AUTH_EXPIRED']);
      // 60 seconds ahead: accepted. 61 seconds: refused.
      await h.service.issue('moonpad', signedRequest({ issuedAt: at(60_000) }));
      error = await issueError(h.service.issue('moonpad', signedRequest({ issuedAt: at(61_000) })));
      expect(error.code).toBe('AUTH_EXPIRED');
      error = await issueError(
        h.service.issue('moonpad', signedRequest({ issuedAt: '2026-10-11T12:00:00+00:00' })),
      );
      expect(error.code).toBe('AUTH_EXPIRED');
    });

    it('refuses an identical retry once the signature expired', async () => {
      const h = harness();
      const request = signedRequest();
      await h.service.issue('moonpad', request);
      h.clock.now += 5 * 60_000 + 1000;
      expect((await issueError(h.service.issue('moonpad', request))).code).toBe('AUTH_EXPIRED');
    });
  });

  describe('launchpad and host', () => {
    it('accepts only the launchpad domain as the signed host (403 HOST_MISMATCH)', async () => {
      const h = harness();
      h.store.addLaunchpad({ ...LIVE, id: '00000000-0000-4000-8000-000000000002', slug: 'rugpad' });
      for (const host of [
        `rugpad.${CLIENTS_DOMAIN}`,
        `MOONPAD.${CLIENTS_DOMAIN}`,
        `moonpad.${CLIENTS_DOMAIN}:443`,
        `moonpad.${CLIENTS_DOMAIN}.evil.com`,
        `evil.moonpad.${CLIENTS_DOMAIN}`,
        'moonpad.vercel.app',
        'localhost:3000',
      ]) {
        const error = await issueError(h.service.issue('moonpad', signedRequest({ host })));
        expect([error.status, error.code, host]).toEqual([403, 'HOST_MISMATCH', host]);
      }
      // The same signature on the right launchpad works.
      await h.service.issue('rugpad', signedRequest({ host: `rugpad.${CLIENTS_DOMAIN}` }));
    });

    describe('recorded site host (launchpads.site_host)', () => {
      const SITE_HOST = 'lp-moonpad.vercel.app';
      const OTHER_ID = '00000000-0000-4000-8000-000000000002';

      it('accepts the exact host recorded for this launchpad', async () => {
        const h = harness();
        h.store.addLaunchpad({ ...LIVE, siteHost: SITE_HOST });
        const ticket = await h.service.issue('moonpad', signedRequest({ host: SITE_HOST }));
        expect(ticket.uploadId).toMatch(/^[A-Za-z0-9_-]+$/);
        expect([...h.store.tickets.values()][0]?.host).toBe(SITE_HOST);
        // The subdomain keeps working next to it.
        await h.service.issue('moonpad', signedRequest({ host: `moonpad.${CLIENTS_DOMAIN}` }));
      });

      it('works without CLIENTS_DOMAIN (devnet beta)', async () => {
        const h = harness({ clientsDomain: null });
        h.store.addLaunchpad({ ...LIVE, siteHost: SITE_HOST });
        await h.service.issue('moonpad', signedRequest({ host: SITE_HOST }));
        // Anything else is a mismatch, no longer "not configured".
        const error = await issueError(
          h.service.issue('moonpad', signedRequest({ host: `moonpad.${CLIENTS_DOMAIN}` })),
        );
        expect([error.status, error.code]).toEqual([403, 'HOST_MISMATCH']);
      });

      it('refuses look-alikes and a host recorded for another launchpad', async () => {
        const h = harness();
        h.store.addLaunchpad({ ...LIVE, siteHost: SITE_HOST });
        h.store.addLaunchpad({
          ...LIVE,
          id: OTHER_ID,
          slug: 'rugpad',
          siteHost: 'lp-rugpad.vercel.app',
        });
        for (const host of [
          'lp-moonpad-evil.vercel.app',
          'lp-moonpad-forge.vercel.app',
          'x.lp-moonpad.vercel.app',
          'lp-moonpad.vercel.app.evil.com',
          'LP-MOONPAD.vercel.app',
          'lp-moonpad.vercel.app:443',
          'lp-moonpad.vercel.app.',
          'lp-rugpad.vercel.app',
        ]) {
          const error = await issueError(h.service.issue('moonpad', signedRequest({ host })));
          expect([error.status, error.code, host]).toEqual([403, 'HOST_MISMATCH', host]);
        }
        // moonpad's host is refused for rugpad, which accepts its own.
        const error = await issueError(
          h.service.issue('rugpad', signedRequest({ host: SITE_HOST })),
        );
        expect([error.status, error.code]).toEqual([403, 'HOST_MISMATCH']);
        await h.service.issue('rugpad', signedRequest({ host: 'lp-rugpad.vercel.app' }));
      });

      // Before: any well-formed recorded host was accepted as auth.host.
      it('ignores a recorded host the launchpad cannot have, however well formed', async () => {
        for (const siteHost of [
          'evil.example',
          `rugpad.${CLIENTS_DOMAIN}`,
          'moonpad.evil.example',
        ]) {
          const h = harness();
          h.store.addLaunchpad({ ...LIVE, siteHost });
          const error = await issueError(
            h.service.issue('moonpad', signedRequest({ host: siteHost })),
          );
          expect([error.status, error.code, siteHost]).toEqual([403, 'HOST_MISMATCH', siteHost]);
          // The launchpad's own subdomain still works.
          await h.service.issue('moonpad', signedRequest({ host: `moonpad.${CLIENTS_DOMAIN}` }));
        }
        // Without CLIENTS_DOMAIN such a host does not count as configured either.
        const h = harness({ clientsDomain: null });
        h.store.addLaunchpad({ ...LIVE, siteHost: 'evil.example' });
        const error = await issueError(
          h.service.issue('moonpad', signedRequest({ host: 'evil.example' })),
        );
        expect([error.status, error.code]).toEqual([503, 'NOT_CONFIGURED']);
        // The own subdomain recorded as the host is accepted (it is the subdomain anyway).
        const own = harness();
        own.store.addLaunchpad({ ...LIVE, siteHost: `moonpad.${CLIENTS_DOMAIN}` });
        await own.service.issue('moonpad', signedRequest({ host: `moonpad.${CLIENTS_DOMAIN}` }));
      });

      it('keeps the live rule: a sleeping or disabled launchpad gets no upload', async () => {
        const h = harness();
        for (const status of ['sleeping', 'disabled', 'draft']) {
          h.store.addLaunchpad({ ...LIVE, status, siteHost: SITE_HOST });
          const error = await issueError(
            h.service.issue('moonpad', signedRequest({ host: SITE_HOST })),
          );
          expect([error.status, error.code]).toEqual([403, 'LAUNCHPAD_NOT_LIVE']);
        }
      });
    });

    it('accepts local hosts only when allowed (development)', async () => {
      const h = harness({ allowLocalHosts: true });
      await h.service.issue('moonpad', signedRequest({ host: 'localhost:3001' }));
      await h.service.issue('moonpad', signedRequest({ host: '127.0.0.1:3001' }));
    });

    it('fails closed without CLIENTS_DOMAIN (503)', async () => {
      const h = harness({ clientsDomain: null });
      const error = await issueError(h.service.issue('moonpad', signedRequest()));
      expect([error.status, error.code]).toEqual([503, 'NOT_CONFIGURED']);
    });

    it('refuses unknown launchpads (404) and launchpads that are not live (403)', async () => {
      const h = harness();
      for (const param of ['nopad', '00000000-0000-4000-8000-00000000000f', '../x', 'A']) {
        const error = await issueError(h.service.issue(param, signedRequest()));
        expect([error.status, error.code]).toEqual([404, 'LAUNCHPAD_NOT_FOUND']);
      }
      for (const status of ['draft', 'sleeping', 'disabled']) {
        h.store.addLaunchpad({ ...LIVE, status });
        const error = await issueError(h.service.issue('moonpad', signedRequest()));
        expect([error.status, error.code]).toEqual([403, 'LAUNCHPAD_NOT_LIVE']);
      }
    });
  });

  describe('mint', () => {
    it('refuses a mint that already has a ticket (409 MINT_USED)', async () => {
      const h = harness();
      const mint = newWallet().address;
      await h.service.issue('moonpad', signedRequest({ mint }));
      const error = await issueError(h.service.issue('moonpad', signedRequest({ mint })));
      expect([error.status, error.code]).toEqual([409, 'MINT_USED']);
    });

    it('refuses the launchpad coin mint and a mint that exists on-chain', async () => {
      const coinMint = newWallet().address;
      const onChain = newWallet().address;
      const h = harness({ existingAccounts: [onChain] });
      h.store.addLaunchpad({ ...LIVE, coinMint });
      expect(
        (await issueError(h.service.issue('moonpad', signedRequest({ mint: coinMint })))).code,
      ).toBe('MINT_USED');
      expect(
        (await issueError(h.service.issue('moonpad', signedRequest({ mint: onChain })))).code,
      ).toBe('MINT_USED');
      expect(h.store.tickets.size).toBe(0);
    });

    it('fails closed when the chain cannot be read (503)', async () => {
      const h = harness({
        mintChecker: {
          accountExists: async () => {
            throw new ChainReadError();
          },
        },
      });
      const error = await issueError(h.service.issue('moonpad', signedRequest()));
      expect([error.status, error.code]).toEqual([503, 'CHAIN_UNAVAILABLE']);
    });

    it('refuses a mint equal to the wallet and non-canonical addresses', async () => {
      const h = harness();
      const wallet = newWallet();
      let error = await issueError(
        h.service.issue('moonpad', signedRequest({ wallet, mint: wallet.address })),
      );
      expect(error.code).toBe('BAD_REQUEST');
      error = await issueError(
        h.service.issue('moonpad', signedRequest({ mint: '1111111111111111111111111111111' })),
      );
      expect(error.code).toBe('BAD_REQUEST');
    });
  });

  describe('rate limits', () => {
    it('limits tickets per wallet, with Retry-After', async () => {
      const h = harness();
      const wallet = newWallet();
      for (let i = 0; i < UPLOAD_RATE_LIMITS.wallet.limit; i++) {
        await h.service.issue('moonpad', signedRequest({ wallet }));
      }
      const error = await issueError(h.service.issue('moonpad', signedRequest({ wallet })));
      expect([error.status, error.code]).toEqual([429, 'RATE_LIMITED']);
      expect(error.retryAfterSeconds).toBe(UPLOAD_RATE_LIMITS.wallet.windowMs / 1000);
      // Another wallet is not affected.
      await h.service.issue('moonpad', signedRequest());
    });

    it('counts tickets durably, so a fresh instance still limits the wallet', async () => {
      const h = harness();
      const wallet = newWallet();
      for (let i = 0; i < UPLOAD_RATE_LIMITS.wallet.limit; i++) {
        h.clock.now += 1000;
        await h.service.issue(
          'moonpad',
          signedRequest({ wallet, issuedAt: new Date(h.clock.now).toISOString() }),
        );
      }
      const fresh = harness();
      for (const [id, t] of h.store.tickets) fresh.store.tickets.set(id, t);
      fresh.clock.now = h.clock.now;
      const error = await issueError(
        fresh.service.issue(
          'moonpad',
          signedRequest({ wallet, issuedAt: new Date(h.clock.now).toISOString() }),
        ),
      );
      expect(error.code).toBe('RATE_LIMITED');
      // The oldest ticket leaves the 10 minute window 10 minutes after it was issued.
      expect(error.retryAfterSeconds).toBe(
        UPLOAD_RATE_LIMITS.wallet.windowMs / 1000 - (UPLOAD_RATE_LIMITS.wallet.limit - 1),
      );
    });

    it('limits tickets per launchpad across wallets', async () => {
      const h = harness({ limiter: new SlidingWindowLimiter(() => T0) });
      const base: Omit<TicketRecord, 'id' | 'nonce' | 'mint' | 'wallet'> = {
        launchpadId: LIVE.id,
        requestSha256: 'f'.repeat(64),
        host: `moonpad.${CLIENTS_DOMAIN}`,
        contentType: 'image/png',
        imageSize: 1,
        imageSha256: 'e'.repeat(64),
        uploadKey: 'pending/k',
        imageKey: 'k',
        metadataKey: 'm',
        coinName: 'x',
        coinSymbol: 'X',
        coinDescription: '',
        firstBuyLamports: '0',
        status: 'issued',
        rejection: null,
        metadataSha256: null,
        issuedAt: new Date(T0 - 60_000),
        expiresAt: new Date(T0),
        completedAt: null,
        sweptAt: null,
      };
      for (let i = 0; i < UPLOAD_RATE_LIMITS.launchpad.limit; i++) {
        const id = `seed${String(i).padStart(18, '0')}`;
        h.store.tickets.set(id, {
          ...base,
          id,
          nonce: i.toString(16).padStart(32, '0'),
          mint: `mint${i}`,
          wallet: `wallet${i}`,
        });
      }
      const error = await issueError(h.service.issue('moonpad', signedRequest()));
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.retryAfterSeconds).toBe(UPLOAD_RATE_LIMITS.launchpad.windowMs / 1000 - 60);
    });
  });

  it('refuses malformed bodies (400)', async () => {
    const h = harness();
    const request = signedRequest();
    for (const body of [
      null,
      { ...request, extra: 1 },
      { ...request, version: 2 },
      { ...request, image: { ...request.image, contentType: 'image/svg+xml' } },
      { ...request, image: { ...request.image, size: 2 * 1024 * 1024 + 1 } },
      { ...request, coin: { ...request.coin, name: 'Bad‮Name' } },
      { ...request, firstBuyLamports: '18446744073709551616' },
      { ...request, auth: { ...request.auth, nonce: 'XYZ' } },
    ]) {
      const error = await issueError(h.service.issue('moonpad', body));
      expect([error.status, error.code]).toEqual([400, 'BAD_REQUEST']);
    }
  });
});

async function issueAndPut(h: Harness, image = pngBytes()) {
  const request = signedRequest({ image });
  const ticket = await h.service.issue('moonpad', request);
  expect(await putImage(h, ticket, image)).toBe(200);
  return { request, ticket };
}

describe('presigned PUT (R2 rules)', () => {
  it('is write-once, bound to the checksum, the headers and the expiry', async () => {
    const h = harness();
    const image = pngBytes();
    const request = signedRequest({ image });
    const ticket = await h.service.issue('moonpad', request);

    // Other bytes than the declared SHA-256: refused by storage.
    expect(await putImage(h, ticket, pngBytes(1024, 9))).toBe(400);
    // Another size: the signed Content-Length no longer matches.
    expect(await putImage(h, ticket, pngBytes(2048))).toBe(403);
    expect(await putImage(h, ticket, pngBytes(1023))).toBe(403);
    // Missing or altered signed header: signature mismatch.
    const { 'If-None-Match': _omit, ...withoutIfNoneMatch } = ticket.image.headers;
    void _omit;
    expect(
      await putImage(h, { image: { ...ticket.image, headers: withoutIfNoneMatch } }, image),
    ).toBe(403);
    expect(
      await putImage(
        h,
        {
          image: {
            ...ticket.image,
            headers: { ...ticket.image.headers, 'Content-Type': 'text/html' },
          },
        },
        image,
      ),
    ).toBe(403);
    // Right bytes: stored once; a second PUT never overwrites.
    expect(await putImage(h, ticket, image)).toBe(200);
    expect(await putImage(h, ticket, image)).toBe(412);
    // Expired URL.
    h.clock.now += TICKET_TTL_SECONDS * 1000 + 1000;
    expect(await putImage(h, ticket, image)).toBe(403);
  });
});

describe('complete', () => {
  it('verifies the stored image, writes the metadata JSON and returns the receipt', async () => {
    const h = harness();
    const { request, ticket } = await issueAndPut(h);
    const receipt = await h.service.complete('moonpad', ticket.uploadId, { mint: request.mint });

    const metadataKey = `launchpads/moonpad/metadata/${request.mint}.json`;
    const stored = h.r2.objects.get(metadataKey)!;
    const json = Buffer.from(stored.bytes).toString('utf8');
    expect(JSON.parse(json)).toEqual({
      name: 'Moon Coin',
      symbol: 'MOON',
      description: 'The moon coin.',
      image: ticket.image.publicUrl,
    });
    expect(json.indexOf('"name"')).toBeLessThan(json.indexOf('"image"'));
    expect(stored.contentType).toBe('application/json');
    expect(receipt).toEqual({
      image: { publicUrl: ticket.image.publicUrl, sha256: request.image.sha256 },
      metadata: { publicUrl: ticket.metadata.publicUrl, sha256: sha256Hex(stored.bytes) },
    });
    expect(h.store.tickets.get(ticket.uploadId)).toMatchObject({
      status: 'completed',
      metadataSha256: receipt.metadata.sha256,
    });
    // FORGE wrote the verified bytes to the public key itself and dropped the staged copy.
    const image = h.r2.objects.get(`launchpads/moonpad/images/${request.mint}.png`)!;
    expect(sha256Hex(image.bytes)).toBe(request.image.sha256);
    expect(image.contentType).toBe('image/png');
    expect(h.r2.objects.has(`pending/moonpad/${request.mint}.png`)).toBe(false);
  });

  it('never exposes staged bytes at the public key before verification', async () => {
    const h = harness();
    const { request } = await issueAndPut(h);
    expect(h.r2.objects.has(`pending/moonpad/${request.mint}.png`)).toBe(true);
    expect(h.r2.objects.has(`launchpads/moonpad/images/${request.mint}.png`)).toBe(false);
  });

  it('refuses a public image already holding other bytes (409 IMAGE_CONFLICT)', async () => {
    const h = harness();
    const { request, ticket } = await issueAndPut(h);
    h.r2.objects.set(`launchpads/moonpad/images/${request.mint}.png`, {
      bytes: pngBytes(1024, 4),
      contentType: 'image/png',
    });
    const error = await issueError(
      h.service.complete('moonpad', ticket.uploadId, { mint: request.mint }),
    );
    expect([error.status, error.code]).toEqual([409, 'IMAGE_CONFLICT']);
    expect(h.store.tickets.get(ticket.uploadId)!.status).toBe('issued');
  });

  it('only serves the site whose server token names the launchpad', async () => {
    const h = harness();
    const { request, ticket } = await issueAndPut(h);
    const other = { serverSlug: 'rugpad' };
    for (const param of ['moonpad', LIVE.id]) {
      const error = await issueError(
        h.service.complete(param, ticket.uploadId, { mint: request.mint }, other),
      );
      expect([error.status, error.code]).toEqual([403, 'SERVER_TOKEN_MISMATCH']);
      const issued = await issueError(h.service.issue(param, signedRequest(), other));
      expect([issued.status, issued.code]).toEqual([403, 'SERVER_TOKEN_MISMATCH']);
    }
    expect(h.store.tickets.size).toBe(1);
  });

  it('is idempotent: a retry returns the same receipt without touching storage', async () => {
    const h = harness();
    const { request, ticket } = await issueAndPut(h);
    const first = await h.service.complete(LIVE.id, ticket.uploadId, { mint: request.mint });
    const calls = h.r2.calls.length;
    const again = await h.service.complete('moonpad', ticket.uploadId, { mint: request.mint });
    expect(again).toEqual(first);
    expect(h.r2.calls.length).toBe(calls);
  });

  it('recovers when an earlier attempt wrote the metadata but did not record it', async () => {
    const h = harness();
    const { request, ticket } = await issueAndPut(h);
    const first = await h.service.complete('moonpad', ticket.uploadId, { mint: request.mint });
    // Simulate the lost database write.
    const row = h.store.tickets.get(ticket.uploadId)!;
    row.status = 'issued';
    row.metadataSha256 = null;
    row.completedAt = null;
    const again = await h.service.complete('moonpad', ticket.uploadId, { mint: request.mint });
    expect(again).toEqual(first);
    expect(h.r2.calls.some((c) => c.method === 'PUT' && c.status === 412)).toBe(true);
  });

  it('recovers when an earlier attempt wrote the public image but nothing else', async () => {
    const h = harness();
    const image = pngBytes();
    const { request, ticket } = await issueAndPut(h, image);
    // The staged copy is gone, the public image is there: the retry reuses it.
    h.r2.objects.delete(`pending/moonpad/${request.mint}.png`);
    h.r2.objects.set(`launchpads/moonpad/images/${request.mint}.png`, {
      bytes: image,
      contentType: 'image/png',
    });
    const receipt = await h.service.complete('moonpad', ticket.uploadId, { mint: request.mint });
    expect(receipt.image.sha256).toBe(request.image.sha256);
  });

  it('refuses metadata already written with other content (409)', async () => {
    const h = harness();
    const { request, ticket } = await issueAndPut(h);
    h.r2.objects.set(`launchpads/moonpad/metadata/${request.mint}.json`, {
      bytes: Buffer.from('{"name":"other"}'),
      contentType: 'application/json',
    });
    const error = await issueError(
      h.service.complete('moonpad', ticket.uploadId, { mint: request.mint }),
    );
    expect([error.status, error.code]).toEqual([409, 'METADATA_CONFLICT']);
  });

  it('answers 409 IMAGE_MISSING before the PUT, then works after it', async () => {
    const h = harness();
    const image = pngBytes();
    const request = signedRequest({ image });
    const ticket = await h.service.issue('moonpad', request);
    const error = await issueError(
      h.service.complete('moonpad', ticket.uploadId, { mint: request.mint }),
    );
    expect([error.status, error.code]).toEqual([409, 'IMAGE_MISSING']);
    expect(h.store.tickets.get(ticket.uploadId)!.status).toBe('issued');
    await putImage(h, ticket, image);
    await h.service.complete('moonpad', ticket.uploadId, { mint: request.mint });
  });

  describe('deletes a stored image that does not match, and rejects the upload', () => {
    async function expectRejected(h: Harness, uploadId: string, mint: string, key: string) {
      const error = await issueError(h.service.complete('moonpad', uploadId, { mint }));
      expect([error.status, error.code]).toEqual([422, 'IMAGE_REJECTED']);
      expect(h.r2.objects.has(key)).toBe(false);
      expect(h.r2.calls.some((c) => c.method === 'DELETE' && c.key === key)).toBe(true);
      expect(h.store.tickets.get(uploadId)!.status).toBe('rejected');
      // Nothing was written to the public keys.
      expect(h.r2.objects.has(`launchpads/moonpad/images/${mint}.png`)).toBe(false);
      expect(h.r2.objects.has(`launchpads/moonpad/metadata/${mint}.json`)).toBe(false);
      // Final: a retry is refused the same way, without reading storage again.
      const calls = h.r2.calls.length;
      const again = await issueError(h.service.complete('moonpad', uploadId, { mint }));
      expect(again.code).toBe('IMAGE_REJECTED');
      expect(h.r2.calls.length).toBe(calls);
    }

    it('other bytes than declared (storage without checksum enforcement)', async () => {
      const h = harness();
      const request = signedRequest();
      const ticket = await h.service.issue('moonpad', request);
      const key = `pending/moonpad/${request.mint}.png`;
      h.r2.objects.set(key, { bytes: pngBytes(1024, 3), contentType: 'image/png' });
      await expectRejected(h, ticket.uploadId, request.mint, key);
    });

    it('another size', async () => {
      const h = harness();
      const request = signedRequest();
      const ticket = await h.service.issue('moonpad', request);
      const key = `pending/moonpad/${request.mint}.png`;
      h.r2.objects.set(key, { bytes: pngBytes(1000), contentType: 'image/png' });
      await expectRejected(h, ticket.uploadId, request.mint, key);
    });

    it('bytes that are not the declared image type (magic bytes)', async () => {
      const h = harness();
      const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(1024, ' '));
      const request = signedRequest({ image: html });
      const ticket = await h.service.issue('moonpad', request);
      // The checksum matches, so storage accepts the PUT; FORGE refuses it afterwards.
      expect(await putImage(h, ticket, html)).toBe(200);
      await expectRejected(h, ticket.uploadId, request.mint, `pending/moonpad/${request.mint}.png`);
    });

    it('a JPEG declared as PNG', async () => {
      const h = harness();
      const jpeg = new Uint8Array(512).fill(1);
      jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
      const request = signedRequest({ image: jpeg, contentType: 'image/png' });
      const ticket = await h.service.issue('moonpad', request);
      expect(await putImage(h, ticket, jpeg)).toBe(200);
      await expectRejected(h, ticket.uploadId, request.mint, `pending/moonpad/${request.mint}.png`);
    });

    it('a re-PUT after the rejection stays staged and never reaches the public key', async () => {
      const h = harness();
      const html = Buffer.from('<html></html>'.padEnd(1024, ' '));
      const request = signedRequest({ image: html });
      const ticket = await h.service.issue('moonpad', request);
      expect(await putImage(h, ticket, html)).toBe(200);
      await expectRejected(h, ticket.uploadId, request.mint, `pending/moonpad/${request.mint}.png`);
      // The URL is still valid for a few minutes: the bytes land in staging again...
      expect(await putImage(h, ticket, html)).toBe(200);
      const again = await issueError(
        h.service.complete('moonpad', ticket.uploadId, { mint: request.mint }),
      );
      expect(again.code).toBe('IMAGE_REJECTED');
      // ...where only the sweep (and the lifecycle rule) will find them.
      expect(h.r2.objects.has(`pending/moonpad/${request.mint}.png`)).toBe(true);
      expect(h.r2.objects.has(`launchpads/moonpad/images/${request.mint}.png`)).toBe(false);
    });

    it('an object larger than 2 MB', async () => {
      const h = harness();
      const request = signedRequest();
      const ticket = await h.service.issue('moonpad', request);
      const key = `pending/moonpad/${request.mint}.png`;
      h.r2.objects.set(key, { bytes: pngBytes(2 * 1024 * 1024 + 1), contentType: 'image/png' });
      await expectRejected(h, ticket.uploadId, request.mint, key);
    });
  });

  it('refuses unknown uploads, another launchpad and another mint', async () => {
    const h = harness();
    h.store.addLaunchpad({ ...LIVE, id: '00000000-0000-4000-8000-000000000002', slug: 'rugpad' });
    const { request, ticket } = await issueAndPut(h);
    let error = await issueError(
      h.service.complete('moonpad', 'A'.repeat(22), { mint: request.mint }),
    );
    expect([error.status, error.code]).toEqual([404, 'UPLOAD_NOT_FOUND']);
    error = await issueError(h.service.complete('moonpad', '../../etc', { mint: request.mint }));
    expect(error.code).toBe('UPLOAD_NOT_FOUND');
    error = await issueError(h.service.complete('rugpad', ticket.uploadId, { mint: request.mint }));
    expect(error.code).toBe('UPLOAD_NOT_FOUND');
    error = await issueError(
      h.service.complete('moonpad', ticket.uploadId, { mint: newWallet().address }),
    );
    expect([error.status, error.code]).toEqual([400, 'BAD_REQUEST']);
    error = await issueError(
      h.service.complete('moonpad', ticket.uploadId, { mint: request.mint, x: 1 }),
    );
    expect(error.code).toBe('BAD_REQUEST');
  });

  it('expires an upload that was never completed', async () => {
    const h = harness();
    const { request, ticket } = await issueAndPut(h);
    h.clock.now += COMPLETE_WINDOW_SECONDS * 1000 + 1000;
    const error = await issueError(
      h.service.complete('moonpad', ticket.uploadId, { mint: request.mint }),
    );
    expect([error.status, error.code]).toEqual([410, 'UPLOAD_EXPIRED']);
  });

  it('refuses an upload the sweep marked expired', async () => {
    const h = harness();
    const { request, ticket } = await issueAndPut(h);
    h.store.tickets.get(ticket.uploadId)!.status = 'expired';
    const error = await issueError(
      h.service.complete('moonpad', ticket.uploadId, { mint: request.mint }),
    );
    expect([error.status, error.code]).toEqual([410, 'UPLOAD_EXPIRED']);
  });

  it('refuses to complete on a launchpad that stopped being live', async () => {
    const h = harness();
    const { request, ticket } = await issueAndPut(h);
    h.store.addLaunchpad({ ...LIVE, status: 'disabled' });
    const error = await issueError(
      h.service.complete('moonpad', ticket.uploadId, { mint: request.mint }),
    );
    expect(error.code).toBe('LAUNCHPAD_NOT_LIVE');
  });

  it('rate-limits completion attempts per upload', async () => {
    const h = harness();
    const request = signedRequest();
    const ticket = await h.service.issue('moonpad', request);
    for (let i = 0; i < UPLOAD_RATE_LIMITS.complete.limit; i++) {
      await issueError(h.service.complete('moonpad', ticket.uploadId, { mint: request.mint }));
    }
    const error = await issueError(
      h.service.complete('moonpad', ticket.uploadId, { mint: request.mint }),
    );
    expect(error.code).toBe('RATE_LIMITED');
  });

  it('retries storage errors, then reports 502 STORAGE_UNAVAILABLE', async () => {
    const h = harness();
    const { request, ticket } = await issueAndPut(h);
    h.r2.failures.push(503, 0);
    const receipt = await h.service.complete('moonpad', ticket.uploadId, { mint: request.mint });
    expect(receipt.image.sha256).toBe(request.image.sha256);

    const other = await issueAndPut(h);
    h.r2.failures.push(500, 500, 500);
    const failure = await h.service
      .complete('moonpad', other.ticket.uploadId, { mint: other.request.mint })
      .then(
        () => null,
        (error: unknown) => error,
      );
    const mapped = toUploadHttpError(failure, () => undefined);
    expect([mapped.status, mapped.code]).toEqual([502, 'STORAGE_UNAVAILABLE']);
    // Nothing was rejected or deleted because storage was down.
    expect(h.store.tickets.get(other.ticket.uploadId)!.status).toBe('issued');
  });
});
