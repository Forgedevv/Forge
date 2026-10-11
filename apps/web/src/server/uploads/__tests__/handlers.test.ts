// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveRelayToken, RELAY_TOKEN_HEADER } from '../../rpc/server-token';
import { UPLOAD_PRE_LIMITS, UploadHttpError } from '../contract';
import { createUploadHandlers, type UploadHandlerDeps } from '../handlers';
import { SlidingWindowLimiter } from '../rate-limit';
import type { UploadService } from '../service';
import { harness, LIVE, pngBytes, putImage, signedRequest, T0, type Harness } from './helpers';

const API = 'https://forge.app';
const SECRET = Buffer.from('relay-token-secret-for-tests-0123456789abcdef', 'utf8');
const MOON_TOKEN = deriveRelayToken(SECRET, 'moonpad');

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  token: string | null = MOON_TOKEN,
) {
  return new Request(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': '76.76.21.9',
      ...(token === null ? {} : { [RELAY_TOKEN_HEADER]: token }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function handlersFor(h: Harness, logs: string[] = [], extra: UploadHandlerDeps = {}) {
  return createUploadHandlers({
    service: () => h.service,
    log: (m) => logs.push(m),
    tokenSecret: () => SECRET,
    limiter: new SlidingWindowLimiter(() => h.clock.now),
    ...extra,
  });
}

/** A service that must never be reached. */
function unreachable(calls: string[]): UploadService {
  return {
    issue: async () => {
      calls.push('issue');
      throw new Error('unreachable');
    },
    complete: async () => {
      calls.push('complete');
      throw new Error('unreachable');
    },
  };
}

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('upload routes over HTTP', () => {
  it('runs the three contract steps', async () => {
    const h = harness();
    const handlers = handlersFor(h);
    const image = pngBytes(2048);
    const request = signedRequest({ image });

    const res = await handlers.createUpload(
      post('/api/launchpads/moonpad/uploads', request),
      'moonpad',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const ticket = (await res.json()) as Awaited<ReturnType<UploadService['issue']>>;
    expect(await putImage(h, ticket, image)).toBe(200);

    const done = await handlers.completeUpload(
      post(`/api/launchpads/moonpad/uploads/${ticket.uploadId}/complete`, { mint: request.mint }),
      'moonpad',
      ticket.uploadId,
    );
    expect(done.status).toBe(200);
    const receipt = (await done.json()) as { image: { publicUrl: string; sha256: string } };
    expect(receipt.image).toEqual({
      publicUrl: ticket.image.publicUrl,
      sha256: request.image.sha256,
    });
  });

  it('answers errors as { error: { code, message } }', async () => {
    const h = harness();
    const handlers = handlersFor(h);
    const request = signedRequest({ host: 'evil.example' });
    const res = await handlers.createUpload(post('/x', request), 'moonpad');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'HOST_MISMATCH', message: 'This signed request was made for another site.' },
    });
  });

  it('refuses non-JSON, oversized and invalid bodies', async () => {
    const h = harness();
    const handlers = handlersFor(h);
    let res = await handlers.createUpload(
      post('/x', '{}', { 'content-type': 'text/plain' }),
      'moonpad',
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
    res = await handlers.createUpload(post('/x', 'x'.repeat(17 * 1024)), 'moonpad');
    expect(res.status).toBe(413);
    res = await handlers.createUpload(post('/x', '{not json'), 'moonpad');
    expect(res.status).toBe(400);
    res = await handlers.completeUpload(
      post('/x', { mint: 'x'.repeat(2000) }),
      'moonpad',
      'A'.repeat(22),
    );
    expect(res.status).toBe(413);
    res = await handlers.createUpload(
      post('/x', JSON.stringify({}), { 'content-type': 'application/json; charset=utf-8' }),
      'moonpad',
    );
    expect(res.status).toBe(400);
  });

  it('sends Retry-After on 429', async () => {
    const service: UploadService = {
      issue: async () => {
        throw new UploadHttpError(
          429,
          'RATE_LIMITED',
          'Too many coin uploads. Try again later.',
          42.2,
        );
      },
      complete: async () => {
        throw new Error('unused');
      },
    };
    const res = await createUploadHandlers({
      service: () => service,
      tokenSecret: () => SECRET,
      limiter: new SlidingWindowLimiter(),
    }).createUpload(post('/x', signedRequest()), 'moonpad');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('43');
  });

  it('maps unexpected failures to 500 without leaking details', async () => {
    const logs: string[] = [];
    const service: UploadService = {
      issue: async () => {
        throw new Error('secret detail https://user:pass@example.com');
      },
      complete: async () => {
        throw new Error('unused');
      },
    };
    const res = await createUploadHandlers({
      service: () => service,
      log: (m) => logs.push(m),
      tokenSecret: () => SECRET,
      limiter: new SlidingWindowLimiter(),
    }).createUpload(post('/x', signedRequest()), 'moonpad');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret');
    expect(logs.join(' ')).not.toContain('secret');
  });
});

describe('server token and pre-limits', () => {
  it('requires a valid server token on both routes before any other work (401)', async () => {
    const h = harness();
    const calls: string[] = [];
    const handlers = handlersFor(h, [], { service: () => unreachable(calls) });
    const forged = `v1.moonpad.${'0'.repeat(64)}`;
    for (const token of [
      null,
      '',
      'garbage',
      forged,
      deriveRelayToken(Buffer.alloc(32, 1), 'moonpad'),
    ]) {
      const res = await handlers.createUpload(post('/x', signedRequest(), {}, token), 'moonpad');
      expect(res.status).toBe(401);
      expect(await codeOf(res)).toBe('SERVER_TOKEN_REQUIRED');
      const done = await handlers.completeUpload(
        post('/x', { mint: signedRequest().mint }, {}, token),
        'moonpad',
        'A'.repeat(22),
      );
      expect(done.status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it("refuses another launchpad's token for a slug route without touching the database", async () => {
    const h = harness();
    const calls: string[] = [];
    const handlers = handlersFor(h, [], { service: () => unreachable(calls) });
    const sun = deriveRelayToken(SECRET, 'sun-pad');
    const res = await handlers.createUpload(post('/x', signedRequest(), {}, sun), 'moonpad');
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SERVER_TOKEN_MISMATCH');
    const done = await handlers.completeUpload(
      post('/x', { mint: signedRequest().mint }, {}, sun),
      'moonpad',
      'A'.repeat(22),
    );
    expect(await codeOf(done)).toBe('SERVER_TOKEN_MISMATCH');
    expect(calls).toEqual([]);
  });

  it("refuses another launchpad's token for a uuid route (checked by the service)", async () => {
    const h = harness();
    const handlers = handlersFor(h);
    const sun = deriveRelayToken(SECRET, 'sun-pad');
    const res = await handlers.createUpload(post('/x', signedRequest(), {}, sun), LIVE.id);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SERVER_TOKEN_MISMATCH');
    expect(h.store.tickets.size).toBe(0);
  });

  it('fails closed with 503 when RPC_RELAY_TOKEN_SECRET is unset or too short', async () => {
    for (const secret of [null, 'invalid'] as const) {
      const h = harness();
      const logs: string[] = [];
      const calls: string[] = [];
      const handlers = handlersFor(h, logs, {
        service: () => unreachable(calls),
        tokenSecret: () => secret,
      });
      const res = await handlers.createUpload(post('/x', signedRequest()), 'moonpad');
      expect(res.status).toBe(503);
      expect(await codeOf(res)).toBe('NOT_CONFIGURED');
      expect(logs.join(' ')).toContain('RPC_RELAY_TOKEN_SECRET');
      expect(calls).toEqual([]);
    }
  });

  it('limits per client IP before checking the token', async () => {
    const h = harness();
    const calls: string[] = [];
    const handlers = handlersFor(h, [], { service: () => unreachable(calls) });
    for (let i = 0; i < UPLOAD_PRE_LIMITS.ip.limit; i++) {
      const res = await handlers.createUpload(post('/x', '{bad', {}, null), 'moonpad');
      expect(res.status).toBe(401);
    }
    const limited = await handlers.createUpload(post('/x', signedRequest()), 'moonpad');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // The complete route shares the per-IP budget.
    const done = await handlers.completeUpload(
      post('/x', { mint: signedRequest().mint }),
      'moonpad',
      'A'.repeat(22),
    );
    expect(done.status).toBe(429);
    // Another IP still passes the pre-limits.
    const other = await handlers.createUpload(
      post('/x', '{bad', { 'x-real-ip': '76.76.21.10' }),
      'moonpad',
    );
    expect(other.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('keys ticket and complete limits on the server token, across IPs', async () => {
    const h = harness();
    const calls: string[] = [];
    const handlers = handlersFor(h, [], { service: () => unreachable(calls) });
    const ip = (i: number) => ({ 'x-real-ip': `198.51.${Math.floor(i / 250)}.${i % 250}` });
    for (let i = 0; i < UPLOAD_PRE_LIMITS.serverIssue.limit; i++) {
      await handlers.createUpload(post('/x', '{bad', ip(i)), 'moonpad');
    }
    const limited = await handlers.createUpload(
      post('/x', '{bad', { 'x-real-ip': '192.0.2.1' }),
      'moonpad',
    );
    expect(limited.status).toBe(429);
    // Another site's token is not affected; neither is the complete route of this site.
    const sun = deriveRelayToken(SECRET, 'sun-pad');
    const sunRes = await handlers.createUpload(post('/x', '{bad', {}, sun), 'sun-pad');
    expect(sunRes.status).toBe(400);
    const done = await handlers.completeUpload(post('/x', '{bad'), 'moonpad', 'A'.repeat(22));
    expect(done.status).toBe(400);

    for (let i = 1; i < UPLOAD_PRE_LIMITS.serverComplete.limit; i++) {
      await handlers.completeUpload(
        post('/x', '{bad', ip(i)),
        'moonpad',
        `${'B'.repeat(21)}${i % 10}`,
      );
    }
    const completeLimited = await handlers.completeUpload(
      post('/x', '{bad', { 'x-real-ip': '192.0.2.2' }),
      'moonpad',
      'C'.repeat(22),
    );
    expect(completeLimited.status).toBe(429);
    expect(calls).toEqual([]);
  });

  it('frees the per-token budget after the window', async () => {
    const h = harness();
    const handlers = handlersFor(h, [], { service: () => unreachable([]) });
    for (let i = 0; i < UPLOAD_PRE_LIMITS.serverIssue.limit; i++) {
      await handlers.createUpload(
        post('/x', '{bad', { 'x-real-ip': `203.0.113.${i % 200}` }),
        'moonpad',
      );
    }
    expect((await handlers.createUpload(post('/x', '{bad'), 'moonpad')).status).toBe(429);
    h.clock.now = T0 + UPLOAD_PRE_LIMITS.serverIssue.windowMs + 1;
    expect((await handlers.createUpload(post('/x', '{bad'), 'moonpad')).status).toBe(400);
  });
});

describe('route files', () => {
  it('fail closed with 503 NOT_CONFIGURED without the server token secret', async () => {
    vi.stubEnv('RPC_RELAY_TOKEN_SECRET', '');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { POST } = await import('../../../../app/api/launchpads/[id]/uploads/route');
    const res = await POST(post('/api/launchpads/moonpad/uploads', signedRequest()), {
      params: Promise.resolve({ id: 'moonpad' }),
    });
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('NOT_CONFIGURED');
    expect(errors.mock.calls.flat().join(' ')).toContain('RPC_RELAY_TOKEN_SECRET');
  });

  it('fail closed with 503 NOT_CONFIGURED when storage is not configured', async () => {
    vi.stubEnv('RPC_RELAY_TOKEN_SECRET', SECRET.toString('utf8'));
    for (const name of [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'R2_PUBLIC_URL',
    ]) {
      vi.stubEnv(name, '');
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { POST } = await import('../../../../app/api/launchpads/[id]/uploads/route');
    const res = await POST(post('/api/launchpads/moonpad/uploads', signedRequest()), {
      params: Promise.resolve({ id: 'moonpad' }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_CONFIGURED');
    expect(errors.mock.calls.flat().join(' ')).toContain('R2_ACCOUNT_ID');

    const complete =
      await import('../../../../app/api/launchpads/[id]/uploads/[uploadId]/complete/route');
    const res2 = await complete.POST(post('/x', { mint: signedRequest().mint }), {
      params: Promise.resolve({ id: 'moonpad', uploadId: 'A'.repeat(22) }),
    });
    expect(res2.status).toBe(503);
  });
});
