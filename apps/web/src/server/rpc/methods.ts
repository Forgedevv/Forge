import { z } from 'zod';

/*
 * JSON-RPC method allowlist of the relay, with per-method parameter validation and weights.
 *
 * Only what FORGE code calls through the relay is allowed: the client-site template (trade panel,
 * coin creation, creator claims, its server route /api/upload), @forge/core helpers it runs, and
 * the FORGE site's browser client (wallet adapter, launch signing, partner fee claims). Each entry
 * says who needs it. Everything else is refused with -32601, in particular:
 * - getProgramAccounts in any shape but two (a program scan is very expensive and its response is
 *   unbounded; the coin lists come from the Jupiter data API). The shapes allowed are the queries
 *   of the Meteora SDK's `getPoolsByCreator` and `getPoolsByConfig`: the DBC program, a pool
 *   account discriminator at offset 0 and one 32-byte key at offset 104 (creator: the creator fee
 *   claim finds the coins a wallet created) or at offset 72 (config: the on-chain fallback of a
 *   client site's coin list, server-token callers only, see `isConfigPoolsScan`), base64 data,
 *   nothing else (no dataSlice, dataSize, withContext, minContextSlot or extra filter). Any other
 *   shape answers -32601 too, like a refused method;
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
/**
 * Most writable accounts of one `getRecentPrioritizationFees` call: what @forge/core sends at most
 * (`MAX_PRIORITY_FEE_ACCOUNTS`, a test compares them); the RPC itself accepts 128.
 */
export const MAX_PRIORITY_FEE_ACCOUNTS = 32;
/**
 * Rate-limit units of one priority fee read: answered from the node's in-memory cache of the
 * last 150 slots (about 6 KB at most), a little more than an account read.
 */
export const PRIORITY_FEES_WEIGHT = 2;

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

/**
 * Meteora Dynamic Bonding Curve program (same id on devnet and mainnet). Kept here so the relay
 * route does not load the transaction core; a test checks it against @forge/core.
 */
export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

/**
 * Anchor account discriminators of the two DBC pool accounts (`VirtualPool`, `TransferHookPool`,
 * IDL of SDK 1.5.13): `getPoolsByCreator` sends one query for each.
 */
export const DBC_POOL_DISCRIMINATORS: readonly (readonly number[])[] = [
  [213, 224, 5, 209, 98, 69, 119, 92],
  [237, 219, 184, 23, 42, 189, 169, 35],
];

/** Offset of the pool creator in a DBC pool account (8-byte discriminator + `PoolState`). */
export const DBC_POOL_CREATOR_OFFSET = 104;

/** Offset of the pool config in a DBC pool account (the SDK's `getPoolsByConfig` filter). */
export const DBC_POOL_CONFIG_OFFSET = 72;

/** Rate-limit units of one creator pool query (a program scan, about 10x an account read). */
export const CREATOR_POOLS_WEIGHT = 20;

/**
 * Rate-limit units of one config pool query: a program scan whose answer holds every coin of a
 * launchpad (larger than a creator's), served to server-token callers only, which cache it.
 */
export const CONFIG_POOLS_WEIGHT = 30;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decodes a short base58 string (at most 64 characters), or null when it is not base58. */
export function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0 || value.length > 64) return null;
  let n = BigInt(0);
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    n = n * BigInt(58) + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > BigInt(0)) {
    bytes.unshift(Number(n & BigInt(0xff)));
    n >>= BigInt(8);
  }
  for (const char of value) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function sameBytes(a: Uint8Array, b: readonly number[]): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** A memcmp filter at exactly `offset`, base58 bytes (web3.js adds `encoding: 'base58'`). */
const memcmpAt = (offset: number, bytes: z.ZodType<string>) =>
  z.strictObject({
    memcmp: z.strictObject({
      offset: z.literal(offset),
      bytes,
      encoding: z.literal('base58').optional(),
    }),
  });

const PoolDiscriminator = z.string().refine((value) => {
  const bytes = decodeBase58(value);
  return bytes !== null && DBC_POOL_DISCRIMINATORS.some((d) => sameBytes(bytes, d));
}, 'not a DBC pool account discriminator');

const Key32 = z.string().refine((value) => {
  const bytes = decodeBase58(value);
  return bytes !== null && bytes.length === 32;
}, 'not a 32-byte key');

/**
 * Config of a pool query on one 32-byte key at `offset`, exactly as web3.js 1.x sends the SDK's
 * `getPoolsByCreator` / `getPoolsByConfig`:
 * `{ encoding: 'base64', commitment?, filters: [discriminator @0, key @offset] }`.
 */
const poolsByKeyConfig = (offset: number) =>
  z.strictObject({
    encoding: z.literal('base64'),
    commitment: Commitment.optional(),
    filters: z.tuple([memcmpAt(0, PoolDiscriminator), memcmpAt(offset, Key32)]),
  });

const CreatorPoolsConfig = poolsByKeyConfig(DBC_POOL_CREATOR_OFFSET);
const ConfigPoolsConfig = poolsByKeyConfig(DBC_POOL_CONFIG_OFFSET);

const creatorPoolsParams = (params: unknown) =>
  positional([z.literal(DBC_PROGRAM_ID), CreatorPoolsConfig])(params);
const configPoolsParams = (params: unknown) =>
  positional([z.literal(DBC_PROGRAM_ID), ConfigPoolsConfig])(params);

/**
 * True when `params` are the config pool query (`getPoolsByConfig`). The handler serves it to
 * server-token callers only (a client site's server route, which caches it): a browser, a
 * sleeping site or an anonymous caller gets -32601, as for any refused scan.
 */
export function isConfigPoolsScan(params: unknown): boolean {
  return configPoolsParams(params) === null;
}

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
  /**
   * Invalid params answer -32601 (method not allowed) instead of -32602, without a reason: the
   * method is allowed in one narrow shape only, and every other use of it is a refused method.
   */
  narrow?: true;
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
  getRecentPrioritizationFees: {
    usedBy:
      'core priority fees of the transactions it builds (template swaps, coin creation and creator fee claims, FORGE site claims): the recent fees of the accounts the transaction writes',
    // web3.js sends [] without accounts, [[addresses]] with them; nothing else.
    validate: positional([], [z.array(Pubkey).min(1).max(MAX_PRIORITY_FEE_ACCOUNTS)]),
    weight: () => PRIORITY_FEES_WEIGHT,
    retryable: true,
  },
  getProgramAccounts: {
    usedBy:
      'template creator fee claim: core listCoinsOfCreator (SDK getPoolsByCreator), DBC pools of one creator; template /api/coins (server token only): core listPoolStatesOfConfig (SDK getPoolsByConfig), DBC pools of one config',
    validate: (params) =>
      creatorPoolsParams(params) === null || configPoolsParams(params) === null
        ? null
        : 'not an allowed program scan',
    weight: (p) => (isConfigPoolsScan(p) ? CONFIG_POOLS_WEIGHT : CREATOR_POOLS_WEIGHT),
    retryable: true,
    narrow: true,
  },
};

export function isAllowedMethod(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(METHODS, method);
}

export const ALLOWED_METHODS: readonly string[] = Object.freeze(Object.keys(METHODS));

/**
 * What the browser of a sleeping site may call (origins.ts, kind `sleeping`): the one action left
 * on a sleeping site is the creator fee claim (decision D29, template `ClaimCreatorFees`), so only
 * the methods that claim sends are served. Everything else (trades, simulations, coin creation)
 * answers -32601.
 */
export const SLEEPING_SITE_METHODS: ReadonlySet<string> = new Set([
  // Coins of the wallet: core listCoinsOfCreator (SDK getPoolsByCreator). The config pool query
  // is server-token only (handler.ts), so it is refused here too.
  'getProgramAccounts',
  // Pool and config (SDK fetchers), the wallet's coin account (SDK getOrCreateATAInstruction).
  'getAccountInfo',
  // Core claim build: the receiver's coin account, the temporary WSOL account, the receiver.
  'getMultipleAccounts',
  // Core claim build: token account rent, read from the cluster.
  'getMinimumBalanceForRentExemption',
  // Core claim build: the claim transaction's blockhash.
  'getLatestBlockhash',
  // Template chain client: balance check before signing.
  'getBalance',
  // Template chain client: the signed claim, then confirmation by polling.
  'sendTransaction',
  'getSignatureStatuses',
  // Core claim build: the claim's priority fee (recent fees of the accounts it writes).
  'getRecentPrioritizationFees',
]);
