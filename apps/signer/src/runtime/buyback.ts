/**
 * Wiring of the $FORGE buyback job (jobs/buyback.ts) as a job module (modules.ts).
 *
 * What it wires: the settings from `buybackConfigFromEnv` (vault and FORGE_MINT from the startup
 * `requireAddresses`), the file journals, the Postgrest flags reader, the live collaborators the
 * process already has (keystore, RPC, token reader, the shared `walletLock`, the watcher's
 * `onBeforeSend`), the revenue budget source (jobs/buyback-budget.ts: the forwards, claim
 * receipts and buyback journals of SIGNER_JOURNAL_DIR from BUYBACK_REVENUE_SINCE, the RPC for
 * the claims' finality), the Squads v4 spending-limit withdrawer (jobs/squads.ts) when
 * FORGE_SQUADS_MULTISIG and FORGE_SQUADS_SPENDING_LIMIT are set, and the buy route:
 * - `jupiter` (default, the only route on mainnet-beta): Jupiter quote client + the RPC swap
 *   preparer (static allowlist + simulation + keystore signature);
 * - `dbc-devnet` (devnet only, startup error on mainnet-beta): core `buildBuyTx` on
 *   BUYBACK_DEVNET_DBC_POOL (jobs/buyback-dbc.ts).
 * Without a withdrawer the job stays in simulation (and refuses a live request at startup).
 *
 * The module is optional (a refused configuration disables it with an alert, runtime.ts), except
 * on mainnet-beta with FORGE_BUYBACK_LIVE set: there a refused configuration stops the signer.
 *
 * The module is typed against a structural slice of the job library (`BuybackLibrary`) so the
 * runtime tests can replace it; production uses the real modules (`buybackJobModule()`).
 */
import type { Connection, PublicKey } from '@solana/web3.js';
import {
  buybackConfigFromEnv,
  createBuybackJob,
  createBuybackJournal,
  createJupiterBuybackClient,
  createRpcBuybackSwapPreparer,
  createRpcForgeTokenReader,
  type BuybackRouteKind,
} from '../jobs/buyback.js';
import { createFileBuybackBudgetSource } from '../jobs/buyback-budget.js';
import { createDbcDevnetBuybackRoute } from '../jobs/buyback-dbc.js';
import {
  createSquadsJournal,
  createSquadsSpendingLimitWithdrawer,
  squadsConfigFromEnv,
} from '../jobs/squads.js';
import {
  JobError,
  type BeforeSendHook,
  type FlagsReader,
  type JobAlerter,
  type JobLogger,
  type KeystoreLike,
  type Mutex,
  type SolanaRpc,
} from '../jobs/shared.js';
import type { EnvSource } from './env.js';
import type { SignerJobModule } from './modules.js';

export interface BuybackJupiterSettingsLike {
  baseUrl: string;
  apiKey?: string | undefined;
  minRequestIntervalMs: number;
  timeoutMs: number;
}

export interface BuybackConfigLike {
  maxPriorityFeeLamports: bigint;
  route: BuybackRouteKind;
  devnetPool: PublicKey | null;
  /** BUYBACK_REVENUE_SINCE (null when unset: the budget source reports it unconfigured). */
  revenueSince: string | null;
}

export interface BuybackDepsLike<Config> {
  config: Config;
  journal: unknown;
  flags: FlagsReader;
  alerter: JobAlerter;
  logger: JobLogger;
  quotes?: unknown;
  budget?: unknown;
  tickMs?: number;
  withdrawer?: unknown;
  keystore?: KeystoreLike;
  rpc?: SolanaRpc;
  swapPreparer?: unknown;
  tokens?: unknown;
  walletLock?: Mutex;
  onBeforeSend?: BeforeSendHook;
}

export interface SquadsConfigLike {
  multisig: PublicKey;
  spendingLimit: PublicKey;
  vaultIndex: number;
  vault: PublicKey;
}

/** The exports of jobs/buyback.ts, jobs/squads.ts and jobs/buyback-dbc.ts this wiring uses. */
export interface BuybackLibrary<Config extends BuybackConfigLike> {
  buybackConfigFromEnv(
    env: EnvSource,
    addresses: { vault: PublicKey; forgeMint: PublicKey | null },
    /** The runtime's resolved cluster: the mode decision must not read the raw variable. */
    options: { cluster: string },
  ): { config: Config; tickMs: number; jupiter: BuybackJupiterSettingsLike };
  createBuybackJournal(dir: string): unknown;
  createJupiterBuybackClient(
    opts: BuybackJupiterSettingsLike & { maxPriorityFeeLamports: bigint; fetch?: typeof fetch },
  ): unknown;
  createRpcBuybackSwapPreparer(opts: {
    connection: Connection;
    keystore: KeystoreLike;
    maxPriorityFeeLamports: bigint;
  }): unknown;
  createRpcForgeTokenReader(connection: Connection): unknown;
  createFileBuybackBudgetSource(opts: {
    journalDir: string;
    since: string | null;
    vault: PublicKey;
    rpc: SolanaRpc;
    logger: JobLogger;
  }): unknown;
  createBuybackJob(deps: BuybackDepsLike<Config>): {
    readonly mode: string;
    runOnce(): Promise<unknown>;
  };
  squadsConfigFromEnv(env: EnvSource, vault: PublicKey): SquadsConfigLike | null;
  createSquadsJournal(dir: string): unknown;
  createSquadsSpendingLimitWithdrawer(opts: {
    config: SquadsConfigLike;
    connection: Connection;
    rpc: SolanaRpc;
    keystore: KeystoreLike;
    journal: unknown;
    logger: JobLogger;
  }): unknown;
  createDbcDevnetBuybackRoute(opts: {
    connection: Connection;
    pool: PublicKey;
    forgeMint: PublicKey;
    env: EnvSource;
    keystore: KeystoreLike;
    cluster: string | undefined;
    maxPriorityFeeLamports: bigint;
  }): { quotes: unknown; swapPreparer: unknown };
}

/** The real job modules. */
export const REAL_BUYBACK_LIBRARY = {
  buybackConfigFromEnv,
  createBuybackJournal,
  createJupiterBuybackClient,
  createRpcBuybackSwapPreparer,
  createRpcForgeTokenReader,
  createFileBuybackBudgetSource,
  createBuybackJob,
  squadsConfigFromEnv,
  createSquadsJournal,
  createSquadsSpendingLimitWithdrawer: (opts: {
    config: ReturnType<typeof squadsConfigFromEnv> & object;
    connection: Connection;
    rpc: SolanaRpc;
    keystore: KeystoreLike;
    journal: ReturnType<typeof createSquadsJournal>;
    logger: JobLogger;
  }) => createSquadsSpendingLimitWithdrawer(opts),
  createDbcDevnetBuybackRoute,
} satisfies BuybackLibrary<ReturnType<typeof buybackConfigFromEnv>['config']>;

/**
 * FORGE_BUYBACK_LIVE asks for live mode: any value but unset or "false" (a malformed value is
 * refused by the configuration, and counts as a live request here: fail closed).
 */
export function buybackLiveRequested(env: EnvSource): boolean {
  const value = env.FORGE_BUYBACK_LIVE ?? '';
  return value !== '' && value !== 'false';
}

export function buybackJobModule<Config extends BuybackConfigLike>(
  lib: BuybackLibrary<Config> = REAL_BUYBACK_LIBRARY as unknown as BuybackLibrary<Config>,
): SignerJobModule {
  return {
    name: 'buyback',
    // A live buyback on mainnet-beta is not optional: its refused configuration stops the
    // signer at startup. Elsewhere (devnet, simulation) it only disables the module, alerted.
    required: (ctx) => ctx.cluster === 'mainnet-beta' && buybackLiveRequested(ctx.env),
    create(ctx) {
      const { config, tickMs, jupiter } = lib.buybackConfigFromEnv(
        ctx.env,
        { vault: ctx.addresses.vault, forgeMint: ctx.addresses.forgeMint },
        { cluster: ctx.cluster },
      );
      const logger = ctx.jobLogger('buyback');

      // Squads v4 spending limit of the bot (optional: simulation without it).
      const squads = lib.squadsConfigFromEnv(ctx.env, ctx.addresses.vault);
      const withdrawer = squads
        ? lib.createSquadsSpendingLimitWithdrawer({
            config: squads,
            connection: ctx.connection,
            rpc: ctx.rpc,
            keystore: ctx.keystore,
            journal: lib.createSquadsJournal(ctx.journalDir),
            logger: ctx.jobLogger('squads'),
          })
        : undefined;

      // Buy route: Jupiter on mainnet-beta; the devnet DBC pool for the devnet test only.
      let quotes: unknown;
      let swapPreparer: unknown;
      if (config.route === 'dbc-devnet') {
        if (ctx.cluster !== 'devnet') {
          throw new JobError('CONFIG', 'BUYBACK_ROUTE=dbc-devnet is refused off devnet');
        }
        if (!config.devnetPool) throw new JobError('CONFIG', 'BUYBACK_DEVNET_DBC_POOL is required');
        if (!ctx.addresses.forgeMint) {
          throw new JobError('CONFIG', 'BUYBACK_ROUTE=dbc-devnet needs FORGE_MINT');
        }
        ({ quotes, swapPreparer } = lib.createDbcDevnetBuybackRoute({
          connection: ctx.connection,
          pool: config.devnetPool,
          forgeMint: ctx.addresses.forgeMint,
          env: ctx.env,
          keystore: ctx.keystore,
          cluster: ctx.cluster,
          maxPriorityFeeLamports: config.maxPriorityFeeLamports,
        }));
      } else {
        quotes = lib.createJupiterBuybackClient({
          ...jupiter,
          maxPriorityFeeLamports: config.maxPriorityFeeLamports,
          fetch: ctx.fetch,
        });
        swapPreparer = lib.createRpcBuybackSwapPreparer({
          connection: ctx.connection,
          keystore: ctx.keystore,
          maxPriorityFeeLamports: config.maxPriorityFeeLamports,
        });
      }

      // The revenue backlog (D35): forwards, claim receipts and the buyback's own withdrawals
      // since BUYBACK_REVENUE_SINCE, from the journal directory; the RPC settles the claims'
      // finality. Unset on mainnet-beta live is refused by the configuration above; elsewhere
      // the job alerts and plans nothing.
      const budget = lib.createFileBuybackBudgetSource({
        journalDir: ctx.journalDir,
        since: config.revenueSince,
        vault: ctx.addresses.vault,
        rpc: ctx.rpc,
        logger: ctx.jobLogger('buyback-budget'),
      });

      const job = lib.createBuybackJob({
        config,
        journal: lib.createBuybackJournal(ctx.journalDir),
        flags: ctx.flags,
        alerter: ctx.alerter,
        logger,
        quotes,
        budget,
        tickMs,
        ...(withdrawer !== undefined ? { withdrawer } : {}),
        keystore: ctx.keystore,
        rpc: ctx.rpc,
        swapPreparer,
        tokens: lib.createRpcForgeTokenReader(ctx.connection),
        walletLock: ctx.walletLock,
        onBeforeSend: ctx.onBeforeSend,
      });
      logger.info(
        {
          mode: job.mode,
          route: config.route,
          withdrawer: withdrawer !== undefined,
          revenueSince: config.revenueSince,
        },
        'buyback job wired',
      );
      return { runOnce: () => job.runOnce(), delayMs: () => tickMs };
    },
  };
}
