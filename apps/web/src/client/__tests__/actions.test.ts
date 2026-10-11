// @vitest-environment node
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvePreview,
  confirmSpec,
  getOwnerTransactionSummary,
  reactivateLaunchpad,
  requestModification,
  signOwnerTransaction,
} from '../actions';
import { SIG, id, json, mockFetch, owner, phases, rejection, setWallet, txB64 } from './helpers';

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
    await expect(confirmSpec('nope', {} as never)).rejects.toThrow(/Invalid request/);
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
    mockFetch(() => json({ transaction: txB64(), summary }));
    await expect(getOwnerTransactionSummary(id())).resolves.toEqual(summary);
  });

  it('reactivateLaunchpad posts to the reactivate route', async () => {
    const lp = id();
    const fetchFn = mockFetch(() => json({ ok: true }));
    await reactivateLaunchpad(lp);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(`/api/launchpads/${lp}/reactivate`);
    mockFetch(() => json({ message: 'Signups are paused', code: 'SIGNUPS_PAUSED' }, 503));
    await expect(reactivateLaunchpad(lp)).rejects.toMatchObject({ code: 'SIGNUPS_PAUSED' });
  });
});

describe('signOwnerTransaction', () => {
  const summary = (wallet = owner.toBase58()) => ({
    coinName: 'Acme',
    coinSymbol: 'ACME',
    firstBuyLamports: '1',
    estimatedNetworkFeeLamports: '5000',
    ownerWallet: wallet,
  });

  it('signs and submits through the server route', async () => {
    const jobId = id();
    const fetchFn = mockFetch((_url, init) =>
      init?.method === 'POST'
        ? json({ signature: SIG })
        : json({ transaction: txB64(), summary: summary() }),
    );
    const p = phases();
    const result = await signOwnerTransaction(jobId, p.on);
    expect(result).toEqual({ phase: 'confirmed', signature: SIG });
    expect(p.list).toEqual(['awaiting_signature', 'sending', 'confirmed']);
    const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/jobs/${jobId}/owner-transaction`);
    expect(Object.keys(JSON.parse(init.body as string))).toEqual(['signedTransaction']);
  });

  it('throws WRONG_WALLET when the connected wallet is not the owner', async () => {
    const sign = vi.fn();
    setWallet(sign);
    mockFetch(() =>
      json({ transaction: txB64(), summary: summary(Keypair.generate().publicKey.toBase58()) }),
    );
    const p = phases();
    await expect(signOwnerTransaction(id(), p.on)).rejects.toMatchObject({ code: 'WRONG_WALLET' });
    expect(sign).not.toHaveBeenCalled();
    expect(p.list).toEqual(['error']);
  });

  it('reports rejected when the user declines', async () => {
    setWallet(async () => {
      throw rejection();
    });
    const fetchFn = mockFetch(() => json({ transaction: txB64(), summary: summary() }));
    const p = phases();
    await expect(signOwnerTransaction(id(), p.on)).resolves.toEqual({ phase: 'rejected' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('maps server errors on submit', async () => {
    mockFetch((_u, init) =>
      init?.method === 'POST'
        ? json({ message: 'nope' }, 429)
        : json({ transaction: txB64(), summary: summary() }),
    );
    const p = phases();
    await expect(signOwnerTransaction(id(), p.on)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(p.list).toEqual(['awaiting_signature', 'sending', 'error']);
  });

  it('rejects an invalid transaction from the server', async () => {
    mockFetch(() => json({ transaction: 'AAAA', summary: summary() }));
    await expect(signOwnerTransaction(id(), () => undefined)).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });
});
