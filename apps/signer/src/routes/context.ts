/**
 * Shared plumbing of the signing routes: dependencies, the checks every signing request goes
 * through (job, launchpad, spec, payment, kill switch), the creator wallet, the launchpad locks
 * and the compare-and-set writes of the launchpad addresses.
 */
import { PublicKey } from '@solana/web3.js';
import {
  LAUNCH_METADATA_BUDGET_BYTES,
  LaunchCoinError,
  METADATA_LIMITS,
  assertLaunchMetadata,
  launchMetadataBytes,
  parseLaunchpadSpec,
} from '@forge/core';
import type { LaunchpadSpec } from '@forge/shared';
import { creatorRole, type Keystore } from '../keystore.js';
import {
  DEFAULT_MIN_PAYMENT_LAMPORTS,
  DEFAULT_RETRY,
  Mutex,
  PAYMENT_USD_BY_KIND,
  checkPaused,
  createAnnouncer,
  parseAddress,
  realSleep,
  requireRoleRef,
  sendAlert,
  type BeforeSendHook,
  type FlagsReader,
  type JobAlerter,
  type JobLogger,
  type KeystoreLike,
  type PaymentMinimums,
  type RetryOptions,
  type SettleTiming,
  type SolanaRpc,
} from '../jobs/shared.js';
import { PayerReservations } from '../jobs/reservations.js';
import type { AlertFn, CreationEnv } from './accounts.js';
import { DEFAULT_MAX_LAUNCHPADS_PER_DAY, MAX_LAUNCHPADS_PER_DAY } from './budget.js';
import { fail } from './errors.js';
import type { RouteJournals } from './journal.js';
import type { RouteCore } from './onchain.js';
import type { RoutePaymentVerifier } from './payment.js';
import type {
  LaunchpadAddressColumn,
  RouteJob,
  RouteLaunchpad,
  RoutePayment,
  RouteStore,
} from './store.js';

/** Kill switch of the signing routes (docs/OPERATIONS.md): the deploy pipeline is stopped. */
export const ROUTES_FLAG = 'deploys_paused' as const;

export type RouteKeystore = KeystoreLike & Pick<Keystore, 'createKey'>;

export interface SignerRoutesConfig {
  /**
   * Metadata URI of the launchpad coin, with `{slug}` or `{launchpadId}` (SIGNER_COIN_METADATA_URL).
   * After substitution it must be a canonical https URL that fits the launch transaction next to
   * the longest coin name and symbol: at most `MAX_METADATA_URI_BYTES` (106) bytes with the
   * longest slug (32) or launchpad id (36). Checked at startup (`assertMetadataTemplate`).
   */
  metadataUriTemplate: string;
  /** Priority fee of the config and nonce creations (micro-lamports per CU, default 0). */
  computeUnitPriceMicroLamports?: number;
  /** Bounded wait for a creation to confirm within one request (default 45 s). */
  settle?: Partial<SettleTiming>;
  /** Failed or expired creation transactions tolerated per account (default 3). */
  maxCreateAttempts?: number;
  /** Launch transactions built per job (rebuilds after an advanced nonce, default 10). */
  maxLaunchBuilds?: number;
  /** Lamports kept on top of the rent for the network fees (default 0.001 SOL). */
  payerFeeBufferLamports?: bigint;
  /** Local kill switch (SIGNER_ROUTES_PAUSED). */
  paused?: boolean;
  /**
   * New launchpads the routes create accounts for per UTC day (SIGNER_MAX_LAUNCHPADS_PER_DAY,
   * default 20, budget.ts). Past it, new launchpads are refused (503, alerted).
   */
  maxLaunchpadsPerDay?: number;
  /**
   * Floors on the confirmed payment rows a route acts on, per kind (SIGNER_MIN_*_PAYMENT_LAMPORTS,
   * default `DEFAULT_MIN_PAYMENT_LAMPORTS`): a row below its floor, or whose `usd_amount` is not
   * the shared price of its kind, is refused (409, alerted) before any key or payer spend. The
   * database alone must never decide how little a launchpad is worth.
   */
  minPaymentLamports?: PaymentMinimums;
}

export interface SignerRoutesDeps {
  store: RouteStore;
  core: RouteCore;
  rpc: SolanaRpc;
  keystore: RouteKeystore;
  /** On-chain proof of the creation payment (core verifyPayment, finalized). */
  payments: RoutePaymentVerifier;
  flags: FlagsReader;
  journals: RouteJournals;
  alerter: JobAlerter;
  logger: JobLogger;
  config: SignerRoutesConfig;
  /** Called with each signature right before its first broadcast (watcher expected set). */
  onBeforeSend: BeforeSendHook;
  /** Serializes every spend of the payer wallet by the routes (created when absent). */
  payerLock?: Mutex;
  /**
   * Payer lamports promised to creations in flight, shared with the jobs that check the payer
   * balance (created when absent).
   */
  payerReservations?: PayerReservations;
  retry?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DEFAULT_ROUTE_SETTLE: SettleTiming = {
  timeoutMs: 45_000,
  pollMs: 2_000,
  rebroadcastMs: 6_000,
};
export const DEFAULT_MAX_CREATE_ATTEMPTS = 3;
export const DEFAULT_MAX_LAUNCH_BUILDS = 10;
export const DEFAULT_PAYER_FEE_BUFFER_LAMPORTS = 1_000_000n;

/** One lock per key (launchpad id): requests for the same launchpad never interleave. */
export class KeyedMutex {
  readonly #locks = new Map<string, { mutex: Mutex; users: number }>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.#locks.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(), users: 0 };
      this.#locks.set(key, entry);
    }
    entry.users++;
    try {
      return await entry.mutex.runExclusive(fn);
    } finally {
      entry.users--;
      if (entry.users === 0) this.#locks.delete(key);
    }
  }

  get size(): number {
    return this.#locks.size;
  }
}

export interface RouteRuntime {
  deps: SignerRoutesDeps;
  store: RouteStore;
  core: RouteCore;
  rpc: SolanaRpc;
  keystore: RouteKeystore;
  payments: RoutePaymentVerifier;
  journals: RouteJournals;
  log: JobLogger;
  alert: AlertFn;
  announce: (signature: string) => boolean;
  retry: RetryOptions;
  settle: SettleTiming;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  payerLock: Mutex;
  reservations: PayerReservations;
  locks: KeyedMutex;
  /** Serializes the daily admissions of new launchpads (budget.ts). */
  admissionLock: Mutex;
  maxLaunchpadsPerDay: number;
  minPaymentLamports: PaymentMinimums;
  maxCreateAttempts: number;
  maxLaunchBuilds: number;
  payerFeeBufferLamports: bigint;
  computeUnitPriceMicroLamports: number;
  metadataUriTemplate: string;
}

export function createRouteRuntime(deps: SignerRoutesDeps): RouteRuntime {
  const { config } = deps;
  const cuPrice = config.computeUnitPriceMicroLamports ?? 0;
  if (!Number.isSafeInteger(cuPrice) || cuPrice < 0) {
    throw new Error('computeUnitPriceMicroLamports must be a non-negative integer');
  }
  assertMetadataTemplate(config.metadataUriTemplate);
  const maxLaunchpadsPerDay = config.maxLaunchpadsPerDay ?? DEFAULT_MAX_LAUNCHPADS_PER_DAY;
  if (
    !Number.isSafeInteger(maxLaunchpadsPerDay) ||
    maxLaunchpadsPerDay < 1 ||
    maxLaunchpadsPerDay > MAX_LAUNCHPADS_PER_DAY
  ) {
    throw new Error(
      `maxLaunchpadsPerDay must be an integer between 1 and ${MAX_LAUNCHPADS_PER_DAY}`,
    );
  }
  const minPaymentLamports = config.minPaymentLamports ?? DEFAULT_MIN_PAYMENT_LAMPORTS;
  for (const [kind, floor] of Object.entries(minPaymentLamports)) {
    if (typeof floor !== 'bigint' || floor < 0n) {
      throw new Error(`minPaymentLamports.${kind} must be a non-negative bigint`);
    }
  }
  const log = deps.logger;
  return {
    deps,
    store: deps.store,
    core: deps.core,
    rpc: deps.rpc,
    keystore: deps.keystore,
    payments: deps.payments,
    journals: deps.journals,
    log,
    alert: (level, code, message, details, dedupKey) =>
      sendAlert(deps.alerter, log, level, code, message, details, dedupKey),
    announce: createAnnouncer(deps.onBeforeSend, log),
    retry: deps.retry ?? DEFAULT_RETRY,
    settle: { ...DEFAULT_ROUTE_SETTLE, ...config.settle },
    sleep: deps.sleep ?? realSleep,
    now: deps.now ?? Date.now,
    payerLock: deps.payerLock ?? new Mutex(),
    reservations: deps.payerReservations ?? new PayerReservations(),
    locks: new KeyedMutex(),
    admissionLock: new Mutex(),
    maxLaunchpadsPerDay,
    minPaymentLamports,
    maxCreateAttempts: config.maxCreateAttempts ?? DEFAULT_MAX_CREATE_ATTEMPTS,
    maxLaunchBuilds: config.maxLaunchBuilds ?? DEFAULT_MAX_LAUNCH_BUILDS,
    payerFeeBufferLamports: config.payerFeeBufferLamports ?? DEFAULT_PAYER_FEE_BUFFER_LAMPORTS,
    computeUnitPriceMicroLamports: cuPrice,
    metadataUriTemplate: config.metadataUriTemplate,
  };
}

// ---------------------------------------------------------------------------------------
// Kill switch

export async function assertRoutesNotPaused(rt: RouteRuntime): Promise<void> {
  const pause = await checkPaused(rt.deps.flags, ROUTES_FLAG, rt.deps.config.paused, rt.log);
  if (!pause.paused) return;
  if (pause.reason === 'flag_missing' || pause.reason === 'flags_unavailable') {
    await rt.alert(
      'high',
      `signer_routes_paused_${pause.reason}`,
      pause.reason === 'flag_missing'
        ? 'The signing routes refuse requests: the "deploys_paused" flag row is missing'
        : 'The signing routes refuse requests: the flags table cannot be read',
      { flag: ROUTES_FLAG },
      `signer_routes_paused_${pause.reason}`,
    );
    fail(503, 'flags_unavailable');
  }
  fail(503, 'deploys_paused');
}

// ---------------------------------------------------------------------------------------
// Request checks

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OnchainSetup {
  job: RouteJob;
  launchpad: RouteLaunchpad;
  spec: LaunchpadSpec;
  owner: PublicKey;
  /** The confirmed creation payments of the job (each one proven on-chain by payment.ts). */
  payments: RoutePayment[];
}

/**
 * Re-reads and checks everything a signing route acts on (INTERFACES §7): a `create_launchpad`
 * job in `onchain_setup`, its `draft` launchpad, the spec re-validated by core with the owner
 * wallet of the row, at least one confirmed creation payment by that wallet (with its
 * transaction signature, at least the floor of its kind, priced at the shared dollar price) and
 * none refunded (status `refunded` or a `refund_signature`), and the `deploys_paused` kill
 * switch (fail closed).
 * The payment rows are only the database's word: `assertCreationPaid` (payment.ts) proves them
 * on-chain before anything is spent.
 */
export async function loadOnchainSetup(rt: RouteRuntime, jobId: string): Promise<OnchainSetup> {
  const job = await rt.store.getJob(jobId);
  if (!job) fail(404, 'job_not_found');
  if (job.type !== 'create_launchpad') fail(409, 'not_a_creation_job');
  if (job.status !== 'onchain_setup') fail(409, 'job_not_in_onchain_setup');
  if (!UUID_RE.test(job.launchpadId)) fail(409, 'invalid_launchpad_id');
  const launchpad = await rt.store.getLaunchpad(job.launchpadId);
  if (!launchpad || launchpad.id !== job.launchpadId) fail(404, 'launchpad_not_found');
  if (launchpad.status !== 'draft') fail(409, 'launchpad_not_draft');

  const spec = parseLaunchpadSpec(launchpad.spec);
  const owner = parseAddress(spec.ownerWallet);
  if (!owner || spec.ownerWallet !== launchpad.ownerWallet) fail(422, 'spec_owner_mismatch');

  const payments = await rt.store.listPayments(jobId);
  // A refund sent (refund_signature set) counts as refunded even if the status lags behind.
  if (payments.some((p) => p.status === 'refunded' || p.refundSignature !== null)) {
    fail(409, 'payment_refunded');
  }
  const confirmed = payments.filter((p) => p.status === 'confirmed' && p.kind === 'creation');
  if (confirmed.length === 0) fail(409, 'payment_not_confirmed');
  if (confirmed.some((p) => p.payerWallet !== launchpad.ownerWallet || p.lamports <= 0n)) {
    fail(409, 'payment_mismatch');
  }
  if (confirmed.some((p) => !p.txSignature)) fail(409, 'payment_signature_missing');
  await assertPaymentRowsPlausible(rt, jobId, confirmed);

  await assertRoutesNotPaused(rt);
  return { job, launchpad, spec, owner, payments: confirmed };
}

/**
 * The amount and the price of a payment row are the database's word alone (the on-chain proof
 * checks the transaction against the row, not the row against the offer): a row below the floor
 * of its kind, or priced at anything but the shared dollar price, is refused and alerted before
 * any key is created or any lamport of rent is spent.
 */
async function assertPaymentRowsPlausible(
  rt: RouteRuntime,
  jobId: string,
  payments: readonly RoutePayment[],
): Promise<void> {
  for (const p of payments) {
    const floor = rt.minPaymentLamports[p.kind];
    if (p.lamports < floor) {
      await rt.alert(
        'high',
        'payment_below_minimum',
        'A confirmed payment row is below the floor of its kind: nothing was signed, check the row and the quote',
        { jobId, paymentId: p.id, kind: p.kind, lamports: p.lamports, floor },
        `payment_below_minimum:${p.id}`,
      );
      fail(409, 'payment_below_minimum');
    }
    const price = PAYMENT_USD_BY_KIND[p.kind];
    if (!Number.isFinite(p.usdAmount) || p.usdAmount !== price) {
      await rt.alert(
        'high',
        'payment_price_mismatch',
        'A confirmed payment row is not priced at the shared price of its kind: nothing was signed, check the row',
        { jobId, paymentId: p.id, kind: p.kind, usdAmount: p.usdAmount, expected: price },
        `payment_price_mismatch:${p.id}`,
      );
      fail(409, 'payment_price_mismatch');
    }
  }
}

/**
 * Runs `fn` under the lock of the job's launchpad, with everything re-read inside the lock.
 * The launchpad is resolved once outside (a cheap refusal before queuing) and again inside; a job
 * that points at another launchpad by then is refused (409, alerted): `fn` must never act on a
 * launchpad whose lock it does not hold.
 */
export async function withLaunchpadLock<T>(
  rt: RouteRuntime,
  jobId: string,
  fn: (setup: OnchainSetup) => Promise<T>,
): Promise<T> {
  const outside = await loadOnchainSetup(rt, jobId);
  const locked = outside.launchpad.id;
  return rt.locks.run(locked, async () => {
    const setup = await loadOnchainSetup(rt, jobId);
    if (setup.launchpad.id !== locked || setup.job.launchpadId !== locked) {
      await rt.alert(
        'high',
        'job_launchpad_changed',
        'A creation job points at another launchpad than a moment ago: request refused, manual check needed',
        { jobId, lockedLaunchpadId: locked, launchpadId: setup.launchpad.id },
        `job_launchpad_changed:${jobId}`,
      );
      fail(409, 'launchpad_changed');
    }
    return fn(setup);
  });
}

// ---------------------------------------------------------------------------------------
// Keys

export interface KeyRefWithAddress {
  ref: string;
  publicKey: PublicKey;
}

/**
 * The launchpad's creator wallet (keystore role `creator:<launchpadId>`), created if absent.
 * Refuses when the row already points at another keystore ref.
 */
export async function ensureCreatorWallet(
  rt: RouteRuntime,
  launchpad: RouteLaunchpad,
): Promise<KeyRefWithAddress> {
  const created = await rt.keystore.createKey(creatorRole(launchpad.id));
  if (launchpad.creatorWalletRef !== null && launchpad.creatorWalletRef !== created.ref) {
    await rt.alert(
      'high',
      'creator_ref_mismatch',
      'The launchpad row points at a creator wallet that is not the keystore one: manual check needed',
      { launchpadId: launchpad.id },
      `creator_ref_mismatch:${launchpad.id}`,
    );
    fail(409, 'creator_ref_mismatch');
  }
  if (created.created) {
    rt.log.info(
      { launchpadId: launchpad.id, ref: created.ref, address: created.publicKey.toBase58() },
      'creator wallet created',
    );
  }
  return { ref: created.ref, publicKey: created.publicKey };
}

export async function payerOf(rt: RouteRuntime): Promise<KeyRefWithAddress> {
  return requireRoleRef(rt.keystore, 'payer');
}

export function creationEnv(rt: RouteRuntime, payer: KeyRefWithAddress): CreationEnv {
  return {
    rpc: rt.rpc,
    keystore: rt.keystore,
    payer,
    payerLock: rt.payerLock,
    reservations: rt.reservations,
    announce: rt.announce,
    assertNotPaused: () => assertRoutesNotPaused(rt),
    retry: rt.retry,
    settle: rt.settle,
    sleep: rt.sleep,
    now: rt.now,
    logger: rt.log,
    alert: rt.alert,
    maxAttempts: rt.maxCreateAttempts,
    payerFeeBufferLamports: rt.payerFeeBufferLamports,
  };
}

// ---------------------------------------------------------------------------------------
// Launchpad row (compare-and-set)

const COLUMN_FIELD: Record<LaunchpadAddressColumn, keyof RouteLaunchpad> = {
  launchpad_config: 'launchpadConfig',
  launchpad_coin_config: 'launchpadCoinConfig',
  launchpad_coin_mint: 'launchpadCoinMint',
  creator_wallet_ref: 'creatorWalletRef',
};

/**
 * Writes `want` into the launchpad row. A column already holding the wanted value is left as is;
 * a null column, or one holding a value listed in `replaceable`, is written (compare-and-set on
 * its current value); any other value is a conflict (409, alerted): never overwritten.
 */
export async function recordLaunchpadColumns(
  rt: RouteRuntime,
  launchpadId: string,
  want: Partial<Record<LaunchpadAddressColumn, string>>,
  replaceable: Partial<Record<LaunchpadAddressColumn, readonly string[]>> = {},
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await rt.store.getLaunchpad(launchpadId);
    if (!row) fail(404, 'launchpad_not_found');
    const values: Partial<Record<LaunchpadAddressColumn, string>> = {};
    const expected: Partial<Record<LaunchpadAddressColumn, string | null>> = {};
    for (const [column, value] of Object.entries(want) as [LaunchpadAddressColumn, string][]) {
      const current = row[COLUMN_FIELD[column]] as string | null;
      if (current === value) continue;
      if (current !== null && !(replaceable[column] ?? []).includes(current)) {
        await rt.alert(
          'high',
          'launchpad_address_conflict',
          'A launchpad row already holds another on-chain address than the signer: manual check needed',
          { launchpadId, column },
          `launchpad_address_conflict:${launchpadId}:${column}`,
        );
        fail(409, 'launchpad_address_conflict');
      }
      values[column] = value;
      expected[column] = current;
    }
    if (Object.keys(values).length === 0) return;
    if (await rt.store.setLaunchpadColumns(launchpadId, values, expected)) return;
    // Lost a race: re-read and decide again (once).
  }
  fail(503, 'launchpad_update_conflict');
}

// ---------------------------------------------------------------------------------------
// Metadata URI

const PLACEHOLDER_RE = /\{(slug|launchpadId)\}/g;

/**
 * Longest value of each placeholder: a slug is at most 32 characters of `[a-z0-9-]`, a launchpad
 * id is a lowercase UUID (36 characters). Both are ASCII, so characters = bytes.
 */
const LONGEST_PLACEHOLDER_VALUE = {
  slug: 'a'.repeat(32),
  launchpadId: '00000000-0000-0000-0000-000000000000',
} as const;

/**
 * Longest metadata URI the launch transaction holds next to the longest coin name and symbol
 * (core `LAUNCH_METADATA_BUDGET_BYTES` minus the Metaplex name and symbol limits): 106 bytes.
 */
export const MAX_METADATA_URI_BYTES =
  LAUNCH_METADATA_BUDGET_BYTES - METADATA_LIMITS.name - METADATA_LIMITS.symbol;

/**
 * Startup check of SIGNER_COIN_METADATA_URL: exactly one `{slug}` or `{launchpadId}`, https, and
 * with the longest value of that placeholder a canonical URL of at most `MAX_METADATA_URI_BYTES`.
 * Every spec the shared schema accepts (name <= 32 bytes, symbol <= 10) then fits the launch
 * transaction: a too long template would only fail at /v1/launch-coin/prepare, after the
 * configs are paid for.
 */
export function assertMetadataTemplate(template: string): void {
  if (typeof template !== 'string' || template.length === 0) {
    throw new Error('SIGNER_COIN_METADATA_URL is required');
  }
  const placeholders = template.match(PLACEHOLDER_RE) ?? [];
  if (placeholders.length !== 1) {
    throw new Error('SIGNER_COIN_METADATA_URL must contain exactly one {slug} or {launchpadId}');
  }
  let url: URL;
  try {
    url = new URL(template.replace(PLACEHOLDER_RE, 'x'));
  } catch {
    throw new Error('SIGNER_COIN_METADATA_URL must be an absolute URL');
  }
  if (url.protocol !== 'https:') throw new Error('SIGNER_COIN_METADATA_URL must use https');

  const longest = template.replace(PLACEHOLDER_RE, (_m, name: 'slug' | 'launchpadId') => {
    return LONGEST_PLACEHOLDER_VALUE[name];
  });
  const bytes = launchMetadataBytes('', '', longest);
  if (bytes > MAX_METADATA_URI_BYTES) {
    throw new Error(
      `SIGNER_COIN_METADATA_URL is too long: ${bytes} bytes with the longest ${placeholders[0]}, at most ${MAX_METADATA_URI_BYTES} (the launch transaction holds ${LAUNCH_METADATA_BUDGET_BYTES} bytes of coin name + symbol + metadata URI)`,
    );
  }
  // The exact rules core applies at launch (canonical https URL), on the longest URI.
  try {
    assertLaunchMetadata('N', 'NN', longest);
  } catch (error) {
    if (!(error instanceof LaunchCoinError)) throw error;
    throw new Error(`SIGNER_COIN_METADATA_URL is refused by the launch: ${error.message}`, {
      cause: error,
    });
  }
}

/** The coin metadata URI of a launchpad (slug and id are URL-safe by construction). */
export function metadataUriFor(template: string, launchpad: RouteLaunchpad): string {
  if (!/^[a-z0-9-]{3,32}$/.test(launchpad.slug)) fail(409, 'invalid_slug');
  return template.replace(PLACEHOLDER_RE, (_m, name: string) =>
    name === 'slug' ? launchpad.slug : launchpad.id,
  );
}
