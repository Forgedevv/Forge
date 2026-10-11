// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPLETE_WINDOW_SECONDS, SWEEP_GRACE_SECONDS, TICKET_TTL_SECONDS } from '../contract';
import { StorageError, type ObjectStorage } from '../storage';
import { sweepKeys, sweepUploads, type SweepDeps } from '../sweep';
import { handleUploadSweep, hasCronSecret } from '../sweep-route';
import { harness, pngBytes, putImage, signedRequest, T0, type Harness } from './helpers';

const MINUTE = 60_000;
const CRON_SECRET = 'cron-secret-for-tests-0123456789abcdef';

async function issued(h: Harness, image = pngBytes()) {
  const request = signedRequest({ image });
  const ticket = await h.service.issue('moonpad', request);
  return { request, ticket, image };
}

const keysOf = (mint: string) => ({
  pending: `pending/moonpad/${mint}.png`,
  image: `launchpads/moonpad/images/${mint}.png`,
  metadata: `launchpads/moonpad/metadata/${mint}.json`,
});

function deps(h: Harness, storage: ObjectStorage = h.storage): SweepDeps & { logs: string[] } {
  const logs: string[] = [];
  return { store: h.store, storage, now: () => h.clock.now, log: (m) => logs.push(m), logs };
}

afterEach(() => vi.restoreAllMocks());

describe('sweepUploads', () => {
  it('deletes a staged re-PUT of a rejected ticket once its URL is dead', async () => {
    const h = harness();
    const html = Buffer.from('<html></html>'.padEnd(1024, ' '));
    const { request, ticket } = await issued(h, html);
    expect(await putImage(h, ticket, html)).toBe(200);
    await h.service.complete('moonpad', ticket.uploadId, { mint: request.mint }).catch(() => null);
    expect(h.store.tickets.get(ticket.uploadId)!.status).toBe('rejected');
    // Staged again while the URL is valid.
    expect(await putImage(h, ticket, html)).toBe(200);
    const k = keysOf(request.mint);

    // Not before the URL expired (plus grace).
    h.clock.now = T0 + (TICKET_TTL_SECONDS + SWEEP_GRACE_SECONDS) * 1000 - 1000;
    expect(await sweepUploads(deps(h))).toMatchObject({ scanned: 0, swept: 0 });
    expect(h.r2.objects.has(k.pending)).toBe(true);

    h.clock.now += 2000;
    expect(await sweepUploads(deps(h))).toMatchObject({ scanned: 1, swept: 1, expired: 0 });
    expect(h.r2.objects.has(k.pending)).toBe(false);
    expect(h.store.tickets.get(ticket.uploadId)!.sweptAt).toEqual(new Date(h.clock.now));
    // Once swept, never again.
    expect(await sweepUploads(deps(h))).toMatchObject({ scanned: 0 });
  });

  it('keeps the public objects of a completed ticket and drops its staged leftover', async () => {
    const h = harness();
    const { request, ticket, image } = await issued(h);
    expect(await putImage(h, ticket, image)).toBe(200);
    await h.service.complete('moonpad', ticket.uploadId, { mint: request.mint });
    // The URL is still valid after completion: someone stages bytes again.
    expect(await putImage(h, ticket, image)).toBe(200);
    const k = keysOf(request.mint);
    h.clock.now = T0 + (TICKET_TTL_SECONDS + SWEEP_GRACE_SECONDS) * 1000 + 1000;
    expect(await sweepUploads(deps(h))).toMatchObject({ swept: 1, expired: 0 });
    expect(h.r2.objects.has(k.pending)).toBe(false);
    expect(h.r2.objects.has(k.image)).toBe(true);
    expect(h.r2.objects.has(k.metadata)).toBe(true);
    expect(h.store.tickets.get(ticket.uploadId)!.status).toBe('completed');
  });

  it('expires tickets never completed and deletes everything they wrote', async () => {
    const h = harness();
    const { request, ticket, image } = await issued(h);
    expect(await putImage(h, ticket, image)).toBe(200);
    const k = keysOf(request.mint);
    // A complete that failed half-way left a public image and metadata behind.
    h.r2.objects.set(k.image, { bytes: image, contentType: 'image/png' });
    h.r2.objects.set(k.metadata, { bytes: Buffer.from('{}'), contentType: 'application/json' });

    // Inside the complete window (plus grace): untouched, even though the URL is dead.
    h.clock.now = T0 + (COMPLETE_WINDOW_SECONDS + SWEEP_GRACE_SECONDS) * 1000 - 1000;
    expect(await sweepUploads(deps(h))).toMatchObject({ scanned: 0 });
    expect(h.store.tickets.get(ticket.uploadId)!.status).toBe('issued');

    h.clock.now += 2000;
    expect(await sweepUploads(deps(h))).toMatchObject({ scanned: 1, expired: 1, swept: 1 });
    expect(h.store.tickets.get(ticket.uploadId)!.status).toBe('expired');
    for (const key of Object.values(k)) expect(h.r2.objects.has(key)).toBe(false);
    // The client gets 410 from now on.
    const error = await h.service
      .complete('moonpad', ticket.uploadId, { mint: request.mint })
      .catch((e: unknown) => e as { code: string });
    expect(error).toMatchObject({ code: 'UPLOAD_EXPIRED' });
  });

  it('lists the keys to delete per status', () => {
    const base = {
      uploadKey: 'pending/a/m.png',
      imageKey: 'launchpads/a/images/m.png',
      metadataKey: 'launchpads/a/metadata/m.json',
    };
    expect(sweepKeys({ ...base, status: 'completed' } as never)).toEqual([base.uploadKey]);
    for (const status of ['rejected', 'expired', 'issued']) {
      expect(sweepKeys({ ...base, status } as never)).toEqual([
        base.uploadKey,
        base.imageKey,
        base.metadataKey,
      ]);
    }
  });

  it('leaves a ticket for the next run when storage fails, and goes on with the others', async () => {
    const h = harness();
    const first = await issued(h);
    const second = await issued(h);
    h.clock.now = T0 + (COMPLETE_WINDOW_SECONDS + SWEEP_GRACE_SECONDS) * 1000 + 1000;
    const failing: ObjectStorage = {
      ...h.storage,
      delete: async (key) => {
        if (key.includes(first.request.mint)) throw new StorageError('delete', 503);
        return h.storage.delete(key);
      },
    };
    const d = deps(h, failing);
    const report = await sweepUploads(d);
    expect(report).toMatchObject({ scanned: 2, expired: 2, swept: 1, failed: 1 });
    expect(h.store.tickets.get(first.ticket.uploadId)!.sweptAt).toBeNull();
    expect(h.store.tickets.get(second.ticket.uploadId)!.sweptAt).not.toBeNull();
    expect(d.logs.join(' ')).toContain(first.ticket.uploadId);
    // Next run (storage back): the expired ticket is cleaned.
    expect(await sweepUploads(deps(h))).toMatchObject({ scanned: 1, expired: 0, swept: 1 });
  });

  it('stops on its ticket budget and reports it', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await issued(h);
    h.clock.now = T0 + (COMPLETE_WINDOW_SECONDS + SWEEP_GRACE_SECONDS) * 1000 + MINUTE;
    const report = await sweepUploads(deps(h), { batchSize: 2, maxTickets: 3 });
    expect(report).toMatchObject({ scanned: 3, swept: 3, truncated: true });
    expect(await sweepUploads(deps(h))).toMatchObject({ scanned: 2, truncated: false });
  });
});

describe('POST /api/internal/uploads/sweep', () => {
  const post = (authorization?: string) =>
    new Request('https://forge.app/api/internal/uploads/sweep', {
      method: 'POST',
      headers: authorization === undefined ? {} : { authorization },
    });
  const env = { FORGE_INTERNAL_CRON_SECRET: CRON_SECRET };

  it('runs the sweep with the right bearer secret and returns the report', async () => {
    const h = harness();
    const logs: string[] = [];
    const res = await handleUploadSweep(post(`Bearer ${CRON_SECRET}`), {
      env,
      sweepDeps: () => deps(h),
      log: (m) => logs.push(m),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      scanned: 0,
      expired: 0,
      swept: 0,
      failed: 0,
      truncated: false,
    });
  });

  it('refuses a missing or wrong secret (401) without running anything', async () => {
    const sweep = vi.fn();
    for (const auth of [undefined, '', CRON_SECRET, `Bearer ${CRON_SECRET}x`, 'Bearer short']) {
      const res = await handleUploadSweep(post(auth), {
        env,
        sweep,
        sweepDeps: () => ({}) as never,
      });
      expect(res.status).toBe(401);
    }
    expect(sweep).not.toHaveBeenCalled();
  });

  it('is disabled (503) while FORGE_INTERNAL_CRON_SECRET is unset or too short', async () => {
    for (const value of [undefined, '', 'too-short']) {
      const logs: string[] = [];
      const sweep = vi.fn();
      const res = await handleUploadSweep(post(`Bearer ${value ?? ''}`), {
        env: { FORGE_INTERNAL_CRON_SECRET: value },
        sweep,
        log: (m) => logs.push(m),
      });
      expect(res.status).toBe(503);
      expect(logs.join(' ')).toContain('FORGE_INTERNAL_CRON_SECRET');
      expect(logs.join(' ')).not.toContain('too-short');
      expect(sweep).not.toHaveBeenCalled();
    }
  });

  it('answers 503 when storage or the database is not configured', async () => {
    const logs: string[] = [];
    const res = await handleUploadSweep(post(`Bearer ${CRON_SECRET}`), {
      env,
      log: (m) => logs.push(m),
    });
    expect(res.status).toBe(503);
    expect(logs.join(' ')).toContain('R2_ACCOUNT_ID');
  });

  it('maps an unexpected failure to a 500 without details', async () => {
    const logs: string[] = [];
    const res = await handleUploadSweep(post(`Bearer ${CRON_SECRET}`), {
      env,
      sweepDeps: () => ({}) as never,
      sweep: () => Promise.reject(new Error('https://user:pass@db.example')),
      log: (m) => logs.push(m),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('pass');
    expect(logs.join(' ')).not.toContain('pass');
  });

  it('compares the secret in constant time over digests', () => {
    expect(hasCronSecret(post(`Bearer ${CRON_SECRET}`), CRON_SECRET)).toBe(true);
    expect(hasCronSecret(post(`bearer ${CRON_SECRET}`), CRON_SECRET)).toBe(false);
    expect(hasCronSecret(post(`Bearer ${CRON_SECRET} extra`), CRON_SECRET)).toBe(false);
  });

  it('is served by the route file and refuses without a secret', async () => {
    const { POST } = await import('../../../../app/api/internal/uploads/sweep/route');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await POST(post());
    expect([401, 503]).toContain(res.status);
  });
});
