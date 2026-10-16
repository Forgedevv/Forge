// @vitest-environment node
import { Keypair, VersionedTransaction, type PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signOwnerTransaction } from '../actions';
import { base64ToBytes } from '../base58';
import { getKeptLaunch, resetKeptLaunches } from '../launches';
import { setSession } from '../session-store';
import {
  SIG,
  encode,
  fakeConnection,
  fakeSign,
  id,
  json,
  launchFixture,
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

/** The GET owner-transaction body: the prepared launch, its summary and its launch accounts. */
const served = (fixture = launchFixture(), extra: Record<string, unknown> = {}) => ({
  transaction: encode(fixture.tx),
  summary: summary(),
  launch: fixture.launch,
  ...extra,
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
    const fixture = launchFixture();
    const prepared = fixture.tx;
    const fetchFn = mockFetch((_url, init) =>
      init?.method === 'POST'
        ? json({ signature: SIG })
        : json(served(fixture, { simulation: 'ok' })),
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
      json(served(launchFixture(), { summary: summary(Keypair.generate().publicKey.toBase58()) })),
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
    const fetchFn = mockFetch(() => json(served()));
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
    [
      'another fee payer',
      () => launchFixture({ payer: Keypair.generate().publicKey }),
      /fee payer/,
    ],
    [
      'a missing FORGE signature',
      () => launchFixture({ presign: false }),
      /missing a FORGE signature/,
    ],
    // The transaction must do what the summary in the same response says.
    [
      'a first buy other than the summary',
      () => launchFixture({ firstBuyLamports: 2n }),
      /first buy amount/,
    ],
    ['another coin than the summary', () => launchFixture({ name: 'Other' }), /coin name/],
    // ...and use exactly the accounts of the `launch` in the same response.
    [
      'another creator wallet than the response pins',
      () => {
        const f = launchFixture();
        return { ...f, launch: { ...f.launch, creator: Keypair.generate().publicKey.toBase58() } };
      },
      /creator wallet is not the expected one/,
    ],
    [
      'another nonce account than the response pins',
      () => {
        const f = launchFixture();
        return {
          ...f,
          launch: { ...f.launch, nonceAccount: Keypair.generate().publicKey.toBase58() },
        };
      },
      /durable nonce account is not the expected one/,
    ],
  ])('refuses %s before the wallet is asked to sign', async (_label, build, message) => {
    const sign = vi.fn();
    setWallet(sign);
    const fetchFn = mockFetch(() => json(served(build())));
    const result = await signOwnerTransaction(id(), () => undefined);
    expect(result.phase).toBe('error');
    expect(result.error).toMatch(message);
    expect(sign).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // Before: the config, creator and mint all came from the same server response; the config is
  // now read from the chain before the wallet is asked to sign.
  it('reads the launchpad coin config on-chain through the client connection', async () => {
    const connection = signIn();
    const fixture = launchFixture();
    mockFetch((_url, init) =>
      init?.method === 'POST' ? json({ signature: SIG }) : json(served(fixture)),
    );
    await expect(signOwnerTransaction(id(), () => undefined)).resolves.toEqual({
      phase: 'confirmed',
      signature: SIG,
    });
    const getAccountInfo = (connection as unknown as { getAccountInfo: ReturnType<typeof vi.fn> })
      .getAccountInfo;
    expect(getAccountInfo).toHaveBeenCalledTimes(1);
    const [key, commitment] = getAccountInfo.mock.calls[0] as [PublicKey, string];
    expect(key.toBase58()).toBe(fixture.launch.config);
    expect(commitment).toBe('confirmed');
  });

  it.each([
    [
      'a fee claimer other than the owner',
      { feeClaimer: Keypair.generate().publicKey },
      /does not pay its trading fees to your wallet/,
    ],
    ['a coin creation fee', { poolCreationFeeLamports: 1_000_000n }, /charges a coin creation fee/],
    [
      'a creator share other than 25%',
      { creatorTradingFeePercentage: 50 },
      /does not set the 25% creator share/,
    ],
    ['mutable coin metadata', { tokenUpdateAuthority: 0 }, /lets the coin metadata be changed/],
    [
      'an account of another program',
      { owner: Keypair.generate().publicKey },
      /not a Meteora coin config/,
    ],
    ['another account size', { size: 1_000 }, /not a Meteora coin config/],
    [
      'another account type',
      { discriminator: [1, 2, 3, 4, 5, 6, 7, 8] },
      /not a Meteora coin config/,
    ],
  ])(
    'refuses a coin config on-chain with %s before the wallet is asked to sign',
    async (_label, config, message) => {
      const sign = vi.fn();
      setWallet(sign);
      const fetchFn = mockFetch(() => json(served(launchFixture({ config }))));
      const result = await signOwnerTransaction(id(), () => undefined);
      expect(result.phase).toBe('error');
      expect(result.error).toMatch(message);
      expect(result.error).toMatch(/Nothing was signed/);
      expect(sign).not.toHaveBeenCalled();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses when the coin config is missing on-chain or cannot be read', async () => {
    const cases: [string, () => void, RegExp][] = [
      ['missing', () => setWallet(vi.fn()), /does not exist on-chain/],
      [
        'unreadable',
        () =>
          setWallet(
            vi.fn(),
            fakeConnection({ getAccountInfo: vi.fn().mockRejectedValue(new Error('429')) }),
          ),
        /could not be read on-chain/,
      ],
      ['without a connection', () => setWallet(vi.fn(), null), /could not be read on-chain/],
    ];
    for (const [label, connect, message] of cases) {
      connect();
      mockFetch(() => json(served(launchFixture({ config: null }))));
      const result = await signOwnerTransaction(id(), () => undefined);
      expect(result.phase, label).toBe('error');
      expect(result.error, label).toMatch(message);
    }
  });

  // Before: a response without launch accounts was signed with only internal consistency checks.
  it('refuses a response without the launch accounts, in production too', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const sign = vi.fn();
      setWallet(sign);
      const fixture = launchFixture();
      const fetchFn = mockFetch(() =>
        json({ transaction: encode(fixture.tx), summary: summary(), simulation: 'ok' }),
      );
      const result = await signOwnerTransaction(id(), () => undefined);
      expect(result.phase).toBe('error');
      expect(result.error).toMatch(/launch details are missing/);
      expect(sign).not.toHaveBeenCalled();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not submit when the wallet changed the launch message', async () => {
    setWallet(async () => {
      const changed = launchTx();
      changed.signatures[0] = new Uint8Array(64).fill(7);
      return changed;
    });
    const fetchFn = mockFetch(() => json(served()));
    const result = await signOwnerTransaction(id(), () => undefined);
    expect(result.phase).toBe('error');
    expect(result.error).toMatch(/changed the transaction/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('signOwnerTransaction retries with the same signed bytes', () => {
  /** GET serves the prepared launch; POST answers from `replies` in order (the last repeats). */
  function server(replies: (Response | Error)[]) {
    const prepared = launchFixture();
    const posts: string[] = [];
    let gets = 0;
    let i = 0;
    const fetchFn = mockFetch((_url, init) => {
      if (init?.method !== 'POST') {
        gets++;
        return json(served(prepared, { simulation: 'ok' }));
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
