import { presign, type SigV4Credentials } from './sigv4';

/*
 * Object storage for coin uploads: Cloudflare R2 through its S3 API, path-style URLs, every
 * request authorized by a short-lived SigV4 presigned URL (the same signer serves the URLs
 * handed to client sites and FORGE's own reads and writes). Credentials never leave this module
 * and are never logged; errors carry the operation and the HTTP status only.
 */

export class StorageError extends Error {
  constructor(
    readonly operation: string,
    readonly status?: number,
  ) {
    super(`storage ${operation} failed${status === undefined ? '' : ` (${status})`}`);
    this.name = 'StorageError';
  }
}

export class ObjectTooLargeError extends Error {
  constructor() {
    super('stored object is larger than allowed');
    this.name = 'ObjectTooLargeError';
  }
}

export interface PresignedPut {
  url: string;
  headers: Record<string, string>;
}

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string | null;
}

export interface ObjectStorage {
  /**
   * Presigned write-once PUT: signed with `Content-Type`, `If-None-Match: *` and
   * `x-amz-checksum-sha256`, returned in `headers` for the uploader to send exactly, and with
   * `Content-Length` = `contentLength`, which is NOT returned: HTTP clients set it from the body,
   * so R2 refuses any body of another size (or a chunked one) before storing it. Deterministic
   * for a given `date`, so an identical retry gets an identical URL.
   */
  presignPut(input: {
    key: string;
    contentType: string;
    sha256Base64: string;
    contentLength: number;
    date: Date;
    expiresSeconds: number;
  }): PresignedPut;
  /** Object bytes, or null when absent. Throws ObjectTooLargeError above `maxBytes`. */
  get(key: string, maxBytes: number): Promise<StoredObject | null>;
  /** Write-once PUT: `exists` when the key is already taken (nothing overwritten). */
  putIfAbsent(
    key: string,
    body: Uint8Array,
    contentType: string,
    sha256Base64: string,
  ): Promise<'created' | 'exists'>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Public URL of a key (under R2_PUBLIC_URL). */
  publicUrl(key: string): string;
}

export interface R2StorageOptions {
  accountId: string;
  bucket: string;
  credentials: SigV4Credentials;
  /** Public base URL of the bucket (https). */
  publicBaseUrl: string;
  /** S3 API endpoint. Default `https://{accountId}.r2.cloudflarestorage.com`. */
  endpoint?: string;
  /** Prepended to every key (used only by the live smoke test, `forge-smoke/...`). */
  keyPrefix?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Extra attempts on network errors and 5xx. Default 2. */
  retries?: number;
  timeoutMs?: number;
}

/** Validity of the URLs FORGE signs for its own requests. */
const INTERNAL_URL_SECONDS = 60;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ObjectTooLargeError();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ObjectTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function createR2Storage(options: R2StorageOptions): ObjectStorage {
  const endpoint = (
    options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`
  ).replace(/\/+$/, '');
  const publicBase = options.publicBaseUrl.replace(/\/+$/, '');
  const prefix = options.keyPrefix ?? '';
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const objectUrl = (key: string) => `${endpoint}/${options.bucket}/${prefix}${key}`;

  function sign(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    headers: Record<string, string>,
    date: Date,
    expiresSeconds: number,
  ) {
    return presign({
      method,
      url: objectUrl(key),
      region: 'auto',
      service: 's3',
      credentials: options.credentials,
      date,
      expiresSeconds,
      headers,
    });
  }

  /** Signed request with retries on network errors and 5xx. Returns the last response. */
  async function send(
    operation: string,
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    headers: Record<string, string> = {},
    body?: Uint8Array,
  ): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
      const signed = sign(method, key, headers, now(), INTERNAL_URL_SECONDS);
      let res: Response;
      try {
        res = await doFetch(signed.url, {
          method,
          headers: signed.headers,
          ...(body ? { body: body as unknown as BodyInit } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt < retries) continue;
        throw new StorageError(operation);
      }
      if (res.status >= 500 && attempt < retries) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      return res;
    }
    throw new StorageError(operation);
  }

  return {
    presignPut({ key, contentType, sha256Base64, contentLength, date, expiresSeconds }) {
      if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
        throw new Error('presignPut: invalid content length');
      }
      const headers = {
        'Content-Type': contentType,
        'If-None-Match': '*',
        'x-amz-checksum-sha256': sha256Base64,
      };
      const signed = sign(
        'PUT',
        key,
        { ...headers, 'Content-Length': String(contentLength) },
        date,
        expiresSeconds,
      );
      return { url: signed.url, headers };
    },

    async get(key, maxBytes) {
      const res = await send('get', 'GET', key);
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new StorageError('get', res.status);
      }
      const bytes = await readCapped(res, maxBytes);
      return { bytes, contentType: res.headers.get('content-type') };
    },

    async putIfAbsent(key, body, contentType, sha256Base64) {
      const res = await send(
        'put',
        'PUT',
        key,
        {
          'Content-Type': contentType,
          'If-None-Match': '*',
          'x-amz-checksum-sha256': sha256Base64,
        },
        body,
      );
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 412) return 'exists';
      if (!res.ok) throw new StorageError('put', res.status);
      return 'created';
    },

    async delete(key) {
      const res = await send('delete', 'DELETE', key);
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok && res.status !== 404) throw new StorageError('delete', res.status);
    },

    publicUrl(key) {
      return `${publicBase}/${prefix}${key}`;
    },
  };
}
