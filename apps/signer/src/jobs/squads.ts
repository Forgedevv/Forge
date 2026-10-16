/**
 * Squads v4 spending-limit withdrawer of the $FORGE buyback (jobs/buyback.ts, step "funding";
 * docs/SECURITY.md 7: "The buyback bot only has a daily Squads spending limit to its own wallet").
 *
 * Setup on the multisig (done by the team through the Squads app, never by this code): the bot
 * wallet (keystore role `buyback`) is a member of the multisig WITHOUT any permission (it cannot
 * initiate, vote or execute anything), and a SOL spending limit on the treasury vault lists it as
 * its only member and its only destination, with a `Day` period. The bot can then move at most the
 * limit per day, only to itself; everything else on the vault still needs the multisig threshold.
 *
 * Environment: FORGE_SQUADS_MULTISIG (the multisig account), FORGE_SQUADS_SPENDING_LIMIT (the
 * spending limit account), FORGE_SQUADS_VAULT_INDEX (default 0), read and format-checked by
 * `readSquadsAddresses` of @forge/core (addresses.ts, PLANEXECUTE rule 7). The vault derived
 * here from the multisig and the index (the program id comes from the pinned SDK) must be
 * FORGE_MULTISIG_VAULT: a mismatch is a startup error. Without the two addresses no withdrawer
 * is wired and the buyback stays in simulation.
 *
 * Policy, checked before anything is signed, on every withdrawal and on every allowance read:
 * - the spending limit account is owned by the Squads program, belongs to the configured
 *   multisig and vault index, is a SOL limit (`mint` = the all-zero key), has a `Day` period,
 *   lists the bot as a member and the bot as its ONLY destination, and has a positive amount;
 * - the amount is positive and within what remains of the period, recomputed from the on-chain
 *   clock the way the program does it (a stale `remainingAmount` is never trusted upwards);
 * - the transaction is exactly one `spending_limit_use` instruction of the Squads program, fee
 *   payer and only signer = the bot, accounts = [multisig, bot (signer), spending limit, vault,
 *   bot (destination), System Program], data = the amount, 9 decimals and the fixed memo.
 * Idempotency: a withdrawal is journaled under its idempotency key BEFORE it is sent; a key seen
 * before is never built again (its earlier transaction is settled and reported instead).
 * The instruction itself is built by the official SDK (`@sqds/multisig`, pinned) and re-decoded
 * here: the SDK is trusted to encode, the policy decides.
 */
import { createHash } from 'node:crypto';
import * as multisig from '@sqds/multisig';
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountInfo,
  type AccountMeta,
  type Connection,
} from '@solana/web3.js';
import { z } from 'zod';
import {
  ForgeAddressError,
  ForgeSquadsConfigError,
  readSquadsAddresses,
  type SquadsAddresses,
} from '@forge/core';
import type { SpendingLimitWithdrawer, WithdrawResult } from './buyback.js';
import {
  DEFAULT_RETRY,
  DEFAULT_SETTLE,
  JobError,
  awaitSettlement,
  broadcast,
  checkSettlement,
  createFileJournal,
  describeError,
  realSleep,
  requireRoleRef,
  requiredSigners,
  signWithKeystore,
  withRetry,
  type JobLogger,
  type Journal,
  type KeystoreLike,
  type RetryOptions,
  type SettleTiming,
  type SolanaRpc,
} from './shared.js';

// ---------------------------------------------------------------------------------------
// Constants

/** Squads v4 program (same id on devnet and mainnet-beta), from the pinned SDK. */
export const SQUADS_PROGRAM_ID = new PublicKey(multisig.PROGRAM_ID.toBase58());
/** Memo carried by every withdrawal (the vault outflow is labelled on-chain). */
export const FUNDING_MEMO = 'forge:buyback-funding';
/** SOL spending limits use the all-zero key as mint. */
export const SOL_SPENDING_LIMIT_MINT = PublicKey.default;
export const SOL_DECIMALS = 9;
/** Anchor discriminator of `spending_limit_use`: sha256("global:spending_limit_use")[0..8]. */
export const SPENDING_LIMIT_USE_DISCRIMINATOR: Buffer = createHash('sha256')
  .update('global:spending_limit_use')
  .digest()
  .subarray(0, 8);

/** `Period` of the Squads program: seconds per period, null for a one-time limit. */
export const PERIOD_SECONDS: Readonly<Record<number, bigint | null>> = {
  0: null, // OneTime
  1: 86_400n, // Day
  2: 604_800n, // Week
  3: 2_592_000n, // Month (30 days)
};
export const PERIOD_DAY = 1;

const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;

// ---------------------------------------------------------------------------------------
// Configuration

export interface SquadsConfig {
  /** FORGE_SQUADS_MULTISIG: the multisig account. */
  multisig: PublicKey;
  /** FORGE_SQUADS_SPENDING_LIMIT: the spending limit account (SOL, daily, bot only). */
  spendingLimit: PublicKey;
  /** FORGE_SQUADS_VAULT_INDEX (default 0). */
  vaultIndex: number;
  /** FORGE_MULTISIG_VAULT, equal to the vault derived from `multisig` and `vaultIndex`. */
  vault: PublicKey;
  programId: PublicKey;
}

/** Vault PDA of a multisig: seeds ["multisig", multisig, "vault", index]. */
export function deriveSquadsVault(
  multisigKey: PublicKey,
  index: number,
  programId: PublicKey = SQUADS_PROGRAM_ID,
): PublicKey {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new JobError('CONFIG', 'vault index must be between 0 and 255');
  }
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('multisig', 'utf8'),
      multisigKey.toBuffer(),
      Buffer.from('vault', 'utf8'),
      Buffer.from([index]),
    ],
    programId,
  );
  return pda;
}

/**
 * Reads FORGE_SQUADS_MULTISIG, FORGE_SQUADS_SPENDING_LIMIT and FORGE_SQUADS_VAULT_INDEX through
 * @forge/core `readSquadsAddresses`. Returns null when both addresses are absent (no withdrawer:
 * simulation only). One without the other, an invalid address, an index outside 0..255, or a
 * vault that is not FORGE_MULTISIG_VAULT is a CONFIG error (names only, never values).
 */
export function squadsConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  vault: PublicKey,
): SquadsConfig | null {
  const fail = (rule: string): never => {
    throw new JobError('CONFIG', rule);
  };
  let read: SquadsAddresses | null;
  try {
    read = readSquadsAddresses(env);
  } catch (err) {
    if (err instanceof ForgeAddressError) {
      fail(`${err.invalid.join(', ')} is not an address`);
    }
    if (err instanceof ForgeSquadsConfigError) fail(err.message);
    throw err;
  }
  if (!read) return null;
  const { multisig: multisigKey, spendingLimit, vaultIndex } = read;
  if (!deriveSquadsVault(multisigKey, vaultIndex).equals(vault)) {
    fail('FORGE_SQUADS_MULTISIG and FORGE_SQUADS_VAULT_INDEX do not derive FORGE_MULTISIG_VAULT');
  }
  if (spendingLimit.equals(multisigKey) || spendingLimit.equals(vault)) {
    fail('FORGE_SQUADS_SPENDING_LIMIT must be a distinct account');
  }
  return { multisig: multisigKey, spendingLimit, vaultIndex, vault, programId: SQUADS_PROGRAM_ID };
}

// ---------------------------------------------------------------------------------------
// Spending limit account (pure)

export interface SpendingLimitState {
  multisig: string;
  createKey: string;
  vaultIndex: number;
  mint: string;
  amount: bigint;
  /** `Period` enum value (0 one-time, 1 day, 2 week, 3 month). */
  period: number;
  remainingAmount: bigint;
  /** Unix seconds of the last period reset. */
  lastReset: bigint;
  members: string[];
  destinations: string[];
}

function bignum(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new JobError('RPC', 'invalid amount');
    return BigInt(value);
  }
  if (typeof value === 'bigint') return value;
  if (value && typeof (value as { toString?: unknown }).toString === 'function') {
    const text = String(value);
    if (!/^(0|[1-9][0-9]{0,19})$/.test(text)) throw new JobError('RPC', 'invalid amount');
    return BigInt(text);
  }
  throw new JobError('RPC', 'invalid amount');
}

/** Decodes a `SpendingLimit` account with the SDK layout; refuses other owners. */
export function decodeSpendingLimit(
  info: Pick<AccountInfo<Buffer>, 'owner' | 'data'>,
  programId: PublicKey = SQUADS_PROGRAM_ID,
): SpendingLimitState {
  if (!info.owner.equals(programId)) {
    throw new JobError('TX_POLICY', 'spending limit account is not owned by the Squads program');
  }
  let decoded: multisig.accounts.SpendingLimit;
  try {
    [decoded] = multisig.accounts.SpendingLimit.fromAccountInfo({
      executable: false,
      lamports: 0,
      owner: info.owner,
      data: Buffer.from(info.data),
    });
  } catch {
    throw new JobError('TX_POLICY', 'spending limit account cannot be decoded');
  }
  return {
    multisig: decoded.multisig.toBase58(),
    createKey: decoded.createKey.toBase58(),
    vaultIndex: decoded.vaultIndex,
    mint: decoded.mint.toBase58(),
    amount: bignum(decoded.amount),
    period: Number(decoded.period),
    remainingAmount: bignum(decoded.remainingAmount),
    lastReset: bignum(decoded.lastReset),
    members: decoded.members.map((k) => k.toBase58()),
    destinations: decoded.destinations.map((k) => k.toBase58()),
  };
}

export type SpendingLimitRefusal =
  | 'wrong_multisig'
  | 'wrong_vault_index'
  | 'not_sol'
  | 'not_daily'
  | 'bot_not_member'
  | 'destination_not_bot_only'
  | 'zero_amount';

/** Why the spending limit must not be used, or null (SECURITY.md 7: to the bot's own wallet only). */
export function checkSpendingLimit(
  state: SpendingLimitState,
  expected: { multisig: PublicKey; vaultIndex: number; bot: PublicKey },
): SpendingLimitRefusal | null {
  const bot = expected.bot.toBase58();
  if (state.multisig !== expected.multisig.toBase58()) return 'wrong_multisig';
  if (state.vaultIndex !== expected.vaultIndex) return 'wrong_vault_index';
  if (state.mint !== SOL_SPENDING_LIMIT_MINT.toBase58()) return 'not_sol';
  if (state.period !== PERIOD_DAY) return 'not_daily';
  if (!state.members.includes(bot)) return 'bot_not_member';
  if (state.destinations.length !== 1 || state.destinations[0] !== bot) {
    return 'destination_not_bot_only';
  }
  if (state.amount <= 0n) return 'zero_amount';
  return null;
}

/**
 * Lamports the program will accept right now: the on-chain `remainingAmount`, or the full amount
 * once the period has elapsed since `lastReset` (the program resets it on use, strictly more than
 * a period later). A clock behind the program's only lowers the estimate.
 */
export function effectiveRemainingLamports(state: SpendingLimitState, nowUnix: bigint): bigint {
  const period = PERIOD_SECONDS[state.period] ?? null;
  if (period !== null && nowUnix - state.lastReset > period) return state.amount;
  return state.remainingAmount < state.amount ? state.remainingAmount : state.amount;
}

/** `unix_timestamp` of the Clock sysvar (i64 at offset 32). */
export function decodeClockUnixTimestamp(data: Buffer): bigint {
  if (data.length < 40) throw new JobError('RPC', 'clock sysvar data too short');
  return data.readBigInt64LE(32);
}

// ---------------------------------------------------------------------------------------
// Instruction (SDK-built, policy-decoded)

export interface SpendingLimitUseParams {
  multisig: PublicKey;
  spendingLimit: PublicKey;
  vaultIndex: number;
  /** The bot: member of the spending limit, signer, and destination. */
  bot: PublicKey;
  lamports: bigint;
  programId?: PublicKey;
}

/** `spending_limit_use` (SOL, to the bot, with the funding memo), built by the pinned SDK. */
export function buildSpendingLimitUseIx(p: SpendingLimitUseParams): TransactionInstruction {
  if (p.lamports <= 0n) throw new JobError('INVALID_AMOUNT', 'withdrawal must be positive');
  if (p.lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new JobError('INVALID_AMOUNT', 'withdrawal too large');
  }
  const programId = p.programId ?? SQUADS_PROGRAM_ID;
  const ix = multisig.instructions.spendingLimitUse({
    multisigPda: p.multisig,
    member: p.bot,
    spendingLimit: p.spendingLimit,
    vaultIndex: p.vaultIndex,
    amount: Number(p.lamports),
    decimals: SOL_DECIMALS,
    destination: p.bot,
    memo: FUNDING_MEMO,
    programId,
  });
  // Re-created with this module's web3.js classes (the SDK may carry its own instance).
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId.toBase58()),
    keys: ix.keys.map(
      (k): AccountMeta => ({
        pubkey: new PublicKey(k.pubkey.toBase58()),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      }),
    ),
    data: Buffer.from(ix.data),
  });
}

export interface SpendingLimitUseArgs {
  amount: bigint;
  decimals: number;
  memo: string | null;
}

/** Decodes `spending_limit_use` data (discriminator, u64 amount, u8 decimals, Option<String>). */
export function decodeSpendingLimitUse(data: Buffer): SpendingLimitUseArgs | null {
  if (data.length < 18 || !data.subarray(0, 8).equals(SPENDING_LIMIT_USE_DISCRIMINATOR)) return null;
  const amount = data.readBigUInt64LE(8);
  const decimals = data[16]!;
  const tag = data[17];
  if (tag === 0) return data.length === 18 ? { amount, decimals, memo: null } : null;
  if (tag !== 1 || data.length < 22) return null;
  const length = data.readUInt32LE(18);
  if (data.length !== 22 + length) return null;
  return { amount, decimals, memo: data.subarray(22).toString('utf8') };
}

export interface SpendingLimitUseExpectation {
  programId: PublicKey;
  multisig: PublicKey;
  spendingLimit: PublicKey;
  vault: PublicKey;
  bot: PublicKey;
  lamports: bigint;
}

function policy(rule: string): never {
  throw new JobError('TX_POLICY', rule);
}

/**
 * Withdrawal policy: fee payer and only signer = the bot; exactly one instruction, of the Squads
 * program, `spending_limit_use` on the expected multisig and spending limit, from the expected
 * vault, to the bot, of exactly `lamports` with 9 decimals and the funding memo; the accounts in
 * the SDK's order with the SDK's flags, the four optional token accounts left as the program id
 * placeholders (no token path). Nothing else (no compute budget, no memo program).
 */
export function assertSpendingLimitUseTx(
  tx: Transaction,
  expected: SpendingLimitUseExpectation,
): void {
  if (expected.lamports <= 0n) policy('withdrawal must be positive');
  if (expected.bot.equals(expected.vault)) policy('bot and vault must differ');
  if (!tx.feePayer?.equals(expected.bot)) policy('unexpected fee payer');
  if (!tx.recentBlockhash) policy('missing recent blockhash');
  for (const s of requiredSigners(tx)) {
    if (!s.equals(expected.bot)) policy('unexpected required signer');
  }
  if (tx.instructions.length !== 1) policy('exactly one instruction expected');
  const ix = tx.instructions[0]!;
  if (!ix.programId.equals(expected.programId)) policy('program not allowed in a withdrawal');
  if (ix.keys.length !== 10) policy('unexpected account count');
  // A SOL use: the four optional token accounts are the program id placeholders of the SDK.
  const want: Array<[PublicKey, boolean, boolean, string]> = [
    [expected.multisig, false, false, 'multisig'],
    [expected.bot, true, false, 'member'],
    [expected.spendingLimit, false, true, 'spending limit'],
    [expected.vault, false, true, 'vault'],
    [expected.bot, false, true, 'destination'],
    [SystemProgram.programId, false, false, 'system program'],
    [expected.programId, false, false, 'mint placeholder'],
    [expected.programId, false, false, 'vault token account placeholder'],
    [expected.programId, false, false, 'destination token account placeholder'],
    [expected.programId, false, false, 'token program placeholder'],
  ];
  want.forEach(([key, signer, writable, name], i) => {
    const meta = ix.keys[i]!;
    if (!meta.pubkey.equals(key)) policy(`unexpected ${name} account`);
    if (meta.isSigner !== signer || meta.isWritable !== writable) policy(`unexpected ${name} flags`);
  });
  const decoded = decodeSpendingLimitUse(Buffer.from(ix.data));
  if (!decoded) policy('not a spending limit use');
  if (decoded.amount !== expected.lamports) policy('withdrawal amount mismatch');
  if (decoded.decimals !== SOL_DECIMALS) policy('decimals mismatch');
  if (decoded.memo !== FUNDING_MEMO) policy('memo mismatch');
}

// ---------------------------------------------------------------------------------------
// Journal

const lamportsString = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);

export const SquadsWithdrawalEntry = z.object({
  v: z.literal(1),
  key: z.string().regex(KEY_RE),
  status: z.enum(['submitted', 'confirmed', 'failed']),
  lamports: lamportsString,
  destination: z.string(),
  signature: z.string(),
  rawTx: z.string(),
  lastValidBlockHeight: z.number().int().nonnegative(),
  startedAt: z.string(),
  settledAt: z.string().optional(),
  note: z.string().max(200).optional(),
});
export type SquadsWithdrawalEntry = z.infer<typeof SquadsWithdrawalEntry>;

/** `<dir>/squads.<idempotencyKey>.json`: one file per withdrawal, written before the send. */
export function createSquadsJournal(dir: string): Journal<SquadsWithdrawalEntry> {
  return createFileJournal({ dir, namespace: 'squads', schema: SquadsWithdrawalEntry });
}

// ---------------------------------------------------------------------------------------
// Withdrawer

export interface SquadsWithdrawerDeps {
  config: SquadsConfig;
  /** Account reads (spending limit, clock). */
  connection: Pick<Connection, 'getAccountInfo'>;
  rpc: SolanaRpc;
  keystore: KeystoreLike;
  journal: Journal<SquadsWithdrawalEntry>;
  logger: JobLogger;
  retry?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  settle?: Partial<SettleTiming>;
}

export interface SquadsWithdrawer extends SpendingLimitWithdrawer {
  /** Current policy-checked state of the spending limit (throws TX_POLICY when it is wrong). */
  readLimit(bot: PublicKey): Promise<{ state: SpendingLimitState; remainingLamports: bigint }>;
  /** Settles a journaled withdrawal (null when the key is unknown). */
  settle(idempotencyKey: string): Promise<WithdrawResult | null>;
}

export function createSquadsSpendingLimitWithdrawer(deps: SquadsWithdrawerDeps): SquadsWithdrawer {
  const { config, connection, rpc, keystore, journal, logger: log } = deps;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const settleTiming = { ...DEFAULT_SETTLE, ...deps.settle };
  const iso = () => new Date(now()).toISOString();
  if (config.vault.equals(config.multisig)) throw new JobError('CONFIG', 'vault equals multisig');
  if (!deriveSquadsVault(config.multisig, config.vaultIndex, config.programId).equals(config.vault)) {
    throw new JobError('CONFIG', 'the vault is not derived from the multisig and the vault index');
  }

  async function bot(destination: PublicKey): Promise<{ ref: string; publicKey: PublicKey }> {
    const handle = await requireRoleRef(keystore, 'buyback');
    if (!handle.publicKey.equals(destination)) {
      throw new JobError('TX_POLICY', 'withdrawal destination is not the buyback wallet');
    }
    if (handle.publicKey.equals(config.vault)) {
      throw new JobError('CONFIG', 'the buyback wallet and the vault must differ');
    }
    return handle;
  }

  async function readLimit(
    botKey: PublicKey,
  ): Promise<{ state: SpendingLimitState; remainingLamports: bigint }> {
    const [limitInfo, clockInfo] = await Promise.all([
      withRetry(() => connection.getAccountInfo(config.spendingLimit, 'confirmed'), retry),
      withRetry(() => connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed'), retry),
    ]);
    if (!limitInfo) throw new JobError('TX_POLICY', 'spending limit account not found');
    if (!clockInfo) throw new JobError('RPC', 'clock sysvar not found');
    const state = decodeSpendingLimit(limitInfo, config.programId);
    const refusal = checkSpendingLimit(state, {
      multisig: config.multisig,
      vaultIndex: config.vaultIndex,
      bot: botKey,
    });
    if (refusal) throw new JobError('TX_POLICY', `spending limit refused: ${refusal}`);
    const unix = decodeClockUnixTimestamp(Buffer.from(clockInfo.data));
    return { state, remainingLamports: effectiveRemainingLamports(state, unix) };
  }

  function resultOf(entry: SquadsWithdrawalEntry): WithdrawResult {
    if (entry.status === 'confirmed') return { status: 'confirmed', signature: entry.signature };
    if (entry.status === 'failed') {
      return { status: 'failed', error: entry.note ?? 'failed', signature: entry.signature };
    }
    return { status: 'unknown', signature: entry.signature };
  }

  async function settleEntry(entry: SquadsWithdrawalEntry, wait: boolean): Promise<WithdrawResult> {
    if (entry.status !== 'submitted') return resultOf(entry);
    const raw = Buffer.from(entry.rawTx, 'base64');
    const s = wait
      ? await awaitSettlement(rpc, entry.signature, {
          lastValidBlockHeight: entry.lastValidBlockHeight,
          raw,
          until: 'confirmed',
          ...settleTiming,
          retry,
          sleep,
          now,
          logger: log,
        })
      : await checkSettlement(rpc, entry.signature, entry.lastValidBlockHeight, retry);
    if (s.kind === 'confirmed' || s.kind === 'finalized') {
      const next: SquadsWithdrawalEntry = { ...entry, status: 'confirmed', settledAt: iso() };
      await journal.put(entry.key, next);
      log.info(
        { key: entry.key, signature: entry.signature, lamports: entry.lamports },
        'spending limit withdrawal confirmed',
      );
      return resultOf(next);
    }
    if (s.kind === 'failed' || s.kind === 'expired') {
      const note = s.kind === 'failed' ? s.error : 'blockhash expired: never landed';
      const next: SquadsWithdrawalEntry = {
        ...entry,
        status: 'failed',
        settledAt: iso(),
        note: note.slice(0, 200),
      };
      await journal.put(entry.key, next);
      log.warn({ key: entry.key, signature: entry.signature, note }, 'withdrawal did not land');
      return resultOf(next);
    }
    return { status: 'unknown', signature: entry.signature };
  }

  return {
    readLimit,

    async settle(idempotencyKey) {
      const entry = await journal.get(idempotencyKey);
      return entry ? settleEntry(entry, false) : null;
    },

    async remainingLamports(destination) {
      const handle = await bot(destination);
      return (await readLimit(handle.publicKey)).remainingLamports;
    },

    async withdraw({ lamports, destination, idempotencyKey, onBeforeSend }) {
      if (!KEY_RE.test(idempotencyKey)) throw new JobError('CONFIG', 'invalid idempotency key');
      const existing = await journal.get(idempotencyKey);
      if (existing) {
        log.info({ key: idempotencyKey, status: existing.status }, 'withdrawal already journaled');
        return settleEntry(existing, true);
      }
      if (lamports <= 0n) return { status: 'refused', reason: 'amount must be positive' };
      const handle = await bot(destination);
      const { remainingLamports } = await readLimit(handle.publicKey);
      if (lamports > remainingLamports) {
        return { status: 'refused', reason: 'amount above the remaining spending limit' };
      }
      const tx = new Transaction().add(
        buildSpendingLimitUseIx({
          multisig: config.multisig,
          spendingLimit: config.spendingLimit,
          vaultIndex: config.vaultIndex,
          bot: handle.publicKey,
          lamports,
          programId: config.programId,
        }),
      );
      tx.feePayer = handle.publicKey;
      const { blockhash, lastValidBlockHeight } = await withRetry(
        () => rpc.getLatestBlockhash(),
        retry,
      );
      tx.recentBlockhash = blockhash;
      assertSpendingLimitUseTx(tx, {
        programId: config.programId,
        multisig: config.multisig,
        spendingLimit: config.spendingLimit,
        vault: config.vault,
        bot: handle.publicKey,
        lamports,
      });
      const { raw, signature } = await signWithKeystore(keystore, tx, [
        { ref: handle.ref, expected: handle.publicKey },
      ]);
      const entry: SquadsWithdrawalEntry = {
        v: 1,
        key: idempotencyKey,
        status: 'submitted',
        lamports: lamports.toString(),
        destination: destination.toBase58(),
        signature,
        rawTx: raw.toString('base64'),
        lastValidBlockHeight,
        startedAt: iso(),
      };
      await journal.put(idempotencyKey, entry);
      try {
        onBeforeSend(signature);
      } catch (err) {
        const note = `not announced, never sent: ${describeError(err).message}`.slice(0, 200);
        await journal.put(idempotencyKey, { ...entry, status: 'failed', settledAt: iso(), note });
        return { status: 'failed', error: note, signature };
      }
      log.info(
        { key: idempotencyKey, signature, lamports: lamports.toString() },
        'withdrawing from the vault spending limit',
      );
      const sent = await broadcast(rpc, raw, retry);
      if (sent.status === 'rejected') {
        // Preflight refused it. One look in case an earlier attempt still reached the network.
        const s = await checkSettlement(rpc, signature, lastValidBlockHeight, retry);
        if (s.kind === 'confirmed' || s.kind === 'finalized') return settleEntry(entry, false);
        const note = sent.reason.slice(0, 200);
        await journal.put(idempotencyKey, { ...entry, status: 'failed', settledAt: iso(), note });
        return { status: 'failed', error: note, signature };
      }
      return settleEntry(entry, true);
    },
  };
}

/** Exported for the policy tests: the SDK's own discriminator constant. */
export const SDK_SPENDING_LIMIT_USE_DISCRIMINATOR: Buffer = Buffer.from(
  multisig.generated.spendingLimitUseInstructionDiscriminator,
);
