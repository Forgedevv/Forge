import { ClientError, type OnTxPhase, type TxPhase, type TxResult } from '@forge/shared';
import { SendTransactionError, VersionedTransaction } from '@solana/web3.js';
import { base58Encode, base64ToBytes, bytesToBase64 } from './base58';
import { defaultMessage, errorMessage, isUserRejection, networkError } from './errors';
import { getSessionSnapshot } from './session-store';
import { getWalletBridge } from './wallet-bridge';

export const CONFIRM_POLL_MS = 1000;
export const CONFIRM_TIMEOUT_MS = 60_000;

export function requireWallet() {
  const bridge = getWalletBridge();
  if (!bridge.publicKey || !bridge.signTransaction) {
    throw new ClientError('UNAUTHORIZED', 'Connect your wallet first.');
  }
  return { publicKey: bridge.publicKey, signTransaction: bridge.signTransaction, bridge };
}

/**
 * The connected wallet, which must be the signed-in (session) wallet: transactions are checked
 * against the session wallet before the wallet is asked to sign.
 */
export function requireSessionWallet() {
  const wallet = requireWallet();
  const session = getSessionSnapshot();
  if (!session) throw new ClientError('UNAUTHORIZED', defaultMessage('UNAUTHORIZED'));
  if (wallet.publicKey.toBase58() !== session.wallet) {
    throw new ClientError(
      'WRONG_WALLET',
      'The connected wallet is not the signed-in wallet. Reconnect the wallet you signed in with.',
    );
  }
  return { ...wallet, address: session.wallet };
}

/** Reports a phase without letting a faulty listener break the flow. */
export function safeReporter(onPhase: OnTxPhase): (phase: TxPhase) => void {
  return (phase) => {
    try {
      onPhase(phase);
    } catch {
      // ignored
    }
  };
}

/** Base58 signature of the fee payer (the transaction id), or null when not signed yet. */
export function feePayerSignature(tx: VersionedTransaction): string | null {
  const first = tx.signatures[0];
  if (!first || first.every((b) => b === 0)) return null;
  return base58Encode(first);
}

/**
 * The RPC node refused the transaction during preflight: it was NOT broadcast. Any other send
 * failure (network error, timeout, 5xx from the relay) may hide a transaction that did go out.
 */
export function isPreflightRejection(err: unknown): err is SendTransactionError {
  return err instanceof SendTransactionError;
}

/** Readable reason of a preflight rejection (the node's message, without the debugging hints). */
export function preflightMessage(err: SendTransactionError): string {
  const reason = err.transactionError.message?.trim();
  return reason
    ? `The network refused the transaction: ${reason}`
    : 'The network refused the transaction.';
}

/** Decodes a base64 transaction received from the server. Never builds one client-side. */
export function deserializeTransaction(b64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(base64ToBytes(b64));
  } catch {
    throw new ClientError('NETWORK', 'The server sent an invalid transaction.');
  }
}

export function serializeToBase64(tx: VersionedTransaction): string {
  return bytesToBase64(tx.serialize());
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls the cluster (through the RPC relay) until the signature is confirmed. */
export async function waitForConfirmation(signature: string): Promise<void> {
  const { connection } = getWalletBridge();
  if (!connection) throw networkError();
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) throw new Error('The transaction failed on-chain.');
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return;
      }
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for confirmation.');
    await sleep(CONFIRM_POLL_MS);
  }
}

/** Sends a signed transaction through the connection and waits for its confirmation. */
export async function sendAndConfirm(signed: VersionedTransaction): Promise<string> {
  const { connection } = getWalletBridge();
  if (!connection) throw networkError();
  const signature = await connection.sendRawTransaction(signed.serialize());
  await waitForConfirmation(signature);
  return signature;
}

export interface TxSteps {
  /** Fetches the transaction to sign (server side). Errors here happen before any prompt. */
  prepare(): Promise<VersionedTransaction>;
  /** Sends the signed transaction and returns its signature once confirmed. */
  submit(signed: VersionedTransaction): Promise<string>;
}

/**
 * Runs prepare -> sign -> submit and reports TxPhase. A wallet rejection is the `rejected`
 * phase, not an error. ClientErrors (UNAUTHORIZED, WRONG_WALLET, QUOTE_EXPIRED, ...) are
 * rethrown after reporting `error`; any other failure resolves with `phase: 'error'`.
 */
export async function runTransaction(onPhase: OnTxPhase, steps: TxSteps): Promise<TxResult> {
  const report = (p: TxPhase) => {
    try {
      onPhase(p);
    } catch {
      // a faulty listener must not break the flow
    }
  };
  let stage: 'prepare' | 'sign' | 'send' = 'prepare';
  try {
    const { signTransaction } = requireWallet();
    const tx = await steps.prepare();
    stage = 'sign';
    report('awaiting_signature');
    const signed = await signTransaction(tx);
    stage = 'send';
    report('sending');
    const signature = await steps.submit(signed);
    report('confirmed');
    return { phase: 'confirmed', signature };
  } catch (err) {
    if (stage === 'sign' && isUserRejection(err)) {
      report('rejected');
      return { phase: 'rejected' };
    }
    report('error');
    if (err instanceof ClientError) throw err;
    return { phase: 'error', error: errorMessage(err) || defaultMessage('NETWORK') };
  }
}
