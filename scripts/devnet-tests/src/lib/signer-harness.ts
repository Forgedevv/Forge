/**
 * Runs the signer's job code (apps/signer/src/jobs) on devnet with the throwaway wallets of these
 * scripts: a keystore-shaped signer over existing keypairs (scripts/devnet-tests is the only
 * place allowed to hold such keypairs outside the signer, PLANEXECUTE rule 5), and console
 * loggers/alerters. Only public data is printed.
 */
import { randomBytes } from 'node:crypto';
import type { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import type { KeystoreSigner } from '../../../../apps/signer/src/keystore.js';
import {
  scrubText,
  type JobAlerter,
  type JobLogger,
  type KeystoreLike,
} from '../../../../apps/signer/src/jobs/shared.js';

export function consoleLogger(prefix: string): JobLogger {
  const out =
    (level: string) =>
    (fields: Record<string, unknown>, msg: string): void => {
      const json = JSON.stringify(fields, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      console.log(scrubText(`    [${prefix}:${level}] ${msg} ${json}`).slice(0, 400));
    };
  return { debug: () => undefined, info: out('info'), warn: out('warn'), error: out('error') };
}

export function consoleAlerter(alerts: string[]): JobAlerter {
  return {
    async alert(level, code, message, details) {
      alerts.push(code);
      console.log(
        scrubText(`    ALERT [${level}] ${code}: ${message} ${JSON.stringify(details ?? {})}`),
      );
    },
  };
}

/** Keystore-shaped signer over existing devnet wallets (script-only stand-in). */
export function walletKeystore(roles: Record<string, Keypair>): KeystoreLike {
  const byRef = new Map<string, { role: string; keypair: Keypair }>();
  const refOf = new Map<string, string>();
  for (const [role, keypair] of Object.entries(roles)) {
    const ref = `ks_${randomBytes(16).toString('hex')}`;
    byRef.set(ref, { role, keypair });
    refOf.set(role, ref);
  }
  const entry = (ref: string) => {
    const e = byRef.get(ref);
    if (!e) throw new Error('unknown ref');
    return e;
  };
  return {
    findRef: async (role) => refOf.get(role),
    getPublicKey: async (ref) => entry(ref).keypair.publicKey,
    withSigner: async (ref, fn) => {
      const { role, keypair } = entry(ref);
      const signer: KeystoreSigner = {
        ref,
        role: role as KeystoreSigner['role'],
        publicKey: keypair.publicKey,
        signTransaction(tx: Transaction | VersionedTransaction) {
          if ('message' in tx) tx.sign([keypair]);
          else tx.partialSign(keypair);
        },
        signMessage() {
          throw new Error('not needed');
        },
      };
      return fn(signer);
    },
  };
}
