/**
 * FORGE addresses (PLANEXECUTE.md rule 7, docs/INTERFACES.md §8).
 *
 * This is the only place where FORGE addresses are read, and they are read from the environment
 * only: nothing is hard-coded. Nothing is required at load time either: each app calls
 * `requireAddresses([...])` at startup with the addresses it uses, and crashes if one is missing
 * or invalid.
 *
 * Validation choice: a value is valid when the `PublicKey` constructor accepts it (base58 that
 * decodes to exactly 32 bytes) and it re-encodes to the same string. Being on the ed25519 curve is
 * NOT required, because some of these addresses are token accounts or PDAs (e.g. the Meteora
 * referral account, which is a WSOL token account held by the multisig, or a Squads vault PDA).
 * The all-zero key (`11111111111111111111111111111111`, the System Program) is rejected: fees
 * sent there would be lost.
 *
 * Error messages list variable names only, never values.
 */
import { PublicKey } from '@solana/web3.js';

export const FORGE_ADDRESS_NAMES = [
  'FORGE_MULTISIG_VAULT',
  'FORGE_METEORA_REFERRAL_ACCOUNT',
  'FORGE_PLATFORM_FEE_WALLET',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'FORGE_CASHBOX_WALLET',
  'FORGE_MINT',
] as const;

export type ForgeAddressName = (typeof FORGE_ADDRESS_NAMES)[number];

/** Addresses that may be absent. `FORGE_MINT` is absent before the $FORGE launch. */
export const OPTIONAL_FORGE_ADDRESS_NAMES = [
  'FORGE_MINT',
] as const satisfies readonly ForgeAddressName[];

export type OptionalForgeAddressName = (typeof OPTIONAL_FORGE_ADDRESS_NAMES)[number];

/** Environment object to read from (defaults to `process.env`; injectable for tests). */
export type AddressEnv = Readonly<Record<string, string | undefined>>;

/** Resolved addresses: optional ones are `null` when absent. */
export type ForgeAddresses<N extends ForgeAddressName> = {
  [K in N]: K extends OptionalForgeAddressName ? PublicKey | null : PublicKey;
};

/** Thrown when required addresses are missing or invalid. Holds names only, never values. */
export class ForgeAddressError extends Error {
  readonly missing: readonly ForgeAddressName[];
  readonly invalid: readonly ForgeAddressName[];

  constructor(missing: readonly ForgeAddressName[], invalid: readonly ForgeAddressName[]) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
    if (invalid.length > 0) parts.push(`invalid Solana public key: ${invalid.join(', ')}`);
    super(`FORGE address configuration error (${parts.join('; ')})`);
    this.name = 'ForgeAddressError';
    this.missing = missing;
    this.invalid = invalid;
  }
}

function defaultEnv(): AddressEnv {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

function isOptional(name: ForgeAddressName): name is OptionalForgeAddressName {
  return (OPTIONAL_FORGE_ADDRESS_NAMES as readonly ForgeAddressName[]).includes(name);
}

function isForgeAddressName(name: unknown): name is ForgeAddressName {
  return typeof name === 'string' && (FORGE_ADDRESS_NAMES as readonly string[]).includes(name);
}

/** Parses a value as a public key; returns null when it is not a valid, canonical address. */
function parsePublicKey(value: string): PublicKey | null {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) return null;
    if (key.equals(PublicKey.default)) return null;
    return key;
  } catch {
    return null;
  }
}

/**
 * Validates the given FORGE addresses and returns them as `PublicKey`s.
 * A required address that is absent or empty is "missing"; any present value that is not a valid
 * Solana public key is "invalid" (optional ones included). All problems are reported at once.
 *
 * @throws ForgeAddressError listing the missing and invalid names (never the values).
 */
export function requireAddresses<N extends ForgeAddressName>(
  names: readonly N[],
  env: AddressEnv = defaultEnv(),
): ForgeAddresses<N> {
  const unknown = names.filter((name) => !isForgeAddressName(name));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown FORGE address name(s): ${unknown.map(String).join(', ')}`);
  }
  const missing: ForgeAddressName[] = [];
  const invalid: ForgeAddressName[] = [];
  const result: Partial<Record<ForgeAddressName, PublicKey | null>> = {};

  for (const name of new Set(names)) {
    const value = env[name];
    if (value === undefined || value === '') {
      if (isOptional(name)) result[name] = null;
      else missing.push(name);
      continue;
    }
    const key = parsePublicKey(value);
    if (key === null) invalid.push(name);
    else result[name] = key;
  }

  if (missing.length > 0 || invalid.length > 0) throw new ForgeAddressError(missing, invalid);
  return result as ForgeAddresses<N>;
}

/** Squads multisig vault: receives the creator fees, the Meteora referral and the cashbox sweeps. */
export function getMultisigVault(env?: AddressEnv): PublicKey {
  return requireAddresses(['FORGE_MULTISIG_VAULT'], env).FORGE_MULTISIG_VAULT;
}

/** Meteora referral token account (WSOL, held by the multisig), passed as `referralTokenAccount`. */
export function getMeteoraReferralAccount(env?: AddressEnv): PublicKey {
  return requireAddresses(['FORGE_METEORA_REFERRAL_ACCOUNT'], env).FORGE_METEORA_REFERRAL_ACCOUNT;
}

/** Wallet receiving the 0.3% platform fee on swaps built by @forge/core. */
export function getPlatformFeeWallet(env?: AddressEnv): PublicKey {
  return requireAddresses(['FORGE_PLATFORM_FEE_WALLET'], env).FORGE_PLATFORM_FEE_WALLET;
}

/** Jupiter referral account (integrator fee after graduation). */
export function getJupiterReferralAccount(env?: AddressEnv): PublicKey {
  return requireAddresses(['FORGE_JUPITER_REFERRAL_ACCOUNT'], env).FORGE_JUPITER_REFERRAL_ACCOUNT;
}

/** Cashbox wallet (held by the signer) receiving client payments. */
export function getCashboxWallet(env?: AddressEnv): PublicKey {
  return requireAddresses(['FORGE_CASHBOX_WALLET'], env).FORGE_CASHBOX_WALLET;
}

/** $FORGE mint, or `null` before the $FORGE launch (token-gating off, buyback simulated). */
export function getForgeMint(env?: AddressEnv): PublicKey | null {
  return requireAddresses(['FORGE_MINT'], env).FORGE_MINT;
}
