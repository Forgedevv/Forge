/**
 * Trading-fee claims on Meteora DBC pools (docs/METEORA.md; proven on devnet in test 2).
 *
 * - Creator claim (`claimCreatorTradingFeeToReceiver`): signed by the pool creator; the creator
 *   share lands on `receiver` (for FORGE creator wallets: the multisig vault, SECURITY.md §5).
 * - Partner claim (`claimPartnerTradingFeeToReceiver`): signed by the config's `feeClaimer`; the
 *   partner share lands on `receiver`, which defaults to the `feeClaimer` itself (the client's
 *   wallet for client configs, the FORGE multisig vault when FORGE is the partner).
 *
 * Both return an UNSIGNED transaction (fee payer and recent blockhash set) plus the amounts
 * claimable when it was built. Nothing is signed or sent here. The claim uses `U64_MAX` limits, so
 * it collects everything accrued when it executes (possibly more than the build-time summary).
 *
 * Quote side (SOL): the SDK creates a temporary WSOL associated account of the claimer, the
 * program pays the fees into it, and it is closed to `receiver` (the receiver gets the fees plus
 * that account's rent, which the payer advanced). It also creates the receiver's base-token
 * associated account if missing (rent paid by the payer).
 */
import { PublicKey, type Commitment, type Connection, type Transaction } from '@solana/web3.js';
import { CreatorService, PartnerService, U64_MAX } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { SOL_QUOTE_MINT } from './constants.js';
import {
  READ_COMMITMENT,
  feeMetrics,
  getDbcPoolState,
  retryRpc,
  type DbcPoolState,
  type RetryOptions,
  type TokenAmounts,
} from './reads.js';

export type ClaimErrorCode =
  'not_pool_creator' | 'not_fee_claimer' | 'unsupported_quote_mint' | 'invalid_receiver';

export class ClaimError extends Error {
  readonly code: ClaimErrorCode;

  constructor(code: ClaimErrorCode, message: string) {
    super(message);
    this.name = 'ClaimError';
    this.code = code;
  }
}

export type ClaimKind = 'creator' | 'partner';

export interface ClaimSummary {
  kind: ClaimKind;
  pool: PublicKey;
  baseMint: PublicKey;
  /** The signer of the claim: pool creator or config `feeClaimer`. */
  claimer: PublicKey;
  receiver: PublicKey;
  /** Fee payer of the transaction (and of the temporary accounts' rent). */
  payer: PublicKey;
  /** Amounts claimable when the transaction was built. */
  claimable: TokenAmounts;
}

export interface ClaimTxResult {
  /** Unsigned claim transaction, or `null` when there is nothing to claim. */
  transaction: Transaction | null;
  /** Block height after which the transaction's blockhash expires (null when no transaction). */
  lastValidBlockHeight: number | null;
  summary: ClaimSummary;
}

export interface ClaimOptions {
  commitment?: Commitment;
  retry?: RetryOptions;
}

export interface CreatorClaimParams {
  pool: PublicKey;
  /** Pool creator (must match the pool state); signs the claim. */
  creator: PublicKey;
  /** Where the creator fees go. */
  receiver: PublicKey;
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

function assertSolQuote(state: DbcPoolState): void {
  if (!state.config.quoteMint.equals(SOL_QUOTE_MINT)) {
    throw new ClaimError(
      'unsupported_quote_mint',
      `Pool ${state.address.toBase58()} is not quoted in SOL: FORGE pools are SOL-quoted only`,
    );
  }
}

function assertReceiver(receiver: PublicKey): void {
  if (receiver.equals(PublicKey.default) || receiver.equals(SOL_QUOTE_MINT)) {
    throw new ClaimError('invalid_receiver', 'Claim receiver is not a valid wallet');
  }
}

function isEmpty(amounts: TokenAmounts): boolean {
  return amounts.base === 0n && amounts.quote === 0n;
}

async function finalize(
  connection: Connection,
  build: () => Promise<Transaction>,
  summary: ClaimSummary,
  options: ClaimOptions,
): Promise<ClaimTxResult> {
  if (isEmpty(summary.claimable)) {
    return { transaction: null, lastValidBlockHeight: null, summary };
  }
  const transaction = await retryRpc(build, options.retry);
  const { blockhash, lastValidBlockHeight } = await retryRpc(
    () => connection.getLatestBlockhash(options.commitment ?? READ_COMMITMENT),
    options.retry,
  );
  transaction.feePayer = summary.payer;
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  return { transaction, lastValidBlockHeight, summary };
}

/**
 * Builds the creator claim of `pool` to `receiver`.
 * @throws ClaimError when `creator` is not the pool creator or the pool is not SOL-quoted.
 * @throws DbcReadError when the pool or its config does not exist.
 */
export async function buildCreatorClaimTx(
  connection: Connection,
  params: CreatorClaimParams,
  options: ClaimOptions = {},
): Promise<ClaimTxResult> {
  const commitment = options.commitment ?? READ_COMMITMENT;
  const state = await getDbcPoolState(connection, params.pool, {
    commitment,
    retry: options.retry,
  });
  assertSolQuote(state);
  assertReceiver(params.receiver);
  const poolCreator = state.virtualPool.poolState.creator;
  if (!poolCreator.equals(params.creator)) {
    throw new ClaimError(
      'not_pool_creator',
      `${params.creator.toBase58()} is not the creator of pool ${params.pool.toBase58()}`,
    );
  }
  const payer = params.payer ?? params.creator;
  const summary: ClaimSummary = {
    kind: 'creator',
    pool: params.pool,
    baseMint: state.virtualPool.poolState.baseMint,
    claimer: params.creator,
    receiver: params.receiver,
    payer,
    claimable: feeMetrics(state).claimable.creator,
  };
  const service = new CreatorService(connection, commitment);
  return finalize(
    connection,
    () =>
      service.claimCreatorTradingFeeToReceiver({
        creator: params.creator,
        payer,
        pool: params.pool,
        receiver: params.receiver,
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
      }),
    summary,
    options,
  );
}

/**
 * Builds the partner claim of `pool` (receiver defaults to the `feeClaimer`).
 * @throws ClaimError when `feeClaimer` is not the config's fee claimer or the pool is not SOL-quoted.
 * @throws DbcReadError when the pool or its config does not exist.
 */
export async function buildPartnerClaimTx(
  connection: Connection,
  params: PartnerClaimParams,
  options: ClaimOptions = {},
): Promise<ClaimTxResult> {
  const commitment = options.commitment ?? READ_COMMITMENT;
  const state = await getDbcPoolState(connection, params.pool, {
    commitment,
    retry: options.retry,
  });
  assertSolQuote(state);
  const receiver = params.receiver ?? params.feeClaimer;
  assertReceiver(receiver);
  if (!state.config.feeClaimer.equals(params.feeClaimer)) {
    throw new ClaimError(
      'not_fee_claimer',
      `${params.feeClaimer.toBase58()} is not the fee claimer of pool ${params.pool.toBase58()}`,
    );
  }
  const payer = params.payer ?? params.feeClaimer;
  const summary: ClaimSummary = {
    kind: 'partner',
    pool: params.pool,
    baseMint: state.virtualPool.poolState.baseMint,
    claimer: params.feeClaimer,
    receiver,
    payer,
    claimable: feeMetrics(state).claimable.partner,
  };
  const service = new PartnerService(connection, commitment);
  return finalize(
    connection,
    () =>
      service.claimPartnerTradingFeeToReceiver({
        feeClaimer: params.feeClaimer,
        payer,
        pool: params.pool,
        receiver,
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
      }),
    summary,
    options,
  );
}
