import { randomBytes } from 'node:crypto';
import { isCanonicalPublicKey } from '../auth/base58';
import { ChainReadError, type MintChecker } from './chain';
import {
  COMPLETE_WINDOW_SECONDS,
  CompleteRequest,
  IMAGE_MAX_BYTES,
  MAX_METADATA_URL_BYTES,
  TICKET_TTL_SECONDS,
  UPLOAD_ID_PATTERN,
  UPLOAD_RATE_LIMITS,
  UploadHttpError,
  UploadRequest,
  type UploadReceipt,
  type UploadTicket,
} from './contract';
import { sniffImageType } from './image';
import { imageKey, metadataKey, uploadKey } from './keys';
import {
  buildLaunchAuthMessage,
  isFreshIssuedAt,
  sha256Hex,
  verifyLaunchAuth,
} from './launch-auth';
import { retryAfter, SlidingWindowLimiter, type WindowRule } from './rate-limit';
import {
  ObjectTooLargeError,
  StorageError,
  type ObjectStorage,
  type StoredObject,
} from './storage';
import { UploadStoreError, type LaunchpadRef, type TicketRecord, type UploadStore } from './store';

/*
 * Coin upload tickets for client sites (contract v1, see contract.ts).
 *
 * The route handlers (handlers.ts) have already checked the per-IP and per-token limits and the
 * calling site's server token; `caller.serverSlug` is the launchpad that token names.
 *
 * Issue:    strict body -> fresh `issuedAt` -> ed25519 signature over the exact v1 message ->
 *           per-instance wallet limit -> launchpad (slug or uuid) is the token's and live ->
 *           `auth.host` is the launchpad's domain (`<slug>.<CLIENTS_DOMAIN>`) or its recorded
 *           `site_host`, exactly -> `(wallet, nonce)` already seen? identical
 *           body: same ticket, other body: 409 -> durable limits per wallet and per launchpad ->
 *           mint never used (tickets, launchpad coins, on-chain account) -> ticket stored (unique
 *           constraints decide races) -> presigned write-once PUT to the staging key, size signed.
 * Complete: launchpad is the token's -> ticket of this launchpad and mint -> public image key
 *           already written by an earlier attempt? reuse it; otherwise the staged image is read
 *           back: size, SHA-256, magic bytes and type must match (else it is deleted and the
 *           ticket rejected), then FORGE writes the verified bytes to the public image key
 *           (write-once) and deletes the staged copy -> metadata JSON written write-once ->
 *           ticket completed. Every step is idempotent.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{3,32}$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
/** Largest metadata JSON read back when checking an existing object. */
const MAX_METADATA_BYTES = 16 * 1024;

export interface UploadServiceDeps {
  store: UploadStore;
  storage: ObjectStorage;
  /**
   * Client sites are served at `<slug>.<clientsDomain>` (and at their recorded `site_host`). Null:
   * only recorded site hosts, and local hosts (if allowed).
   */
  clientsDomain: string | null;
  /** Accept `localhost`/`127.0.0.1` hosts (never in production). */
  allowLocalHosts?: boolean;
  /** Null skips the on-chain freshness check of the mint. */
  mintChecker: MintChecker | null;
  now?: () => number;
  newUploadId?: () => string;
  limiter?: SlidingWindowLimiter;
  log?: (message: string) => void;
}

/** The calling client site, as authenticated by its server token (handlers.ts). */
export interface UploadCaller {
  /** Launchpad slug named by the `X-Forge-Relay-Token` of the request. */
  serverSlug: string;
}

export interface UploadService {
  issue(launchpadParam: string, body: unknown, caller: UploadCaller): Promise<UploadTicket>;
  complete(
    launchpadParam: string,
    uploadId: string,
    body: unknown,
    caller: UploadCaller,
  ): Promise<UploadReceipt>;
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

/** Canonical form of a request, hashed to recognise an identical retry. */
export function requestFingerprint(body: UploadRequest): string {
  return sha256Hex(
    JSON.stringify([
      body.version,
      body.mint,
      body.wallet,
      body.coin.name,
      body.coin.symbol,
      body.coin.description,
      body.firstBuyLamports,
      body.image.contentType,
      body.image.size,
      body.image.sha256,
      body.auth.host,
      body.auth.nonce,
      body.auth.issuedAt,
      body.auth.signature,
    ]),
  );
}

/** Exact bytes of the metadata JSON (fixed key order, so a retry writes the same bytes). */
export function metadataBytes(ticket: TicketRecord, imagePublicUrl: string): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      name: ticket.coinName,
      symbol: ticket.coinSymbol,
      description: ticket.coinDescription,
      image: imagePublicUrl,
    }),
    'utf8',
  );
}

function rateLimited(seconds: number): UploadHttpError {
  return new UploadHttpError(
    429,
    'RATE_LIMITED',
    'Too many coin uploads. Try again later.',
    seconds,
  );
}

export function createUploadService(deps: UploadServiceDeps): UploadService {
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? new SlidingWindowLimiter(now);
  const newUploadId = deps.newUploadId ?? (() => randomBytes(16).toString('base64url'));
  const log = deps.log ?? ((message: string) => console.error(message));
  const { store, storage } = deps;

  function take(key: string, rule: WindowRule): void {
    const decision = limiter.take(key, rule);
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
  }

  async function durableLimit(
    filter: { wallet: string } | { launchpadId: string },
    rule: WindowRule,
  ): Promise<void> {
    const t = now();
    const issued = await store.recentIssues(filter, new Date(t - rule.windowMs), rule.limit);
    if (issued.length >= rule.limit) {
      throw rateLimited(retryAfter(issued[0]?.getTime() ?? t, rule, t));
    }
  }

  async function findLaunchpad(param: string): Promise<LaunchpadRef> {
    let launchpad: LaunchpadRef | null = null;
    if (UUID.test(param)) launchpad = await store.findLaunchpad({ id: param.toLowerCase() });
    else if (SLUG.test(param)) launchpad = await store.findLaunchpad({ slug: param });
    if (!launchpad) {
      throw new UploadHttpError(404, 'LAUNCHPAD_NOT_FOUND', 'This launchpad does not exist.');
    }
    return launchpad;
  }

  function requireCaller(launchpad: LaunchpadRef, caller: UploadCaller): void {
    if (launchpad.slug !== caller.serverSlug) {
      throw new UploadHttpError(
        403,
        'SERVER_TOKEN_MISMATCH',
        'This server token belongs to another launchpad.',
      );
    }
  }

  function requireLive(launchpad: LaunchpadRef): void {
    if (launchpad.status !== 'live') {
      throw new UploadHttpError(
        403,
        'LAUNCHPAD_NOT_LIVE',
        'Coin creation is not available on this launchpad right now.',
      );
    }
  }

  /**
   * `auth.host` must be a host of THIS launchpad's site: `<slug>.<CLIENTS_DOMAIN>`, or exactly the
   * production host the builder recorded for it (`site_host`, read from the Vercel API for its own
   * project). Never a pattern: a look-alike `*.vercel.app` name of another project is refused.
   */
  function checkHost(host: string, launchpad: LaunchpadRef): void {
    if (deps.allowLocalHosts && LOCAL_HOST.test(host)) return;
    if (launchpad.siteHost !== null && host === launchpad.siteHost) return;
    if (!deps.clientsDomain && launchpad.siteHost === null) {
      log('uploads: CLIENTS_DOMAIN is not set, no client site host can be accepted');
      throw new UploadHttpError(503, 'NOT_CONFIGURED', 'Coin uploads are not configured yet.');
    }
    if (!deps.clientsDomain || host !== `${launchpad.slug}.${deps.clientsDomain}`) {
      throw new UploadHttpError(
        403,
        'HOST_MISMATCH',
        'This signed request was made for another site.',
      );
    }
  }

  function toTicket(ticket: TicketRecord): UploadTicket {
    const put = storage.presignPut({
      key: ticket.uploadKey,
      contentType: ticket.contentType,
      sha256Base64: hexToBase64(ticket.imageSha256),
      contentLength: ticket.imageSize,
      date: ticket.issuedAt,
      expiresSeconds: TICKET_TTL_SECONDS,
    });
    return {
      uploadId: ticket.id,
      expiresAt: ticket.expiresAt.toISOString(),
      image: {
        uploadUrl: put.url,
        method: 'PUT',
        headers: put.headers,
        publicUrl: storage.publicUrl(ticket.imageKey),
      },
      metadata: { publicUrl: storage.publicUrl(ticket.metadataKey) },
    };
  }

  function toReceipt(ticket: TicketRecord): UploadReceipt {
    if (!ticket.metadataSha256) throw new UploadStoreError('receipt', 'no_metadata_hash');
    return {
      image: { publicUrl: storage.publicUrl(ticket.imageKey), sha256: ticket.imageSha256 },
      metadata: { publicUrl: storage.publicUrl(ticket.metadataKey), sha256: ticket.metadataSha256 },
    };
  }

  /** The stored ticket for a request that reused its nonce: identical body or 409. */
  function sameRequest(existing: TicketRecord, fingerprint: string, launchpadId: string) {
    if (existing.requestSha256 === fingerprint && existing.launchpadId === launchpadId) {
      return toTicket(existing);
    }
    throw new UploadHttpError(
      409,
      'NONCE_USED',
      'This signed request was already used. Sign again.',
    );
  }

  function mintUsed(): UploadHttpError {
    return new UploadHttpError(409, 'MINT_USED', 'This coin address is already used. Try again.');
  }

  async function issue(
    launchpadParam: string,
    raw: unknown,
    caller: UploadCaller,
  ): Promise<UploadTicket> {
    const parsed = UploadRequest.safeParse(raw);
    if (!parsed.success) {
      throw new UploadHttpError(
        400,
        'BAD_REQUEST',
        'The upload request is missing fields or has invalid or extra ones.',
      );
    }
    const body = parsed.data;
    if (!isCanonicalPublicKey(body.wallet) || !isCanonicalPublicKey(body.mint)) {
      throw new UploadHttpError(400, 'BAD_REQUEST', 'Invalid wallet or mint address.');
    }
    if (body.wallet === body.mint) {
      throw new UploadHttpError(400, 'BAD_REQUEST', 'The mint cannot be the wallet.');
    }

    // Wallet authorization: fresh, and signed over this exact coin, image and site.
    const t = now();
    if (!isFreshIssuedAt(body.auth.issuedAt, t)) {
      throw new UploadHttpError(401, 'AUTH_EXPIRED', 'The signed request expired. Sign again.');
    }
    const message = buildLaunchAuthMessage({
      host: body.auth.host,
      wallet: body.wallet,
      name: body.coin.name,
      symbol: body.coin.symbol,
      firstBuyLamports: body.firstBuyLamports,
      imageSha256: body.image.sha256,
      descriptionSha256: sha256Hex(Buffer.from(body.coin.description, 'utf8')),
      nonce: body.auth.nonce,
      issuedAt: body.auth.issuedAt,
    });
    if (!verifyLaunchAuth(body.wallet, message, body.auth.signature)) {
      throw new UploadHttpError(
        401,
        'BAD_SIGNATURE',
        'The wallet signature does not match this request.',
      );
    }

    take(`wallet:${body.wallet}`, UPLOAD_RATE_LIMITS.wallet);
    const launchpad = await findLaunchpad(launchpadParam);
    requireCaller(launchpad, caller);
    requireLive(launchpad);
    checkHost(body.auth.host, launchpad);

    // `(wallet, nonce)` is single use; an identical retry gets the same ticket back.
    const fingerprint = requestFingerprint(body);
    const existing = await store.findTicketByNonce(body.wallet, body.auth.nonce);
    if (existing) return sameRequest(existing, fingerprint, launchpad.id);

    take(`launchpad:${launchpad.id}`, UPLOAD_RATE_LIMITS.launchpad);
    await durableLimit({ wallet: body.wallet }, UPLOAD_RATE_LIMITS.wallet);
    await durableLimit({ launchpadId: launchpad.id }, UPLOAD_RATE_LIMITS.launchpad);

    if (body.mint === launchpad.coinMint || (await store.isMintTaken(body.mint))) throw mintUsed();
    if (deps.mintChecker) {
      let exists: boolean;
      try {
        exists = await deps.mintChecker.accountExists(body.mint);
      } catch (error) {
        if (error instanceof ChainReadError) {
          throw new UploadHttpError(
            503,
            'CHAIN_UNAVAILABLE',
            'Could not reach the network. Try again in a moment.',
          );
        }
        throw error;
      }
      if (exists) throw mintUsed();
    }

    const issuedAt = new Date(Math.floor(t / 1000) * 1000);
    const ticket: TicketRecord = {
      id: newUploadId(),
      launchpadId: launchpad.id,
      wallet: body.wallet,
      nonce: body.auth.nonce,
      requestSha256: fingerprint,
      mint: body.mint,
      host: body.auth.host,
      contentType: body.image.contentType,
      imageSize: body.image.size,
      imageSha256: body.image.sha256,
      uploadKey: uploadKey(launchpad.slug, body.mint, body.image.contentType),
      imageKey: imageKey(launchpad.slug, body.mint, body.image.contentType),
      metadataKey: metadataKey(launchpad.slug, body.mint),
      coinName: body.coin.name,
      coinSymbol: body.coin.symbol,
      coinDescription: body.coin.description,
      firstBuyLamports: body.firstBuyLamports,
      status: 'issued',
      rejection: null,
      metadataSha256: null,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + TICKET_TTL_SECONDS * 1000),
      completedAt: null,
      sweptAt: null,
    };
    if (!UPLOAD_ID_PATTERN.test(ticket.id)) throw new UploadStoreError('new upload id', 'bad_id');
    const metadataUrl = storage.publicUrl(ticket.metadataKey);
    if (Buffer.byteLength(metadataUrl, 'utf8') > MAX_METADATA_URL_BYTES) {
      log('uploads: R2_PUBLIC_URL is too long for a 200-byte metadata URI');
      throw new UploadHttpError(503, 'NOT_CONFIGURED', 'Coin uploads are not configured yet.');
    }

    const inserted = await store.insertTicket(ticket);
    if (!inserted.ok) {
      // Lost a race. A concurrent identical request wins with its ticket, whichever unique
      // constraint the database reported first.
      const winner = await store.findTicketByNonce(body.wallet, body.auth.nonce);
      if (winner) return sameRequest(winner, fingerprint, launchpad.id);
      if (inserted.conflict === 'mint') throw mintUsed();
      throw new UploadStoreError('insert ticket', inserted.conflict);
    }
    return toTicket(ticket);
  }

  /**
   * Deletes the staged image and rejects the ticket. The presigned URL stays valid until it
   * expires and may stage new bytes: they never reach a public key (complete refuses a rejected
   * ticket) and the sweep deletes them once the URL is dead.
   */
  async function reject(ticket: TicketRecord, reason: string): Promise<never> {
    await storage.delete(ticket.uploadKey);
    await store.markRejected(ticket.id, reason);
    log(`uploads: stored image rejected (${reason}) for upload ${ticket.id}`);
    throw new UploadHttpError(
      422,
      'IMAGE_REJECTED',
      'The stored image does not match the upload request and was deleted. Start again.',
    );
  }

  async function writeMetadata(ticket: TicketRecord): Promise<string> {
    const bytes = metadataBytes(ticket, storage.publicUrl(ticket.imageKey));
    const sha = sha256Hex(bytes);
    const written = await storage.putIfAbsent(
      ticket.metadataKey,
      bytes,
      'application/json',
      hexToBase64(sha),
    );
    if (written === 'exists') {
      // Written by an earlier attempt of this same ticket? Then it holds the very same bytes.
      const current = await storage.get(ticket.metadataKey, MAX_METADATA_BYTES).catch((error) => {
        if (error instanceof ObjectTooLargeError) return null;
        throw error;
      });
      if (!current || sha256Hex(current.bytes) !== sha) {
        log(`uploads: metadata object already exists with other content for upload ${ticket.id}`);
        throw new UploadHttpError(
          409,
          'METADATA_CONFLICT',
          'Metadata already exists for this coin. Start again.',
        );
      }
    }
    return sha;
  }

  function imageConflict(ticket: TicketRecord): UploadHttpError {
    log(`uploads: public image already exists with other content for upload ${ticket.id}`);
    return new UploadHttpError(
      409,
      'IMAGE_CONFLICT',
      'An image already exists for this coin. Start again.',
    );
  }

  /** The verified image at its public key: true when written there (now or by an earlier try). */
  async function publicImageMatches(ticket: TicketRecord): Promise<boolean> {
    let current: StoredObject | null;
    try {
      current = await storage.get(ticket.imageKey, IMAGE_MAX_BYTES);
    } catch (error) {
      if (error instanceof ObjectTooLargeError) throw imageConflict(ticket);
      throw error;
    }
    if (!current) return false;
    if (sha256Hex(current.bytes) !== ticket.imageSha256) throw imageConflict(ticket);
    return true;
  }

  /** Verifies the staged image and writes it to the public key; rejects the ticket on mismatch. */
  async function promoteStagedImage(ticket: TicketRecord): Promise<void> {
    let stored: StoredObject | null;
    try {
      stored = await storage.get(ticket.uploadKey, IMAGE_MAX_BYTES);
    } catch (error) {
      if (error instanceof ObjectTooLargeError) return reject(ticket, 'too_large');
      throw error;
    }
    if (!stored) {
      throw new UploadHttpError(409, 'IMAGE_MISSING', 'Upload the image before completing.');
    }
    const storedType = stored.contentType?.split(';')[0]?.trim().toLowerCase() ?? null;
    if (stored.bytes.length !== ticket.imageSize) return reject(ticket, 'size');
    if (sha256Hex(stored.bytes) !== ticket.imageSha256) return reject(ticket, 'sha256');
    if (sniffImageType(stored.bytes) !== ticket.contentType) return reject(ticket, 'magic_bytes');
    if (storedType !== null && storedType !== ticket.contentType) {
      return reject(ticket, 'content_type');
    }
    const written = await storage.putIfAbsent(
      ticket.imageKey,
      stored.bytes,
      ticket.contentType,
      hexToBase64(ticket.imageSha256),
    );
    // `exists`: a concurrent attempt of this ticket won; it must hold the very same bytes.
    if (written === 'exists' && !(await publicImageMatches(ticket))) throw imageConflict(ticket);
  }

  async function complete(
    launchpadParam: string,
    uploadId: string,
    raw: unknown,
    caller: UploadCaller,
  ): Promise<UploadReceipt> {
    const notFound = () =>
      new UploadHttpError(404, 'UPLOAD_NOT_FOUND', 'This upload does not exist.');
    if (!UPLOAD_ID_PATTERN.test(uploadId)) throw notFound();
    const parsed = CompleteRequest.safeParse(raw);
    if (!parsed.success) {
      throw new UploadHttpError(400, 'BAD_REQUEST', 'The request must be { "mint": "<mint>" }.');
    }
    take(`complete:${uploadId}`, UPLOAD_RATE_LIMITS.complete);

    const launchpad = await findLaunchpad(launchpadParam);
    requireCaller(launchpad, caller);
    const ticket = await store.findTicketById(uploadId);
    if (!ticket || ticket.launchpadId !== launchpad.id) throw notFound();
    if (ticket.mint !== parsed.data.mint) {
      throw new UploadHttpError(400, 'BAD_REQUEST', 'The mint does not match this upload.');
    }

    if (ticket.status === 'completed') return toReceipt(ticket);
    if (ticket.status === 'rejected') {
      throw new UploadHttpError(
        422,
        'IMAGE_REJECTED',
        'The stored image did not match the upload request and was deleted. Start again.',
      );
    }
    const expired = () =>
      new UploadHttpError(410, 'UPLOAD_EXPIRED', 'This upload expired. Start again.');
    if (ticket.status === 'expired') throw expired();
    requireLive(launchpad);
    if (now() > ticket.issuedAt.getTime() + COMPLETE_WINDOW_SECONDS * 1000) throw expired();

    // A retry after the public image was written skips straight to the metadata.
    if (!(await publicImageMatches(ticket))) await promoteStagedImage(ticket);
    await storage.delete(ticket.uploadKey);

    const metadataSha256 = await writeMetadata(ticket);
    const done = await store.markCompleted(ticket.id, metadataSha256, new Date(now()));
    if (!done) throw new UploadStoreError('complete ticket', 'missing');
    if (done.status === 'expired') throw expired();
    if (done.status !== 'completed') {
      throw new UploadHttpError(
        422,
        'IMAGE_REJECTED',
        'The stored image did not match the upload request and was deleted. Start again.',
      );
    }
    return toReceipt(done);
  }

  return { issue, complete };
}

/** Maps any failure of the service to an UploadHttpError (and logs unexpected ones). */
export function toUploadHttpError(error: unknown, log: (message: string) => void): UploadHttpError {
  if (error instanceof UploadHttpError) return error;
  if (error instanceof StorageError) {
    log(`uploads: ${error.message}`);
    return new UploadHttpError(
      502,
      'STORAGE_UNAVAILABLE',
      'The image storage is unavailable. Try again in a moment.',
    );
  }
  if (error instanceof UploadStoreError) {
    log(`uploads: ${error.message}`);
    return new UploadHttpError(500, 'SERVER_ERROR', 'Could not process the upload. Try again.');
  }
  log(`uploads: unexpected ${error instanceof Error ? error.name : 'error'}`);
  return new UploadHttpError(500, 'SERVER_ERROR', 'Could not process the upload. Try again.');
}
