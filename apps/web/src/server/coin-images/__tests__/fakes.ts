import { createR2Storage, type ObjectStorage } from '../../uploads/storage';
import { createFakeR2, type FakeR2 } from '../../uploads/__tests__/fake-r2';
import type { PinnedTransport, ResolvedAddress, Resolver, TransportResponse } from '../fetch-image';

/*
 * Fakes of the coin image fetcher's network (DNS and the pinned HTTPS GET) and of R2, so the
 * tests run without any socket.
 */

export const ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
export const BUCKET = 'forge-dev';
export const PUBLIC_BASE = 'https://pub-0123456789abcdef0123456789abcdef.r2.dev';
export const CREDENTIALS = {
  accessKeyId: 'TESTACCESSKEYID0123456789ABCDEF0',
  secretAccessKey: 'test-secret-access-key-0123456789abcdef0123456789abcdef01234567',
};

export const PUBLIC_V4 = '93.184.216.34';

/** A small valid PNG signature followed by filler bytes. */
export function pngBytes(size = 1024, fill = 7): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

export function jpegBytes(size = 512): Uint8Array {
  const bytes = new Uint8Array(size).fill(1);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

export interface FakeReply {
  status: number;
  headers?: Record<string, string>;
  /** Body chunks (one chunk when a single array is given). */
  body?: Uint8Array | Uint8Array[];
  /** Never resolves the request (the deadline must end it). */
  hang?: boolean;
}

export interface TransportCall {
  url: string;
  address: ResolvedAddress;
  headers: Record<string, string>;
}

/** DNS answers by host name; an unknown host fails like ENOTFOUND. */
export function fakeResolver(table: Record<string, string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const resolve = (host: string) => {
    calls.push(host);
    const addresses = table[host];
    if (!addresses)
      return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    return Promise.resolve(
      addresses.map((address) => ({ address, family: (address.includes(':') ? 6 : 4) as 4 | 6 })),
    );
  };
  return Object.assign(resolve, { calls });
}

/** Replies by full URL; records every request and whether each response was discarded. */
export function fakeTransport(
  replies: Record<string, FakeReply>,
): PinnedTransport & { calls: TransportCall[]; discarded: number } {
  const calls: TransportCall[] = [];
  const state = { discarded: 0 };
  const transport: PinnedTransport = ({ url, address, headers, signal }) => {
    calls.push({ url: url.href, address, headers });
    const reply = replies[url.href];
    if (!reply) return Promise.reject(new Error('ECONNREFUSED'));
    if (reply.hang) {
      return new Promise<TransportResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    const chunks =
      reply.body === undefined ? [] : Array.isArray(reply.body) ? reply.body : [reply.body];
    const headerMap = new Map(
      Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let discarded = false;
    const response: TransportResponse = {
      status: reply.status,
      header: (name) => headerMap.get(name.toLowerCase()),
      body: (async function* () {
        for (const chunk of chunks) {
          if (discarded) throw new Error('read after discard');
          yield chunk;
        }
      })(),
      discard: () => {
        if (!discarded) state.discarded += 1;
        discarded = true;
      },
    };
    return Promise.resolve(response);
  };
  // A live getter (Object.assign would copy the current value only).
  return Object.defineProperties(transport, {
    calls: { value: calls },
    discarded: { get: () => state.discarded },
  }) as PinnedTransport & { calls: TransportCall[]; discarded: number };
}

export interface StorageHarness {
  r2: FakeR2;
  storage: ObjectStorage;
  /** Headers of every PUT sent to R2, lowercase names. */
  puts: { key: string; headers: Record<string, string> }[];
}

/** The real R2 storage client over the in-memory R2 of the uploads tests. */
export function storageHarness(now = () => new Date('2026-10-16T12:00:00.000Z')): StorageHarness {
  const r2 = createFakeR2({ credentials: CREDENTIALS, endpoint: ENDPOINT, bucket: BUCKET, now });
  const puts: StorageHarness['puts'] = [];
  const recording = ((input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
      puts.push({ key: decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length)), headers });
    }
    return r2.fetch(input, init);
  }) as typeof fetch;
  const storage = createR2Storage({
    accountId: '0123456789abcdef0123456789abcdef',
    bucket: BUCKET,
    credentials: CREDENTIALS,
    publicBaseUrl: PUBLIC_BASE,
    endpoint: ENDPOINT,
    fetch: recording,
    now,
    sleep: () => Promise.resolve(),
  });
  return { r2, storage, puts };
}
