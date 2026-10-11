import type { Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { confirmByPolling } from '../../src/forge/trade/confirm';

type Status = { err: unknown; confirmationStatus?: string } | null;

function rpc(...responses: Array<Status | Error>) {
  let i = 0;
  const getSignatureStatuses = vi.fn(async () => {
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return { context: { slot: 1 }, value: [next] };
  });
  return { connection: { getSignatureStatuses } as unknown as Connection, getSignatureStatuses };
}

function clock() {
  let t = 0;
  return {
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

describe('confirmByPolling', () => {
  it('resolves once the status is confirmed', async () => {
    const { connection, getSignatureStatuses } = rpc(
      null,
      { err: null, confirmationStatus: 'processed' },
      { err: null, confirmationStatus: 'confirmed' },
    );
    await confirmByPolling(connection, 'sig', { ...clock(), intervalMs: 10, timeoutMs: 1000 });
    expect(getSignatureStatuses).toHaveBeenCalledTimes(3);
  });

  it('rejects with the mapped error when the transaction failed', async () => {
    const { connection } = rpc({ err: { InstructionError: [0, 'InsufficientFundsForRent'] } });
    await expect(
      confirmByPolling(connection, 'sig', { ...clock(), intervalMs: 10, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'insufficient_rent', signature: 'sig' });
  });

  it('times out with the signature attached', async () => {
    const { connection } = rpc(null);
    await expect(
      confirmByPolling(connection, 'sig', { ...clock(), intervalMs: 100, timeoutMs: 500 }),
    ).rejects.toMatchObject({ code: 'confirm_timeout', signature: 'sig' });
  });

  it('retries transient RPC failures and gives up after repeated ones', async () => {
    const recovering = rpc(new Error('Failed to fetch'), {
      err: null,
      confirmationStatus: 'finalized',
    });
    await expect(
      confirmByPolling(recovering.connection, 'sig', {
        ...clock(),
        intervalMs: 10,
        timeoutMs: 100_000,
      }),
    ).resolves.toBeUndefined();

    const down = rpc(new Error('Failed to fetch'));
    await expect(
      confirmByPolling(down.connection, 'sig', {
        ...clock(),
        intervalMs: 10,
        timeoutMs: 100_000,
        maxConsecutiveFailures: 3,
      }),
    ).rejects.toMatchObject({ code: 'network', signature: 'sig' });
  });
});
