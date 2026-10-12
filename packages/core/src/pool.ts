/**
 * Launch of the launchpad coin: pool creation + the client's first buy in ONE transaction
 * (`createPoolWithFirstBuy`, docs/METEORA.md; devnet test 3, docs/DECISIONS.md).
 *
 * Who signs:
 * - signer side (apps/signer): the FORGE creator wallet (pool creator) and the base mint keypair,
 *   plus the durable nonce authority when it is another key;
 * - the client (owner) last: fee payer, buyer and receiver of the tokens.
 *
 * With a durable nonce the first instruction is `nonceAdvance` and the `recentBlockhash` is the
 * nonce value read from the chain, so the transaction does not expire while the client signs.
 *
 * Before anything is built, the on-chain config is checked: it must be this client's launchpad
 * coin config (SOL quote, client fee claimer, FORGE creator share, first swap at the minimum fee),
 * the pool and the mint must not exist yet, and the referral account must be a rent-exempt WSOL
 * token account. Nothing here signs or sends.
 *
 * The owner's WSOL account used by the first buy is always created in the transaction with the
 * idempotent instruction: the SDK only adds it when the account is missing at build time, and with
 * a durable nonce the owner can close it before signing (the transaction would then fail and still
 * advance the nonce).
 *
 * No referral on the first buy. A Meteora referral token account on the swap of
 * `createPoolWithFirstBuy` makes the DBC program skip the first-swap minimum fee
 * (`enableFirstSwapWithMinFee`): on devnet the first buy then paid the anti-sniper fee and failed
 * with `ExceededSlippage` even at 10% slippage, while the same launch without a referral landed
 * exactly at the quote (scripts/devnet-tests/reports/signer-routes.md, reproduced in
 * scripts/devnet-tests/reports/core-launch.md). The referral would only have earned 20% of the
 * protocol share of one minimum-fee swap, so it is not worth an anti-sniper fee for the client.
 * Both builders below therefore never put a referral on the first buy, and refuse one
 * (`REFERRAL_UNSUPPORTED`) instead of silently dropping it. Later swaps (swap.ts) keep the FORGE
 * referral: they never get the first-swap minimum fee anyway.
 *
 * `buildUserCoinLaunchTx` is the same launch for a coin created by a user on the client's
 * launchpad config: the user is pool creator, rent payer, fee payer and buyer, the mint is the
 * only other signer.
 */
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  MigrationOption,
  TokenType,
  deriveDbcPoolAddress,
  type PoolConfig,
  type SwapQuoteConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import type { OwnerTransactionSummary } from '@forge/shared';
import type { AddressEnv } from './addresses.js';
import { quoteFirstBuyOnConfig, type FirstBuyQuote } from './config.js';
import { FEES, MIGRATION_THRESHOLD_LAMPORTS, SOL_QUOTE_MINT } from './constants.js';
import {
  LaunchCoinError,
  assertFirstBuyLamports,
  assertLaunchMetadata,
  type LaunchCoinErrorCode,
} from './launch-metadata.js';
import {
  MAX_TRANSACTION_BYTES,
  computeBudgetInstructions,
  priorityFeeLamports,
  readNonce,
  requiredSigners,
  transactionSize,
  type NonceInfo,
} from './tx.js';

// The metadata and first buy checks live in launch-metadata.ts (shared with config.ts); they
// stay part of this module's public surface.
export {
  LAUNCH_METADATA_BUDGET_BYTES,
  LaunchCoinError,
  MAX_FIRST_BUY_LAMPORTS,
  METADATA_LIMITS,
  assertFirstBuyLamports,
  assertLaunchMetadata,
  assertSpecLaunchable,
  launchMetadataBytes,
  type LaunchCoinErrorCode,
} from './launch-metadata.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/**
 * Compute unit limit of the launch transaction: 190,840 CU measured on devnet with the durable
 * nonce (scripts/devnet-tests/reports/core-config-pool.md), 174,034 without it (test 3).
 */
export const LAUNCH_COIN_COMPUTE_UNITS = 300_000;

/** Default slippage on the first buy. The quote is exact (fresh pool, minimum fee). */
export const DEFAULT_FIRST_BUY_SLIPPAGE_BPS = 100;

/** Highest slippage accepted on the first buy. */
export const MAX_FIRST_BUY_SLIPPAGE_BPS = 1000;

/** Size of the Metaplex metadata account created with the pool (measured on devnet). */
export const METADATA_ACCOUNT_SIZE = 607;

/**
 * Metaplex Token Metadata protocol fee charged on metadata creation (0.01 SOL, kept in the
 * metadata account; measured on devnet). It is a program fee, not rent.
 */
export const METAPLEX_CREATE_METADATA_FEE_LAMPORTS = 10_000_000n;

/** Base fee per signature when the cluster does not answer `getFeeForMessage`. */
export const FALLBACK_LAMPORTS_PER_SIGNATURE = 5000n;

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/**
 * Who pays the accounts created with the pool and the pool creation fee. `creator` is only
 * accepted on a config without a pool creation fee: otherwise the FORGE creator wallet would pay
 * the client's own fee (`RENT_PAYER_REFUSED`).
 */
export type RentPayer = 'owner' | 'creator';

export interface DurableNonceParam {
  /** Initialized system nonce account (see `buildCreateNonceAccountTx`). */
  nonceAccount: PublicKey;
  /** Its authority: signs `nonceAdvance`. Recommended: the creator wallet (already a signer). */
  authority: PublicKey;
}

export interface BuildLaunchCoinTxParams {
  connection: Connection;
  /** The launchpad coin config (`buildLaunchpadCoinConfig`), already created on-chain. */
  config: PublicKey;
  /** FORGE creator wallet of this launchpad: pool creator; signs on the signer side. */
  creator: PublicKey;
  /** Client wallet: fee payer, buyer and receiver of the first buy; signs last. */
  owner: PublicKey;
  /** Base mint keypair (or its public key): a fresh key held by the signer, which signs. */
  mint: PublicKey | { publicKey: PublicKey };
  /**
   * Token metadata: Metaplex limits (32 / 10 / 200 bytes) and, together, at most
   * `LAUNCH_METADATA_BUDGET_BYTES` (148) bytes of name + symbol + URI with the durable nonce and a
   * first buy (`assertSpecLaunchable`); beyond that the transaction is `TX_TOO_LARGE`.
   */
  name: string;
  symbol: string;
  metadataUri: string;
  /** SOL spent by the client on the first buy, in lamports (0 = no first buy). */
  firstBuyLamports: bigint;
  /** Slippage on the first buy (default 100 bps, at most 1000). */
  slippageBps?: number;
  /** Durable nonce: the transaction then stays valid until the nonce advances. */
  durableNonce?: DurableNonceParam;
  /**
   * Who pays the pool, mint, metadata and vault accounts and the pool creation fee (default
   * `owner`; `creator` only on a config whose pool creation fee is 0).
   */
  rentPayer?: RentPayer;
  /**
   * @deprecated The first buy never carries a referral (see the top of this file): leave it out
   * or pass `null`. A key is refused with `REFERRAL_UNSUPPORTED`. Kept so that callers passing
   * `null` explicitly still compile.
   */
  referralTokenAccount?: PublicKey | null;
  /**
   * @deprecated Not read any more: it was only the source of the default FORGE referral of the
   * first buy, which is gone. Kept so that existing callers still compile.
   */
  env?: AddressEnv;
  computeUnitLimit?: number;
  /** Priority fee, micro-lamports per compute unit (default 0). */
  computeUnitPriceMicroLamports?: number;
}

/** Lamport amounts, as bigint. */
export interface LaunchCoinCosts {
  /** SOL swapped into the pool by the first buy. */
  firstBuyLamports: bigint;
  /** Fee charged on the first buy (trading + protocol + referral), included in it. */
  firstBuyFeeLamports: bigint;
  /** Config's pool creation fee (paid to the pool, claimable by the partner and the protocol). */
  poolCreationFeeLamports: bigint;
  /** Rent of the pool, mint, metadata and the two vaults (paid by `rentPayer`). */
  poolAccountsRentLamports: bigint;
  /** Metaplex metadata creation fee (paid by `rentPayer`). */
  metaplexFeeLamports: bigint;
  /** Rent of the owner's token account for the new coin (paid by the owner). */
  ownerTokenAccountRentLamports: bigint;
  /**
   * WSOL account rent the owner must hold during the transaction (refunded in it). Always counted
   * with a first buy: the account is (re)created in the transaction even if it exists at build time.
   */
  ownerTemporaryLamports: bigint;
  /** Signature fees + priority fee (paid by the owner, the fee payer). */
  networkFeeLamports: bigint;
  /** `cluster` = `getFeeForMessage`; `estimate` = signatures x 5000 + priority fee. */
  networkFeeSource: 'cluster' | 'estimate';
  /** Everything the owner's balance decreases by. */
  ownerTotalLamports: bigint;
  /** Balance the owner needs before signing (total + temporary). */
  ownerRequiredBalanceLamports: bigint;
  /** Everything the creator wallet pays (0 unless `rentPayer` = creator). */
  creatorTotalLamports: bigint;
}

export interface LaunchCoinSummary {
  config: PublicKey;
  pool: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  owner: PublicKey;
  feePayer: PublicKey;
  rentPayer: PublicKey;
  /** The config's fee claimer (= owner). */
  feeClaimer: PublicKey;
  /** @deprecated Always null: the first buy never carries a referral. */
  referralTokenAccount: null;
  /** @deprecated Always `none`: the first buy never carries a referral. */
  referralSource: 'none';
  /** @deprecated Always false: no referral is ever left out (there is none). */
  referralOmittedForSize: false;
  name: string;
  symbol: string;
  metadataUri: string;
  /** Raw base units (6 decimals) the first buy is quoted to deliver, and the minimum accepted. */
  expectedTokensOut: bigint;
  minimumTokensOut: bigint;
  slippageBps: number;
  costs: LaunchCoinCosts;
  /** Durable nonce used, or null for a recent blockhash. */
  durableNonce: { nonceAccount: PublicKey; authority: PublicKey; nonce: string } | null;
  recentBlockhash: string;
  /** Null with a durable nonce (it does not expire with block height). */
  lastValidBlockHeight: number | null;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  /** Signers on the signer side (creator, mint, nonce authority if distinct), then the owner. */
  signerSideSigners: PublicKey[];
  ownerSigner: PublicKey;
  txBytes: number;
}

export interface LaunchCoinTx {
  /** Unsigned. Signer side signs first (`partialSign`), the owner last. */
  transaction: Transaction;
  summary: LaunchCoinSummary;
}

// ---------------------------------------------------------------------------------------------
// Input checks (pure)
// ---------------------------------------------------------------------------------------------

function fail(code: LaunchCoinErrorCode, message: string): never {
  throw new LaunchCoinError(code, message);
}

function assertDistinctKeys(entries: readonly (readonly [string, PublicKey])[]): void {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [nameA, keyA] = entries[i]!;
      const [nameB, keyB] = entries[j]!;
      if (keyA.equals(keyB)) fail('INVALID_INPUT', `${nameA} and ${nameB} must be different keys`);
    }
  }
}

/**
 * Checks that an on-chain config is the launchpad coin config of `owner` and that it is safe to
 * launch the coin on it: SOL quote, SPL token, fee claimer = owner, FORGE creator share, creator
 * locked liquidity, first swap at the minimum fee (otherwise the client's first buy would pay
 * the anti-sniper fee), fee scheduler base fee, DAMM v2 migration at exactly 10 SOL.
 *
 * @throws LaunchCoinError `CONFIG_MISMATCH` listing every mismatch.
 */
export function assertLaunchCoinConfig(config: PoolConfig, owner: PublicKey): void {
  const problems: string[] = [];
  if (!config.quoteMint.equals(SOL_QUOTE_MINT)) problems.push('quote mint is not SOL');
  if (config.quoteTokenFlag !== 0) problems.push('quote token is not an SPL token');
  if (config.tokenType !== TokenType.SPLToken) problems.push('base token type is not SPL token');
  if (!config.feeClaimer.equals(owner)) problems.push('fee claimer is not the owner wallet');
  if (!config.leftoverReceiver.equals(owner)) problems.push('leftover receiver is not the owner');
  if (config.creatorTradingFeePercentage !== FEES.forgeCreatorSharePct) {
    problems.push(`creator trading fee is not ${FEES.forgeCreatorSharePct}%`);
  }
  if (!(config.creatorPermanentLockedLiquidityPercentage > 0)) {
    problems.push('creator has no permanently locked liquidity');
  }
  if (config.enableFirstSwapWithMinFee !== 1) {
    problems.push(
      'first swap with minimum fee is disabled (the first buy would pay the anti-sniper fee)',
    );
  }
  const mode = config.poolFees.baseFee.baseFeeMode;
  if (mode !== 0 && mode !== 1) problems.push('base fee mode is not a fee scheduler');
  if (config.migrationOption !== MigrationOption.MET_DAMM_V2) {
    problems.push('migration option is not DAMM v2');
  }
  if (BigInt(config.migrationQuoteThreshold.toString()) !== MIGRATION_THRESHOLD_LAMPORTS) {
    problems.push(`migration threshold is not ${MIGRATION_THRESHOLD_LAMPORTS} lamports`);
  }
  if (problems.length > 0) {
    fail('CONFIG_MISMATCH', `config is not a valid launchpad coin config: ${problems.join('; ')}`);
  }
}

/** The quote inputs of a pool config, for a pool that does not exist yet. */
export function quoteConfigFromPoolConfig(config: PoolConfig): SwapQuoteConfig {
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: config.poolFees.baseFee.cliffFeeNumerator,
        firstFactor: config.poolFees.baseFee.firstFactor,
        secondFactor: config.poolFees.baseFee.secondFactor,
        thirdFactor: config.poolFees.baseFee.thirdFactor,
        baseFeeMode: config.poolFees.baseFee.baseFeeMode,
      },
      dynamicFee: config.poolFees.dynamicFee,
    },
    collectFeeMode: config.collectFeeMode,
    sqrtStartPrice: config.sqrtStartPrice,
    migrationQuoteThreshold: config.migrationQuoteThreshold,
    curve: config.curve,
    migrationSqrtPrice: config.migrationSqrtPrice,
  };
}

const toBigInt = (value: BN): bigint => BigInt(value.toString());

/** First buy quote on the on-chain config (no referral), mapped to `LaunchCoinError`. */
function quoteFirstBuy(
  poolConfig: PoolConfig,
  firstBuyLamports: bigint,
  slippageBps: number,
): FirstBuyQuote {
  const quote = quoteFirstBuyOnConfig(quoteConfigFromPoolConfig(poolConfig), firstBuyLamports, {
    slippageBps,
    hasReferral: false,
  });
  if (!quote.ok) {
    fail(
      quote.reason === 'EXCEEDS_CURVE' ? 'FIRST_BUY_EXCEEDS_CURVE' : 'QUOTE_FAILED',
      quote.message,
    );
  }
  return quote;
}

/** Writable flag of a key in the compiled legacy message. */
function isWritableInMessage(transaction: Transaction, key: PublicKey): boolean {
  const message = transaction.compileMessage();
  const index = message.accountKeys.findIndex((k) => k.equals(key));
  return index >= 0 && message.isAccountWritable(index);
}

/** True when `instructions` hold an associated token account creation of `account`. */
function createsAssociatedAccount(
  instructions: readonly TransactionInstruction[],
  account: PublicKey,
): boolean {
  return instructions.some(
    (ix) =>
      ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
      ix.keys[1]?.pubkey.equals(account) === true,
  );
}

/**
 * Refuses any referral on the first buy (see the top of this file): with one, the DBC program
 * does not apply the first-swap minimum fee.
 *
 * @throws LaunchCoinError `REFERRAL_UNSUPPORTED`.
 */
function assertNoFirstBuyReferral(referral: unknown): void {
  if (referral !== undefined && referral !== null) {
    fail(
      'REFERRAL_UNSUPPORTED',
      'the first buy cannot carry a referral: the DBC program then skips the first-swap minimum fee and the buy pays the anti-sniper fee (devnet finding)',
    );
  }
}

/** Checks the inputs shared by both launch builders (pure). */
function assertCommonLaunchInputs(input: {
  keys: readonly (readonly [string, unknown])[];
  firstBuyLamports: bigint;
  name: string;
  symbol: string;
  metadataUri: string;
  slippageBps: number;
  budget: { units: number; microLamports: number };
}): void {
  for (const [name, key] of input.keys) {
    if (!(key instanceof PublicKey)) fail('INVALID_INPUT', `${name} must be a PublicKey`);
  }
  assertFirstBuyLamports(input.firstBuyLamports);
  assertLaunchMetadata(input.name, input.symbol, input.metadataUri);
  if (
    !Number.isInteger(input.slippageBps) ||
    input.slippageBps < 0 ||
    input.slippageBps > MAX_FIRST_BUY_SLIPPAGE_BPS
  ) {
    fail(
      'INVALID_INPUT',
      `slippageBps must be an integer between 0 and ${MAX_FIRST_BUY_SLIPPAGE_BPS}`,
    );
  }
  try {
    computeBudgetInstructions(input.budget);
  } catch (error) {
    fail('INVALID_INPUT', error instanceof Error ? error.message : String(error));
  }
}

type DbcClient = ReturnType<typeof DynamicBondingCurveClient.create>;
type DbcCreatorProgram = ReturnType<DbcClient['creator']['getProgram']>;

interface LaunchState {
  poolConfig: PoolConfig;
  client: DbcClient;
  program: DbcCreatorProgram;
}

/**
 * Reads the config, the pool and the mint: the config must be a DBC pool config accepted by
 * `checkConfig`, the pool and the mint must not exist yet.
 */
async function loadLaunchState(
  connection: Connection,
  accounts: { config: PublicKey; pool: PublicKey; mint: PublicKey },
  checkConfig: (poolConfig: PoolConfig) => void,
): Promise<LaunchState> {
  const { config, pool, mint } = accounts;
  const [configInfo, poolInfo, mintInfo] = await connection.getMultipleAccountsInfo(
    [config, pool, mint],
    'confirmed',
  );
  if (!configInfo) fail('CONFIG_NOT_FOUND', `config ${config.toBase58()} does not exist`);
  if (!configInfo.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) {
    fail('CONFIG_MISMATCH', 'config account is not owned by the DBC program');
  }
  const client = DynamicBondingCurveClient.create(connection, 'confirmed');
  const program = client.creator.getProgram();
  let poolConfig: PoolConfig;
  try {
    poolConfig = program.coder.accounts.decode<PoolConfig>('poolConfig', configInfo.data);
  } catch {
    fail('CONFIG_MISMATCH', 'config account is not a DBC pool config');
  }
  checkConfig(poolConfig);
  if (poolInfo) fail('POOL_EXISTS', `pool ${pool.toBase58()} already exists`);
  if (mintInfo) fail('MINT_EXISTS', `mint ${mint.toBase58()} already exists: use a fresh keypair`);
  return { poolConfig, client, program };
}

interface AssembleLaunchInput {
  client: DbcClient;
  poolConfig: PoolConfig;
  config: PublicKey;
  mint: PublicKey;
  /** Pool creator (signs). */
  poolCreator: PublicKey;
  /** Pays the pool accounts and the pool creation fee (signs). */
  payer: PublicKey;
  /** Fee payer, buyer and receiver of the first buy (signs). */
  buyer: PublicKey;
  name: string;
  symbol: string;
  metadataUri: string;
  firstBuyLamports: bigint;
  slippageBps: number;
  budget: { units: number; microLamports: number };
  nonce: NonceInfo | null;
  recentBlockhash: string;
  lastValidBlockHeight: number | null;
}

/**
 * Quotes the first buy on the fresh pool at the minimum fee (exact: nothing else can trade before
 * it, the pool is created in the same transaction) and assembles the transaction: nonce advance,
 * compute budget, the buyer's WSOL account (idempotent), then the SDK instructions of
 * `createPoolWithFirstBuy` (proven call pattern of devnet test 3), without referral.
 */
async function assembleLaunch(input: AssembleLaunchInput): Promise<{
  transaction: Transaction;
  quote: FirstBuyQuote | null;
  txBytes: number;
}> {
  const { buyer, nonce } = input;
  const quote =
    input.firstBuyLamports > 0n
      ? quoteFirstBuy(input.poolConfig, input.firstBuyLamports, input.slippageBps)
      : null;
  const sdkTx = await input.client.creator.createPoolWithFirstBuy({
    createPoolParam: {
      name: input.name,
      symbol: input.symbol,
      uri: input.metadataUri,
      payer: input.payer,
      poolCreator: input.poolCreator,
      config: input.config,
      baseMint: input.mint,
    },
    ...(quote
      ? {
          firstBuyParam: {
            buyer,
            receiver: buyer,
            buyAmount: new BN(input.firstBuyLamports.toString()),
            minimumAmountOut: new BN(quote.minimumTokensOut.toString()),
            referralTokenAccount: null,
          },
        }
      : {}),
  });

  const instructions: TransactionInstruction[] = [];
  if (nonce) {
    instructions.push(
      SystemProgram.nonceAdvance({
        noncePubkey: nonce.nonceAccount,
        authorizedPubkey: nonce.authority,
      }),
    );
  }
  instructions.push(...computeBudgetInstructions(input.budget));
  // The SDK adds the buyer's WSOL account creation only when it is missing at build time.
  const buyerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, buyer, true, TOKEN_PROGRAM_ID);
  if (quote && !createsAssociatedAccount(sdkTx.instructions, buyerWsol)) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        buyer,
        buyerWsol,
        buyer,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
      ),
    );
  }
  instructions.push(...sdkTx.instructions);
  const transaction = new Transaction({ feePayer: buyer, recentBlockhash: input.recentBlockhash });
  if (input.lastValidBlockHeight !== null) {
    transaction.lastValidBlockHeight = input.lastValidBlockHeight;
  }
  transaction.add(...instructions);
  return { transaction, quote, txBytes: transactionSize(transaction) };
}

/** The required signers, and whether they are exactly `expected` with `feePayer` first. */
function checkSigners(
  transaction: Transaction,
  expected: readonly PublicKey[],
  feePayer: PublicKey,
): { ok: boolean; actual: PublicKey[] } {
  const actual = requiredSigners(transaction);
  const ok =
    actual.length === expected.length &&
    expected.every((k) => actual.some((a) => a.equals(k))) &&
    actual[0]!.equals(feePayer);
  return { ok, actual };
}

/** @throws LaunchCoinError `TX_TOO_LARGE`. */
function assertLaunchSize(txBytes: number): void {
  if (txBytes > MAX_TRANSACTION_BYTES) {
    fail(
      'TX_TOO_LARGE',
      `launch transaction is ${txBytes} bytes (limit ${MAX_TRANSACTION_BYTES}): shorten the name, symbol or metadata URI`,
    );
  }
}

/**
 * Every lamport of a launch, rent read from the cluster. `rentPayerIsOwner`: the owner (buyer,
 * fee payer) also pays the pool accounts, the Metaplex fee and the pool creation fee; otherwise
 * the creator wallet does.
 */
async function computeLaunchCosts(input: {
  connection: Connection;
  program: DbcCreatorProgram;
  transaction: Transaction;
  signatureCount: number;
  nonce: NonceInfo | null;
  budget: { units: number; microLamports: number };
  quote: FirstBuyQuote | null;
  firstBuyLamports: bigint;
  poolCreationFeeLamports: bigint;
  rentPayerIsOwner: boolean;
}): Promise<LaunchCoinCosts> {
  const { connection, quote } = input;
  const rentFor = async (size: number) =>
    BigInt(await connection.getMinimumBalanceForRentExemption(size));
  const [poolRent, mintRent, metadataRent, tokenAccountRent] = await Promise.all([
    rentFor(input.program.account.virtualPool.size),
    rentFor(MINT_SIZE),
    rentFor(METADATA_ACCOUNT_SIZE),
    rentFor(ACCOUNT_SIZE),
  ]);
  const poolAccountsRentLamports = poolRent + mintRent + metadataRent + 2n * tokenAccountRent;
  const firstBuy = quote ? input.firstBuyLamports : 0n;
  const ownerTokenAccountRentLamports = quote ? tokenAccountRent : 0n;
  // The WSOL account is created (idempotently) and closed in the transaction: its rent is only
  // held for the duration of the transaction, whether or not it exists at build time.
  const ownerTemporaryLamports = quote ? tokenAccountRent : 0n;

  let networkFeeSource: 'cluster' | 'estimate' = 'estimate';
  const lamportsPerSignature = input.nonce?.lamportsPerSignature || FALLBACK_LAMPORTS_PER_SIGNATURE;
  let networkFeeLamports =
    BigInt(input.signatureCount) * lamportsPerSignature + priorityFeeLamports(input.budget);
  try {
    const fee = (await connection.getFeeForMessage(input.transaction.compileMessage(), 'confirmed'))
      .value;
    if (typeof fee === 'number' && Number.isSafeInteger(fee) && fee > 0) {
      networkFeeLamports = BigInt(fee);
      networkFeeSource = 'cluster';
    }
  } catch {
    // Keep the estimate: the fee only informs the summary, it is not part of the transaction.
  }

  const rentPayerCosts =
    poolAccountsRentLamports +
    METAPLEX_CREATE_METADATA_FEE_LAMPORTS +
    input.poolCreationFeeLamports;
  const ownerTotalLamports =
    firstBuy +
    networkFeeLamports +
    ownerTokenAccountRentLamports +
    (input.rentPayerIsOwner ? rentPayerCosts : 0n);
  return {
    firstBuyLamports: firstBuy,
    firstBuyFeeLamports: quote ? quote.feeLamports : 0n,
    poolCreationFeeLamports: input.poolCreationFeeLamports,
    poolAccountsRentLamports,
    metaplexFeeLamports: METAPLEX_CREATE_METADATA_FEE_LAMPORTS,
    ownerTokenAccountRentLamports,
    ownerTemporaryLamports,
    networkFeeLamports,
    networkFeeSource,
    ownerTotalLamports,
    ownerRequiredBalanceLamports: ownerTotalLamports + ownerTemporaryLamports,
    creatorTotalLamports: input.rentPayerIsOwner ? 0n : rentPayerCosts,
  };
}

// ---------------------------------------------------------------------------------------------
// Builder: the launchpad coin (FORGE creator wallet, client first buy)
// ---------------------------------------------------------------------------------------------

/**
 * Builds the launch transaction of the launchpad coin: pool creation + the owner's first buy
 * (never with a referral), with compute budget instructions and, optionally, a durable nonce.
 *
 * @throws LaunchCoinError (typed `code`, `REFERRAL_UNSUPPORTED` when a referral is given), or
 *   DurableNonceError from tx.ts.
 */
export async function buildLaunchCoinTx(params: BuildLaunchCoinTxParams): Promise<LaunchCoinTx> {
  const { connection, config, creator, owner } = params;
  const mint = params.mint instanceof PublicKey ? params.mint : params.mint.publicKey;
  const rentPayerKind: RentPayer = params.rentPayer ?? 'owner';
  const slippageBps = params.slippageBps ?? DEFAULT_FIRST_BUY_SLIPPAGE_BPS;
  const computeUnitLimit = params.computeUnitLimit ?? LAUNCH_COIN_COMPUTE_UNITS;
  const computeUnitPriceMicroLamports = params.computeUnitPriceMicroLamports ?? 0;
  const budget = { units: computeUnitLimit, microLamports: computeUnitPriceMicroLamports };

  // 1. Inputs.
  assertCommonLaunchInputs({
    keys: [
      ['config', config],
      ['creator', creator],
      ['owner', owner],
      ['mint', mint],
    ],
    firstBuyLamports: params.firstBuyLamports,
    name: params.name,
    symbol: params.symbol,
    metadataUri: params.metadataUri,
    slippageBps,
    budget,
  });
  if (rentPayerKind !== 'owner' && rentPayerKind !== 'creator') {
    fail('INVALID_INPUT', "rentPayer must be 'owner' or 'creator'");
  }
  assertNoFirstBuyReferral(params.referralTokenAccount);

  const keys: (readonly [string, PublicKey])[] = [
    ['config', config],
    ['creator', creator],
    ['owner', owner],
    ['mint', mint],
  ];
  if (params.durableNonce) keys.push(['nonceAccount', params.durableNonce.nonceAccount]);
  assertDistinctKeys(keys);
  if (params.durableNonce) {
    const { authority, nonceAccount } = params.durableNonce;
    if (authority.equals(mint) || authority.equals(config) || authority.equals(nonceAccount)) {
      fail('INVALID_INPUT', 'the nonce authority must be the creator, the owner or a separate key');
    }
  }

  const pool = deriveDbcPoolAddress(SOL_QUOTE_MINT, mint, config);
  const rentPayer = rentPayerKind === 'owner' ? owner : creator;

  // 2. On-chain state: config (this owner's launchpad coin config), pool and mint not existing.
  const { poolConfig, client, program } = await loadLaunchState(
    connection,
    { config, pool, mint },
    (decoded) => assertLaunchCoinConfig(decoded, owner),
  );
  const poolCreationFeeLamports = toBigInt(poolConfig.poolCreationFee);
  if (rentPayerKind === 'creator' && poolCreationFeeLamports !== 0n) {
    fail(
      'RENT_PAYER_REFUSED',
      `the creator wallet cannot pay the rent on a config with a pool creation fee (${poolCreationFeeLamports} lamports): it would pay the client's own fee`,
    );
  }

  // 3. Blockhash or durable nonce.
  let nonce: NonceInfo | null = null;
  let recentBlockhash: string;
  let lastValidBlockHeight: number | null = null;
  if (params.durableNonce) {
    nonce = await readNonce(connection, params.durableNonce.nonceAccount, {
      expectedAuthority: params.durableNonce.authority,
    });
    recentBlockhash = nonce.nonce;
  } else {
    const latest = await connection.getLatestBlockhash('confirmed');
    recentBlockhash = latest.blockhash;
    lastValidBlockHeight = latest.lastValidBlockHeight;
  }

  // 4. Quote and instructions.
  const { transaction, quote, txBytes } = await assembleLaunch({
    client,
    poolConfig,
    config,
    mint,
    poolCreator: creator,
    payer: rentPayer,
    buyer: owner,
    name: params.name,
    symbol: params.symbol,
    metadataUri: params.metadataUri,
    firstBuyLamports: params.firstBuyLamports,
    slippageBps,
    budget,
    nonce,
    recentBlockhash,
    lastValidBlockHeight,
  });

  // 5. Signers: exactly owner, creator, mint (+ the nonce authority). With the owner paying
  //    the rent, the creator wallet must not be debitable at all (read-only signer).
  const expected = [owner, creator, mint];
  if (nonce && !expected.some((k) => k.equals(nonce.authority))) expected.push(nonce.authority);
  const signers = checkSigners(transaction, expected, owner);
  if (!signers.ok) {
    fail(
      'UNEXPECTED_SIGNERS',
      `unexpected signers: ${signers.actual.map((k) => k.toBase58()).join(', ')} (fee payer must be the owner)`,
    );
  }
  if (rentPayerKind === 'owner' && isWritableInMessage(transaction, creator)) {
    fail(
      'UNEXPECTED_SIGNERS',
      'the creator wallet must not be writable when the owner pays the rent',
    );
  }

  // 6. Size.
  assertLaunchSize(txBytes);

  // 7. Costs (rent read from the cluster).
  const costs = await computeLaunchCosts({
    connection,
    program,
    transaction,
    signatureCount: signers.actual.length,
    nonce,
    budget,
    quote,
    firstBuyLamports: params.firstBuyLamports,
    poolCreationFeeLamports,
    rentPayerIsOwner: rentPayerKind === 'owner',
  });

  const signerSideSigners = [creator, mint];
  if (nonce && !nonce.authority.equals(owner) && !nonce.authority.equals(creator)) {
    signerSideSigners.push(nonce.authority);
  }

  return {
    transaction,
    summary: {
      config,
      pool,
      mint,
      creator,
      owner,
      feePayer: owner,
      rentPayer,
      feeClaimer: poolConfig.feeClaimer,
      referralTokenAccount: null,
      referralSource: 'none',
      referralOmittedForSize: false,
      name: params.name,
      symbol: params.symbol,
      metadataUri: params.metadataUri,
      expectedTokensOut: quote ? quote.tokensOut : 0n,
      minimumTokensOut: quote ? quote.minimumTokensOut : 0n,
      slippageBps,
      costs,
      durableNonce: nonce
        ? { nonceAccount: nonce.nonceAccount, authority: nonce.authority, nonce: nonce.nonce }
        : null,
      recentBlockhash,
      lastValidBlockHeight,
      computeUnitLimit,
      computeUnitPriceMicroLamports,
      signerSideSigners,
      ownerSigner: owner,
      txBytes,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Builder: a user coin on the client's launchpad config
// ---------------------------------------------------------------------------------------------

export interface BuildUserCoinLaunchTxParams {
  connection: Connection;
  /** The client's launchpad config (`buildLaunchpadConfig`), already created on-chain. */
  config: PublicKey;
  /** The user: pool creator, rent payer, fee payer, buyer and receiver; signs last. */
  wallet: PublicKey;
  /** Fresh base mint keypair (or its public key); the only other signer. */
  mint: PublicKey | { publicKey: PublicKey };
  /** Token metadata (Metaplex limits: 32 / 10 / 200 bytes, all of them fit in this launch). */
  name: string;
  symbol: string;
  metadataUri: string;
  /** SOL spent by the user on the first buy, in lamports (0 = no first buy, at most 10 SOL). */
  firstBuyLamports: bigint;
  /** Slippage on the first buy (default 100 bps, at most 1000). */
  slippageBps?: number;
  /**
   * Accepted for symmetry with `buildLaunchCoinTx`; not read: a user coin launch involves no
   * FORGE address (no referral on the first buy, no platform fee on the creation).
   */
  env?: AddressEnv;
  computeUnitLimit?: number;
  /** Priority fee, micro-lamports per compute unit (default 0). */
  computeUnitPriceMicroLamports?: number;
}

export interface UserCoinLaunchSummary {
  config: PublicKey;
  pool: PublicKey;
  mint: PublicKey;
  /** The user: pool creator, rent payer, fee payer, buyer and receiver of the first buy. */
  wallet: PublicKey;
  /** The config's fee claimer (the launchpad owner, who earns the partner fees). */
  feeClaimer: PublicKey;
  name: string;
  symbol: string;
  metadataUri: string;
  /** Raw base units (6 decimals) the first buy is quoted to deliver, and the minimum accepted. */
  expectedTokensOut: bigint;
  minimumTokensOut: bigint;
  slippageBps: number;
  /**
   * Same figures as `LaunchCoinCosts`, read the same way: the `owner*` fields are the wallet's
   * (it pays everything, including the pool accounts and the pool creation fee);
   * `creatorTotalLamports` is 0 because no separate creator wallet pays anything.
   */
  costs: LaunchCoinCosts;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  /** Required signers in message order: the wallet (fee payer) then the mint. */
  signers: PublicKey[];
  txBytes: number;
}

export interface UserCoinLaunchTx {
  /** Unsigned. The mint signs (`partialSign`), then the wallet signs last. */
  transaction: Transaction;
  summary: UserCoinLaunchSummary;
}

/**
 * Checks that an on-chain config can launch a user coin with a first buy at the minimum fee: SOL
 * quote, SPL token program for both tokens, `enableFirstSwapWithMinFee`. Nothing about who owns
 * the config or the creator share: the template checks the config address itself.
 *
 * @throws LaunchCoinError `CONFIG_MISMATCH` listing every mismatch.
 */
export function assertUserCoinConfig(config: PoolConfig): void {
  const problems: string[] = [];
  if (!config.quoteMint.equals(SOL_QUOTE_MINT)) problems.push('quote mint is not SOL');
  if (config.quoteTokenFlag !== 0) problems.push('quote token is not an SPL token');
  if (config.tokenType !== TokenType.SPLToken) problems.push('base token type is not SPL token');
  if (config.enableFirstSwapWithMinFee !== 1) {
    problems.push(
      'first swap with minimum fee is disabled (the first buy would pay the anti-sniper fee)',
    );
  }
  if (problems.length > 0) {
    fail('CONFIG_MISMATCH', `config cannot launch a user coin: ${problems.join('; ')}`);
  }
}

/**
 * Builds the launch transaction of a coin created by a user on the client's launchpad config:
 * pool creation + the user's first buy at the minimum fee (no referral), with a compute unit limit
 * (and a priority fee when given) and a recent blockhash. The user is pool creator, rent payer,
 * fee payer and buyer; the mint is the only other signer. Rent is read from the cluster.
 *
 * @throws LaunchCoinError (typed `code`).
 */
export async function buildUserCoinLaunchTx(
  params: BuildUserCoinLaunchTxParams,
): Promise<UserCoinLaunchTx> {
  const { connection, config, wallet } = params;
  const mint = params.mint instanceof PublicKey ? params.mint : params.mint.publicKey;
  const slippageBps = params.slippageBps ?? DEFAULT_FIRST_BUY_SLIPPAGE_BPS;
  const computeUnitLimit = params.computeUnitLimit ?? LAUNCH_COIN_COMPUTE_UNITS;
  const computeUnitPriceMicroLamports = params.computeUnitPriceMicroLamports ?? 0;
  const budget = { units: computeUnitLimit, microLamports: computeUnitPriceMicroLamports };

  // 1. Inputs.
  assertCommonLaunchInputs({
    keys: [
      ['config', config],
      ['wallet', wallet],
      ['mint', mint],
    ],
    firstBuyLamports: params.firstBuyLamports,
    name: params.name,
    symbol: params.symbol,
    metadataUri: params.metadataUri,
    slippageBps,
    budget,
  });
  assertDistinctKeys([
    ['config', config],
    ['wallet', wallet],
    ['mint', mint],
  ]);
  const baseMint = mint;
  const pool = deriveDbcPoolAddress(SOL_QUOTE_MINT, baseMint, config);

  // 2. On-chain state.
  const { poolConfig, client, program } = await loadLaunchState(
    connection,
    { config, pool, mint: baseMint },
    assertUserCoinConfig,
  );
  const poolCreationFeeLamports = toBigInt(poolConfig.poolCreationFee);

  // 3. Recent blockhash: the user signs right away, no durable nonce.
  const latest = await connection.getLatestBlockhash('confirmed');

  // 4. Quote and instructions.
  const { transaction, quote, txBytes } = await assembleLaunch({
    client,
    poolConfig,
    config,
    mint: baseMint,
    poolCreator: wallet,
    payer: wallet,
    buyer: wallet,
    name: params.name,
    symbol: params.symbol,
    metadataUri: params.metadataUri,
    firstBuyLamports: params.firstBuyLamports,
    slippageBps,
    budget,
    nonce: null,
    recentBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });

  // 5. Signers: exactly the wallet (fee payer, first) and the mint.
  const signers = checkSigners(transaction, [wallet, baseMint], wallet);
  if (!signers.ok) {
    fail(
      'UNEXPECTED_SIGNERS',
      `unexpected signers: ${signers.actual.map((k) => k.toBase58()).join(', ')} (expected the wallet, fee payer, and the mint)`,
    );
  }

  // 6. Size.
  assertLaunchSize(txBytes);

  // 7. Costs (rent read from the cluster): the wallet pays everything.
  const costs = await computeLaunchCosts({
    connection,
    program,
    transaction,
    signatureCount: signers.actual.length,
    nonce: null,
    budget,
    quote,
    firstBuyLamports: params.firstBuyLamports,
    poolCreationFeeLamports,
    rentPayerIsOwner: true,
  });

  return {
    transaction,
    summary: {
      config,
      pool,
      mint: baseMint,
      wallet,
      feeClaimer: poolConfig.feeClaimer,
      name: params.name,
      symbol: params.symbol,
      metadataUri: params.metadataUri,
      expectedTokensOut: quote ? quote.tokensOut : 0n,
      minimumTokensOut: quote ? quote.minimumTokensOut : 0n,
      slippageBps,
      costs,
      recentBlockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      computeUnitLimit,
      computeUnitPriceMicroLamports,
      signers: signers.actual,
      txBytes,
    },
  };
}

/**
 * The summary in the shared `OwnerTransactionSummary` shape (docs/INTERFACES.md §6, decimal
 * strings). `estimatedNetworkFeeLamports` is everything the owner pays besides the first buy
 * (network fee, rents, Metaplex fee and, when the owner pays it, the pool creation fee), so the
 * client is never debited more than first buy + that amount. `ownerRequiredBalanceLamports` is
 * what the owner's wallet must hold to sign: that debit plus the temporary WSOL account rent
 * (refunded within the transaction, but needed while it runs).
 */
export function toOwnerTransactionSummary(summary: LaunchCoinSummary): OwnerTransactionSummary {
  const { costs } = summary;
  return {
    coinName: summary.name,
    coinSymbol: summary.symbol,
    firstBuyLamports: costs.firstBuyLamports.toString(),
    estimatedNetworkFeeLamports: (costs.ownerTotalLamports - costs.firstBuyLamports).toString(),
    ownerWallet: summary.owner.toBase58(),
    ownerRequiredBalanceLamports: costs.ownerRequiredBalanceLamports.toString(),
  };
}
