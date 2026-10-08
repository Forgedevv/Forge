/**
 * The narrow slice of `@forge/core` the signer jobs (claims, cashbox, refunds) depend on.
 *
 * The jobs only see the `SignerCore` interface below, injected at startup; tests inject fakes.
 * Its shapes mirror `@forge/core` (claims.ts, reads.ts, payments.ts on the w3/core-reads branch):
 *   - `buildCreatorClaimTx(connection, { pool, creator, receiver, payer? })`
 *       -> `{ transaction | null, lastValidBlockHeight, summary }` (null = nothing to claim);
 *   - `getDbcPoolState` + `feeMetrics` + `isGraduated` (reads.ts);
 *   - `verifyPayment(connection, signature, { payer, lamports, jobId })`
 *       -> `pending | invalid | confirmed`, payment memo `forge:job:<uuid>`.
 * The connection is bound once in the factory instead of being passed on every call.
 *
 * `createSdkSignerCore` is a minimal stand-in written directly against the DBC SDK so the jobs can
 * run on devnet before `@forge/core` is merged. TO REPLACE WITH @forge/core AT MERGE: every method
 * becomes a one-line call to the core function of the same name (PLANEXECUTE.md rule 6), and this
 * file keeps only the interface. The SDK is imported here and nowhere else in the signer jobs.
 */
import {
  CreatorService,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  StateService,
  U64_MAX,
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
  /** Unclaimed creator share (core `feeMetrics(...).claimable.creator`). */
  creatorClaimable: TokenAmounts;
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
  /** Address of the SOL-quoted DBC pool of `baseMint` on `config`. */
  coinPoolAddress(config: PublicKey, baseMint: PublicKey): PublicKey;
  /** Pool state, or null when the pool does not exist (launch transaction never signed). */
  readCreatorPool(pool: PublicKey): Promise<CreatorPoolState | null>;
  buildCreatorClaimTx(params: CreatorClaimParams): Promise<ClaimTxResult>;
  /** Verifies a client payment to the cashbox at FINALIZED commitment. */
  verifyPayment(signature: string, expected: ExpectedPayment): Promise<PaymentVerification>;
  /** Unsigned SOL transfer (+ memo without signer keys). The caller sets blockhash and fee payer. */
  buildSolTransferTx(params: SolTransferParams): Transaction;
}

// ---------------------------------------------------------------------------------------
// Stand-in implementation (devnet), TO REPLACE WITH @forge/core AT MERGE.

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MEMO_V1_PROGRAM_ID = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');
const PAYMENT_MEMO_PREFIX = 'forge:job:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toBigint(value: { toString(): string }): bigint {
  return BigInt(value.toString());
}

function readU64(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  return value;
}

export interface SdkSignerCoreOptions {
  connection: Connection;
  /** FORGE_CASHBOX_WALLET (from `requireAddresses` at startup). */
  cashbox: PublicKey;
}

/** Minimal SDK-backed `SignerCore`. TO REPLACE WITH @forge/core AT MERGE. */
export function createSdkSignerCore(options: SdkSignerCoreOptions): SignerCore {
  const { connection, cashbox } = options;
  const state = new StateService(connection, 'confirmed');

  return {
    dbcProgramId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,

    coinPoolAddress(config, baseMint) {
      return deriveDbcPoolAddress(NATIVE_MINT, baseMint, config);
    },

    async readCreatorPool(pool) {
      const virtualPool = await state.getPool(pool);
      if (!virtualPool) return null;
      const p = virtualPool.poolState;
      const config = await state.getPoolConfig(p.config);
      if (!config) throw new Error('DBC config of the pool not found');
      const migrated = p.isMigrated !== 0 || p.migrationProgress >= 3;
      const complete =
        p.migrationProgress >= 1 ||
        toBigint(p.quoteReserve) >= toBigint(config.migrationQuoteThreshold);
      return {
        pool,
        config: p.config,
        baseMint: p.baseMint,
        quoteMint: config.quoteMint,
        creator: p.creator,
        graduated: migrated || complete,
        creatorClaimable: { base: toBigint(p.creatorBaseFee), quote: toBigint(p.creatorQuoteFee) },
      };
    },

    async buildCreatorClaimTx(params) {
      const virtualPool = await state.getPool(params.pool);
      if (!virtualPool) throw new Error('DBC pool not found');
      const p = virtualPool.poolState;
      if (!p.creator.equals(params.creator)) throw new Error('not_pool_creator');
      const payer = params.payer ?? params.creator;
      const summary: ClaimSummary = {
        kind: 'creator',
        pool: params.pool,
        baseMint: p.baseMint,
        claimer: params.creator,
        receiver: params.receiver,
        payer,
        claimable: { base: toBigint(p.creatorBaseFee), quote: toBigint(p.creatorQuoteFee) },
      };
      if (summary.claimable.base === 0n && summary.claimable.quote === 0n) {
        return { transaction: null, lastValidBlockHeight: null, summary };
      }
      const transaction = await new CreatorService(
        connection,
        'confirmed',
      ).claimCreatorTradingFeeToReceiver({
        creator: params.creator,
        payer,
        pool: params.pool,
        receiver: params.receiver,
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
      });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      transaction.feePayer = payer;
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      return { transaction, lastValidBlockHeight, summary };
    },

    async verifyPayment(signature, expected) {
      if (!UUID_RE.test(expected.jobId)) throw new Error('jobId must be a UUID');
      const memo = `${PAYMENT_MEMO_PREFIX}${expected.jobId.toLowerCase()}`;
      const invalid = (
        reason: string,
        detail: string,
        slot: number | null,
      ): PaymentVerification => ({
        status: 'invalid',
        signature,
        reason,
        detail,
        slot,
      });
      const status = (
        await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
      ).value[0];
      if (!status || status.confirmationStatus !== 'finalized') {
        return { status: 'pending', signature };
      }
      if (status.err)
        return invalid('transaction_failed', 'payment transaction failed', status.slot);
      const tx = await connection.getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return { status: 'pending', signature };
      const meta = tx.meta;
      if (!meta) return invalid('missing_meta', 'no status meta', tx.slot);
      if (meta.err) return invalid('transaction_failed', 'payment transaction failed', tx.slot);
      const message = tx.transaction.message;
      const keys = message.getAccountKeys({
        accountKeysFromLookups: meta.loadedAddresses ?? undefined,
      });
      const payerIndex = message.staticAccountKeys.findIndex((k) => k.equals(expected.payer));
      if (payerIndex < 0 || payerIndex >= message.header.numRequiredSignatures) {
        return invalid('payer_not_signer', 'the expected payer did not sign', tx.slot);
      }
      const transfers: Array<{ from: PublicKey; lamports: bigint }> = [];
      const memos: string[] = [];
      for (const ix of message.compiledInstructions) {
        const program = keys.get(ix.programIdIndex);
        if (!program) continue;
        if (program.equals(SystemProgram.programId)) {
          const data = ix.data;
          if (data.length !== 12 || Buffer.from(data).readUInt32LE(0) !== 2) continue;
          const from = keys.get(ix.accountKeyIndexes[0] ?? -1);
          const to = keys.get(ix.accountKeyIndexes[1] ?? -1);
          if (!from || !to || !to.equals(cashbox)) continue;
          transfers.push({ from, lamports: readU64(data, 4) });
        } else if (program.equals(MEMO_PROGRAM_ID) || program.equals(MEMO_V1_PROGRAM_ID)) {
          memos.push(Buffer.from(ix.data).toString('utf8'));
        }
      }
      if (transfers.length !== 1) {
        return invalid(
          'recipient_mismatch',
          'expected exactly one transfer to the cashbox',
          tx.slot,
        );
      }
      const transfer = transfers[0]!;
      if (!transfer.from.equals(expected.payer)) {
        return invalid('payer_mismatch', 'transfer does not come from the payer', tx.slot);
      }
      if (transfer.lamports !== expected.lamports) {
        return invalid('amount_mismatch', 'transfer amount differs from the quote', tx.slot);
      }
      if (memos.length !== 1 || memos[0] !== memo) {
        return invalid('memo_mismatch', 'payment memo does not match the job', tx.slot);
      }
      return {
        status: 'confirmed',
        signature,
        slot: tx.slot,
        confirmationStatus: 'finalized',
        payer: expected.payer,
        recipient: cashbox,
        lamports: transfer.lamports,
        memo,
      };
    },

    buildSolTransferTx: buildSolTransferTx,
  };
}

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
