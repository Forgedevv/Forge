// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadHttpError } from '../contract';
import { createUploadHandlers } from '../handlers';
import type { UploadService } from '../service';
import { harness, pngBytes, putImage, signedRequest, type Harness } from './helpers';

const API = 'https://forge.app';

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function handlersFor(h: Harness, logs: string[] = []) {
  return createUploadHandlers({ service: () => h.service, log: (m) => logs.push(m) });
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
    const res = await createUploadHandlers({ service: () => service }).createUpload(
      post('/x', signedRequest()),
      'moonpad',
    );
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
    }).createUpload(post('/x', signedRequest()), 'moonpad');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret');
    expect(logs.join(' ')).not.toContain('secret');
  });
});

describe('route files', () => {
  it('fail closed with 503 NOT_CONFIGURED when storage is not configured', async () => {
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
