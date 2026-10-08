import { z } from 'zod';

/**
 * LOCKED ZONE. Client side of the coin preparation API (`POST /api/upload`).
 *
 * The server stores the image and metadata (R2), generates the mint, builds the launch
 * transaction (`createPoolWithFirstBuy` when there is a first buy), signs it with the mint (and
 * with the pool creator when that is not the user, using a durable nonce so it does not expire
 * while the user reads the summary), and returns it with a machine-readable summary. The user is
 * the fee payer and the buyer and signs last. The browser never receives a secret key.
 *
 * The browser does NOT trust the summary: `verify.ts` checks it against the form and decodes the
 * transaction before anything is shown as "ready to sign".
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
  /** Signature fees and priority fee. */
  estimatedNetworkFeeLamports: Lamports,
  /** Rent-exempt deposit of the new on-chain accounts, read from the cluster by the server. */
  accountRentLamports: Lamports,
});

export const PrepareLaunchResponse = z.object({
  success: z.literal(true).optional(),
  /** Base64 transaction, partially signed (mint, and creator if not the user). */
  poolTx: z.string().min(1),
  mint: SolanaAddress,
  summary: LaunchSummaryWire,
});
export type PrepareLaunchResponse = z.infer<typeof PrepareLaunchResponse>;

export interface PrepareLaunchRequest {
  tokenName: string;
  tokenSymbol: string;
  description: string;
  /** `data:<mime>;base64,<payload>` of the coin image. */
  tokenLogo: string;
  userWallet: string;
  /** Decimal string of lamports. "0" means no first buy. */
  firstBuyLamports: string;
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
