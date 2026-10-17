/**
 * The signer's scheduled jobs as modules over ONE shared context (one process, VPS 2):
 *
 * - one keystore, one RPC connection, one Supabase client, one flags reader, one alerter;
 * - one `walletLock` (Mutex) for every job spending from the cashbox or a bot wallet (cashbox
 *   sweep, refunds, fee conversion, buyback): they never sign concurrently;
 * - one expected-signature set of the outflow watcher: every job (and the signing routes) calls
 *   `onBeforeSend` -> `expected.expect(signature)` before a first broadcast, so the watcher
 *   never alerts on FORGE's own transactions.
 *
 * A module turns the context into a `ScheduledJob` (scheduler.ts). The jobs themselves
 * (jobs/*.ts) are only imported and configured here, from their own `...FromEnv` parsers.
 */
import type { Connection, VersionedTransaction } from '@solana/web3.js';
import { CLAIM_COMPUTE_UNITS, positionClaimComputeUnits } from '@forge/core';
import type pino from 'pino';
import type { QueueingAlerter } from '../alerts.js';
import type { SignerCore } from '../core-adapter.js';
import type { Keystore } from '../keystore.js';
import type { PayerReservations } from '../jobs/reservations.js';
import type { PriorityFees } from '../jobs/priority.js';
import {
  createCashboxJob,
  cashboxConfigFromEnv,
  createPostgrestCashboxStore,
  SweepJournalEntry,
} from '../jobs/cashbox.js';
import {
  ClaimJournalEntry,
  claimsConfigFromEnv,
  createClaimReceiptJournal,
  createClaimsJob,
  createPostgrestClaimsStore,
} from '../jobs/claims.js';
import {
  createJupiterClaimsJob,
  createJupiterClaimsJournal,
  jupiterClaimsConfigFromEnv,
} from '../jobs/jupiter-claims.js';
import {
  createFileLedger,
  createJupiterClient,
  createRpcBalanceSource,
  createRpcSwapSender,
  parseConvertConfig,
  runConvertOnce,
  type ConvertConfig,
  type ConvertDeps,
  type JupiterClient,
  type SwapSender,
} from '../jobs/convert.js';
import { createJupiterV2Client } from '../jobs/jupiter-v2.js';
import {
  RevenueForwardEntry,
  RevenueStateEntry,
  createRevenueJob,
  createRevenueRpc,
  revenueConfigFromEnv,
} from '../jobs/revenue.js';
import {
  RefundJournalEntry,
  RefundManualMark,
  createFileRefundLedger,
  createPostgrestRefundStore,
  createRefundsJob,
  refundsConfigFromEnv,
} from '../jobs/refunds.js';
import {
  JobError,
  base58Encode,
  createFileJournal,
  type BeforeSendHook,
  type FlagsReader,
  type JobLogger,
  type Mutex,
  type PostgrestClient,
  type SolanaRpc,
} from '../jobs/shared.js';
import {
  buildStaticAccounts,
  createSupabaseTargetSource,
  createWatchState,
  createWatchStateJournal,
  createWeb3WatchRpc,
  nextDelayMs,
  parseWatchConfig,
  restoreWatchState,
  runWatchCycle,
  type ExpectedSignatureLog,
  type ExpectedSignatures,
  type WatchDeps,
} from '../jobs/watch.js';
import type { PublicKey } from '@solana/web3.js';
import type { ConvertRole, EnvSource } from './env.js';
import type { ScheduledJob } from './scheduler.js';

export interface SignerAddresses {
  vault: PublicKey;
  cashbox: PublicKey;
  platformFee: PublicKey;
  meteoraReferral: PublicKey;
  jupiterReferral: PublicKey;
  /** FORGE_REVENUE_WALLET (D34): the keystore `revenue` wallet, also the platform fee wallet. */
  revenue: PublicKey;
  /** Null before the $FORGE launch. */
  forgeMint: PublicKey | null;
}

export interface KeyHandle {
  ref: string;
  publicKey: PublicKey;
}

export interface SignerJobContext {
  env: EnvSource;
  cluster: 'devnet' | 'mainnet-beta';
  addresses: SignerAddresses;
  connection: Connection;
  rpc: SolanaRpc;
  core: SignerCore;
  keystore: Keystore;
  /** Fixed keystore wallets, checked at startup (cashbox = FORGE_CASHBOX_WALLET). */
  payer: KeyHandle;
  cashbox: KeyHandle;
  /**
   * The revenue wallet (FORGE_REVENUE_WALLET) when the keystore `revenue` key is that address;
   * null on devnet when the wiring is refused (alerted, the revenue job is then off). On
   * mainnet-beta a refused wiring stops the startup (runtime.ts).
   */
  revenue: KeyHandle | null;
  /**
   * Priority fees of the jobs' own transactions (SIGNER_PRIORITY_FEE_*, jobs/priority.ts); the
   * core builders get the same setting through `core`.
   */
  priorityFees: PriorityFees;
  db: PostgrestClient;
  supabase: { url: string; serviceRoleKey: string };
  flags: FlagsReader;
  alerter: QueueingAlerter;
  logger: pino.Logger;
  jobLogger(name: string): JobLogger;
  /** Shared by every job that spends from the cashbox or a bot wallet. */
  walletLock: Mutex;
  /** Shared by everything that spends from the payer wallet: routes, payer-paid claims, payer conversions. */
  payerLock: Mutex;
  /** Payer lamports reserved by the routes' creations in flight (subtracted from its balance). */
  payerReservations: PayerReservations;
  expected: ExpectedSignatures;
  /** Where `expected.expect()` writes each announced signature before its broadcast; loaded by the watcher at start. */
  expectedLog: ExpectedSignatureLog;
  onBeforeSend: BeforeSendHook;
  journalDir: string;
  convertRoles: readonly ConvertRole[];
  convertIntervalMs: number;
  fetch: typeof fetch;
}

export interface SignerJobModule {
  readonly name: string;
  create(ctx: SignerJobContext): ScheduledJob | Promise<ScheduledJob>;
  /**
   * Optional modules (`extraJobs`) only: true when the module is not optional in this
   * environment, so a refused configuration stops the startup instead of disabling the module.
   */
  required?(ctx: SignerJobContext): boolean;
}

export const claimsModule: SignerJobModule = {
  name: 'claims',
  create(ctx) {
    const parsed = claimsConfigFromEnv(ctx.env, ctx.addresses.vault);
    const { intervalMs } = parsed;
    // Core prices the claims (ctx.core); the fee payer keeps their cap on top of its buffer.
    const config = {
      ...parsed.config,
      maxPriorityFeeLamports: ctx.priorityFees.maxFeeLamports(
        Math.max(CLAIM_COMPUTE_UNITS, positionClaimComputeUnits(1)),
      ),
    };
    const job = createClaimsJob({
      store: createPostgrestClaimsStore(ctx.db),
      core: ctx.core,
      priorityFees: ctx.priorityFees,
      rpc: ctx.rpc,
      keystore: ctx.keystore,
      journal: createFileJournal({
        dir: ctx.journalDir,
        namespace: 'claims',
        schema: ClaimJournalEntry,
      }),
      // Append-only, one file per claim the vault received: the buyback budget reads them.
      receipts: createClaimReceiptJournal(ctx.journalDir),
      flags: ctx.flags,
      alerter: ctx.alerter,
      logger: ctx.jobLogger('claims'),
      config,
      onBeforeSend: ctx.onBeforeSend,
      payerLock: ctx.payerLock,
      payerReservations: ctx.payerReservations,
    });
    return { runOnce: () => job.runOnce(), delayMs: () => intervalMs };
  },
};

/**
 * Jupiter referral fee claims (jobs/jupiter-claims.ts), mainnet-beta only: the referral program
 * does not exist elsewhere, so on any other cluster the module registers a job that does nothing
 * (health status `off`) after one log line. The configuration is parsed on every cluster.
 */
export const jupiterClaimsModule: SignerJobModule = {
  name: 'jupiter-claims',
  create(ctx) {
    const { config, intervalMs } = jupiterClaimsConfigFromEnv(ctx.env, {
      partner: ctx.addresses.revenue,
      jupiterReferral: ctx.addresses.jupiterReferral,
    });
    const logger = ctx.jobLogger('jupiter-claims');
    if (ctx.cluster !== 'mainnet-beta') {
      logger.info(
        { cluster: ctx.cluster },
        'jupiter referral claims off: the referral program only exists on mainnet-beta',
      );
      return { runOnce: async () => ({ status: 'off' }), delayMs: () => intervalMs };
    }
    const job = createJupiterClaimsJob({
      connection: ctx.connection,
      rpc: ctx.rpc,
      keystore: ctx.keystore,
      journal: createJupiterClaimsJournal(ctx.journalDir),
      flags: ctx.flags,
      alerter: ctx.alerter,
      logger,
      config,
      onBeforeSend: ctx.onBeforeSend,
      payerLock: ctx.payerLock,
      payerReservations: ctx.payerReservations,
      priorityFees: ctx.priorityFees,
    });
    logger.info({ mints: config.mints.length }, 'jupiter referral claims wired');
    return { runOnce: () => job.runOnce(), delayMs: () => intervalMs };
  },
};

export const cashboxModule: SignerJobModule = {
  name: 'cashbox',
  create(ctx) {
    const { config, intervalMs } = cashboxConfigFromEnv(ctx.env, {
      cashbox: ctx.addresses.cashbox,
      vault: ctx.addresses.vault,
    });
    const job = createCashboxJob({
      store: createPostgrestCashboxStore(ctx.db),
      rpc: ctx.rpc,
      core: ctx.core,
      keystore: ctx.keystore,
      journal: createFileJournal({
        dir: ctx.journalDir,
        namespace: 'cashbox',
        schema: SweepJournalEntry,
      }),
      flags: ctx.flags,
      alerter: ctx.alerter,
      logger: ctx.jobLogger('cashbox'),
      config,
      walletLock: ctx.walletLock,
      onBeforeSend: ctx.onBeforeSend,
      priorityFees: ctx.priorityFees,
    });
    return { runOnce: () => job.runOnce(), delayMs: () => intervalMs };
  },
};

export const refundsModule: SignerJobModule = {
  name: 'refunds',
  create(ctx) {
    const { config, intervalMs } = refundsConfigFromEnv(ctx.env, ctx.addresses.cashbox);
    const job = createRefundsJob({
      store: createPostgrestRefundStore(ctx.db),
      rpc: ctx.rpc,
      core: ctx.core,
      keystore: ctx.keystore,
      journal: createFileJournal({
        dir: ctx.journalDir,
        namespace: 'refunds',
        schema: RefundJournalEntry,
      }),
      manualMarks: createFileJournal({
        dir: ctx.journalDir,
        namespace: 'refund-manual',
        schema: RefundManualMark,
      }),
      // Append-only, never deleted: the record that makes a refund happen at most once.
      ledger: createFileRefundLedger(ctx.journalDir),
      flags: ctx.flags,
      alerter: ctx.alerter,
      logger: ctx.jobLogger('refunds'),
      config,
      walletLock: ctx.walletLock,
      onBeforeSend: ctx.onBeforeSend,
      priorityFees: ctx.priorityFees,
    });
    return { runOnce: () => job.runOnce(), delayMs: () => intervalMs };
  },
};

export const watchModule: SignerJobModule = {
  name: 'watch',
  async create(ctx) {
    const config = parseWatchConfig(ctx.env);
    const { addresses } = ctx;
    // The buyback bot wallet exists once --init-keys ran: watched for outflows like the payer.
    const buybackRef = await ctx.keystore.findRef('buyback');
    const buyback = buybackRef ? (await ctx.keystore.getPublicKey(buybackRef)).toBase58() : null;
    const deps: WatchDeps = {
      rpc: createWeb3WatchRpc(ctx.connection),
      targets: createSupabaseTargetSource({
        supabaseUrl: ctx.supabase.url,
        serviceRoleKey: ctx.supabase.serviceRoleKey,
        fetch: ctx.fetch,
        resolveCreator: async (ref) => (await ctx.keystore.getPublicKey(ref)).toBase58(),
        config,
      }),
      staticAccounts: buildStaticAccounts(
        {
          vault: addresses.vault.toBase58(),
          platformFee: addresses.platformFee.toBase58(),
          cashbox: addresses.cashbox.toBase58(),
          referrals: [addresses.meteoraReferral.toBase58(), addresses.jupiterReferral.toBase58()],
          payer: ctx.payer.publicKey.toBase58(),
          ...(buyback ? { buyback } : {}),
          revenue: addresses.revenue.toBase58(),
        },
        config,
      ),
      alerter: ctx.alerter,
      logger: ctx.jobLogger('watch'),
      config,
      state: createWatchState(),
      expected: ctx.expected,
      journal: createWatchStateJournal(ctx.journalDir),
      expectedLog: ctx.expectedLog,
    };
    return {
      init: async () => {
        await restoreWatchState(deps);
      },
      runOnce: async () => {
        const result = await runWatchCycle(deps);
        return { status: result.errors.length > 0 ? 'error' : 'ran' };
      },
      delayMs: () => nextDelayMs(config, deps.state.rpcErrorStreak),
    };
  },
};

/**
 * Jupiter swap sender signing with the keystore keys of `owners` (address -> ref) only, every
 * signature announced to the outflow watcher before its broadcast.
 */
function createKeystoreSwapSender(
  ctx: SignerJobContext,
  owners: ReadonlyMap<string, string>,
  maxPriorityFeeLamports: bigint,
): SwapSender {
  return createRpcSwapSender({
    connection: ctx.connection,
    maxPriorityFeeLamports,
    async signTransaction(owner: string, tx: VersionedTransaction) {
      const ref = owners.get(owner);
      if (!ref) throw new JobError('CONFIG', 'not a conversion wallet');
      await ctx.keystore.withSigner(ref, (signer) => {
        if (signer.publicKey.toBase58() !== owner) throw new JobError('SIGNER_MISMATCH');
        signer.signTransaction(tx);
      });
      const first = tx.signatures[0];
      if (!first || first.length !== 64 || first.every((b) => b === 0)) {
        throw new JobError('NOT_SIGNED', 'swap transaction is not signed');
      }
      // Signed, not sent yet: the watcher learns the signature first (a throw stops the send).
      ctx.onBeforeSend(base58Encode(first));
    },
  });
}

/**
 * The conversion's Jupiter client (JUPITER_SWAP_API): Swap API V2 by default (`/build`, the swap
 * assembled here from its instructions with the signer's priority fees, capped at
 * CONVERT_MAX_PRIORITY_FEE_LAMPORTS, its lookup tables read through `ctx.connection`), or the
 * Metis API (v1, the rollback path for one release).
 */
function createConvertJupiterClient(ctx: SignerJobContext, config: ConvertConfig): JupiterClient {
  const transport = {
    baseUrl: config.jupiterUrl,
    apiKey: config.apiKey,
    minRequestIntervalMs: config.minRequestIntervalMs,
    timeoutMs: config.requestTimeoutMs,
    fetch: ctx.fetch,
  };
  if (config.swapApi === 'v1') {
    return createJupiterClient({
      ...transport,
      maxPriorityFeeLamports: config.maxPriorityFeeLamports,
    });
  }
  return createJupiterV2Client({
    ...transport,
    connection: ctx.connection,
    priorityFees: ctx.priorityFees,
    maxPriorityFeeLamports: config.maxPriorityFeeLamports,
  });
}

export const convertModule: SignerJobModule = {
  name: 'convert',
  async create(ctx) {
    const config = parseConvertConfig(ctx.env, { cluster: ctx.cluster });
    // Wallets whose non-SOL fee balances are swapped to SOL: never the buyback bot (its $FORGE
    // goes to the vault, and FORGE_MINT is excluded anyway); the revenue wallet is converted by
    // its own job (revenueModule), which books the output by source.
    const owners = new Map<string, string>();
    for (const role of ctx.convertRoles) {
      const handle = role === 'cashbox' ? ctx.cashbox : ctx.payer;
      owners.set(handle.publicKey.toBase58(), handle.ref);
    }
    const buybackRef = await ctx.keystore.findRef('buyback');
    if (buybackRef) {
      const bot = (await ctx.keystore.getPublicKey(buybackRef)).toBase58();
      if (owners.has(bot)) throw new JobError('CONFIG', 'the buyback wallet is not converted');
    }
    if (owners.has(ctx.addresses.revenue.toBase58())) {
      throw new JobError('CONFIG', 'the revenue wallet is converted by the revenue job');
    }
    const sender = createKeystoreSwapSender(ctx, owners, config.maxPriorityFeeLamports);
    // Every conversion holds the wallet lock; one of the payer wallet also holds the payer lock
    // (shared with the signing routes and the claims). Order: wallet lock, then payer lock.
    const payerAddress = ctx.payer.publicKey.toBase58();
    const lockedSender: SwapSender = {
      send: (input) =>
        ctx.walletLock.runExclusive(() =>
          input.owner === payerAddress
            ? ctx.payerLock.runExclusive(() => sender.send(input))
            : sender.send(input),
        ),
    };
    const logger = ctx.jobLogger('convert');
    const deps: ConvertDeps = {
      jupiter: createConvertJupiterClient(ctx, config),
      balances: createRpcBalanceSource(ctx.connection, [...owners.keys()]),
      sender: lockedSender,
      ledger: createFileLedger(ctx.journalDir),
      journalDir: ctx.journalDir,
      flags: ctx.flags,
      alerter: ctx.alerter,
      logger,
      config,
      cluster: ctx.cluster,
      liveFlag: ctx.env.FORGE_CONVERT_LIVE,
    };
    logger.info({ jupiterSwapApi: config.swapApi }, 'convert job wired');
    return {
      runOnce: async () => {
        const summary = await runConvertOnce(deps);
        return { status: summary.status };
      },
      delayMs: () => ctx.convertIntervalMs,
    };
  },
};

/**
 * Revenue wallet job (jobs/revenue.ts): unwraps the wrapped SOL, converts the other balances
 * (mainnet-beta, through the conversion machinery of jobs/convert.ts over the revenue wallet
 * only, same policy and `convert_paused` switch) and forwards the native SOL to the vault.
 * Off (health status `off`) when the keystore has no `revenue` key matching FORGE_REVENUE_WALLET:
 * only possible on devnet, where the startup alerts instead of failing.
 */
export const revenueModule: SignerJobModule = {
  name: 'revenue',
  create(ctx) {
    const { config, intervalMs } = revenueConfigFromEnv(ctx.env, {
      revenue: ctx.addresses.revenue,
      vault: ctx.addresses.vault,
      meteoraReferral: ctx.addresses.meteoraReferral,
      // Priced per transaction by `priorityFees` (deps below), never a fixed price.
      computeUnitPriceMicroLamports: 0,
    });
    const logger = ctx.jobLogger('revenue');
    const revenue = ctx.revenue;
    if (!revenue) {
      logger.warn({}, 'revenue job off: the keystore revenue key is not FORGE_REVENUE_WALLET');
      return { runOnce: async () => ({ status: 'off' }), delayMs: () => intervalMs };
    }
    let convert: (() => ReturnType<typeof runConvertOnce>) | null = null;
    let jupiterSwapApi: ConvertConfig['swapApi'] | null = null;
    if (ctx.cluster === 'mainnet-beta') {
      const convertConfig = parseConvertConfig(ctx.env, { cluster: ctx.cluster });
      jupiterSwapApi = convertConfig.swapApi;
      const owner = revenue.publicKey.toBase58();
      const deps: ConvertDeps = {
        jupiter: createConvertJupiterClient(ctx, convertConfig),
        balances: createRpcBalanceSource(ctx.connection, [owner]),
        sender: createKeystoreSwapSender(
          ctx,
          new Map([[owner, revenue.ref]]),
          convertConfig.maxPriorityFeeLamports,
        ),
        ledger: createFileLedger(ctx.journalDir),
        journalDir: ctx.journalDir,
        flags: ctx.flags,
        alerter: ctx.alerter,
        logger,
        config: convertConfig,
        cluster: ctx.cluster,
        liveFlag: ctx.env.FORGE_CONVERT_LIVE,
      };
      convert = () => runConvertOnce(deps);
    }
    const job = createRevenueJob({
      rpc: createRevenueRpc(ctx.connection),
      core: ctx.core,
      keystore: ctx.keystore,
      journal: createFileJournal({
        dir: ctx.journalDir,
        namespace: 'revenue',
        schema: RevenueStateEntry,
      }),
      forwards: createFileJournal({
        dir: ctx.journalDir,
        namespace: 'revenue-forward',
        schema: RevenueForwardEntry,
      }),
      flags: ctx.flags,
      alerter: ctx.alerter,
      logger,
      config,
      cluster: ctx.cluster,
      convert,
      onBeforeSend: ctx.onBeforeSend,
      priorityFees: ctx.priorityFees,
    });
    logger.info(
      { dryRun: config.dryRun, conversions: convert !== null, jupiterSwapApi },
      'revenue job wired',
    );
    return { runOnce: () => job.runOnce(), delayMs: () => intervalMs };
  },
};

/** The jobs every signer process runs, in this order. */
export const BUILTIN_JOB_MODULES: readonly SignerJobModule[] = [
  claimsModule,
  jupiterClaimsModule,
  cashboxModule,
  refundsModule,
  watchModule,
  convertModule,
  revenueModule,
];
