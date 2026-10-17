/**
 * One-off setup of the revenue wallet's referral accounts (operator command
 * `tsx src/index.ts --setup-revenue-referrals`; docs/MAINNET.md section 5, docs/DECISIONS.md
 * D34, docs/METEORA.md). The two accounts the revenue wallet must hold:
 *
 * - the Meteora referral account (`FORGE_METEORA_REFERRAL_ACCOUNT`): a STANDALONE wrapped-SOL
 *   token account owned by the revenue wallet, never its associated account (the Jupiter claims
 *   land there and would be booked as Meteora referral). Built by core
 *   (`buildCreateMeteoraReferralAccountTx`) at `createWithSeed(payer, seed, SPL Token)`: no
 *   keypair to generate or keep, the address is re-derived at every run. Any cluster: the devnet
 *   proof of the revenue job uses one.
 * - the Jupiter referral account (`FORGE_JUPITER_REFERRAL_ACCOUNT`): a NAMED referral account of
 *   Jupiter's Ultra project with the revenue wallet as partner (the PDA `["referral", project,
 *   name]`, the only kind `claim_v2` accepts) and its v2 collection accounts for wrapped SOL and
 *   USDC (core `buildJupiterReferralSetupTx`). Mainnet-beta only: the program and the project
 *   exist nowhere else (`wrong_cluster`, nothing read, nothing sent).
 *
 * Who signs: the keystore PAYER wallet, alone, for both parts. The referral program takes the
 * partner as a plain account (no partner signature) and SPL Token `InitializeAccount3` takes the
 * owner from the instruction data, so the revenue key never signs its own setup. The payer is the
 * established fee and rent payer of every account the signer creates (configs, nonce accounts,
 * the Jupiter claims' token accounts); the revenue wallet's native outflows are watched with the
 * vault as the only allowed destination, and its reserve is sized for the unwrap only: paying a
 * rent from it would raise `revenue_unexpected_outflow` and starve the revenue job.
 *
 * Idempotent and fail-closed: the chain is read first (core's inspections); an account that
 * exists and matches (owner, mint, standalone; partner, project, name) is skipped, an account
 * that exists and does NOT match refuses the whole part with its reason and sends nothing. The
 * configured addresses (`FORGE_METEORA_REFERRAL_ACCOUNT`, `FORGE_JUPITER_REFERRAL_ACCOUNT`),
 * when set, are checked against what the command derives: a different address is a refusal,
 * never a second account. Dry run by default (the plan, the costs and the resulting env lines);
 * `--send` sends. Each transaction is checked against a strict policy before the payer signs it
 * (`assertMeteoraReferralSetupTx`, `assertJupiterReferralSetupTx`: exact programs, instructions
 * and accounts, bounded compute budget), journaled (`referral-setup.<part>`) and announced to
 * the outflow watcher BEFORE its first broadcast, then settled by polling; a transaction in
 * flight from a previous run is settled before anything else. Only public addresses and
 * signatures are printed and journaled.
 */
import {
  ACCOUNT_SIZE,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  type Connection,
  type Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { z } from 'zod';
import {
  JUPITER_REFERRAL_ACCOUNT_SIZE,
  JUPITER_REFERRAL_PROGRAM_ID,
  JUPITER_REFERRAL_SETUP_COMPUTE_UNITS,
  JUPITER_ULTRA_REFERRAL_PROJECT,
  JupiterReferralError,
  METEORA_REFERRAL_ACCOUNT_SEED,
  METEORA_REFERRAL_SETUP_COMPUTE_UNITS,
  MeteoraReferralError,
  TOKEN_INITIALIZE_ACCOUNT3_TAG,
  assertJupiterReferralName,
  assertMeteoraReferralSeed,
  buildCreateMeteoraReferralAccountIxs,
  buildCreateMeteoraReferralAccountTx,
  buildJupiterInitializeReferralAccountWithNameIx,
  buildJupiterReferralSetupTx,
  buildJupiterReferralTokenAccountV2Ix,
  decodeJupiterReferralAccount,
  deriveJupiterReferralAccount,
  deriveMeteoraReferralAccount,
  readJupiterReferralSetup,
  readMeteoraReferralAccount,
  type JupiterReferralSetupState,
  type JupiterReferralSetupTokenAccount,
  type MeteoraReferralAccountStatus,
} from '@forge/core';
import { USDC_MINT } from './jupiter-claims.js';
import { NO_PRIORITY_FEES, type PriorityFees } from './priority.js';
import {
  DEFAULT_RETRY,
  DEFAULT_SETTLE,
  JobError,
  assertSignerBudgetPair,
  awaitSettlement,
  broadcast,
  checkSettlement,
  createAnnouncer,
  describeError,
  formatSol,
  realSleep,
  requiredSigners,
  signWithKeystore,
  spendableBalance,
  withRetry,
  type BeforeSendHook,
  type Journal,
  type JobLogger,
  type KeystoreLike,
  type RetryOptions,
  type SettleTiming,
  type Settlement,
  type SolanaRpc,
} from './shared.js';

// ---------------------------------------------------------------------------------------
// Constants and journal

/** Journal namespace: `referral-setup.meteora.json`, `referral-setup.jupiter.json`. */
export const REFERRAL_SETUP_JOURNAL_NAMESPACE = 'referral-setup';

/** Default name of the Jupiter referral account (`--name`). */
export const DEFAULT_JUPITER_REFERRAL_NAME = 'forge';

/** Payer lamports kept on top of the rents, the signature fee and the priority fee cap. */
export const REFERRAL_SETUP_FEE_BUFFER_LAMPORTS = 10_000n;

/** Network fee of one signature. */
const SIGNATURE_FEE_LAMPORTS = 5_000n;

/** Failed or expired transactions tolerated per part before manual handling. */
export const MAX_REFERRAL_SETUP_ATTEMPTS = 3;

export type ReferralSetupPart = 'meteora' | 'jupiter';

export const ReferralSetupAttempt = z.object({
  signature: z.string(),
  outcome: z.enum(['failed', 'expired']),
  error: z.string().nullable(),
  at: z.string(),
});

export const ReferralSetupEntry = z.object({
  v: z.literal(1),
  part: z.enum(['meteora', 'jupiter']),
  cluster: z.enum(['devnet', 'mainnet-beta']),
  /** The account the part sets up (public address). */
  account: z.string(),
  /** Public addresses the transaction creates. */
  creates: z.array(z.string()),
  /** `failed` / `expired`: the last attempt did not land (kept in `history` too); rebuilt next run. */
  status: z.enum(['in_flight', 'confirmed', 'failed', 'expired']),
  signature: z.string(),
  /** Signed bytes, base64: re-sent byte for byte while the signature is unknown. */
  rawTx: z.string(),
  lastValidBlockHeight: z.number().int().nonnegative(),
  recordedAt: z.string(),
  confirmedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Previous attempts of this part (newest last), bounded. */
  history: z.array(ReferralSetupAttempt),
});
export type ReferralSetupEntry = z.infer<typeof ReferralSetupEntry>;

// ---------------------------------------------------------------------------------------
// Policies (TX_POLICY before anything is signed)

function policy(rule: string): never {
  throw new JobError('TX_POLICY', rule);
}

function sameInstruction(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
): boolean {
  if (!actual.programId.equals(expected.programId)) return false;
  if (!Buffer.from(actual.data).equals(Buffer.from(expected.data))) return false;
  if (actual.keys.length !== expected.keys.length) return false;
  return actual.keys.every((k, i) => {
    const e = expected.keys[i]!;
    return k.pubkey.equals(e.pubkey) && k.isSigner === e.isSigner && k.isWritable === e.isWritable;
  });
}

function assertPayerOnly(tx: Transaction, payer: PublicKey): void {
  if (!tx.feePayer?.equals(payer)) policy('unexpected fee payer');
  if (!tx.recentBlockhash) policy('missing recent blockhash');
  const signers = requiredSigners(tx);
  if (signers.length !== 1 || !signers[0]!.equals(payer)) {
    policy('the payer must be the only required signer');
  }
}

export interface MeteoraReferralSetupExpectation {
  payer: PublicKey;
  /** The revenue wallet. */
  owner: PublicKey;
  /** `deriveMeteoraReferralAccount(payer, seed)`. */
  account: PublicKey;
  seed: string;
  rentLamports: bigint;
  /** Cap of the priority fee the transaction was priced with (default: the signer's hard cap). */
  maxPriorityFeeLamports?: bigint;
}

/**
 * Meteora referral setup policy: fee payer and only signer = the payer; in order: the optional
 * bounded compute budget pair, exactly one System `createAccountWithSeed` (from = base = payer,
 * the expected account, the rent, 165 bytes, SPL Token owned) and exactly one SPL Token
 * `InitializeAccount3` of that account with the wrapped SOL mint and the revenue wallet as
 * owner, both byte for byte what core builds; nothing else.
 */
export function assertMeteoraReferralSetupTx(
  tx: Transaction,
  e: MeteoraReferralSetupExpectation,
): void {
  assertPayerOnly(tx, e.payer);
  if (e.owner.equals(e.payer)) policy('the owner must not be the payer');
  if (e.account.equals(e.owner) || e.account.equals(e.payer)) policy('unexpected account');
  const expected = buildCreateMeteoraReferralAccountIxs({
    payer: e.payer,
    owner: e.owner,
    seed: e.seed,
    rentLamports: e.rentLamports,
  });
  if (!expected.account.equals(e.account)) policy('account is not the derived address');
  const skip = assertSignerBudgetPair(tx.instructions, e.maxPriorityFeeLamports);
  const rest = tx.instructions.slice(skip);
  if (rest.length !== 2) policy('expected createAccountWithSeed then InitializeAccount3');
  const [create, initialize] = rest as [TransactionInstruction, TransactionInstruction];
  if (!create.programId.equals(SystemProgram.programId)) policy('first instruction is not System');
  let type: string;
  try {
    type = SystemInstruction.decodeInstructionType(create);
  } catch {
    policy('undecodable system instruction');
  }
  if (type !== 'CreateWithSeed') policy('system instruction other than createAccountWithSeed');
  const c = SystemInstruction.decodeCreateWithSeed(create);
  if (!c.fromPubkey.equals(e.payer) || !c.basePubkey.equals(e.payer)) {
    policy('account not funded and derived by the payer');
  }
  if (!c.newAccountPubkey.equals(e.account)) policy('unexpected new account');
  if (c.seed !== e.seed) policy('seed mismatch');
  if (BigInt(c.lamports) !== e.rentLamports) policy('rent amount mismatch');
  if (c.space !== ACCOUNT_SIZE) policy('unexpected account size');
  if (!c.programId.equals(TOKEN_PROGRAM_ID)) policy('account not owned by the SPL Token program');
  if (!sameInstruction(create, expected.instructions[0]!)) policy('createAccountWithSeed mismatch');
  if (!initialize.programId.equals(TOKEN_PROGRAM_ID)) policy('second instruction is not SPL Token');
  const data = Buffer.from(initialize.data);
  if (data.length !== 33 || data[0] !== TOKEN_INITIALIZE_ACCOUNT3_TAG) {
    policy('expected InitializeAccount3');
  }
  if (!new PublicKey(data.subarray(1)).equals(e.owner)) policy('token account owner mismatch');
  if (!initialize.keys[0]?.pubkey.equals(e.account)) policy('initialize of an unexpected account');
  if (!initialize.keys[1]?.pubkey.equals(NATIVE_MINT))
    policy('token account mint is not wrapped SOL');
  if (!sameInstruction(initialize, expected.instructions[1]!))
    policy('InitializeAccount3 mismatch');
}

export interface JupiterReferralSetupExpectation {
  payer: PublicKey;
  /** The revenue wallet. */
  partner: PublicKey;
  project: PublicKey;
  name: string;
  /** `deriveJupiterReferralAccount(project, name)`. */
  referralAccount: PublicKey;
  createReferralAccount: boolean;
  /** The v2 collection accounts the transaction creates, in order. */
  tokenAccounts: readonly JupiterReferralSetupTokenAccount[];
  programId?: PublicKey;
  maxPriorityFeeLamports?: bigint;
}

/**
 * Jupiter referral setup policy: fee payer and only signer = the payer (the partner never
 * signs and stays read-only); in order: the optional bounded compute budget pair, exactly one
 * `initialize_referral_account_with_name` when expected (re-built from the pinned payer,
 * partner, project, name and PDA and compared account by account, flag by flag, byte by byte),
 * then exactly one idempotent associated token account creation per expected collection account
 * (funded by the payer, owned by the referral account, of the expected mint and token program),
 * re-built and compared the same way; nothing else, no other program.
 */
export function assertJupiterReferralSetupTx(
  tx: Transaction,
  e: JupiterReferralSetupExpectation,
): void {
  const programId = e.programId ?? JUPITER_REFERRAL_PROGRAM_ID;
  assertPayerOnly(tx, e.payer);
  if (e.partner.equals(e.payer)) policy('the partner must not be the payer');
  if (e.referralAccount.equals(e.payer) || e.referralAccount.equals(e.partner)) {
    policy('unexpected referral account');
  }
  if (!e.createReferralAccount && e.tokenAccounts.length === 0) policy('nothing to set up');
  let pda: PublicKey;
  try {
    pda = deriveJupiterReferralAccount(e.project, e.name, programId);
  } catch {
    policy('referral account name is not a valid seed');
  }
  if (!pda.equals(e.referralAccount)) policy('referral account is not the PDA of the name');
  const message = tx.compileMessage();
  const partnerIndex = message.accountKeys.findIndex((k) => k.equals(e.partner));
  if (partnerIndex >= 0 && message.isAccountWritable(partnerIndex)) {
    policy('the partner must be read-only');
  }
  const expected: TransactionInstruction[] = [];
  if (e.createReferralAccount) {
    expected.push(
      buildJupiterInitializeReferralAccountWithNameIx(
        {
          payer: e.payer,
          partner: e.partner,
          project: e.project,
          referralAccount: e.referralAccount,
        },
        e.name,
        programId,
      ),
    );
  }
  const seen = new Set<string>();
  for (const t of e.tokenAccounts) {
    if (seen.has(t.mint.toBase58())) policy('duplicate collection account');
    seen.add(t.mint.toBase58());
    if (!t.tokenProgram.equals(TOKEN_PROGRAM_ID) && !t.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      policy('not a token program');
    }
    const built = buildJupiterReferralTokenAccountV2Ix({
      payer: e.payer,
      referralAccount: e.referralAccount,
      mint: t.mint,
      tokenProgram: t.tokenProgram,
    });
    if (!built.tokenAccount.equals(t.tokenAccount)) policy('collection account mismatch');
    expected.push(built.instruction);
  }
  const skip = assertSignerBudgetPair(tx.instructions, e.maxPriorityFeeLamports);
  const rest = tx.instructions.slice(skip);
  if (rest.length !== expected.length) policy('unexpected number of instructions');
  rest.forEach((ix, i) => {
    if (!sameInstruction(ix, expected[i]!)) {
      policy(
        i === 0 && e.createReferralAccount
          ? 'referral account initialization mismatch'
          : 'collection account creation mismatch',
      );
    }
  });
}

// ---------------------------------------------------------------------------------------
// Command

export type ReferralSetupConnection = Pick<
  Connection,
  'getAccountInfo' | 'getMultipleAccountsInfo' | 'getGenesisHash'
>;

export interface ReferralSetupDeps {
  cluster: 'devnet' | 'mainnet-beta';
  /** Account reads (the core read helpers). */
  connection: ReferralSetupConnection;
  rpc: SolanaRpc;
  keystore: KeystoreLike;
  /** The keystore payer: fee payer, rent payer and only signer. */
  payer: { ref: string; publicKey: PublicKey };
  /** The revenue wallet: owner of the Meteora account, partner of the Jupiter account. */
  revenue: PublicKey;
  /** FORGE_METEORA_REFERRAL_ACCOUNT and FORGE_JUPITER_REFERRAL_ACCOUNT when already set. */
  configured: { meteoraReferral: PublicKey | null; jupiterReferral: PublicKey | null };
  journal: Journal<ReferralSetupEntry>;
  /** Called with the signature right before its first broadcast (watcher expected set). */
  onBeforeSend: BeforeSendHook;
  logger: JobLogger;
  /** Where the plan and the resulting env lines go (default: standard output). */
  print?: (line: string) => void;
  /** Priority fees (SIGNER_PRIORITY_FEE_*). Default: none. */
  priorityFees?: PriorityFees;
  /** Mints of the Jupiter collection accounts (default: wrapped SOL and USDC). */
  jupiterMints?: readonly PublicKey[];
  retry?: RetryOptions;
  settle?: Partial<SettleTiming>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ReferralSetupOptions {
  /** Name of the Jupiter referral account (default `forge`): 1 to 19 characters. */
  name?: string;
  /** Seed of the Meteora account address (default `forge-meteora-referral`). */
  seed?: string;
  /** False (default): dry run, nothing is signed or sent. */
  send?: boolean;
}

export type ReferralSetupPartStatus =
  /** The account exists and matches: nothing to do. */
  | 'ready'
  /** Dry run: the transaction would be sent. */
  | 'planned'
  /** Sent and confirmed in this run. */
  | 'sent'
  /** Sent (now or before), not settled yet: run the command again. */
  | 'pending'
  /** Something exists that does not match, or the configuration disagrees: nothing sent. */
  | 'mismatch'
  /** Jupiter part off mainnet-beta: nothing read, nothing sent. */
  | 'wrong_cluster'
  /** The transaction failed on-chain or expired: nothing created, run again. */
  | 'failed';

export interface ReferralSetupPartResult {
  part: ReferralSetupPart;
  status: ReferralSetupPartStatus;
  /** The account of the part (public), null when it could not be established. */
  account: string | null;
  /** Public addresses created, or to be created (dry run). */
  creates: string[];
  signature: string | null;
  /** What was wrong (mismatch, failed), one line each; empty otherwise. */
  problems: string[];
  /** Lamports the payer spends (rents, fees) for the planned or sent transaction. */
  costLamports: bigint | null;
}

export interface ReferralSetupResult {
  dryRun: boolean;
  payer: string;
  revenue: string;
  meteora: ReferralSetupPartResult;
  jupiter: ReferralSetupPartResult;
  /** `FORGE_..._ACCOUNT=<address>` lines of the parts that are ready or sent. */
  envLines: string[];
  /** 0: done or nothing to do (a dry run included); 2: refused; 3: pending, run again. */
  exitCode: 0 | 2 | 3;
}

interface Ctx {
  deps: ReferralSetupDeps;
  retry: RetryOptions;
  settle: SettleTiming;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  iso: () => string;
  print: (line: string) => void;
  announce: (signature: string) => boolean;
  priorityFees: PriorityFees;
  send: boolean;
}

function part(
  p: ReferralSetupPart,
  status: ReferralSetupPartStatus,
  init: Partial<ReferralSetupPartResult> = {},
): ReferralSetupPartResult {
  return {
    part: p,
    status,
    account: null,
    creates: [],
    signature: null,
    problems: [],
    costLamports: null,
    ...init,
  };
}

/** Settles the part's transaction in flight, if any: returns a pending result or null. */
async function settleInFlight(
  ctx: Ctx,
  p: ReferralSetupPart,
): Promise<ReferralSetupPartResult | null> {
  const { deps, retry } = ctx;
  const entry = await deps.journal.get(p);
  if (!entry || entry.status !== 'in_flight') return null;
  deps.logger.info({ part: p, signature: entry.signature }, 'settling the transaction in flight');
  const announced = ctx.announce(entry.signature);
  let s = await checkSettlement(deps.rpc, entry.signature, entry.lastValidBlockHeight, retry);
  if (s.kind === 'pending' || s.kind === 'processing') {
    s = await awaitSettlement(deps.rpc, entry.signature, {
      lastValidBlockHeight: entry.lastValidBlockHeight,
      ...(announced ? { raw: Buffer.from(entry.rawTx, 'base64') } : {}),
      until: 'confirmed',
      ...ctx.settle,
      retry,
      sleep: ctx.sleep,
      now: ctx.now,
      logger: deps.logger,
    });
  }
  const applied = await applySettlement(ctx, entry, s);
  if (applied === 'pending') {
    return part(p, 'pending', {
      account: entry.account,
      signature: entry.signature,
      creates: entry.creates,
    });
  }
  return null;
}

/** Records a settlement; returns what it became. */
async function applySettlement(
  ctx: Ctx,
  entry: ReferralSetupEntry,
  s: Settlement,
): Promise<'confirmed' | 'open' | 'pending'> {
  const { deps } = ctx;
  if (s.kind === 'confirmed' || s.kind === 'finalized') {
    await deps.journal.put(entry.part, { ...entry, status: 'confirmed', confirmedAt: ctx.iso() });
    deps.logger.info(
      { part: entry.part, signature: entry.signature, account: entry.account },
      'referral setup confirmed',
    );
    return 'confirmed';
  }
  if (s.kind === 'failed' || s.kind === 'expired') {
    const error = s.kind === 'failed' ? s.error : entry.lastError;
    // The entry keeps the attempt in its history; the next run re-reads the chain and rebuilds.
    await deps.journal.put(entry.part, {
      ...entry,
      status: s.kind,
      confirmedAt: null,
      lastError: error,
      history: [
        ...entry.history,
        { signature: entry.signature, outcome: s.kind, error, at: ctx.iso() },
      ].slice(-20),
    });
    deps.logger.error(
      { part: entry.part, signature: entry.signature, outcome: s.kind, error },
      'referral setup transaction did not land',
    );
    return 'open';
  }
  return 'pending';
}

async function attemptsOf(deps: ReferralSetupDeps, p: ReferralSetupPart): Promise<number> {
  const entry = await deps.journal.get(p);
  return entry?.history.length ?? 0;
}

interface Planned {
  tx: Transaction;
  lastValidBlockHeight: number;
  account: PublicKey;
  creates: PublicKey[];
  rentLamports: bigint;
  priorityFeeLamports: bigint;
  computeUnits: number;
  describe: string[];
}

/** Signs, journals, announces, broadcasts and settles one planned transaction. */
async function sendPlanned(
  ctx: Ctx,
  p: ReferralSetupPart,
  planned: Planned,
): Promise<ReferralSetupPartResult> {
  const { deps, retry } = ctx;
  const cost =
    planned.rentLamports +
    SIGNATURE_FEE_LAMPORTS +
    ctx.priorityFees.maxFeeLamports(planned.computeUnits) +
    REFERRAL_SETUP_FEE_BUFFER_LAMPORTS;
  const balance = await spendableBalance(deps.rpc, deps.payer.publicKey, retry);
  if (balance < cost) {
    throw new JobError(
      'CONFIG',
      `the payer wallet holds ${formatSol(balance)} SOL, the ${p} setup needs ${formatSol(cost)} SOL: fund it`,
    );
  }
  if ((await attemptsOf(deps, p)) >= MAX_REFERRAL_SETUP_ATTEMPTS) {
    throw new JobError(
      'CONFIG',
      `the ${p} setup failed ${MAX_REFERRAL_SETUP_ATTEMPTS} times: manual handling (journal ${REFERRAL_SETUP_JOURNAL_NAMESPACE}.${p})`,
    );
  }
  const previous = await deps.journal.get(p);
  const { raw, signature } = await signWithKeystore(deps.keystore, planned.tx, [
    { ref: deps.payer.ref, expected: deps.payer.publicKey },
  ]);
  const entry: ReferralSetupEntry = {
    v: 1,
    part: p,
    cluster: deps.cluster,
    account: planned.account.toBase58(),
    creates: planned.creates.map((k) => k.toBase58()),
    status: 'in_flight',
    signature,
    rawTx: raw.toString('base64'),
    lastValidBlockHeight: planned.lastValidBlockHeight,
    recordedAt: ctx.iso(),
    confirmedAt: null,
    lastError: null,
    history: previous?.history ?? [],
  };
  await deps.journal.put(p, entry); // journaled BEFORE the first broadcast
  deps.logger.info(
    { part: p, signature, account: entry.account, creates: entry.creates },
    'referral setup signed and journaled',
  );
  const base = {
    account: entry.account,
    creates: entry.creates,
    signature,
    costLamports: planned.rentLamports + SIGNATURE_FEE_LAMPORTS + planned.priorityFeeLamports,
  };
  if (!ctx.announce(signature)) return part(p, 'pending', base);
  const result = await broadcast(deps.rpc, raw, retry);
  if (result.status === 'rejected') {
    await deps.journal.put(p, { ...entry, lastError: result.reason });
    deps.logger.error(
      { part: p, signature, reason: result.reason },
      'the RPC rejected the referral setup transaction',
    );
    // It may still have reached the network: settle it like any other before replacing it.
  }
  const s = await awaitSettlement(deps.rpc, signature, {
    lastValidBlockHeight: planned.lastValidBlockHeight,
    raw,
    until: 'confirmed',
    ...ctx.settle,
    retry,
    sleep: ctx.sleep,
    now: ctx.now,
    logger: deps.logger,
  });
  const applied = await applySettlement(
    ctx,
    { ...entry, lastError: result.status === 'rejected' ? result.reason : null },
    s,
  );
  if (applied === 'confirmed') return part(p, 'sent', base);
  if (applied === 'pending') return part(p, 'pending', base);
  const error =
    s.kind === 'failed' ? s.error : result.status === 'rejected' ? result.reason : 'expired';
  return part(p, 'failed', { ...base, problems: [`the transaction ${s.kind}: ${error}`] });
}

// ---------------------------------------------------------------------------------------
// Meteora part

async function meteoraPart(ctx: Ctx, seed: string): Promise<ReferralSetupPartResult> {
  const { deps, retry } = ctx;
  const inFlight = await settleInFlight(ctx, 'meteora');
  if (inFlight) return inFlight;
  const derived = deriveMeteoraReferralAccount(deps.payer.publicKey, seed);
  const configured = deps.configured.meteoraReferral;
  const address = configured ?? derived;
  const status: MeteoraReferralAccountStatus = await readMeteoraReferralAccount({
    connection: deps.connection,
    address,
    owner: deps.revenue,
    retry,
  });
  const base = { account: address.toBase58() };
  if (status.status === 'ready') {
    deps.logger.info(
      { ...base, lamports: status.lamports.toString(), configured: configured !== null },
      'Meteora referral account ready',
    );
    return part('meteora', 'ready', base);
  }
  if (status.status === 'mismatch') {
    return part('meteora', 'mismatch', {
      ...base,
      problems: [
        `${configured ? 'FORGE_METEORA_REFERRAL_ACCOUNT' : 'the derived address'} ${address.toBase58()}: ${status.detail} (${status.reason})`,
        configured
          ? 'fix or unset FORGE_METEORA_REFERRAL_ACCOUNT; the command never creates a second account'
          : 'choose another seed (--seed) or free the address; the command never reuses it',
      ],
    });
  }
  if (configured && !configured.equals(derived)) {
    return part('meteora', 'mismatch', {
      ...base,
      problems: [
        `FORGE_METEORA_REFERRAL_ACCOUNT=${configured.toBase58()} holds no account and is not the address this command derives (${derived.toBase58()})`,
        'unset it to let the command create the account at the derived address, or create it by other means',
      ],
    });
  }
  const rentLamports = await withRetry(
    () => deps.rpc.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
    retry,
  );
  const quote = await ctx.priorityFees.quote(
    [deps.payer.publicKey, derived],
    METEORA_REFERRAL_SETUP_COMPUTE_UNITS,
  );
  const { blockhash, lastValidBlockHeight } = await withRetry(
    () => deps.rpc.getLatestBlockhash(),
    retry,
  );
  const built = buildCreateMeteoraReferralAccountTx({
    payer: deps.payer.publicKey,
    owner: deps.revenue,
    seed,
    rentLamports,
    blockhash,
    lastValidBlockHeight,
    priorityFee: quote,
  });
  assertMeteoraReferralSetupTx(built.transaction, {
    payer: deps.payer.publicKey,
    owner: deps.revenue,
    account: derived,
    seed,
    rentLamports,
    maxPriorityFeeLamports: quote.maxLamports,
  });
  const planned: Planned = {
    tx: built.transaction,
    lastValidBlockHeight,
    account: derived,
    creates: [derived],
    rentLamports,
    priorityFeeLamports: quote.priorityFeeLamports,
    computeUnits: METEORA_REFERRAL_SETUP_COMPUTE_UNITS,
    describe: [
      `create the Meteora referral account ${derived.toBase58()} (standalone wrapped-SOL token account, owner ${deps.revenue.toBase58()}, seed "${seed}")`,
      `rent ${formatSol(rentLamports)} SOL paid by the payer ${deps.payer.publicKey.toBase58()}, priority fee up to ${formatSol(quote.priorityFeeLamports)} SOL`,
    ],
  };
  for (const line of planned.describe) ctx.print(`[meteora] ${line}`);
  if (!ctx.send) {
    return part('meteora', 'planned', {
      ...base,
      creates: [derived.toBase58()],
      costLamports: rentLamports + SIGNATURE_FEE_LAMPORTS + quote.priorityFeeLamports,
    });
  }
  const sent = await sendPlanned(ctx, 'meteora', planned);
  if (sent.status === 'sent') {
    const after = await readMeteoraReferralAccount({
      connection: deps.connection,
      address: derived,
      owner: deps.revenue,
      retry,
    });
    if (after.status !== 'ready') {
      return {
        ...sent,
        status: 'failed',
        problems: [
          `confirmed, but the account is ${after.status}${after.status === 'mismatch' ? `: ${after.detail}` : ''}`,
        ],
      };
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------------------
// Jupiter part

function describeConfiguredJupiter(
  configured: PublicKey,
  info: { owner: PublicKey; data: Buffer } | null,
): string {
  if (!info) return `FORGE_JUPITER_REFERRAL_ACCOUNT=${configured.toBase58()} holds no account`;
  if (!info.owner.equals(JUPITER_REFERRAL_PROGRAM_ID)) {
    return `FORGE_JUPITER_REFERRAL_ACCOUNT=${configured.toBase58()} is not owned by the referral program`;
  }
  try {
    const a = decodeJupiterReferralAccount(Buffer.from(info.data));
    return `FORGE_JUPITER_REFERRAL_ACCOUNT=${configured.toBase58()} is a referral account of project ${a.project.toBase58()} with partner ${a.partner.toBase58()} and ${a.name === null ? 'no name' : `name "${a.name}"`}`;
  } catch {
    return `FORGE_JUPITER_REFERRAL_ACCOUNT=${configured.toBase58()} does not decode as a referral account`;
  }
}

async function jupiterPart(ctx: Ctx, name: string): Promise<ReferralSetupPartResult> {
  const { deps, retry } = ctx;
  if (deps.cluster !== 'mainnet-beta') {
    ctx.print(
      '[jupiter] the Jupiter referral program and the Ultra project only exist on mainnet-beta: skipped on ' +
        deps.cluster,
    );
    return part('jupiter', 'wrong_cluster');
  }
  const inFlight = await settleInFlight(ctx, 'jupiter');
  if (inFlight) return inFlight;
  const mints = deps.jupiterMints ?? [NATIVE_MINT, USDC_MINT];
  const state: JupiterReferralSetupState = await readJupiterReferralSetup({
    connection: deps.connection as Connection,
    partner: deps.revenue,
    name,
    mints,
    retry,
  });
  const base = { account: state.referralAccount.toBase58() };
  const problems: string[] = [];
  const configured = deps.configured.jupiterReferral;
  if (configured && !configured.equals(state.referralAccount)) {
    const info = await withRetry(
      () => deps.connection.getAccountInfo(configured, 'confirmed'),
      retry,
    );
    problems.push(
      `${describeConfiguredJupiter(configured, info)}; the named account "${name}" of the Ultra project is ${state.referralAccount.toBase58()}`,
      'pass --name with the name of the configured account, or unset FORGE_JUPITER_REFERRAL_ACCOUNT; the command never creates a second account',
    );
  }
  if (state.referral.status === 'mismatch') {
    problems.push(
      `referral account ${state.referralAccount.toBase58()}: ${state.referral.detail} (${state.referral.reason})`,
    );
  }
  for (const t of state.tokenAccounts) {
    if (t.status.status === 'mismatch') {
      problems.push(
        `collection account ${t.tokenAccount.toBase58()} of mint ${t.mint.toBase58()}: ${t.status.detail} (${t.status.reason})`,
      );
    }
  }
  if (problems.length > 0) return part('jupiter', 'mismatch', { ...base, problems });
  const createReferralAccount = state.referral.status === 'absent';
  const tokenAccounts = state.tokenAccounts.filter((t) => t.status.status === 'absent');
  if (!createReferralAccount && tokenAccounts.length === 0) {
    deps.logger.info(
      {
        ...base,
        name,
        shareBps: state.referral.status === 'ready' ? state.referral.account.shareBps : null,
      },
      'Jupiter referral account ready',
    );
    return part('jupiter', 'ready', base);
  }
  const referralRent = createReferralAccount
    ? await withRetry(
        () => deps.rpc.getMinimumBalanceForRentExemption(JUPITER_REFERRAL_ACCOUNT_SIZE),
        retry,
      )
    : 0n;
  const tokenRent =
    tokenAccounts.length > 0
      ? await withRetry(() => deps.rpc.getMinimumBalanceForRentExemption(ACCOUNT_SIZE), retry)
      : 0n;
  const rentLamports = referralRent + tokenRent * BigInt(tokenAccounts.length);
  const creates = [
    ...(createReferralAccount ? [state.referralAccount] : []),
    ...tokenAccounts.map((t) => t.tokenAccount),
  ];
  const quote = await ctx.priorityFees.quote(
    [deps.payer.publicKey, ...creates],
    JUPITER_REFERRAL_SETUP_COMPUTE_UNITS,
  );
  const { blockhash, lastValidBlockHeight } = await withRetry(
    () => deps.rpc.getLatestBlockhash(),
    retry,
  );
  const built = buildJupiterReferralSetupTx({
    payer: deps.payer.publicKey,
    partner: deps.revenue,
    project: JUPITER_ULTRA_REFERRAL_PROJECT,
    name,
    createReferralAccount,
    tokenAccounts,
    blockhash,
    lastValidBlockHeight,
    priorityFee: quote,
  });
  assertJupiterReferralSetupTx(built.transaction, {
    payer: deps.payer.publicKey,
    partner: deps.revenue,
    project: JUPITER_ULTRA_REFERRAL_PROJECT,
    name,
    referralAccount: state.referralAccount,
    createReferralAccount,
    tokenAccounts: built.tokenAccounts,
    maxPriorityFeeLamports: quote.maxLamports,
  });
  const planned: Planned = {
    tx: built.transaction,
    lastValidBlockHeight,
    account: state.referralAccount,
    creates,
    rentLamports,
    priorityFeeLamports: quote.priorityFeeLamports,
    computeUnits: JUPITER_REFERRAL_SETUP_COMPUTE_UNITS,
    describe: [
      ...(createReferralAccount
        ? [
            `create the Jupiter referral account ${state.referralAccount.toBase58()} (name "${name}", Ultra project ${JUPITER_ULTRA_REFERRAL_PROJECT.toBase58()}, partner ${deps.revenue.toBase58()}, share ${state.projectAccount.defaultShareBps} bps)`,
          ]
        : [`the Jupiter referral account ${state.referralAccount.toBase58()} exists`]),
      ...tokenAccounts.map(
        (t) =>
          `create its collection account ${t.tokenAccount.toBase58()} for mint ${t.mint.toBase58()}`,
      ),
      `rent ${formatSol(rentLamports)} SOL paid by the payer ${deps.payer.publicKey.toBase58()}, priority fee up to ${formatSol(quote.priorityFeeLamports)} SOL`,
    ],
  };
  for (const line of planned.describe) ctx.print(`[jupiter] ${line}`);
  if (!ctx.send) {
    return part('jupiter', 'planned', {
      ...base,
      creates: creates.map((k) => k.toBase58()),
      costLamports: rentLamports + SIGNATURE_FEE_LAMPORTS + quote.priorityFeeLamports,
    });
  }
  const sent = await sendPlanned(ctx, 'jupiter', planned);
  if (sent.status === 'sent') {
    const after = await readJupiterReferralSetup({
      connection: deps.connection as Connection,
      partner: deps.revenue,
      name,
      mints,
      retry,
    });
    const notReady = [
      ...(after.referral.status !== 'ready' ? [`referral account ${after.referral.status}`] : []),
      ...after.tokenAccounts
        .filter((t) => t.status.status !== 'ready')
        .map((t) => `collection account of ${t.mint.toBase58()} ${t.status.status}`),
    ];
    if (notReady.length > 0)
      return { ...sent, status: 'failed', problems: notReady.map((n) => `confirmed, but ${n}`) };
  }
  return sent;
}

// ---------------------------------------------------------------------------------------
// Entry point

/**
 * Runs the setup: settles what is in flight, reads the chain, plans, and (with `send`) sends.
 * Throws on a configuration error (bad name or seed, unfunded payer, exhausted attempts) or a
 * read failure; returns a result with an exit code otherwise. Never throws for a mismatch.
 */
export async function runReferralSetup(
  deps: ReferralSetupDeps,
  options: ReferralSetupOptions = {},
): Promise<ReferralSetupResult> {
  const name = options.name ?? DEFAULT_JUPITER_REFERRAL_NAME;
  const seed = options.seed ?? METEORA_REFERRAL_ACCOUNT_SEED;
  try {
    assertJupiterReferralName(name);
    assertMeteoraReferralSeed(seed);
  } catch (err) {
    if (err instanceof JupiterReferralError || err instanceof MeteoraReferralError) {
      throw new JobError('CONFIG', err.message);
    }
    throw err;
  }
  if (deps.payer.publicKey.equals(deps.revenue)) {
    throw new JobError('CONFIG', 'the payer and the revenue wallet must be different keys');
  }
  const ctx: Ctx = {
    deps,
    retry: deps.retry ?? DEFAULT_RETRY,
    settle: { ...DEFAULT_SETTLE, ...deps.settle },
    sleep: deps.sleep ?? realSleep,
    now: deps.now ?? Date.now,
    iso: () => new Date((deps.now ?? Date.now)()).toISOString(),
    print: deps.print ?? ((line) => console.log(line)),
    announce: createAnnouncer(deps.onBeforeSend, deps.logger),
    priorityFees: deps.priorityFees ?? NO_PRIORITY_FEES,
    send: options.send === true,
  };
  ctx.print(
    `revenue wallet referral accounts setup on ${deps.cluster} (${ctx.send ? 'SENDING' : 'dry run: nothing is sent without --send'})`,
  );
  ctx.print(`payer ${deps.payer.publicKey.toBase58()}, revenue wallet ${deps.revenue.toBase58()}`);

  const meteora = await meteoraPart(ctx, seed);
  const jupiter = await jupiterPart(ctx, name);

  const envLines: string[] = [];
  if ((meteora.status === 'ready' || meteora.status === 'sent') && meteora.account) {
    envLines.push(`FORGE_METEORA_REFERRAL_ACCOUNT=${meteora.account}`);
  }
  if ((jupiter.status === 'ready' || jupiter.status === 'sent') && jupiter.account) {
    envLines.push(`FORGE_JUPITER_REFERRAL_ACCOUNT=${jupiter.account}`);
  }
  for (const p of [meteora, jupiter]) {
    const line = `[${p.part}] ${p.status}${p.account ? ` ${p.account}` : ''}${p.signature ? ` (signature ${p.signature})` : ''}`;
    ctx.print(line);
    for (const problem of p.problems) ctx.print(`[${p.part}]   ${problem}`);
    if (p.status === 'planned' && p.account) {
      ctx.print(
        `[${p.part}]   after --send, set ${p.part === 'meteora' ? 'FORGE_METEORA_REFERRAL_ACCOUNT' : 'FORGE_JUPITER_REFERRAL_ACCOUNT'}=${p.account}`,
      );
    }
  }
  if (envLines.length > 0) {
    ctx.print('set on the signer, the builder and the web:');
    for (const line of envLines) ctx.print(line);
  }
  const statuses = [meteora.status, jupiter.status];
  const exitCode: 0 | 2 | 3 =
    statuses.includes('mismatch') || statuses.includes('failed')
      ? 2
      : statuses.includes('pending')
        ? 3
        : 0;
  const result: ReferralSetupResult = {
    dryRun: !ctx.send,
    payer: deps.payer.publicKey.toBase58(),
    revenue: deps.revenue.toBase58(),
    meteora,
    jupiter,
    envLines,
    exitCode,
  };
  deps.logger.info(
    {
      dryRun: result.dryRun,
      exitCode,
      meteora: { status: meteora.status, account: meteora.account, signature: meteora.signature },
      jupiter: { status: jupiter.status, account: jupiter.account, signature: jupiter.signature },
    },
    'referral setup finished',
  );
  return result;
}

/** Safe summary of a failure for the operator (no URL, no secret). */
export function describeReferralSetupError(err: unknown): string {
  const summary = describeError(err);
  return summary.code ? `${summary.code}: ${summary.message}` : summary.message;
}
