import type { IncomingHttpHeaders } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import type { SiteMode } from '@forge/shared';
import type { PrepareLaunchResponse } from './api';
import {
  LAUNCH_AUTH_MAX_SKEW_MS,
  LAUNCH_AUTH_TTL_MS,
  NONCE_PATTERN,
  buildLaunchAuthMessage,
  isFreshIssuedAt,
} from './auth';
import { ImageError, checkImageDataUrl } from './image';
import { LaunchBuildError, type LaunchBuilder } from './launch-builder';
import {
  clientIp,
  createNonceStore,
  createRateLimiter,
  sha256HexNode,
  verifyWalletSignature,
  type NonceStore,
  type RateLimiter,
} from './server-guards';
import { UploadError, UPLOAD_CONTRACT_VERSION, type UploadClient } from './upload-client';
import { FIRST_BUY_MAX_SOL, IMAGE_MAX_BYTES, validateCreateCoin } from './validation';
import { VerificationError, verifyPreparedLaunch } from './verify';
import { canonicalAddress } from '../tx/programs';

/**
 * LOCKED ZONE. Server side of `POST /api/upload` (contract: `api.ts`, signed message: `auth.ts`).
 *
 *   mode guard -> method -> per-IP rate limit -> configuration (fail closed) -> bounded JSON body
 *   -> coin rules -> image (type allowlist by magic bytes, 2 MB) -> wallet signature over the exact
 *   request, fresh, single-use nonce -> launchpad config read on-chain -> fresh mint generated here
 *   -> image + metadata through the FORGE upload endpoint (write-once keys, no storage key here)
 *   -> launch transaction built through the RPC relay, signed by the mint only -> checked with the
 *   browser verifier -> `{ success, poolTx, mint, summary }`.
 *
 * Without the on-chain config, the relay or the FORGE upload endpoint, the route answers 503 and
 * stores nothing: there is no fallback to storage credentials.
 */

/** Largest accepted request body: a 2 MB image as base64 plus the other fields. */
export const MAX_BODY_BYTES = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 16 * 1024;
export const RATE_LIMIT = { limit: 5, windowMs: 10 * 60 * 1000 } as const;
const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

const PrepareBody = z
  .object({
    tokenName: z.string().max(64),
    tokenSymbol: z.string().max(16),
    description: z.string().max(2000),
    tokenLogo: z.string().max(MAX_BODY_BYTES),
    userWallet: z.string().max(64),
    firstBuyLamports: z.string().regex(/^(0|[1-9]\d{0,19})$/),
    auth: z
      .object({
        nonce: z.string().max(64),
        issuedAt: z.string().max(64),
        signature: z.string().max(200),
      })
      .strict(),
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
  limiter?: RateLimiter;
  nonces?: NonceStore;
  now?: () => number;
  newMint?: () => Keypair;
  log?: (message: string) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

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

export function createPrepareHandler(deps: PrepareDeps) {
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? createRateLimiter({ ...RATE_LIMIT, now });
  const nonces =
    deps.nonces ?? createNonceStore({ ttlMs: LAUNCH_AUTH_TTL_MS + LAUNCH_AUTH_MAX_SKEW_MS, now });
  const newMint = deps.newMint ?? (() => Keypair.generate());
  const log = deps.log ?? ((message: string) => console.error(message));

  async function prepare(req: RequestLike): Promise<PrepareLaunchResponse> {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });

    const ip = clientIp(req.headers, req.socket?.remoteAddress);
    const decision = limiter.take(ip);
    if (!decision.allowed) {
      throw new HttpError(429, 'Too many coin creation requests. Try again later.', {
        'Retry-After': String(decision.retryAfterSeconds),
      });
    }

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
      throw new HttpError(400, Object.values(checked.errors)[0] ?? 'Invalid coin.');
    }
    const coin = checked.value;
    if (
      coin.name !== body.tokenName ||
      coin.symbol !== body.tokenSymbol ||
      coin.description !== body.description
    ) {
      throw new HttpError(400, 'The coin name, symbol or description is not in canonical form.');
    }
    const firstBuyLamports = BigInt(body.firstBuyLamports);
    if (firstBuyLamports > BigInt(FIRST_BUY_MAX_SOL) * LAMPORTS_PER_SOL) {
      throw new HttpError(400, `First buy cannot exceed ${FIRST_BUY_MAX_SOL} SOL.`);
    }
    if (firstBuyLamports > BigInt(0) && !deps.platformFeeWallet) {
      // The first buy owes the FORGE platform fee and its wallet is not configured.
      throw new HttpError(503, 'Coins with a first buy cannot be created on this site right now.');
    }

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
    if (!nonces.consume(wallet, nonce)) {
      throw new HttpError(409, 'This signed request was already used. Sign again.');
    }

    // On-chain config first: nothing is uploaded for a launchpad that cannot create coins.
    let config;
    try {
      config = await launchBuilder.loadConfig();
    } catch (error) {
      throw buildError(error);
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
        if (error.code === 'rate_limited') {
          throw new HttpError(429, 'Too many coin creation requests. Try again later.', {
            'Retry-After': String(error.retryAfter ?? 60),
          });
        }
        throw new HttpError(502, 'Could not store the coin image. Try again in a moment.');
      }
      throw error;
    }

    let response: PrepareLaunchResponse;
    try {
      response = await launchBuilder.build(config, {
        mint,
        wallet,
        name: coin.name,
        symbol: coin.symbol,
        metadataUri: uploaded.metadataUrl,
        firstBuyLamports,
      });
    } catch (error) {
      throw buildError(error);
    }

    // Same checks as the browser: never hand out a transaction the user would be told to refuse.
    try {
      verifyPreparedLaunch(response, {
        wallet,
        name: coin.name,
        symbol: coin.symbol,
        firstBuyLamports,
        launchpadConfig,
        poolCreationFeeLamports,
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
    return response;
  }

  function buildError(error: unknown): HttpError {
    if (error instanceof LaunchBuildError) {
      switch (error.code) {
        case 'first_buy_too_large':
        case 'too_large':
          return new HttpError(400, error.message);
        case 'mint_exists':
          return new HttpError(409, 'Please try again.');
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
        res.status(error.status).json({ error: error.message });
        return;
      }
      log(`upload: unexpected error: ${error instanceof Error ? error.message : 'unknown'}`);
      res.status(500).json({ error: 'Could not prepare the coin. Try again later.' });
    }
  };
}
