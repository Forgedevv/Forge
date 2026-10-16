import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { IMAGE_TYPES, type ImageType } from '../uploads/contract';
import { sniffImageType } from '../uploads/image';
import { checkFetchUrl, isPublicAddress } from './address';

/*
 * Download of an image from a public https URL given by a launchpad owner, built against SSRF:
 *
 * - every URL (the first one and each redirect target) must pass `checkFetchUrl`: https, default
 *   port, no credentials, a DNS host name (no IP literal, no local-only name);
 * - the host is resolved here and EVERY address it resolves to must be public (`isPublicAddress`:
 *   no private, loopback, link-local, CGNAT, multicast, reserved, IPv6 ULA or link-local, ...);
 * - the connection is pinned to a checked address (the socket's DNS lookup is replaced by one
 *   that answers that address), so a second resolution cannot point it elsewhere; TLS still
 *   verifies the certificate against the host name;
 * - redirects are followed by hand, at most MAX_REDIRECTS, each one checked like the first URL;
 * - one deadline (TIMEOUT_MS) covers DNS, every hop and the body;
 * - the body is streamed and abandoned beyond MAX_BYTES (a larger Content-Length is refused
 *   before reading);
 * - only PNG, JPEG, WebP and GIF are accepted, recognised by their magic bytes. A declared
 *   Content-Type must be one of these (and match the bytes) or a generic binary type.
 *
 * Errors carry a reason code only: never the URL, a response header or body bytes.
 */

export const TIMEOUT_MS = 10_000;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const USER_AGENT =
  'Mozilla/5.0 (compatible; FORGE-CoinImage/1.0; +https://github.com/Forgedevv/Forge)';

export type ImageFetchFailure =
  | 'invalid_url'
  | 'blocked_address'
  | 'dns'
  | 'redirect'
  | 'too_many_redirects'
  | 'http_status'
  | 'timeout'
  | 'network'
  | 'too_large'
  | 'unsupported_type'
  | 'not_an_image';

export class ImageFetchError extends Error {
  constructor(
    readonly reason: ImageFetchFailure,
    /** HTTP status of the last response, when the failure is about one. */
    readonly status?: number,
  ) {
    super(`image fetch failed (${reason}${status === undefined ? '' : `, ${status}`})`);
    this.name = 'ImageFetchError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address of `host` (A and AAAA). */
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

export interface TransportResponse {
  status: number;
  /** First value of a response header (lowercase name), if present. */
  header(name: string): string | undefined;
  body: AsyncIterable<Uint8Array>;
  /** Closes the connection without reading the rest of the body. */
  discard(): void;
}

/** One GET of `url` over a connection to exactly `address`. Never follows redirects. */
export type PinnedTransport = (input: {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<TransportResponse>;

export interface FetchImageOptions {
  resolve?: Resolver;
  transport?: PinnedTransport;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface FetchedImage {
  bytes: Uint8Array;
  /** Detected from the magic bytes. */
  contentType: ImageType;
}

export const systemResolver: Resolver = async (host) => {
  const records = await dnsLookup(host, { all: true });
  return records
    .filter((r) => r.family === 4 || r.family === 6)
    .map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

/** A socket lookup that ignores the host name and answers `address` (connection pinning). */
export function pinnedLookup(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
}

export const nodeHttpsTransport: PinnedTransport = ({ url, address, headers, signal }) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        // A fresh connection per request: no pooled socket of another pin is ever reused.
        agent: false,
        servername: url.hostname.replace(/\.$/, ''),
        lookup: pinnedLookup(address),
        signal,
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          header(name) {
            const value = res.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
          },
          body: res,
          discard: () => res.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);
const TYPE_ALIASES: Record<string, ImageType> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
};

/** Declared type: an accepted image type, `generic` (absent or binary) or null (refused). */
function declaredType(header: string | undefined): ImageType | 'generic' | null {
  if (header === undefined) return 'generic';
  const essence = header.split(';')[0]?.trim().toLowerCase() ?? '';
  if (essence === '' || GENERIC_TYPES.has(essence)) return 'generic';
  const alias = TYPE_ALIASES[essence];
  if (alias) return alias;
  return (IMAGE_TYPES as readonly string[]).includes(essence) ? (essence as ImageType) : null;
}

/** The checked target of a redirect (relative locations resolve against `base`), or null. */
function redirectTarget(location: string | undefined, base: URL): URL | null {
  if (!location) return null;
  try {
    return checkFetchUrl(new URL(location, base));
  } catch {
    return null;
  }
}

function pickAddress(addresses: readonly ResolvedAddress[]): ResolvedAddress {
  // IPv4 first: some serverless egress networks have no IPv6 route.
  const first = addresses.find((a) => a.family === 4) ?? addresses[0];
  if (!first) throw new ImageFetchError('dns');
  return first;
}

async function readCapped(res: TransportResponse, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      res.discard();
      throw new ImageFetchError('too_large');
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Downloads the image at `rawUrl` under the rules above. Throws ImageFetchError. */
export async function fetchPublicImage(
  rawUrl: string,
  options: FetchImageOptions = {},
): Promise<FetchedImage> {
  const resolve = options.resolve ?? systemResolver;
  const transport = options.transport ?? nodeHttpsTransport;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  const expired = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new ImageFetchError('timeout')), {
      once: true,
    });
  });
  expired.catch(() => undefined);
  const inTime = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired]);

  try {
    let url = checkFetchUrl(rawUrl);
    if (!url) throw new ImageFetchError('invalid_url');
    for (let hop = 0; ; hop++) {
      let addresses: ResolvedAddress[];
      try {
        addresses = await inTime(resolve(url.hostname));
      } catch (error) {
        if (error instanceof ImageFetchError) throw error;
        throw new ImageFetchError('dns');
      }
      if (addresses.length === 0) throw new ImageFetchError('dns');
      if (!addresses.every((a) => isPublicAddress(a.address))) {
        throw new ImageFetchError('blocked_address');
      }

      let res: TransportResponse;
      try {
        res = await inTime(
          transport({
            url,
            address: pickAddress(addresses),
            headers: {
              'User-Agent': USER_AGENT,
              Accept: IMAGE_TYPES.join(', '),
              'Accept-Encoding': 'identity',
            },
            signal: controller.signal,
          }),
        );
      } catch (error) {
        if (error instanceof ImageFetchError) throw error;
        throw new ImageFetchError(controller.signal.aborted ? 'timeout' : 'network');
      }

      try {
        if (REDIRECTS.has(res.status)) {
          res.discard();
          if (hop >= maxRedirects) throw new ImageFetchError('too_many_redirects', res.status);
          const next = redirectTarget(res.header('location'), url);
          if (!next) throw new ImageFetchError('redirect', res.status);
          url = next;
          continue;
        }
        if (res.status !== 200) throw new ImageFetchError('http_status', res.status);

        const declared = declaredType(res.header('content-type'));
        if (declared === null) throw new ImageFetchError('unsupported_type');
        const length = Number(res.header('content-length'));
        if (Number.isFinite(length) && length > maxBytes) throw new ImageFetchError('too_large');

        const bytes = await inTime(readCapped(res, maxBytes));
        const sniffed = sniffImageType(bytes);
        if (sniffed === null) throw new ImageFetchError('not_an_image');
        if (declared !== 'generic' && declared !== sniffed) {
          throw new ImageFetchError('not_an_image');
        }
        return { bytes, contentType: sniffed };
      } catch (error) {
        res.discard();
        if (error instanceof ImageFetchError) throw error;
        // The body stream broke (aborted on the deadline, or the connection dropped).
        throw new ImageFetchError(controller.signal.aborted ? 'timeout' : 'network');
      }
    }
  } finally {
    clearTimeout(timer);
    // Ends any request still open (only on failure: a success has read its body to the end).
    controller.abort();
  }
}
