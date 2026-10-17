/**
 * Entry point of the signer (VPS 2). Production command: `pnpm --filter @forge/signer start`
 * (= `tsx src/index.ts`, no file watcher), run under a process supervisor that restarts it;
 * `pnpm --filter @forge/signer dev` (tsx watch) is for local development only.
 *
 *   (no argument)  starts the HMAC server and the scheduled jobs (runtime/runtime.ts);
 *   --init-keys    creates the fixed keystore wallets (payer, cashbox, buyback, revenue) when
 *                  absent and prints their PUBLIC addresses (set FORGE_CASHBOX_WALLET,
 *                  FORGE_REVENUE_WALLET and FORGE_PLATFORM_FEE_WALLET from it, fund the payer),
 *                  then exits. Needs only SIGNER_KEYSTORE_PASSPHRASE / SIGNER_KEYSTORE_DIR.
 *   --revoke-launch <jobId>
 *                  advances the launchpad's durable nonce with its creator wallet, so the launch
 *                  transaction handed out for that job can no longer land; journaled, then the
 *                  next prepare builds a new one (runtime/operator.ts, routes/revoke.ts). Same
 *                  environment as the service, which must be stopped first (both take the
 *                  instance lock of SIGNER_JOURNAL_DIR). Exit code 3: sent but not settled yet,
 *                  run again.
 *   --setup-revenue-referrals [--name <name>] [--seed <seed>] [--send]
 *                  one-off setup of the revenue wallet's referral accounts (jobs/referral-setup.ts,
 *                  docs/MAINNET.md section 5): the Meteora referral account (a standalone
 *                  wrapped-SOL token account owned by the revenue wallet, any cluster) and, on
 *                  mainnet-beta only, the named Jupiter referral account of the Ultra project
 *                  (partner = the revenue wallet, default name `forge`) with its wrapped SOL and
 *                  USDC collection accounts. The payer wallet signs alone. Reads the chain first
 *                  and skips what exists and matches; refuses (exit code 2, nothing sent) what
 *                  exists and does not match. Dry run by default: prints the plan; `--send`
 *                  sends. Prints the env lines to set (FORGE_METEORA_REFERRAL_ACCOUNT,
 *                  FORGE_JUPITER_REFERRAL_ACCOUNT). Needs SOLANA_CLUSTER, RPC_URL, the keystore
 *                  and journal variables, SIGNER_PRIORITY_FEE_*; the two FORGE_*_REFERRAL_ACCOUNT
 *                  variables and FORGE_REVENUE_WALLET are checked when set. Service stopped
 *                  first (instance lock). Exit code 3: sent but not settled yet, run again.
 *
 * Every variable is documented in apps/signer/.env.example. Back up SIGNER_KEYSTORE_DIR and
 * SIGNER_JOURNAL_DIR together: the journals are what makes every payment and account creation
 * happen at most once, and the refund ledger in it (`refund-ledger.*`, append-only) what makes
 * every refund happen at most once.
 */
import { pino } from 'pino';
import { keystoreOptionsFromEnv, openKeystore } from './keystore.js';
import { describeError } from './jobs/shared.js';
import {
  parseSetupRevenueReferralsArgs,
  runRevokeLaunch,
  runSetupRevenueReferrals,
} from './runtime/operator.js';
import { createSignerRuntime } from './runtime/runtime.js';
import type { SignerJobModule } from './runtime/modules.js';
import { buybackJobModule } from './runtime/buyback.js';

/**
 * Optional job modules: the $FORGE buyback (simulation unless the Squads spending limit is
 * configured and live mode is enabled, runtime/buyback.ts). Required, and so fatal when refused,
 * on mainnet-beta with FORGE_BUYBACK_LIVE set.
 */
const EXTRA_JOBS: SignerJobModule[] = [buybackJobModule()];

const log = pino({ name: 'signer-main' });

async function initKeys(): Promise<void> {
  const keystore = await openKeystore({ ...keystoreOptionsFromEnv(process.env), logger: log });
  try {
    for (const role of ['payer', 'cashbox', 'buyback', 'revenue'] as const) {
      const key = await keystore.createKey(role);
      log.info(
        { role, address: key.publicKey.toBase58(), created: key.created },
        'keystore wallet',
      );
    }
  } finally {
    await keystore.close();
  }
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--init-keys')) {
    await initKeys();
    return;
  }
  if (argv.includes('--setup-revenue-referrals')) {
    const args = parseSetupRevenueReferralsArgs(argv);
    const result = await runSetupRevenueReferrals({ env: process.env, ...args });
    log.info(
      {
        dryRun: result.dryRun,
        meteora: { status: result.meteora.status, account: result.meteora.account },
        jupiter: { status: result.jupiter.status, account: result.jupiter.account },
        exitCode: result.exitCode,
      },
      'revenue referral accounts setup',
    );
    process.exitCode = result.exitCode;
    return;
  }
  const revoke = argv.indexOf('--revoke-launch');
  if (revoke >= 0) {
    const jobId = argv[revoke + 1];
    if (!jobId || jobId.startsWith('--')) throw new Error('usage: --revoke-launch <jobId>');
    const result = await runRevokeLaunch({ env: process.env, jobId });
    log.info({ result }, 'launch revocation');
    if (result.status === 'pending') process.exitCode = 3;
    return;
  }
  const runtime = await createSignerRuntime({ env: process.env, extraJobs: EXTRA_JOBS });
  await runtime.start();
  let exiting = false;
  const shutdown = (signal: string) => {
    if (exiting) return;
    exiting = true;
    log.info({ signal }, 'shutting down');
    runtime.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error({ err: describeError(err) }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main(process.argv.slice(2)).catch((err: unknown) => {
  // Scrubbed summary only: no URL, no secret, no key material.
  log.fatal({ err: describeError(err) }, 'signer failed to start');
  process.exit(1);
});
