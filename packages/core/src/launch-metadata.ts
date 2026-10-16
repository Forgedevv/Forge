/**
 * Pure checks of what a coin launch writes on-chain: the token metadata (name, symbol, URI) and
 * the first buy amount. Shared by the launch builders (pool.ts) and the config builder
 * (config.ts), so that `/v1/configs` refuses a launchpad coin that could never be launched BEFORE
 * any config is paid for (docs/DECISIONS.md D18: a failure after the configs exist is manual).
 *
 * Two limits apply to the metadata:
 * - the Metaplex protocol limits (`METADATA_LIMITS`, UTF-8 bytes): name 32, symbol 10, URI 200.
 *   A user coin launch (`buildUserCoinLaunchTx`) fits all of them at once;
 * - the launchpad coin launch (`buildLaunchCoinTx` as the signer builds it: durable nonce held by
 *   the creator wallet, no priority fee, a first buy) is a bigger transaction (one more signer,
 *   the nonce advance) and only holds `LAUNCH_METADATA_BUDGET_BYTES` bytes of name + symbol + URI
 *   in the 1,232-byte packet: a 200-byte URI does NOT fit there.
 */
import type { LaunchpadSpec } from '@forge/shared';
import { MAX_FIRST_BUY_SOL, solToLamports } from './constants.js';

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type LaunchCoinErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_MISMATCH'
  | 'POOL_EXISTS'
  | 'MINT_EXISTS'
  /** A referral was given for the first buy: it would lose the first-swap minimum fee. */
  | 'REFERRAL_UNSUPPORTED'
  | 'RENT_PAYER_REFUSED'
  | 'FIRST_BUY_EXCEEDS_CURVE'
  | 'QUOTE_FAILED'
  | 'UNEXPECTED_SIGNERS'
  | 'TX_TOO_LARGE'
  /** FORGE_PLATFORM_FEE_WALLET does not exist or is not rent-exempt (user coin launch). */
  | 'PLATFORM_FEE_WALLET_NOT_READY';

/** The launch transaction cannot be built. Nothing has been sent. */
export class LaunchCoinError extends Error {
  readonly code: LaunchCoinErrorCode;

  constructor(code: LaunchCoinErrorCode, message: string) {
    super(message);
    this.name = 'LaunchCoinError';
    this.code = code;
  }
}

function fail(code: LaunchCoinErrorCode, message: string): never {
  throw new LaunchCoinError(code, message);
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/**
 * Metaplex token metadata limits, in UTF-8 bytes (protocol limits). The launchpad coin launch is
 * tighter: see `LAUNCH_METADATA_BUDGET_BYTES`.
 */
export const METADATA_LIMITS = { name: 32, symbol: 10, uri: 200 } as const;

/**
 * Combined UTF-8 budget of name + symbol + metadata URI in the launchpad coin launch transaction
 * built by the signer (durable nonce held by the creator wallet, no priority fee, with a first
 * buy): every byte of the three strings is one byte of the transaction, and a 32-byte name, a
 * 10-byte symbol and a 106-byte URI land at exactly 1,232 bytes (pool.test.ts, "size"). A smaller
 * launch (no first buy, no nonce) has more room; this is the bound for the signer's shape.
 */
export const LAUNCH_METADATA_BUDGET_BYTES = 148;

/** Largest first buy (the spec bound, `launchpadCoin.firstBuySol` <= 10 SOL). */
export const MAX_FIRST_BUY_LAMPORTS = solToLamports(MAX_FIRST_BUY_SOL);

const SYMBOL_RE = /^[A-Z0-9]{2,10}$/;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** UTF-8 bytes of name + symbol + URI, the quantity bounded by `LAUNCH_METADATA_BUDGET_BYTES`. */
export function launchMetadataBytes(name: string, symbol: string, metadataUri: string): number {
  return utf8Length(name) + utf8Length(symbol) + utf8Length(metadataUri);
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** Name and symbol rules (no URI): Metaplex limits, no surrounding spaces, symbol pattern. */
function assertNameAndSymbol(name: string, symbol: string): void {
  if (typeof name !== 'string' || name.trim().length === 0 || name !== name.trim()) {
    fail('INVALID_INPUT', 'name must be a non-empty string without surrounding spaces');
  }
  if (utf8Length(name) > METADATA_LIMITS.name) {
    fail('INVALID_INPUT', `name must be at most ${METADATA_LIMITS.name} bytes`);
  }
  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) {
    fail('INVALID_INPUT', 'symbol must be 2 to 10 uppercase letters or digits');
  }
}

/**
 * Checks the token metadata against the Metaplex limits and the spec rules (symbol 2-10
 * uppercase letters or digits, canonical https metadata URI). The launchpad coin launch is also
 * bound by `LAUNCH_METADATA_BUDGET_BYTES` (`assertSpecLaunchable`).
 *
 * @throws LaunchCoinError `INVALID_INPUT`.
 */
export function assertLaunchMetadata(name: string, symbol: string, metadataUri: string): void {
  assertNameAndSymbol(name, symbol);
  if (typeof metadataUri !== 'string' || utf8Length(metadataUri) > METADATA_LIMITS.uri) {
    fail('INVALID_INPUT', `metadataUri must be at most ${METADATA_LIMITS.uri} bytes`);
  }
  let url: URL;
  try {
    url = new URL(metadataUri);
  } catch {
    fail('INVALID_INPUT', 'metadataUri must be an absolute URL');
  }
  if (url.protocol !== 'https:' || url.href !== metadataUri) {
    fail('INVALID_INPUT', 'metadataUri must be a canonical https URL');
  }
}

/**
 * Checks the first buy amount: a bigint between 0 and `MAX_FIRST_BUY_LAMPORTS`.
 *
 * @throws LaunchCoinError `INVALID_INPUT`.
 */
export function assertFirstBuyLamports(firstBuyLamports: bigint): void {
  if (typeof firstBuyLamports !== 'bigint') {
    fail('INVALID_INPUT', 'firstBuyLamports must be a bigint (lamports)');
  }
  if (firstBuyLamports < 0n || firstBuyLamports > MAX_FIRST_BUY_LAMPORTS) {
    fail('INVALID_INPUT', `firstBuyLamports must be between 0 and ${MAX_FIRST_BUY_LAMPORTS}`);
  }
}

/**
 * Pure: whether the launchpad coin of `spec` can be launched with `metadataUri` by the signer:
 * the metadata rules (`assertLaunchMetadata`), name + symbol + URI within
 * `LAUNCH_METADATA_BUDGET_BYTES`, and a first buy in lamports within bounds. `metadataUri` null =
 * not known yet: name, symbol and first buy only (they always leave room for a URI).
 *
 * Run it before creating anything for a launchpad (`/v1/configs`): the same inputs would
 * otherwise only fail at `/v1/launch-coin/prepare`, after the configs are paid for.
 *
 * @throws LaunchCoinError `INVALID_INPUT` (metadata rules, first buy) or `TX_TOO_LARGE` (budget).
 */
export function assertSpecLaunchable(spec: LaunchpadSpec, metadataUri: string | null): void {
  const coin = spec?.launchpadCoin;
  if (coin === null || typeof coin !== 'object') {
    fail('INVALID_INPUT', 'spec.launchpadCoin is missing');
  }
  if (metadataUri === null) assertNameAndSymbol(coin.name, coin.symbol);
  else assertLaunchMetadata(coin.name, coin.symbol, metadataUri);

  const bytes = launchMetadataBytes(coin.name, coin.symbol, metadataUri ?? '');
  if (bytes > LAUNCH_METADATA_BUDGET_BYTES) {
    fail(
      'TX_TOO_LARGE',
      `coin name + symbol + metadata URI are ${bytes} bytes; the launch transaction holds ${LAUNCH_METADATA_BUDGET_BYTES}: shorten the name, symbol or metadata URI`,
    );
  }

  let firstBuyLamports: bigint;
  try {
    firstBuyLamports = solToLamports(coin.firstBuySol);
  } catch (error) {
    fail(
      'INVALID_INPUT',
      `launchpadCoin.firstBuySol: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertFirstBuyLamports(firstBuyLamports);
}
