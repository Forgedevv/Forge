// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readR2Options } from '../config';
import { createUploadService } from '../service';
import { createR2Storage } from '../storage';
import { MemoryUploadStore } from '../store';
import { LIVE, pngBytes, sha256Hex, signedRequest } from './helpers';

/*
 * Opt-in live smoke against the dev R2 bucket: FORGE_R2_SMOKE=1 plus the R2_* variables.
 * Everything lives under a dedicated `forge-smoke/<run>/` prefix and is deleted at the end.
 * Steps: ticket -> PUT a 1 KB PNG through the presigned URL to the staging key -> checksum,
 * signed size and write-once checks -> complete (read back, public image and metadata written)
 * -> delete. Never logs a URL or a credential.
 */

const enabled = process.env.FORGE_R2_SMOKE === '1';
const describeLive = enabled ? describe : describe.skip;

describeLive('live R2 smoke (dev bucket, forge-smoke/ prefix)', () => {
  it('presigns, uploads, completes and cleans up', { timeout: 60_000 }, async () => {
    const run = randomBytes(6).toString('hex');
    const keyPrefix = `forge-smoke/${run}/`;
    const options = readR2Options(process.env);
    const storage = createR2Storage({ ...options, keyPrefix });
    const store = new MemoryUploadStore();
    store.addLaunchpad(LIVE);
    const service = createUploadService({
      store,
      storage,
      clientsDomain: 'forge-sites.app',
      mintChecker: null,
      now: Date.now,
      log: () => undefined,
    });

    const image = pngBytes(1024);
    const request = signedRequest({
      image,
      host: 'moonpad.forge-sites.app',
      issuedAt: new Date().toISOString(),
    });
    const keys = [
      `pending/moonpad/${request.mint}.png`,
      `launchpads/moonpad/images/${request.mint}.png`,
      `launchpads/moonpad/metadata/${request.mint}.json`,
    ];
    const outcome: Record<string, unknown> = {};
    try {
      const caller = { serverSlug: 'moonpad' };
      const ticket = await service.issue('moonpad', request, caller);
      // Booleans only: a presigned URL is never printed.
      const path = `/${options.bucket}/${keyPrefix}pending/moonpad/`;
      expect(new URL(ticket.image.uploadUrl).pathname.startsWith(path)).toBe(true);

      const put = (bytes: Uint8Array) =>
        fetch(ticket.image.uploadUrl, {
          method: 'PUT',
          headers: ticket.image.headers,
          body: bytes as unknown as BodyInit,
        });

      // Bytes that do not match the signed checksum: refused, nothing stored.
      const wrong = await put(pngBytes(1024, 9));
      outcome.checksumMismatchStatus = wrong.status;
      expect(wrong.ok).toBe(false);

      // Another size than the signed Content-Length: refused, nothing stored.
      const bigger = await put(pngBytes(2048));
      outcome.sizeMismatchStatus = bigger.status;
      expect(bigger.ok).toBe(false);

      const first = await put(image);
      outcome.putStatus = first.status;
      expect(first.ok).toBe(true);

      // Write-once: a second PUT on the same key never overwrites.
      const second = await put(image);
      outcome.secondPutStatus = second.status;
      expect(second.status).toBe(412);

      const receipt = await service.complete(
        'moonpad',
        ticket.uploadId,
        { mint: request.mint },
        caller,
      );
      expect(receipt.image.sha256).toBe(sha256Hex(image));
      outcome.stagedGone = (await storage.get(keys[0]!, 4096)) === null;
      const metadata = await storage.get(keys[2]!, 16 * 1024);
      expect(metadata).not.toBeNull();
      expect(sha256Hex(metadata!.bytes)).toBe(receipt.metadata.sha256);
      expect(JSON.parse(Buffer.from(metadata!.bytes).toString('utf8'))).toMatchObject({
        name: 'Moon Coin',
        symbol: 'MOON',
        image: ticket.image.publicUrl,
      });

      // Public URL (read-only GET).
      const pub = await fetch(receipt.image.publicUrl);
      outcome.publicGetStatus = pub.status;
      if (pub.ok)
        outcome.publicBytesMatch =
          sha256Hex(new Uint8Array(await pub.arrayBuffer())) === sha256Hex(image);
    } finally {
      for (const key of keys) await storage.delete(key);
      for (const key of keys)
        outcome[`gone:${key.split('/').at(-2)}`] = (await storage.get(key, 4096)) === null;
      console.info(`[smoke] ${JSON.stringify(outcome)}`);
    }
    expect(outcome['gone:moonpad']).toBe(true);
    expect(outcome['gone:images']).toBe(true);
    expect(outcome['gone:metadata']).toBe(true);
  });
});
