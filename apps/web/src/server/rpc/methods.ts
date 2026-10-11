import { z } from 'zod';

/*
 * JSON-RPC method allowlist of the relay, with per-method parameter validation and weights.
 *
 * Only what FORGE code calls through the relay is allowed: the client-site template (trade panel,
 * coin creation, creator claims, its server route /api/upload), @forge/core helpers it runs, and
 * the FORGE site's browser client (wallet adapter, launch signing, partner fee claims). Each entry
 * says who needs it. Everything else is refused with -32601, in particular:
 * - getProgramAccounts (scans a whole program: very expensive, unbounded responses; the coin lists
 *   come from the Jupiter data API);
 * - getSignaturesForAddress / getTransaction (history indexing; payment checks run server side on
 *   FORGE's own connection, not through the relay);
 * - requestAirdrop, subscriptions, getLargestAccounts, getTokenLargestAccounts, getVoteAccounts...
 *
 * Params are validated positionally and strictly (unknown config keys are refused) against what
 * @solana/web3.js 1.x sends. Sizes are bounded: at most MAX_MULTIPLE_ACCOUNTS keys,
 * MAX_SIGNATURE_STATUSES signatures, transactions/messages of at most PACKET_DATA_SIZE bytes.
 */

/** Largest serialized transaction (bytes), the Solana packet data size. */
export const PACKET_DATA_SIZE = 1232;
/** Largest account size the runtime allows (10 MiB). */
export const MAX_ACCOUNT_DATA_BYTES = 10 * 1024 * 1024;
export const MAX_MULTIPLE_ACCOUNTS = 20;
export const MAX_SIGNATURE_STATUSES = 16;
export const MAX_SIMULATION_ACCOUNTS = 8;
export const MAX_SEND_RETRIES = 10;

const Pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
/** Only the three current commitment levels (the deprecated aliases are refused). */
const Commitment = z.enum(['processed', 'confirmed', 'finalized']);
const Slot = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const DataSlice = z.strictObject({
  offset: z.number().int().min(0).max(MAX_ACCOUNT_DATA_BYTES),
  length: z.number().int().min(0).max(MAX_ACCOUNT_DATA_BYTES),
});
/** base58 is refused (slow, limited to 128 bytes); web3.js always asks for base64. */
const AccountEncoding = z.enum(['base64', 'base64+zstd', 'jsonParsed']);

const base64Bytes = (maxBytes: number) =>
  z
    .string()
    .min(4)
    .max(4 * Math.ceil(maxBytes / 3))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((v) => v.length % 4 === 0, 'invalid base64 padding')
    .refine((v) => Buffer.from(v, 'base64').length <= maxBytes, `more than ${maxBytes} bytes`);

const WireTransaction = base64Bytes(PACKET_DATA_SIZE);

const CommitmentConfig = z.strictObject({ commitment: Commitment.optional() });
const ContextConfig = z.strictObject({
  commitment: Commitment.optional(),
  minContextSlot: Slot.optional(),
});
const AccountConfig = z.strictObject({
  commitment: Commitment.optional(),
  encoding: AccountEncoding.optional(),
  dataSlice: DataSlice.optional(),
  minContextSlot: Slot.optional(),
});

const SimulateConfig = z
  .strictObject({
    encoding: z.literal('base64'),
    sigVerify: z.boolean().optional(),
    replaceRecentBlockhash: z.boolean().optional(),
    commitment: Commitment.optional(),
    minContextSlot: Slot.optional(),
    innerInstructions: z.boolean().optional(),
    accounts: z
      .strictObject({
        addresses: z.array(Pubkey).max(MAX_SIMULATION_ACCOUNTS),
        encoding: AccountEncoding.optional(),
      })
      .optional(),
  })
  .refine((c) => !(c.sigVerify === true && c.replaceRecentBlockhash === true), {
    message: 'sigVerify and replaceRecentBlockhash cannot both be true',
  });

const SendConfig = z.strictObject({
  encoding: z.literal('base64'),
  skipPreflight: z.boolean().optional(),
  preflightCommitment: Commitment.optional(),
  maxRetries: z.number().int().min(0).max(MAX_SEND_RETRIES).optional(),
  minContextSlot: Slot.optional(),
});

/** Positional params: `required` first, then up to `optional.length` more. */
function positional(required: z.ZodType[], optional: z.ZodType[] = []) {
  return (params: unknown): string | null => {
    if (params === undefined) {
      return required.length === 0 ? null : 'params are required';
    }
    if (!Array.isArray(params)) return 'params must be an array';
    if (params.length < required.length) return 'missing params';
    if (params.length > required.length + optional.length) return 'too many params';
    const schemas = [...required, ...optional];
    for (let i = 0; i < params.length; i++) {
      const schema = schemas[i];
      const value: unknown = params[i];
      // web3.js never sends explicit nulls, but a trailing `undefined` config serializes as null.
      if (i >= required.length && value === null) continue;
      const result = schema?.safeParse(value);
      if (!result || !result.success) return `invalid param ${i}`;
    }
    return null;
  };
}

export interface MethodSpec {
  /** Who calls it through the relay (documentation; kept next to the rule). */
  usedBy: string;
  /** Returns null when the params are valid, otherwise a short reason (safe to return). */
  validate(params: unknown): string | null;
  /** Rate-limit units of one call (params are already validated). */
  weight(params: unknown[]): number;
  /** Draws from the sendTransaction bucket. */
  isSend?: true;
  /** Safe to retry upstream on a transport error (reads and simulations). */
  retryable: boolean;
}

const one = () => 1;
const parsedSurcharge = (config: unknown): number =>
  typeof config === 'object' &&
  config !== null &&
  (config as { encoding?: unknown }).encoding === 'jsonParsed'
    ? 1
    : 0;

export const METHODS: Readonly<Record<string, MethodSpec>> = {
  getAccountInfo: {
    usedBy: 'core reads (pool, config, lookup tables via getAddressLookupTable), template balances',
    validate: positional([Pubkey], [AccountConfig]),
    weight: (p) => 1 + parsedSurcharge(p[1]),
    retryable: true,
  },
  getMultipleAccounts: {
    usedBy: 'core swap/pool/claims/gating snapshots (3 to 5 keys), template coin creation',
    validate: positional([z.array(Pubkey).min(1).max(MAX_MULTIPLE_ACCOUNTS)], [AccountConfig]),
    weight: (p) =>
      1 + Math.ceil((Array.isArray(p[0]) ? p[0].length : 1) / 5) + parsedSurcharge(p[1]),
    retryable: true,
  },
  getBalance: {
    usedBy: 'template wallet balances (SOL), chain client of the coin creation',
    validate: positional([Pubkey], [ContextConfig]),
    weight: one,
    retryable: true,
  },
  getLatestBlockhash: {
    usedBy: 'every transaction built in the browser or the template server',
    validate: positional([], [ContextConfig]),
    weight: one,
    retryable: true,
  },
  getMinimumBalanceForRentExemption: {
    usedBy: 'core and template rent checks (rent is read from the cluster, never hardcoded)',
    validate: positional([z.number().int().min(0).max(MAX_ACCOUNT_DATA_BYTES)], [CommitmentConfig]),
    weight: one,
    retryable: true,
  },
  getSignatureStatuses: {
    usedBy: 'confirmation by polling (core confirmSignature, template, FORGE site)',
    validate: positional(
      [z.array(Signature).min(1).max(MAX_SIGNATURE_STATUSES)],
      [z.strictObject({ searchTransactionHistory: z.boolean().optional() })],
    ),
    weight: (p) =>
      1 +
      ((p[1] as { searchTransactionHistory?: unknown } | null | undefined)
        ?.searchTransactionHistory === true
        ? 2
        : 0),
    retryable: true,
  },
  getBlockHeight: {
    usedBy: 'confirmation deadline (lastValidBlockHeight) in core and the template',
    validate: positional([], [ContextConfig]),
    weight: one,
    retryable: true,
  },
  getSlot: {
    usedBy: 'core swap quotes (activation point of the pool)',
    validate: positional([], [ContextConfig]),
    weight: one,
    retryable: true,
  },
  getBlockTime: {
    usedBy: 'core swap quotes (timestamp-based activation and anti-sniper schedule)',
    validate: positional([Slot]),
    weight: one,
    retryable: true,
  },
  getTokenAccountsByOwner: {
    usedBy: 'wallet token balance of one mint (mint filter only: no whole-program listing)',
    validate: positional([Pubkey, z.strictObject({ mint: Pubkey })], [AccountConfig]),
    weight: (p) => 3 + parsedSurcharge(p[2]),
    retryable: true,
  },
  getTokenAccountBalance: {
    usedBy: 'wallet token balance of one token account',
    validate: positional([Pubkey], [CommitmentConfig]),
    weight: one,
    retryable: true,
  },
  simulateTransaction: {
    usedBy: 'template trade and send helper (simulate before asking the wallet to sign)',
    validate: positional([WireTransaction, SimulateConfig]),
    weight: () => 5,
    retryable: true,
  },
  sendTransaction: {
    usedBy: 'template trades, coin creation and claims; FORGE site launch and fee claims',
    validate: positional([WireTransaction, SendConfig]),
    weight: () => 10,
    isSend: true,
    retryable: false,
  },
  getFeeForMessage: {
    usedBy: 'core pool launch (estimated network fee shown before signing)',
    validate: positional([base64Bytes(PACKET_DATA_SIZE)], [ContextConfig]),
    weight: one,
    retryable: true,
  },
  getEpochInfo: {
    usedBy: 'wallet adapters and web3.js helpers (cheap, no account data)',
    validate: positional([], [ContextConfig]),
    weight: one,
    retryable: true,
  },
};

export function isAllowedMethod(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(METHODS, method);
}

export const ALLOWED_METHODS: readonly string[] = Object.freeze(Object.keys(METHODS));
