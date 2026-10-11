// @vitest-environment node
import { CLUSTER_GENESIS_HASH } from '@forge/core';
import { Keypair, SendTransactionError, Transaction, type Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  ClusterMismatchError,
  RpcUnavailableError,
  classifySendError,
  createConnectionLaunchChain,
} from '../chain';
import { launchTransaction, ownerSign } from './fakes';

const owner = Keypair.generate();

function sendError(message: string, logs: string[] = []): SendTransactionError {
  return new SendTransactionError({
    action: 'send',
    signature: '',
    transactionMessage: message,
    logs,
  });
}

function fakeConnection(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const base: Record<string, (...args: unknown[]) => unknown> = {
    getGenesisHash: async () => CLUSTER_GENESIS_HASH.devnet,
    getFeeForMessage: async () => ({ context: { slot: 1 }, value: 15_000 }),
    getBalance: async () => 2_000_000_000,
    simulateTransaction: async () => ({
      context: { slot: 1 },
      value: {
        err: null,
        logs: [],
        accounts: [
          {
            lamports: 1_480_000_000,
            owner: '11111111111111111111111111111111',
            data: ['', 'base64'],
            executable: false,
            rentEpoch: 0,
          },
        ],
      },
    }),
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
    sendRawTransaction: async () => 'sig',
    getBlockHeight: async () => 1,
  };
  const connection = new Proxy(
    {},
    {
      get(_t, prop: string) {
        const fn = (overrides[prop] as ((...a: unknown[]) => unknown) | undefined) ?? base[prop];
        if (!fn) return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return fn(...args);
        };
      },
    },
  ) as unknown as Connection;
  return { connection, calls };
}

const noRetry = { attempts: 1, baseDelayMs: 0 };

describe('classifySendError', () => {
  it('classifies preflight failures without exposing them', () => {
    expect(
      classifySendError(sendError('Transaction simulation failed: Blockhash not found')),
    ).toEqual({
      status: 'expired',
    });
    expect(
      classifySendError(
        sendError(
          'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.',
        ),
      ),
    ).toEqual({ status: 'rejected', reason: 'insufficient_funds' });
    expect(classifySendError(sendError('This transaction has already been processed'))).toBe(
      'already_processed',
    );
    expect(classifySendError(sendError('custom program error: 0x1771'))).toEqual({
      status: 'rejected',
      reason: 'simulation_failed',
    });
  });
});

describe('createConnectionLaunchChain', () => {
  it('checks the genesis hash once and refuses another cluster', async () => {
    const ok = fakeConnection();
    const chain = createConnectionLaunchChain({
      connection: ok.connection,
      cluster: 'devnet',
      retry: noRetry,
    });
    await chain.assertCluster();
    await chain.assertCluster();
    expect(ok.calls.filter((c) => c.method === 'getGenesisHash')).toHaveLength(1);

    const mainnet = fakeConnection({
      getGenesisHash: async () => CLUSTER_GENESIS_HASH['mainnet-beta'],
    });
    const wrong = createConnectionLaunchChain({
      connection: mainnet.connection,
      cluster: 'devnet',
      retry: noRetry,
    });
    await expect(wrong.assertCluster()).rejects.toBeInstanceOf(ClusterMismatchError);
  });

  it('estimates the owner debit from a simulation of the exact message, nonce kept', async () => {
    const { connection, calls } = fakeConnection();
    const chain = createConnectionLaunchChain({ connection, cluster: 'devnet', retry: noRetry });
    const { tx } = launchTransaction(owner);
    const estimate = await chain.estimateOwnerCosts(tx, owner.publicKey);
    expect(estimate).toEqual({
      networkFeeLamports: 15_000n,
      ownerDebitLamports: 520_000_000n,
      simulationFailed: false,
    });
    const sim = calls.find((c) => c.method === 'simulateTransaction')!;
    expect(sim.args[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false });
    const simulated = sim.args[0] as { message: { serialize(): Uint8Array } };
    expect(Buffer.from(simulated.message.serialize()).equals(tx.serializeMessage())).toBe(true);
  });

  it('reports a failed simulation and falls back on the signature count for the fee', async () => {
    const { connection } = fakeConnection({
      getFeeForMessage: async () => ({ context: { slot: 1 }, value: null }),
      simulateTransaction: async () => ({
        context: { slot: 1 },
        value: { err: 'InsufficientFundsForFee', logs: [] },
      }),
    });
    const chain = createConnectionLaunchChain({ connection, cluster: 'devnet', retry: noRetry });
    const { tx } = launchTransaction(owner);
    expect(await chain.estimateOwnerCosts(tx, owner.publicKey)).toEqual({
      networkFeeLamports: 15_000n,
      ownerDebitLamports: null,
      simulationFailed: true,
    });
  });

  it('reads signature states with the transaction history', async () => {
    const statuses = [
      null,
      { slot: 1, confirmations: 0, err: null, confirmationStatus: 'processed' },
      { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' },
      {
        slot: 1,
        confirmations: null,
        err: { InstructionError: [0, 'Custom'] },
        confirmationStatus: 'finalized',
      },
    ];
    const { connection, calls } = fakeConnection({
      getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [statuses.shift()] }),
    });
    const chain = createConnectionLaunchChain({ connection, cluster: 'devnet', retry: noRetry });
    expect(await chain.getSignatureState('s')).toBe('unknown');
    expect(await chain.getSignatureState('s')).toBe('pending');
    expect(await chain.getSignatureState('s')).toBe('confirmed');
    expect(await chain.getSignatureState('s')).toBe('failed');
    expect(calls[0]!.args[1]).toEqual({ searchTransactionHistory: true });
  });

  it('sends the fully signed bytes with preflight, and maps errors', async () => {
    const { base64 } = launchTransaction(owner);
    const signed = Transaction.from(Buffer.from(ownerSign(base64, owner), 'base64'));
    const ok = fakeConnection();
    const chain = createConnectionLaunchChain({
      connection: ok.connection,
      cluster: 'devnet',
      retry: noRetry,
    });
    expect(await chain.send(signed)).toEqual({ status: 'sent' });
    const call = ok.calls.find((c) => c.method === 'sendRawTransaction')!;
    expect(Buffer.from(call.args[0] as Uint8Array).toString('base64')).toBe(
      signed.serialize().toString('base64'),
    );
    expect(call.args[1]).toMatchObject({ skipPreflight: false });

    const processed = fakeConnection({
      sendRawTransaction: async () => {
        throw sendError('This transaction has already been processed');
      },
    });
    const c2 = createConnectionLaunchChain({
      connection: processed.connection,
      cluster: 'devnet',
      retry: noRetry,
    });
    expect(await c2.send(signed)).toEqual({ status: 'sent' });

    const down = fakeConnection({
      sendRawTransaction: async () => {
        throw new Error('fetch failed https://devnet.helius-rpc.com/?api-key=SECRET');
      },
    });
    const c3 = createConnectionLaunchChain({
      connection: down.connection,
      cluster: 'devnet',
      retry: noRetry,
    });
    const error = await c3.send(signed).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcUnavailableError);
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('refuses to send a transaction missing a signature', async () => {
    const { tx } = launchTransaction(owner);
    const { connection, calls } = fakeConnection();
    const chain = createConnectionLaunchChain({ connection, cluster: 'devnet', retry: noRetry });
    await expect(chain.send(tx)).rejects.toThrow();
    expect(calls.some((c) => c.method === 'sendRawTransaction')).toBe(false);
  });

  it('confirms by polling signature statuses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const statuses = [
        null,
        { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' },
      ];
      const { connection } = fakeConnection({
        getSignatureStatuses: async () => ({
          context: { slot: 1 },
          value: [statuses.shift() ?? null],
        }),
      });
      const chain = createConnectionLaunchChain({
        connection,
        cluster: 'devnet',
        retry: noRetry,
        pollIntervalMs: 10,
      });
      const pending = chain.confirm('sig', 5_000);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toBe('confirmed');

      const failing = fakeConnection({
        getSignatureStatuses: async () => ({
          context: { slot: 1 },
          value: [
            {
              slot: 1,
              confirmations: 1,
              err: { InstructionError: [0, 'Custom'] },
              confirmationStatus: 'confirmed',
            },
          ],
        }),
      });
      const c2 = createConnectionLaunchChain({
        connection: failing.connection,
        cluster: 'devnet',
        pollIntervalMs: 10,
      });
      expect(await c2.confirm('sig', 5_000)).toBe('failed');

      const never = fakeConnection();
      const c3 = createConnectionLaunchChain({
        connection: never.connection,
        cluster: 'devnet',
        pollIntervalMs: 10,
      });
      const timeout = c3.confirm('sig', 100);
      await vi.advanceTimersByTimeAsync(500);
      expect(await timeout).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});
