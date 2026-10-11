import { z } from 'zod';

/**
 * LOCKED ZONE. Client side of the coin preparation API (`POST /api/upload`).
 *
 * The request carries a message signed by the wallet (`auth.ts`). The server checks it, generates
 * the mint, builds the launch transaction on this launchpad's config (`createPoolWithFirstBuy` when
 * there is a first buy; the user is pool creator, fee payer and buyer), signs it with the mint only,
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

export interface LaunchApi {
  prepare(request: PrepareLaunchRequest): Promise<PrepareLaunchResponse>;
}

export class LaunchApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LaunchApiError';
  }
}

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const PREPARE_ENDPOINT = '/api/upload';

/** Default implementation: same-origin HTTP call to the template's own API route. */
export function createHttpLaunchApi(doFetch?: FetchLike): LaunchApi {
  const run: FetchLike = doFetch ?? ((input, init) => fetch(input, init));
  return {
    async prepare(request) {
      let res;
      try {
        res = await run(PREPARE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });
      } catch {
        throw new LaunchApiError('Could not reach the server. Check your connection and retry.');
      }
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        throw new LaunchApiError('The server sent an unreadable answer.', res.status);
      }
      if (!res.ok) {
        const message =
          typeof (payload as { error?: unknown })?.error === 'string'
            ? (payload as { error: string }).error
            : `The server refused the request (${res.status}).`;
        throw new LaunchApiError(message, res.status);
      }
      const parsed = PrepareLaunchResponse.safeParse(payload);
      if (!parsed.success) {
        throw new LaunchApiError('The server answer is not in the expected format.', res.status);
      }
      return parsed.data;
    },
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
