/**
 * Wiring of the $FORGE buyback job (jobs/buyback.ts) as a job module (modules.ts).
 *
 * What it wires: the settings from `buybackConfigFromEnv` (vault and FORGE_MINT from the startup
 * `requireAddresses`), the file journals, the Postgrest flags reader, the live collaborators the
 * process already has (keystore, RPC, token reader, the shared `walletLock`, the watcher's
 * `onBeforeSend`), the Squads v4 spending-limit withdrawer (jobs/squads.ts) when
 * FORGE_SQUADS_MULTISIG and FORGE_SQUADS_SPENDING_LIMIT are set, and the buy route:
 * - `jupiter` (default, the only route on mainnet-beta): Jupiter quote client + the RPC swap
 *   preparer (static allowlist + simulation + keystore signature);
 * - `dbc-devnet` (devnet only, startup error on mainnet-beta): core `buildBuyTx` on
 *   BUYBACK_DEVNET_DBC_POOL (jobs/buyback-dbc.ts).
 * Without a withdrawer the job stays in simulation (and refuses a live request at startup).
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
}

export interface BuybackDepsLike<Config> {
  config: Config;
  journal: unknown;
  flags: FlagsReader;
  alerter: JobAlerter;
  logger: JobLogger;
  quotes?: unknown;
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

export function buybackJobModule<Config extends BuybackConfigLike>(
  lib: BuybackLibrary<Config> = REAL_BUYBACK_LIBRARY as unknown as BuybackLibrary<Config>,
): SignerJobModule {
  return {
    name: 'buyback',
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

      const job = lib.createBuybackJob({
        config,
        journal: lib.createBuybackJournal(ctx.journalDir),
        flags: ctx.flags,
        alerter: ctx.alerter,
        logger,
        quotes,
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
        { mode: job.mode, route: config.route, withdrawer: withdrawer !== undefined },
        'buyback job wired',
      );
      return { runOnce: () => job.runOnce(), delayMs: () => tickMs };
    },
  };
}
