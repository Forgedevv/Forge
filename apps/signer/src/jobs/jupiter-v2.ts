/**
 * Jupiter Swap API V2 for the signer's swaps: the fee conversion (convert.ts, and the revenue
 * job through it) and the $FORGE buyback (buyback.ts). docs/METEORA.md "Jupiter".
 *
 * The Metis Swap API (`/swap/v1`: `/quote`, then `/swap` returning a transaction Jupiter
 * assembled) is no longer maintained and is superseded by Swap V2
 * (https://developers.jup.ag/docs/swap-api). Its Router path, `GET /swap/v2/build`
 * (https://developers.jup.ag/docs/swap/build, reference
 * https://developers.jup.ag/docs/api-reference/swap/build), answers the quote AND the raw
 * instructions in one call, routed by Metis only, without a Jupiter swap fee; the client
 * assembles the transaction (migration guide:
 * https://developers.jup.ag/docs/swap/migration/metis-to-build). JUPITER_SWAP_API=v1 keeps the
 * Metis path for one release (convert.ts `createJupiterClient`, buyback.ts
 * `createJupiterBuybackClient`).
 *
 * Request, `GET <JUPITER_API_URL>/build` with the key in `x-api-key` (every V2 endpoint needs
 * one): inputMint, outputMint, amount, taker (the wallet that signs and pays: V2's name for
 * `userPublicKey`), slippageBps, wrapAndUnwrapSol=true, transactionVersion=0. `/build` is ExactIn
 * only (no `swapMode`) and has no `restrictIntermediateTokens` (Metis picks the intermediate
 * tokens); no platform fee, fee account, tip or payer is ever asked.
 *
 * Response fields used: the quote (inputMint, outputMint, inAmount, outAmount,
 * otherAmountThreshold, swapMode, slippageBps, priceImpactPct), validated by the jobs exactly
 * like a Metis quote; computeBudgetInstructions (the unit price only: dropped), setupInstructions,
 * swapInstruction (V2 routes by default: `route_v2`, `shared_accounts_route_v2`),
 * cleanupInstruction, otherInstructions, tipInstruction (must be null),
 * addressesByLookupTableAddress, transactionVersion (must be 0). blockhashWithMetadata is not
 * used: the blockhash and its last valid block height come from the signer's own RPC.
 *
 * Assembly (`assembleJupiterSwap`), trusting Jupiter for nothing the chain can answer:
 *   1. every instruction is decoded (program, accounts, base64 data); only the taker may sign;
 *      `computeBudgetInstructions` may hold compute budget instructions only and is dropped, no
 *      other list may hold one, and a tip instruction is refused;
 *   2. each lookup table Jupiter names is read through the signer's RPC: it must exist, be
 *      active and hold every address Jupiter lists at the same index (tables only grow: the
 *      chain may hold more); the message is compiled against the ON-CHAIN tables;
 *   3. compute budget: the signer's own pair first (priority.ts `signerBudgetPair`), never
 *      Jupiter's price. The unit limit is 1.2 x the units a simulation at 1.4M consumes
 *      (Jupiter's recipe for `/build`), the price the signer's setting (SIGNER_PRIORITY_FEE_*)
 *      for the swap's writable accounts with its cap per transaction lowered to the job's
 *      (CONVERT_MAX_PRIORITY_FEE_LAMPORTS, BUYBACK_MAX_PRIORITY_FEE_LAMPORTS), checked by
 *      `assertSignerBudgetPair`;
 *   4. a v0 message paid by the taker, with the RPC's blockhash, at most 1232 bytes.
 * A refusal throws `JupiterRefusal` (stable reason, nothing signed). The assembled bytes then go
 * through the same checks as a Metis transaction: the static allowlist (`verifySwapTransaction`,
 * the route arguments bound to the quote), the simulation of every account the wallet holds, the
 * kill switch re-read, the journal before the broadcast.
 */
import {
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
} from '@solana/web3.js';
import { z } from 'zod';
import {
  estimatePriorityFee,
  fixedPriorityFee,
  writableAccountsOf,
  type PriorityFeeQuote,
} from '@forge/core';
import type { BuybackQuoteSource } from './buyback.js';
import {
  JupiterError,
  JupiterRefusal,
  WSOL_MINT,
  quoteSchema,
  type JupiterClient,
  type JupiterQuote,
  type JupiterSwap,
} from './convert.js';
import { capPrioritySetting, signerBudgetPair, type PriorityFees } from './priority.js';
import { JobError, MAX_COMPUTE_UNIT_LIMIT, assertSignerBudgetPair, realSleep } from './shared.js';

/** Unit limit margin over the simulated consumption (Jupiter: "at least a 1.2x buffer"). */
export const JUPITER_V2_COMPUTE_UNIT_MARGIN_PERCENT = 120;
/** A build naming more lookup tables than this is refused (Jupiter uses a handful). */
export const MAX_JUPITER_LOOKUP_TABLES = 10;

// ---------------------------------------------------------------------------------------------
// Response

const apiInstructionSchema = z.object({
  programId: z.string(),
  accounts: z.array(
    z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() }),
  ),
  data: z.string(),
});
export type JupiterApiInstruction = z.infer<typeof apiInstructionSchema>;

/** The instruction part of a `/build` answer (the quote part is `quoteSchema`). */
export const buildInstructionsSchema = z.object({
  computeBudgetInstructions: z.array(apiInstructionSchema),
  setupInstructions: z.array(apiInstructionSchema),
  swapInstruction: apiInstructionSchema,
  cleanupInstruction: apiInstructionSchema.nullable().optional(),
  otherInstructions: z.array(apiInstructionSchema).optional(),
  tipInstruction: apiInstructionSchema.nullable().optional(),
  addressesByLookupTableAddress: z.record(z.string(), z.array(z.string())).nullable().optional(),
  transactionVersion: z.number().optional(),
});
export type JupiterBuildInstructions = z.infer<typeof buildInstructionsSchema>;

/** A parsed `/build` answer, for the taker it was asked for. */
export interface JupiterBuild {
  quote: JupiterQuote;
  taker: string;
  instructions: JupiterBuildInstructions;
}

/**
 * Pure: a `/build` answer -> the quote (its fields only) and the instructions. Throws
 * JupiterError on an unexpected shape.
 */
export function parseJupiterBuild(body: unknown, taker: string): JupiterBuild {
  const quote = quoteSchema.safeParse(body);
  const instructions = buildInstructionsSchema.safeParse(body);
  if (!quote.success || !instructions.success) {
    throw new JupiterError('Jupiter build has an unexpected shape');
  }
  const q = quote.data;
  return {
    quote: {
      inputMint: q.inputMint,
      outputMint: q.outputMint,
      inAmount: q.inAmount,
      outAmount: q.outAmount,
      otherAmountThreshold: q.otherAmountThreshold,
      swapMode: q.swapMode,
      slippageBps: q.slippageBps,
      priceImpactPct: q.priceImpactPct,
    },
    taker,
    instructions: instructions.data,
  };
}

// ---------------------------------------------------------------------------------------------
// Transport

export interface JupiterBuildRequest {
  inputMint: string;
  outputMint: string;
  /** Raw units of the input mint (ExactIn). */
  amount: bigint;
  slippageBps: number;
  /** The wallet that signs and pays the swap. */
  taker: string;
}

export interface JupiterBuildClientOptions {
  /** JUPITER_API_URL (default https://api.jup.ag/swap/v2). */
  baseUrl: string;
  /** JUPITER_API_KEY, sent as x-api-key when present. */
  apiKey?: string | undefined;
  fetch?: typeof fetch;
  /** Minimum delay between two calls (the free tier allows 1 request per second). */
  minRequestIntervalMs: number;
  timeoutMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface JupiterBuildClient {
  build(request: JupiterBuildRequest): Promise<JupiterBuild>;
}

/**
 * `GET /build` client. Same transport rules as the Metis clients: https only, the key in a
 * header, rate limited, errors that never carry the URL or the headers.
 */
export function createJupiterBuildClient(opts: JupiterBuildClientOptions): JupiterBuildClient {
  let base: URL;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    throw new JupiterError('Jupiter API URL is invalid');
  }
  // The API key travels in this request: never over plain http.
  if (base.protocol !== 'https:') throw new JupiterError('Jupiter API URL must use https');
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  let lastCall = Number.NEGATIVE_INFINITY;

  return {
    async build({ inputMint, outputMint, amount, slippageBps, taker }) {
      const wait = lastCall + opts.minRequestIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastCall = now();
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        taker,
        slippageBps: String(slippageBps),
        // Native SOL in and out: the temporary wSOL account is created and closed in the swap.
        wrapAndUnwrapSol: 'true',
        transactionVersion: '0',
      });
      const headers: Record<string, string> = { accept: 'application/json' };
      if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/build?${params.toString()}`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (err) {
        // Never forward the original error: it could carry the request URL or headers.
        throw new JupiterError(
          `Jupiter request failed (${err instanceof Error ? err.name : 'error'})`,
        );
      }
      if (!res.ok) throw new JupiterError(`Jupiter answered with status ${res.status}`, res.status);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new JupiterError('Jupiter answered with invalid JSON', res.status);
      }
      return parseJupiterBuild(body, taker);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Assembly

/** What the assembly reads from the signer's RPC (a `Connection` satisfies it). */
export type JupiterAssemblyConnection = Pick<
  Connection,
  | 'getAddressLookupTable'
  | 'getLatestBlockhash'
  | 'simulateTransaction'
  | 'getRecentPrioritizationFees'
>;

export interface JupiterSwapPricing {
  /** The signer's priority fees (SIGNER_PRIORITY_FEE_*): their setting prices the swap. */
  priorityFees: Pick<PriorityFees, 'setting'>;
  /**
   * The job's cap of the swap's priority fee, lamports (CONVERT_MAX_PRIORITY_FEE_LAMPORTS,
   * BUYBACK_MAX_PRIORITY_FEE_LAMPORTS): also the bound of the static allowlist.
   */
  maxPriorityFeeLamports: bigint;
}

export interface AssembleJupiterSwapOptions extends JupiterSwapPricing {
  connection: JupiterAssemblyConnection;
}

export interface AssembledJupiterSwap {
  /** Unsigned v0 transaction, paid by the taker. */
  transaction: VersionedTransaction;
  /** Of the signer RPC's blockhash the transaction uses. */
  lastValidBlockHeight: number;
  priorityFee: PriorityFeeQuote;
}

function refuse(reason: string, message: string): never {
  throw new JupiterRefusal(reason, `Jupiter build refused: ${message}`);
}

function parseKey(value: string): PublicKey | null {
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value ? key : null;
  } catch {
    return null;
  }
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Pure: one API instruction, decoded; refused when malformed or signed by anyone but the taker. */
export function toTransactionInstruction(
  ix: JupiterApiInstruction,
  taker: PublicKey,
): TransactionInstruction {
  const programId = parseKey(ix.programId);
  if (!programId || !BASE64.test(ix.data)) {
    refuse('build_invalid_instruction', 'malformed instruction');
  }
  const keys = ix.accounts.map((account) => {
    const pubkey = parseKey(account.pubkey);
    if (!pubkey) refuse('build_invalid_instruction', 'malformed account');
    if (account.isSigner && !pubkey.equals(taker)) {
      refuse('build_unexpected_signer', 'an instruction asks for another signer');
    }
    return { pubkey, isSigner: account.isSigner, isWritable: account.isWritable };
  });
  return new TransactionInstruction({ programId, keys, data: Buffer.from(ix.data, 'base64') });
}

/**
 * Pure: the instructions of the swap, in Jupiter's order (setup, swap, cleanup, other), without
 * any compute budget instruction (`computeBudgetInstructions` is checked, then dropped).
 */
export function jupiterSwapInstructions(
  build: JupiterBuildInstructions,
  taker: PublicKey,
): TransactionInstruction[] {
  if (build.transactionVersion !== undefined && build.transactionVersion !== 0) {
    refuse('build_not_v0', 'not built for a v0 transaction');
  }
  if (build.tipInstruction) refuse('build_tip_not_allowed', 'a tip instruction was added');
  for (const ix of build.computeBudgetInstructions) {
    if (!toTransactionInstruction(ix, taker).programId.equals(ComputeBudgetProgram.programId)) {
      refuse('build_compute_budget_not_allowed', 'a non compute budget instruction in the budget');
    }
  }
  const instructions = [
    ...build.setupInstructions,
    build.swapInstruction,
    ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
    ...(build.otherInstructions ?? []),
  ].map((ix) => toTransactionInstruction(ix, taker));
  if (instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))) {
    refuse('build_compute_budget_not_allowed', 'a compute budget instruction among the swap');
  }
  return instructions;
}

/**
 * Reads every lookup table Jupiter names through the signer's RPC and checks it: present,
 * active, and holding each listed address at the same index (a table only grows, so the chain
 * may hold more than Jupiter lists). Returns the ON-CHAIN tables.
 */
export async function loadVerifiedLookupTables(
  connection: Pick<Connection, 'getAddressLookupTable'>,
  listed: Readonly<Record<string, readonly string[]>> | null | undefined,
): Promise<AddressLookupTableAccount[]> {
  const entries = Object.entries(listed ?? {});
  if (entries.length > MAX_JUPITER_LOOKUP_TABLES) {
    refuse('too_many_lookup_tables', 'too many lookup tables');
  }
  const out: AddressLookupTableAccount[] = [];
  for (const [address, addresses] of entries) {
    const key = parseKey(address);
    if (!key) refuse('lookup_table_mismatch', 'malformed lookup table address');
    const table = (await connection.getAddressLookupTable(key, { commitment: 'confirmed' })).value;
    if (!table) refuse('lookup_table_missing', 'a lookup table is not on chain');
    if (!table.isActive()) refuse('lookup_table_inactive', 'a lookup table is deactivated');
    const onChain = table.state.addresses;
    if (
      addresses.length > onChain.length ||
      addresses.some((a, i) => onChain[i]!.toBase58() !== a)
    ) {
      refuse('lookup_table_mismatch', 'a lookup table differs from the chain');
    }
    out.push(table);
  }
  return out;
}

/** Pure: the unit limit for a simulated consumption, 1.2x with a ceiling (1.4M when unknown). */
export function swapComputeUnitLimit(unitsConsumed: number | undefined | null): number {
  if (
    typeof unitsConsumed !== 'number' ||
    !Number.isSafeInteger(unitsConsumed) ||
    unitsConsumed <= 0
  ) {
    return MAX_COMPUTE_UNIT_LIMIT;
  }
  const units = Math.ceil((unitsConsumed * JUPITER_V2_COMPUTE_UNIT_MARGIN_PERCENT) / 100);
  return Math.min(MAX_COMPUTE_UNIT_LIMIT, units);
}

function compile(
  payer: PublicKey,
  recentBlockhash: string,
  instructions: TransactionInstruction[],
  tables: AddressLookupTableAccount[],
): VersionedTransaction {
  let tx: VersionedTransaction;
  let size: number;
  try {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash,
      instructions,
    }).compileToV0Message(tables);
    tx = new VersionedTransaction(message);
    size = tx.serialize().length;
  } catch {
    refuse('transaction_uncompilable', 'the instructions do not compile to a v0 transaction');
  }
  if (size > PACKET_DATA_SIZE) refuse('transaction_too_large', 'the transaction is too large');
  return tx;
}

/**
 * Assembles the unsigned v0 swap transaction of a `/build` answer (steps 1 to 4 at the top of
 * this file). Throws `JupiterRefusal` when Jupiter's answer is refused; RPC errors propagate.
 */
export async function assembleJupiterSwap(
  build: JupiterBuild,
  opts: AssembleJupiterSwapOptions,
): Promise<AssembledJupiterSwap> {
  const taker = parseKey(build.taker);
  if (!taker) throw new JupiterError('the taker is not an address');
  const body = jupiterSwapInstructions(build.instructions, taker);
  const tables = await loadVerifiedLookupTables(
    opts.connection,
    build.instructions.addressesByLookupTableAddress,
  );
  const { blockhash, lastValidBlockHeight } = await opts.connection.getLatestBlockhash('confirmed');

  // Units: the swap simulated at the ceiling, with the same layout (pair first).
  const probe = compile(
    taker,
    blockhash,
    [...signerBudgetPair({ computeUnitLimit: MAX_COMPUTE_UNIT_LIMIT, microLamports: 0 }), ...body],
    tables,
  );
  const simulation = await opts.connection.simulateTransaction(probe, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  });
  if (simulation.value.err !== null && simulation.value.err !== undefined) {
    refuse('simulation_failed', 'the swap fails in simulation');
  }
  const computeUnitLimit = swapComputeUnitLimit(simulation.value.unitsConsumed);

  // Price: the signer's setting, capped by the job's cap, for the accounts the swap writes.
  const setting = capPrioritySetting(opts.priorityFees.setting, opts.maxPriorityFeeLamports);
  const priorityFee = setting
    ? await estimatePriorityFee({
        connection: opts.connection,
        writableAccounts: writableAccountsOf(body),
        computeUnitLimit,
        setting,
      })
    : fixedPriorityFee(computeUnitLimit, 0);
  const instructions = [...signerBudgetPair(priorityFee), ...body];
  try {
    assertSignerBudgetPair(instructions, opts.maxPriorityFeeLamports);
  } catch (err) {
    if (err instanceof JobError && err.code === 'TX_POLICY') {
      refuse('compute_budget_not_allowed', 'the compute budget is out of bounds');
    }
    throw err;
  }
  return {
    transaction: compile(taker, blockhash, instructions, tables),
    lastValidBlockHeight,
    priorityFee,
  };
}

// ---------------------------------------------------------------------------------------------
// Job clients

export interface JupiterV2ClientOptions extends JupiterBuildClientOptions, JupiterSwapPricing {
  connection: JupiterAssemblyConnection;
}

/**
 * One build per quote, assembled at most once, for its own taker only: `swap` takes the build
 * this client returned for `quote` (never a quote from elsewhere).
 */
function buildStore(opts: JupiterV2ClientOptions) {
  const api = createJupiterBuildClient(opts);
  const builds = new WeakMap<JupiterQuote, JupiterBuild>();
  return {
    async quote(request: JupiterBuildRequest): Promise<JupiterQuote> {
      const build = await api.build(request);
      builds.set(build.quote, build);
      return build.quote;
    },
    async swap(quote: JupiterQuote, owner: string): Promise<JupiterSwap> {
      const build = builds.get(quote);
      if (!build) throw new JupiterError('the quote was not built by this Jupiter client');
      builds.delete(quote);
      if (build.taker !== owner) {
        refuse('build_taker_mismatch', 'the quote was built for another wallet');
      }
      const assembled = await assembleJupiterSwap(build, opts);
      return {
        swapTransaction: Buffer.from(assembled.transaction.serialize()).toString('base64'),
        lastValidBlockHeight: assembled.lastValidBlockHeight,
      };
    },
  };
}

/** The conversion job's Jupiter client over Swap API V2 (any mint -> wrapped SOL). */
export function createJupiterV2Client(opts: JupiterV2ClientOptions): JupiterClient {
  const store = buildStore(opts);
  return {
    quote: ({ inputMint, amount, slippageBps, taker }) =>
      store.quote({ inputMint, outputMint: WSOL_MINT, amount, slippageBps, taker }),
    swap: ({ quote, userPublicKey }) => store.swap(quote, userPublicKey),
  };
}

/** The buyback's quote source over Swap API V2 (wrapped SOL -> $FORGE). */
export function createJupiterV2BuybackClient(opts: JupiterV2ClientOptions): BuybackQuoteSource {
  const store = buildStore(opts);
  return {
    quote: ({ outputMint, lamports, slippageBps, taker }) =>
      store.quote({ inputMint: WSOL_MINT, outputMint, amount: lamports, slippageBps, taker }),
    swap: ({ quote, userPublicKey }) => store.swap(quote, userPublicKey),
  };
}
