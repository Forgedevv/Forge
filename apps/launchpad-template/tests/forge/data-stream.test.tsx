// @vitest-environment jsdom
import '../helpers/dom-setup';
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ cluster: 'mainnet-beta' }));
vi.mock('@/forge/config', () => ({
  onchainConfig: undefined,
  get cluster() {
    return state.cluster;
  },
}));

import {
  DataStreamProvider,
  FAILURES_BEFORE_POLLING,
  POLL_INTERVAL_MILLIS,
  isPolledQuery,
  startPolling,
} from '@/forge/data/DataStreamProvider';
import { resetDataSource } from '@/forge/data/source';

/** A WebSocket that never opens (the stream is unreachable) unless `open()` is called. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  fail() {
    this.onerror?.(new Error('unreachable'));
  }
}

function setup() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={client}>
      <DataStreamProvider>
        <span>market</span>
      </DataStreamProvider>
    </QueryClientProvider>,
  );
  return { invalidate };
}

let debug: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  resetDataSource();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { OPEN: 1 }));
  debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.cluster = 'mainnet-beta';
});

describe('polling helpers', () => {
  it('poll the coin lists and the coin info only', () => {
    expect(isPolledQuery(['explore', 'gems', {}])).toBe(true);
    expect(isPolledQuery(['explore', 'token', 'mint', 'info'])).toBe(true);
    expect(isPolledQuery(['explore', 'token', 'mint', 'holders'])).toBe(false);
    expect(isPolledQuery(['explore', 'token', 'mint', 'txs'])).toBe(false);
    expect(isPolledQuery(['other'])).toBe(false);
  });

  it('pause while the tab is hidden and catch up when it is shown again', () => {
    const listeners: (() => void)[] = [];
    const doc = {
      hidden: false,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    };
    const refresh = vi.fn();
    const stop = startPolling(refresh, 1_000, doc as never);
    vi.advanceTimersByTime(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    doc.hidden = true;
    vi.advanceTimersByTime(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    doc.hidden = false;
    listeners.forEach((fn) => fn());
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(5_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(doc.removeEventListener).toHaveBeenCalled();
  });
});

describe('DataStreamProvider', () => {
  it('polls when the trench stream cannot be reached, and stops once it is back', async () => {
    const { invalidate } = setup();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]!.url).toBe('wss://trench-stream.jup.ag/ws');
    // The stream is up: no polling.
    await act(async () => FakeSocket.instances[0]!.open());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MILLIS * 2);
    });
    expect(invalidate).not.toHaveBeenCalled();
    // It drops: reconnecting is not a failure yet.
    await act(async () => FakeSocket.instances[0]!.close());

    // Failed connections in a row (connect timeout) switch to polling.
    for (let i = 0; i < FAILURES_BEFORE_POLLING; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(70_000);
      });
    }
    expect(FakeSocket.instances.length).toBeGreaterThan(FAILURES_BEFORE_POLLING);
    expect(debug).toHaveBeenCalledWith(
      '[forge data] live updates: on-chain (stream unreachable, polling)',
    );
    invalidate.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MILLIS);
    });
    expect(invalidate).toHaveBeenCalled();
    const filter = invalidate.mock.calls[0]![0] as { predicate: (q: unknown) => boolean };
    expect(filter.predicate({ queryKey: ['explore', 'gems', {}] })).toBe(true);
    expect(filter.predicate({ queryKey: ['explore', 'token', 'm', 'holders'] })).toBe(false);

    // The stream comes back: polling stops.
    await act(async () => FakeSocket.instances.at(-1)!.open());
    invalidate.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MILLIS * 3);
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(debug).toHaveBeenLastCalledWith('[forge data] live updates: Jupiter data API');
  });

  it('never opens the stream on devnet and polls from the start', async () => {
    state.cluster = 'devnet';
    const { invalidate } = setup();
    expect(FakeSocket.instances).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MILLIS);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
