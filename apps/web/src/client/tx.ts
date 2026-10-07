import { ClientError, type OnTxPhase, type TxPhase, type TxResult } from '@forge/shared';
import { VersionedTransaction } from '@solana/web3.js';
import { base64ToBytes, bytesToBase64 } from './base58';
import { defaultMessage, errorMessage, isUserRejection, networkError } from './errors';
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
