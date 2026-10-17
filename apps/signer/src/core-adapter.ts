/**
 * The narrow slice of `@forge/core` the signer jobs (claims, cashbox, refunds) depend on.
 *
 * The jobs only see the `SignerCore` interface below, injected at startup; tests inject fakes.
 * `createForgeSignerCore` binds a connection once and forwards every call to `@forge/core`
 * (PLANEXECUTE.md rule 6: core is the single source of truth for the transactions it builds):
 *   - `readCreatorPool`      -> `getDbcPoolState` + `feeMetrics` + `isGraduated` +
 *                               `graduationStatus` (reads.ts);
 *   - `buildCreatorClaimTx`  -> `buildCreatorClaimTx` (claims.ts), unsigned, blockhash set;
 *   - `readCreatorPositions` -> `findCreatorDammV2Positions` (position-claims.ts): the creator's
 *                               locked DAMM v2 positions of a migrated pool and their fees;
 *   - `buildCreatorPositionClaimTx` -> `buildCreatorPositionFeeClaimTx` (position-claims.ts),
 *                               unsigned, blockhash set;
 *   - `verifyPayment`        -> `verifyPayment` (payments.ts) at FINALIZED commitment, on the
 *                               configured cluster (genesis hash checked by core).
 * Two helpers are not exported by core yet and come from the pinned DBC SDK (change request):
 * the DBC program id and the SOL-quoted pool address derivation. `buildSolTransferTx` stays local:
 * core has no builder for a plain cashbox -> recipient transfer (its payment builder is the
 * client -> cashbox payment with a payer-signed memo, a different transaction).
 */
import {
  DAMM_V2_PROGRAM_ID,
  DbcReadError,
  type PriorityFeeSetting,
  buildCreatorClaimTx as coreBuildCreatorClaimTx,
  buildCreatorPositionFeeClaimTx as coreBuildCreatorPositionFeeClaimTx,
  feeMetrics,
  findCreatorDammV2Positions,
  getDbcPoolState,
  graduationStatus,
  isGraduated,
  verifyPayment as coreVerifyPayment,
  type PaymentCluster,
} from '@forge/core';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
  type Finality,
} from '@solana/web3.js';

export interface TokenAmounts {
  /** Base token (the coin), raw units. */
  base: bigint;
  /** Quote token (SOL), lamports. */
  quote: bigint;
}

/** What the claims job needs to know about a launchpad coin pool. */
export interface CreatorPoolState {
  pool: PublicKey;
  config: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  /** Current pool creator (it changes only through `transferPoolCreator`). */
  creator: PublicKey;
  /** Curve complete or migrated (core `isGraduated`). */
  graduated: boolean;
  /** The DAMM pool exists (core `graduationStatus` = `migrated`): position fees may accrue. */
  migrated: boolean;
  /** Unclaimed creator share (core `feeMetrics(...).claimable.creator`). */
  creatorClaimable: TokenAmounts;
}

/** One DAMM v2 position of the creator on the migrated pool. */
export interface CreatorPositionState {
  position: PublicKey;
  /** Token-2022 account (held by the creator) of the position NFT. */
  positionNftAccount: PublicKey;
  nftMint: PublicKey;
  permanentLockedLiquidity: bigint;
  /** Fees claimable now: `base` = the coin, `quote` = SOL (lamports). */
  pendingFees: TokenAmounts;
}

/** The creator's positions on the DAMM v2 pool a launchpad coin pool migrated to. */
export interface CreatorPositionsState {
  pool: PublicKey;
  dammPool: PublicKey;
  creator: PublicKey;
  /** Sorted by position address. Empty when the creator holds no position NFT. */
  positions: CreatorPositionState[];
  /** Sum of the positions' pending fees. */
  claimable: TokenAmounts;
}

export interface CreatorPositionClaimParams {
  /** The DBC pool (core derives the DAMM v2 pool). */
  pool: PublicKey;
  /** Pool creator and owner of the positions; signs the claim. */
  creator: PublicKey;
  /** Where the fees go (FORGE multisig vault). */
  receiver: PublicKey;
  /** Fee payer; defaults to the creator. */
  payer?: PublicKey;
  /** Positions to claim; defaults to every position of the creator on the pool. */
  positions?: readonly PublicKey[];
}

export interface PositionClaimSummary {
  kind: 'position';
  pool: PublicKey;
  dammPool: PublicKey;
  baseMint: PublicKey;
  claimer: PublicKey;
  receiver: PublicKey;
  payer: PublicKey;
  /** The positions claimed, with the token account holding each one's NFT. */
  positions: Array<{ position: PublicKey; positionNftAccount: PublicKey }>;
  /** Sum of the pending fees when the transaction was built (a lower bound at execution). */
  claimable: TokenAmounts;
}

export interface PositionClaimTxResult {
  /** Unsigned claim (fee payer and recent blockhash set), or null when there is nothing to claim. */
  transaction: Transaction | null;
  lastValidBlockHeight: number | null;
  summary: PositionClaimSummary;
}

export interface CreatorClaimParams {
  pool: PublicKey;
  /** Pool creator; signs the claim. */
  creator: PublicKey;
  /** Where the creator fees go (FORGE multisig vault). */
  receiver: PublicKey;
  /** Fee payer; defaults to the creator. */
  payer?: PublicKey;
}

export interface ClaimSummary {
  kind: 'creator';
  pool: PublicKey;
  baseMint: PublicKey;
  claimer: PublicKey;
  receiver: PublicKey;
  payer: PublicKey;
  /** Amounts claimable when the transaction was built. */
  claimable: TokenAmounts;
}

export interface ClaimTxResult {
  /** Unsigned claim (fee payer and recent blockhash set), or null when there is nothing to claim. */
  transaction: Transaction | null;
  lastValidBlockHeight: number | null;
  summary: ClaimSummary;
}

export interface ExpectedPayment {
  payer: PublicKey;
  lamports: bigint;
  jobId: string;
}

export type PaymentVerification =
  | { status: 'pending'; signature: string }
  | { status: 'invalid'; signature: string; reason: string; detail: string; slot: number | null }
  | {
      status: 'confirmed';
      signature: string;
      slot: number;
      confirmationStatus: Finality;
      payer: PublicKey;
      recipient: PublicKey;
      lamports: bigint;
      memo: string;
    };

export interface SolTransferParams {
  from: PublicKey;
  to: PublicKey;
  lamports: bigint;
  memo?: string;
}

export interface SignerCore {
  /** DBC program id (for the claim transaction policy). */
  readonly dbcProgramId: PublicKey;
  /** DAMM v2 (cp-amm) program id (for the position fee claim policy). */
  readonly cpAmmProgramId: PublicKey;
  /** Address of the SOL-quoted DBC pool of `baseMint` on `config`. */
  coinPoolAddress(config: PublicKey, baseMint: PublicKey): PublicKey;
  /** Pool state, or null when the pool does not exist (launch transaction never signed). */
  readCreatorPool(pool: PublicKey): Promise<CreatorPoolState | null>;
  buildCreatorClaimTx(params: CreatorClaimParams): Promise<ClaimTxResult>;
  /**
   * The creator's DAMM v2 positions of a migrated pool and their fees; null when the pool has
   * not migrated to DAMM v2. Throws when `creator` is not the pool creator.
   */
  readCreatorPositions(pool: PublicKey, creator: PublicKey): Promise<CreatorPositionsState | null>;
  buildCreatorPositionClaimTx(params: CreatorPositionClaimParams): Promise<PositionClaimTxResult>;
  /** Verifies a client payment to the cashbox at FINALIZED commitment. */
  verifyPayment(signature: string, expected: ExpectedPayment): Promise<PaymentVerification>;
  /** Unsigned SOL transfer (+ memo without signer keys). The caller sets blockhash and fee payer. */
  buildSolTransferTx(params: SolTransferParams): Transaction;
}

// ---------------------------------------------------------------------------------------
// @forge/core implementation

export interface ForgeSignerCoreOptions {
  connection: Connection;
  /** FORGE_CASHBOX_WALLET (from `requireAddresses` at startup). */
  cashbox: PublicKey;
  /** SOLANA_CLUSTER: core checks the connection's genesis hash against it. */
  cluster: PaymentCluster;
  /**
   * Priority fee of the claims core builds (jobs/priority.ts `PriorityFees.setting`): priced from
   * the recent fees of their writable accounts and bounded. Without it, no compute budget.
   */
  priority?: PriorityFeeSetting;
}

/** `SignerCore` over `@forge/core`. */
export function createForgeSignerCore(options: ForgeSignerCoreOptions): SignerCore {
  const { connection, cashbox, cluster } = options;
  const priority = options.priority ? { priority: options.priority } : {};
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') {
    throw new Error('cluster must be devnet or mainnet-beta');
  }
  // Core reads the cashbox and the cluster from this env object, never from process.env here.
  const env = { FORGE_CASHBOX_WALLET: cashbox.toBase58(), SOLANA_CLUSTER: cluster };

  return {
    dbcProgramId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    cpAmmProgramId: DAMM_V2_PROGRAM_ID,

    coinPoolAddress(config, baseMint) {
      return deriveDbcPoolAddress(NATIVE_MINT, baseMint, config);
    },

    async readCreatorPool(pool) {
      let state;
      try {
        state = await getDbcPoolState(connection, pool, { commitment: 'confirmed' });
      } catch (err) {
        // Only a missing pool means "not launched"; a missing config is an anomaly.
        if (err instanceof DbcReadError && err.code === 'pool_not_found') return null;
        throw err;
      }
      const p = state.virtualPool.poolState;
      const creator = feeMetrics(state).claimable.creator;
      return {
        pool,
        config: p.config,
        baseMint: p.baseMint,
        quoteMint: state.config.quoteMint,
        creator: p.creator,
        graduated: isGraduated(state),
        migrated: graduationStatus(state) === 'migrated',
        creatorClaimable: { base: creator.base, quote: creator.quote },
      };
    },

    async readCreatorPositions(pool, creator) {
      const found = await findCreatorDammV2Positions(
        connection,
        { pool, creator },
        { commitment: 'confirmed' },
      );
      if (!found) return null;
      return {
        pool: found.pool,
        dammPool: found.dammPool,
        creator: found.creator,
        positions: found.positions.map((p) => ({
          position: p.position,
          positionNftAccount: p.positionNftAccount,
          nftMint: p.nftMint,
          permanentLockedLiquidity: p.liquidity.permanentLocked,
          pendingFees: { base: p.pendingFees.base, quote: p.pendingFees.quote },
        })),
        claimable: { base: found.claimable.base, quote: found.claimable.quote },
      };
    },

    async buildCreatorPositionClaimTx(params) {
      const built = await coreBuildCreatorPositionFeeClaimTx(connection, params, {
        commitment: 'confirmed',
        ...priority,
      });
      const s = built.summary;
      if (s.kind !== 'position') throw new Error('core returned a non-position claim');
      return {
        transaction: built.transaction,
        lastValidBlockHeight: built.lastValidBlockHeight,
        summary: {
          kind: 'position',
          pool: s.pool,
          dammPool: s.dammPool,
          baseMint: s.baseMint,
          claimer: s.claimer,
          receiver: s.receiver,
          payer: s.payer,
          positions: s.positions.map((p) => ({
            position: p.position,
            positionNftAccount: p.positionNftAccount,
          })),
          claimable: { base: s.claimable.base, quote: s.claimable.quote },
        },
      };
    },

    async buildCreatorClaimTx(params) {
      const built = await coreBuildCreatorClaimTx(connection, params, {
        commitment: 'confirmed',
        ...priority,
      });
      const s = built.summary;
      if (s.kind !== 'creator') throw new Error('core returned a non-creator claim');
      return {
        transaction: built.transaction,
        lastValidBlockHeight: built.lastValidBlockHeight,
        summary: {
          kind: 'creator',
          pool: s.pool,
          baseMint: s.baseMint,
          claimer: s.claimer,
          receiver: s.receiver,
          payer: s.payer,
          claimable: { base: s.claimable.base, quote: s.claimable.quote },
        },
      };
    },

    async verifyPayment(signature, expected) {
      const v = await coreVerifyPayment(connection, signature, expected, {
        commitment: 'finalized',
        cluster,
        env,
      });
      if (v.status === 'pending') return { status: 'pending', signature: v.signature };
      if (v.status === 'invalid') {
        return {
          status: 'invalid',
          signature: v.signature,
          reason: v.reason,
          detail: v.detail,
          slot: v.slot,
        };
      }
      // Belt and braces: anything short of finalized is still pending for a refund.
      if (v.confirmationStatus !== 'finalized') return { status: 'pending', signature };
      return {
        status: 'confirmed',
        signature: v.signature,
        slot: v.slot,
        confirmationStatus: v.confirmationStatus,
        payer: v.payer,
        recipient: v.recipient,
        lamports: v.lamports,
        memo: v.memo,
      };
    },

    buildSolTransferTx,
  };
}

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** Pure: SOL transfer + optional memo (memo carries no signer key). */
export function buildSolTransferTx(params: SolTransferParams): Transaction {
  if (params.lamports <= 0n) throw new Error('transfer amount must be positive');
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.from,
      toPubkey: params.to,
      lamports: params.lamports,
    }),
  );
  if (params.memo !== undefined) {
    tx.add(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [],
        data: Buffer.from(params.memo, 'utf8'),
      }),
    );
  }
  return tx;
}
