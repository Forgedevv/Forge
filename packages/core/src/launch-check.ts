/**
 * Verification of the launchpad coin launch transaction BEFORE the owner signs it (and on the
 * server, before it is handed out): pool creation + the owner's first buy, prepared and partially
 * signed by apps/signer (`buildLaunchCoinTx` with a durable nonce, rent paid by the owner).
 *
 * The owner's wallet must only be asked to sign exactly that: a compromised or buggy server must
 * not get it to sign another program call, a transfer to someone else, another amount, or a pool
 * on another config. `verifyLaunchCoinTransaction` accepts nothing but the shape core builds:
 *
 * - legacy message, no address lookup table, fee payer = the owner, required signers exactly
 *   {owner, creator wallet, coin mint}; the creator and mint signatures present and valid
 *   (ed25519 over the message), the owner's absent or valid; the creator wallet read-only;
 * - instruction 1: System `AdvanceNonceAccount` by the creator wallet (durable nonce);
 * - Compute Budget: at most one unit limit and one unit price, bounded;
 * - Associated Token: idempotent creations, paid by and for the owner, of its WSOL account and
 *   its account of the new coin (classic SPL Token program);
 * - System transfers only from the owner to its own WSOL account: exactly the first buy;
 * - SPL Token: SyncNative of the owner's WSOL account, CloseAccount of it back to the owner;
 * - DBC: one `initialize_virtual_pool_with_spl_token` (expected config, pool PDA, mint, creator,
 *   paid by the owner, every program account and PDA as derived), then, with a first buy, one
 *   `swap` of exactly the first buy on that pool, paid by and delivered to the owner, without a
 *   referral;
 * - nothing else. The creator wallet appears only in the nonce advance and the pool creation.
 *
 * Expected values the caller does not know (null) are taken from the transaction and checked to
 * be consistent everywhere they appear. Pure and light: only @solana/web3.js, so the browser
 * client can run it (apps/web src/client). Account layouts follow the pinned DBC SDK 1.5.13 IDL;
 * pool.test.ts / launch-check.test.ts run it on what `buildLaunchCoinTx` builds.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type Message,
} from '@solana/web3.js';
import { encodeBase58 } from './tx.js';

// ---------------------------------------------------------------------------------------------
// Protocol constants (public program ids and PDAs, identical on devnet and mainnet)
// ---------------------------------------------------------------------------------------------

/** Meteora Dynamic Bonding Curve program (SDK 1.5.13). */
export const LAUNCH_CHECK_DBC_PROGRAM_ID = new PublicKey(
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
);
const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** Anchor discriminators of the DBC instructions of a launch (IDL of SDK 1.5.13). */
export const LAUNCH_DBC_DISCRIMINATORS = {
  initializeVirtualPoolWithSplToken: [140, 85, 215, 176, 102, 54, 104, 79],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
} as const;

/** Highest compute unit limit and priority fee a launch may carry. */
export const LAUNCH_CHECK_MAX_COMPUTE_UNITS = 1_400_000;
/** 0.01 SOL: far above what FORGE sets (no priority fee), far below anything worth stealing. */
export const LAUNCH_CHECK_MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n;

const SYSTEM_TRANSFER = 2;
const SYSTEM_ADVANCE_NONCE = 4;
const TOKEN_CLOSE_ACCOUNT = 9;
const TOKEN_SYNC_NATIVE = 17;
const ATA_CREATE_IDEMPOTENT = 1;

const encoder = new TextEncoder();

function pda(seeds: Uint8Array[], program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** The DBC pool of `mint` (SOL quote) on `config` (`deriveDbcPoolAddress` of the SDK). */
export function launchPoolAddress(config: PublicKey, mint: PublicKey): PublicKey {
  const quote = WSOL_MINT.toBytes();
  const base = mint.toBytes();
  const quoteFirst = compareBytes(quote, base) > 0;
  return pda(
    [
      encoder.encode('pool'),
      config.toBytes(),
      quoteFirst ? quote : base,
      quoteFirst ? base : quote,
    ],
    LAUNCH_CHECK_DBC_PROGRAM_ID,
  );
}

function tokenVault(pool: PublicKey, mint: PublicKey): PublicKey {
  return pda(
    [encoder.encode('token_vault'), mint.toBytes(), pool.toBytes()],
    LAUNCH_CHECK_DBC_PROGRAM_ID,
  );
}

function mintMetadata(mint: PublicKey): PublicKey {
  return pda(
    [encoder.encode('metadata'), METAPLEX_PROGRAM_ID.toBytes(), mint.toBytes()],
    METAPLEX_PROGRAM_ID,
  );
}

function associatedTokenAccount(owner: PublicKey, mint: PublicKey): PublicKey {
  return pda(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

let cachedAuthorities: { pool: PublicKey; event: PublicKey } | null = null;

function dbcAuthorities(): { pool: PublicKey; event: PublicKey } {
  cachedAuthorities ??= {
    pool: pda([encoder.encode('pool_authority')], LAUNCH_CHECK_DBC_PROGRAM_ID),
    event: pda([encoder.encode('__event_authority')], LAUNCH_CHECK_DBC_PROGRAM_ID),
  };
  return cachedAuthorities;
}

// ---------------------------------------------------------------------------------------------
// Errors and types
// ---------------------------------------------------------------------------------------------

export type LaunchTransactionCheckCode =
  /** Not a decodable legacy transaction, or it uses address lookup tables. */
  | 'MALFORMED'
  /** Fee payer or required signers other than {owner, creator, mint}. */
  | 'UNEXPECTED_SIGNERS'
  /** The creator or mint signature is missing. */
  | 'MISSING_SIGNATURE'
  /** A signature present does not verify against the message. */
  | 'INVALID_SIGNATURE'
  /** A program or instruction outside the launch shape. */
  | 'UNEXPECTED_INSTRUCTION'
  /** An account or amount differs from the expected one, or is inconsistent. */
  | 'MISMATCH';

/** The transaction is not the launch the owner is about to approve. Nothing should be signed. */
export class LaunchTransactionCheckError extends Error {
  readonly code: LaunchTransactionCheckCode;

  constructor(code: LaunchTransactionCheckCode, message: string) {
    super(message);
    this.name = 'LaunchTransactionCheckError';
    this.code = code;
  }
}

function fail(code: LaunchTransactionCheckCode, message: string): never {
  throw new LaunchTransactionCheckError(code, message);
}

type KeyLike = PublicKey | string;

export interface ExpectedLaunchCoinTransaction {
  /** The client wallet: fee payer, rent payer, buyer and receiver of the first buy. */
  owner: KeyLike;
  /** Exact first buy in lamports (the SOL wrapped and the swap input); 0n = no first buy. */
  firstBuyLamports: bigint;
  /** FORGE creator wallet of the launchpad (pool creator, nonce authority), when known. */
  creator?: KeyLike | null;
  /** The launchpad coin mint, when known. */
  mint?: KeyLike | null;
  /** The launchpad coin config, when known. */
  config?: KeyLike | null;
  /** The durable nonce account, when known. */
  nonceAccount?: KeyLike | null;
  /** Coin metadata the pool creation must write, when known. */
  name?: string | null;
  symbol?: string | null;
  metadataUri?: string | null;
}

/** What the verified transaction does (every key checked as described above). */
export interface VerifiedLaunchCoinTransaction {
  owner: PublicKey;
  creator: PublicKey;
  mint: PublicKey;
  config: PublicKey;
  pool: PublicKey;
  nonceAccount: PublicKey;
  /** The durable nonce value (the message's recent blockhash). */
  nonce: string;
  name: string;
  symbol: string;
  metadataUri: string;
  firstBuyLamports: bigint;
  /** `minimum_amount_out` of the first buy (0n without a first buy). */
  minimumTokensOut: bigint;
  /** Whether the owner's signature is already present (and valid). */
  ownerSigned: boolean;
}

// ---------------------------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------------------------

function toKey(value: KeyLike, name: string): PublicKey {
  try {
    const key = value instanceof PublicKey ? value : new PublicKey(value);
    if (typeof value === 'string' && key.toBase58() !== value) throw new Error('not canonical');
    return key;
  } catch {
    throw new TypeError(`expected ${name} must be a public key`);
  }
}

function optionalKey(value: KeyLike | null | undefined, name: string): PublicKey | null {
  return value === null || value === undefined ? null : toKey(value, name);
}

interface Ix {
  /** 1-based position, for messages. */
  position: number;
  program: PublicKey;
  keys: PublicKey[];
  data: Uint8Array;
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return data.length >= prefix.length && prefix.every((b, i) => data[i] === b);
}

/** Borsh strings of the pool creation: name, symbol, uri, nothing after. */
function decodeInitializeParams(data: Uint8Array): [string, string, string] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const out: string[] = [];
  let offset = 8;
  for (let i = 0; i < 3; i++) {
    if (offset + 4 > data.length) fail('MALFORMED', 'the pool creation data is truncated');
    const length = readU32(data, offset);
    offset += 4;
    if (offset + length > data.length) fail('MALFORMED', 'the pool creation data is truncated');
    try {
      out.push(decoder.decode(data.subarray(offset, offset + length)));
    } catch {
      fail('MALFORMED', 'the coin metadata is not valid UTF-8');
    }
    offset += length;
  }
  if (offset !== data.length) fail('MALFORMED', 'the pool creation data has trailing bytes');
  return out as [string, string, string];
}

function same(a: PublicKey | undefined, b: PublicKey): boolean {
  return a !== undefined && a.equals(b);
}

function key(ix: Ix, index: number): PublicKey {
  const k = ix.keys[index];
  if (!k) fail('MALFORMED', `instruction ${ix.position} is missing accounts`);
  return k;
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

/**
 * Checks that `tx` is the launchpad coin launch described above for `expected`, and returns what
 * it does. Accepts a legacy `Transaction`, a `VersionedTransaction` or the serialized bytes.
 *
 * @throws LaunchTransactionCheckError (typed `code`); TypeError for a malformed `expected`.
 */
export function verifyLaunchCoinTransaction(
  tx: Transaction | VersionedTransaction | Uint8Array,
  expected: ExpectedLaunchCoinTransaction,
): VerifiedLaunchCoinTransaction {
  const owner = toKey(expected.owner, 'owner');
  if (typeof expected.firstBuyLamports !== 'bigint' || expected.firstBuyLamports < 0n) {
    throw new TypeError('expected firstBuyLamports must be a non-negative bigint');
  }
  const firstBuy = expected.firstBuyLamports;
  const want = {
    creator: optionalKey(expected.creator, 'creator'),
    mint: optionalKey(expected.mint, 'mint'),
    config: optionalKey(expected.config, 'config'),
    nonceAccount: optionalKey(expected.nonceAccount, 'nonceAccount'),
  };

  // 1. Decode (legacy only: what core builds; no lookup table can hide an account).
  let versioned: VersionedTransaction;
  try {
    const bytes =
      tx instanceof Uint8Array
        ? tx
        : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    versioned = VersionedTransaction.deserialize(bytes);
  } catch {
    fail('MALFORMED', 'the launch transaction cannot be decoded');
  }
  const message = versioned.message;
  if (message.version !== 'legacy') fail('MALFORMED', 'the launch transaction is not legacy');
  if (message.addressTableLookups.length > 0) {
    fail('MALFORMED', 'the launch transaction uses address lookup tables');
  }
  const keys = message.staticAccountKeys;
  const ixs: Ix[] = message.compiledInstructions.map((ix, i) => {
    const program = keys[ix.programIdIndex];
    if (!program) fail('MALFORMED', 'the launch transaction references an unknown program');
    return {
      position: i + 1,
      program,
      keys: ix.accountKeyIndexes.map((index) => {
        const k = keys[index];
        if (!k) fail('MALFORMED', 'the launch transaction references an unknown account');
        return k;
      }),
      data: Uint8Array.from(ix.data),
    };
  });

  // 2. The pool creation names the creator, the mint and the config.
  const inits = ixs.filter(
    (ix) =>
      ix.program.equals(LAUNCH_CHECK_DBC_PROGRAM_ID) &&
      startsWith(ix.data, LAUNCH_DBC_DISCRIMINATORS.initializeVirtualPoolWithSplToken),
  );
  if (inits.length !== 1) fail('UNEXPECTED_INSTRUCTION', 'exactly one pool creation is expected');
  const init = inits[0]!;
  const config = key(init, 0);
  const creator = key(init, 2);
  const mint = key(init, 3);
  for (const [name, actual, wanted] of [
    ['config', config, want.config],
    ['creator wallet', creator, want.creator],
    ['coin mint', mint, want.mint],
  ] as const) {
    if (wanted && !actual.equals(wanted)) fail('MISMATCH', `the ${name} is not the expected one`);
  }
  const pool = launchPoolAddress(config, mint);
  const ownerWsol = associatedTokenAccount(owner, WSOL_MINT);
  const ownerCoin = associatedTokenAccount(owner, mint);

  // 3. Signers: exactly {owner, creator, mint}, the owner first (fee payer).
  const required = message.header.numRequiredSignatures;
  const signers = keys.slice(0, required);
  if (!same(signers[0], owner)) fail('UNEXPECTED_SIGNERS', 'the fee payer is not the owner');
  if (
    required !== 3 ||
    owner.equals(creator) ||
    owner.equals(mint) ||
    creator.equals(mint) ||
    ![owner, creator, mint].every((k) => signers.some((s) => s.equals(k)))
  ) {
    fail('UNEXPECTED_SIGNERS', 'the signers are not exactly the owner, the creator and the mint');
  }
  const indexOf = (k: PublicKey) => keys.findIndex((x) => x.equals(k));
  if (message.isAccountWritable(indexOf(creator))) {
    fail('UNEXPECTED_SIGNERS', 'the creator wallet must be read-only');
  }
  for (const k of [config, pool, ownerWsol, ownerCoin]) {
    if (signers.some((s) => s.equals(k))) fail('UNEXPECTED_SIGNERS', 'unexpected signer');
  }

  // 4. Signatures: creator and mint present, every present one valid for this message.
  const signatureOf = (k: PublicKey): Uint8Array | null => {
    const sig = versioned.signatures[indexOf(k)];
    return sig && sig.some((b) => b !== 0) ? sig : null;
  };
  if (!signatureOf(creator)) fail('MISSING_SIGNATURE', 'the creator wallet has not signed');
  if (!signatureOf(mint)) fail('MISSING_SIGNATURE', 'the coin mint has not signed');
  const populated = Transaction.populate(
    message as Message,
    versioned.signatures.map((sig) => encodeBase58(sig)),
  );
  if (!populated.verifySignatures(false)) {
    fail('INVALID_SIGNATURE', 'a signature of the launch transaction does not verify');
  }

  // 5. Instructions.
  const authorities = dbcAuthorities();
  let nonceAccount: PublicKey | null = null;
  let units: bigint | null = null;
  let price: bigint | null = null;
  let transferred = 0n;
  let transfers = 0;
  let swaps = 0;
  let initialized = false;
  let minimumTokensOut = 0n;
  let metadata: [string, string, string] = ['', '', ''];
  for (const ix of ixs) {
    const touchesCreator = ix.keys.some((k) => k.equals(creator));
    if (ix.position === 1) {
      // The durable nonce advance, by the creator wallet.
      if (
        !ix.program.equals(SystemProgram.programId) ||
        ix.data.length !== 4 ||
        readU32(ix.data, 0) !== SYSTEM_ADVANCE_NONCE ||
        ix.keys.length !== 3
      ) {
        fail('UNEXPECTED_INSTRUCTION', 'the first instruction must advance the durable nonce');
      }
      nonceAccount = key(ix, 0);
      if (!key(ix, 1).equals(SYSVAR_RECENT_BLOCKHASHES_PUBKEY)) {
        fail('MALFORMED', 'the nonce advance does not read the recent blockhashes');
      }
      if (!key(ix, 2).equals(creator)) {
        fail('MISMATCH', 'the durable nonce authority is not the creator wallet');
      }
      if (want.nonceAccount && !nonceAccount.equals(want.nonceAccount)) {
        fail('MISMATCH', 'the durable nonce account is not the expected one');
      }
      if ([owner, mint, config, pool, ownerWsol, ownerCoin].some((k) => k.equals(nonceAccount!))) {
        fail('MISMATCH', 'the durable nonce account is one of the launch accounts');
      }
      continue;
    }
    if (touchesCreator && ix !== init) {
      fail('MISMATCH', `instruction ${ix.position} uses the creator wallet`);
    }

    if (ix.program.equals(ComputeBudgetProgram.programId)) {
      if (ix.keys.length !== 0) fail('UNEXPECTED_INSTRUCTION', 'unexpected compute budget');
      if (ix.data[0] === 2 && ix.data.length === 5 && units === null) {
        units = BigInt(readU32(ix.data, 1));
        if (units < 1n || units > BigInt(LAUNCH_CHECK_MAX_COMPUTE_UNITS)) {
          fail('UNEXPECTED_INSTRUCTION', 'the compute unit limit is out of range');
        }
      } else if (ix.data[0] === 3 && ix.data.length === 9 && price === null) {
        price = readU64(ix.data, 1);
      } else {
        fail('UNEXPECTED_INSTRUCTION', 'unexpected compute budget instruction');
      }
      continue;
    }

    if (ix.program.equals(SystemProgram.programId)) {
      // Wrapping the first buy: owner -> its own WSOL account, nothing else.
      if (
        ix.data.length !== 12 ||
        readU32(ix.data, 0) !== SYSTEM_TRANSFER ||
        ix.keys.length !== 2
      ) {
        fail('UNEXPECTED_INSTRUCTION', `instruction ${ix.position} is an unexpected System call`);
      }
      if (!key(ix, 0).equals(owner) || !key(ix, 1).equals(ownerWsol)) {
        fail('MISMATCH', 'SOL is sent elsewhere than to your own wrapped SOL account');
      }
      transferred += readU64(ix.data, 4);
      transfers++;
      continue;
    }

    if (ix.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // CreateIdempotent: payer, account, owner, mint, system program, token program.
      if (ix.data.length !== 1 || ix.data[0] !== ATA_CREATE_IDEMPOTENT || ix.keys.length !== 6) {
        fail(
          'UNEXPECTED_INSTRUCTION',
          `instruction ${ix.position} is an unexpected token account call`,
        );
      }
      const tokenMint = key(ix, 3);
      if (
        !key(ix, 0).equals(owner) ||
        !key(ix, 2).equals(owner) ||
        !key(ix, 4).equals(SystemProgram.programId) ||
        !key(ix, 5).equals(TOKEN_PROGRAM_ID) ||
        !(tokenMint.equals(WSOL_MINT) || tokenMint.equals(mint)) ||
        !key(ix, 1).equals(associatedTokenAccount(owner, tokenMint))
      ) {
        fail('MISMATCH', 'a token account created is not your own WSOL or coin account');
      }
      continue;
    }

    if (ix.program.equals(TOKEN_PROGRAM_ID)) {
      if (ix.data.length === 1 && ix.data[0] === TOKEN_SYNC_NATIVE && ix.keys.length === 1) {
        if (!key(ix, 0).equals(ownerWsol)) fail('MISMATCH', 'unexpected wrapped SOL account');
        continue;
      }
      if (ix.data.length === 1 && ix.data[0] === TOKEN_CLOSE_ACCOUNT && ix.keys.length === 3) {
        // CloseAccount(account, destination, authority): the owner's WSOL account, to the owner.
        if (
          !key(ix, 0).equals(ownerWsol) ||
          !key(ix, 1).equals(owner) ||
          !key(ix, 2).equals(owner)
        ) {
          fail('MISMATCH', 'wrapped SOL is returned elsewhere than to your wallet');
        }
        continue;
      }
      fail('UNEXPECTED_INSTRUCTION', `instruction ${ix.position} is an unexpected token call`);
    }

    if (ix.program.equals(LAUNCH_CHECK_DBC_PROGRAM_ID)) {
      if (ix === init) {
        // config, pool_authority, creator, base_mint, quote_mint, pool, base_vault, quote_vault,
        // mint_metadata, metadata_program, payer, token_quote_program, token_program,
        // system_program, event_authority, program.
        const layout: PublicKey[] = [
          config,
          authorities.pool,
          creator,
          mint,
          WSOL_MINT,
          pool,
          tokenVault(pool, mint),
          tokenVault(pool, WSOL_MINT),
          mintMetadata(mint),
          METAPLEX_PROGRAM_ID,
          owner,
          TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          SystemProgram.programId,
          authorities.event,
          LAUNCH_CHECK_DBC_PROGRAM_ID,
        ];
        if (ix.keys.length !== layout.length || !layout.every((k, i) => ix.keys[i]!.equals(k))) {
          fail('MISMATCH', 'the pool creation accounts are not the expected ones');
        }
        metadata = decodeInitializeParams(ix.data);
        initialized = true;
        continue;
      }
      if (startsWith(ix.data, LAUNCH_DBC_DISCRIMINATORS.swap)) {
        if (!initialized) fail('UNEXPECTED_INSTRUCTION', 'the first buy comes before the pool');
        // pool_authority, config, pool, input (owner WSOL), output (owner coin), base_vault,
        // quote_vault, base_mint, quote_mint, payer, token_base_program, token_quote_program,
        // referral_token_account (none = the program id), event_authority, program
        // [, instructions sysvar for the first-swap minimum fee].
        const layout: PublicKey[] = [
          authorities.pool,
          config,
          pool,
          ownerWsol,
          ownerCoin,
          tokenVault(pool, mint),
          tokenVault(pool, WSOL_MINT),
          mint,
          WSOL_MINT,
          owner,
          TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          LAUNCH_CHECK_DBC_PROGRAM_ID,
          authorities.event,
          LAUNCH_CHECK_DBC_PROGRAM_ID,
        ];
        const extra = ix.keys.slice(layout.length);
        if (
          ix.keys.length < layout.length ||
          !layout.every((k, i) => ix.keys[i]!.equals(k)) ||
          extra.length > 1 ||
          (extra.length === 1 && !extra[0]!.equals(SYSVAR_INSTRUCTIONS_PUBKEY))
        ) {
          fail('MISMATCH', 'the first buy accounts are not the expected ones');
        }
        if (ix.data.length !== 24) fail('MALFORMED', 'the first buy data is malformed');
        if (readU64(ix.data, 8) !== firstBuy) {
          fail('MISMATCH', 'the first buy amount is not the expected one');
        }
        minimumTokensOut = readU64(ix.data, 16);
        if (minimumTokensOut === 0n) fail('MISMATCH', 'the first buy accepts receiving nothing');
        swaps++;
        continue;
      }
      fail('UNEXPECTED_INSTRUCTION', `instruction ${ix.position} is an unexpected pool call`);
    }

    fail('UNEXPECTED_INSTRUCTION', `instruction ${ix.position} calls an unexpected program`);
  }

  if (!nonceAccount) fail('UNEXPECTED_INSTRUCTION', 'the durable nonce advance is missing');
  if (price !== null) {
    const budget = units ?? BigInt(LAUNCH_CHECK_MAX_COMPUTE_UNITS);
    if ((price * budget + 999_999n) / 1_000_000n > LAUNCH_CHECK_MAX_PRIORITY_FEE_LAMPORTS) {
      fail('UNEXPECTED_INSTRUCTION', 'the priority fee is too high');
    }
  }
  if (swaps !== (firstBuy > 0n ? 1 : 0)) {
    fail('MISMATCH', firstBuy > 0n ? 'the first buy is missing' : 'unexpected first buy');
  }
  if (transferred !== firstBuy || transfers !== (firstBuy > 0n ? 1 : 0)) {
    fail('MISMATCH', 'the SOL wrapped is not the first buy amount');
  }
  const [name, symbol, metadataUri] = metadata;
  for (const [label, actual, wanted] of [
    ['coin name', name, expected.name],
    ['coin symbol', symbol, expected.symbol],
    ['metadata URI', metadataUri, expected.metadataUri],
  ] as const) {
    if (wanted !== null && wanted !== undefined && actual !== wanted) {
      fail('MISMATCH', `the ${label} is not the expected one`);
    }
  }

  return {
    owner,
    creator,
    mint,
    config,
    pool,
    nonceAccount,
    nonce: message.recentBlockhash,
    name,
    symbol,
    metadataUri,
    firstBuyLamports: firstBuy,
    minimumTokensOut,
    ownerSigned: signatureOf(owner) !== null,
  };
}
