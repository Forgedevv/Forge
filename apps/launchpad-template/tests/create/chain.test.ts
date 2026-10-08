import { describe, expect, it, vi } from 'vitest';
import {
  confirmSignature,
  createRpcChainClient,
  RpcError,
  type ChainClient,
} from '@/forge/create/chain';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

describe('createRpcChainClient', () => {
  it('reads balances as bigint', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ result: { value: 1_234_567_890 } }));
    const chain = createRpcChainClient({ url: 'https://relay.test', fetch });
    expect(await chain.getBalanceLamports('Wallet')).toBe(BigInt(1234567890));
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.method).toBe('getBalance');
  });

  it('retries network errors with backoff, then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ result: 'sig' }));
    const chain = createRpcChainClient({ url: 'https://relay.test', fetch, sleep });
    expect(await chain.sendRawTransaction('AAAA')).toBe('sig');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
  });

  it('does not retry JSON-RPC errors and surfaces them', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: -32002, message: 'Simulation failed' } }));
    const chain = createRpcChainClient({ url: 'https://relay.test', fetch, sleep: async () => {} });
    await expect(chain.sendRawTransaction('AAAA')).rejects.toBeInstanceOf(RpcError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retries', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('down'));
    const chain = createRpcChainClient({
      url: 'https://relay.test',
      fetch,
      sleep: async () => {},
      retries: 1,
    });
    await expect(chain.getBalanceLamports('W')).rejects.toThrow('down');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('maps signature statuses', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ result: { value: [null] } }))
      .mockResolvedValueOnce(
        jsonResponse({ result: { value: [{ confirmationStatus: 'confirmed', err: null }] } }),
      );
    const chain = createRpcChainClient({ url: 'https://relay.test', fetch });
    expect(await chain.getSignatureStatus('s')).toBeNull();
    expect(await chain.getSignatureStatus('s')).toEqual({
      confirmationStatus: 'confirmed',
      err: null,
    });
  });
});

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('confirmSignature', () => {
  it('polls until confirmed', async () => {
    const clock = fakeClock();
    const getSignatureStatus = vi
      .fn<ChainClient['getSignatureStatus']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ confirmationStatus: 'processed', err: null })
      .mockResolvedValueOnce({ confirmationStatus: 'confirmed', err: null });
    const outcome = await confirmSignature({ getSignatureStatus }, 'sig', clock);
    expect(outcome).toEqual({ kind: 'confirmed', commitment: 'confirmed' });
    expect(getSignatureStatus).toHaveBeenCalledTimes(3);
  });

  it('reports an on-chain failure', async () => {
    const clock = fakeClock();
    const outcome = await confirmSignature(
      {
        getSignatureStatus: async () => ({
          confirmationStatus: 'confirmed',
          err: { InstructionError: [0, 'Custom'] },
        }),
      },
      'sig',
      clock,
    );
    expect(outcome.kind).toBe('failed');
  });

  it('times out at the deadline without failing', async () => {
    const clock = fakeClock();
    const getSignatureStatus = vi.fn<ChainClient['getSignatureStatus']>().mockResolvedValue(null);
    const outcome = await confirmSignature({ getSignatureStatus }, 'sig', {
      ...clock,
      timeoutMs: 5_000,
      intervalMs: 1_000,
    });
    expect(outcome).toEqual({ kind: 'timeout' });
    expect(getSignatureStatus.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('survives transient polling errors', async () => {
    const clock = fakeClock();
    const getSignatureStatus = vi
      .fn<ChainClient['getSignatureStatus']>()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ confirmationStatus: 'finalized', err: null });
    expect(await confirmSignature({ getSignatureStatus }, 'sig', clock)).toEqual({
      kind: 'confirmed',
      commitment: 'finalized',
    });
  });

  it('waits for finalized when asked', async () => {
    const clock = fakeClock();
    const getSignatureStatus = vi
      .fn<ChainClient['getSignatureStatus']>()
      .mockResolvedValueOnce({ confirmationStatus: 'confirmed', err: null })
      .mockResolvedValueOnce({ confirmationStatus: 'finalized', err: null });
    const outcome = await confirmSignature({ getSignatureStatus }, 'sig', {
      ...clock,
      commitment: 'finalized',
    });
    expect(outcome).toEqual({ kind: 'confirmed', commitment: 'finalized' });
  });
});

describe('confirmSignature expiry', () => {
  it('reports expired when the blockhash is gone and the status is unknown', async () => {
    const clock = fakeClock();
    const getSignatureStatus = vi.fn<ChainClient['getSignatureStatus']>().mockResolvedValue(null);
    const outcome = await confirmSignature({ getSignatureStatus }, 'sig', {
      ...clock,
      isExpired: async () => true,
    });
    expect(outcome).toEqual({ kind: 'expired' });
  });

  it('still reports confirmed when it landed right before expiry', async () => {
    const clock = fakeClock();
    const getSignatureStatus = vi
      .fn<ChainClient['getSignatureStatus']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ confirmationStatus: 'confirmed', err: null });
    const outcome = await confirmSignature({ getSignatureStatus }, 'sig', {
      ...clock,
      isExpired: async () => true,
    });
    expect(outcome).toEqual({ kind: 'confirmed', commitment: 'confirmed' });
  });

  it('keeps polling when the expiry check itself fails', async () => {
    const clock = fakeClock();
    const getSignatureStatus = vi
      .fn<ChainClient['getSignatureStatus']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ confirmationStatus: 'confirmed', err: null });
    const outcome = await confirmSignature({ getSignatureStatus }, 'sig', {
      ...clock,
      isExpired: async () => {
        throw new Error('rpc down');
      },
    });
    expect(outcome.kind).toBe('confirmed');
  });
});
