/**
 * Wiring of the $FORGE buyback job (jobs/buyback.ts, task 4.2) as an optional job module.
 *
 * The job lives on its own branch; this adapter is typed against the slice of its module the
 * wiring uses (`BuybackLibrary`, structural), so that once it is merged the wiring is one line in
 * index.ts:
 *
 *   const EXTRA_JOBS = [buybackJobModule(await import('./jobs/buyback.js'))];
 *
 * What it wires: the settings from `buybackConfigFromEnv` (vault, FORGE_MINT from the startup
 * `requireAddresses`), the file journal, the Jupiter client, the Postgrest flags reader, and the
 * live-mode collaborators the process already has: keystore, RPC, swap preparer, token reader,
 * the shared `walletLock` and the watcher's `onBeforeSend`. No Squads spending-limit withdrawer
 * exists yet: the job refuses live mode at startup without one (simulation otherwise).
 */
import type { Connection, PublicKey } from '@solana/web3.js';
import type {
  BeforeSendHook,
  FlagsReader,
  JobAlerter,
  JobLogger,
  KeystoreLike,
  Mutex,
  SolanaRpc,
} from '../jobs/shared.js';
import type { EnvSource } from './env.js';
import type { SignerJobModule } from './modules.js';

export interface BuybackJupiterSettingsLike {
  baseUrl: string;
  apiKey?: string | undefined;
  minRequestIntervalMs: number;
  timeoutMs: number;
}

export interface BuybackDepsLike<Config> {
  config: Config;
  journal: unknown;
  flags: FlagsReader;
  alerter: JobAlerter;
  logger: JobLogger;
  quotes?: unknown;
  tickMs?: number;
  keystore?: KeystoreLike;
  rpc?: SolanaRpc;
  swapPreparer?: unknown;
  tokens?: unknown;
  walletLock?: Mutex;
  onBeforeSend?: BeforeSendHook;
}

/** The exports of jobs/buyback.ts this wiring uses (method syntax: checked structurally). */
export interface BuybackLibrary<Config extends { maxPriorityFeeLamports: bigint }> {
  buybackConfigFromEnv(
    env: EnvSource,
    addresses: { vault: PublicKey; forgeMint: PublicKey | null },
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
}

export function buybackJobModule<Config extends { maxPriorityFeeLamports: bigint }>(
  lib: BuybackLibrary<Config>,
): SignerJobModule {
  return {
    name: 'buyback',
    create(ctx) {
      const { config, tickMs, jupiter } = lib.buybackConfigFromEnv(ctx.env, {
        vault: ctx.addresses.vault,
        forgeMint: ctx.addresses.forgeMint,
      });
      const logger = ctx.jobLogger('buyback');
      const job = lib.createBuybackJob({
        config,
        journal: lib.createBuybackJournal(ctx.journalDir),
        flags: ctx.flags,
        alerter: ctx.alerter,
        logger,
        quotes: lib.createJupiterBuybackClient({
          ...jupiter,
          maxPriorityFeeLamports: config.maxPriorityFeeLamports,
          fetch: ctx.fetch,
        }),
        tickMs,
        keystore: ctx.keystore,
        rpc: ctx.rpc,
        swapPreparer: lib.createRpcBuybackSwapPreparer({
          connection: ctx.connection,
          keystore: ctx.keystore,
          maxPriorityFeeLamports: config.maxPriorityFeeLamports,
        }),
        tokens: lib.createRpcForgeTokenReader(ctx.connection),
        walletLock: ctx.walletLock,
        onBeforeSend: ctx.onBeforeSend,
      });
      logger.info({ mode: job.mode }, 'buyback job wired');
      return { runOnce: () => job.runOnce(), delayMs: () => tickMs };
    },
  };
}
