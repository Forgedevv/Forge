import { createHash } from 'node:crypto';
import { presignParts, type SigV4Credentials } from '../sigv4';

/*
 * In-memory stand-in for the R2 S3 API, reached through `fetch`: it checks every presigned URL
 * exactly like R2 would (signature over the signed headers, `Content-Length` included, expiry),
 * then applies the write-once (`If-None-Match: *`) and checksum (`x-amz-checksum-sha256`) rules.
 */

export interface FakeObject {
  bytes: Uint8Array;
  contentType: string | null;
}

export interface FakeR2Options {
  credentials: SigV4Credentials;
  endpoint: string;
  bucket: string;
  now: () => Date;
}

export interface FakeR2Call {
  method: string;
  key: string;
  status: number;
}

function parseAmzDate(value: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) throw new Error('bad X-Amz-Date');
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

function headerMap(init: RequestInit | undefined): Map<string, string> {
  const map = new Map<string, string>();
  new Headers(init?.headers).forEach((value, name) => map.set(name.toLowerCase(), value));
  return map;
}

function bodyBytes(body: unknown): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return body;
  throw new Error('fake R2: unsupported body');
}

export function createFakeR2(options: FakeR2Options) {
  const objects = new Map<string, FakeObject>();
  const calls: FakeR2Call[] = [];
  /** Set to make the next N requests fail with this status (or a network error when 0). */
  const failures: number[] = [];
  const root = new URL(options.endpoint);

  function reply(
    method: string,
    key: string,
    status: number,
    body?: BodyInit,
    headers?: HeadersInit,
  ) {
    calls.push({ method, key, status });
    return new Response(status === 204 || method === 'HEAD' ? null : (body ?? null), {
      status,
      headers,
    });
  }

  async function fetchImpl(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const prefix = `/${options.bucket}/`;
    if (url.origin !== root.origin || !url.pathname.startsWith(prefix)) {
      return reply(method, url.pathname, 404);
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));

    const failure = failures.shift();
    if (failure === 0) {
      calls.push({ method, key, status: 0 });
      throw new TypeError('fetch failed');
    }
    if (failure !== undefined) return reply(method, key, failure);

    // Presigned URL checks.
    const q = url.searchParams;
    const signature = q.get('X-Amz-Signature');
    const signedNames = (q.get('X-Amz-SignedHeaders') ?? '').split(';');
    const date = parseAmzDate(q.get('X-Amz-Date') ?? '');
    const expires = Number(q.get('X-Amz-Expires'));
    if (!signature || !signedNames.includes('host')) return reply(method, key, 403);
    if (options.now().getTime() > date.getTime() + expires * 1000) {
      return reply(method, key, 403);
    }
    const sent = headerMap(init);
    // Like any HTTP client, fetch sends Content-Length from a body of known size.
    if (init?.body !== undefined && init.body !== null && !sent.has('content-length')) {
      sent.set('content-length', String(bodyBytes(init.body).length));
    }
    const signedHeaders: Record<string, string> = {};
    for (const name of signedNames) {
      if (name === 'host') continue;
      const value = sent.get(name);
      if (value === undefined) return reply(method, key, 403);
      signedHeaders[name] = value;
    }
    const objectUrl = `${url.origin}${url.pathname}`;
    const expected = presignParts({
      method: method as 'GET' | 'PUT' | 'DELETE' | 'HEAD',
      url: objectUrl,
      region: 'auto',
      service: 's3',
      credentials: options.credentials,
      date,
      expiresSeconds: expires,
      headers: signedHeaders,
    });
    const credential = q.get('X-Amz-Credential') ?? '';
    if (
      expected.signature !== signature ||
      !credential.startsWith(`${options.credentials.accessKeyId}/`)
    ) {
      return reply(method, key, 403);
    }

    switch (method) {
      case 'PUT': {
        const bytes = bodyBytes(init?.body);
        if (sent.get('if-none-match') === '*' && objects.has(key)) return reply(method, key, 412);
        const checksum = sent.get('x-amz-checksum-sha256');
        if (checksum !== undefined) {
          const actual = createHash('sha256').update(bytes).digest('base64');
          if (actual !== checksum) return reply(method, key, 400);
        }
        objects.set(key, {
          bytes: Uint8Array.from(bytes),
          contentType: sent.get('content-type') ?? null,
        });
        return reply(method, key, 200);
      }
      case 'GET': {
        const object = objects.get(key);
        if (!object) return reply(method, key, 404);
        const headers: Record<string, string> = { 'content-length': String(object.bytes.length) };
        if (object.contentType) headers['content-type'] = object.contentType;
        return reply(method, key, 200, Buffer.from(object.bytes), headers);
      }
      case 'DELETE':
        objects.delete(key);
        return reply(method, key, 204);
      default:
        return reply(method, key, 405);
    }
  }

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    objects,
    calls,
    failures,
  };
}

export type FakeR2 = ReturnType<typeof createFakeR2>;
