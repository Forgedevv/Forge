import { PublicKey } from '@solana/web3.js';

/**
 * LOCKED ZONE. Public program ids, Meteora DBC instruction discriminators and the program-derived
 * addresses the browser needs to check a transaction before it is signed.
 *
 * These are protocol constants (same on devnet and mainnet), not FORGE addresses. The DBC values
 * mirror `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 (IDL discriminators and PDA seeds); a unit
 * test compares them with the SDK so a version bump cannot silently change them. They are copied
 * here so the browser bundle does not pull the SDK (and Anchor) in.
 */

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const TOKEN_METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const SYSVAR_INSTRUCTIONS_ID = 'Sysvar1nstructions1111111111111111111111111';
/** Meteora Dynamic Bonding Curve. */
export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
/** Wrapped SOL mint: the quote token of every FORGE pool. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Anchor discriminators of the DBC instructions the template may meet (first 8 data bytes). */
export const DBC_DISCRIMINATORS = {
  initializeVirtualPoolWithSplToken: [140, 85, 215, 176, 102, 54, 104, 79],
  initializeVirtualPoolWithToken2022: [169, 118, 51, 78, 145, 110, 220, 155],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
  swap2: [65, 75, 63, 76, 235, 91, 91, 136],
  claimCreatorTradingFee: [82, 220, 250, 189, 3, 85, 107, 45],
  claimCreatorTradingFee2: [238, 247, 213, 94, 110, 145, 88, 142],
} as const;

export type DbcInstructionName = keyof typeof DBC_DISCRIMINATORS;

const encoder = new TextEncoder();

function pda(seeds: Uint8Array[], programId: string): string {
  return PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0].toBase58();
}

function bytes(address: string): Uint8Array {
  return new PublicKey(address).toBytes();
}

/** Byte-wise comparison of two keys, as `Buffer.compare`. */
function compareKeys(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

let poolAuthority: string | null = null;
let eventAuthority: string | null = null;

/** DBC pool authority (`["pool_authority"]`). */
export function dbcPoolAuthority(): string {
  poolAuthority ??= pda([encoder.encode('pool_authority')], DBC_PROGRAM_ID);
  return poolAuthority;
}

/** DBC event authority (`["__event_authority"]`), used by the self-CPI events. */
export function dbcEventAuthority(): string {
  eventAuthority ??= pda([encoder.encode('__event_authority')], DBC_PROGRAM_ID);
  return eventAuthority;
}

/** DBC pool of a coin on a config: `["pool", config, max(quote, base), min(quote, base)]`. */
export function dbcPoolAddress(config: string, baseMint: string, quoteMint = WSOL_MINT): string {
  const quote = bytes(quoteMint);
  const base = bytes(baseMint);
  const quoteFirst = compareKeys(quote, base) > 0;
  return pda(
    [
      encoder.encode('pool'),
      bytes(config),
      quoteFirst ? quote : base,
      quoteFirst ? base : quote,
    ],
    DBC_PROGRAM_ID,
  );
}

/** DBC token vault of a pool: `["token_vault", mint, pool]`. */
export function dbcVaultAddress(pool: string, mint: string): string {
  return pda([encoder.encode('token_vault'), bytes(mint), bytes(pool)], DBC_PROGRAM_ID);
}

/** Metaplex metadata account of a mint. */
export function metadataAddress(mint: string): string {
  return pda(
    [encoder.encode('metadata'), bytes(TOKEN_METADATA_PROGRAM_ID), bytes(mint)],
    TOKEN_METADATA_PROGRAM_ID,
  );
}

/** Associated token account of `owner` for `mint` under `tokenProgram`. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  return pda([bytes(owner), bytes(tokenProgram), bytes(mint)], ASSOCIATED_TOKEN_PROGRAM_ID);
}

/** A canonical, non-default public key in base58, or null. */
export function canonicalAddress(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value || key.equals(PublicKey.default)) return null;
    return value;
  } catch {
    return null;
  }
}
