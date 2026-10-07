import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockController } from './client';
import { fullSpec } from './fixtures';
import type { TxPhase, WebClient } from '@forge/shared';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('contract mocks', () => {
  it('streams answers and fills a complete blueprint without network calls', async () => {
    const controller = createMockController('chat:welcome');
    const api: WebClient = controller.client;
    const { result } = renderHook(() => api.useChat({}));
    for (const message of [
      'Orbit for makers',
      'Use the sample fee settings',
      'A quiet violet design',
      'ORBT with the sample first buy',
    ]) {
      act(() => result.current.send(message));
      expect(result.current.streaming).toBe(true);
      await advance(3000);
    }
    expect(result.current.validation.complete).toBe(true);
    expect(result.current.spec.name).toBe('Orbit');
    expect(result.current.messages).toHaveLength(9);
    const confirmation = api.confirmSpec('demo-conversation', fullSpec);
    await advance(500);
    expect(await confirmation).toEqual({ launchpadId: 'demo-pad', jobId: 'demo-job' });
    controller.dispose();
  });
  it('advances the automatic journey every three seconds and disposes its timers', async () => {
    const controller = createMockController('journey:auto');
    controller.start();
    expect(controller.snapshot().jobs['demo-job']!.status).toBe('paid');
    await advance(3000);
    expect(controller.snapshot().jobs['demo-job']!.status).toBe('building');
    await advance(24000);
    expect(controller.snapshot().jobs['demo-job']!.status).toBe('live');
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retries a failed build exactly once before succeeding', async () => {
    const controller = createMockController('job:retry');
    controller.start();
    await advance(3000);
    expect(controller.snapshot().jobs['demo-job']).toMatchObject({
      status: 'building',
      attempts: 2,
    });
    await advance(24000);
    expect(controller.snapshot().jobs['demo-job']!.status).toBe('live');
    controller.dispose();
  });
  it('requires preview approval and the owner signature in the normal journey', async () => {
    const controller = createMockController('chat:ready');
    const api = controller.client;
    const quotePromise = api.getQuote('demo-job', 'creation');
    await advance(500);
    const quote = await quotePromise;
    const phases: TxPhase[] = [];
    const payment = api.payQuote(quote, (phase) => phases.push(phase));
    await advance(1800);
    await payment;
    expect(phases).toEqual(['awaiting_signature', 'sending', 'confirmed']);
    await advance(12000);
    expect(controller.snapshot().jobs['demo-job']!.status).toBe('preview_ready');
    const approval = api.approvePreview('demo-job');
    await advance(500);
    await approval;
    await advance(12000);
    expect(controller.snapshot().jobs['demo-job']!.status).toBe('awaiting_owner_signature');
    controller.dispose();
  });
  it('preserves rejected signatures without changing balances', async () => {
    const controller = createMockController('dashboard:claim-rejected');
    const phases: TxPhase[] = [];
    const claim = controller.client.claimPartnerFees('demo-pad', (phase) => phases.push(phase));
    await advance(1000);
    expect((await claim).phase).toBe('rejected');
    expect(controller.snapshot().pads[0]!.claimablePartnerFeesLamports).toBe('1285000000');
    controller.dispose();
  });
});
