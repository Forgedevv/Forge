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
 * the pool and the mint must not exist yet, and the optional referral account must be a
 * rent-exempt WSOL token account. Nothing here signs or sends.
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
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
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
import { quoteFirstBuyOnConfig, type FirstBuyQuote } from './config.js';
import { FEES, MIGRATION_THRESHOLD_LAMPORTS, SOL_QUOTE_MINT, solToLamports } from './constants.js';
import {
  MAX_TRANSACTION_BYTES,
  assertRentExempt,
  computeBudgetInstructions,
  priorityFeeLamports,
  readNonce,
  requiredSigners,
  transactionSize,
  type NonceInfo,
} from './tx.js';

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

/** Largest first buy (the spec bound, `launchpadCoin.firstBuySol` <= 100 SOL). */
export const MAX_FIRST_BUY_LAMPORTS = solToLamports(100);

/** Metaplex token metadata limits, in UTF-8 bytes. */
export const METADATA_LIMITS = { name: 32, symbol: 10, uri: 200 } as const;

/** Size of the Metaplex metadata account created with the pool (measured on devnet). */
export const METADATA_ACCOUNT_SIZE = 607;

/**
 * Metaplex Token Metadata protocol fee charged on metadata creation (0.01 SOL, kept in the
 * metadata account; measured on devnet). It is a program fee, not rent.
 */
export const METAPLEX_CREATE_METADATA_FEE_LAMPORTS = 10_000_000n;

/** Base fee per signature when the cluster does not answer `getFeeForMessage`. */
export const FALLBACK_LAMPORTS_PER_SIGNATURE = 5000n;

const SYMBOL_RE = /^[A-Z0-9]{2,10}$/;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type LaunchCoinErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_MISMATCH'
  | 'POOL_EXISTS'
  | 'MINT_EXISTS'
  | 'REFERRAL_INVALID'
  | 'FIRST_BUY_EXCEEDS_CURVE'
  | 'QUOTE_FAILED'
  | 'UNEXPECTED_SIGNERS'
  | 'TX_TOO_LARGE';

/** The launch transaction cannot be built. Nothing has been sent. */
export class LaunchCoinError extends Error {
  readonly code: LaunchCoinErrorCode;

  constructor(code: LaunchCoinErrorCode, message: string) {
    super(message);
    this.name = 'LaunchCoinError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** Who pays the accounts created with the pool and the pool creation fee. */
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
  /** Token metadata (Metaplex limits: 32 / 10 / 200 bytes). */
  name: string;
  symbol: string;
  metadataUri: string;
  /** SOL spent by the client on the first buy, in lamports (0 = no first buy). */
  firstBuyLamports: bigint;
  /** Slippage on the first buy (default 100 bps, at most 1000). */
  slippageBps?: number;
  /** Durable nonce: the transaction then stays valid until the nonce advances. */
  durableNonce?: DurableNonceParam;
  /** Who pays the pool, mint, metadata and vault accounts and the pool creation fee. */
  rentPayer?: RentPayer;
  /** Optional Meteora referral (a WSOL token account) on the first buy. Default: none. */
  referralTokenAccount?: PublicKey | null;
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
  /** WSOL account rent the owner must hold during the transaction (refunded in it). */
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
  referralTokenAccount: PublicKey | null;
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

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function fail(code: LaunchCoinErrorCode, message: string): never {
  throw new LaunchCoinError(code, message);
}

/**
 * Checks the token metadata against the Metaplex limits and the spec rules (symbol 2-10
 * uppercase letters or digits, https metadata URI).
 *
 * @throws LaunchCoinError `INVALID_INPUT`.
 */
export function assertLaunchMetadata(name: string, symbol: string, metadataUri: string): void {
  if (typeof name !== 'string' || name.trim().length === 0 || name !== name.trim()) {
    fail('INVALID_INPUT', 'name must be a non-empty string without surrounding spaces');
  }
  if (utf8Length(name) > METADATA_LIMITS.name) {
    fail('INVALID_INPUT', `name must be at most ${METADATA_LIMITS.name} bytes`);
  }
  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) {
    fail('INVALID_INPUT', 'symbol must be 2 to 10 uppercase letters or digits');
  }
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

/** First buy quote on the on-chain config, mapped to `LaunchCoinError`. */
function quoteFirstBuy(
  poolConfig: PoolConfig,
  firstBuyLamports: bigint,
  slippageBps: number,
  hasReferral: boolean,
): FirstBuyQuote {
  const quote = quoteFirstBuyOnConfig(quoteConfigFromPoolConfig(poolConfig), firstBuyLamports, {
    slippageBps,
    hasReferral,
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

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

/**
 * Builds the launch transaction of the launchpad coin: pool creation + the owner's first buy,
 * with compute budget instructions and, optionally, a durable nonce.
 *
 * @throws LaunchCoinError (typed `code`) or DurableNonceError / RentExemptionError from tx.ts.
 */
export async function buildLaunchCoinTx(params: BuildLaunchCoinTxParams): Promise<LaunchCoinTx> {
  const { connection, config, creator, owner } = params;
  const mint = params.mint instanceof PublicKey ? params.mint : params.mint.publicKey;
  const rentPayerKind: RentPayer = params.rentPayer ?? 'owner';
  const referral = params.referralTokenAccount ?? null;
  const slippageBps = params.slippageBps ?? DEFAULT_FIRST_BUY_SLIPPAGE_BPS;
  const computeUnitLimit = params.computeUnitLimit ?? LAUNCH_COIN_COMPUTE_UNITS;
  const computeUnitPriceMicroLamports = params.computeUnitPriceMicroLamports ?? 0;
  const budget = { units: computeUnitLimit, microLamports: computeUnitPriceMicroLamports };

  // 1. Inputs.
  for (const [name, key] of [
    ['config', config],
    ['creator', creator],
    ['owner', owner],
    ['mint', mint],
  ] as const) {
    if (!(key instanceof PublicKey)) fail('INVALID_INPUT', `${name} must be a PublicKey`);
  }
  if (rentPayerKind !== 'owner' && rentPayerKind !== 'creator') {
    fail('INVALID_INPUT', "rentPayer must be 'owner' or 'creator'");
  }
  assertFirstBuyLamports(params.firstBuyLamports);
  assertLaunchMetadata(params.name, params.symbol, params.metadataUri);
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > MAX_FIRST_BUY_SLIPPAGE_BPS
  ) {
    fail(
      'INVALID_INPUT',
      `slippageBps must be an integer between 0 and ${MAX_FIRST_BUY_SLIPPAGE_BPS}`,
    );
  }
  try {
    computeBudgetInstructions(budget);
  } catch (error) {
    fail('INVALID_INPUT', error instanceof Error ? error.message : String(error));
  }
  const keys: (readonly [string, PublicKey])[] = [
    ['config', config],
    ['creator', creator],
    ['owner', owner],
    ['mint', mint],
  ];
  if (referral) keys.push(['referralTokenAccount', referral]);
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

  // 2. On-chain state: config, pool, mint, owner WSOL account, referral.
  const ownerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID);
  const lookups = [config, pool, mint, ownerWsol, ...(referral ? [referral] : [])];
  const [configInfo, poolInfo, mintInfo, ownerWsolInfo, referralInfo] =
    await connection.getMultipleAccountsInfo(lookups, 'confirmed');

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
  assertLaunchCoinConfig(poolConfig, owner);
  if (poolInfo) fail('POOL_EXISTS', `pool ${pool.toBase58()} already exists`);
  if (mintInfo) fail('MINT_EXISTS', `mint ${mint.toBase58()} already exists: use a fresh keypair`);

  if (referral) {
    if (!referralInfo) fail('REFERRAL_INVALID', 'referral token account does not exist');
    let tokenAccount: ReturnType<typeof unpackAccount>;
    try {
      tokenAccount = unpackAccount(referral, referralInfo, TOKEN_PROGRAM_ID);
    } catch {
      fail('REFERRAL_INVALID', 'referral account is not an SPL token account');
    }
    if (!tokenAccount.mint.equals(NATIVE_MINT) || !tokenAccount.isInitialized) {
      fail('REFERRAL_INVALID', 'referral account must be an initialized WSOL token account');
    }
    await assertRentExempt(connection, [{ address: referral, label: 'referralTokenAccount' }]);
  }

  // 3. Quote of the first buy on the fresh pool, at the minimum fee (exact: nothing else can
  //    trade before it, the pool is created in the same transaction).
  const quote =
    params.firstBuyLamports > 0n
      ? quoteFirstBuy(poolConfig, params.firstBuyLamports, slippageBps, referral !== null)
      : null;

  // 4. SDK instructions (proven call pattern of test 3).
  const sdkTx = await client.creator.createPoolWithFirstBuy({
    createPoolParam: {
      name: params.name,
      symbol: params.symbol,
      uri: params.metadataUri,
      payer: rentPayer,
      poolCreator: creator,
      config,
      baseMint: mint,
    },
    ...(quote
      ? {
          firstBuyParam: {
            buyer: owner,
            receiver: owner,
            buyAmount: new BN(params.firstBuyLamports.toString()),
            minimumAmountOut: new BN(quote.minimumTokensOut.toString()),
            referralTokenAccount: referral,
          },
        }
      : {}),
  });

  // 5. Blockhash or durable nonce.
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

  const instructions: TransactionInstruction[] = [];
  if (nonce) {
    instructions.push(
      SystemProgram.nonceAdvance({
        noncePubkey: nonce.nonceAccount,
        authorizedPubkey: nonce.authority,
      }),
    );
  }
  instructions.push(...computeBudgetInstructions(budget), ...sdkTx.instructions);
  const transaction = new Transaction({ feePayer: owner, recentBlockhash });
  if (lastValidBlockHeight !== null) transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.add(...instructions);

  // 6. Signers: exactly owner, creator, mint (+ the nonce authority). With the owner paying
  //    the rent, the creator wallet must not be debitable at all (read-only signer).
  const expected = [owner, creator, mint];
  if (nonce && !expected.some((k) => k.equals(nonce.authority))) expected.push(nonce.authority);
  const actual = requiredSigners(transaction);
  const sameSet =
    actual.length === expected.length && expected.every((k) => actual.some((a) => a.equals(k)));
  if (!sameSet || !actual[0]!.equals(owner)) {
    fail(
      'UNEXPECTED_SIGNERS',
      `unexpected signers: ${actual.map((k) => k.toBase58()).join(', ')} (fee payer must be the owner)`,
    );
  }
  if (rentPayerKind === 'owner' && isWritableInMessage(transaction, creator)) {
    fail(
      'UNEXPECTED_SIGNERS',
      'the creator wallet must not be writable when the owner pays the rent',
    );
  }

  // 7. Size.
  const txBytes = transactionSize(transaction);
  if (txBytes > MAX_TRANSACTION_BYTES) {
    fail(
      'TX_TOO_LARGE',
      `launch transaction is ${txBytes} bytes (limit ${MAX_TRANSACTION_BYTES}): shorten the name, symbol or metadata URI`,
    );
  }

  // 8. Costs (rent read from the cluster).
  const rentFor = async (size: number) =>
    BigInt(await connection.getMinimumBalanceForRentExemption(size));
  const [poolRent, mintRent, metadataRent, tokenAccountRent] = await Promise.all([
    rentFor(program.account.virtualPool.size),
    rentFor(MINT_SIZE),
    rentFor(METADATA_ACCOUNT_SIZE),
    rentFor(ACCOUNT_SIZE),
  ]);
  const poolAccountsRentLamports = poolRent + mintRent + metadataRent + 2n * tokenAccountRent;
  const poolCreationFeeLamports = toBigInt(poolConfig.poolCreationFee);
  const firstBuy = quote ? params.firstBuyLamports : 0n;
  const ownerTokenAccountRentLamports = quote ? tokenAccountRent : 0n;
  const ownerTemporaryLamports = quote && !ownerWsolInfo ? tokenAccountRent : 0n;

  let networkFeeLamports: bigint;
  let networkFeeSource: 'cluster' | 'estimate' = 'estimate';
  const signatureCount = BigInt(actual.length);
  const lamportsPerSignature = nonce?.lamportsPerSignature || FALLBACK_LAMPORTS_PER_SIGNATURE;
  networkFeeLamports = signatureCount * lamportsPerSignature + priorityFeeLamports(budget);
  try {
    const fee = (await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed'))
      .value;
    if (typeof fee === 'number' && Number.isSafeInteger(fee) && fee > 0) {
      networkFeeLamports = BigInt(fee);
      networkFeeSource = 'cluster';
    }
  } catch {
    // Keep the estimate: the fee only informs the summary, it is not part of the transaction.
  }

  const rentPayerCosts =
    poolAccountsRentLamports + METAPLEX_CREATE_METADATA_FEE_LAMPORTS + poolCreationFeeLamports;
  const ownerTotalLamports =
    firstBuy +
    networkFeeLamports +
    ownerTokenAccountRentLamports +
    (rentPayerKind === 'owner' ? rentPayerCosts : 0n);
  const costs: LaunchCoinCosts = {
    firstBuyLamports: firstBuy,
    firstBuyFeeLamports: quote ? quote.feeLamports : 0n,
    poolCreationFeeLamports,
    poolAccountsRentLamports,
    metaplexFeeLamports: METAPLEX_CREATE_METADATA_FEE_LAMPORTS,
    ownerTokenAccountRentLamports,
    ownerTemporaryLamports,
    networkFeeLamports,
    networkFeeSource,
    ownerTotalLamports,
    ownerRequiredBalanceLamports: ownerTotalLamports + ownerTemporaryLamports,
    creatorTotalLamports: rentPayerKind === 'creator' ? rentPayerCosts : 0n,
  };

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
      referralTokenAccount: referral,
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

/**
 * The summary in the shared `OwnerTransactionSummary` shape (docs/INTERFACES.md §6, decimal
 * strings). `estimatedNetworkFeeLamports` is everything the owner pays besides the first buy
 * (network fee, rents, Metaplex fee and, when the owner pays it, the pool creation fee), so the
 * client is never debited more than first buy + that amount.
 */
export function toOwnerTransactionSummary(summary: LaunchCoinSummary): OwnerTransactionSummary {
  const { costs } = summary;
  return {
    coinName: summary.name,
    coinSymbol: summary.symbol,
    firstBuyLamports: costs.firstBuyLamports.toString(),
    estimatedNetworkFeeLamports: (costs.ownerTotalLamports - costs.firstBuyLamports).toString(),
    ownerWallet: summary.owner.toBase58(),
  };
}
