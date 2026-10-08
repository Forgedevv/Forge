/**
 * $FORGE token-gating (docs/INTERFACES.md §6 `GET /api/gating`, §8; DECISIONS D5).
 *
 * `getForgeBalance` reads the balance of the wallet's associated token account (ATA) of the
 * `FORGE_MINT` mint. Only the ATA counts: tokens held in other token accounts of the same wallet
 * are ignored (every wallet UI uses the ATA). Both the classic SPL Token and Token-2022 programs
 * are supported, depending on the mint's owner program.
 *
 * `FORGE_MINT` is optional (absent before the $FORGE launch): when it is absent, gating is
 * disabled and `getForgeBalance` returns `{ enabled: false }` without any RPC call.
 */
import type { Commitment, Connection, PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import { requireAddresses, type AddressEnv } from './addresses.js';
import { READ_COMMITMENT, retryRpc, type RetryOptions } from './reads.js';

export type ForgeBalance =
  | {
      /** `FORGE_MINT` is not configured: gating is disabled, everybody passes. */
      enabled: false;
    }
  | {
      enabled: true;
      mint: PublicKey;
      /** The wallet's associated token account (may not exist: balance 0). */
      tokenAccount: PublicKey;
      tokenProgram: PublicKey;
      /** Raw units (see `decimals`). */
      balance: bigint;
      decimals: number;
    };

export type GatingErrorCode = 'mint_not_found' | 'not_a_mint';

export class GatingError extends Error {
  readonly code: GatingErrorCode;

  constructor(code: GatingErrorCode, message: string) {
    super(message);
    this.name = 'GatingError';
    this.code = code;
  }
}

export interface GatingOptions {
  /** Where `FORGE_MINT` is read from (defaults to `process.env`). */
  env?: AddressEnv;
  commitment?: Commitment;
  retry?: RetryOptions;
}

/**
 * The wallet's $FORGE balance, or `{ enabled: false }` when `FORGE_MINT` is absent.
 * One RPC call (`getMultipleAccountsInfo` on the mint and both possible ATAs).
 * @throws ForgeAddressError when `FORGE_MINT` is set but invalid.
 * @throws GatingError when the configured mint does not exist or is not a token mint.
 */
export async function getForgeBalance(
  connection: Connection,
  wallet: PublicKey,
  options: GatingOptions = {},
): Promise<ForgeBalance> {
  const mint = requireAddresses(['FORGE_MINT'], options.env).FORGE_MINT;
  if (!mint) return { enabled: false };

  const classicAta = getAssociatedTokenAddressSync(mint, wallet, true, TOKEN_PROGRAM_ID);
  const token2022Ata = getAssociatedTokenAddressSync(mint, wallet, true, TOKEN_2022_PROGRAM_ID);
  const [mintInfo, classicInfo, token2022Info] = await retryRpc(
    () =>
      connection.getMultipleAccountsInfo(
        [mint, classicAta, token2022Ata],
        options.commitment ?? READ_COMMITMENT,
      ),
    options.retry,
  );
  if (!mintInfo) throw new GatingError('mint_not_found', `FORGE_MINT ${mint.toBase58()} not found`);

  let tokenProgram: PublicKey;
  if (mintInfo.owner.equals(TOKEN_PROGRAM_ID)) tokenProgram = TOKEN_PROGRAM_ID;
  else if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = TOKEN_2022_PROGRAM_ID;
  else throw new GatingError('not_a_mint', `FORGE_MINT ${mint.toBase58()} is not a token mint`);
  if (mintInfo.data.length < MINT_SIZE) {
    throw new GatingError('not_a_mint', `FORGE_MINT ${mint.toBase58()} is not a token mint`);
  }
  const { decimals } = unpackMint(mint, mintInfo, tokenProgram);

  const isClassic = tokenProgram.equals(TOKEN_PROGRAM_ID);
  const tokenAccount = isClassic ? classicAta : token2022Ata;
  const accountInfo = isClassic ? classicInfo : token2022Info;

  let balance = 0n;
  if (
    accountInfo &&
    accountInfo.owner.equals(tokenProgram) &&
    accountInfo.data.length >= ACCOUNT_SIZE
  ) {
    const account = unpackAccount(tokenAccount, accountInfo, tokenProgram);
    if (account.mint.equals(mint) && account.owner.equals(wallet)) balance = account.amount;
  }
  return { enabled: true, mint, tokenAccount, tokenProgram, balance, decimals };
}

/**
 * True when the wallet passes the gate: gating disabled, or balance >= `required` (raw units,
 * `FORGE_GATING_AMOUNT`).
 */
export function passesForgeGate(balance: ForgeBalance, required: bigint): boolean {
  if (!balance.enabled) return true;
  return balance.balance >= required;
}
