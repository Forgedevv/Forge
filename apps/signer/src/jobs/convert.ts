/*
 * Fee conversion job (docs/METEORA.md "Jupiter", docs/OPERATIONS.md "Automatic tasks").
 *
 * Fees collected through the Jupiter integrator fee arrive in whatever currency Jupiter picks.
 * Once they sit in a FORGE-held wallet, this job swaps each non-SOL balance to SOL through the
 * Jupiter Swap API (quote then swap), so claims, the cashbox sweep and the multisig only deal
 * with SOL.
 *
 * Safety model (every line here can move money):
 *   - Mode. The job is dry-run (quote only, nothing signed, nothing sent) unless BOTH
 *     SOLANA_CLUSTER = mainnet-beta AND FORGE_CONVERT_LIVE = true. Jupiter does not index devnet,
 *     so devnet always runs in dry-run. The live check is repeated right before signing.
 *   - Quote validation. The quote must be an ExactIn swap of exactly the amount asked, from the
 *     asked mint to wrapped SOL, with slippage and price impact under the caps and an output
 *     above the minimum. Anything else is refused, never adjusted. $FORGE (FORGE_MINT) and the
 *     excluded mints are never sold.
 *   - Transaction validation. The transaction returned by the API is NOT trusted:
 *       1. static allowlist (`verifySwapTransaction`), lookup tables resolved first: the owner is
 *          the fee payer and only signer; only compute budget (bounded priority fee), idempotent
 *          ATA creation for the owner (wSOL or the input mint), SyncNative / CloseAccount of the
 *          owner's wSOL account back to the owner, System transfer / CreateAccount only into the
 *          owner's wSOL account, and exactly one Jupiter ExactIn route instruction whose decoded
 *          arguments match the quote (input amount, no platform fee, slippage <= the cap, quoted
 *          output >= the quote's). Approve, SetAuthority, token transfers, other Jupiter
 *          instructions and anything else are refused;
 *       2. simulation (`checkSwapSimulation`) with the post-state of every account the owner
 *          holds: the input mint decreases by at most the quoted amount, the owner's SOL (wallet +
 *          wSOL accounts) grows by at least `otherAmountThreshold` minus the fee bound, and
 *          nothing else changes (no other token amount, owner, delegate or close authority).
 *   - Idempotency. A (wallet, mint, run window) is converted at most once: the ledger entry is
 *     written as `submitted` BEFORE the transaction is sent and is never retried within the
 *     window, even after a crash or an unknown outcome (a resend could swap twice). The ledger is
 *     a file journal by default (`SIGNER_JOURNAL_DIR`), so a restart keeps it. A swap that is
 *     confirmed as failed, proven expired, or refused before sending may be retried in the next
 *     window.
 *   - Settlement. Same rule as the other jobs (`checkSettlement`): finalized height read before
 *     the status, expiry only past the last valid block height plus a margin.
 *   - Errors are reported, never swallowed: each balance gets its own outcome and failures raise
 *     an alert. HTTP calls are rate limited (the free Jupiter tier allows 1 request per second).
 *
 * Signing is delegated to the injected `SwapSender`; this file never touches key material.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type AccountInfo,
  type AddressLookupTableAccount,
  type Connection,
  type MessageAccountKeys,
  type VersionedMessage,
} from '@solana/web3.js';
import type { Alerter } from '../alerts.js';
import {
  FALLBACK_EXPIRY_BLOCKS,
  MAX_COMPUTE_UNIT_LIMIT,
  base58Encode,
  checkSettlement,
  createFileJournal,
  journalDirFromEnv,
  settlementRpcFromConnection,
  type RetryOptions,
} from './shared.js';

export const WSOL_MINT = NATIVE_MINT.toBase58();
export const DEFAULT_JUPITER_URL = 'https://api.jup.ag/swap/v1';

// ---------------------------------------------------------------------------------------------
// Mode

export type ConvertMode = 'dry-run' | 'live';

export interface ConvertModeInput {
  cluster: string | undefined;
  /** FORGE_CONVERT_LIVE. */
  liveFlag: string | undefined;
}

export interface ConvertModeDecision {
  mode: ConvertMode;
  reason: string;
}

/** Live only on mainnet-beta with the flag set to exactly "true". Everything else is dry-run. */
export function resolveConvertMode(input: ConvertModeInput): ConvertModeDecision {
  if (input.cluster !== 'mainnet-beta') {
    return { mode: 'dry-run', reason: `cluster is ${input.cluster ?? 'unset'}, not mainnet-beta` };
  }
  if (input.liveFlag !== 'true') {
    return { mode: 'dry-run', reason: 'FORGE_CONVERT_LIVE is not "true"' };
  }
  return { mode: 'live', reason: 'mainnet-beta with FORGE_CONVERT_LIVE=true' };
}

// ---------------------------------------------------------------------------------------------
// Configuration

export interface ConvertConfig {
  jupiterUrl: string;
  /** JUPITER_API_KEY, sent as x-api-key when present. */
  apiKey?: string | undefined;
  /** Slippage asked from Jupiter, in bps. */
  slippageBps: number;
  /** A quote with a higher slippage than this is refused. */
  maxSlippageBps: number;
  /** A quote with a higher price impact than this (in bps) is refused. */
  maxPriceImpactBps: number;
  /** Quotes paying out less than this many lamports are skipped as dust. */
  minOutputLamports: bigint;
  /**
   * Never swap more than this many raw input units of one mint in one run (0n: no cap). Default
   * `DEFAULT_CONVERT_MAX_INPUT_AMOUNT`; a larger balance is converted over several runs.
   */
  maxInputAmount: bigint;
  /** Highest priority fee (lamports) a swap transaction may carry. */
  maxPriorityFeeLamports: bigint;
  /** Minimum delay between two Jupiter HTTP calls. */
  minRequestIntervalMs: number;
  requestTimeoutMs: number;
  /** Mints never converted (e.g. the $FORGE token the buyback accumulates). */
  excludedMints: readonly string[];
}

const httpsUrl = z
  .string()
  .url()
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'JUPITER_API_URL must use https');

/**
 * Default cap of one swap, in raw input units: 1 000 USDC (6 decimals), the main non-SOL
 * currency the Jupiter integrator fee is collected in (docs/METEORA.md). It bounds what one run
 * can lose to a bad price within the slippage and price-impact caps. Set CONVERT_MAX_INPUT_AMOUNT
 * per deployment (mints with other decimals or prices), or 0 to remove the cap.
 */
export const DEFAULT_CONVERT_MAX_INPUT_AMOUNT = 1_000_000_000n;

const envSchema = z.object({
  JUPITER_API_URL: httpsUrl.default(DEFAULT_JUPITER_URL),
  JUPITER_API_KEY: z.string().optional(),
  CONVERT_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(500).default(50),
  CONVERT_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(500).default(100),
  CONVERT_MAX_PRICE_IMPACT_BPS: z.coerce.number().int().min(1).max(1000).default(100),
  CONVERT_MIN_OUTPUT_LAMPORTS: z
    .string()
    .regex(/^\d{1,18}$/)
    .default('10000000')
    .transform((v) => BigInt(v)),
  CONVERT_MAX_INPUT_AMOUNT: z
    .string()
    .regex(/^\d{1,30}$/)
    .default(DEFAULT_CONVERT_MAX_INPUT_AMOUNT.toString())
    .transform((v) => BigInt(v)),
  CONVERT_MAX_PRIORITY_FEE_LAMPORTS: z
    .string()
    .regex(/^\d{1,12}$/)
    .default('1000000')
    .transform((v) => BigInt(v)),
  CONVERT_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).default(1100),
  CONVERT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  CONVERT_EXCLUDED_MINTS: z.string().default(''),
});

export function parseConvertConfig(
  env: Readonly<Record<string, string | undefined>>,
): ConvertConfig {
  const p = envSchema.parse(env);
  const excluded = new Set(
    p.CONVERT_EXCLUDED_MINTS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // The buyback token is never sold by this job.
  if (env.FORGE_MINT) excluded.add(env.FORGE_MINT);
  const config: ConvertConfig = {
    jupiterUrl: p.JUPITER_API_URL.replace(/\/+$/, ''),
    slippageBps: p.CONVERT_SLIPPAGE_BPS,
    maxSlippageBps: p.CONVERT_MAX_SLIPPAGE_BPS,
    maxPriceImpactBps: p.CONVERT_MAX_PRICE_IMPACT_BPS,
    minOutputLamports: p.CONVERT_MIN_OUTPUT_LAMPORTS,
    maxInputAmount: p.CONVERT_MAX_INPUT_AMOUNT,
    maxPriorityFeeLamports: p.CONVERT_MAX_PRIORITY_FEE_LAMPORTS,
    minRequestIntervalMs: p.CONVERT_REQUEST_INTERVAL_MS,
    requestTimeoutMs: p.CONVERT_REQUEST_TIMEOUT_MS,
    excludedMints: [...excluded],
  };
  if (p.JUPITER_API_KEY) config.apiKey = p.JUPITER_API_KEY;
  if (config.slippageBps > config.maxSlippageBps) {
    throw new Error('CONVERT_SLIPPAGE_BPS must not exceed CONVERT_MAX_SLIPPAGE_BPS');
  }
  return config;
}

// ---------------------------------------------------------------------------------------------
// Jupiter client

const amountString = z.string().regex(/^\d{1,30}$/);

export const quoteSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: amountString,
    outAmount: amountString,
    otherAmountThreshold: amountString,
    swapMode: z.string(),
    slippageBps: z.number().int(),
    priceImpactPct: z.string(),
  })
  .passthrough();
export type JupiterQuote = z.infer<typeof quoteSchema>;

const swapResponseSchema = z.object({
  swapTransaction: z.string().min(1),
  lastValidBlockHeight: z.number().int().optional(),
});
export type JupiterSwap = z.infer<typeof swapResponseSchema>;

export class JupiterError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JupiterError';
    this.status = status;
  }
}

export interface JupiterClient {
  quote(input: { inputMint: string; amount: bigint; slippageBps: number }): Promise<JupiterQuote>;
  swap(input: { quote: JupiterQuote; userPublicKey: string }): Promise<JupiterSwap>;
}

export interface JupiterClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  fetch?: typeof fetch;
  minRequestIntervalMs: number;
  timeoutMs: number;
  /** Priority fee cap passed to Jupiter (lamports). Default 1 000 000. */
  maxPriorityFeeLamports?: bigint;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createJupiterClient(opts: JupiterClientOptions): JupiterClient {
  let base: URL;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    throw new JupiterError('Jupiter API URL is invalid');
  }
  // The API key and the quotes travel in this request: never over plain http.
  if (base.protocol !== 'https:') throw new JupiterError('Jupiter API URL must use https');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPriorityFee = opts.maxPriorityFeeLamports ?? 1_000_000n;
  let lastCall = Number.NEGATIVE_INFINITY;

  async function throttle(): Promise<void> {
    const wait = lastCall + opts.minRequestIntervalMs - now();
    if (wait > 0) await sleep(wait);
    lastCall = now();
  }

  async function request(path: string, init: RequestInit): Promise<unknown> {
    await throttle();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      // Never forward the original error: it could carry the request URL or headers.
      throw new JupiterError(
        `Jupiter request failed (${err instanceof Error ? err.name : 'error'})`,
      );
    }
    if (!res.ok) throw new JupiterError(`Jupiter answered with status ${res.status}`, res.status);
    try {
      return await res.json();
    } catch {
      throw new JupiterError('Jupiter answered with invalid JSON', res.status);
    }
  }

  return {
    async quote({ inputMint, amount, slippageBps }) {
      const params = new URLSearchParams({
        inputMint,
        outputMint: WSOL_MINT,
        amount: amount.toString(),
        slippageBps: String(slippageBps),
        swapMode: 'ExactIn',
        restrictIntermediateTokens: 'true',
      });
      const body = await request(`/quote?${params.toString()}`, { method: 'GET' });
      const parsed = quoteSchema.safeParse(body);
      if (!parsed.success) throw new JupiterError('Jupiter quote has an unexpected shape');
      return parsed.data;
    },
    async swap({ quote, userPublicKey }) {
      const body = await request('/swap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          // Output arrives as native SOL in the wallet.
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              maxLamports: Number(maxPriorityFee),
              priorityLevel: 'medium',
            },
          },
        }),
      });
      const parsed = swapResponseSchema.safeParse(body);
      if (!parsed.success) throw new JupiterError('Jupiter swap has an unexpected shape');
      return parsed.data;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pure checks

export type QuoteRejection =
  | 'input_mint_mismatch'
  | 'input_mint_excluded'
  | 'output_not_sol'
  | 'amount_mismatch'
  | 'not_exact_in'
  | 'slippage_too_high'
  | 'price_impact_too_high'
  | 'invalid_price_impact'
  | 'dust'
  | 'threshold_inconsistent';

/** Returns why a quote must not be used, or null when it is acceptable. */
export function validateQuote(
  quote: JupiterQuote,
  request: { inputMint: string; amount: bigint },
  config: Pick<ConvertConfig, 'maxSlippageBps' | 'maxPriceImpactBps' | 'minOutputLamports'> &
    Partial<Pick<ConvertConfig, 'excludedMints'>>,
): QuoteRejection | null {
  if (quote.inputMint !== request.inputMint) return 'input_mint_mismatch';
  if (config.excludedMints?.includes(quote.inputMint)) return 'input_mint_excluded';
  if (quote.outputMint !== WSOL_MINT) return 'output_not_sol';
  if (BigInt(quote.inAmount) !== request.amount) return 'amount_mismatch';
  if (quote.swapMode !== 'ExactIn') return 'not_exact_in';
  if (quote.slippageBps > config.maxSlippageBps) return 'slippage_too_high';
  const impact = Number(quote.priceImpactPct);
  if (!Number.isFinite(impact) || impact < 0) return 'invalid_price_impact';
  // priceImpactPct is a fraction: 0.01 = 1% = 100 bps.
  if (impact * 10_000 > config.maxPriceImpactBps) return 'price_impact_too_high';
  const out = BigInt(quote.outAmount);
  if (BigInt(quote.otherAmountThreshold) > out) return 'threshold_inconsistent';
  if (out < config.minOutputLamports) return 'dust';
  return null;
}

/** Window key: converting a mint twice in one UTC day is refused. */
export function runWindowKey(nowMs: number, windowMs = 24 * 60 * 60_000): string {
  return String(Math.floor(nowMs / windowMs));
}

// ---------------------------------------------------------------------------------------------
// Ledger (idempotency)

export type LedgerStatus = 'submitted' | 'confirmed' | 'failed' | 'refused';

export interface LedgerEntry {
  status: LedgerStatus;
  signature?: string;
  at: number;
}

export interface ConvertLedger {
  get(key: string): Promise<LedgerEntry | undefined>;
  set(key: string, entry: LedgerEntry): Promise<void>;
}

/** In-memory ledger: tests only (a restart would forget what was submitted). */
export function createMemoryLedger(): ConvertLedger {
  const map = new Map<string, LedgerEntry>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, entry) {
      map.set(key, entry);
    },
  };
}

const StoredLedgerEntry = z.object({
  key: z.string(),
  status: z.enum(['submitted', 'confirmed', 'failed', 'refused']),
  signature: z.string().optional(),
  at: z.number(),
});

/**
 * Durable ledger: one file journal entry per (owner, mint, window), named by the SHA-256 of the
 * ledger key (`<dir>/convert.<hash>.json`). The full key is stored and checked on read.
 */
export function createFileLedger(dir: string): ConvertLedger {
  const journal = createFileJournal({ dir, namespace: 'convert', schema: StoredLedgerEntry });
  const id = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');
  return {
    async get(key) {
      const stored = await journal.get(id(key));
      if (!stored) return undefined;
      if (stored.key !== key) throw new Error('convert ledger entry does not match its key');
      return {
        status: stored.status,
        at: stored.at,
        ...(stored.signature !== undefined ? { signature: stored.signature } : {}),
      };
    },
    async set(key, entry) {
      await journal.put(id(key), { key, ...entry });
    },
  };
}

export function ledgerKey(owner: string, mint: string, window: string): string {
  return `convert:${owner}:${mint}:${window}`;
}

// ---------------------------------------------------------------------------------------------
// Job

export interface TokenBalance {
  /** Wallet that owns the token account and will sign the swap. */
  owner: string;
  mint: string;
  /** Raw units. */
  amount: bigint;
}

export interface BalanceSource {
  list(): Promise<TokenBalance[]>;
}

/** What the swap transaction may do, from the validated quote. */
export interface SwapExpectation {
  inputMint: string;
  /** Raw input units of the quote: the swap may sell at most this. */
  inAmount: bigint;
  /** Lamports the quote guarantees (`otherAmountThreshold`). */
  minOutLamports: bigint;
  /** Output the quote announced (`outAmount`): the route's `quoted_out_amount` may not be lower. */
  quotedOutAmount: bigint;
  /** Highest `slippage_bps` the route instruction may carry (CONVERT_MAX_SLIPPAGE_BPS). */
  maxSlippageBps: number;
  /** Mints that must never be sold ($FORGE and the excluded mints). */
  forbiddenMints: readonly string[];
}

export type SendResult =
  | { status: 'confirmed'; signature: string }
  | { status: 'failed'; signature: string; error: string }
  /** Sent but the outcome is unknown after the deadline. */
  | { status: 'unknown'; signature: string }
  /** Refused before signing: nothing was signed or sent. */
  | { status: 'refused'; reason: string };

/** Verifies, signs (with the keystore) and sends a base64 transaction, then waits for it. */
export interface SwapSender {
  send(input: {
    owner: string;
    swapTransaction: string;
    lastValidBlockHeight?: number;
    expected: SwapExpectation;
  }): Promise<SendResult>;
}

export type ConvertOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'rejected'; reason: QuoteRejection }
  | { status: 'quoted'; outAmount: bigint; slippageBps: number }
  | { status: 'confirmed'; signature: string; outAmount: bigint }
  | { status: 'failed'; error: string; signature?: string }
  | { status: 'refused'; reason: string }
  | { status: 'unknown'; signature: string };

export interface ConvertItemResult {
  owner: string;
  mint: string;
  amount: bigint;
  outcome: ConvertOutcome;
}

export interface ConvertRunSummary {
  mode: ConvertMode;
  modeReason: string;
  window: string;
  items: ConvertItemResult[];
}

export interface ConvertLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ConvertDeps {
  jupiter: JupiterClient;
  balances: BalanceSource;
  /** Required for live mode; unused in dry-run. */
  sender?: SwapSender;
  /** Default: the file ledger in `journalDir` (SIGNER_JOURNAL_DIR). */
  ledger?: ConvertLedger;
  /** Directory of the default file ledger. Default: SIGNER_JOURNAL_DIR, then `./journal`. */
  journalDir?: string;
  alerter: Alerter;
  logger: ConvertLogger;
  config: ConvertConfig;
  cluster: string | undefined;
  liveFlag: string | undefined;
  now?: () => number;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

const defaultLedgers = new WeakMap<ConvertDeps, ConvertLedger>();

/** The ledger of these deps: the injected one, else a file ledger (created once). */
export function ledgerOf(deps: ConvertDeps): ConvertLedger {
  if (deps.ledger) return deps.ledger;
  let ledger = defaultLedgers.get(deps);
  if (!ledger) {
    ledger = createFileLedger(deps.journalDir ?? journalDirFromEnv(process.env));
    defaultLedgers.set(deps, ledger);
  }
  return ledger;
}

async function convertOne(
  deps: ConvertDeps,
  decision: ConvertModeDecision,
  window: string,
  balance: TokenBalance,
): Promise<ConvertOutcome> {
  const { config } = deps;
  const ledger = ledgerOf(deps);
  if (balance.mint === WSOL_MINT) return { status: 'skipped', reason: 'already_sol' };
  if (config.excludedMints.includes(balance.mint))
    return { status: 'skipped', reason: 'excluded_mint' };
  if (balance.amount <= 0n) return { status: 'skipped', reason: 'empty' };

  const key = ledgerKey(balance.owner, balance.mint, window);
  const previous = await ledger.get(key);
  // `failed` / `refused` may be retried only in another window; anything else is final for it.
  if (previous) return { status: 'skipped', reason: `already_${previous.status}` };

  const amount =
    config.maxInputAmount > 0n && balance.amount > config.maxInputAmount
      ? config.maxInputAmount
      : balance.amount;

  let quote: JupiterQuote;
  try {
    quote = await deps.jupiter.quote({
      inputMint: balance.mint,
      amount,
      slippageBps: config.slippageBps,
    });
  } catch (err) {
    return { status: 'failed', error: `quote: ${errName(err)}` };
  }
  const rejection = validateQuote(quote, { inputMint: balance.mint, amount }, config);
  if (rejection) {
    return rejection === 'dust'
      ? { status: 'skipped', reason: 'dust' }
      : { status: 'rejected', reason: rejection };
  }
  const outAmount = BigInt(quote.outAmount);
  if (decision.mode === 'dry-run') {
    return { status: 'quoted', outAmount, slippageBps: quote.slippageBps };
  }

  // Live path. Re-check the mode right before anything is built or signed.
  const recheck = resolveConvertMode({ cluster: deps.cluster, liveFlag: deps.liveFlag });
  if (recheck.mode !== 'live' || !deps.sender) {
    return { status: 'failed', error: 'live swap refused: not allowed in this environment' };
  }

  let swap: JupiterSwap;
  try {
    swap = await deps.jupiter.swap({ quote, userPublicKey: balance.owner });
  } catch (err) {
    return { status: 'failed', error: `swap: ${errName(err)}` };
  }

  // What the transaction may do comes from the VALIDATED quote, never from the swap answer.
  const expected: SwapExpectation = {
    inputMint: balance.mint,
    inAmount: amount,
    minOutLamports: BigInt(quote.otherAmountThreshold),
    quotedOutAmount: outAmount,
    maxSlippageBps: config.maxSlippageBps,
    forbiddenMints: config.excludedMints,
  };
  const now = (deps.now ?? Date.now)();
  // Written before sending: a crash or an unknown outcome must never lead to a second swap.
  await ledger.set(key, { status: 'submitted', at: now });
  let sent: SendResult;
  try {
    sent = await deps.sender.send({
      owner: balance.owner,
      swapTransaction: swap.swapTransaction,
      ...(swap.lastValidBlockHeight !== undefined
        ? { lastValidBlockHeight: swap.lastValidBlockHeight }
        : {}),
      expected,
    });
  } catch (err) {
    // The transaction may have reached the network: keep `submitted`.
    return { status: 'failed', error: `send: ${errName(err)}` };
  }
  if (sent.status === 'refused') {
    // Nothing was signed or sent: the next window may try again with a fresh quote.
    await ledger.set(key, { status: 'refused', at: now });
    return { status: 'refused', reason: sent.reason };
  }
  if (sent.status === 'confirmed') {
    await ledger.set(key, { status: 'confirmed', signature: sent.signature, at: now });
    return { status: 'confirmed', signature: sent.signature, outAmount };
  }
  if (sent.status === 'failed') {
    await ledger.set(key, { status: 'failed', signature: sent.signature, at: now });
    return { status: 'failed', error: sent.error, signature: sent.signature };
  }
  return { status: 'unknown', signature: sent.signature };
}

/** One conversion pass over every balance. Never throws for a single balance. */
export async function runConvertOnce(deps: ConvertDeps): Promise<ConvertRunSummary> {
  const now = (deps.now ?? Date.now)();
  const window = runWindowKey(now);
  const decision = resolveConvertMode({ cluster: deps.cluster, liveFlag: deps.liveFlag });
  deps.logger.info({ mode: decision.mode, reason: decision.reason, window }, 'convert run start');

  let balances: TokenBalance[];
  try {
    balances = await deps.balances.list();
  } catch (err) {
    await deps.alerter.alert(
      'high',
      'CONVERT_BALANCES_FAILED',
      'Could not read the fee balances to convert',
      {
        errorName: errName(err),
      },
    );
    return { mode: decision.mode, modeReason: decision.reason, window, items: [] };
  }

  const items: ConvertItemResult[] = [];
  for (const balance of balances) {
    let outcome: ConvertOutcome;
    try {
      outcome = await convertOne(deps, decision, window, balance);
    } catch (err) {
      outcome = { status: 'failed', error: errName(err) };
    }
    items.push({ owner: balance.owner, mint: balance.mint, amount: balance.amount, outcome });
    deps.logger.info(
      {
        owner: balance.owner,
        mint: balance.mint,
        amount: balance.amount.toString(),
        outcome: outcome.status,
      },
      'convert item',
    );
    await alertForOutcome(deps, balance, outcome);
  }
  return { mode: decision.mode, modeReason: decision.reason, window, items };
}

async function alertForOutcome(
  deps: ConvertDeps,
  balance: TokenBalance,
  outcome: ConvertOutcome,
): Promise<void> {
  const details = { owner: balance.owner, mint: balance.mint, amount: balance.amount };
  const dedupKey = `convert:${balance.owner}:${balance.mint}`;
  // In dry-run a failed quote is expected (devnet has no Jupiter): log only.
  const live =
    resolveConvertMode({ cluster: deps.cluster, liveFlag: deps.liveFlag }).mode === 'live';
  switch (outcome.status) {
    case 'confirmed':
      await deps.alerter.alert(
        'normal',
        'CONVERT_DONE',
        `Converted fees to SOL (${outcome.outAmount} lamports)`,
        { ...details, signature: outcome.signature },
        { dedupKey: `${dedupKey}:done` },
      );
      return;
    case 'failed':
      if (!live) return;
      await deps.alerter.alert(
        'high',
        'CONVERT_FAILED',
        'Fee conversion failed',
        { ...details, error: outcome.error },
        { dedupKey },
      );
      return;
    case 'rejected':
      if (!live) return;
      await deps.alerter.alert(
        'high',
        'CONVERT_QUOTE_REFUSED',
        `Quote refused: ${outcome.reason}`,
        details,
        { dedupKey: `${dedupKey}:refused` },
      );
      return;
    case 'refused':
      await deps.alerter.alert(
        'high',
        'CONVERT_TX_REFUSED',
        `The swap transaction from the Jupiter API was refused before signing: ${outcome.reason}`,
        details,
        { dedupKey: `${dedupKey}:tx-refused` },
      );
      return;
    case 'unknown':
      await deps.alerter.alert(
        'high',
        'CONVERT_UNKNOWN',
        'Swap sent but the outcome is unknown: check the transaction before the next run',
        { ...details, signature: outcome.signature },
        { dedupKey: `${dedupKey}:unknown` },
      );
      return;
    default:
      return;
  }
}

export interface ConvertHandle {
  stop(): void;
  done: Promise<void>;
}

/** Runs the job every `intervalMs` (24 h by default). Errors are logged and the loop goes on. */
export function startConvert(
  deps: ConvertDeps,
  intervalMs = 24 * 60 * 60_000,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
): ConvertHandle {
  const controller = new AbortController();
  const loop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        await runConvertOnce(deps);
      } catch (err) {
        deps.logger.error({ errorName: errName(err) }, 'convert run crashed');
      }
      if (controller.signal.aborted) break;
      await sleep(intervalMs, controller.signal);
    }
  };
  return { stop: () => controller.abort(), done: loop() };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Jupiter route instruction (decoded, never trusted)
//
// The static allowlist also decodes the arguments of the Jupiter instruction, because they are
// what the program enforces when the transaction actually executes (the simulation only proves
// the outcome at the simulated state): the minimum output is `quoted_out_amount` reduced by
// `slippage_bps`. Only the ExactIn route instructions of the Swap API are accepted; any other
// Jupiter instruction (exact-out routes, token-ledger routes, claims, account helpers...) is
// refused.
//
// Source of the layouts: the Jupiter aggregator v6 Anchor IDL (program JUP6Lkb...TaV4).
// - Discriminators: Anchor's sha256("global:<instruction name>")[0..8] (recomputed in the tests).
// - Arguments, in order (Borsh):
//     route                     route_plan: Vec<RoutePlanStep>, in_amount: u64,
//                               quoted_out_amount: u64, slippage_bps: u16, platform_fee_bps: u8
//     shared_accounts_route     id: u8, then the same arguments as `route`
//     route_v2                  in_amount: u64, quoted_out_amount: u64, slippage_bps: u16,
//                               platform_fee_bps: u16, positive_slippage_bps: u16,
//                               route_plan: Vec<RoutePlanStepV2>
//     shared_accounts_route_v2  id: u8, then the same arguments as `route_v2`
//   RoutePlanStep = { swap: Swap, percent: u8, input_index: u8, output_index: u8 }.
// - The `Swap` enum (variant order and payloads): variants 0-61 as published by Jupiter in the
//   IDL of @jup-ag/instruction-parser 6.0.28 (variants 0-38 also in jup-ag/jupiter-cpi
//   idl.json); variants 62-151 from the decoder generated with Codama from the latest v6 IDL
//   (github.com/sevenlabs-hq/carbon, decoders/jupiter-swap-decoder, regenerated 2026-05-18).
//
// In the v1 routes the route plan comes BEFORE the amounts, and the program ignores trailing
// bytes: the plan is decoded step by step and the amounts must end the data exactly, otherwise
// trailing bytes could carry fake amounts. A step of a variant unknown to the table below is
// refused (fail closed: extend the table from the IDL). In the v2 routes the amounts come first
// and the program reads them the same way whatever follows, so the plan is not decoded.

type SwapField =
  | 'bool'
  | 'u8'
  | 'u32'
  | 'u64'
  | 'u128'
  | 'u64x5'
  | 'side'
  | 'hyloSwapType'
  | 'bytes'
  | 'optionU8'
  | 'remainingAccountsInfo'
  | 'optionRemainingAccountsInfo'
  | 'candidateSwaps'
  | 'candidateSwapsWithBps';

type SwapVariant = readonly [name: string, fields: readonly SwapField[]];

/** `Swap` enum of the Jupiter v6 IDL: index = Borsh variant tag. */
export const JUPITER_SWAP_VARIANTS: readonly SwapVariant[] = [
  ['Saber', []],
  ['SaberAddDecimalsDeposit', []],
  ['SaberAddDecimalsWithdraw', []],
  ['TokenSwap', []],
  ['Sencha', []],
  ['Step', []],
  ['Cropper', []],
  ['Raydium', []],
  ['Crema', ['bool']],
  ['Lifinity', []],
  ['Mercurial', []],
  ['Cykura', []],
  ['Serum', ['side']],
  ['MarinadeDeposit', []],
  ['MarinadeUnstake', []],
  ['Aldrin', ['side']],
  ['AldrinV2', ['side']],
  ['Whirlpool', ['bool']],
  ['Invariant', ['bool']],
  ['Meteora', []],
  ['GooseFX', []],
  ['DeltaFi', ['bool']],
  ['Balansol', []],
  ['MarcoPolo', ['bool']],
  ['Dradex', ['side']],
  ['LifinityV2', []],
  ['RaydiumClmm', []],
  ['Openbook', ['side']],
  ['Phoenix', ['side']],
  ['Symmetry', ['u64', 'u64']],
  ['TokenSwapV2', []],
  ['HeliumTreasuryManagementRedeemV0', []],
  ['StakeDexStakeWrappedSol', []],
  ['StakeDexSwapViaStake', ['u32']],
  ['GooseFXV2', []],
  ['Perps', []],
  ['PerpsAddLiquidity', []],
  ['PerpsRemoveLiquidity', []],
  ['MeteoraDlmm', []],
  ['OpenBookV2', ['side']],
  ['RaydiumClmmV2', []],
  ['StakeDexPrefundWithdrawStakeAndDepositStake', ['u32']],
  ['Clone', ['u8', 'bool', 'bool']],
  ['SanctumS', ['u8', 'u8', 'u32', 'u32']],
  ['SanctumSAddLiquidity', ['u8', 'u32']],
  ['SanctumSRemoveLiquidity', ['u8', 'u32']],
  ['RaydiumCP', []],
  ['WhirlpoolSwapV2', ['bool', 'optionRemainingAccountsInfo']],
  ['OneIntro', []],
  ['PumpWrappedBuy', []],
  ['PumpWrappedSell', []],
  ['PerpsV2', []],
  ['PerpsV2AddLiquidity', []],
  ['PerpsV2RemoveLiquidity', []],
  ['MoonshotWrappedBuy', []],
  ['MoonshotWrappedSell', []],
  ['StabbleStableSwap', []],
  ['StabbleWeightedSwap', []],
  ['Obric', ['bool']],
  ['FoxBuyFromEstimatedCost', []],
  ['FoxClaimPartial', ['bool']],
  ['SolFi', ['bool']],
  ['SolayerDelegateNoInit', []],
  ['SolayerUndelegateNoInit', []],
  ['TokenMill', ['side']],
  ['DaosFunBuy', []],
  ['DaosFunSell', []],
  ['ZeroFi', []],
  ['StakeDexWithdrawWrappedSol', []],
  ['VirtualsBuy', []],
  ['VirtualsSell', []],
  ['Perena', ['u8', 'u8']],
  ['PumpSwapBuy', []],
  ['PumpSwapSell', []],
  ['Gamma', []],
  ['MeteoraDlmmSwapV2', ['remainingAccountsInfo']],
  ['Woofi', []],
  ['MeteoraDammV2', []],
  ['MeteoraDynamicBondingCurveSwap', []],
  ['StabbleStableSwapV2', []],
  ['StabbleWeightedSwapV2', []],
  ['RaydiumLaunchlabBuy', ['u64']],
  ['RaydiumLaunchlabSell', ['u64']],
  ['BoopdotfunWrappedBuy', []],
  ['BoopdotfunWrappedSell', []],
  ['Plasma', ['side']],
  ['GoonFi', ['bool', 'u8']],
  ['HumidiFi', ['u64', 'bool']],
  ['MeteoraDynamicBondingCurveSwapWithRemainingAccounts', []],
  ['TesseraV', ['side']],
  ['PumpWrappedBuyV2', []],
  ['PumpWrappedSellV2', []],
  ['PumpSwapBuyV2', []],
  ['PumpSwapSellV2', []],
  ['Heaven', ['bool']],
  ['SolFiV2', ['bool']],
  ['Aquifer', []],
  ['PumpWrappedBuyV3', []],
  ['PumpWrappedSellV3', []],
  ['PumpSwapBuyV3', []],
  ['PumpSwapSellV3', []],
  ['JupiterLendDeposit', []],
  ['JupiterLendRedeem', []],
  ['DefiTuna', ['bool', 'optionRemainingAccountsInfo']],
  ['AlphaQ', ['bool']],
  ['RaydiumV2', []],
  ['SarosDlmm', ['bool']],
  ['Futarchy', ['side']],
  ['MeteoraDammV2WithRemainingAccounts', []],
  ['Obsidian', []],
  ['WhaleStreet', ['side']],
  ['DynamicV1', ['candidateSwaps', 'optionU8']],
  ['PumpWrappedBuyV4', []],
  ['PumpWrappedSellV4', []],
  ['CarrotIssue', []],
  ['CarrotRedeem', []],
  ['Manifest', ['side']],
  ['BisonFi', ['bool']],
  ['HumidiFiV2', ['u64', 'bool']],
  ['PerenaStar', ['bool']],
  ['JupiterRfqV2', ['side', 'bytes']],
  ['GoonFiV2', ['bool']],
  ['Scorch', ['u128']],
  ['VaultLiquidUnstake', ['u64x5', 'u64']],
  ['XOrca', []],
  ['Quantum', ['side']],
  ['WhaleStreetV2', ['side', 'u64', 'u64']],
  ['Riptide', ['bool']],
  ['RunnerRodeo', []],
  ['TaurusFi', ['bool']],
  ['Omnipair', []],
  ['MSwap', []],
  ['Hylo', ['hyloSwapType']],
  ['VoltrDeposit', []],
  ['VoltrWithdraw', []],
  ['SanctumSV2', ['u8', 'u8', 'u32', 'u32']],
  ['LemmingsFi', ['bool']],
  ['ScaleVmmBuy', []],
  ['ScaleVmmSell', []],
  ['ScaleAmmBuy', []],
  ['ScaleAmmSell', []],
  ['BisonFiV2', ['bool']],
  ['Trends', []],
  ['HumaDeposit', []],
  ['HumaInstantWithdraw', []],
  ['Kipseli', ['bool']],
  ['DynamicV2', ['candidateSwapsWithBps', 'u8', 'u8']],
  ['PumpSwapBuyV3WithCashbackClaim', []],
  ['PumpSwapSellV3WithCashbackClaim', []],
  ['PumpWrappedBuyV4WithCashbackClaim', []],
  ['PumpWrappedSellV4WithCashbackClaim', []],
  ['GoonFiV3', ['bool']],
];

/** `CandidateSwap` enum (payload of the DynamicV1 / DynamicV2 variants). */
const JUPITER_CANDIDATE_SWAP_VARIANTS: readonly SwapVariant[] = [
  ['HumidiFi', ['u64', 'bool']],
  ['TesseraV', ['side']],
  ['HumidiFiV2', ['u64', 'bool']],
  ['RaydiumV2', []],
  ['RaydiumClmm', []],
  ['Whirlpool', ['bool']],
  ['ZeroFi', []],
  ['BisonFiV2', ['bool']],
  ['GoonFiV2', ['bool']],
  ['GoonFiV3', ['bool']],
  ['WhirlpoolV2', ['bool', 'optionRemainingAccountsInfo']],
];

/** Side and HyloSwapType are fieldless enums: number of variants. */
const SIDE_VARIANTS = 2;
const HYLO_SWAP_TYPE_VARIANTS = 8;

/** The ExactIn route instructions a Swap API transaction may use. */
export const JUPITER_ROUTE_INSTRUCTIONS = {
  route: { discriminator: [229, 23, 203, 151, 122, 227, 173, 42], shared: false, v2: false },
  shared_accounts_route: {
    discriminator: [193, 32, 155, 51, 65, 214, 156, 129],
    shared: true,
    v2: false,
  },
  route_v2: { discriminator: [187, 100, 250, 204, 49, 196, 175, 20], shared: false, v2: true },
  shared_accounts_route_v2: {
    discriminator: [209, 152, 83, 147, 124, 254, 216, 233],
    shared: true,
    v2: true,
  },
} as const satisfies Record<
  string,
  { discriminator: readonly number[]; shared: boolean; v2: boolean }
>;

/** Exact-out routes: recognized only to be refused with a precise reason (quotes are ExactIn). */
export const JUPITER_EXACT_OUT_INSTRUCTIONS = {
  exact_out_route: [208, 51, 239, 151, 123, 43, 237, 92],
  shared_accounts_exact_out_route: [176, 209, 105, 168, 154, 125, 69, 62],
  exact_out_route_v2: [157, 138, 184, 82, 21, 244, 243, 36],
  shared_accounts_exact_out_route_v2: [53, 96, 229, 202, 216, 187, 250, 24],
} as const satisfies Record<string, readonly number[]>;

export type JupiterRouteName = keyof typeof JUPITER_ROUTE_INSTRUCTIONS;

/** What the Jupiter program will enforce for a route instruction. */
export interface JupiterRouteArgs {
  instruction: JupiterRouteName;
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
}

export type JupiterRouteRefusal =
  'jupiter_instruction_not_allowed' | 'jupiter_route_not_exact_in' | 'jupiter_route_undecodable';

export type JupiterRouteDecode =
  { ok: true; route: JupiterRouteArgs } | { ok: false; reason: JupiterRouteRefusal };

class RouteDecodeError extends Error {}

interface BorshReader {
  remaining(): number;
  skip(n: number): void;
  u8(): number;
  u16(): number;
  u32(): number;
  u64(): bigint;
  /** A fieldless enum / bool / Option tag: refused when it is not below `count`. */
  tag(count: number): number;
  /** A Vec length prefix, refused when its elements cannot fit in what is left. */
  vecLength(minElementBytes: number): number;
}

function borshReader(data: Buffer): BorshReader {
  let offset = 0;
  const take = (n: number): number => {
    if (n > data.length - offset) throw new RouteDecodeError('truncated');
    const at = offset;
    offset += n;
    return at;
  };
  const reader: BorshReader = {
    remaining: () => data.length - offset,
    skip: (n) => {
      take(n);
    },
    u8: () => data.readUInt8(take(1)),
    u16: () => data.readUInt16LE(take(2)),
    u32: () => data.readUInt32LE(take(4)),
    u64: () => data.readBigUInt64LE(take(8)),
    tag(count) {
      const value = reader.u8();
      if (value >= count) throw new RouteDecodeError('invalid tag');
      return value;
    },
    vecLength(minElementBytes) {
      const length = reader.u32();
      if (length * minElementBytes > reader.remaining()) throw new RouteDecodeError('vec length');
      return length;
    },
  };
  return reader;
}

function skipSwapField(r: BorshReader, field: SwapField): void {
  switch (field) {
    case 'bool':
      r.tag(2);
      return;
    case 'u8':
      r.skip(1);
      return;
    case 'u32':
      r.skip(4);
      return;
    case 'u64':
      r.skip(8);
      return;
    case 'u128':
      r.skip(16);
      return;
    case 'u64x5':
      r.skip(40);
      return;
    case 'side':
      r.tag(SIDE_VARIANTS);
      return;
    case 'hyloSwapType':
      r.tag(HYLO_SWAP_TYPE_VARIANTS);
      return;
    case 'bytes':
      r.skip(r.vecLength(1));
      return;
    case 'optionU8':
      if (r.tag(2) === 1) r.skip(1);
      return;
    case 'remainingAccountsInfo':
      // Vec<RemainingAccountsSlice { accounts_type: u8, length: u8 }>
      r.skip(2 * r.vecLength(2));
      return;
    case 'optionRemainingAccountsInfo':
      if (r.tag(2) === 1) skipSwapField(r, 'remainingAccountsInfo');
      return;
    case 'candidateSwaps':
      for (let i = r.vecLength(1); i > 0; i--) skipSwapVariant(r, JUPITER_CANDIDATE_SWAP_VARIANTS);
      return;
    case 'candidateSwapsWithBps':
      // Vec<CandidateSwapWithBps { candidate_swap: CandidateSwap, bps: u32 }>
      for (let i = r.vecLength(5); i > 0; i--) {
        skipSwapVariant(r, JUPITER_CANDIDATE_SWAP_VARIANTS);
        r.skip(4);
      }
      return;
  }
}

function skipSwapVariant(r: BorshReader, variants: readonly SwapVariant[]): void {
  // An unknown tag throws: a variant missing from the table is never guessed.
  const [, fields] = variants[r.tag(variants.length)]!;
  for (const field of fields) skipSwapField(r, field);
}

function startsWith(data: Buffer, discriminator: readonly number[]): boolean {
  return discriminator.every((b, i) => data[i] === b);
}

/**
 * Decodes a Jupiter v6 instruction. Accepts only the ExactIn routes of the Swap API (`route`,
 * `shared_accounts_route` and their v2), refuses the exact-out routes and any other instruction.
 */
export function decodeJupiterRoute(data: Uint8Array): JupiterRouteDecode {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 8) return { ok: false, reason: 'jupiter_instruction_not_allowed' };
  for (const discriminator of Object.values(JUPITER_EXACT_OUT_INSTRUCTIONS)) {
    if (startsWith(buf, discriminator)) return { ok: false, reason: 'jupiter_route_not_exact_in' };
  }
  const names = Object.keys(JUPITER_ROUTE_INSTRUCTIONS) as JupiterRouteName[];
  const instruction = names.find((name) =>
    startsWith(buf, JUPITER_ROUTE_INSTRUCTIONS[name].discriminator),
  );
  if (!instruction) return { ok: false, reason: 'jupiter_instruction_not_allowed' };
  const spec = JUPITER_ROUTE_INSTRUCTIONS[instruction];
  try {
    const r = borshReader(buf.subarray(8));
    if (spec.shared) r.skip(1); // id
    if (spec.v2) {
      const inAmount = r.u64();
      const quotedOutAmount = r.u64();
      const slippageBps = r.u16();
      const platformFeeBps = r.u16();
      r.skip(2); // positive_slippage_bps
      r.vecLength(1); // route_plan follows
      return {
        ok: true,
        route: { instruction, inAmount, quotedOutAmount, slippageBps, platformFeeBps },
      };
    }
    // RoutePlanStep: Swap (at least its tag) + percent + input_index + output_index.
    for (let steps = r.vecLength(4); steps > 0; steps--) {
      skipSwapVariant(r, JUPITER_SWAP_VARIANTS);
      r.skip(3);
    }
    const inAmount = r.u64();
    const quotedOutAmount = r.u64();
    const slippageBps = r.u16();
    const platformFeeBps = r.u8();
    // What the program reads ends here: anything after it is refused (see above).
    if (r.remaining() !== 0) throw new RouteDecodeError('trailing bytes');
    return {
      ok: true,
      route: { instruction, inAmount, quotedOutAmount, slippageBps, platformFeeBps },
    };
  } catch (err) {
    if (err instanceof RouteDecodeError) return { ok: false, reason: 'jupiter_route_undecodable' };
    throw err;
  }
}

export type JupiterRouteCheck =
  | 'jupiter_route_amount_mismatch'
  | 'jupiter_route_platform_fee'
  | 'jupiter_route_slippage_too_high'
  | 'jupiter_route_quoted_out_too_low';

/**
 * Pure: the decoded route against the validated quote. It must sell exactly the quoted input,
 * take no platform fee (none is asked for), carry a slippage within the configured maximum and
 * announce at least the quoted output, so the minimum the program enforces is at least
 * `outAmount * (10 000 - maxSlippageBps) / 10 000`.
 */
export function checkJupiterRoute(
  route: JupiterRouteArgs,
  expected: Pick<SwapExpectation, 'inAmount' | 'quotedOutAmount' | 'maxSlippageBps'>,
): JupiterRouteCheck | null {
  if (route.inAmount !== expected.inAmount) return 'jupiter_route_amount_mismatch';
  if (route.platformFeeBps !== 0) return 'jupiter_route_platform_fee';
  if (route.slippageBps > expected.maxSlippageBps) return 'jupiter_route_slippage_too_high';
  if (route.quotedOutAmount < expected.quotedOutAmount) return 'jupiter_route_quoted_out_too_low';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Swap transaction checks

/** Jupiter aggregator v6 program: every Jupiter swap transaction invokes it. */
export const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/** Base fee per signature (lamports). */
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000n;
/** Compute units per instruction when no limit is set (runtime default). */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;

export type SwapRefusal =
  | 'undecodable'
  | 'fee_payer_mismatch'
  | 'extra_signers'
  | 'input_mint_forbidden'
  | 'lookup_table_missing'
  | 'program_from_lookup_table'
  | 'missing_accounts'
  | 'compute_budget_not_allowed'
  | 'compute_unit_limit_too_high'
  | 'priority_fee_too_high'
  | 'ata_not_allowed'
  | 'token_instruction_not_allowed'
  | 'system_instruction_not_allowed'
  | 'program_not_allowed'
  | 'jupiter_program_missing'
  | 'jupiter_multiple_routes'
  | 'expectation_invalid'
  | JupiterRouteRefusal
  | JupiterRouteCheck
  | 'simulation_failed'
  | 'simulation_incomplete'
  | 'state_changed_during_check'
  | 'owner_account_changed'
  | 'token_account_changed'
  | 'input_increased'
  | 'input_overspent'
  | 'output_below_minimum';

export type SwapCheck = { ok: true; feeBoundLamports: bigint } | { ok: false; reason: SwapRefusal };

export interface VerifySwapParams {
  owner: string;
  /** The lookup tables the message references, resolved from the chain. */
  lookupTables: readonly AddressLookupTableAccount[];
  expected: SwapExpectation;
  maxPriorityFeeLamports: bigint;
}

function isTokenProgram(id: PublicKey): boolean {
  return id.equals(TOKEN_PROGRAM_ID) || id.equals(TOKEN_2022_PROGRAM_ID);
}

const refuse = (reason: SwapRefusal): SwapCheck => ({ ok: false, reason });

/**
 * Static allowlist of a Jupiter-provided transaction, before anything is simulated or signed.
 * Every instruction's accounts are resolved (static keys + lookup tables). Allowed:
 * - ComputeBudget SetComputeUnitLimit (<= 1.4M) and SetComputeUnitPrice (total priority fee
 *   <= `maxPriorityFeeLamports`);
 * - Associated Token CreateIdempotent paid by the owner, for the owner, of wSOL or the input mint;
 * - Token SyncNative of the owner's wSOL account; CloseAccount of it, to the owner, by the owner;
 * - System Transfer / CreateAccount from the owner into the owner's wSOL account;
 * - exactly one Jupiter instruction, an ExactIn route (`decodeJupiterRoute`) whose arguments match
 *   the validated quote (`checkJupiterRoute`): input = `expected.inAmount`, no platform fee,
 *   slippage <= `expected.maxSlippageBps`, quoted output >= `expected.quotedOutAmount`.
 * Anything else (Approve, SetAuthority, token transfers, other programs, other Jupiter
 * instructions...) is refused. Returns the fee bound (base fee + priority fee) used by the
 * simulation check.
 */
export function verifySwapTransaction(
  tx: VersionedTransaction,
  params: VerifySwapParams,
): SwapCheck {
  const { expected } = params;
  const message = tx.message;
  let ownerKey: PublicKey;
  let inputMint: PublicKey;
  try {
    ownerKey = new PublicKey(params.owner);
    inputMint = new PublicKey(expected.inputMint);
  } catch {
    return refuse('undecodable');
  }
  const staticKeys = message.staticAccountKeys;
  if (!staticKeys[0]?.equals(ownerKey)) return refuse('fee_payer_mismatch');
  if (message.header.numRequiredSignatures !== 1) return refuse('extra_signers');
  if (expected.inputMint === WSOL_MINT || expected.forbiddenMints.includes(expected.inputMint)) {
    return refuse('input_mint_forbidden');
  }
  // Without a positive quoted output and a sane slippage cap the route check would bound nothing.
  if (
    expected.inAmount <= 0n ||
    expected.quotedOutAmount <= 0n ||
    !Number.isInteger(expected.maxSlippageBps) ||
    expected.maxSlippageBps < 0 ||
    expected.maxSlippageBps > 10_000
  ) {
    return refuse('expectation_invalid');
  }
  let keys: MessageAccountKeys;
  try {
    keys = message.getAccountKeys({ addressLookupTableAccounts: [...params.lookupTables] });
  } catch {
    return refuse('lookup_table_missing');
  }
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, ownerKey, true, TOKEN_PROGRAM_ID);

  let jupiter = 0;
  let nonBudget = 0;
  let unitLimit: number | null = null;
  let unitPrice = 0n;
  for (const ix of message.compiledInstructions) {
    if (ix.programIdIndex >= staticKeys.length) return refuse('program_from_lookup_table');
    const program = staticKeys[ix.programIdIndex]!;
    const data = Buffer.from(ix.data);
    const accounts: PublicKey[] = [];
    for (const index of ix.accountKeyIndexes) {
      const key = keys.get(index);
      if (!key) return refuse('missing_accounts');
      accounts.push(key);
    }
    const at = (i: number): PublicKey | undefined => accounts[i];

    if (program.equals(ComputeBudgetProgram.programId)) {
      if (data[0] === 2 && data.length === 5) {
        const units = data.readUInt32LE(1);
        if (units > MAX_COMPUTE_UNIT_LIMIT) return refuse('compute_unit_limit_too_high');
        unitLimit = units;
      } else if (data[0] === 3 && data.length === 9) {
        unitPrice = data.readBigUInt64LE(1);
      } else {
        return refuse('compute_budget_not_allowed');
      }
      continue;
    }
    nonBudget++;
    if (program.toBase58() === JUPITER_PROGRAM_ID) {
      // One route per swap: a second one would sell the input again.
      if (++jupiter > 1) return refuse('jupiter_multiple_routes');
      const decoded = decodeJupiterRoute(data);
      if (!decoded.ok) return refuse(decoded.reason);
      const mismatch = checkJupiterRoute(decoded.route, expected);
      if (mismatch) return refuse(mismatch);
      continue;
    }
    if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (!(data.length === 1 && data[0] === 1) || accounts.length < 6) {
        return refuse('ata_not_allowed');
      }
      const [payer, ata, wallet, mint, system, tokenProgram] = accounts as [
        PublicKey,
        PublicKey,
        PublicKey,
        PublicKey,
        PublicKey,
        PublicKey,
      ];
      if (!payer.equals(ownerKey) || !wallet.equals(ownerKey)) return refuse('ata_not_allowed');
      if (!mint.equals(NATIVE_MINT) && !mint.equals(inputMint)) return refuse('ata_not_allowed');
      if (!system.equals(SystemProgram.programId) || !isTokenProgram(tokenProgram)) {
        return refuse('ata_not_allowed');
      }
      if (!ata.equals(getAssociatedTokenAddressSync(mint, ownerKey, true, tokenProgram))) {
        return refuse('ata_not_allowed');
      }
      continue;
    }
    if (program.equals(TOKEN_PROGRAM_ID)) {
      if (data.length === 1 && data[0] === 17) {
        if (!at(0)?.equals(wsolAta)) return refuse('token_instruction_not_allowed');
        continue;
      }
      if (data.length === 1 && data[0] === 9) {
        if (!at(0)?.equals(wsolAta) || !at(1)?.equals(ownerKey) || !at(2)?.equals(ownerKey)) {
          return refuse('token_instruction_not_allowed');
        }
        continue;
      }
      return refuse('token_instruction_not_allowed');
    }
    if (program.equals(SystemProgram.programId)) {
      const kind = data.length >= 4 ? data.readUInt32LE(0) : -1;
      const intoWsol = at(0)?.equals(ownerKey) && at(1)?.equals(wsolAta);
      if ((kind === 2 && data.length === 12) || (kind === 0 && data.length === 52)) {
        if (!intoWsol) return refuse('system_instruction_not_allowed');
        continue;
      }
      return refuse('system_instruction_not_allowed');
    }
    return refuse('program_not_allowed');
  }
  if (jupiter === 0) return refuse('jupiter_program_missing');
  const units =
    unitLimit ?? Math.min(MAX_COMPUTE_UNIT_LIMIT, DEFAULT_UNITS_PER_INSTRUCTION * nonBudget);
  const priorityFee = (unitPrice * BigInt(units) + 999_999n) / 1_000_000n;
  if (priorityFee > params.maxPriorityFeeLamports) return refuse('priority_fee_too_high');
  return {
    ok: true,
    feeBoundLamports:
      BASE_FEE_LAMPORTS_PER_SIGNATURE * BigInt(message.header.numRequiredSignatures) + priorityFee,
  };
}

/** Account state for the delta check: program owner, lamports and raw data. */
export interface AccountStateLite {
  owner: string;
  lamports: bigint;
  data: Buffer;
}

export interface AccountDelta {
  address: string;
  /** Null: the account does not exist. */
  pre: AccountStateLite | null;
  post: AccountStateLite | null;
}

interface TokenFields {
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  delegatedAmount: bigint;
  closeAuthority: string | null;
  state: number;
}

function decodeTokenAccount(state: AccountStateLite | null): TokenFields | null {
  if (!state || state.data.length < AccountLayout.span) return null;
  if (
    state.owner !== TOKEN_PROGRAM_ID.toBase58() &&
    state.owner !== TOKEN_2022_PROGRAM_ID.toBase58()
  ) {
    return null;
  }
  const raw = AccountLayout.decode(state.data.subarray(0, AccountLayout.span));
  return {
    mint: raw.mint.toBase58(),
    owner: raw.owner.toBase58(),
    amount: raw.amount,
    delegate: raw.delegateOption ? raw.delegate.toBase58() : null,
    delegatedAmount: raw.delegatedAmount,
    closeAuthority: raw.closeAuthorityOption ? raw.closeAuthority.toBase58() : null,
    state: raw.state,
  };
}

function sameState(a: AccountStateLite | null, b: AccountStateLite | null): boolean {
  if (!a || !b) return a === b;
  return a.owner === b.owner && a.lamports === b.lamports && a.data.equals(b.data);
}

/**
 * Pure: compares the owner's accounts before and after the simulated swap.
 * - the owner wallet stays a plain System account;
 * - token accounts keep their mint, owner (= the owner), delegate, close authority and state;
 * - only wSOL accounts may be created or closed (they count as SOL, by lamports);
 * - input mint: decreases by at most `expected.inAmount` (never increases);
 * - every other mint: unchanged;
 * - SOL (wallet + wSOL accounts): grows by at least `minOutLamports - feeBoundLamports`.
 */
export function compareSwapStates(
  owner: string,
  expected: SwapExpectation,
  feeBoundLamports: bigint,
  deltas: readonly AccountDelta[],
): SwapRefusal | null {
  const system = SystemProgram.programId.toBase58();
  let solPre = 0n;
  let solPost = 0n;
  let inputPre = 0n;
  let inputPost = 0n;
  let sawOwner = false;
  for (const raw of deltas) {
    // An account closed by the swap (the temporary wrapped SOL account) comes back from the
    // simulation as a zero-lamport, empty, system-owned stub: a missing account.
    const closed = (s: AccountStateLite | null) =>
      s && s.lamports === 0n && s.data.length === 0 ? null : s;
    const d: AccountDelta = { address: raw.address, pre: closed(raw.pre), post: closed(raw.post) };
    if (d.address === owner) {
      sawOwner = true;
      if (!d.pre || !d.post || d.post.owner !== system || d.post.data.length !== 0) {
        return 'owner_account_changed';
      }
      solPre += d.pre.lamports;
      solPost += d.post.lamports;
      continue;
    }
    const pre = decodeTokenAccount(d.pre);
    const post = decodeTokenAccount(d.post);
    if ((d.pre && !pre) || (d.post && !post)) {
      // Not (or no longer) a token account: it must not change at all.
      if (!sameState(d.pre, d.post)) return 'token_account_changed';
      continue;
    }
    if (!pre && !post) continue;
    const mint = (pre ?? post)!.mint;
    const ref = pre ?? post!;
    for (const t of [pre, post]) {
      if (t && (t.owner !== owner || t.mint !== mint)) return 'token_account_changed';
    }
    if (pre && post) {
      if (
        pre.delegate !== post.delegate ||
        pre.delegatedAmount !== post.delegatedAmount ||
        pre.closeAuthority !== post.closeAuthority ||
        pre.state !== post.state
      ) {
        return 'token_account_changed';
      }
    } else if (post && (post.delegate !== null || post.closeAuthority !== null)) {
      return 'token_account_changed';
    }
    if (
      mint === WSOL_MINT &&
      d.address ===
        getAssociatedTokenAddressSync(
          NATIVE_MINT,
          new PublicKey(owner),
          true,
          TOKEN_PROGRAM_ID,
        ).toBase58()
    ) {
      solPre += d.pre?.lamports ?? 0n;
      solPost += d.post?.lamports ?? 0n;
      continue;
    }
    // Any other account must exist before and after (only the wSOL account comes and goes).
    if (!pre || !post) return 'token_account_changed';
    if (mint === expected.inputMint) {
      inputPre += pre.amount;
      inputPost += post.amount;
      continue;
    }
    if (pre.amount !== post.amount || d.pre!.lamports !== d.post!.lamports || ref.mint !== mint) {
      return 'token_account_changed';
    }
  }
  if (!sawOwner) return 'simulation_incomplete';
  if (inputPost > inputPre) return 'input_increased';
  if (inputPre - inputPost > expected.inAmount) return 'input_overspent';
  if (solPost - solPre < expected.minOutLamports - feeBoundLamports) return 'output_below_minimum';
  return null;
}

export type SwapConnection = Pick<
  Connection,
  | 'sendRawTransaction'
  | 'getSignatureStatuses'
  | 'getBlockHeight'
  | 'getSlot'
  | 'getTransaction'
  | 'getAddressLookupTable'
  | 'simulateTransaction'
  | 'getMultipleAccountsInfoAndContext'
  | 'getTokenAccountsByOwner'
>;

const ACCOUNTS_PER_REQUEST = 100;

function toLite(info: AccountInfo<Buffer> | null | undefined): AccountStateLite | null {
  if (!info) return null;
  return { owner: info.owner.toBase58(), lamports: BigInt(info.lamports), data: info.data };
}

async function readAccounts(
  connection: SwapConnection,
  keys: readonly PublicKey[],
): Promise<{ slot: number; states: (AccountStateLite | null)[] }> {
  const states: (AccountStateLite | null)[] = [];
  let slot = 0;
  for (let i = 0; i < keys.length; i += ACCOUNTS_PER_REQUEST) {
    const res = await connection.getMultipleAccountsInfoAndContext(
      keys.slice(i, i + ACCOUNTS_PER_REQUEST),
      'confirmed',
    );
    slot = Math.max(slot, res.context.slot);
    for (const info of res.value) states.push(toLite(info));
  }
  return { slot, states };
}

/**
 * Simulates the swap with the post-state of every account the owner holds (its wallet, all its
 * token accounts of both programs, its wSOL and input-mint ATAs) and checks the deltas with
 * `compareSwapStates`. The pre-state is read before AND after the simulation and must be the
 * same, so the simulation ran on the state that was compared.
 */
export async function checkSwapSimulation(
  connection: SwapConnection,
  tx: VersionedTransaction,
  input: { owner: string; expected: SwapExpectation; feeBoundLamports: bigint },
): Promise<SwapRefusal | null> {
  const owner = new PublicKey(input.owner);
  const watched = new Map<string, PublicKey>();
  const add = (k: PublicKey) => watched.set(k.toBase58(), k);
  add(owner);
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await connection.getTokenAccountsByOwner(owner, { programId }, 'confirmed');
    for (const { pubkey } of res.value) add(pubkey);
  }
  const inputMint = new PublicKey(input.expected.inputMint);
  add(getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID));
  add(getAssociatedTokenAddressSync(inputMint, owner, true, TOKEN_PROGRAM_ID));
  add(getAssociatedTokenAddressSync(inputMint, owner, true, TOKEN_2022_PROGRAM_ID));
  const keys = [...watched.values()];

  const before = await readAccounts(connection, keys);
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: false,
    commitment: 'confirmed',
    minContextSlot: before.slot,
    accounts: { encoding: 'base64', addresses: keys.map((k) => k.toBase58()) },
  });
  const again = await readAccounts(connection, keys);
  if (sim.value.err !== null && sim.value.err !== undefined) return 'simulation_failed';
  const post = sim.value.accounts;
  if (!post || post.length !== keys.length) return 'simulation_incomplete';
  for (let i = 0; i < keys.length; i++) {
    if (!sameState(before.states[i] ?? null, again.states[i] ?? null)) {
      return 'state_changed_during_check';
    }
  }
  const deltas: AccountDelta[] = keys.map((k, i) => {
    const p = post[i];
    return {
      address: k.toBase58(),
      pre: before.states[i] ?? null,
      post: p
        ? {
            owner: p.owner,
            lamports: BigInt(p.lamports),
            data: Buffer.from(p.data[0] ?? '', 'base64'),
          }
        : null,
    };
  });
  return compareSwapStates(input.owner, input.expected, input.feeBoundLamports, deltas);
}

/** Resolves the lookup tables of a message; null when one cannot be found. */
export async function loadLookupTables(
  connection: Pick<Connection, 'getAddressLookupTable'>,
  message: VersionedMessage,
): Promise<AddressLookupTableAccount[] | null> {
  const out: AddressLookupTableAccount[] = [];
  for (const lookup of message.addressTableLookups) {
    const res = await connection.getAddressLookupTable(lookup.accountKey, {
      commitment: 'confirmed',
    });
    if (!res.value) return null;
    out.push(res.value);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Adapters

/** Token balances (classic and Token-2022) of the given wallets, one entry per (owner, mint). */
export function createRpcBalanceSource(
  connection: Pick<Connection, 'getParsedTokenAccountsByOwner'>,
  owners: readonly string[],
): BalanceSource {
  return {
    async list() {
      const out: TokenBalance[] = [];
      for (const owner of owners) {
        const totals = new Map<string, bigint>();
        for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
          const res = await connection.getParsedTokenAccountsByOwner(
            new PublicKey(owner),
            { programId },
            'confirmed',
          );
          for (const { account } of res.value) {
            const info = (account.data as { parsed?: { info?: unknown } }).parsed?.info as
              { mint?: string; state?: string; tokenAmount?: { amount?: string } } | undefined;
            if (!info?.mint || !info.tokenAmount?.amount || info.state === 'frozen') continue;
            totals.set(info.mint, (totals.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
          }
        }
        for (const [mint, amount] of totals) out.push({ owner, mint, amount });
      }
      return out;
    },
  };
}

export interface RpcSwapSenderOptions {
  connection: SwapConnection;
  /** Signs in place with the key of `owner` (keystore `withSigner`). */
  signTransaction(owner: string, tx: VersionedTransaction): Promise<void>;
  /** Highest priority fee accepted in a swap transaction. Default 1 000 000 lamports. */
  maxPriorityFeeLamports?: bigint;
  /** Give up waiting for a status after this long. Default 180 s (past a proven expiry). */
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Retries of the settlement reads. */
  retry?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Verifies (allowlist + simulation), signs and sends a Jupiter swap, then polls its settlement
 * with `checkSettlement` (no websocket). Returns `refused` when nothing was signed or sent.
 */
export function createRpcSwapSender(opts: RpcSwapSenderOptions): SwapSender {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.confirmTimeoutMs ?? 180_000;
  const pollMs = opts.pollIntervalMs ?? 2_000;
  const maxPriorityFeeLamports = opts.maxPriorityFeeLamports ?? 1_000_000n;
  const retry: RetryOptions = opts.retry ?? {
    attempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 4_000,
    sleep,
  };
  const settlementRpc = settlementRpcFromConnection(opts.connection);
  return {
    async send({ owner, swapTransaction, lastValidBlockHeight, expected }) {
      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      } catch {
        return { status: 'refused', reason: 'undecodable' };
      }
      const lookupTables = await loadLookupTables(opts.connection, tx.message);
      if (!lookupTables) return { status: 'refused', reason: 'lookup_table_missing' };
      const check = verifySwapTransaction(tx, {
        owner,
        lookupTables,
        expected,
        maxPriorityFeeLamports,
      });
      if (!check.ok) return { status: 'refused', reason: check.reason };
      const simulated = await checkSwapSimulation(opts.connection, tx, {
        owner,
        expected,
        feeBoundLamports: check.feeBoundLamports,
      });
      if (simulated) return { status: 'refused', reason: simulated };

      // Expiry bound: Jupiter's, else a height observed now (>= the blockhash's) + a safe margin.
      const expiry =
        lastValidBlockHeight ??
        (await opts.connection.getBlockHeight('confirmed')) + FALLBACK_EXPIRY_BLOCKS;
      await opts.signTransaction(owner, tx);
      const first = tx.signatures[0];
      if (!first || first.length !== 64 || first.every((b) => b === 0)) {
        throw new Error('swap transaction is not signed');
      }
      const signature = base58Encode(first);
      try {
        await opts.connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      } catch {
        // It may still have reached the network: only the settlement check decides.
      }
      const deadline = now() + timeoutMs;
      for (;;) {
        const s = await checkSettlement(settlementRpc, signature, expiry, retry);
        if (s.kind === 'confirmed' || s.kind === 'finalized') {
          return { status: 'confirmed', signature };
        }
        if (s.kind === 'failed') return { status: 'failed', signature, error: s.error };
        if (s.kind === 'expired')
          return { status: 'failed', signature, error: 'blockhash expired' };
        if (now() >= deadline) return { status: 'unknown', signature };
        await sleep(pollMs);
      }
    },
  };
}
