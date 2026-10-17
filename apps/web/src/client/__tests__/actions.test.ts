// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvePreview,
  confirmSpec,
  getOwnerTransactionSummary,
  reactivateLaunchpad,
  requestModification,
  retryLaunchpad,
} from '../actions';
import { id, json, mockFetch, owner, setWallet, txB64 } from './helpers';

beforeEach(() => {
  setWallet(async (tx) => tx);
});
afterEach(() => vi.unstubAllGlobals());

describe('simple actions', () => {
  it('confirmSpec posts a validated body and parses the response', async () => {
    const conversationId = id();
    const out = { launchpadId: id(), jobId: id() };
    const fetchFn = mockFetch(() => json(out));
    const spec = {
      version: 1,
      quote: 'SOL',
      name: 'Acme',
      slug: 'acme',
      tradingFeeBps: 100,
      coinCreatorSharePct: 20,
      poolCreationFeeSol: 0,
      antiSniper: true,
      theme: {
        primaryColor: '#111111',
        accentColor: '#22cc88',
        darkMode: true,
        tagline: 'Hi',
        designNotes: '',
      },
      launchpadCoin: {
        name: 'Acme',
        symbol: 'ACME',
        description: 'd',
        imageUrl: 'https://x.io/a.png',
        firstBuySol: 0.1,
      },
      ownerWallet: owner.toBase58(),
    } as const;
    await expect(confirmSpec(conversationId, spec)).resolves.toEqual(out);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/spec/confirm');
    expect(JSON.parse(init.body as string)).toMatchObject({
      conversationId,
      spec: { slug: 'acme' },
    });
  });

  it('confirmSpec rejects an invalid conversation id without calling the server', async () => {
    const fetchFn = mockFetch(() => json({}));
    await expect(confirmSpec('nope', {} as never)).rejects.toThrow(/not valid/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('requestModification posts to the launchpad route', async () => {
    const lp = id();
    const jobId = id();
    const fetchFn = mockFetch(() => json({ jobId }));
    await expect(requestModification(lp, id(), 'Make it blue')).resolves.toEqual({ jobId });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/launchpads/${lp}/modifications`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ request: 'Make it blue' });
  });

  it('requestModification maps rate limiting', async () => {
    mockFetch(() => json({ message: 'slow' }, 429));
    await expect(requestModification(id(), id(), 'x')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('approvePreview posts without body and maps UNAUTHORIZED', async () => {
    const jobId = id();
    const fetchFn = mockFetch(() => json({ status: 'approved' }));
    await expect(approvePreview(jobId)).resolves.toBeUndefined();
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/jobs/${jobId}/approve`);
    expect(init.body).toBeUndefined();

    mockFetch(() => json({}, 401));
    await expect(approvePreview(jobId)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('getOwnerTransactionSummary returns the summary', async () => {
    const summary = {
      coinName: 'Acme',
      coinSymbol: 'ACME',
      firstBuyLamports: '100000000',
      estimatedNetworkFeeLamports: '5000',
      ownerWallet: owner.toBase58(),
    };
    mockFetch(() => json({ transaction: txB64(), summary, simulation: 'failed' }));
    await expect(getOwnerTransactionSummary(id())).resolves.toEqual({
      ...summary,
      simulation: 'failed',
    });
    // A server that does not say whether it simulated: treated as not checked.
    mockFetch(() => json({ transaction: txB64(), summary }));
    await expect(getOwnerTransactionSummary(id())).resolves.toMatchObject({
      simulation: 'unavailable',
    });
    // The balance the wallet must hold reaches the launch screen as the server computed it.
    mockFetch(() =>
      json({
        transaction: txB64(),
        summary: { ...summary, ownerRequiredBalanceLamports: '102044280' },
        simulation: 'ok',
      }),
    );
    await expect(getOwnerTransactionSummary(id())).resolves.toEqual({
      ...summary,
      ownerRequiredBalanceLamports: '102044280',
      simulation: 'ok',
    });
  });

  it('reactivateLaunchpad posts to the reactivate route', async () => {
    const lp = id();
    const fetchFn = mockFetch(() => json({ ok: true }));
    await reactivateLaunchpad(lp);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(`/api/launchpads/${lp}/reactivate`);
    mockFetch(() => json({ message: 'Signups are paused', code: 'SIGNUPS_PAUSED' }, 503));
    await expect(reactivateLaunchpad(lp)).rejects.toMatchObject({ code: 'SIGNUPS_PAUSED' });
  });

  it('retryLaunchpad posts without body to the retry route and returns the job to pay', async () => {
    const lp = id();
    const jobId = id();
    const fetchFn = mockFetch(() => json({ jobId }, 201));
    await expect(retryLaunchpad(lp)).resolves.toEqual({ jobId });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/launchpads/${lp}/retry`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('retryLaunchpad keeps the server explanation of a refusal', async () => {
    const message = 'The refund of the last attempt is not complete yet.';
    mockFetch(() => json({ code: 'REFUND_PENDING', message, jobId: id() }, 409));
    const error = await retryLaunchpad(id()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'NETWORK', message, serverCode: 'REFUND_PENDING' });
    mockFetch(() => json({ code: 'SIGNUPS_PAUSED', message: 'Paused.' }, 403));
    await expect(retryLaunchpad(id())).rejects.toMatchObject({ code: 'SIGNUPS_PAUSED' });
    // An unexpected answer is never taken for a job to pay.
    mockFetch(() => json({ jobId: 'not-a-uuid' }));
    await expect(retryLaunchpad(id())).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
