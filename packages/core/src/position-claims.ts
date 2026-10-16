/**
 * DAMM v2 position fee claims of a migrated DBC pool (docs/METEORA.md "Migration", DECISIONS.md
 * D6 and D27, devnet test 2).
 *
 * When a launchpad coin graduates, `migrateToDammV2` creates the DAMM v2 pool and two locked
 * positions: the partner's and the creator's. The creator's position (a FORGE creator wallet for
 * a launchpad coin, permanently locked) keeps earning the migrated pool's trading fees; nothing
 * but a `claim_position_fee` signed by the position owner moves them. This module:
 * - finds the migrated DAMM v2 pool of a DBC pool (pure, from the decoded DBC state) and the
 *   creator's position(s) on it (the position NFT is held by the creator);
 * - builds the UNSIGNED claim of their fees to a receiver (`@meteora-ag/cp-amm-sdk`, pinned
 *   1.5.1), the creator signing, with an optional fee payer; shaped like `buildCreatorClaimTx`:
 *   transaction, summary, costs, skip reasons.
 *
 * Transaction (SOL-quoted pools only):
 *   1. create-idempotent the receiver's coin account (the payer funds its rent, once per pool);
 *   2. create-idempotent the creator's WSOL associated account (temporary, rent from the payer);
 *   3. one `claim_position_fee` per position: coin fees to the receiver's coin account, SOL fees
 *      to the creator's temporary WSOL account;
 *   4. close the temporary WSOL account to the receiver: the fees AND the account's rent reach
 *      the receiver as lamports. `claim_position_fee` has no amount cap and fees keep accruing
 *      until the transaction executes, so the exact forward of the DBC claim is not possible
 *      here: the rent (~0.002 SOL) moves from the payer to the receiver with every claim.
 * The transaction never removes liquidity, never closes, locks, splits or transfers the position
 * or its NFT, and contains no other program.
 */
import {
  ACCOUNT_SIZE,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from '@solana/spl-token';
import {
  PublicKey,
  Transaction,
  type AccountInfo,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  MigrationOption,
  deriveDammV2PoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  CP_AMM_PROGRAM_ID,
  CpAmm,
  derivePositionNftAccount,
  getUnClaimLpFee,
  type PoolState as DammV2PoolState,
  type PositionState as DammV2PositionState,
} from '@meteora-ag/cp-amm-sdk';
import { getMultisigVault, type AddressEnv } from './addresses.js';
import {
  CLAIM_LAMPORTS_PER_SIGNATURE,
  ClaimError,
  assertClaimReceiver,
  assertSolQuotedPool,
  type ClaimOptions,
} from './claims.js';
import {
  READ_COMMITMENT,
  getDbcPoolState,
  graduationStatus,
  retryRpc,
  toBigint,
  type DbcPoolState,
  type ReadOptions,
  type TokenAmounts,
} from './reads.js';

export type { DammV2PoolState, DammV2PositionState };

/** DAMM v2 (cp-amm) program id, from the pinned SDK. */
export const DAMM_V2_PROGRAM_ID: PublicKey = CP_AMM_PROGRAM_ID;

/** Anchor discriminator of `claim_position_fee` (sha256("global:claim_position_fee")[0..8]). */
export const CLAIM_POSITION_FEE_DISCRIMINATOR = Buffer.from([180, 38, 154, 17, 133, 33, 162, 211]);

/** Account indexes of `claim_position_fee` (cp-amm SDK 1.5.1 IDL). */
export const CLAIM_POSITION_FEE_ACCOUNTS = {
  poolAuthority: 0,
  pool: 1,
  position: 2,
  tokenAAccount: 3,
  tokenBAccount: 4,
  tokenAVault: 5,
  tokenBVault: 6,
  tokenAMint: 7,
  tokenBMint: 8,
  positionNftAccount: 9,
  owner: 10,
  tokenAProgram: 11,
  tokenBProgram: 12,
  eventAuthority: 13,
  program: 14,
} as const;

/** `tokenAFlag` / `tokenBFlag` of a DAMM v2 pool: 0 = SPL Token, 1 = Token-2022. */
export function dammV2TokenProgram(flag: number): PublicKey {
  return flag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

export interface MigratedDammV2Pool {
  /** The DAMM v2 pool the DBC pool migrated to. */
  dammPool: PublicKey;
  /** The DAMM v2 config of the migration fee option (`DAMM_V2_MIGRATION_FEE_ADDRESS`). */
  dammConfig: PublicKey;
}

/**
 * Pure: the DAMM v2 pool of a migrated DBC pool, derived like the SDK's `migrateToDammV2`
 * (`deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint)` with the DAMM v2 config the SDK
 * pins for the config's `migrationFeeOption`, `DAMM_V2_MIGRATION_FEE_ADDRESS`). Null when the
 * pool has not migrated yet, migrates to DAMM v1, or has a migration fee option the pinned SDK
 * does not know (FORGE configs use `FixedBps25`, D27).
 */
export function migratedDammV2Pool(
  state: Pick<DbcPoolState, 'virtualPool' | 'config'>,
): MigratedDammV2Pool | null {
  if (graduationStatus(state) !== 'migrated') return null;
  if (state.config.migrationOption !== MigrationOption.MET_DAMM_V2) return null;
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[state.config.migrationFeeOption];
  if (!dammConfig) return null;
  const p = state.virtualPool.poolState;
  return {
    dammPool: deriveDammV2PoolAddress(dammConfig, p.baseMint, state.config.quoteMint),
    dammConfig,
  };
}

/** A DAMM v2 position: the account, the NFT that owns it and the NFT's token account. */
export interface DammV2PositionRef {
  position: PublicKey;
  nftMint: PublicKey;
  positionNftAccount: PublicKey;
}

export interface DammV2PositionSummary extends DammV2PositionRef {
  /** DAMM v2 pool of the position. */
  dammPool: PublicKey;
  liquidity: { unlocked: bigint; vested: bigint; permanentLocked: bigint };
  /** Fees claimable now: `base` = token A (the coin), `quote` = token B (SOL), raw units. */
  pendingFees: TokenAmounts;
}

/** Pure: unclaimed fees of a position (SDK `getUnClaimLpFee`), as bigint. */
export function positionPendingFees(
  poolState: DammV2PoolState,
  positionState: DammV2PositionState,
): TokenAmounts {
  const fees = getUnClaimLpFee(poolState, positionState);
  return { base: toBigint(fees.feeTokenA), quote: toBigint(fees.feeTokenB) };
}

/** Pure: summary of one position of `poolState`. */
export function summarizePosition(
  poolState: DammV2PoolState,
  ref: DammV2PositionRef,
  positionState: DammV2PositionState,
): DammV2PositionSummary {
  return {
    ...ref,
    dammPool: positionState.pool,
    liquidity: {
      unlocked: toBigint(positionState.unlockedLiquidity),
      vested: toBigint(positionState.vestedLiquidity),
      permanentLocked: toBigint(positionState.permanentLockedLiquidity),
    },
    pendingFees: positionPendingFees(poolState, positionState),
  };
}

/** Pure: sum of the pending fees of `positions`. */
export function sumPendingFees(positions: readonly DammV2PositionSummary[]): TokenAmounts {
  let base = 0n;
  let quote = 0n;
  for (const p of positions) {
    base += p.pendingFees.base;
    quote += p.pendingFees.quote;
  }
  return { base, quote };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

function cpAmm(connection: Connection): CpAmm {
  return new CpAmm(connection);
}

/** Fetches a DAMM v2 pool. @throws ClaimError `damm_pool_not_found` when the account is missing. */
export async function getDammV2PoolState(
  connection: Connection,
  dammPool: PublicKey,
  options: ReadOptions = {},
): Promise<DammV2PoolState> {
  try {
    return await retryRpc(() => cpAmm(connection).fetchPoolState(dammPool), options.retry);
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      throw new ClaimError('damm_pool_not_found', `DAMM v2 pool not found: ${dammPool.toBase58()}`);
    }
    throw err;
  }
}

/**
 * The migrated DAMM v2 pool of a DBC pool and the creator's positions on it, with their fees.
 * Null when the pool has not migrated (see `migratedDammV2Pool`).
 */
export interface CreatorDammV2Positions {
  /** The DBC pool. */
  pool: PublicKey;
  dammPool: PublicKey;
  dammConfig: PublicKey;
  creator: PublicKey;
  /** Positions whose NFT the creator holds, sorted by address. */
  positions: DammV2PositionSummary[];
  /** Sum of the positions' pending fees. */
  claimable: TokenAmounts;
}

interface PositionCandidate {
  position: PublicKey;
  /** Token account holding the NFT when already known (found by owner); derived otherwise. */
  positionNftAccount: PublicKey | null;
  positionState: DammV2PositionState | null;
}

/**
 * Resolves and checks positions: each must belong to `dammPool`, and its NFT token account
 * (Token-2022) must be owned by `owner` and hold the NFT. Sorted by position address.
 * @throws ClaimError `position_not_found`, `position_mismatch` or `position_not_owned`.
 */
async function resolvePositions(
  connection: Connection,
  amm: CpAmm,
  dammPool: PublicKey,
  poolState: DammV2PoolState,
  owner: PublicKey,
  candidates: readonly PositionCandidate[],
  options: ReadOptions,
): Promise<DammV2PositionSummary[]> {
  const commitment = options.commitment ?? READ_COMMITMENT;
  const unique = new Map<string, PositionCandidate>();
  for (const c of candidates) unique.set(c.position.toBase58(), c);
  const ordered = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (ordered.length === 0) return [];

  const resolved: Array<{ ref: DammV2PositionRef; state: DammV2PositionState }> = [];
  for (const [id, candidate] of ordered) {
    let state = candidate.positionState;
    if (!state) {
      try {
        state = await retryRpc(() => amm.fetchPositionState(candidate.position), options.retry);
      } catch (err) {
        if (err instanceof Error && /not found/i.test(err.message)) {
          throw new ClaimError('position_not_found', `DAMM v2 position not found: ${id}`);
        }
        throw err;
      }
    }
    if (!state.pool.equals(dammPool)) {
      throw new ClaimError(
        'position_mismatch',
        `Position ${id} belongs to pool ${state.pool.toBase58()}, not to ${dammPool.toBase58()}`,
      );
    }
    resolved.push({
      ref: {
        position: candidate.position,
        nftMint: state.nftMint,
        positionNftAccount: candidate.positionNftAccount ?? derivePositionNftAccount(state.nftMint),
      },
      state,
    });
  }

  const nftInfos = await retryRpc(
    () =>
      connection.getMultipleAccountsInfo(
        resolved.map((r) => r.ref.positionNftAccount),
        commitment,
      ),
    options.retry,
  );
  resolved.forEach(({ ref }, i) => {
    const info = nftInfos[i];
    const problem = nftOwnershipProblem(ref, info ?? null, owner);
    if (problem) {
      throw new ClaimError(
        'position_not_owned',
        `Position ${ref.position.toBase58()} is not held by ${owner.toBase58()}: ${problem}`,
      );
    }
  });
  return resolved.map(({ ref, state }) => summarizePosition(poolState, ref, state));
}

/** Why `info` is not a Token-2022 account of `owner` holding the position NFT; null when it is. */
function nftOwnershipProblem(
  ref: DammV2PositionRef,
  info: AccountInfo<Buffer> | null,
  owner: PublicKey,
): string | null {
  if (!info) return 'position NFT token account missing';
  let account;
  try {
    account = unpackAccount(ref.positionNftAccount, info, TOKEN_2022_PROGRAM_ID);
  } catch {
    return 'position NFT token account is not a Token-2022 account';
  }
  if (!account.mint.equals(ref.nftMint)) return 'token account mint is not the position NFT';
  if (account.amount !== 1n) return 'token account does not hold the position NFT';
  if (!account.owner.equals(owner)) return `held by ${account.owner.toBase58()}`;
  return null;
}

export interface FindCreatorPositionsParams {
  /** The DBC pool, or its already-read state. */
  pool: PublicKey | DbcPoolState;
  /** The pool creator (must match the pool state). */
  creator: PublicKey;
}

/**
 * Finds the creator's positions on the migrated DAMM v2 pool of a DBC pool (SDK
 * `getUserPositionByPool`: the Token-2022 accounts of the creator holding one NFT, then the
 * position of each), checked again (pool, NFT held by the creator) and sorted by address.
 * Returns null when the pool has not migrated to DAMM v2.
 * @throws ClaimError `not_pool_creator`, `damm_pool_not_found`, `damm_pool_mismatch`.
 * @throws DbcReadError when the DBC pool or its config does not exist.
 */
export async function findCreatorDammV2Positions(
  connection: Connection,
  params: FindCreatorPositionsParams,
  options: ReadOptions = {},
): Promise<CreatorDammV2Positions | null> {
  const state =
    params.pool instanceof PublicKey
      ? await getDbcPoolState(connection, params.pool, options)
      : params.pool;
  const poolCreator = state.virtualPool.poolState.creator;
  if (!poolCreator.equals(params.creator)) {
    throw new ClaimError(
      'not_pool_creator',
      `${params.creator.toBase58()} is not the creator of pool ${state.address.toBase58()}`,
    );
  }
  const migrated = migratedDammV2Pool(state);
  if (!migrated) return null;
  const amm = cpAmm(connection);
  const poolState = await getDammV2PoolState(connection, migrated.dammPool, options);
  assertDammPoolMatches(state, migrated.dammPool, poolState);
  const found = await retryRpc(
    () => amm.getUserPositionByPool(migrated.dammPool, params.creator),
    options.retry,
  );
  const positions = await resolvePositions(
    connection,
    amm,
    migrated.dammPool,
    poolState,
    params.creator,
    found.map((f) => ({
      position: f.position,
      positionNftAccount: f.positionNftAccount,
      positionState: f.positionState,
    })),
    options,
  );
  return {
    pool: state.address,
    dammPool: migrated.dammPool,
    dammConfig: migrated.dammConfig,
    creator: params.creator,
    positions,
    claimable: sumPendingFees(positions),
  };
}

function assertDammPoolMatches(
  state: DbcPoolState,
  dammPool: PublicKey,
  poolState: DammV2PoolState,
): void {
  const baseMint = state.virtualPool.poolState.baseMint;
  if (!poolState.tokenAMint.equals(baseMint) || !poolState.tokenBMint.equals(state.config.quoteMint)) {
    throw new ClaimError(
      'damm_pool_mismatch',
      `DAMM v2 pool ${dammPool.toBase58()} is not the ${baseMint.toBase58()} / SOL pool of DBC pool ${state.address.toBase58()}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Claim builder
// ---------------------------------------------------------------------------------------------

/** Lamport costs of a position fee claim, as bigint. */
export interface PositionClaimCosts {
  /** Signature fees (signers x 5000 lamports; no priority fee), paid by the payer. */
  networkFeeLamports: bigint;
  /**
   * Rent of the receiver's coin account, created on the first claim of a pool (paid by the
   * payer, kept in that account, which the receiver owns). 0 when it already exists.
   */
  receiverTokenAccountRentLamports: bigint;
  /**
   * Rent of the temporary WSOL account the payer funds: closed to the receiver with the fees, it
   * reaches the receiver as lamports (not refunded to the payer). 0 when the account exists.
   */
  unwrapAccountRentLamports: bigint;
  /** Everything the payer's balance decreases by: the three amounts above. */
  payerTotalLamports: bigint;
  /** Balance the payer needs before signing (same as the total: nothing is refunded). */
  payerRequiredBalanceLamports: bigint;
}

export interface PositionClaimSummary {
  kind: 'position';
  /** The DBC pool. */
  pool: PublicKey;
  dammPool: PublicKey;
  dammConfig: PublicKey;
  baseMint: PublicKey;
  /** The creator: owner of the positions, signs the claim. */
  claimer: PublicKey;
  receiver: PublicKey;
  /** Fee payer of the transaction. */
  payer: PublicKey;
  /** The positions claimed (sorted by address), with their fees when the claim was built. */
  positions: DammV2PositionSummary[];
  /** Sum of the positions' pending fees when the claim was built (a lower bound at execution). */
  claimable: TokenAmounts;
  /**
   * SOL the receiver gets from the transaction, lamports: the claimable SOL fees plus the
   * lamports of the temporary WSOL account closed to it (its rent). A lower bound: the claim is
   * uncapped and fees accrue until it executes. Never exact (`quoteIsExact` is always false).
   */
  receiverQuoteLamports: bigint;
  quoteIsExact: false;
  /** Zero costs when there is no transaction. */
  costs: PositionClaimCosts;
  /** `receiverQuoteLamports - costs.payerTotalLamports`. Coin fees are not valued. */
  netLamports: bigint;
}

export type PositionClaimSkipReason = 'no_position' | 'nothing_to_claim' | 'not_worthwhile';

export interface PositionClaimTxResult {
  /** Unsigned claim transaction, or `null` when skipped (see `skipReason`). */
  transaction: Transaction | null;
  lastValidBlockHeight: number | null;
  skipReason: PositionClaimSkipReason | null;
  summary: PositionClaimSummary;
}

export interface CreatorPositionClaimParams {
  /** The DBC pool (the DAMM v2 pool is derived from it). */
  pool: PublicKey;
  /** Pool creator and owner of the positions; signs the claim. */
  creator: PublicKey;
  /** Where the fees go. */
  receiver: PublicKey;
  /** When set, `receiver` must equal it (`receiver_mismatch` otherwise). */
  expectedReceiver?: PublicKey;
  /** Fee payer; defaults to the creator. */
  payer?: PublicKey;
  /**
   * Positions to claim (addresses). Each must belong to the migrated pool and be held by the
   * creator. Default: every position of the creator on that pool.
   */
  positions?: readonly PublicKey[];
}

const ZERO_COSTS: PositionClaimCosts = {
  networkFeeLamports: 0n,
  receiverTokenAccountRentLamports: 0n,
  unwrapAccountRentLamports: 0n,
  payerTotalLamports: 0n,
  payerRequiredBalanceLamports: 0n,
};

/** True when the claim collects more SOL than it costs, by more than `minNetLamports`. */
export function isPositionClaimWorthwhile(
  summary: PositionClaimSummary,
  minNetLamports = 0n,
): boolean {
  return summary.claimable.quote > 0n && summary.netLamports > minNetLamports;
}

/**
 * Builds the claim of the creator's DAMM v2 position fees of a migrated DBC pool to `receiver`
 * (see the module comment for the transaction).
 * @throws ClaimError when `creator` is not the pool creator, the pool is not SOL-quoted or not
 *   migrated to DAMM v2 (`not_migrated`), the receiver is invalid or differs from
 *   `expectedReceiver`, a position is missing, on another pool or not held by the creator, or
 *   the creator's WSOL account holds WSOL while the receiver is someone else.
 * @throws DbcReadError when the DBC pool or its config does not exist.
 */
export async function buildCreatorPositionFeeClaimTx(
  connection: Connection,
  params: CreatorPositionClaimParams,
  options: ClaimOptions = {},
): Promise<PositionClaimTxResult> {
  const commitment = options.commitment ?? READ_COMMITMENT;
  const readOptions: ReadOptions = { commitment, retry: options.retry };
  assertClaimReceiver(params.receiver);
  if (params.expectedReceiver && !params.expectedReceiver.equals(params.receiver)) {
    throw new ClaimError(
      'receiver_mismatch',
      `Position fees of pool ${params.pool.toBase58()} must go to ${params.expectedReceiver.toBase58()}, not ${params.receiver.toBase58()}`,
    );
  }
  const state = await getDbcPoolState(connection, params.pool, readOptions);
  assertSolQuotedPool(state);
  const poolCreator = state.virtualPool.poolState.creator;
  if (!poolCreator.equals(params.creator)) {
    throw new ClaimError(
      'not_pool_creator',
      `${params.creator.toBase58()} is not the creator of pool ${params.pool.toBase58()}`,
    );
  }
  const migrated = migratedDammV2Pool(state);
  if (!migrated) {
    throw new ClaimError(
      'not_migrated',
      `Pool ${params.pool.toBase58()} has not migrated to DAMM v2: no position to claim`,
    );
  }
  const { dammPool, dammConfig } = migrated;
  const amm = cpAmm(connection);
  const poolState = await getDammV2PoolState(connection, dammPool, readOptions);
  assertDammPoolMatches(state, dammPool, poolState);

  let candidates: PositionCandidate[];
  if (params.positions) {
    candidates = params.positions.map((position) => ({
      position,
      positionNftAccount: null,
      positionState: null,
    }));
  } else {
    const found = await retryRpc(
      () => amm.getUserPositionByPool(dammPool, params.creator),
      options.retry,
    );
    candidates = found.map((f) => ({
      position: f.position,
      positionNftAccount: f.positionNftAccount,
      positionState: f.positionState,
    }));
  }
  const positions = await resolvePositions(
    connection,
    amm,
    dammPool,
    poolState,
    params.creator,
    candidates,
    readOptions,
  );

  const payer = params.payer ?? params.creator;
  const receiver = params.receiver;
  const baseMint = state.virtualPool.poolState.baseMint;
  const claimable = sumPendingFees(positions);
  const baseSummary = {
    kind: 'position' as const,
    pool: state.address,
    dammPool,
    dammConfig,
    baseMint,
    claimer: params.creator,
    receiver,
    payer,
    positions,
    claimable,
    quoteIsExact: false as const,
  };
  const skip = (skipReason: PositionClaimSkipReason): PositionClaimTxResult => ({
    transaction: null,
    lastValidBlockHeight: null,
    skipReason,
    summary: { ...baseSummary, receiverQuoteLamports: 0n, costs: ZERO_COSTS, netLamports: 0n },
  });
  if (positions.length === 0) return skip('no_position');
  if (claimable.base === 0n && claimable.quote === 0n) return skip('nothing_to_claim');

  // 1. The cp-amm claim instructions, built by the SDK (accounts: receiver's coin account,
  //    creator's temporary WSOL account). Its pre/post instructions are replaced below.
  const tokenAProgram = dammV2TokenProgram(poolState.tokenAFlag);
  const tokenBProgram = dammV2TokenProgram(poolState.tokenBFlag);
  if (!tokenBProgram.equals(TOKEN_PROGRAM_ID)) {
    throw new ClaimError('unsupported_quote_mint', 'The SOL side of the pool is not SPL Token WSOL');
  }
  const receiverBase = getAssociatedTokenAddressSync(baseMint, receiver, true, tokenAProgram);
  const creatorWsol = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    params.creator,
    true,
    TOKEN_PROGRAM_ID,
  );
  const claimIxs: TransactionInstruction[] = [];
  for (const p of positions) {
    const sdkTx = await retryRpc(
      () =>
        amm.claimPositionFee({
          owner: params.creator,
          position: p.position,
          pool: dammPool,
          positionNftAccount: p.positionNftAccount,
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAProgram,
          tokenBProgram,
          receiver,
          feePayer: payer,
          tempWSolAccount: params.creator,
        }),
      options.retry,
    );
    const ixs = sdkTx.instructions.filter((ix) => ix.programId.equals(DAMM_V2_PROGRAM_ID));
    const ix = ixs[0];
    const at = (i: number) => ix?.keys[i]?.pubkey;
    if (
      ixs.length !== 1 ||
      !ix ||
      !CLAIM_POSITION_FEE_DISCRIMINATOR.equals(Buffer.from(ix.data).subarray(0, 8)) ||
      !at(CLAIM_POSITION_FEE_ACCOUNTS.pool)?.equals(dammPool) ||
      !at(CLAIM_POSITION_FEE_ACCOUNTS.position)?.equals(p.position) ||
      !at(CLAIM_POSITION_FEE_ACCOUNTS.tokenAAccount)?.equals(receiverBase) ||
      !at(CLAIM_POSITION_FEE_ACCOUNTS.tokenBAccount)?.equals(creatorWsol) ||
      !at(CLAIM_POSITION_FEE_ACCOUNTS.positionNftAccount)?.equals(p.positionNftAccount) ||
      !at(CLAIM_POSITION_FEE_ACCOUNTS.owner)?.equals(params.creator)
    ) {
      throw new ClaimError(
        'unexpected_sdk_instructions',
        'The SDK position fee claim does not have the expected claim instruction',
      );
    }
    claimIxs.push(ix);
  }

  // 2. On-chain state: the receiver's coin account, the creator's WSOL account.
  const [infos, tokenAccountRent] = await Promise.all([
    retryRpc(
      () => connection.getMultipleAccountsInfo([receiverBase, creatorWsol], commitment),
      options.retry,
    ),
    retryRpc(
      () => connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, commitment),
      options.retry,
    ),
  ]);
  const [receiverBaseInfo, creatorWsolInfo] = infos;
  // The temporary account is closed to the receiver: WSOL already held by the creator would go
  // with it. Refuse unless the creator is the receiver.
  if (creatorWsolInfo && !params.creator.equals(receiver)) {
    let amount = 0n;
    if (creatorWsolInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      try {
        amount = unpackAccount(creatorWsol, creatorWsolInfo, TOKEN_PROGRAM_ID).amount;
      } catch {
        amount = 0n;
      }
    }
    if (amount > 0n) {
      throw new ClaimError(
        'claimer_wsol_not_empty',
        `The creator's WSOL account ${creatorWsol.toBase58()} holds ${amount} lamports of WSOL: unwrap it before claiming to another receiver`,
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
      tokenAProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      creatorWsol,
      params.creator,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    ),
    ...claimIxs,
    createCloseAccountInstruction(creatorWsol, receiver, params.creator),
  ];
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
  const unwrapAccountRentLamports = creatorWsolInfo ? 0n : BigInt(tokenAccountRent);
  const payerTotalLamports =
    networkFeeLamports + receiverTokenAccountRentLamports + unwrapAccountRentLamports;
  const costs: PositionClaimCosts = {
    networkFeeLamports,
    receiverTokenAccountRentLamports,
    unwrapAccountRentLamports,
    payerTotalLamports,
    payerRequiredBalanceLamports: payerTotalLamports,
  };
  // The closed account hands the receiver its whole balance: its rent (new or existing).
  const closedLamports = creatorWsolInfo
    ? BigInt(creatorWsolInfo.lamports)
    : unwrapAccountRentLamports;
  const receiverQuoteLamports = claimable.quote + closedLamports;
  const summary: PositionClaimSummary = {
    ...baseSummary,
    receiverQuoteLamports,
    costs,
    netLamports: receiverQuoteLamports - payerTotalLamports,
  };
  if (
    options.minNetLamports !== undefined &&
    !isPositionClaimWorthwhile(summary, options.minNetLamports)
  ) {
    return { transaction: null, lastValidBlockHeight: null, skipReason: 'not_worthwhile', summary };
  }
  return { transaction, lastValidBlockHeight, skipReason: null, summary };
}

export interface ForgeCreatorPositionClaimParams {
  pool: PublicKey;
  /** FORGE creator wallet of the launchpad (the pool creator); signs the claim. */
  creator: PublicKey;
  /** Fee payer; defaults to the creator. */
  payer?: PublicKey;
  positions?: readonly PublicKey[];
}

/**
 * The position fee claim of a FORGE creator wallet: the receiver is always the FORGE multisig
 * vault (`FORGE_MULTISIG_VAULT`, SECURITY.md §5), read from `env` (defaults to `process.env`).
 * @throws ForgeAddressError when `FORGE_MULTISIG_VAULT` is missing or invalid; as
 *   `buildCreatorPositionFeeClaimTx` otherwise.
 */
export async function buildForgeCreatorPositionFeeClaimTx(
  connection: Connection,
  params: ForgeCreatorPositionClaimParams,
  options: ClaimOptions & { env?: AddressEnv } = {},
): Promise<PositionClaimTxResult> {
  const vault = getMultisigVault(options.env);
  return buildCreatorPositionFeeClaimTx(
    connection,
    { ...params, receiver: vault, expectedReceiver: vault },
    options,
  );
}
