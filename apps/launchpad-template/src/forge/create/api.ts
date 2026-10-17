import { z } from 'zod';

/**
 * LOCKED ZONE. Client side of the coin preparation API (`POST /api/upload`).
 *
 * The request carries a message signed by the wallet (`auth.ts`). The server checks it, generates
 * the mint, builds the launch transaction on this launchpad's config with @forge/core
 * (`buildUserCoinLaunchTx`: the user is pool creator, fee payer and buyer; a first buy pays the
 * 0.3% FORGE platform fee), signs it with the mint only,
 * stores the image and metadata through the FORGE upload endpoint (write-once keys named after the
 * mint, see `upload-client.ts`; the site holds no storage key) and returns the transaction with a
 * machine-readable summary. The user signs last. The browser never receives a secret key.
 * Server side: `prepare-handler.ts`.
 *
 * The browser does NOT trust the summary: `verify.ts` checks it against the form, decodes every
 * instruction of the transaction and simulates it before anything is shown as "ready to sign".
 */

const Lamports = z.string().regex(/^\d{1,20}$/, 'lamports must be a decimal string');
const SolanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export const LaunchSummaryWire = z.object({
  coinName: z.string(),
  coinSymbol: z.string(),
  /** The wallet that becomes pool creator, i.e. the claimant of the creator fee share. */
  creatorWallet: SolanaAddress,
  /** Coin creation fee paid to the launchpad owner (0 when the launchpad charges none). */
  poolCreationFeeLamports: Lamports,
  firstBuyLamports: Lamports,
  /** Coins the first buy is quoted to deliver, and the minimum the swap accepts (raw units). */
  firstBuyExpectedTokensOut: Lamports,
  firstBuyMinimumTokensOut: Lamports,
  /**
   * FORGE platform fee on the first buy (0.3%, rounded up; "0" without a first buy), transferred
   * to FORGE_PLATFORM_FEE_WALLET by the last instruction. Recomputed by the browser.
   */
  platformFeeLamports: Lamports,
  /** Signature fees and priority fee. Recomputed from the transaction by the browser. */
  estimatedNetworkFeeLamports: Lamports,
  /** Rent-exempt deposit of the new on-chain accounts, read from the cluster by the server. */
  accountRentLamports: Lamports,
  /** Metaplex token metadata creation fee (a program fee, not a deposit). */
  metadataFeeLamports: Lamports,
});

export const PrepareLaunchResponse = z.object({
  success: z.literal(true).optional(),
  /** Base64 transaction, signed by the mint only. */
  poolTx: z.string().min(1),
  mint: SolanaAddress,
  summary: LaunchSummaryWire,
  /**
   * Single-use-per-coin capability to rebuild this exact launch (same mint, image and metadata)
   * with a fresh blockhash or another first buy, without a new upload (`LaunchApi.rebuild`).
   * Absent when the server cannot keep the prepared launch.
   */
  rebuildToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});
export type PrepareLaunchResponse = z.infer<typeof PrepareLaunchResponse>;

export interface PrepareLaunchAuth {
  /** 32 hex characters, single use. */
  nonce: string;
  /** ISO 8601 UTC time the message was signed. */
  issuedAt: string;
  /** Base64 ed25519 signature of `buildLaunchAuthMessage(...)` by `userWallet`. */
  signature: string;
}

export interface PrepareLaunchRequest {
  tokenName: string;
  tokenSymbol: string;
  description: string;
  /** `data:<mime>;base64,<payload>` of the coin image. */
  tokenLogo: string;
  userWallet: string;
  /** Decimal string of lamports. "0" means no first buy. */
  firstBuyLamports: string;
  auth: PrepareLaunchAuth;
}

/**
 * Rebuild of a prepared launch (`POST /api/upload` with a `rebuild` body): the server reuses the
 * mint, the stored image and the metadata of the launch it prepared, and builds a new transaction
 * (fresh blockhash, possibly another first buy). No new upload, no new message signature: the
 * `rebuildToken` handed out with the first answer authorizes it, for the same wallet only.
 */
export interface RebuildLaunchRequest {
  mint: string;
  rebuildToken: string;
  userWallet: string;
  /** Decimal string of lamports. "0" means no first buy. */
  firstBuyLamports: string;
}

export interface LaunchApi {
  prepare(request: PrepareLaunchRequest): Promise<PrepareLaunchResponse>;
  /** Optional: without it, every change goes through a full `prepare`. */
  rebuild?(request: RebuildLaunchRequest): Promise<PrepareLaunchResponse>;
}

/** Stable codes the route may attach to an error answer (`{ error, code }`). */
export type LaunchApiErrorCode =
  /** The prepared launch is unknown or expired on the server: prepare again. */
  | 'prepare_again'
  /** The coin of this mint already exists on-chain. */
  | 'already_launched'
  | 'invalid_input'
  | 'rate_limited';

export class LaunchApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: LaunchApiErrorCode,
  ) {
    super(message);
    this.name = 'LaunchApiError';
  }
}

const KNOWN_CODES: readonly string[] = [
  'prepare_again',
  'already_launched',
  'invalid_input',
  'rate_limited',
];

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const PREPARE_ENDPOINT = '/api/upload';

/** Default implementation: same-origin HTTP call to the template's own API route. */
export function createHttpLaunchApi(doFetch?: FetchLike): LaunchApi {
  const run: FetchLike = doFetch ?? ((input, init) => fetch(input, init));

  async function post(body: unknown): Promise<PrepareLaunchResponse> {
    let res;
    try {
      res = await run(PREPARE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new LaunchApiError('Could not reach the server. Check your connection and retry.');
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new LaunchApiError(
        `The server sent an unreadable answer (error ${res.status}). Try again in a moment.`,
        res.status,
      );
    }
    if (!res.ok) {
      const answer = payload as { error?: unknown; code?: unknown } | null;
      const message =
        typeof answer?.error === 'string' && answer.error.length > 0 && answer.error.length <= 300
          ? answer.error
          : `Could not prepare the coin (error ${res.status}). Try again in a moment.`;
      const code =
        typeof answer?.code === 'string' && KNOWN_CODES.includes(answer.code)
          ? (answer.code as LaunchApiErrorCode)
          : undefined;
      throw new LaunchApiError(message, res.status, code);
    }
    const parsed = PrepareLaunchResponse.safeParse(payload);
    if (!parsed.success) {
      throw new LaunchApiError(
        'The server answer is not in the expected format. Nothing was signed.',
        res.status,
      );
    }
    return parsed.data;
  }

  return {
    prepare: (request) => post(request),
    rebuild: (request) =>
      post({
        rebuild: {
          mint: request.mint,
          token: request.rebuildToken,
          firstBuyLamports: request.firstBuyLamports,
        },
        userWallet: request.userWallet,
      }),
  };
}

/** Reads a File as a `data:` URL. */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.readAsDataURL(file);
  });
}
