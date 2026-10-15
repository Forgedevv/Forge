import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { base58Encode } from '../../auth/base58';
import type { MintChecker } from '../chain';
import type { UploadRequest } from '../contract';
import { buildLaunchAuthMessage } from '../launch-auth';
import { SlidingWindowLimiter } from '../rate-limit';
import {
  createUploadService,
  type UploadCaller,
  type UploadService,
  type UploadServiceDeps,
} from '../service';
import { createR2Storage } from '../storage';
import { MemoryUploadStore, type LaunchpadRef } from '../store';
import { createFakeR2 } from './fake-r2';

export const T0 = Date.parse('2026-10-11T12:00:00.000Z');
export const CLIENTS_DOMAIN = 'forge-sites.app';
export const ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
export const BUCKET = 'forge-dev';
export const PUBLIC_BASE = 'https://pub-0123456789abcdef0123456789abcdef.r2.dev';
export const CREDENTIALS = {
  accessKeyId: 'TESTACCESSKEYID0123456789ABCDEF0',
  secretAccessKey: 'test-secret-access-key-0123456789abcdef0123456789abcdef01234567',
};

export interface TestWallet {
  address: string;
  privateKey: KeyObject;
}

export function newWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x!;
  return { address: base58Encode(Buffer.from(x, 'base64url')), privateKey };
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A small valid PNG header followed by filler bytes. */
export function pngBytes(size = 1024, fill = 7): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

export const LIVE: LaunchpadRef = {
  id: '6f1c2b8e-4d4a-4c7e-9a43-0c2b5d1e7f10',
  slug: 'moonpad',
  status: 'live',
  coinMint: null,
  siteHost: null,
};

export interface RequestOptions {
  wallet?: TestWallet;
  mint?: string;
  host?: string;
  image?: Uint8Array;
  contentType?: UploadRequest['image']['contentType'];
  name?: string;
  symbol?: string;
  description?: string;
  firstBuyLamports?: string;
  nonce?: string;
  issuedAt?: string;
  /** Sign other fields than the ones sent. */
  signOverride?: Partial<Parameters<typeof buildLaunchAuthMessage>[0]>;
}

let nonceCounter = 0;

export function freshNonce(): string {
  nonceCounter += 1;
  return nonceCounter.toString(16).padStart(32, 'a');
}

/** A request signed by `wallet` exactly as a client site builds it. */
export function signedRequest(options: RequestOptions = {}): UploadRequest {
  const wallet = options.wallet ?? newWallet();
  const image = options.image ?? pngBytes();
  const description = options.description ?? 'The moon coin.';
  const fields = {
    host: options.host ?? `moonpad.${CLIENTS_DOMAIN}`,
    wallet: wallet.address,
    name: options.name ?? 'Moon Coin',
    symbol: options.symbol ?? 'MOON',
    firstBuyLamports: options.firstBuyLamports ?? '100000000',
    imageSha256: sha256Hex(image),
    descriptionSha256: sha256Hex(Buffer.from(description, 'utf8')),
    nonce: options.nonce ?? freshNonce(),
    issuedAt: options.issuedAt ?? new Date(T0).toISOString(),
  };
  const message = buildLaunchAuthMessage({ ...fields, ...options.signOverride });
  const signature = sign(null, Buffer.from(message, 'utf8'), wallet.privateKey).toString('base64');
  return {
    version: 1,
    mint: options.mint ?? newWallet().address,
    wallet: wallet.address,
    coin: { name: fields.name, symbol: fields.symbol, description },
    firstBuyLamports: fields.firstBuyLamports,
    image: {
      contentType: options.contentType ?? 'image/png',
      size: image.length,
      sha256: fields.imageSha256,
    },
    auth: {
      host: fields.host,
      nonce: fields.nonce,
      issuedAt: fields.issuedAt,
      signature,
    },
  };
}

/** The service with the caller optional: by default, the site whose launchpad is in the route. */
export interface TestUploadService {
  issue(
    launchpadParam: string,
    body: unknown,
    caller?: UploadCaller,
  ): ReturnType<UploadService['issue']>;
  complete(
    launchpadParam: string,
    uploadId: string,
    body: unknown,
    caller?: UploadCaller,
  ): ReturnType<UploadService['complete']>;
}

export interface Harness {
  clock: { now: number };
  store: MemoryUploadStore;
  r2: ReturnType<typeof createFakeR2>;
  storage: ReturnType<typeof createR2Storage>;
  service: TestUploadService;
  logs: string[];
  mintChecks: string[];
}

export function harness(
  overrides: Partial<UploadServiceDeps> & { existingAccounts?: string[] } = {},
): Harness {
  const clock = { now: T0 };
  const store = new MemoryUploadStore();
  store.addLaunchpad(LIVE);
  const r2 = createFakeR2({
    credentials: CREDENTIALS,
    endpoint: ENDPOINT,
    bucket: BUCKET,
    now: () => new Date(clock.now),
  });
  const storage = createR2Storage({
    accountId: '0123456789abcdef0123456789abcdef',
    bucket: BUCKET,
    credentials: CREDENTIALS,
    publicBaseUrl: PUBLIC_BASE,
    endpoint: ENDPOINT,
    fetch: r2.fetch,
    now: () => new Date(clock.now),
    sleep: async () => undefined,
  });
  const logs: string[] = [];
  const mintChecks: string[] = [];
  const existing = new Set(overrides.existingAccounts ?? []);
  const mintChecker: MintChecker = {
    async accountExists(address) {
      mintChecks.push(address);
      return existing.has(address);
    },
  };
  const raw = createUploadService({
    store,
    storage,
    clientsDomain: CLIENTS_DOMAIN,
    mintChecker,
    now: () => clock.now,
    limiter: new SlidingWindowLimiter(() => clock.now),
    log: (message) => logs.push(message),
    ...overrides,
  });
  const callerFor = (param: string): UploadCaller => ({
    serverSlug: store.launchpads.get(param.toLowerCase())?.slug ?? param,
  });
  const service: TestUploadService = {
    issue: (param, body, caller) => raw.issue(param, body, caller ?? callerFor(param)),
    complete: (param, uploadId, body, caller) =>
      raw.complete(param, uploadId, body, caller ?? callerFor(param)),
  };
  return { clock, store, r2, storage, service, logs, mintChecks };
}

/** What the client site does with a ticket: PUT the bytes with exactly the ticket headers. */
export async function putImage(
  h: Harness,
  ticket: { image: { uploadUrl: string; headers: Record<string, string> } },
  bytes: Uint8Array,
): Promise<number> {
  const res = await h.r2.fetch(ticket.image.uploadUrl, {
    method: 'PUT',
    headers: ticket.image.headers,
    body: bytes as unknown as BodyInit,
  });
  return res.status;
}
