import type { IncomingMessage } from 'node:http';

/** Default maximum request body size, in bytes. Signer requests only carry `{ jobId }`. */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

export type BodyResult = { ok: true; raw: Buffer } | { ok: false; reason: 'too_large' | 'aborted' };

/**
 * Reads the raw request body as bytes, stopping as soon as `maxBytes` is exceeded. The declared
 * Content-Length is checked first so that an oversized request is refused before reading it.
 */
export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const length = Number(declared);
      if (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(length) || length > maxBytes) {
        resolve({ ok: false, reason: 'too_large' });
        return;
      }
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: BodyResult) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop buffering; the caller answers 413 and closes the connection.
        req.pause();
        finish({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish({ ok: true, raw: Buffer.concat(chunks, total) });
    const onError = () => finish({ ok: false, reason: 'aborted' });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
  });
}
