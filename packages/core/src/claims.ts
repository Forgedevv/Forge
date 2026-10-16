/**
 * Fee claims on Meteora DBC pools (docs/METEORA.md; proven on devnet in test 2 and core-claims).
 *
 * - Creator claim (`claimCreatorTradingFee`): signed by the pool creator; the creator share goes
 *   to `receiver` (for FORGE creator wallets: the multisig vault, SECURITY.md §5, see
 *   `buildForgeCreatorClaimTx`).
 * - Partner claim (`claimTradingFee`): signed by the config's `feeClaimer`; the partner share goes
 *   to `receiver`, which defaults to the `feeClaimer` itself (the client's wallet for client
 *   configs, the FORGE multisig vault when FORGE is the partner).
 * - Partner pool creation fee (`claimPartnerPoolCreationFee`): signed by the config's
 *   `feeClaimer`; the partner share of the pool creation fee (90%, the protocol keeps 10%) goes to
 *   `receiver` (default: the `feeClaimer`). Once per pool.
 *
 * Every builder returns an UNSIGNED transaction (fee payer and recent blockhash set) plus a summary
 * of the amounts and costs. Nothing is signed or sent here.
 *
 * Trading fee claims, quote side (SOL). The program pays the fees into a WSOL token account, so a
 * temporary one is used: the claimer's WSOL associated account, created by the payer, closed back
 * to the PAYER (its rent returns to whoever advanced it). Then:
 * - receiver = payer: nothing else; the claim is uncapped (`U64_MAX`), so it collects everything
 *   accrued when it executes (at least the build-time amount);
 * - receiver != payer: the claim is capped to the build-time claimable amount, a self-transfer of
 *   that amount on the WSOL account asserts on-chain that it was received in full (the transaction
 *   fails otherwise, e.g. when another claim got there first), and the payer then transfers
 *   exactly that amount of SOL to the receiver.
 * So the payer's balance only decreases by the network fee and the one-time rent below, and the
 * claimer's balance does not change at all when the claimer is not the payer (read-only signer).
 * A claimer WSOL account that already holds WSOL is refused when the claimer is not the payer
 * (`claimer_wsol_not_empty`): closing it would hand that WSOL to the payer.
 *
 * Base side (the coin): the program needs a base token account even when there is nothing to
 * claim (FORGE configs collect fees in SOL only). It is the receiver's associated account, created
 * idempotently by the payer: the first claim of each pool costs the payer that account's rent
 * (~0.00204 SOL), which stays in an account owned by the receiver (recoverable by closing it).
 */
import {
  ACCOUNT_SIZE,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type Commitment,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  CreatorService,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  PartnerService,
  TokenType,
  U64_MAX,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
import { getMultisigVault, type AddressEnv } from './addresses.js';
import { SOL_QUOTE_MINT } from './constants.js';
import {
  READ_COMMITMENT,
  feeMetrics,
  getDbcPoolState,
  poolCreationFeeStatus,
  retryRpc,
  type DbcPoolState,
  type RetryOptions,
  type TokenAmounts,
} from './reads.js';

/** Base fee per signature (lamports); claims set no priority fee. */
export const CLAIM_LAMPORTS_PER_SIGNATURE = 5000n;

// Pool creation fee helpers live in reads.ts (CoinOfConfig uses them); re-exported here.
export { PARTNER_POOL_CREATION_FEE_CLAIMED_BIT, partnerPoolCreationFeeShare } from './reads.js';

export type ClaimErrorCode =
  | 'not_pool_creator'
  | 'not_fee_claimer'
  | 'unsupported_quote_mint'
  | 'invalid_receiver'
  | 'receiver_mismatch'
  | 'receiver_not_rent_exempt'
  | 'claimer_wsol_not_empty'
  | 'unexpected_sdk_instructions'
  // DAMM v2 position fee claims (position-claims.ts).
  | 'not_migrated'
  | 'damm_pool_not_found'
  | 'damm_pool_mismatch'
  | 'position_not_found'
  | 'position_mismatch'
  | 'position_not_owned';

export class ClaimError extends Error {
  readonly code: ClaimErrorCode;

  constructor(code: ClaimErrorCode, message: string) {
    super(message);
    this.name = 'ClaimError';
    this.code = code;
  }
}

export type ClaimKind = 'creator' | 'partner';

/** Lamport costs of a trading fee claim, as bigint. */
export interface ClaimCosts {
  /** Signature fees (signers x 5000 lamports; no priority fee), paid by the payer. */
  networkFeeLamports: bigint;
  /**
   * Rent of the receiver's coin account, created on the first claim of a pool (paid by the payer,
   * kept in that account, which the receiver owns). 0 when it already exists.
   */
  receiverTokenAccountRentLamports: bigint;
  /** WSOL account rent the payer advances during the transaction (refunded in it). */
  temporaryLamports: bigint;
  /** Everything the payer's balance decreases by: network fee + one-time rent. */
  payerTotalLamports: bigint;
  /** Balance the payer needs before signing (total + temporary). */
  payerRequiredBalanceLamports: bigint;
}

export interface ClaimSummary {
  kind: ClaimKind;
  pool: PublicKey;
  baseMint: PublicKey;
  /** The signer of the claim: pool creator or config `feeClaimer`. */
  claimer: PublicKey;
  receiver: PublicKey;
  /** Fee payer of the transaction: advances the temporary rent, gets it back. */
  payer: PublicKey;
  /** Amounts claimable when the transaction was built. */
  claimable: TokenAmounts;
  /**
   * SOL the receiver gets from the transaction, lamports. Exact when `quoteIsExact` (receiver is
   * not the payer: the claim is capped to it); otherwise a lower bound (uncapped claim).
   */
  receiverQuoteLamports: bigint;
  quoteIsExact: boolean;
  /** Zero costs when there is no transaction. */
  costs: ClaimCosts;
  /**
   * `receiverQuoteLamports - costs.payerTotalLamports`: what the claim brings in SOL once its
   * costs are paid (negative when it costs more than it collects). Base tokens are not valued.
   */
  netLamports: bigint;
}

export type ClaimSkipReason = 'nothing_to_claim' | 'not_worthwhile';

export interface ClaimTxResult {
  /** Unsigned claim transaction, or `null` when skipped (see `skipReason`). */
  transaction: Transaction | null;
  /** Block height after which the transaction's blockhash expires (null when no transaction). */
  lastValidBlockHeight: number | null;
  /** Why there is no transaction, or null. */
  skipReason: ClaimSkipReason | null;
  summary: ClaimSummary;
}

export interface ClaimOptions {
  commitment?: Commitment;
  retry?: RetryOptions;
  /**
   * Skip (no transaction, `skipReason: 'not_worthwhile'`) unless the claim nets strictly more
   * than this many lamports (see `isClaimWorthwhile`). Default: never skip a non-empty claim.
   */
  minNetLamports?: bigint;
}

export interface CreatorClaimParams {
  pool: PublicKey;
  /** Pool creator (must match the pool state); signs the claim. */
  creator: PublicKey;
  /** Where the creator fees go. */
  receiver: PublicKey;
  /**
   * When set, `receiver` must equal it (`receiver_mismatch` otherwise): pins the destination,
   * e.g. to `getMultisigVault()` for FORGE creator wallets.
   */
  expectedReceiver?: PublicKey;
  /** Fee payer; defaults to the creator. */
  payer?: PublicKey;
}

export interface PartnerClaimParams {
  pool: PublicKey;
  /** Config `feeClaimer` (must match the config); signs the claim. */
  feeClaimer: PublicKey;
  /** Where the partner fees go; defaults to the `feeClaimer`. */
  receiver?: PublicKey;
  /** Fee payer; defaults to the `feeClaimer`. */
  payer?: PublicKey;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** Smallest claimable SOL amount that nets more than `minNetLamports` once `costs` are paid. */
export function minimumWorthwhileClaimLamports(costs: ClaimCosts, minNetLamports = 0n): bigint {
  return costs.payerTotalLamports + minNetLamports + 1n;
}

/**
 * True when the claim collects more SOL than it costs, by more than `minNetLamports` (default 0):
 * callers skip claims below it. Base tokens are not valued (FORGE configs collect SOL fees only).
 */
export function isClaimWorthwhile(summary: ClaimSummary, minNetLamports = 0n): boolean {
  return summary.receiverQuoteLamports > 0n && summary.netLamports > minNetLamports;
}

/** @throws ClaimError `unsupported_quote_mint` unless the pool is quoted in SOL. */
export function assertSolQuotedPool(state: DbcPoolState): void {
  if (!state.config.quoteMint.equals(SOL_QUOTE_MINT)) {
    throw new ClaimError(
      'unsupported_quote_mint',
      `Pool ${state.address.toBase58()} is not quoted in SOL: FORGE pools are SOL-quoted only`,
    );
  }
}

const assertSolQuote = assertSolQuotedPool;

/** @throws ClaimError `invalid_receiver` for anything but a usable wallet address. */
export function assertClaimReceiver(receiver: PublicKey): void {
  if (!(receiver instanceof PublicKey)) {
    throw new ClaimError('invalid_receiver', 'Claim receiver must be a PublicKey');
  }
  if (receiver.equals(PublicKey.default) || receiver.equals(SOL_QUOTE_MINT)) {
    throw new ClaimError('invalid_receiver', 'Claim receiver is not a valid wallet');
  }
}

const assertReceiver = assertClaimReceiver;

function isEmpty(amounts: TokenAmounts): boolean {
  return amounts.base === 0n && amounts.quote === 0n;
}

const ZERO_COSTS: ClaimCosts = {
  networkFeeLamports: 0n,
  receiverTokenAccountRentLamports: 0n,
  temporaryLamports: 0n,
  payerTotalLamports: 0n,
  payerRequiredBalanceLamports: 0n,
};

function baseTokenProgram(state: DbcPoolState): PublicKey {
  return state.config.tokenType === TokenType.SPLToken ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
}

// ---------------------------------------------------------------------------------------------
// Trading fee claims
// ---------------------------------------------------------------------------------------------

interface TradingClaimInput {
  kind: ClaimKind;
  state: DbcPoolState;
  claimer: PublicKey;
  receiver: PublicKey;
  payer: PublicKey;
  claimable: TokenAmounts;
  /** Builds the SDK claim transaction with this quote cap; its DBC instruction is kept. */
  sdkClaim: (maxQuoteAmount: BN) => Promise<Transaction>;
}

async function buildTradingClaim(
  connection: Connection,
  input: TradingClaimInput,
  options: ClaimOptions,
): Promise<ClaimTxResult> {
  const { kind, state, claimer, receiver, payer, claimable } = input;
  const commitment = options.commitment ?? READ_COMMITMENT;
  const exact = !receiver.equals(payer);
  const baseSummary = {
    kind,
    pool: state.address,
    baseMint: state.virtualPool.poolState.baseMint,
    claimer,
    receiver,
    payer,
    claimable,
    quoteIsExact: exact,
  };
  if (isEmpty(claimable)) {
    return {
      transaction: null,
      lastValidBlockHeight: null,
      skipReason: 'nothing_to_claim',
      summary: { ...baseSummary, receiverQuoteLamports: 0n, costs: ZERO_COSTS, netLamports: 0n },
    };
  }

  const baseMint = state.virtualPool.poolState.baseMint;
  const baseProgram = baseTokenProgram(state);
  const receiverBase = getAssociatedTokenAddressSync(baseMint, receiver, true, baseProgram);
  const claimerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, claimer, true, TOKEN_PROGRAM_ID);
  const quote = claimable.quote;

  // 1. The DBC claim instruction, built by the SDK (accounts: receiver's coin account, claimer's
  //    WSOL account). Its pre/post instructions are replaced below.
  const sdkTx = await retryRpc(
    () => input.sdkClaim(exact ? new BN(quote.toString()) : U64_MAX),
    options.retry,
  );
  const claimIxs = sdkTx.instructions.filter((ix) =>
    ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
  );
  const claimIx = claimIxs[0];
  if (
    claimIxs.length !== 1 ||
    !claimIx ||
    !claimIx.keys.some((k) => k.pubkey.equals(receiverBase)) ||
    !claimIx.keys.some((k) => k.pubkey.equals(claimerWsol))
  ) {
    throw new ClaimError(
      'unexpected_sdk_instructions',
      'The SDK claim transaction does not have the expected claim instruction',
    );
  }

  // 2. On-chain state: does the receiver's coin account exist, can the receiver take the SOL.
  const [infos, tokenAccountRent] = await Promise.all([
    retryRpc(
      () => connection.getMultipleAccountsInfo([receiverBase, claimerWsol, receiver], commitment),
      options.retry,
    ),
    retryRpc(
      () => connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, commitment),
      options.retry,
    ),
  ]);
  const [receiverBaseInfo, claimerWsolInfo, receiverInfo] = infos;
  // The temporary WSOL account is closed to the payer: when it already holds WSOL of a claimer
  // that is not the payer, that WSOL would move to the payer. Refuse instead.
  if (claimerWsolInfo && !claimer.equals(payer) && claimerWsolInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    let amount: bigint;
    try {
      amount = unpackAccount(claimerWsol, claimerWsolInfo, TOKEN_PROGRAM_ID).amount;
    } catch {
      // Not a token account (e.g. lamports sent to the address): the idempotent creation takes it.
      amount = 0n;
    }
    if (amount > 0n) {
      throw new ClaimError(
        'claimer_wsol_not_empty',
        `The claimer's WSOL account ${claimerWsol.toBase58()} holds ${amount} lamports of WSOL: unwrap it before claiming with another payer`,
      );
    }
  }
  if (exact && quote > 0n) {
    const size = receiverInfo?.data.length ?? 0;
    const minimum = BigInt(
      await retryRpc(
        () => connection.getMinimumBalanceForRentExemption(size, commitment),
        options.retry,
      ),
    );
    const after = BigInt(receiverInfo?.lamports ?? 0) + quote;
    if (after < minimum) {
      throw new ClaimError(
        'receiver_not_rent_exempt',
        `Receiver ${receiver.toBase58()} would hold ${after} lamports after the claim, below its rent-exempt minimum ${minimum}: fund it first`,
      );
    }
  }

  // 3. Instructions.
  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      receiverBase,
      receiver,
      baseMint,
      baseProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      claimerWsol,
      claimer,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    ),
    claimIx,
  ];
  if (exact && quote > 0n) {
    // Self-transfer: fails with InsufficientFunds unless the WSOL account holds the full amount.
    instructions.push(createTransferInstruction(claimerWsol, claimerWsol, claimer, quote));
  }
  instructions.push(createCloseAccountInstruction(claimerWsol, payer, claimer));
  if (exact && quote > 0n) {
    instructions.push(
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: receiver, lamports: quote }),
    );
  }

  const { blockhash, lastValidBlockHeight } = await retryRpc(
    () => connection.getLatestBlockhash(commitment),
    options.retry,
  );
  const transaction = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
  transaction.add(...instructions);

  // 4. Costs and net.
  const signatures = BigInt(transaction.compileMessage().header.numRequiredSignatures);
  const networkFeeLamports = signatures * CLAIM_LAMPORTS_PER_SIGNATURE;
  const receiverTokenAccountRentLamports = receiverBaseInfo ? 0n : BigInt(tokenAccountRent);
  const temporaryLamports = claimerWsolInfo ? 0n : BigInt(tokenAccountRent);
  const payerTotalLamports = networkFeeLamports + receiverTokenAccountRentLamports;
  const costs: ClaimCosts = {
    networkFeeLamports,
    receiverTokenAccountRentLamports,
    temporaryLamports,
    payerTotalLamports,
    payerRequiredBalanceLamports: payerTotalLamports + temporaryLamports,
  };
  const summary: ClaimSummary = {
    ...baseSummary,
    receiverQuoteLamports: quote,
    costs,
    netLamports: quote - payerTotalLamports,
  };
  if (options.minNetLamports !== undefined && !isClaimWorthwhile(summary, options.minNetLamports)) {
    return { transaction: null, lastValidBlockHeight: null, skipReason: 'not_worthwhile', summary };
  }
  return { transaction, lastValidBlockHeight, skipReason: null, summary };
}

/**
 * Builds the creator claim of `pool` to `receiver` (see the module comment for the transaction).
 * @throws ClaimError when `creator` is not the pool creator, the pool is not SOL-quoted, the
 *   receiver is invalid, differs from `expectedReceiver`, or cannot be rent-exempt.
 * @throws DbcReadError when the pool or its config does not exist.
 */
export async function buildCreatorClaimTx(
  connection: Connection,
  params: CreatorClaimParams,
  options: ClaimOptions = {},
): Promise<ClaimTxResult> {
  const commitment = options.commitment ?? READ_COMMITMENT;
  assertReceiver(params.receiver);
  if (params.expectedReceiver && !params.expectedReceiver.equals(params.receiver)) {
    throw new ClaimError(
      'receiver_mismatch',
      `Creator fees of pool ${params.pool.toBase58()} must go to ${params.expectedReceiver.toBase58()}, not ${params.receiver.toBase58()}`,
    );
  }
  const state = await getDbcPoolState(connection, params.pool, {
    commitment,
    retry: options.retry,
  });
  assertSolQuote(state);
  const poolCreator = state.virtualPool.poolState.creator;
  if (!poolCreator.equals(params.creator)) {
    throw new ClaimError(
      'not_pool_creator',
      `${params.creator.toBase58()} is not the creator of pool ${params.pool.toBase58()}`,
    );
  }
  const payer = params.payer ?? params.creator;
  const service = new CreatorService(connection, commitment);
  return buildTradingClaim(
    connection,
    {
      kind: 'creator',
      state,
      claimer: params.creator,
      receiver: params.receiver,
      payer,
      claimable: feeMetrics(state).claimable.creator,
      sdkClaim: (maxQuoteAmount) =>
        service.claimCreatorTradingFeeToReceiver({
          creator: params.creator,
          payer,
          pool: params.pool,
          receiver: params.receiver,
          maxBaseAmount: U64_MAX,
          maxQuoteAmount,
        }),
    },
    options,
  );
}

export interface ForgeCreatorClaimParams {
  pool: PublicKey;
  /** FORGE creator wallet of the launchpad (the pool creator); signs the claim. */
  creator: PublicKey;
  /** Fee payer; defaults to the creator. */
  payer?: PublicKey;
}

/**
 * The creator claim of a FORGE creator wallet: the receiver is always the FORGE multisig vault
 * (`FORGE_MULTISIG_VAULT`, SECURITY.md §5), read from `env` (defaults to `process.env`).
 * @throws ForgeAddressError when `FORGE_MULTISIG_VAULT` is missing or invalid; as
 *   `buildCreatorClaimTx` otherwise.
 */
export async function buildForgeCreatorClaimTx(
  connection: Connection,
  params: ForgeCreatorClaimParams,
  options: ClaimOptions & { env?: AddressEnv } = {},
): Promise<ClaimTxResult> {
  const vault = getMultisigVault(options.env);
  return buildCreatorClaimTx(
    connection,
    { ...params, receiver: vault, expectedReceiver: vault },
    options,
  );
}

/**
 * Builds the partner claim of `pool` (receiver defaults to the `feeClaimer`).
 * @throws ClaimError when `feeClaimer` is not the config's fee claimer, the pool is not
 *   SOL-quoted, or the receiver is invalid or cannot be rent-exempt.
 * @throws DbcReadError when the pool or its config does not exist.
 */
export async function buildPartnerClaimTx(
  connection: Connection,
  params: PartnerClaimParams,
  options: ClaimOptions = {},
): Promise<ClaimTxResult> {
  const commitment = options.commitment ?? READ_COMMITMENT;
  const receiver = params.receiver ?? params.feeClaimer;
  assertReceiver(receiver);
  const state = await getDbcPoolState(connection, params.pool, {
    commitment,
    retry: options.retry,
  });
  assertSolQuote(state);
  if (!state.config.feeClaimer.equals(params.feeClaimer)) {
    throw new ClaimError(
      'not_fee_claimer',
      `${params.feeClaimer.toBase58()} is not the fee claimer of pool ${params.pool.toBase58()}`,
    );
  }
  const payer = params.payer ?? params.feeClaimer;
  const service = new PartnerService(connection, commitment);
  return buildTradingClaim(
    connection,
    {
      kind: 'partner',
      state,
      claimer: params.feeClaimer,
      receiver,
      payer,
      claimable: feeMetrics(state).claimable.partner,
      sdkClaim: (maxQuoteAmount) =>
        service.claimPartnerTradingFeeToReceiver({
          feeClaimer: params.feeClaimer,
          payer,
          pool: params.pool,
          receiver,
          maxBaseAmount: U64_MAX,
          maxQuoteAmount,
        }),
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// Partner pool creation fee
// ---------------------------------------------------------------------------------------------

export interface PartnerPoolCreationFeeClaimParams {
  pool: PublicKey;
  /** Config `feeClaimer` (must match the config); signs the claim. */
  feeClaimer: PublicKey;
  /** Where the fee goes (SOL); defaults to the `feeClaimer`. */
  receiver?: PublicKey;
  /** Fee payer; defaults to the `feeClaimer`. */
  payer?: PublicKey;
}

export interface PoolCreationFeeClaimSummary {
  pool: PublicKey;
  config: PublicKey;
  feeClaimer: PublicKey;
  receiver: PublicKey;
  payer: PublicKey;
  /** Pool creation fee of the config, lamports (paid when the pool was created). */
  poolCreationFeeLamports: bigint;
  /** Partner share: the fee minus the protocol's 10% (rounded down), lamports. */
  partnerShareLamports: bigint;
  /** True when the partner already claimed it for this pool. */
  alreadyClaimed: boolean;
  /** SOL the receiver gets from the transaction (0 when there is none), lamports. */
  claimableLamports: bigint;
  /** Signature fees of the transaction (0 when there is none), paid by the payer. */
  networkFeeLamports: bigint;
  /** `claimableLamports - networkFeeLamports` (0 when there is no transaction). */
  netLamports: bigint;
}

export type PoolCreationFeeSkipReason = 'no_pool_creation_fee' | 'already_claimed';

export interface PoolCreationFeeClaimTxResult {
  /** Unsigned transaction, or `null` when there is nothing to claim. */
  transaction: Transaction | null;
  lastValidBlockHeight: number | null;
  skipReason: PoolCreationFeeSkipReason | null;
  summary: PoolCreationFeeClaimSummary;
}

/**
 * Builds the claim of the partner's share of the pool creation fee of `pool`
 * (`claimPartnerPoolCreationFee`): the client claims the coin creation fees its launchpad charged.
 * Returns no transaction when the config has no pool creation fee or it was already claimed.
 * @throws ClaimError when `feeClaimer` is not the config's fee claimer, or the receiver is invalid
 *   or cannot be rent-exempt.
 * @throws DbcReadError when the pool or its config does not exist.
 */
export async function buildPartnerPoolCreationFeeClaimTx(
  connection: Connection,
  params: PartnerPoolCreationFeeClaimParams,
  options: Omit<ClaimOptions, 'minNetLamports'> = {},
): Promise<PoolCreationFeeClaimTxResult> {
  const commitment = options.commitment ?? READ_COMMITMENT;
  const receiver = params.receiver ?? params.feeClaimer;
  assertReceiver(receiver);
  const state = await getDbcPoolState(connection, params.pool, {
    commitment,
    retry: options.retry,
  });
  if (!state.config.feeClaimer.equals(params.feeClaimer)) {
    throw new ClaimError(
      'not_fee_claimer',
      `${params.feeClaimer.toBase58()} is not the fee claimer of pool ${params.pool.toBase58()}`,
    );
  }
  const payer = params.payer ?? params.feeClaimer;
  const status = poolCreationFeeStatus(state);
  const poolCreationFeeLamports = status.totalLamports;
  const partnerShareLamports = status.partnerShareLamports;
  const alreadyClaimed = status.partnerClaimed;
  const summary: PoolCreationFeeClaimSummary = {
    pool: params.pool,
    config: state.virtualPool.poolState.config,
    feeClaimer: params.feeClaimer,
    receiver,
    payer,
    poolCreationFeeLamports,
    partnerShareLamports,
    alreadyClaimed,
    claimableLamports: 0n,
    networkFeeLamports: 0n,
    netLamports: 0n,
  };
  if (partnerShareLamports === 0n || alreadyClaimed) {
    return {
      transaction: null,
      lastValidBlockHeight: null,
      skipReason: alreadyClaimed ? 'already_claimed' : 'no_pool_creation_fee',
      summary,
    };
  }

  // The fee is moved as lamports from the pool account: the receiver must end rent-exempt.
  const receiverInfo = await retryRpc(
    () => connection.getAccountInfo(receiver, commitment),
    options.retry,
  );
  const minimum = BigInt(
    await retryRpc(
      () =>
        connection.getMinimumBalanceForRentExemption(receiverInfo?.data.length ?? 0, commitment),
      options.retry,
    ),
  );
  const after = BigInt(receiverInfo?.lamports ?? 0) + partnerShareLamports;
  if (after < minimum) {
    throw new ClaimError(
      'receiver_not_rent_exempt',
      `Receiver ${receiver.toBase58()} would hold ${after} lamports after the claim, below its rent-exempt minimum ${minimum}: fund it first`,
    );
  }

  const service = new PartnerService(connection, commitment);
  const sdkTx = await retryRpc(
    () => service.claimPartnerPoolCreationFee({ pool: params.pool, feeReceiver: receiver }),
    options.retry,
  );
  const claimIx = sdkTx.instructions.find((ix) =>
    ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
  );
  if (
    sdkTx.instructions.length !== 1 ||
    !claimIx ||
    !claimIx.keys.some((k) => k.isSigner && k.pubkey.equals(params.feeClaimer)) ||
    !claimIx.keys.some((k) => k.isWritable && k.pubkey.equals(receiver))
  ) {
    throw new ClaimError(
      'unexpected_sdk_instructions',
      'The SDK pool creation fee claim does not have the expected instruction',
    );
  }
  const { blockhash, lastValidBlockHeight } = await retryRpc(
    () => connection.getLatestBlockhash(commitment),
    options.retry,
  );
  const transaction = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
  transaction.add(claimIx);
  const signatures = BigInt(transaction.compileMessage().header.numRequiredSignatures);
  const networkFeeLamports = signatures * CLAIM_LAMPORTS_PER_SIGNATURE;
  return {
    transaction,
    lastValidBlockHeight,
    skipReason: null,
    summary: {
      ...summary,
      claimableLamports: partnerShareLamports,
      networkFeeLamports,
      netLamports: partnerShareLamports - networkFeeLamports,
    },
  };
}
