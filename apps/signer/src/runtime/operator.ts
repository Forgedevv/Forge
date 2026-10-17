/**
 * Operator commands of the signer, run as a separate short-lived process on VPS 2 with the same
 * environment as the service (index.ts):
 *
 *   --revoke-launch <jobId>   advances the launchpad's durable nonce with the creator wallet so a
 *                             handed-out launch transaction can no longer land (routes/revoke.ts),
 *                             journaled in SIGNER_JOURNAL_DIR; the next prepare rebuilds.
 *
 * Same fail-closed startup checks as the service for what the command uses: the environment
 * (runtime/env.ts, Telegram required in production), the instance lock of SIGNER_JOURNAL_DIR
 * (instance.ts: the command refuses to run while the service, or another command, holds it: it
 * writes the same journals), the keystore passphrase, the payer key, and the RPC genesis hash
 * against SOLANA_CLUSTER. Stop the service first, run the command, start the service again. The
 * secrets leave the environment once parsed (env.ts `dropParsedSecrets`).
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { pino } from 'pino';
import { CLUSTER_GENESIS_HASH } from '@forge/core';
import { createAlerterFromEnv } from '../alerts.js';
import { openKeystore, type Keystore } from '../keystore.js';
import {
  createFileJournal,
  createJobLogger,
  requireRoleRef,
  rpcFromConnection,
} from '../jobs/shared.js';
import { createPriorityFees } from '../jobs/priority.js';
import {
  REFERRAL_SETUP_JOURNAL_NAMESPACE,
  ReferralSetupEntry,
  runReferralSetup,
  type ReferralSetupOptions,
  type ReferralSetupResult,
} from '../jobs/referral-setup.js';
import { createExpectedSignatureLog } from '../jobs/watch.js';
import { createFileRouteJournals, createForgeRouteCore } from '../routes/index.js';
import { revokeLaunch, type RevokeResult } from '../routes/revoke.js';
import {
  dropConsumedSecrets,
  dropParsedSecrets,
  parseOperatorEnv,
  parseRuntimeEnv,
  type EnvSource,
} from './env.js';
import { acquireInstanceLock } from './instance.js';

export interface RevokeLaunchOptions {
  env: EnvSource;
  jobId: string;
  /** Injection for tests (no network). */
  connection?: Connection;
  fetch?: typeof fetch;
  logger?: pino.Logger;
}

export async function runRevokeLaunch(options: RevokeLaunchOptions): Promise<RevokeResult> {
  // An empty value is an unset one (as in the service runtime).
  const env: EnvSource = Object.fromEntries(
    Object.entries(options.env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const config = parseRuntimeEnv(env);
  dropParsedSecrets(env, options.env, process.env);
  const logger =
    options.logger ??
    pino({
      name: 'signer-operator',
      level: config.logLevel,
      redact: {
        paths: ['secret', 'passphrase', 'serviceRoleKey', 'headers'],
        censor: '[redacted]',
      },
    });
  const alerter = createAlerterFromEnv(logger.child({ module: 'alerts' }), env, {
    fetch: options.fetch ?? globalThis.fetch,
  });
  // The alerter holds the bot token; the command has no HMAC server and no Jupiter client.
  dropConsumedSecrets(env, options.env, process.env);
  // Never next to the running service (same journals): the lock is taken before the keystore.
  const lock = await acquireInstanceLock(config.journalDir, { command: 'revoke-launch' });
  let keystore: Keystore;
  try {
    keystore = await openKeystore({
      dir: config.keystoreDir,
      passphrase: config.keystorePassphrase,
      logger,
    });
  } catch (err) {
    await lock.release().catch(() => undefined);
    throw err;
  }
  try {
    await requireRoleRef(keystore, 'payer');
    const connection =
      options.connection ?? new Connection(config.rpcUrl, { commitment: 'confirmed' });
    if ((await connection.getGenesisHash()) !== CLUSTER_GENESIS_HASH[config.cluster]) {
      throw new Error(`RPC_URL does not serve SOLANA_CLUSTER (${config.cluster})`);
    }
    return await revokeLaunch(
      {
        core: createForgeRouteCore({ connection }),
        rpc: rpcFromConnection(connection),
        priorityFees: createPriorityFees(connection, config.priorityFee),
        keystore,
        journals: createFileRouteJournals(config.journalDir),
        alerter,
        logger: createJobLogger(logger, 'revoke'),
        onBeforeSend: () => undefined,
      },
      options.jobId,
    );
  } finally {
    await alerter.flushPending();
    await keystore.close();
    await lock.release().catch(() => undefined);
  }
}

/** `--setup-revenue-referrals [--name <name>] [--seed <seed>] [--send | --dry-run]`. */
export function parseSetupRevenueReferralsArgs(argv: readonly string[]): ReferralSetupOptions {
  const out: { name?: string; seed?: string; send: boolean } = { send: false };
  const start = argv.indexOf('--setup-revenue-referrals');
  if (start < 0) throw new Error('usage: --setup-revenue-referrals');
  for (let i = start + 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--send') {
      out.send = true;
    } else if (arg === '--dry-run') {
      out.send = false;
    } else if (arg === '--name' || arg === '--seed') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`usage: ${arg} <value>`);
      if (arg === '--name') out.name = value;
      else out.seed = value;
      i++;
    } else {
      throw new Error(
        'usage: --setup-revenue-referrals [--name <name>] [--seed <seed>] [--send | --dry-run]',
      );
    }
  }
  return out;
}

export interface SetupRevenueReferralsOptions extends ReferralSetupOptions {
  env: EnvSource;
  /** Injection for tests (no network). */
  connection?: Connection;
  logger?: pino.Logger;
  print?: (line: string) => void;
}

/**
 * `--setup-revenue-referrals` (jobs/referral-setup.ts): the one-off creation of the revenue
 * wallet's Meteora referral account and, on mainnet-beta, of its named Jupiter referral account
 * with its collection accounts. Dry run unless `send`.
 *
 * Environment: the operator subset (`parseOperatorEnv`: cluster, RPC, keystore, journals,
 * priority fees), so it runs before the service is fully configured; `FORGE_REVENUE_WALLET`,
 * `FORGE_METEORA_REFERRAL_ACCOUNT` and `FORGE_JUPITER_REFERRAL_ACCOUNT` are read when set and
 * checked against the keystore and the chain (an address that disagrees is a refusal). Same
 * fail-closed startup as the service for what it uses: the instance lock (the service must be
 * stopped: the command writes the journals and the watcher's expected-signature log), the
 * keystore passphrase, the `payer` and `revenue` keys, the RPC genesis hash against
 * SOLANA_CLUSTER. The payer signs alone; every signature is appended to `watch.expected.log`
 * before its broadcast, so the restarted service never raises a false outflow alert for the
 * rents the payer paid.
 */
export async function runSetupRevenueReferrals(
  options: SetupRevenueReferralsOptions,
): Promise<ReferralSetupResult> {
  const env: EnvSource = Object.fromEntries(
    Object.entries(options.env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const config = parseOperatorEnv(env);
  dropParsedSecrets(env, options.env, process.env);
  dropConsumedSecrets(env, options.env, process.env);
  const logger =
    options.logger ??
    pino({
      name: 'signer-operator',
      level: config.logLevel,
      redact: {
        paths: ['secret', 'passphrase', 'serviceRoleKey', 'headers'],
        censor: '[redacted]',
      },
    });
  // Optional here: the command produces the two referral addresses; set ones must agree.
  const optional = (name: string): PublicKey | null => {
    const value = env[name];
    if (value === undefined) return null;
    let key: PublicKey;
    try {
      key = new PublicKey(value);
    } catch {
      throw new Error(`${name} is not a valid public key`);
    }
    if (key.toBase58() !== value || key.equals(PublicKey.default)) {
      throw new Error(`${name} is not a valid public key`);
    }
    return key;
  };
  const configuredRevenue = optional('FORGE_REVENUE_WALLET');
  const configured = {
    meteoraReferral: optional('FORGE_METEORA_REFERRAL_ACCOUNT'),
    jupiterReferral: optional('FORGE_JUPITER_REFERRAL_ACCOUNT'),
  };
  const lock = await acquireInstanceLock(config.journalDir, { command: 'setup-revenue-referrals' });
  let keystore: Keystore;
  try {
    keystore = await openKeystore({
      dir: config.keystoreDir,
      passphrase: config.keystorePassphrase,
      logger,
    });
  } catch (err) {
    await lock.release().catch(() => undefined);
    throw err;
  }
  try {
    const payer = await requireRoleRef(keystore, 'payer');
    const revenue = await requireRoleRef(keystore, 'revenue', configuredRevenue ?? undefined);
    const connection =
      options.connection ?? new Connection(config.rpcUrl, { commitment: 'confirmed' });
    if ((await connection.getGenesisHash()) !== CLUSTER_GENESIS_HASH[config.cluster]) {
      throw new Error(`RPC_URL does not serve SOLANA_CLUSTER (${config.cluster})`);
    }
    const expectedLog = createExpectedSignatureLog(config.journalDir);
    return await runReferralSetup(
      {
        cluster: config.cluster,
        connection,
        rpc: rpcFromConnection(connection),
        keystore,
        payer,
        revenue: revenue.publicKey,
        configured,
        journal: createFileJournal({
          dir: config.journalDir,
          namespace: REFERRAL_SETUP_JOURNAL_NAMESPACE,
          schema: ReferralSetupEntry,
        }),
        onBeforeSend: (signature) => expectedLog.append({ signature, at: Date.now() }),
        logger: createJobLogger(logger, 'referral-setup'),
        ...(options.print ? { print: options.print } : {}),
        priorityFees: createPriorityFees(connection, config.priorityFee),
      },
      { name: options.name, seed: options.seed, send: options.send },
    );
  } finally {
    await keystore.close();
    await lock.release().catch(() => undefined);
  }
}
