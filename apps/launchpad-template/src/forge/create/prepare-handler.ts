import type { IncomingHttpHeaders } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import type { SiteMode } from '@forge/shared';
import type { LaunchApiErrorCode, PrepareLaunchResponse } from './api';
import {
  LAUNCH_AUTH_MAX_SKEW_MS,
  LAUNCH_AUTH_TTL_MS,
  NONCE_PATTERN,
  buildLaunchAuthMessage,
  isFreshIssuedAt,
} from './auth';
import { ImageError, checkImageDataUrl } from './image';
import { LaunchBuildError, type LaunchBuilder, type LoadedLaunchpadConfig } from './launch-builder';
import {
  clientIp,
  createNonceStore,
  createPreparedLaunchStore,
  createRateLimiter,
  sha256HexNode,
  verifyWalletSignature,
  type NonceStore,
  type PreparedLaunchStore,
  type RateLimiter,
} from './server-guards';
import { UploadError, UPLOAD_CONTRACT_VERSION, type UploadClient } from './upload-client';
import { FIRST_BUY_MAX_SOL, IMAGE_MAX_BYTES, validateCreateCoin } from './validation';
import { VerificationError, verifyPreparedLaunch } from './verify';
import { canonicalAddress } from '../tx/programs';

/**
 * LOCKED ZONE. Server side of `POST /api/upload` (contract: `api.ts`, signed message: `auth.ts`).
 *
 *   mode guard -> method -> coarse per-IP request limit -> configuration (fail closed) -> bounded
 *   JSON body -> coin rules -> image (type allowlist by magic bytes, 2 MB) -> wallet signature over
 *   the exact request, fresh -> per-IP creation limit -> single-use nonce -> launchpad config read
 *   on-chain -> fresh mint generated here -> image + metadata through the FORGE upload endpoint
 *   (write-once keys, no storage key here) -> launch transaction built through the RPC relay,
 *   signed by the mint only -> checked with the browser verifier
 *   -> `{ success, poolTx, mint, summary, rebuildToken }`.
 *
 * Invalid requests are refused before they use a creation slot: the creation limit only counts
 * requests that passed every check (a visitor fixing a typo is not locked out), while the coarse
 * request limit, taken before the body is read, still bounds any flood.
 *
 * Rebuild (`{ rebuild: { mint, token, firstBuyLamports }, userWallet }`): the same launch (same
 * mint, image and metadata, nothing uploaded again) built again with a fresh blockhash and the
 * given first buy, for the wallet that prepared it, with the capability handed out in the first
 * answer (`createPreparedLaunchStore`). It has its own per-IP limit and a per-launch cap. When the
 * launch is unknown here (expired, another server instance) the answer is 410 `prepare_again`
 * and the browser prepares it again in full.
 *
 * Without the on-chain config, the relay or the FORGE upload endpoint, the route answers 503 and
 * stores nothing: there is no fallback to storage credentials. Error answers are
 * `{ error, code? }` (`LaunchApiErrorCode`).
 */

/** Largest accepted request body: a 2 MB image as base64 plus the other fields. */
export const MAX_BODY_BYTES = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 16 * 1024;
/** Coin creations (uploads) per IP: only requests that passed every check count. */
export const RATE_LIMIT = { limit: 5, windowMs: 10 * 60 * 1000 } as const;
/** Any request per IP, taken before the body is read. */
export const REQUEST_RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 } as const;
/** Rebuilds per IP (no upload, one config read and one build each). */
export const REBUILD_RATE_LIMIT = { limit: 15, windowMs: 10 * 60 * 1000 } as const;
/** How long a prepared launch can be rebuilt. */
export const PREPARED_LAUNCH_TTL_MS = 10 * 60 * 1000;
/** Rebuilds of one prepared launch. */
export const MAX_REBUILDS = 8;
const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

const Lamports = z.string().regex(/^(0|[1-9]\d{0,19})$/);

const PrepareBody = z
  .object({
    tokenName: z.string().max(64),
    tokenSymbol: z.string().max(16),
    description: z.string().max(2000),
    tokenLogo: z.string().max(MAX_BODY_BYTES),
    userWallet: z.string().max(64),
    firstBuyLamports: Lamports,
    auth: z
      .object({
        nonce: z.string().max(64),
        issuedAt: z.string().max(64),
        signature: z.string().max(200),
      })
      .strict(),
  })
  .strict();

const RebuildBody = z
  .object({
    rebuild: z
      .object({
        mint: z.string().max(64),
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        firstBuyLamports: Lamports,
      })
      .strict(),
    userWallet: z.string().max(64),
  })
  .strict();

export interface RequestLike extends AsyncIterable<Uint8Array | string> {
  method?: string;
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string };
}

export interface ResponseLike {
  status(code: number): ResponseLike;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): void;
}

export interface PrepareDeps {
  mode: SiteMode;
  slug: string;
  /** `forge.config.json#onchain.launchpadConfig`. */
  launchpadConfig?: string;
  /** `forge.config.json#onchain.poolCreationFeeSol` in lamports. */
  poolCreationFeeLamports?: bigint;
  /**
   * FORGE_PLATFORM_FEE_WALLET (`launchPlatformFeeWallet()`): the first buy pays its 0.3% fee
   * there. Without it, a coin with a first buy is refused before anything is uploaded.
   */
  platformFeeWallet?: string | null;
  /** Null when the relay or the FORGE API is not configured: the route fails closed. */
  launchBuilder: LaunchBuilder | null;
  uploadClient: UploadClient | null;
  /** Creation limit (`RATE_LIMIT`). */
  limiter?: RateLimiter;
  /** Coarse request limit (`REQUEST_RATE_LIMIT`). */
  requestLimiter?: RateLimiter;
  /** Rebuild limit (`REBUILD_RATE_LIMIT`). */
  rebuildLimiter?: RateLimiter;
  nonces?: NonceStore;
  prepared?: PreparedLaunchStore;
  now?: () => number;
  newMint?: () => Keypair;
  log?: (message: string) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
    readonly code?: LaunchApiErrorCode,
  ) {
    super(message);
  }
}

function tooManyRequests(retryAfterSeconds: number): HttpError {
  return new HttpError(
    429,
    'Too many coin creation requests. Wait a few minutes, then try again.',
    { 'Retry-After': String(retryAfterSeconds) },
    'rate_limited',
  );
}

const PREPARE_AGAIN = 'This launch must be prepared again. Your coin details are kept.';

async function readBody(req: RequestLike, limit: number): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'The request is too large. Images must be 2 MB or smaller.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      throw new HttpError(413, 'The request is too large. Images must be 2 MB or smaller.');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodeSignature(base64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  return bytes.length === 64 ? bytes : null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRebuildRequest(json: unknown): boolean {
  return typeof json === 'object' && json !== null && Object.hasOwn(json, 'rebuild');
}

export function createPrepareHandler(deps: PrepareDeps) {
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? createRateLimiter({ ...RATE_LIMIT, now });
  const requestLimiter = deps.requestLimiter ?? createRateLimiter({ ...REQUEST_RATE_LIMIT, now });
  const rebuildLimiter = deps.rebuildLimiter ?? createRateLimiter({ ...REBUILD_RATE_LIMIT, now });
  const nonces =
    deps.nonces ?? createNonceStore({ ttlMs: LAUNCH_AUTH_TTL_MS + LAUNCH_AUTH_MAX_SKEW_MS, now });
  const prepared =
    deps.prepared ?? createPreparedLaunchStore({ ttlMs: PREPARED_LAUNCH_TTL_MS, now });
  const newMint = deps.newMint ?? (() => Keypair.generate());
  const log = deps.log ?? ((message: string) => console.error(message));

  function checkFirstBuy(raw: string): bigint {
    const firstBuyLamports = BigInt(raw);
    if (firstBuyLamports > BigInt(FIRST_BUY_MAX_SOL) * LAMPORTS_PER_SOL) {
      throw new HttpError(
        400,
        `First buy cannot exceed ${FIRST_BUY_MAX_SOL} SOL.`,
        {},
        'invalid_input',
      );
    }
    if (firstBuyLamports > BigInt(0) && !deps.platformFeeWallet) {
      // The first buy owes the FORGE platform fee and its wallet is not configured.
      throw new HttpError(503, 'Coins with a first buy cannot be created on this site right now.');
    }
    return firstBuyLamports;
  }

  /** Same checks as the browser: never hand out a transaction the user would be told to refuse. */
  function selfVerify(
    response: PrepareLaunchResponse,
    expected: { wallet: string; name: string; symbol: string; firstBuyLamports: bigint },
  ): void {
    try {
      verifyPreparedLaunch(response, {
        ...expected,
        launchpadConfig: deps.launchpadConfig as string,
        poolCreationFeeLamports: deps.poolCreationFeeLamports as bigint,
        referralTokenAccount: null,
        platformFeeWallet: deps.platformFeeWallet ?? null,
      });
    } catch (error) {
      if (error instanceof VerificationError) {
        log(`upload: prepared launch failed self-verification: ${error.message}`);
        throw new HttpError(500, 'Could not prepare the coin. Try again later.');
      }
      throw error;
    }
  }

  async function prepare(req: RequestLike): Promise<PrepareLaunchResponse> {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });

    const ip = clientIp(req.headers, req.socket?.remoteAddress);
    const coarse = requestLimiter.take(ip);
    if (!coarse.allowed) throw tooManyRequests(coarse.retryAfterSeconds);

    const { launchpadConfig, poolCreationFeeLamports, launchBuilder, uploadClient } = deps;
    if (
      !launchpadConfig ||
      poolCreationFeeLamports === undefined ||
      !launchBuilder ||
      !uploadClient
    ) {
      throw new HttpError(503, 'Coin creation is not configured on this site yet.');
    }

    const contentType = firstHeader(req.headers['content-type']) ?? '';
    if (!/^application\/json\b/i.test(contentType)) {
      throw new HttpError(415, 'The request must be JSON.');
    }
    let json: unknown;
    try {
      json = JSON.parse(await readBody(req, MAX_BODY_BYTES));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'The request is not valid JSON.');
    }
    if (isRebuildRequest(json)) return rebuild(json, ip, launchBuilder);

    const parsed = PrepareBody.safeParse(json);
    if (!parsed.success)
      throw new HttpError(400, 'The request is missing fields or has extra ones.');
    const body = parsed.data;

    // Coin rules (same as the form). The browser signs the validated values, so they must be
    // submitted in canonical form.
    const wallet = canonicalAddress(body.userWallet);
    if (!wallet) throw new HttpError(400, 'Invalid wallet address.');
    let image;
    try {
      image = checkImageDataUrl(body.tokenLogo);
    } catch (error) {
      if (error instanceof ImageError) throw new HttpError(error.status, error.message);
      throw error;
    }
    const checked = validateCreateCoin({
      name: body.tokenName,
      symbol: body.tokenSymbol,
      description: body.description,
      image: { name: 'image', type: image.contentType, size: image.bytes.length },
      firstBuySol: '',
    });
    if (!checked.ok) {
      throw new HttpError(
        400,
        Object.values(checked.errors)[0] ?? 'Invalid coin.',
        {},
        'invalid_input',
      );
    }
    const coin = checked.value;
    if (
      coin.name !== body.tokenName ||
      coin.symbol !== body.tokenSymbol ||
      coin.description !== body.description
    ) {
      throw new HttpError(400, 'The coin name, symbol or description is not in canonical form.');
    }
    const firstBuyLamports = checkFirstBuy(body.firstBuyLamports);

    // Wallet authorization: bound to this site, this exact coin and image, fresh and single use.
    const host = (firstHeader(req.headers.host) ?? '').toLowerCase();
    const { nonce, issuedAt } = body.auth;
    if (!host || !NONCE_PATTERN.test(nonce) || !isFreshIssuedAt(issuedAt, now())) {
      throw new HttpError(401, 'The signed request expired or is invalid. Sign again.');
    }
    const signature = decodeSignature(body.auth.signature);
    const imageSha256 = sha256HexNode(image.bytes);
    const message = buildLaunchAuthMessage({
      host,
      wallet,
      name: coin.name,
      symbol: coin.symbol,
      firstBuyLamports: body.firstBuyLamports,
      imageSha256,
      descriptionSha256: sha256HexNode(new TextEncoder().encode(coin.description)),
      nonce,
      issuedAt,
    });
    if (
      !signature ||
      !verifyWalletSignature(wallet, new TextEncoder().encode(message), signature)
    ) {
      throw new HttpError(401, 'The wallet signature does not match this request.');
    }

    // Only a request that passed every check above uses a creation slot.
    const decision = limiter.take(ip);
    if (!decision.allowed) throw tooManyRequests(decision.retryAfterSeconds);
    if (!nonces.consume(wallet, nonce)) {
      throw new HttpError(409, 'This signed request was already used. Sign again.');
    }

    // On-chain config first: nothing is uploaded for a launchpad that cannot create coins.
    let config;
    try {
      config = await launchBuilder.loadConfig();
    } catch (error) {
      throw buildError(error, false);
    }

    const mint = newMint();
    let uploaded;
    try {
      uploaded = await uploadClient.uploadCoin(
        {
          version: UPLOAD_CONTRACT_VERSION,
          mint: mint.publicKey.toBase58(),
          wallet,
          coin: { name: coin.name, symbol: coin.symbol, description: coin.description },
          firstBuyLamports: body.firstBuyLamports,
          image: { contentType: image.contentType, size: image.bytes.length, sha256: imageSha256 },
          auth: { host, nonce, issuedAt, signature: body.auth.signature },
        },
        image.bytes,
      );
    } catch (error) {
      if (error instanceof UploadError) {
        log(
          `upload: FORGE upload endpoint failed (${error.code}${error.status ? ` ${error.status}` : ''})`,
        );
        if (error.code === 'rate_limited') throw tooManyRequests(error.retryAfter ?? 60);
        throw new HttpError(502, 'Could not store the coin image. Try again in a moment.');
      }
      throw error;
    }

    const response = await build(launchBuilder, config, {
      mint,
      wallet,
      name: coin.name,
      symbol: coin.symbol,
      metadataUri: uploaded.metadataUrl,
      firstBuyLamports,
      rebuild: false,
    });

    const rebuildToken = prepared.put({
      wallet,
      name: coin.name,
      symbol: coin.symbol,
      mint,
      metadataUri: uploaded.metadataUrl,
    });
    return { ...response, rebuildToken };
  }

  async function rebuild(
    json: unknown,
    ip: string,
    launchBuilder: LaunchBuilder,
  ): Promise<PrepareLaunchResponse> {
    const parsed = RebuildBody.safeParse(json);
    if (!parsed.success) {
      throw new HttpError(400, 'The request is missing fields or has extra ones.');
    }
    const { rebuild: target, userWallet } = parsed.data;
    const wallet = canonicalAddress(userWallet);
    if (!wallet) throw new HttpError(400, 'Invalid wallet address.');
    const firstBuyLamports = checkFirstBuy(target.firstBuyLamports);

    // Unknown, expired, another wallet's or worn out: the same answer, nothing revealed.
    const launch = prepared.get(target.mint, target.token);
    if (!launch || launch.wallet !== wallet || launch.rebuilds >= MAX_REBUILDS) {
      throw new HttpError(410, PREPARE_AGAIN, {}, 'prepare_again');
    }
    const decision = rebuildLimiter.take(ip);
    if (!decision.allowed) throw tooManyRequests(decision.retryAfterSeconds);
    launch.rebuilds += 1;

    let config;
    try {
      config = await launchBuilder.loadConfig();
    } catch (error) {
      throw buildError(error, true);
    }
    const response = await build(launchBuilder, config, {
      mint: launch.mint,
      wallet,
      name: launch.name,
      symbol: launch.symbol,
      metadataUri: launch.metadataUri,
      firstBuyLamports,
      rebuild: true,
    });
    return { ...response, rebuildToken: target.token };
  }

  async function build(
    launchBuilder: LaunchBuilder,
    config: LoadedLaunchpadConfig,
    input: {
      mint: Keypair;
      wallet: string;
      name: string;
      symbol: string;
      metadataUri: string;
      firstBuyLamports: bigint;
      rebuild: boolean;
    },
  ): Promise<PrepareLaunchResponse> {
    let response: PrepareLaunchResponse;
    try {
      response = await launchBuilder.build(config, input);
    } catch (error) {
      throw buildError(error, input.rebuild);
    }
    selfVerify(response, input);
    return response;
  }

  function buildError(error: unknown, rebuilding: boolean): HttpError {
    if (error instanceof LaunchBuildError) {
      switch (error.code) {
        case 'first_buy_too_large':
        case 'too_large':
          return new HttpError(400, error.message, {}, 'invalid_input');
        case 'invalid_input':
          return new HttpError(400, error.message, {}, 'invalid_input');
        case 'mint_exists':
          return rebuilding
            ? new HttpError(
                409,
                'This coin already exists on-chain: your launch went through. Check your wallet and the coin page.',
                {},
                'already_launched',
              )
            : new HttpError(409, 'Please try again.');
        case 'metadata_invalid':
          log('upload: core refused the stored metadata URI');
          return new HttpError(502, 'Could not store the coin metadata. Try again in a moment.');
        default:
          log(`upload: launchpad config check failed (${error.code})`);
          return new HttpError(503, 'Coin creation is not available on this site right now.');
      }
    }
    log(`upload: chain access failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return new HttpError(502, 'Could not reach the network. Try again in a moment.');
  }

  return async function handle(req: RequestLike, res: ResponseLike, mode: SiteMode = deps.mode) {
    if (mode !== 'live') {
      res.status(503).json({ error: 'This site is not available.' });
      return;
    }
    try {
      const result = await prepare(req);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof HttpError) {
        for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
        res
          .status(error.status)
          .json(error.code ? { error: error.message, code: error.code } : { error: error.message });
        return;
      }
      log(`upload: unexpected error: ${error instanceof Error ? error.message : 'unknown'}`);
      res.status(500).json({ error: 'Could not prepare the coin. Try again later.' });
    }
  };
}
