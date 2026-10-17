/**
 * Buyback budget from the trading revenue (docs/DECISIONS.md D8, D34, D35; slice S2).
 *
 * D35: all of the trading revenue is bought back as $FORGE, at most BUYBACK_DAILY_CAP_LAMPORTS a
 * day; what the cap leaves out is bought on the following days; client payments never are. This
 * module gives the buyback job (jobs/buyback.ts) the revenue backlog it plans a day from:
 *
 *   backlog = revenue since BUYBACK_REVENUE_SINCE - spent since BUYBACK_REVENUE_SINCE, floored at 0
 *
 * where, everything read from the signer's own journals (SIGNER_JOURNAL_DIR) and nothing from
 * the chain balances (a balance mixes revenue with client payments and the team's own funds):
 * - revenue = the revenue wallet's forwards to the vault (`revenue-forward.<signature>.json`,
 *   jobs/revenue.ts: Meteora referral, Jupiter referral, platform fee, other; finalized at or
 *   after the instant) + the creator claims the vault received (`claim-receipt.<signature>.json`,
 *   jobs/claims.ts: DBC creator share and DAMM v2 position fees, settled at or after the instant,
 *   receiver = the vault, counted only once the ledger shows them finalized: a receipt still
 *   `confirmed` is checked and promoted here, or waits). Cashbox sweeps (client payments,
 *   jobs/cashbox.ts) are journaled elsewhere and never read;
 * - spent = the spending-limit withdrawals the buyback journaled at or after the instant
 *   (`buyback.day-<day>.json`, `funding`): requested, confirmed and unknown ones all count (the
 *   SOL may have left the vault), failed and not-needed ones do not. SOL withdrawn but not yet
 *   swapped is on the bot wallet, which the job counts as buyable on top of the backlog, so it
 *   is never withdrawn twice. Simulated orders move nothing and count for nothing.
 *
 * Fail closed: BUYBACK_REVENUE_SINCE unset -> `unconfigured`; an unreadable journal directory,
 * a corrupt entry or a date that does not parse -> `unavailable`. The job then plans nothing
 * for the run and alerts (never a guess, never a partial sum). A claim whose finality cannot be
 * read is simply not counted yet. Idempotent: nothing here is written except the promotion of a
 * receipt to `finalized`, which only ever happens once per receipt.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PublicKey } from '@solana/web3.js';
import {
  createBuybackJournal,
  type BuybackBudgetResult,
  type BuybackBudgetSource,
  type BuybackJournalEntry,
  type BuybackRevenueFigures,
} from './buyback.js';
import { createClaimReceiptJournal, type ClaimReceiptEntry } from './claims.js';
import {
  createRevenueForwardJournal,
  createRevenueForwardReader,
  type RevenueForwardEntry,
} from './revenue.js';
import {
  DEFAULT_RETRY,
  JobError,
  describeError,
  withRetry,
  type JobLogger,
  type Journal,
  type RetryOptions,
  type SettlementRpc,
} from './shared.js';

/** What the ledger says of a claim the claims job saw confirmed. */
export type ClaimFinality = 'finalized' | 'pending' | 'failed';

/** Funding statuses after which the SOL may have left the vault: counted as spent. */
const SPENT_FUNDING_STATUSES: ReadonlySet<string> = new Set(['requested', 'confirmed', 'unknown']);

export interface BuybackBudgetDeps {
  /** BUYBACK_REVENUE_SINCE, an ISO 8601 instant; null when unset (`unconfigured`). */
  since: string | null;
  /** FORGE_MULTISIG_VAULT: only the claims it received count. */
  vault: PublicKey;
  forwards: Journal<RevenueForwardEntry>;
  receipts: Journal<ClaimReceiptEntry>;
  buyback: Journal<BuybackJournalEntry>;
  /** Finality of a claim signature on the ledger (`rpcClaimFinality`). */
  finality: (signature: string) => Promise<ClaimFinality>;
  logger: JobLogger;
  now?: () => number;
  /** Run before anything is read; a throw makes the budget `unavailable` (directory check). */
  probe?: () => Promise<void>;
}

function parseIso(value: string, what: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new JobError('JOURNAL_CORRUPT', `${what} is not an ISO 8601 date`);
  }
  return ms;
}

/**
 * Finality of a signature from `getSignatureStatuses` (full history searched): `finalized` only
 * when the node reports it so without an error; unknown to the node or still confirmed ->
 * `pending` (never a guess); executed with an error -> `failed`.
 */
export function rpcClaimFinality(
  rpc: Pick<SettlementRpc, 'getSignatureState'>,
  retry: RetryOptions = DEFAULT_RETRY,
): (signature: string) => Promise<ClaimFinality> {
  return async (signature) => {
    const lookup = await withRetry(() => rpc.getSignatureState(signature), retry);
    const state = lookup.state;
    if (!state) return 'pending';
    if (state.err !== null && state.err !== undefined) return 'failed';
    return state.confirmationStatus === 'finalized' ? 'finalized' : 'pending';
  };
}

export function createBuybackBudgetSource(deps: BuybackBudgetDeps): BuybackBudgetSource {
  const { vault, forwards, receipts, buyback, finality, logger: log } = deps;
  const now = deps.now ?? Date.now;
  const vaultKey = vault.toBase58();

  /** Finalized creator claims to the vault settled at or after `sinceMs`; promotes as it goes. */
  async function claimsSince(sinceMs: number): Promise<BuybackRevenueFigures['claims']> {
    const totals = { count: 0, lamports: 0n, dbc: 0n, position: 0n, awaitingFinality: 0 };
    for (const { key, value: r } of await receipts.list()) {
      if (r.signature !== key) {
        throw new JobError('JOURNAL_CORRUPT', 'claim receipt does not match its key');
      }
      if (parseIso(r.settledAt, 'claim receipt settledAt') < sinceMs) continue;
      if (r.receiver !== vaultKey) {
        // The claim policy pins the receiver to the vault: anything else is not FORGE's revenue.
        log.warn({ signature: r.signature, receiver: r.receiver }, 'claim receipt not for the vault');
        continue;
      }
      let entry = r;
      if (entry.commitment !== 'finalized') {
        let state: ClaimFinality;
        try {
          state = await finality(entry.signature);
        } catch (err) {
          log.warn(
            { signature: entry.signature, err: describeError(err) },
            'claim finality unavailable: not counted yet',
          );
          totals.awaitingFinality++;
          continue;
        }
        if (state === 'failed') {
          log.error({ signature: entry.signature }, 'a confirmed claim shows an error: not counted');
          continue;
        }
        if (state === 'pending') {
          totals.awaitingFinality++;
          continue;
        }
        entry = { ...entry, commitment: 'finalized', finalizedAt: new Date(now()).toISOString() };
        await receipts.put(entry.signature, entry);
        log.info({ signature: entry.signature, kind: entry.kind }, 'claim receipt finalized');
      }
      const lamports = BigInt(entry.lamports);
      totals.count++;
      totals.lamports += lamports;
      if (entry.kind === 'dbc') totals.dbc += lamports;
      else totals.position += lamports;
    }
    return totals;
  }

  /** Spending-limit withdrawals the buyback journaled at or after `sinceMs`. */
  async function spentSince(sinceMs: number): Promise<BuybackRevenueFigures['spent']> {
    const totals = { withdrawals: 0, lamports: 0n };
    for (const { key, value } of await buyback.list()) {
      if (value.kind !== 'day') continue;
      if (key !== `day-${value.day}`) {
        throw new JobError('JOURNAL_CORRUPT', 'buyback day entry does not match its key');
      }
      const funding = value.funding;
      if (!funding || !SPENT_FUNDING_STATUSES.has(funding.status)) continue;
      if (parseIso(funding.at, 'buyback funding at') < sinceMs) continue;
      totals.withdrawals++;
      totals.lamports += BigInt(funding.lamports);
    }
    return totals;
  }

  return {
    async backlog(): Promise<BuybackBudgetResult> {
      const since = deps.since;
      if (since === null) {
        return { status: 'unconfigured', reason: 'BUYBACK_REVENUE_SINCE is not set' };
      }
      const sinceMs = Date.parse(since);
      if (!Number.isFinite(sinceMs)) {
        return { status: 'unconfigured', reason: 'BUYBACK_REVENUE_SINCE is not an ISO 8601 date' };
      }
      try {
        if (deps.probe) await deps.probe();
        const forwarded = await createRevenueForwardReader(forwards).totalForwardedSince(since);
        const claims = await claimsSince(sinceMs);
        const spent = await spentSince(sinceMs);
        const revenueLamports = forwarded.lamports + claims.lamports;
        const backlogLamports =
          revenueLamports > spent.lamports ? revenueLamports - spent.lamports : 0n;
        return {
          status: 'ok',
          figures: {
            since,
            forwards: {
              count: forwarded.count,
              lamports: forwarded.lamports,
              breakdown: forwarded.breakdown,
            },
            claims,
            revenueLamports,
            spent,
            backlogLamports,
          },
        };
      } catch (err) {
        const summary = describeError(err);
        log.error({ err: summary }, 'buyback budget unavailable');
        return { status: 'unavailable', reason: summary.message };
      }
    },
  };
}

export interface FileBuybackBudgetOptions {
  journalDir: string;
  since: string | null;
  vault: PublicKey;
  rpc: Pick<SettlementRpc, 'getSignatureState'>;
  logger: JobLogger;
  retry?: RetryOptions;
  now?: () => number;
}

/**
 * The production source: the three file journals of SIGNER_JOURNAL_DIR, the ledger for the
 * claims' finality, and a directory check first (a journal directory that cannot be listed, e.g.
 * a wrong SIGNER_JOURNAL_DIR after a move, must not read as "no revenue").
 */
export function createFileBuybackBudgetSource(opts: FileBuybackBudgetOptions): BuybackBudgetSource {
  const dir = path.resolve(opts.journalDir);
  return createBuybackBudgetSource({
    since: opts.since,
    vault: opts.vault,
    forwards: createRevenueForwardJournal(opts.journalDir),
    receipts: createClaimReceiptJournal(opts.journalDir),
    buyback: createBuybackJournal(opts.journalDir),
    finality: rpcClaimFinality(opts.rpc, opts.retry),
    logger: opts.logger,
    ...(opts.now ? { now: opts.now } : {}),
    probe: async () => {
      try {
        await fs.readdir(dir);
      } catch (err) {
        throw new JobError('JOURNAL_IO', describeError(err).code ?? 'journal directory unreadable');
      }
    },
  });
}
