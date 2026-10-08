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
 *     above the minimum. Anything else is refused, never adjusted.
 *   - Idempotency. A (wallet, mint, run window) is converted at most once: the ledger entry is
 *     written as `submitted` BEFORE the transaction is sent and is never retried within the
 *     window, even after a crash or an unknown outcome (a resend could swap twice). A swap that
 *     is confirmed as failed on-chain is marked `failed` and may be retried in the next window.
 *   - Errors are reported, never swallowed: each balance gets its own outcome and failures raise
 *     an alert. HTTP calls are rate limited (the free Jupiter tier allows 1 request per second).
 *
 * Signing is delegated to the injected `SwapSender`; this file never touches key material.
 */
import { z } from 'zod';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import type { Alerter } from '../alerts.js';

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
  /** Never swap more than this many input units of one mint in one run (0n: no cap). */
  maxInputAmount: bigint;
  /** Minimum delay between two Jupiter HTTP calls. */
  minRequestIntervalMs: number;
  requestTimeoutMs: number;
  /** Mints never converted (e.g. the $FORGE token the buyback accumulates). */
  excludedMints: readonly string[];
}

const envSchema = z.object({
  JUPITER_API_URL: z.string().url().default(DEFAULT_JUPITER_URL),
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
    .default('0')
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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createJupiterClient(opts: JupiterClientOptions): JupiterClient {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
  config: Pick<ConvertConfig, 'maxSlippageBps' | 'maxPriceImpactBps' | 'minOutputLamports'>,
): QuoteRejection | null {
  if (quote.inputMint !== request.inputMint) return 'input_mint_mismatch';
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

export type LedgerStatus = 'submitted' | 'confirmed' | 'failed';

export interface LedgerEntry {
  status: LedgerStatus;
  signature?: string;
  at: number;
}

export interface ConvertLedger {
  get(key: string): Promise<LedgerEntry | undefined>;
  set(key: string, entry: LedgerEntry): Promise<void>;
}

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

export type SendResult =
  | { status: 'confirmed'; signature: string }
  | { status: 'failed'; signature: string; error: string }
  /** Sent but the outcome is unknown after the deadline. */
  | { status: 'unknown'; signature: string };

/** Signs (with the keystore) and sends a base64 transaction, then waits for its status. */
export interface SwapSender {
  send(input: {
    owner: string;
    swapTransaction: string;
    lastValidBlockHeight?: number;
  }): Promise<SendResult>;
}

export type ConvertOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'rejected'; reason: QuoteRejection }
  | { status: 'quoted'; outAmount: bigint; slippageBps: number }
  | { status: 'confirmed'; signature: string; outAmount: bigint }
  | { status: 'failed'; error: string; signature?: string }
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
  ledger: ConvertLedger;
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

async function convertOne(
  deps: ConvertDeps,
  decision: ConvertModeDecision,
  window: string,
  balance: TokenBalance,
): Promise<ConvertOutcome> {
  const { config } = deps;
  if (balance.mint === WSOL_MINT) return { status: 'skipped', reason: 'already_sol' };
  if (config.excludedMints.includes(balance.mint))
    return { status: 'skipped', reason: 'excluded_mint' };
  if (balance.amount <= 0n) return { status: 'skipped', reason: 'empty' };

  const key = ledgerKey(balance.owner, balance.mint, window);
  const previous = await deps.ledger.get(key);
  // `failed` may be retried only in another window; anything else is final for this window.
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

  const now = (deps.now ?? Date.now)();
  // Written before sending: a crash or an unknown outcome must never lead to a second swap.
  await deps.ledger.set(key, { status: 'submitted', at: now });
  let sent: SendResult;
  try {
    sent = await deps.sender.send({
      owner: balance.owner,
      swapTransaction: swap.swapTransaction,
      ...(swap.lastValidBlockHeight !== undefined
        ? { lastValidBlockHeight: swap.lastValidBlockHeight }
        : {}),
    });
  } catch (err) {
    // The transaction may have reached the network: keep `submitted`.
    return { status: 'failed', error: `send: ${errName(err)}` };
  }
  if (sent.status === 'confirmed') {
    await deps.ledger.set(key, { status: 'confirmed', signature: sent.signature, at: now });
    return { status: 'confirmed', signature: sent.signature, outAmount };
  }
  if (sent.status === 'failed') {
    await deps.ledger.set(key, { status: 'failed', signature: sent.signature, at: now });
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
// Adapters

/** Jupiter aggregator v6 program: every Jupiter swap transaction invokes it. */
export const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/**
 * Checks a Jupiter-provided transaction before it is signed: the API answer is not trusted.
 * The wallet must be the fee payer and the only required signer, and the Jupiter program must
 * be invoked. Returns null when acceptable, otherwise the reason.
 */
export function verifySwapTransaction(
  tx: VersionedTransaction,
  owner: string,
): 'fee_payer_mismatch' | 'extra_signers' | 'jupiter_program_missing' | null {
  const message = tx.message;
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  if (keys[0] !== owner) return 'fee_payer_mismatch';
  if (message.header.numRequiredSignatures !== 1) return 'extra_signers';
  const invoked = message.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
  if (!invoked.includes(JUPITER_PROGRAM_ID)) return 'jupiter_program_missing';
  return null;
}

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
  connection: Pick<Connection, 'sendRawTransaction' | 'getSignatureStatuses' | 'getBlockHeight'>;
  /** Signs in place with the key of `owner` (keystore `withSigner`). */
  signTransaction(owner: string, tx: VersionedTransaction): Promise<void>;
  /** Give up waiting for a status after this long. Default 60 s. */
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Signs and sends a Jupiter swap, then polls `getSignatureStatuses` (no websocket). */
export function createRpcSwapSender(opts: RpcSwapSenderOptions): SwapSender {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.confirmTimeoutMs ?? 60_000;
  const pollMs = opts.pollIntervalMs ?? 2_000;
  return {
    async send({ owner, swapTransaction, lastValidBlockHeight }) {
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      const problem = verifySwapTransaction(tx, owner);
      if (problem) throw new Error(`swap transaction refused: ${problem}`);
      await opts.signTransaction(owner, tx);
      const signature = await opts.connection.sendRawTransaction(tx.serialize(), {
        maxRetries: 3,
      });
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        const { value } = await opts.connection.getSignatureStatuses([signature]);
        const status = value[0];
        if (status) {
          if (status.err) return { status: 'failed', signature, error: JSON.stringify(status.err) };
          if (
            status.confirmationStatus === 'confirmed' ||
            status.confirmationStatus === 'finalized'
          ) {
            return { status: 'confirmed', signature };
          }
        } else if (lastValidBlockHeight !== undefined) {
          const height = await opts.connection.getBlockHeight('confirmed');
          // Past the validity window and still unknown: the transaction can no longer land.
          if (height > lastValidBlockHeight) {
            return { status: 'failed', signature, error: 'blockhash expired' };
          }
        }
        await sleep(pollMs);
      }
      return { status: 'unknown', signature };
    },
  };
}
