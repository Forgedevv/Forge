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
import { Connection } from '@solana/web3.js';
import { pino } from 'pino';
import { CLUSTER_GENESIS_HASH } from '@forge/core';
import { createAlerterFromEnv } from '../alerts.js';
import { openKeystore, type Keystore } from '../keystore.js';
import { createJobLogger, requireRoleRef, rpcFromConnection } from '../jobs/shared.js';
import { createFileRouteJournals, createForgeRouteCore } from '../routes/index.js';
import { revokeLaunch, type RevokeResult } from '../routes/revoke.js';
import {
  dropConsumedSecrets,
  dropParsedSecrets,
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
