import { VerificationError } from './errors';
import {
  readBorshString,
  readU32,
  readU64,
  startsWith,
  type DecodedAccount,
  type DecodedInstruction,
} from './decode';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  DBC_DISCRIMINATORS,
  DBC_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type DbcInstructionName,
} from './programs';

/**
 * LOCKED ZONE. Parsers for the few instructions a FORGE transaction may contain. Each parser
 * accepts exactly one encoding (data length and account count included) and throws
 * `VerificationError` for anything else, so an unknown variant can never slip through.
 */

/** Highest compute unit limit Solana accepts per transaction. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
/**
 * Priority fee cap (micro-lamports per CU): 1 lamport per CU, the most the site's own setting
 * (`SITE_PRIORITY_FEE`, the @forge/core defaults) ever asks for; a test pins it to core.
 */
export const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = BigInt(1_000_000);

function refuse(ix: DecodedInstruction, what: string): never {
  throw new VerificationError(
    `The transaction contains an unexpected instruction (#${ix.index + 1}: ${what}). Nothing was signed.`,
  );
}

function account(ix: DecodedInstruction, i: number): DecodedAccount {
  const meta = ix.accounts[i];
  if (!meta) refuse(ix, 'missing account');
  return meta;
}

function exactAccounts(ix: DecodedInstruction, count: number, what: string): void {
  if (ix.accounts.length !== count) refuse(ix, `${what} with ${ix.accounts.length} accounts`);
}

// ---------------------------------------------------------------------------------------------
// Compute budget
// ---------------------------------------------------------------------------------------------

export type ComputeBudgetIx =
  { kind: 'setComputeUnitLimit'; units: number } | { kind: 'setComputeUnitPrice'; microLamports: bigint };

export function parseComputeBudget(ix: DecodedInstruction): ComputeBudgetIx {
  if (ix.programId !== COMPUTE_BUDGET_PROGRAM_ID) refuse(ix, 'not a compute budget instruction');
  if (ix.accounts.length !== 0) refuse(ix, 'compute budget with accounts');
  if (ix.data[0] === 2 && ix.data.length === 5) {
    const units = readU32(ix.data, 1);
    if (units < 1 || units > MAX_COMPUTE_UNIT_LIMIT) refuse(ix, 'compute unit limit out of range');
    return { kind: 'setComputeUnitLimit', units };
  }
  if (ix.data[0] === 3 && ix.data.length === 9) {
    const microLamports = readU64(ix.data, 1);
    if (microLamports > MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) {
      refuse(ix, 'priority fee above the allowed maximum');
    }
    return { kind: 'setComputeUnitPrice', microLamports };
  }
  refuse(ix, 'compute budget variant');
}

// ---------------------------------------------------------------------------------------------
// System program: only plain transfers
// ---------------------------------------------------------------------------------------------

export interface SystemTransferIx {
  from: string;
  to: string;
  lamports: bigint;
}

export function parseSystemTransfer(ix: DecodedInstruction): SystemTransferIx {
  if (ix.programId !== SYSTEM_PROGRAM_ID) refuse(ix, 'not a system instruction');
  if (ix.data.length !== 12 || readU32(ix.data, 0) !== 2) refuse(ix, 'system program variant');
  exactAccounts(ix, 2, 'transfer');
  const from = account(ix, 0);
  const to = account(ix, 1);
  if (!from.signer || !from.writable || !to.writable) refuse(ix, 'malformed transfer');
  return { from: from.key, to: to.key, lamports: readU64(ix.data, 4) };
}

// ---------------------------------------------------------------------------------------------
// Associated token account program: only idempotent creation
// ---------------------------------------------------------------------------------------------

export interface CreateAtaIx {
  payer: string;
  ata: string;
  owner: string;
  mint: string;
  tokenProgram: string;
}

export function parseCreateAtaIdempotent(ix: DecodedInstruction): CreateAtaIx {
  if (ix.programId !== ASSOCIATED_TOKEN_PROGRAM_ID) refuse(ix, 'not a token account creation');
  if (ix.data.length !== 1 || ix.data[0] !== 1) refuse(ix, 'non-idempotent token account creation');
  exactAccounts(ix, 6, 'token account creation');
  if (account(ix, 4).key !== SYSTEM_PROGRAM_ID) refuse(ix, 'token account creation');
  const tokenProgram = account(ix, 5).key;
  if (tokenProgram !== TOKEN_PROGRAM_ID && tokenProgram !== TOKEN_2022_PROGRAM_ID) {
    refuse(ix, 'token account creation for an unknown token program');
  }
  return {
    payer: account(ix, 0).key,
    ata: account(ix, 1).key,
    owner: account(ix, 2).key,
    mint: account(ix, 3).key,
    tokenProgram,
  };
}

// ---------------------------------------------------------------------------------------------
// SPL Token: only SyncNative and CloseAccount (wrapped SOL handling)
// ---------------------------------------------------------------------------------------------

export type TokenIx =
  | { kind: 'syncNative'; account: string }
  | { kind: 'closeAccount'; account: string; destination: string; owner: string };

/** SPL Token instruction tags (`TokenInstruction` enum). */
const SYNC_NATIVE = 17;
const CLOSE_ACCOUNT = 9;

export function parseTokenIx(ix: DecodedInstruction): TokenIx {
  if (ix.programId !== TOKEN_PROGRAM_ID) refuse(ix, 'token program instruction');
  if (ix.data.length !== 1) refuse(ix, 'token program instruction');
  if (ix.data[0] === SYNC_NATIVE) {
    exactAccounts(ix, 1, 'sync native');
    return { kind: 'syncNative', account: account(ix, 0).key };
  }
  if (ix.data[0] === CLOSE_ACCOUNT) {
    exactAccounts(ix, 3, 'close account');
    return {
      kind: 'closeAccount',
      account: account(ix, 0).key,
      destination: account(ix, 1).key,
      owner: account(ix, 2).key,
    };
  }
  // Approve, SetAuthority, Transfer, Burn... are never part of a FORGE transaction.
  refuse(ix, `token program instruction ${ix.data[0]}`);
}

// ---------------------------------------------------------------------------------------------
// Meteora DBC
// ---------------------------------------------------------------------------------------------

export function dbcInstructionName(ix: DecodedInstruction): DbcInstructionName | null {
  if (ix.programId !== DBC_PROGRAM_ID) return null;
  for (const [name, discriminator] of Object.entries(DBC_DISCRIMINATORS)) {
    if (startsWith(ix.data, discriminator)) return name as DbcInstructionName;
  }
  return null;
}

/** `initialize_virtual_pool_with_spl_token` (SPL Token base mint, Metaplex metadata). */
export interface DbcInitializeSplIx {
  config: string;
  poolAuthority: string;
  creator: string;
  baseMint: string;
  quoteMint: string;
  pool: string;
  baseVault: string;
  quoteVault: string;
  mintMetadata: string;
  metadataProgram: string;
  payer: string;
  tokenQuoteProgram: string;
  tokenProgram: string;
  systemProgram: string;
  eventAuthority: string;
  program: string;
  name: string;
  symbol: string;
  uri: string;
}

export function parseDbcInitializeSpl(ix: DecodedInstruction): DbcInitializeSplIx {
  if (dbcInstructionName(ix) !== 'initializeVirtualPoolWithSplToken') refuse(ix, 'pool creation');
  // No remaining accounts: a token badge or anything else is not part of a FORGE launch.
  exactAccounts(ix, 16, 'pool creation');
  let offset = 8;
  const [name, afterName] = readBorshString(ix.data, offset);
  offset = afterName;
  const [symbol, afterSymbol] = readBorshString(ix.data, offset);
  offset = afterSymbol;
  const [uri, end] = readBorshString(ix.data, offset);
  if (end !== ix.data.length) refuse(ix, 'pool creation with extra data');
  const k = (i: number) => account(ix, i).key;
  return {
    config: k(0),
    poolAuthority: k(1),
    creator: k(2),
    baseMint: k(3),
    quoteMint: k(4),
    pool: k(5),
    baseVault: k(6),
    quoteVault: k(7),
    mintMetadata: k(8),
    metadataProgram: k(9),
    payer: k(10),
    tokenQuoteProgram: k(11),
    tokenProgram: k(12),
    systemProgram: k(13),
    eventAuthority: k(14),
    program: k(15),
    name,
    symbol,
    uri,
  };
}

/** `swap` (exact in): `SwapParameters { amount_in: u64, minimum_amount_out: u64 }`. */
export interface DbcSwapIx {
  poolAuthority: string;
  config: string;
  pool: string;
  inputTokenAccount: string;
  outputTokenAccount: string;
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
  payer: string;
  tokenBaseProgram: string;
  tokenQuoteProgram: string;
  referralTokenAccount: string;
  eventAuthority: string;
  program: string;
  /** Remaining accounts (only the instructions sysvar is ever acceptable). */
  remaining: string[];
  amountIn: bigint;
  minimumAmountOut: bigint;
}

export function parseDbcSwap(ix: DecodedInstruction): DbcSwapIx {
  if (dbcInstructionName(ix) !== 'swap') refuse(ix, 'swap variant');
  if (ix.data.length !== 24) refuse(ix, 'swap with unexpected data');
  if (ix.accounts.length < 15 || ix.accounts.length > 16) refuse(ix, 'swap accounts');
  if (!account(ix, 9).signer) refuse(ix, 'swap payer');
  const k = (i: number) => account(ix, i).key;
  return {
    poolAuthority: k(0),
    config: k(1),
    pool: k(2),
    inputTokenAccount: k(3),
    outputTokenAccount: k(4),
    baseVault: k(5),
    quoteVault: k(6),
    baseMint: k(7),
    quoteMint: k(8),
    payer: k(9),
    tokenBaseProgram: k(10),
    tokenQuoteProgram: k(11),
    referralTokenAccount: k(12),
    eventAuthority: k(13),
    program: k(14),
    remaining: ix.accounts.slice(15).map((a) => a.key),
    amountIn: readU64(ix.data, 8),
    minimumAmountOut: readU64(ix.data, 16),
  };
}

/** `claim_creator_trading_fee(max_base_amount: u64, max_quote_amount: u64)`. */
export interface DbcClaimCreatorIx {
  poolAuthority: string;
  pool: string;
  tokenAAccount: string;
  tokenBAccount: string;
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
  creator: string;
  tokenBaseProgram: string;
  tokenQuoteProgram: string;
  eventAuthority: string;
  program: string;
  maxBaseAmount: bigint;
  maxQuoteAmount: bigint;
}

export function parseDbcClaimCreator(ix: DecodedInstruction): DbcClaimCreatorIx {
  if (dbcInstructionName(ix) !== 'claimCreatorTradingFee') refuse(ix, 'claim variant');
  if (ix.data.length !== 24) refuse(ix, 'claim with unexpected data');
  exactAccounts(ix, 13, 'claim');
  if (!account(ix, 8).signer) refuse(ix, 'claim creator');
  const k = (i: number) => account(ix, i).key;
  return {
    poolAuthority: k(0),
    pool: k(1),
    tokenAAccount: k(2),
    tokenBAccount: k(3),
    baseVault: k(4),
    quoteVault: k(5),
    baseMint: k(6),
    quoteMint: k(7),
    creator: k(8),
    tokenBaseProgram: k(9),
    tokenQuoteProgram: k(10),
    eventAuthority: k(11),
    program: k(12),
    maxBaseAmount: readU64(ix.data, 8),
    maxQuoteAmount: readU64(ix.data, 16),
  };
}
