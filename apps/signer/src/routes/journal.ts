/**
 * Durable state of the signing routes (file journals in SIGNER_JOURNAL_DIR, see jobs/shared.ts:
 * atomic writes, a corrupt entry stops the route instead of being guessed around).
 *
 * - `configs.<launchpadId>`: the two config creations of a launchpad;
 * - `nonce.<launchpadId>`: the durable nonce account creation of a launchpad;
 * - `launch.<jobId>`: the prepared launch transaction of a creation job.
 *
 * An account creation records every transaction BEFORE it is first broadcast (signature, signed
 * bytes, last valid block height): after a crash the same bytes are re-sent or settled, and a new
 * transaction (with a new one-time key) is only built once the previous one is proven to have
 * failed or expired. No private key is ever written: only public keys, signatures and signed
 * transactions.
 */
import { z } from 'zod';
import { OwnerTransactionSummary } from '@forge/shared';
import { createFileJournal, createMemoryJournal, type Journal } from '../jobs/shared.js';

const Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
const IsoTime = z.string().min(1);

/** One signed creation transaction. */
export const CreationAttempt = z.object({
  /** The account this transaction creates (public key of the one-time key). */
  address: Address,
  signature: Signature,
  /** Signed transaction, base64. */
  rawTx: z.string().min(1),
  lastValidBlockHeight: z.number().int().nonnegative(),
  recordedAt: IsoTime,
  /** Last broadcast refusal (preflight), if any. */
  lastError: z.string().nullable(),
});
export type CreationAttempt = z.infer<typeof CreationAttempt>;

export const CreationHistoryItem = z.object({
  address: Address,
  signature: Signature,
  outcome: z.enum(['failed', 'expired']),
  error: z.string().nullable(),
  at: IsoTime,
});

/** Creation of one account (a config or the nonce account), created at most once. */
export const AccountCreation = z.object({
  /** Hash of what the account is created from (config parameters, nonce authority). */
  paramsHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(['open', 'in_flight', 'confirmed']),
  /** The transaction in flight (status in_flight) or the one that created the account. */
  current: CreationAttempt.nullable(),
  /** Set once confirmed: the created account. */
  address: Address.nullable(),
  confirmedAt: IsoTime.nullable(),
  /** Transactions proven failed or expired (each one replaced by a new key). */
  history: z.array(CreationHistoryItem).max(50),
});
export type AccountCreation = z.infer<typeof AccountCreation>;

export const ConfigsJournalEntry = z.object({
  v: z.literal(1),
  launchpadId: z.string(),
  jobId: z.string(),
  ownerWallet: Address,
  creatorRef: z.string(),
  creator: Address,
  launchpad: AccountCreation.nullable(),
  launchpadCoin: AccountCreation.nullable(),
  /** When both addresses (and the creator ref) were written to the launchpad row. */
  recordedAt: IsoTime.nullable(),
});
export type ConfigsJournalEntry = z.infer<typeof ConfigsJournalEntry>;

export const NonceJournalEntry = z.object({
  v: z.literal(1),
  launchpadId: z.string(),
  /** Nonce authority = the launchpad's creator wallet. */
  authority: Address,
  creation: AccountCreation.nullable(),
});
export type NonceJournalEntry = z.infer<typeof NonceJournalEntry>;

export const LaunchDetails = z.object({
  pool: Address,
  config: Address,
  nonceAccount: Address,
  creator: Address,
  /** Raw base units (6 decimals), decimal strings. */
  expectedTokensOut: z.string().regex(/^[0-9]+$/),
  minimumTokensOut: z.string().regex(/^[0-9]+$/),
  referral: z.enum(['forge', 'explicit', 'none']),
  metadataUri: z.string().url(),
});
export type LaunchDetails = z.infer<typeof LaunchDetails>;

export const LaunchJournalEntry = z.object({
  v: z.literal(1),
  jobId: z.string(),
  launchpadId: z.string(),
  owner: Address,
  mint: Address,
  /** Nonce value the transaction is bound to (its recent blockhash). */
  nonceValue: Address,
  /** Hash of the inputs the transaction was built from (spec, config, metadata URI). */
  inputsHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Partially signed (creator + mint) launch transaction, base64. */
  partiallySignedTx: z.string().min(1),
  summary: OwnerTransactionSummary,
  details: LaunchDetails,
  builtAt: IsoTime,
  /** Number of launch transactions built for this job (a rebuild follows an advanced nonce). */
  builds: z.number().int().positive(),
  /** Mints of previous builds whose nonce advanced without a launch. */
  replacedMints: z.array(Address).max(50),
});
export type LaunchJournalEntry = z.infer<typeof LaunchJournalEntry>;

export interface RouteJournals {
  configs: Journal<ConfigsJournalEntry>;
  nonces: Journal<NonceJournalEntry>;
  launches: Journal<LaunchJournalEntry>;
}

export function createFileRouteJournals(dir: string): RouteJournals {
  return {
    configs: createFileJournal({ dir, namespace: 'configs', schema: ConfigsJournalEntry }),
    nonces: createFileJournal({ dir, namespace: 'nonce', schema: NonceJournalEntry }),
    launches: createFileJournal({ dir, namespace: 'launch', schema: LaunchJournalEntry }),
  };
}

export function createMemoryRouteJournals(): RouteJournals {
  return {
    configs: createMemoryJournal(ConfigsJournalEntry),
    nonces: createMemoryJournal(NonceJournalEntry),
    launches: createMemoryJournal(LaunchJournalEntry),
  };
}
