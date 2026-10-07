/**
 * Thin Solana helpers: connection, send + confirm with retries, balance reads, Solscan links.
 * The RPC URL is never printed.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type Finality,
  type Signer,
} from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { loadEnv, describeRpc } from './env.js';

export const COMMITMENT: Finality = 'confirmed';

let connection: Connection | undefined;

export function getConnection(): Connection {
  if (!connection) {
    const env = loadEnv();
    connection = new Connection(env.rpcUrl, { commitment: COMMITMENT });
    console.log(`RPC: ${describeRpc(env.rpcUrl)} (cluster: ${env.cluster})`);
  }
  return connection;
}

export function solscanTx(signature: string): string {
  return `https://solscan.io/tx/${signature}?cluster=devnet`;
}

export function solscanAccount(address: PublicKey | string): string {
  return `https://solscan.io/account/${address.toString()}?cluster=devnet`;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function getBalance(pubkey: PublicKey): Promise<bigint> {
  return BigInt(await getConnection().getBalance(pubkey, COMMITMENT));
}

/** Token balance of an account, 0n when the account does not exist. */
export async function getTokenAccountBalance(tokenAccount: PublicKey): Promise<bigint> {
  try {
    const acc = await getAccount(getConnection(), tokenAccount, COMMITMENT);
    return acc.amount;
  } catch {
    return 0n;
  }
}

export function ata(owner: PublicKey, mint: PublicKey, programId = TOKEN_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, programId);
}

export interface SendOptions {
  /** Extra signers besides the fee payer. */
  signers?: Signer[];
  /** Number of attempts on blockhash expiry / transient RPC errors. */
  attempts?: number;
  /** Simulate before sending and print the logs on failure. */
  label?: string;
}

/**
 * Confirmation by polling `getSignatureStatuses` (no websocket: the RPC rate-limits subscriptions,
 * which made web3.js report "expired" for transactions that had landed).
 */
export async function confirmBySignature(signature: string, lastValidBlockHeight: number): Promise<void> {
  const conn = getConnection();
  for (;;) {
    const status = (await conn.getSignatureStatuses([signature])).value[0];
    if (status) {
      if (status.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
    }
    const height = await conn.getBlockHeight(COMMITMENT);
    if (height > lastValidBlockHeight) {
      // One last look: the transaction may have landed in the final blocks.
      const last = (await conn.getSignatureStatuses([signature])).value[0];
      if (last && !last.err && last.confirmationStatus) return;
      throw new TransactionExpiredBlockheightExceededError(signature);
    }
    await sleep(1500);
  }
}

/**
 * Signs with `feePayer` (+ signers), sends and confirms. Retries on blockhash expiry or transient
 * network errors; a program error (custom error, simulation failure) is thrown immediately with logs.
 */
export async function sendAndConfirm(tx: Transaction, feePayer: Keypair, opts: SendOptions = {}): Promise<string> {
  const conn = getConnection();
  const attempts = opts.attempts ?? 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(COMMITMENT);
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = feePayer.publicKey;
      tx.signatures = [];
      tx.sign(feePayer, ...(opts.signers ?? []));
      const raw = tx.serialize();
      const signature = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
      await confirmBySignature(signature, lastValidBlockHeight);
      console.log(`    tx ${opts.label ?? ''} ${signature} (${raw.length} bytes)`);
      return signature;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        err instanceof TransactionExpiredBlockheightExceededError ||
        /block height exceeded|Blockhash not found|fetch failed|ECONNRESET|ETIMEDOUT|429|503|timed out/i.test(msg);
      if (!transient || attempt === attempts) {
        const logs = (err as { logs?: string[] }).logs;
        if (logs) console.error(logs.join('\n'));
        throw err;
      }
      console.warn(`    retry ${attempt}/${attempts}: ${msg.slice(0, 120)}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

/** Sends an already fully signed transaction (test 3: signed by several parties). */
export async function sendSigned(tx: Transaction, label?: string): Promise<string> {
  const conn = getConnection();
  const raw = tx.serialize();
  const signature = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  await confirmBySignature(signature, tx.lastValidBlockHeight!);
  console.log(`    tx ${label ?? ''} ${signature} (${raw.length} bytes)`);
  return signature;
}

export async function transferSol(from: Keypair, to: PublicKey, lamports: bigint, label?: string): Promise<string> {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }),
  );
  return sendAndConfirm(tx, from, { label: label ?? 'transfer' });
}

/** Fee actually paid by the transaction (lamports), from the confirmed transaction meta. */
export async function getTxFee(signature: string): Promise<bigint> {
  const tx = await getConnection().getTransaction(signature, {
    commitment: COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  return BigInt(tx?.meta?.fee ?? 0);
}

/** Program log lines of a confirmed transaction. */
export async function getTxLogs(signature: string): Promise<string[]> {
  const tx = await getConnection().getTransaction(signature, {
    commitment: COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  return tx?.meta?.logMessages ?? [];
}

export function formatSol(lamports: bigint): string {
  return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}
