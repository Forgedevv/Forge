/**
 * Devnet-only buy route of the $FORGE buyback (jobs/buyback.ts, BUYBACK_ROUTE=dbc-devnet).
 *
 * Jupiter does not index devnet, so the devnet live test (FORGE_BUYBACK_DEVNET_TEST=true) buys the
 * stand-in coin straight from its Meteora DBC pool with @forge/core `buildBuyTx` (PLANEXECUTE rule
 * 6: core builds the swap, nobody re-implements it). The route is refused on mainnet-beta at
 * startup (jobs/buyback.ts `validateBuybackConfig` / `resolveBuybackMode`) and again here: the
 * constructor only accepts SOLANA_CLUSTER=devnet and the first use checks the RPC genesis hash.
 * The mainnet route is Jupiter.
 *
 * Same two collaborators as the Jupiter route:
 * - `quotes.quote`: core `quoteSwap` turned into the Jupiter quote shape the job validates
 *   (`validateBuyQuote`: wrapped SOL in, FORGE_MINT out, ExactIn, slippage and price impact caps);
 * - `quotes.swap`: core `buildBuyTx` pinned to the validated quote's minimum output, serialized;
 * - `swapPreparer.prepare`: the transaction is re-checked against a static policy of core's own
 *   layout (`checkDbcBuyInstructions`: compute budget, the bot's wrapped SOL and coin ATAs only,
 *   one wrap transfer of exactly the order, one DBC `swap` on the expected pool with exactly the
 *   order and the quote's minimum, one unwrap, the 30 bps platform fee last), simulated with the
 *   job's `checkBuybackSimulation` (the SOL drop bound includes that platform fee) and signed with
 *   the keystore. Never sent from here.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  PLATFORM_FEE_BPS,
  assertCluster,
  buildBuyTx,
  platformFeeLamports,
  quoteSwap,
  swapFeeAddresses,
  type BuildBuyTxParams,
  type BuiltSwapTransaction,
  type QuoteSwapParams,
  type SwapQuote,
} from '@forge/core';
import {
  MAX_BUYBACK_SLIPPAGE_BPS,
  checkBuybackSimulation,
  type BuybackQuoteSource,
  type BuybackSwapPreparer,
  type PreparedSwap,
} from './buyback.js';
import { WSOL_MINT, type JupiterQuote } from './convert.js';
import {
  JobError,
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_COMPUTE_UNIT_PRICE,
  base58Encode,
  decodeSystemTransfer,
  describeError,
  type KeystoreLike,
} from './shared.js';

// ---------------------------------------------------------------------------------------
// Constants

const SWAP_IDL = DynamicBondingCurveIdl.instructions.find((ix) => ix.name === 'swap');
if (!SWAP_IDL) throw new Error('DBC IDL has no swap instruction');
/** Anchor discriminator of the DBC `swap` instruction, from the pinned SDK IDL. */
export const DBC_SWAP_DISCRIMINATOR: Buffer = Buffer.from(SWAP_IDL.discriminator);
export const BASE_FEE_LAMPORTS = 5_000n;
/** Default compute unit limit of the devnet buys (core's default is 150 000). */
export const DEFAULT_DBC_COMPUTE_UNIT_LIMIT = 150_000;

/** Account indexes of the DBC `swap` instruction (core `buildDbcSwapInstruction`). */
const SWAP_IX = {
  pool: 2,
  input: 3,
  output: 4,
  baseMint: 7,
  quoteMint: 8,
  payer: 9,
  tokenBaseProgram: 10,
  tokenQuoteProgram: 11,
  referral: 12,
  minKeys: 15,
  maxKeys: 16,
} as const;

// ---------------------------------------------------------------------------------------
// Static policy on core's buy layout (pure)

export interface DbcBuyExpectation {
  bot: PublicKey;
  pool: PublicKey;
  forgeMint: PublicKey;
  platformFeeWallet: PublicKey;
  referralTokenAccount: PublicKey;
  /** Lamports into the swap (the order). */
  inLamports: bigint;
  /** Minimum output the validated quote guarantees (raw $FORGE units). */
  minOutAmount: bigint;
  /** Highest priority fee the compute budget may imply (lamports). */
  maxPriorityFeeLamports: bigint;
}

export type DbcBuyRefusal =
  | 'program_not_allowed'
  | 'compute_budget'
  | 'priority_fee_too_high'
  | 'account_creation'
  | 'wrap_transfer'
  | 'sync_native'
  | 'swap_instruction'
  | 'swap_accounts'
  | 'swap_amount'
  | 'swap_min_out'
  | 'unwrap'
  | 'platform_fee'
  | 'instruction_order'
  | 'duplicate_instruction'
  | 'instruction_missing';

export type DbcBuyCheck =
  | { ok: true; feeBoundLamports: bigint; platformFeeLamports: bigint; coinProgram: PublicKey }
  | { ok: false; reason: DbcBuyRefusal };

const refuse = (reason: DbcBuyRefusal): DbcBuyCheck => ({ ok: false, reason });

function isTokenProgram(id: PublicKey): boolean {
  return id.equals(TOKEN_PROGRAM_ID) || id.equals(TOKEN_2022_PROGRAM_ID);
}

/**
 * Pure: the instructions must be exactly core's buy layout for `expected` (swap.ts header):
 * compute budget first (bounded), idempotent creation of the bot's wrapped SOL ATA and optionally
 * of its coin ATA (paid by and owned by the bot), one System transfer bot -> wrapped SOL ATA of
 * exactly the order, SyncNative, one DBC `swap` (pool, mints, bot as signer, the FORGE referral
 * account, exactly the order in and exactly the quote's minimum out), CloseAccount of the wrapped
 * SOL ATA back to the bot, and the platform fee transfer (exactly 30 bps of the order, rounded up)
 * as the last instruction. Nothing else, nothing twice.
 */
export function checkDbcBuyInstructions(
  instructions: readonly TransactionInstruction[],
  expected: DbcBuyExpectation,
): DbcBuyCheck {
  const { bot } = expected;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, bot, true, TOKEN_PROGRAM_ID);
  const platformFee = platformFeeLamports(expected.inLamports, PLATFORM_FEE_BPS);
  let computeUnitLimit: number | null = null;
  let computeUnitPrice: bigint | null = null;
  let wsolCreate = -1;
  let coinCreate = -1;
  let coinProgram: PublicKey | null = null;
  let wrap = -1;
  let sync = -1;
  let swap = -1;
  let close = -1;
  let fee = -1;
  let budgetDone = false;

  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i]!;
    const data = Buffer.from(ix.data);
    const key = (k: number): PublicKey | null => ix.keys[k]?.pubkey ?? null;
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      if (budgetDone) return refuse('instruction_order');
      if (data[0] === 2 && data.length === 5) {
        if (computeUnitLimit !== null) return refuse('duplicate_instruction');
        computeUnitLimit = data.readUInt32LE(1);
        if (computeUnitLimit < 1 || computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT) {
          return refuse('compute_budget');
        }
      } else if (data[0] === 3 && data.length === 9) {
        if (computeUnitPrice !== null) return refuse('duplicate_instruction');
        computeUnitPrice = data.readBigUInt64LE(1);
        if (computeUnitPrice > MAX_COMPUTE_UNIT_PRICE) return refuse('compute_budget');
      } else {
        return refuse('compute_budget');
      }
      continue;
    }
    budgetDone = true;
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (!(data.length === 1 && data[0] === 1) || ix.keys.length !== 6) {
        return refuse('account_creation');
      }
      if (swap !== -1) return refuse('instruction_order');
      const [payer, ata, owner, mint, system, program] = [0, 1, 2, 3, 4, 5].map(key);
      if (!payer?.equals(bot) || !owner?.equals(bot) || !system?.equals(SystemProgram.programId)) {
        return refuse('account_creation');
      }
      if (!mint || !ata || !program) return refuse('account_creation');
      if (mint.equals(NATIVE_MINT)) {
        if (wsolCreate !== -1) return refuse('duplicate_instruction');
        if (!program.equals(TOKEN_PROGRAM_ID) || !ata.equals(wsolAta)) {
          return refuse('account_creation');
        }
        wsolCreate = i;
      } else if (mint.equals(expected.forgeMint)) {
        if (coinCreate !== -1) return refuse('duplicate_instruction');
        if (!isTokenProgram(program)) return refuse('account_creation');
        if (!ata.equals(getAssociatedTokenAddressSync(expected.forgeMint, bot, true, program))) {
          return refuse('account_creation');
        }
        coinCreate = i;
        coinProgram = program;
      } else {
        return refuse('account_creation');
      }
      continue;
    }
    if (ix.programId.equals(SystemProgram.programId)) {
      const t = decodeSystemTransfer(ix);
      if (!t || !t.from.equals(bot)) return refuse('program_not_allowed');
      if (t.to.equals(wsolAta)) {
        if (wrap !== -1) return refuse('duplicate_instruction');
        if (swap !== -1) return refuse('instruction_order');
        if (t.lamports !== expected.inLamports) return refuse('wrap_transfer');
        wrap = i;
      } else if (t.to.equals(expected.platformFeeWallet)) {
        if (fee !== -1) return refuse('duplicate_instruction');
        if (t.lamports !== platformFee || platformFee === 0n) return refuse('platform_fee');
        fee = i;
      } else {
        return refuse('program_not_allowed');
      }
      continue;
    }
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      if (data.length === 1 && data[0] === 17) {
        if (sync !== -1) return refuse('duplicate_instruction');
        if (swap !== -1 || ix.keys.length !== 1 || !key(0)?.equals(wsolAta)) {
          return refuse('sync_native');
        }
        sync = i;
      } else if (data.length === 1 && data[0] === 9) {
        if (close !== -1) return refuse('duplicate_instruction');
        if (swap === -1) return refuse('instruction_order');
        if (
          ix.keys.length !== 3 ||
          !key(0)?.equals(wsolAta) ||
          !key(1)?.equals(bot) ||
          !key(2)?.equals(bot)
        ) {
          return refuse('unwrap');
        }
        close = i;
      } else {
        return refuse('program_not_allowed');
      }
      continue;
    }
    if (ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) {
      if (swap !== -1) return refuse('duplicate_instruction');
      if (!data.subarray(0, 8).equals(DBC_SWAP_DISCRIMINATOR) || data.length !== 24) {
        return refuse('swap_instruction');
      }
      if (ix.keys.length < SWAP_IX.minKeys || ix.keys.length > SWAP_IX.maxKeys) {
        return refuse('swap_accounts');
      }
      const baseProgram = key(SWAP_IX.tokenBaseProgram);
      if (!baseProgram || !isTokenProgram(baseProgram)) return refuse('swap_accounts');
      if (coinProgram && !coinProgram.equals(baseProgram)) return refuse('swap_accounts');
      const coinAta = getAssociatedTokenAddressSync(expected.forgeMint, bot, true, baseProgram);
      const payerMeta = ix.keys[SWAP_IX.payer];
      if (
        !key(SWAP_IX.pool)?.equals(expected.pool) ||
        !key(SWAP_IX.input)?.equals(wsolAta) ||
        !key(SWAP_IX.output)?.equals(coinAta) ||
        !key(SWAP_IX.baseMint)?.equals(expected.forgeMint) ||
        !key(SWAP_IX.quoteMint)?.equals(NATIVE_MINT) ||
        !payerMeta?.pubkey.equals(bot) ||
        !payerMeta.isSigner ||
        !key(SWAP_IX.tokenQuoteProgram)?.equals(TOKEN_PROGRAM_ID) ||
        !key(SWAP_IX.referral)?.equals(expected.referralTokenAccount)
      ) {
        return refuse('swap_accounts');
      }
      if (data.readBigUInt64LE(8) !== expected.inLamports) return refuse('swap_amount');
      if (data.readBigUInt64LE(16) !== expected.minOutAmount) return refuse('swap_min_out');
      coinProgram = baseProgram;
      swap = i;
      continue;
    }
    return refuse('program_not_allowed');
  }

  if (wsolCreate === -1 || wrap === -1 || sync === -1 || swap === -1 || close === -1) {
    return refuse('instruction_missing');
  }
  if (platformFee > 0n && fee === -1) return refuse('platform_fee');
  if (fee !== -1 && fee !== instructions.length - 1) return refuse('instruction_order');
  if (
    wsolCreate > wrap ||
    wrap > sync ||
    sync > swap ||
    swap > close ||
    (coinCreate !== -1 && coinCreate > swap)
  ) {
    return refuse('instruction_order');
  }
  const limit = BigInt(computeUnitLimit ?? 200_000);
  const price = computeUnitPrice ?? 0n;
  const priorityFee = (limit * price + 999_999n) / 1_000_000n;
  if (priorityFee > expected.maxPriorityFeeLamports) return refuse('priority_fee_too_high');
  return {
    ok: true,
    feeBoundLamports: BASE_FEE_LAMPORTS + priorityFee,
    platformFeeLamports: platformFee,
    coinProgram: coinProgram ?? TOKEN_PROGRAM_ID,
  };
}

// ---------------------------------------------------------------------------------------
// Route

/** The core functions the route depends on (injectable for tests). */
export interface DbcRouteCore {
  quoteSwap(params: QuoteSwapParams): Promise<SwapQuote>;
  buildBuyTx(params: BuildBuyTxParams): Promise<BuiltSwapTransaction>;
  assertCluster(connection: Connection, cluster: 'devnet'): Promise<void>;
}

export interface DbcDevnetRouteOptions {
  connection: Connection;
  /** BUYBACK_DEVNET_DBC_POOL: the SOL-quoted DBC pool of the stand-in coin. */
  pool: PublicKey;
  /** FORGE_MINT (devnet stand-in): must be the pool's base mint. */
  forgeMint: PublicKey;
  /** Environment core reads FORGE_PLATFORM_FEE_WALLET / FORGE_METEORA_REFERRAL_ACCOUNT from. */
  env: Readonly<Record<string, string | undefined>>;
  keystore: KeystoreLike;
  /** SOLANA_CLUSTER: anything but devnet is refused. */
  cluster: string | undefined;
  maxPriorityFeeLamports: bigint;
  computeUnitLimit?: number;
  core?: DbcRouteCore;
}

export interface DbcDevnetRoute {
  readonly kind: 'dbc-devnet';
  quotes: BuybackQuoteSource;
  swapPreparer: BuybackSwapPreparer;
}

/** Quote + swap builder + preparer over a devnet DBC pool. Throws CONFIG off devnet. */
export function createDbcDevnetBuybackRoute(o: DbcDevnetRouteOptions): DbcDevnetRoute {
  if (o.cluster !== 'devnet') {
    throw new JobError('CONFIG', 'the dbc-devnet buyback route only runs on devnet');
  }
  if (o.pool.equals(o.forgeMint)) throw new JobError('CONFIG', 'pool and mint must differ');
  const core: DbcRouteCore = o.core ?? { quoteSwap, buildBuyTx, assertCluster };
  const { platformFeeWallet, referralTokenAccount } = swapFeeAddresses(o.env);
  const computeUnitLimit = o.computeUnitLimit ?? DEFAULT_DBC_COMPUTE_UNIT_LIMIT;
  let clusterChecked: Promise<void> | null = null;

  const ensureDevnet = (): Promise<void> => {
    clusterChecked ??= core.assertCluster(o.connection, 'devnet').catch((err: unknown) => {
      clusterChecked = null;
      throw new JobError('CONFIG', `dbc-devnet route: ${describeError(err).message}`);
    });
    return clusterChecked;
  };

  const quotes: BuybackQuoteSource = {
    async quote({ outputMint, lamports, slippageBps }) {
      await ensureDevnet();
      if (outputMint !== o.forgeMint.toBase58()) {
        throw new JobError('CONFIG', 'quote asked for another mint than FORGE_MINT');
      }
      const q = await core.quoteSwap({
        connection: o.connection,
        pool: o.pool,
        side: 'buy',
        amountIn: lamports,
        slippageBps: Math.min(slippageBps, MAX_BUYBACK_SLIPPAGE_BPS),
      });
      if (!q.baseMint.equals(o.forgeMint) || !q.pool.equals(o.pool) || q.side !== 'buy') {
        throw new JobError('CONFIG', 'the devnet pool does not trade FORGE_MINT');
      }
      const quote: JupiterQuote = {
        inputMint: WSOL_MINT,
        outputMint: o.forgeMint.toBase58(),
        inAmount: q.amountIn.toString(),
        outAmount: q.expectedAmountOut.toString(),
        otherAmountThreshold: q.minAmountOut.toString(),
        swapMode: 'ExactIn',
        slippageBps: q.slippageBps ?? slippageBps,
        // The job reads a fraction (bps / 10 000), like the Jupiter field it validates.
        priceImpactPct: (q.priceImpactBps / 10_000).toFixed(6),
        platformFeeLamports: q.fees.platformFee.toString(),
        route: 'dbc-devnet',
      };
      return quote;
    },
    async swap({ quote, userPublicKey }) {
      await ensureDevnet();
      const built = await core.buildBuyTx({
        connection: o.connection,
        pool: o.pool,
        user: new PublicKey(userPublicKey),
        amountInLamports: BigInt(quote.inAmount),
        minAmountOut: BigInt(quote.otherAmountThreshold),
        env: o.env,
        computeUnitLimit,
      });
      return {
        swapTransaction: Buffer.from(built.transaction.serialize()).toString('base64'),
        lastValidBlockHeight: built.lastValidBlockHeight,
      };
    },
  };

  const swapPreparer: BuybackSwapPreparer = {
    async prepare({ owner, ownerRef, swapTransaction, lastValidBlockHeight, expected }) {
      await ensureDevnet();
      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      } catch {
        return { status: 'refused', reason: 'undecodable' };
      }
      if (tx.message.addressTableLookups.length > 0) {
        return { status: 'refused', reason: 'lookup_table_not_allowed' };
      }
      const staticKeys = tx.message.staticAccountKeys;
      if (tx.message.header.numRequiredSignatures !== 1 || !staticKeys[0]?.equals(owner)) {
        return { status: 'refused', reason: 'signer' };
      }
      const decompiled = TransactionMessage.decompile(tx.message);
      const check = checkDbcBuyInstructions(decompiled.instructions, {
        bot: owner,
        pool: o.pool,
        forgeMint: o.forgeMint,
        platformFeeWallet,
        referralTokenAccount,
        inLamports: expected.inLamports,
        minOutAmount: expected.minOutAmount,
        maxPriorityFeeLamports: o.maxPriorityFeeLamports,
      });
      if (!check.ok) return { status: 'refused', reason: check.reason };
      // The bot's SOL drops by the order, the platform fee and the network fee at most.
      const simulated = await checkBuybackSimulation(o.connection, tx, {
        owner,
        expected: {
          forgeMint: expected.forgeMint,
          inLamports: expected.inLamports + check.platformFeeLamports,
          minOutAmount: expected.minOutAmount,
        },
        feeBoundLamports: check.feeBoundLamports,
      });
      if (simulated) return { status: 'refused', reason: simulated };
      const expiry =
        lastValidBlockHeight ?? (await o.connection.getBlockHeight('confirmed')) + 300;
      await o.keystore.withSigner(ownerRef, (signer) => {
        if (!signer.publicKey.equals(owner)) throw new JobError('SIGNER_MISMATCH');
        signer.signTransaction(tx);
      });
      const first = tx.signatures[0];
      if (!first || first.length !== 64 || first.every((b) => b === 0)) {
        throw new JobError('NOT_SIGNED', 'buy transaction is not signed');
      }
      const ready: PreparedSwap = {
        status: 'ready',
        signature: base58Encode(first),
        raw: tx.serialize(),
        lastValidBlockHeight: expiry,
      };
      return ready;
    },
  };

  return { kind: 'dbc-devnet', quotes, swapPreparer };
}
