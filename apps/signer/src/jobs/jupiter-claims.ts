/**
 * Jupiter referral fee claim job (docs/DECISIONS.md D7 and D8, docs/METEORA.md "The platform
 * fee" after graduation, docs/OPERATIONS.md "Kill switches", @forge/core jupiter-referral.ts).
 *
 * After a coin graduates, trades go through Jupiter and FORGE's Jupiter plugin fee (D7: 50 bps,
 * Jupiter's minimum, FORGE keeps 80%) is collected by the Jupiter referral program into token
 * accounts of FORGE_JUPITER_REFERRAL_ACCOUNT, one per currency. Claiming is permissionless: it
 * moves a collection account's balance to the referral account's partner, the FORGE revenue
 * wallet (FORGE_REVENUE_WALLET, D34), which the revenue job converts to SOL and forwards to the
 * vault for the buyback (D8). Once a day this job claims, for every configured mint
 * (SIGNER_JUPITER_CLAIMS_MINTS, default wrapped SOL and USDC), the collection accounts whose total
 * reaches the mint's threshold. The payer wallet signs: it only pays the network fee and, the
 * first time, the rent of the partner's token account.
 *
 * Mainnet-beta only: the referral program and Jupiter's fee collection live on mainnet-beta. On
 * any other cluster the module is wired off (runtime/modules.ts logs it and registers a job that
 * does nothing), and core refuses to build off mainnet anyway (`wrong_cluster`). It cannot be
 * proved on devnet.
 *
 * Per mint: the journal entry is settled first (one claim in flight at a time: a transaction that
 * may have reached the network is never replaced before it is confirmed, failed or proven
 * expired). Then, under the payer lock (shared with the signing routes and the other payer
 * spenders): kill switch, build with core `buildJupiterReferralClaimTx` (partner asserted = the
 * revenue wallet), threshold, payer balance (minus the lamports reserved by creations in flight), policy
 * (`assertJupiterReferralClaimTx`), kill switch again, signature with the keystore payer, journal
 * (signature + bytes) BEFORE the send, `onBeforeSend`, send. Settlement by polling runs outside
 * the lock.
 *
 * Policy (TX_POLICY before anything is signed), nothing else in the transaction:
 * - fee payer and only required signer = the payer wallet, blockhash set;
 * - the referral program's `claim` / `claim_v2` instructions, at most one of each and every one
 *   core announced, re-built from the pinned inputs (payer, FORGE_JUPITER_REFERRAL_ACCOUNT, the
 *   mint, partner = FORGE_REVENUE_WALLET, the project / admin / authority core read from the
 *   program-owned accounts, the token program) and compared account by account, flag by flag and
 *   byte by byte, the collection accounts re-derived from the IDL seeds;
 * - associated token account idempotent creations funded by the payer, for the partner's or the
 *   project admin's associated account of the mint only, each at most once;
 * - the referral program's `create_admin_token_account` (rent paid by the project authority PDA,
 *   never by the payer), re-built and compared the same way, at most once;
 * - at most two compute budget instructions within the shared bounds.
 * Kill switches: env SIGNER_JUPITER_CLAIMS_PAUSED and the `jupiter_claims_paused` flag, fail
 * closed (missing row or unreadable flags = paused), read before the lock, inside it, and again
 * right before signing.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  type Connection,
  type Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { z } from 'zod';
import {
  JUPITER_CLAIM_DISCRIMINATOR,
  JUPITER_CLAIM_V2_DISCRIMINATOR,
  JUPITER_CREATE_ADMIN_TOKEN_ACCOUNT_DISCRIMINATOR,
  JUPITER_REFERRAL_CLAIM_COMPUTE_UNITS,
  JUPITER_REFERRAL_PROGRAM_ID,
  JupiterReferralError,
  buildJupiterCreateAdminTokenAccountIx,
  buildJupiterReferralClaimIx,
  buildJupiterReferralClaimTx,
  deriveJupiterReferralTokenAccount,
  deriveJupiterReferralTokenAccountV2,
  type BuildJupiterReferralClaimTxParams,
  type JupiterReferralClaimTx,
  type JupiterReferralClaimVersion,
} from '@forge/core';
import type { PriorityFees } from './priority.js';
import type { PayerReservations } from './reservations.js';
import {
  DEFAULT_RETRY,
  DEFAULT_SETTLE,
  JOB_FLAGS,
  JobError,
  alertAbnormalPause,
  awaitSettlement,
  broadcast,
  assertComputeBudgetSet,
  checkComputeBudget,
  checkPaused,
  checkSettlement,
  createAnnouncer,
  createFileJournal,
  describeError,
  formatSol,
  isJobError,
  parseAddress,
  parseBoolEnv,
  parseLamports,
  parsePositiveIntEnv,
  realSleep,
  requireRoleRef,
  requiredSigners,
  sendAlert,
  signWithKeystore,
  withRetry,
  type BeforeSendHook,
  type FlagsReader,
  type JobAlerter,
  type JobLogger,
  type Journal,
  type KeystoreLike,
  type Mutex,
  type RetryOptions,
  type SettleTiming,
  type SolanaRpc,
} from './shared.js';

// ---------------------------------------------------------------------------------------
// Configuration

/** USDC on mainnet-beta: with wrapped SOL, the currency Jupiter mostly collects fees in. */
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export interface JupiterClaimMint {
  mint: PublicKey;
  /** Claim only when the collection accounts of the mint hold at least this (raw units). */
  minAmount: bigint;
}

/** Default list: wrapped SOL from 0.01 SOL and USDC from 1 USDC. */
export const DEFAULT_JUPITER_CLAIM_MINTS: readonly JupiterClaimMint[] = [
  { mint: NATIVE_MINT, minAmount: 10_000_000n },
  { mint: USDC_MINT, minAmount: 1_000_000n },
];
export const DEFAULT_JUPITER_CLAIMS_INTERVAL_HOURS = 24;
export const MAX_JUPITER_CLAIM_MINTS = 20;

/**
 * Core refusals meaning FORGE_JUPITER_REFERRAL_ACCOUNT is not FORGE's referral account at all
 * (its fees go to someone else): alerted at `immediate`. By code name, so the list also covers
 * the codes a newer core adds (project, name and PDA checks of the named Ultra referral account).
 */
export const NOT_OUR_REFERRAL_ACCOUNT_CODES: ReadonlySet<string> = new Set([
  'partner_mismatch',
  'project_mismatch',
  'referral_account_unnamed',
  'referral_account_not_pda',
]);

/**
 * SIGNER_JUPITER_CLAIMS_MINTS: comma-separated `<mint>` or `<mint>:<minimum raw units>`. Wrapped
 * SOL and USDC may omit the threshold (their defaults apply); any other mint needs one. Empty or
 * unset: the default list. Every mint is a canonical address, listed once. Errors never echo a
 * value.
 */
export function parseJupiterClaimMints(
  value: string | undefined,
  name = 'SIGNER_JUPITER_CLAIMS_MINTS',
): JupiterClaimMint[] {
  if (value === undefined || value.trim() === '') return [...DEFAULT_JUPITER_CLAIM_MINTS];
  const fail = (rule: string): never => {
    throw new JobError('CONFIG', `${name} ${rule}`);
  };
  const entries = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) fail('lists no mint');
  if (entries.length > MAX_JUPITER_CLAIM_MINTS) fail(`lists more than ${MAX_JUPITER_CLAIM_MINTS} mints`);
  const out: JupiterClaimMint[] = [];
  for (const entry of entries) {
    const parts = entry.split(':');
    if (parts.length > 2) fail('entries are <mint> or <mint>:<minimum raw units>');
    const mint = parseAddress(parts[0]) ?? fail('holds a value that is not a mint address');
    if (out.some((m) => m.mint.equals(mint))) fail('lists a mint twice');
    let minAmount: bigint;
    if (parts.length === 2) {
      const raw = parts[1]!;
      if (!/^[1-9][0-9]{0,19}$/.test(raw)) fail('thresholds must be positive integers of raw units');
      minAmount = parseLamports(raw);
    } else {
      const known =
        DEFAULT_JUPITER_CLAIM_MINTS.find((m) => m.mint.equals(mint)) ??
        fail('needs a threshold for a mint other than wrapped SOL or USDC');
      minAmount = known.minAmount;
    }
    out.push({ mint, minAmount });
  }
  return out;
}

export interface JupiterClaimsConfig {
  /** FORGE_JUPITER_REFERRAL_ACCOUNT (from `requireAddresses` of @forge/core at startup). */
  referralAccount: PublicKey;
  /** FORGE_REVENUE_WALLET: the referral account's partner, receives every claim. */
  partner: PublicKey;
  mints: readonly JupiterClaimMint[];
  paused?: boolean;
  settle?: Partial<SettleTiming>;
  /** The referral program (default: the mainnet-beta program id). */
  programId?: PublicKey;
}

/**
 * SIGNER_JUPITER_CLAIMS_MINTS (default wrapped SOL and USDC), SIGNER_JUPITER_CLAIMS_INTERVAL_HOURS
 * (default 24), SIGNER_JUPITER_CLAIMS_PAUSED (default false). Addresses come from @forge/core
 * `requireAddresses`. Parsed on every cluster (a bad value is a startup error everywhere).
 */
export function jupiterClaimsConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  addresses: { partner: PublicKey; jupiterReferral: PublicKey },
): { config: JupiterClaimsConfig; intervalMs: number } {
  const config: JupiterClaimsConfig = {
    referralAccount: addresses.jupiterReferral,
    partner: addresses.partner,
    mints: parseJupiterClaimMints(env.SIGNER_JUPITER_CLAIMS_MINTS),
    paused: parseBoolEnv(env.SIGNER_JUPITER_CLAIMS_PAUSED, 'SIGNER_JUPITER_CLAIMS_PAUSED', false),
  };
  assertJupiterClaimsConfig(config);
  return {
    config,
    intervalMs:
      parsePositiveIntEnv(
        env.SIGNER_JUPITER_CLAIMS_INTERVAL_HOURS,
        'SIGNER_JUPITER_CLAIMS_INTERVAL_HOURS',
        DEFAULT_JUPITER_CLAIMS_INTERVAL_HOURS,
      ) *
      60 *
      60_000,
  };
}

/** The referral account, the partner and the mints are distinct accounts; at least one mint. */
export function assertJupiterClaimsConfig(config: JupiterClaimsConfig): void {
  if (config.referralAccount.equals(config.partner)) {
    throw new JobError('CONFIG', 'the Jupiter referral account and the partner must differ');
  }
  if (config.mints.length === 0) throw new JobError('CONFIG', 'no mint to claim');
  for (const { mint, minAmount } of config.mints) {
    if (mint.equals(config.referralAccount) || mint.equals(config.partner)) {
      throw new JobError('CONFIG', 'a claimed mint is the referral account or the partner');
    }
    if (minAmount <= 0n) throw new JobError('CONFIG', 'a claim threshold must be positive');
  }
}

// ---------------------------------------------------------------------------------------
// Policy (pure)

export interface JupiterClaimExpectation {
  /** The referral program (default: the mainnet-beta program id). */
  programId?: PublicKey;
  /** The payer wallet: fee payer and only signer. */
  payer: PublicKey;
  /** FORGE_JUPITER_REFERRAL_ACCOUNT. */
  referralAccount: PublicKey;
  /** FORGE_REVENUE_WALLET, the referral account's partner. */
  partner: PublicKey;
  /** From the program-owned referral and project accounts core read. */
  project: PublicKey;
  admin: PublicKey;
  projectAuthority: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  /** The collection accounts the transaction must claim (one per version, each at most once). */
  claims: readonly JupiterReferralClaimVersion[];
}

function policy(rule: string): never {
  throw new JobError('TX_POLICY', rule);
}

/** Same program, same data, same accounts with the same flags, in the same order. */
function sameInstruction(actual: TransactionInstruction, want: TransactionInstruction): boolean {
  if (!actual.programId.equals(want.programId)) return false;
  if (!Buffer.from(actual.data).equals(Buffer.from(want.data))) return false;
  if (actual.keys.length !== want.keys.length) return false;
  return actual.keys.every((k, i) => {
    const w = want.keys[i]!;
    return k.pubkey.equals(w.pubkey) && k.isSigner === w.isSigner && k.isWritable === w.isWritable;
  });
}

/**
 * Referral claim policy (see the module header). Every allowed instruction is re-built from the
 * expectation with the pure core builders (pinned to the IDL by core's tests) and the transaction
 * must match it exactly: a transaction whose accounts, flags or data differ in any way is refused.
 */
export function assertJupiterReferralClaimTx(
  tx: Transaction,
  expected: JupiterClaimExpectation,
): void {
  const programId = expected.programId ?? JUPITER_REFERRAL_PROGRAM_ID;
  const { payer, partner, mint, tokenProgram } = expected;
  if (expected.claims.length === 0) policy('nothing to claim');
  if (new Set(expected.claims).size !== expected.claims.length) policy('duplicate expected claim');
  if (payer.equals(partner) || payer.equals(expected.referralAccount)) {
    policy('payer must differ from the partner and the referral account');
  }
  if (partner.equals(expected.referralAccount)) policy('partner equals the referral account');
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    policy('not a token program');
  }
  if (!tx.feePayer?.equals(payer)) policy('unexpected fee payer');
  if (!tx.recentBlockhash) policy('missing recent blockhash');
  for (const s of requiredSigners(tx)) {
    if (!s.equals(payer)) policy('unexpected required signer');
  }
  if (tx.instructions.length === 0) policy('empty transaction');

  const partnerTokenAccount = getAssociatedTokenAddressSync(mint, partner, true, tokenProgram);
  const adminTokenAccount = getAssociatedTokenAddressSync(mint, expected.admin, true, tokenProgram);
  const wantClaim = (version: JupiterReferralClaimVersion) =>
    buildJupiterReferralClaimIx(
      {
        payer,
        project: expected.project,
        admin: expected.admin,
        projectAdminTokenAccount: adminTokenAccount,
        referralAccount: expected.referralAccount,
        referralTokenAccount:
          version === 'v1'
            ? deriveJupiterReferralTokenAccount(expected.referralAccount, mint, programId)
            : deriveJupiterReferralTokenAccountV2(expected.referralAccount, mint, tokenProgram),
        partner,
        partnerTokenAccount,
        mint,
        tokenProgram,
      },
      version,
      programId,
    );
  const wantPartnerAta = createAssociatedTokenAccountIdempotentInstruction(
    payer,
    partnerTokenAccount,
    partner,
    mint,
    tokenProgram,
  );
  const wantAdminAta = createAssociatedTokenAccountIdempotentInstruction(
    payer,
    adminTokenAccount,
    expected.admin,
    mint,
    tokenProgram,
  );
  const wantAdminCreate = buildJupiterCreateAdminTokenAccountIx(
    {
      project: expected.project,
      projectAuthority: expected.projectAuthority,
      admin: expected.admin,
      projectAdminTokenAccount: adminTokenAccount,
      mint,
      tokenProgram,
    },
    programId,
  );

  const seen = new Set<JupiterReferralClaimVersion>();
  let partnerCreations = 0;
  let adminCreations = 0;
  let computeBudget = 0;
  for (const ix of tx.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      checkComputeBudget(ix);
      if (++computeBudget > 2) policy('too many compute budget instructions');
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (sameInstruction(ix, wantPartnerAta)) {
        if (++partnerCreations > 1) policy('duplicate partner token account creation');
      } else if (sameInstruction(ix, wantAdminAta)) {
        if (++adminCreations > 1) policy('duplicate admin token account creation');
      } else {
        policy('associated token instruction other than the expected idempotent creations');
      }
    } else if (ix.programId.equals(programId)) {
      const data = Buffer.from(ix.data);
      if (data.equals(JUPITER_CLAIM_DISCRIMINATOR) || data.equals(JUPITER_CLAIM_V2_DISCRIMINATOR)) {
        const version: JupiterReferralClaimVersion = data.equals(JUPITER_CLAIM_DISCRIMINATOR)
          ? 'v1'
          : 'v2';
        if (!expected.claims.includes(version)) policy(`unexpected ${version} claim`);
        if (seen.has(version)) policy(`duplicate ${version} claim`);
        if (!sameInstruction(ix, wantClaim(version))) policy(`unexpected ${version} claim accounts`);
        seen.add(version);
      } else if (data.equals(JUPITER_CREATE_ADMIN_TOKEN_ACCOUNT_DISCRIMINATOR)) {
        if (!sameInstruction(ix, wantAdminCreate)) {
          policy('unexpected admin token account creation accounts');
        }
        if (++adminCreations > 1) policy('duplicate admin token account creation');
      } else {
        policy('referral program instruction other than a claim');
      }
    } else {
      policy('program not allowed in a referral claim');
    }
  }
  for (const version of expected.claims) {
    if (!seen.has(version)) policy(`${version} claim missing`);
  }
  assertComputeBudgetSet(tx.instructions);
}

// ---------------------------------------------------------------------------------------
// Journal

const amountString = z.string().regex(/^(0|[1-9][0-9]{0,38})$/);
const claimVersion = z.enum(['v1', 'v2']);

/** One entry per mint (key = the mint address), written before any send. */
export const JupiterClaimJournalEntry = z.object({
  v: z.literal(1),
  mint: z.string(),
  inFlight: z
    .object({
      signature: z.string(),
      rawTx: z.string(),
      lastValidBlockHeight: z.number().int().nonnegative(),
      amount: amountString,
      versions: z.array(claimVersion),
      startedAt: z.string(),
    })
    .nullable(),
  lastClaim: z.object({ signature: z.string(), amount: amountString, at: z.string() }).nullable(),
  lastError: z.string().max(300).nullable(),
});
export type JupiterClaimJournalEntry = z.infer<typeof JupiterClaimJournalEntry>;

export function createJupiterClaimsJournal(dir: string): Journal<JupiterClaimJournalEntry> {
  return createFileJournal({ dir, namespace: 'jupiter-claims', schema: JupiterClaimJournalEntry });
}

// ---------------------------------------------------------------------------------------
// Job

/** The reads core needs to build a claim (the genesis hash, the accounts, a blockhash). */
export type JupiterClaimConnection = Pick<
  Connection,
  'getGenesisHash' | 'getMultipleAccountsInfo' | 'getAccountInfo' | 'getLatestBlockhash'
>;

/** Core's builder (`buildJupiterReferralClaimTx`); injectable for the policy tests. */
export type JupiterClaimBuilder = (
  params: BuildJupiterReferralClaimTxParams,
) => Promise<JupiterReferralClaimTx>;

export const TOKEN_ACCOUNT_SIZE = 165;
/** Kept on the payer on top of the partner token account rent, for the claim's own fees. */
export const JUPITER_CLAIM_FEE_BUFFER_LAMPORTS = 20_000n;

export interface JupiterClaimsDeps {
  connection: JupiterClaimConnection;
  rpc: SolanaRpc;
  keystore: KeystoreLike;
  journal: Journal<JupiterClaimJournalEntry>;
  flags: FlagsReader;
  alerter: JobAlerter;
  logger: JobLogger;
  config: JupiterClaimsConfig;
  retry?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called with each signature right before it is (re)broadcast by this process. Required. */
  onBeforeSend: BeforeSendHook;
  /** Lock of the payer wallet, shared with the signing routes and the other payer spenders. Required. */
  payerLock: Mutex;
  /** Payer lamports reserved by the routes' creations in flight (subtracted from its balance). */
  payerReservations?: PayerReservations;
  /** Default: core's `buildJupiterReferralClaimTx`. */
  builder?: JupiterClaimBuilder;
  /**
   * Priority fee of the claims (SIGNER_PRIORITY_FEE_*, jobs/priority.ts): core prices them, the
   * payer keeps their cap on top of the fee buffer. Default: none.
   */
  priorityFees?: PriorityFees;
}

export type JupiterClaimOutcome = { mint: string } & (
  | { result: 'claimed'; signature: string; amount: bigint }
  | { result: 'nothing_to_claim' }
  | { result: 'below_threshold'; amount: bigint; minAmount: bigint }
  | { result: 'in_flight'; signature: string; state: string }
  | { result: 'expired'; signature: string }
  | { result: 'failed'; signature?: string; error: string }
  | { result: 'skipped'; reason: string }
);

export interface JupiterClaimsRunReport {
  status: 'ran' | 'paused' | 'busy' | 'error';
  reason?: string;
  outcomes: JupiterClaimOutcome[];
}

export interface JupiterClaimsJob {
  runOnce(): Promise<JupiterClaimsRunReport>;
}

export function createJupiterClaimsJob(deps: JupiterClaimsDeps): JupiterClaimsJob {
  const { connection, rpc, keystore, journal, alerter, logger: log, config } = deps;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const settleTiming = { ...DEFAULT_SETTLE, ...config.settle };
  const programId = config.programId ?? JUPITER_REFERRAL_PROGRAM_ID;
  const build = deps.builder ?? buildJupiterReferralClaimTx;
  let running = false;

  assertJupiterClaimsConfig(config);
  if (!deps.payerLock || typeof deps.payerLock.runExclusive !== 'function') {
    throw new JobError('CONFIG', 'payerLock is required (shared with the signing routes)');
  }

  const iso = () => new Date(now()).toISOString();
  const alert = (
    level: 'immediate' | 'high' | 'normal',
    code: string,
    message: string,
    details: Record<string, unknown>,
    dedupKey?: string,
  ) => sendAlert(alerter, log, level, code, message, details, dedupKey);
  const announce = createAnnouncer(deps.onBeforeSend, log);
  const empty = (mint: string): JupiterClaimJournalEntry => ({
    v: 1,
    mint,
    inFlight: null,
    lastClaim: null,
    lastError: null,
  });

  /** Kill switches (env, flag; fail closed). Null when the job may go on. */
  async function pausedReport(): Promise<JupiterClaimsRunReport | null> {
    const pause = await checkPaused(deps.flags, JOB_FLAGS.jupiterClaims, config.paused, log);
    if (!pause.paused) return null;
    log.info({ reason: pause.reason }, 'jupiter referral claims paused');
    await alertAbnormalPause(alerter, log, 'jupiter_claims', JOB_FLAGS.jupiterClaims, pause.reason);
    return { status: 'paused', reason: pause.reason, outcomes: [] };
  }

  /** Settles the claim in flight of a mint. Returns an outcome when the mint stops there. */
  async function settleInFlight(
    entry: JupiterClaimJournalEntry,
    wait: boolean,
  ): Promise<{ entry: JupiterClaimJournalEntry; outcome?: JupiterClaimOutcome }> {
    const inFlight = entry.inFlight;
    if (!inFlight) return { entry };
    const mint = entry.mint;
    const raw = Buffer.from(inFlight.rawTx, 'base64');
    const s = wait
      ? await awaitSettlement(rpc, inFlight.signature, {
          lastValidBlockHeight: inFlight.lastValidBlockHeight,
          raw,
          until: 'confirmed',
          ...settleTiming,
          retry,
          sleep,
          now,
          logger: log,
        })
      : await checkSettlement(rpc, inFlight.signature, inFlight.lastValidBlockHeight, retry);
    if (s.kind === 'confirmed' || s.kind === 'finalized') {
      const next: JupiterClaimJournalEntry = {
        ...entry,
        inFlight: null,
        lastClaim: { signature: inFlight.signature, amount: inFlight.amount, at: iso() },
        lastError: null,
      };
      await journal.put(mint, next);
      log.info(
        { mint, signature: inFlight.signature, amount: inFlight.amount, versions: inFlight.versions },
        'jupiter referral fees claimed to the partner (revenue wallet)',
      );
      return {
        entry: next,
        outcome: {
          mint,
          result: 'claimed',
          signature: inFlight.signature,
          amount: BigInt(inFlight.amount),
        },
      };
    }
    if (s.kind === 'failed') {
      const next: JupiterClaimJournalEntry = {
        ...entry,
        inFlight: null,
        lastError: s.error.slice(0, 300),
      };
      await journal.put(mint, next);
      await alert(
        'high',
        'jupiter_claim_failed',
        'A Jupiter referral claim failed on-chain (nothing was moved)',
        { mint, signature: inFlight.signature, error: s.error },
        `jupiter_claim_failed:${mint}`,
      );
      return {
        entry: next,
        outcome: { mint, result: 'failed', signature: inFlight.signature, error: s.error },
      };
    }
    if (s.kind === 'expired') {
      const next: JupiterClaimJournalEntry = { ...entry, inFlight: null };
      await journal.put(mint, next);
      log.warn({ mint, signature: inFlight.signature }, 'jupiter referral claim expired unsent');
      return {
        entry: next,
        ...(wait ? { outcome: { mint, result: 'expired', signature: inFlight.signature } } : {}),
      };
    }
    if (!wait && s.kind === 'pending' && announce(inFlight.signature)) {
      try {
        await rpc.sendRawTransaction(raw);
      } catch (err) {
        log.debug({ err: describeError(err) }, 'jupiter referral claim rebroadcast failed');
      }
    }
    return { entry, outcome: { mint, result: 'in_flight', signature: inFlight.signature, state: s.kind } };
  }

  /** One mint: settle, then build / check / sign / journal / send under the payer lock, settle. */
  async function claimMint(
    target: JupiterClaimMint,
    payer: { ref: string; publicKey: PublicKey },
  ): Promise<JupiterClaimOutcome> {
    const mint = target.mint.toBase58();
    let entry = (await journal.get(mint)) ?? empty(mint);
    if (entry.inFlight) {
      const settled = await settleInFlight(entry, false);
      entry = settled.entry;
      if (settled.outcome) return settled.outcome;
    }

    const step = await deps.payerLock.runExclusive(
      async (): Promise<{ outcome: JupiterClaimOutcome } | { entry: JupiterClaimJournalEntry }> => {
        // The switch may have been turned on while this run waited for the payer lock.
        const pausedInLock = await pausedReport();
        if (pausedInLock) return { outcome: { mint, result: 'skipped', reason: 'paused' } };

        let built: JupiterReferralClaimTx;
        try {
          built = await build({
            // The job only needs the reads core makes; the real connection has them all.
            connection: connection as Connection,
            referralAccount: config.referralAccount,
            mint: target.mint,
            payer: payer.publicKey,
            expectedPartner: config.partner,
            commitment: 'confirmed',
            retry: { attempts: retry.attempts, baseDelayMs: retry.baseDelayMs },
            programId,
            ...(deps.priorityFees?.setting ? { priority: deps.priorityFees.setting } : {}),
          });
        } catch (err) {
          if (!(err instanceof JupiterReferralError)) throw err;
          // The referral account is not ours (partner, project, name, address), or not on mainnet.
          const notOurs = NOT_OUR_REFERRAL_ACCOUNT_CODES.has(err.code);
          await alert(
            notOurs ? 'immediate' : 'high',
            'jupiter_claim_build_refused',
            notOurs
              ? 'The Jupiter referral account is NOT the FORGE one (partner, project or name): its fees go elsewhere, check FORGE_JUPITER_REFERRAL_ACCOUNT'
              : 'Core refused to build the Jupiter referral claim',
            { mint, code: err.code, error: describeError(err).message },
            `jupiter_claim_build_refused:${mint}:${err.code}`,
          );
          return { outcome: { mint, result: 'failed', error: err.code } };
        }
        const summary = built.summary;
        const amount = summary.claims.reduce((total, c) => total + c.amount, 0n);
        if (!built.transaction || built.lastValidBlockHeight === null || amount === 0n) {
          return { outcome: { mint, result: 'nothing_to_claim' } };
        }
        if (amount < target.minAmount) {
          return { outcome: { mint, result: 'below_threshold', amount, minAmount: target.minAmount } };
        }
        if (
          !summary.referralAccount.equals(config.referralAccount) ||
          !summary.partner.equals(config.partner) ||
          !summary.mint.equals(target.mint)
        ) {
          throw new JobError('TX_POLICY', 'claim summary does not match the request');
        }

        // The payer pays the fee and, the first time, the partner token account rent.
        const tokenRent = summary.createsPartnerTokenAccount
          ? await withRetry(() => rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE), retry)
          : 0n;
        const needed =
          tokenRent +
          JUPITER_CLAIM_FEE_BUFFER_LAMPORTS +
          (deps.priorityFees?.maxFeeLamports(JUPITER_REFERRAL_CLAIM_COMPUTE_UNITS) ?? 0n);
        const balance = await withRetry(() => rpc.getBalance(payer.publicKey, 'confirmed'), retry);
        const reserved = deps.payerReservations
          ? await deps.payerReservations.outstanding(rpc, retry)
          : 0n;
        const available = balance > reserved ? balance - reserved : 0n;
        if (available < needed) {
          await alert(
            'high',
            'jupiter_claim_payer_low_balance',
            'The payer wallet is too low to pay a Jupiter referral claim: fund it',
            {
              address: payer.publicKey.toBase58(),
              balance: formatSol(balance),
              reservedInFlight: formatSol(reserved),
              needed: formatSol(needed),
            },
            'jupiter_claim_payer_low_balance',
          );
          return { outcome: { mint, result: 'skipped', reason: 'payer_low_balance' } };
        }

        assertJupiterReferralClaimTx(built.transaction, {
          programId,
          payer: payer.publicKey,
          referralAccount: config.referralAccount,
          partner: config.partner,
          project: summary.project,
          admin: summary.admin,
          projectAuthority: summary.projectAuthority,
          mint: target.mint,
          tokenProgram: summary.tokenProgram,
          claims: summary.claims.map((c) => c.version),
        });
        // The kill switch may have been turned on since the run started: re-read it before signing.
        const pausedBeforeSigning = await pausedReport();
        if (pausedBeforeSigning) return { outcome: { mint, result: 'skipped', reason: 'paused' } };
        const { raw, signature } = await signWithKeystore(keystore, built.transaction, [
          { ref: payer.ref, expected: payer.publicKey },
        ]);
        entry = {
          ...entry,
          inFlight: {
            signature,
            rawTx: raw.toString('base64'),
            lastValidBlockHeight: built.lastValidBlockHeight,
            amount: amount.toString(),
            versions: summary.claims.map((c) => c.version),
            startedAt: iso(),
          },
        };
        await journal.put(mint, entry);

        if (!announce(signature)) {
          return { outcome: { mint, result: 'in_flight', signature, state: 'not_announced' } };
        }
        const sent = await broadcast(rpc, raw, retry);
        if (sent.status === 'rejected') {
          // The entry stays in flight: an earlier attempt may have reached the network, the next
          // run settles it (confirmed, or proven expired, then a new claim is built).
          entry = { ...entry, lastError: sent.reason.slice(0, 300) };
          await journal.put(mint, entry);
          await alert(
            'high',
            'jupiter_claim_rejected',
            'The RPC rejected a Jupiter referral claim (simulation failed)',
            { mint, signature, reason: sent.reason },
            `jupiter_claim_rejected:${mint}`,
          );
          return { outcome: { mint, result: 'failed', signature, error: sent.reason } };
        }
        log.info(
          { mint, signature, amount: amount.toString(), versions: entry.inFlight?.versions },
          'jupiter referral claim sent',
        );
        return { entry };
      },
    );
    if ('outcome' in step) return step.outcome;

    // Confirmation by polling, outside the payer lock.
    const settled = await settleInFlight(step.entry, true);
    if (settled.outcome) return settled.outcome;
    return { mint, result: 'expired', signature: step.entry.inFlight?.signature ?? '' };
  }

  return {
    async runOnce() {
      if (running) return { status: 'busy', outcomes: [] };
      running = true;
      try {
        // Read before waiting on the lock (no wait when paused), then again inside it.
        const paused = await pausedReport();
        if (paused) return paused;
        let payer: { ref: string; publicKey: PublicKey };
        try {
          payer = await requireRoleRef(keystore, 'payer');
          if (payer.publicKey.equals(config.partner) || payer.publicKey.equals(config.referralAccount)) {
            throw new JobError('CONFIG', 'the payer wallet must differ from the partner and the referral account');
          }
        } catch (err) {
          await alert(
            'high',
            'jupiter_claim_payer_key',
            'Jupiter referral claims stopped: payer key problem',
            { error: describeError(err).message },
            'jupiter_claim_payer_key',
          );
          return { status: 'error', reason: 'payer_key', outcomes: [] };
        }

        const outcomes: JupiterClaimOutcome[] = [];
        let errors = 0;
        for (const target of config.mints) {
          const mint = target.mint.toBase58();
          try {
            outcomes.push(await claimMint(target, payer));
          } catch (err) {
            errors++;
            const summary = describeError(err);
            const policyViolation = isJobError(err, 'TX_POLICY') || isJobError(err, 'SIGNER_MISMATCH');
            log.error({ mint, err: summary }, 'jupiter referral claim failed');
            await alert(
              'high',
              policyViolation ? 'jupiter_claim_policy_violation' : 'jupiter_claim_run_failed',
              policyViolation
                ? 'A Jupiter referral claim transaction was refused before signing (policy check)'
                : 'A Jupiter referral claim run failed (RPC unavailable?)',
              { mint, error: summary.message },
              `${policyViolation ? 'jupiter_claim_policy_violation' : 'jupiter_claim_run_failed'}:${mint}`,
            );
            outcomes.push({ mint, result: 'failed', error: summary.message });
          }
        }
        return { status: errors > 0 ? 'error' : 'ran', outcomes };
      } finally {
        running = false;
      }
    },
  };
}
