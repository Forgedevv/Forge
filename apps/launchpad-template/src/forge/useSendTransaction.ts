import { useState } from 'react';
import { toast } from 'sonner';
import { useWallet } from '@jup-ag/wallet-adapter';
import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  type Commitment as Web3Commitment,
} from '@solana/web3.js';
import { confirmSignature, describeChainError, type ChainClient } from './create/chain';

/**
 * LOCKED ZONE. Client-side transaction sending helper: simulate, sign with the wallet, send, then
 * confirm by polling `getSignatureStatuses` with a deadline (no websocket subscription).
 *
 * The public API (`sendTransaction(transaction, connection, options)` and the returned
 * `{ sendTransaction, isLoading, error, signature }`) is unchanged; `VersionedTransaction` is also
 * accepted now.
 */

type SendTransactionOptions = {
  onSuccess?: (signature: string) => void;
  onError?: (error: string) => void;
  /** Extra keypairs that must sign (e.g. a mint). They sign before the wallet. */
  additionalSigners?: Keypair[];
  /** Polling deadline in milliseconds. Default 60 s. */
  confirmTimeoutMs?: number;
};

/** Adapts a web3.js Connection to the polling interface. */
export function connectionToChain(connection: Connection): Pick<ChainClient, 'getSignatureStatus'> {
  return {
    async getSignatureStatus(signature) {
      const { value } = await connection.getSignatureStatuses([signature]);
      const status = value[0];
      if (!status) return null;
      return {
        confirmationStatus: (status.confirmationStatus ?? null) as Web3Commitment | null,
        err: status.err,
      } as never;
    },
  };
}

export function useSendTransaction() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const { publicKey, signTransaction } = useWallet();

  const sendTransaction = async (
    transaction: Transaction | VersionedTransaction,
    connection: Connection,
    options: SendTransactionOptions = {},
  ) => {
    if (!publicKey || !signTransaction) {
      const walletError = new Error('Wallet not connected');
      setError(walletError);
      toast.error('Wallet not connected. Please connect your wallet.');
      options.onError?.(walletError.message);
      return null;
    }

    setIsLoading(true);
    setError(null);
    setSignature(null);

    try {
      // Prepare transaction. `lastValidBlockHeight` bounds the wait: past it the transaction can
      // never land, so we stop and say so instead of waiting for the deadline.
      let lastValidBlockHeight: number | undefined;
      if (transaction instanceof Transaction) {
        transaction.feePayer = transaction.feePayer || publicKey;
        if (!transaction.recentBlockhash) {
          const latest = await connection.getLatestBlockhash();
          transaction.recentBlockhash = latest.blockhash;
          lastValidBlockHeight = latest.lastValidBlockHeight;
        }
        lastValidBlockHeight = transaction.lastValidBlockHeight ?? lastValidBlockHeight;
      }

      // Extra signers sign first, the wallet signs last (signing does not alter the message)
      if (options.additionalSigners?.length) {
        if (transaction instanceof Transaction)
          transaction.partialSign(...options.additionalSigners);
        else transaction.sign(options.additionalSigners);
      }

      // Simulate transaction (signatures are not verified: the wallet has not signed yet)
      const simulation =
        transaction instanceof Transaction
          ? await connection.simulateTransaction(transaction)
          : await connection.simulateTransaction(transaction, { sigVerify: false });

      if (simulation.value.err) {
        throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
      }

      // Sign and send transaction
      const signedTransaction = await signTransaction(transaction);
      const txSignature = await connection.sendRawTransaction(
        signedTransaction.serialize() as Uint8Array,
        { preflightCommitment: 'confirmed' },
      );

      // Confirm by polling with a deadline
      const outcome = await confirmSignature(connectionToChain(connection), txSignature, {
        timeoutMs: options.confirmTimeoutMs,
        isExpired:
          lastValidBlockHeight === undefined
            ? undefined
            : async () => (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight!,
      });
      if (outcome.kind === 'failed') {
        throw new Error(`Transaction failed on-chain: ${describeChainError(outcome.err)}`);
      }
      if (outcome.kind === 'expired') {
        throw new Error('Transaction expired before it was confirmed and was not executed.');
      }
      if (outcome.kind === 'timeout') {
        throw new Error(
          `Transaction ${txSignature} was sent but is not confirmed yet. Check an explorer before retrying.`,
        );
      }

      setSignature(txSignature);
      options.onSuccess?.(txSignature);
      return txSignature;
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error';
      setError(new Error(errorMessage));
      options.onError?.(`Transaction failed: ${errorMessage}`);
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    sendTransaction,
    isLoading,
    error,
    signature,
  };
}
