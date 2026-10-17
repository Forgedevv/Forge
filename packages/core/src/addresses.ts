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
 * referral account, which is a WSOL token account held by the revenue wallet, or a Squads vault
 * PDA).
 *
 * The revenue wallet (`FORGE_REVENUE_WALLET`, docs/DECISIONS.md D34) is the signer-held wallet
 * where the non-native trading revenue lands: the platform fee (`FORGE_PLATFORM_FEE_WALLET` must
 * be that wallet), the Meteora referral WSOL account it holds, and the Jupiter referral claims
 * (it is the referral account's partner). The signer converts and forwards it to the vault.
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
  'FORGE_REVENUE_WALLET',
  'FORGE_JUPITER_REFERRAL_ACCOUNT',
  'FORGE_CASHBOX_WALLET',
  'FORGE_MINT',
  'FORGE_SQUADS_MULTISIG',
  'FORGE_SQUADS_SPENDING_LIMIT',
] as const;

export type ForgeAddressName = (typeof FORGE_ADDRESS_NAMES)[number];

/**
 * Addresses that may be absent. `FORGE_MINT` is absent before the $FORGE launch; the Squads
 * accounts are absent while the buyback stays in simulation (see `readSquadsAddresses`).
 */
export const OPTIONAL_FORGE_ADDRESS_NAMES = [
  'FORGE_MINT',
  'FORGE_SQUADS_MULTISIG',
  'FORGE_SQUADS_SPENDING_LIMIT',
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

/**
 * One FORGE address when it is set, `null` when it is absent or empty. A value that is set but is
 * not a valid public key is refused, exactly as `requireAddresses` does. For checks that run
 * wherever the address is known and are skipped elsewhere (e.g. the owner of the Meteora referral
 * account, `FORGE_REVENUE_WALLET`, in a browser that was not given it).
 *
 * @throws ForgeAddressError (invalid value; names only).
 */
export function readOptionalAddress(
  name: ForgeAddressName,
  env: AddressEnv = defaultEnv(),
): PublicKey | null {
  const value = env[name];
  if (value === undefined || value === '') return null;
  return requireAddresses([name], env)[name] as PublicKey;
}

/**
 * Squads multisig vault: receives the creator fees, the cashbox sweeps and the revenue wallet's
 * forwards (the converted trading revenue).
 */
export function getMultisigVault(env?: AddressEnv): PublicKey {
  return requireAddresses(['FORGE_MULTISIG_VAULT'], env).FORGE_MULTISIG_VAULT;
}

/** Meteora referral token account (WSOL, held by the revenue wallet), passed as `referralTokenAccount`. */
export function getMeteoraReferralAccount(env?: AddressEnv): PublicKey {
  return requireAddresses(['FORGE_METEORA_REFERRAL_ACCOUNT'], env).FORGE_METEORA_REFERRAL_ACCOUNT;
}

/**
 * Wallet receiving the 0.3% platform fee on swaps built by @forge/core: the revenue wallet
 * (`FORGE_REVENUE_WALLET`, D34). Kept as its own variable so the fee destination stays explicit;
 * `swapFeeAddresses` refuses an environment where the two differ.
 */
export function getPlatformFeeWallet(env?: AddressEnv): PublicKey {
  return requireAddresses(['FORGE_PLATFORM_FEE_WALLET'], env).FORGE_PLATFORM_FEE_WALLET;
}

/**
 * Revenue wallet (D34): held by the signer (keystore role `revenue`), it receives the platform
 * fee, holds the Meteora referral WSOL account and is the partner of the Jupiter referral
 * account. The signer regularly converts what it holds to SOL and forwards it to the vault.
 */
export function getRevenueWallet(env?: AddressEnv): PublicKey {
  return requireAddresses(['FORGE_REVENUE_WALLET'], env).FORGE_REVENUE_WALLET;
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

// ---------------------------------------------------------------------------------------------
// Squads v4 accounts of the buyback (docs/SECURITY.md 7)

/** Squads v4 accounts the buyback withdraws through, read from the environment. */
export interface SquadsAddresses {
  /** FORGE_SQUADS_MULTISIG: the multisig account. */
  multisig: PublicKey;
  /** FORGE_SQUADS_SPENDING_LIMIT: the spending limit account of the buyback wallet. */
  spendingLimit: PublicKey;
  /** FORGE_SQUADS_VAULT_INDEX (default 0): the vault index of the treasury vault. */
  vaultIndex: number;
}

export type SquadsAddressProblem =
  /** One of the two addresses without the other. */
  | 'incomplete'
  /** FORGE_SQUADS_VAULT_INDEX other than the default 0 without the addresses. */
  | 'index_without_multisig'
  /** FORGE_SQUADS_VAULT_INDEX is not an integer between 0 and 255. */
  | 'invalid_index'
  /** The spending limit account is the multisig account. */
  | 'not_distinct';

/** Thrown by `readSquadsAddresses` on a rule the names alone cannot express. Names only. */
export class ForgeSquadsConfigError extends Error {
  readonly problem: SquadsAddressProblem;

  constructor(problem: SquadsAddressProblem, message: string) {
    super(message);
    this.name = 'ForgeSquadsConfigError';
    this.problem = problem;
  }
}

const VAULT_INDEX_RE = /^(0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/;

/**
 * FORGE_SQUADS_MULTISIG, FORGE_SQUADS_SPENDING_LIMIT and FORGE_SQUADS_VAULT_INDEX. Returns `null`
 * when both addresses are absent (no withdrawer: the buyback stays in simulation). Rules: the
 * two addresses are set together or not at all; an index other than the default `0` needs them
 * (a lone `0` is the default spelled out, not a configuration); the index is an integer between
 * 0 and 255 (default 0); the spending limit is a distinct account. Deriving the vault from the
 * multisig and the index, and comparing it with FORGE_MULTISIG_VAULT, needs the Squads program
 * id (pinned SDK): the caller (the signer) does it.
 *
 * @throws ForgeAddressError (invalid address, names only), ForgeSquadsConfigError (other rules).
 */
export function readSquadsAddresses(env: AddressEnv = defaultEnv()): SquadsAddresses | null {
  const multisigRaw = env.FORGE_SQUADS_MULTISIG ?? '';
  const limitRaw = env.FORGE_SQUADS_SPENDING_LIMIT ?? '';
  const indexRaw = env.FORGE_SQUADS_VAULT_INDEX ?? '';
  if (multisigRaw === '' && limitRaw === '') {
    if (indexRaw !== '' && indexRaw !== '0') {
      throw new ForgeSquadsConfigError(
        'index_without_multisig',
        'FORGE_SQUADS_VAULT_INDEX needs FORGE_SQUADS_MULTISIG',
      );
    }
    return null;
  }
  if (multisigRaw === '' || limitRaw === '') {
    throw new ForgeSquadsConfigError(
      'incomplete',
      'FORGE_SQUADS_MULTISIG and FORGE_SQUADS_SPENDING_LIMIT must be set together',
    );
  }
  const multisig = readOptionalAddress('FORGE_SQUADS_MULTISIG', env) as PublicKey;
  const spendingLimit = readOptionalAddress('FORGE_SQUADS_SPENDING_LIMIT', env) as PublicKey;
  let vaultIndex = 0;
  if (indexRaw !== '') {
    if (!VAULT_INDEX_RE.test(indexRaw)) {
      throw new ForgeSquadsConfigError(
        'invalid_index',
        'FORGE_SQUADS_VAULT_INDEX must be an integer between 0 and 255',
      );
    }
    vaultIndex = Number(indexRaw);
  }
  if (spendingLimit.equals(multisig)) {
    throw new ForgeSquadsConfigError(
      'not_distinct',
      'FORGE_SQUADS_SPENDING_LIMIT must be a distinct account',
    );
  }
  return { multisig, spendingLimit, vaultIndex };
}
