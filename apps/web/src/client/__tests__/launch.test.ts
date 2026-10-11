// @vitest-environment node
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signOwnerTransaction } from '../actions';
import { base64ToBytes } from '../base58';
import { getKeptLaunch, resetKeptLaunches } from '../launches';
import { setSession } from '../session-store';
import {
  SIG,
  encode,
  fakeSign,
  id,
  json,
  launchTx,
  mockFetch,
  owner,
  phases,
  rejection,
  setWallet,
  signIn,
} from './helpers';

const summary = (wallet = owner.toBase58()) => ({
  coinName: 'Acme',
  coinSymbol: 'ACME',
  firstBuyLamports: '1',
  estimatedNetworkFeeLamports: '5000',
  ownerWallet: wallet,
});

beforeEach(() => {
  resetKeptLaunches();
  signIn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

describe('signOwnerTransaction', () => {
  it('signs the prepared launch and submits exactly that message', async () => {
    const jobId = id();
    const prepared = launchTx();
    const fetchFn = mockFetch((_url, init) =>
      init?.method === 'POST'
        ? json({ signature: SIG })
        : json({ transaction: encode(prepared), summary: summary(), simulation: 'ok' }),
    );
    const p = phases();
    const result = await signOwnerTransaction(jobId, p.on);
    expect(result).toEqual({ phase: 'confirmed', signature: SIG });
    expect(p.list).toEqual(['awaiting_signature', 'sending', 'confirmed']);
    const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/jobs/${jobId}/owner-transaction`);
    const body = JSON.parse(init.body as string) as { signedTransaction: string };
    expect(Object.keys(body)).toEqual(['signedTransaction']);
    const sent = VersionedTransaction.deserialize(base64ToBytes(body.signedTransaction));
    expect(sent.message.serialize()).toEqual(prepared.message.serialize());
  });

  it('throws WRONG_WALLET when the connected wallet is not the owner', async () => {
    const sign = vi.fn();
    setWallet(sign);
    mockFetch(() =>
      json({
        transaction: encode(launchTx()),
        summary: summary(Keypair.generate().publicKey.toBase58()),
      }),
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
    const fetchFn = mockFetch(() => json({ transaction: encode(launchTx()), summary: summary() }));
    const p = phases();
    await expect(signOwnerTransaction(id(), p.on)).resolves.toEqual({ phase: 'rejected' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid transaction from the server', async () => {
    mockFetch(() => json({ transaction: 'AAAA', summary: summary() }));
    await expect(signOwnerTransaction(id(), () => undefined)).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  it.each([
    ['another fee payer', () => launchTx({ payer: Keypair.generate().publicKey }), /fee payer/],
    ['a missing FORGE signature', () => launchTx({ presign: false }), /missing a FORGE signature/],
  ])('refuses %s before the wallet is asked to sign', async (_label, build, message) => {
    const sign = vi.fn();
    setWallet(sign);
    const fetchFn = mockFetch(() => json({ transaction: encode(build()), summary: summary() }));
    const result = await signOwnerTransaction(id(), () => undefined);
    expect(result.phase).toBe('error');
    expect(result.error).toMatch(message);
    expect(sign).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not submit when the wallet changed the launch message', async () => {
    setWallet(async () => {
      const changed = launchTx();
      changed.signatures[0] = new Uint8Array(64).fill(7);
      return changed;
    });
    const fetchFn = mockFetch(() => json({ transaction: encode(launchTx()), summary: summary() }));
    const result = await signOwnerTransaction(id(), () => undefined);
    expect(result.phase).toBe('error');
    expect(result.error).toMatch(/changed the transaction/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('signOwnerTransaction retries with the same signed bytes', () => {
  /** GET serves the prepared launch; POST answers from `replies` in order (the last repeats). */
  function server(replies: (Response | Error)[]) {
    const prepared = launchTx();
    const posts: string[] = [];
    let gets = 0;
    let i = 0;
    const fetchFn = mockFetch((_url, init) => {
      if (init?.method !== 'POST') {
        gets++;
        return json({ transaction: encode(prepared), summary: summary(), simulation: 'ok' });
      }
      posts.push(
        (JSON.parse(init.body as string) as { signedTransaction: string }).signedTransaction,
      );
      const reply = replies[Math.min(i, replies.length - 1)]!;
      i++;
      if (reply instanceof Error) throw reply;
      return reply.clone();
    });
    return { posts, gets: () => gets, fetchFn };
  }

  async function settle<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const out = promise.finally(() => {
      done = true;
    });
    for (let waited = 0; !done && waited < 300_000; waited += 1000) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    return out;
  }

  const pending = () =>
    json(
      {
        code: 'CONFIRMATION_PENDING',
        message: 'The launch transaction was sent but is not confirmed yet.',
        signature: SIG,
      },
      503,
      { 'Retry-After': '5' },
    );

  beforeEach(() => {
    vi.useFakeTimers();
    resetKeptLaunches();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-POSTs the same bytes on 503 CONFIRMATION_PENDING and network errors, without signing again', async () => {
    const sign = vi.fn(fakeSign());
    setWallet(sign);
    const { posts } = server([
      pending(),
      new TypeError('Failed to fetch'),
      json({ signature: SIG }),
    ]);
    const p = phases();
    const result = await settle(signOwnerTransaction(id(), p.on));
    expect(result).toEqual({ phase: 'confirmed', signature: SIG });
    expect(posts).toHaveLength(3);
    expect(new Set(posts).size).toBe(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(p.list).toEqual(['awaiting_signature', 'sending', 'confirmed']);
  });

  it('keeps the signed launch when still pending, and a retry only re-submits it', async () => {
    const sign = vi.fn(fakeSign());
    setWallet(sign);
    const jobId = id();
    const first = server([pending()]);
    const result = await settle(signOwnerTransaction(jobId, () => undefined));
    expect(result).toMatchObject({ phase: 'error', signature: SIG });
    expect(result.error).toMatch(/not be asked to sign again/);
    expect(getKeptLaunch(jobId)?.signature).toBe(SIG);
    const kept = first.posts[0];

    const second = server([json({ signature: SIG })]);
    const p = phases();
    const retried = await settle(signOwnerTransaction(jobId, p.on));
    expect(retried).toEqual({ phase: 'confirmed', signature: SIG });
    expect(second.gets()).toBe(0);
    expect(second.posts).toEqual([kept]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(p.list).toEqual(['sending', 'confirmed']);
    expect(getKeptLaunch(jobId)).toBeNull();
  });

  it.each([
    ['409 ALREADY_SIGNED', json({ code: 'ALREADY_SIGNED', message: 'Already signed.' }, 409)],
    [
      '409 INVALID_STATUS with a later job status',
      json({ code: 'INVALID_STATUS', message: 'Not ready.', status: 'deploying' }, 409),
    ],
  ])('treats %s on submit as a success', async (_label, reply) => {
    const jobId = id();
    server([reply]);
    const result = await settle(signOwnerTransaction(jobId, () => undefined));
    expect(result).toEqual({ phase: 'confirmed', signature: SIG });
    expect(getKeptLaunch(jobId)).toBeNull();
  });

  it('treats an already signed launch as confirmed without asking the wallet', async () => {
    const sign = vi.fn();
    setWallet(sign);
    mockFetch(() =>
      json({ code: 'ALREADY_SIGNED', message: 'This launch has already been signed.' }, 409),
    );
    const p = phases();
    await expect(signOwnerTransaction(id(), p.on)).resolves.toEqual({ phase: 'confirmed' });
    expect(sign).not.toHaveBeenCalled();
    expect(p.list).toEqual(['confirmed']);
  });

  it('drops the kept bytes after a definitive failure, keeps them when they can still land', async () => {
    const failedJob = id();
    server([
      json({ code: 'TRANSACTION_FAILED', message: 'The launch transaction failed on-chain.' }, 422),
    ]);
    const failed = await settle(signOwnerTransaction(failedJob, () => undefined));
    expect(failed).toMatchObject({
      phase: 'error',
      signature: SIG,
      error: 'The launch transaction failed on-chain.',
    });
    expect(getKeptLaunch(failedJob)).toBeNull();

    const poorJob = id();
    server([
      json(
        {
          code: 'TRANSACTION_REJECTED',
          message: 'Your wallet does not hold enough SOL for this launch.',
        },
        422,
      ),
    ]);
    const poor = await settle(signOwnerTransaction(poorJob, () => undefined));
    expect(poor).toMatchObject({ phase: 'error', signature: SIG });
    expect(getKeptLaunch(poorJob)).not.toBeNull();
  });
});
