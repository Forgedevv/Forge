import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_METADATA_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../../tx/programs';

/**
 * LOCKED ZONE. Pure decoders of the accounts the on-chain coin data reads besides the DBC pools
 * (decoded by @forge/core): the coin mint, its Metaplex metadata and the Pyth SOL/USD price. No
 * network here: `service.ts` reads the accounts through the FORGE RPC relay.
 *
 * Every decoder checks the owner program and bounds every offset: a malformed or foreign account
 * decodes to null, never to made-up values.
 */

/** Raw account as `getMultipleAccountsInfo` returns it (only what the decoders read). */
export interface RawAccount {
  owner: PublicKey | string;
  data: Uint8Array;
}

function ownerOf(account: RawAccount): string {
  return typeof account.owner === 'string' ? account.owner : account.owner.toBase58();
}

const ZERO = BigInt(0);
const EIGHT = BigInt(8);
const TWO_POW_63 = BigInt(2) ** BigInt(63);
const TWO_POW_64 = BigInt(2) ** BigInt(64);

function u64(data: Uint8Array, offset: number): bigint {
  let value = ZERO;
  for (let i = 7; i >= 0; i--) value = (value << EIGHT) | BigInt(data[offset + i] as number);
  return value;
}

function i64(data: Uint8Array, offset: number): bigint {
  const value = u64(data, offset);
  return value >= TWO_POW_63 ? value - TWO_POW_64 : value;
}

function u32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] as number) |
      ((data[offset + 1] as number) << 8) |
      ((data[offset + 2] as number) << 16)) +
    (data[offset + 3] as number) * 0x1000000
  );
}

function i32(data: Uint8Array, offset: number): number {
  const value = u32(data, offset);
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

// --- SPL mint ------------------------------------------------------------------------------------

/**
 * SPL / Token-2022 mint base layout, 82 bytes: mint authority `COption<Pubkey>` at 0 (u32 tag,
 * then 32 bytes), supply (u64) at 36, decimals (u8) at 44, initialized (u8) at 45, freeze
 * authority `COption<Pubkey>` at 46 (u32 tag, then 32 bytes).
 */
const MINT_SIZE = 82;
const MINT_AUTHORITY_OFFSET = 0;
const FREEZE_AUTHORITY_OFFSET = 46;

export interface MintInfo {
  supply: bigint;
  decimals: number;
  tokenProgram: string;
  /** True when no one can mint more of the coin (`mint_authority` is `None`). */
  mintAuthorityDisabled: boolean;
  /** True when no one can freeze a holder's account (`freeze_authority` is `None`). */
  freezeAuthorityDisabled: boolean;
}

/** `COption` tag at `offset`: false for `None` (0), true for `Some` (1), null for anything else. */
function optionIsSome(data: Uint8Array, offset: number): boolean | null {
  const tag = u32(data, offset);
  return tag === 0 ? false : tag === 1 ? true : null;
}

export function decodeMint(account: RawAccount | null | undefined): MintInfo | null {
  if (!account) return null;
  const owner = ownerOf(account);
  if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) return null;
  const { data } = account;
  if (data.length < MINT_SIZE) return null;
  const decimals = data[44] as number;
  if (data[45] !== 1 || decimals > 18) return null; // not initialized, or not a mint
  const mintAuthority = optionIsSome(data, MINT_AUTHORITY_OFFSET);
  const freezeAuthority = optionIsSome(data, FREEZE_AUTHORITY_OFFSET);
  if (mintAuthority === null || freezeAuthority === null) return null; // not a mint layout
  return {
    supply: u64(data, 36),
    decimals,
    tokenProgram: owner,
    mintAuthorityDisabled: !mintAuthority,
    freezeAuthorityDisabled: !freezeAuthority,
  };
}

// --- Metaplex token metadata ---------------------------------------------------------------------

/** The Metaplex metadata account of a mint (`["metadata", program, mint]`). */
export function metadataAddress(mint: string): string {
  const program = new PublicKey(TOKEN_METADATA_PROGRAM_ID);
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('metadata'), program.toBytes(), new PublicKey(mint).toBytes()],
    program,
  )[0].toBase58();
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  uri: string;
}

/** Protocol limits of the three strings (bytes), as stored (null-padded). */
const METADATA_MAX = { name: 32, symbol: 10, uri: 200 } as const;
/** `Key::MetadataV1`. */
const METADATA_V1_KEY = 4;

const utf8 = new TextDecoder('utf-8', { fatal: false });

function borshString(
  data: Uint8Array,
  offset: number,
  max: number,
): { value: string; next: number } | null {
  if (offset + 4 > data.length) return null;
  const length = u32(data, offset);
  // Older programs pad to the limit (plus a few bytes of slack); anything larger is not metadata.
  if (length > max + 4 || offset + 4 + length > data.length) return null;
  const raw = utf8.decode(data.subarray(offset + 4, offset + 4 + length));
  return { value: raw.replace(/\0+$/g, '').trim(), next: offset + 4 + length };
}

/**
 * Name, symbol and URI of a Metaplex metadata account (key, update authority, mint, then the three
 * borsh strings). Null when the account is not a metadata account of `mint`.
 */
export function decodeMetadata(
  account: RawAccount | null | undefined,
  mint: string,
): TokenMetadata | null {
  if (!account || ownerOf(account) !== TOKEN_METADATA_PROGRAM_ID) return null;
  const { data } = account;
  if (data.length < 65 + 12 || data[0] !== METADATA_V1_KEY) return null;
  if (new PublicKey(data.subarray(33, 65)).toBase58() !== mint) return null;
  const name = borshString(data, 65, METADATA_MAX.name);
  const symbol = name && borshString(data, name.next, METADATA_MAX.symbol);
  const uri = symbol && borshString(data, symbol.next, METADATA_MAX.uri);
  if (!name || !symbol || !uri) return null;
  return { name: name.value, symbol: symbol.value, uri: uri.value };
}

// --- Pyth SOL/USD --------------------------------------------------------------------------------

/**
 * Pyth sponsored SOL/USD price feed account (push oracle, shard 0): same address on mainnet and
 * devnet, owned by the Pyth receiver program. Checked on both clusters on 2026-10-17.
 */
export const PYTH_SOL_USD_ACCOUNT = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';
export const PYTH_RECEIVER_PROGRAM_ID = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
/**
 * Pyth feed id of SOL/USD (hex `ef0d8b6f…c280b56d`), written as the base58 of its 32 bytes like
 * an address.
 */
export const PYTH_SOL_USD_FEED_ID = 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG';
/** Anchor discriminator of `PriceUpdateV2`. */
const PRICE_UPDATE_V2_DISCRIMINATOR = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];
/** A price older than this is not shown (display only: USD values are then left empty). */
export const MAX_SOL_USD_AGE_SECONDS = 15 * 60;

/**
 * SOL price in USD from the Pyth `PriceUpdateV2` account: discriminator, write authority, the
 * verification level (`Partial { num_signatures }` = 2 bytes, `Full` = 1 byte), then the price
 * message (feed id, price i64, conf u64, exponent i32, publish time i64). Null when the account is
 * not the SOL/USD feed, the price is not positive, or it is older than `MAX_SOL_USD_AGE_SECONDS`.
 */
export function decodeSolUsdPrice(
  account: RawAccount | null | undefined,
  nowSeconds: number,
): number | null {
  if (!account || ownerOf(account) !== PYTH_RECEIVER_PROGRAM_ID) return null;
  const { data } = account;
  if (data.length < 42 || PRICE_UPDATE_V2_DISCRIMINATOR.some((b, i) => data[i] !== b)) return null;
  const level = data[40];
  const message = level === 1 ? 41 : level === 0 ? 42 : -1;
  if (message < 0 || data.length < message + 60) return null;
  if (new PublicKey(data.subarray(message, message + 32)).toBase58() !== PYTH_SOL_USD_FEED_ID) {
    return null;
  }
  const price = i64(data, message + 32);
  const exponent = i32(data, message + 48);
  const publishTime = Number(i64(data, message + 52));
  if (price <= ZERO || exponent > 0 || exponent < -18) return null;
  if (nowSeconds - publishTime > MAX_SOL_USD_AGE_SECONDS) return null;
  return Number(price) * 10 ** exponent;
}
