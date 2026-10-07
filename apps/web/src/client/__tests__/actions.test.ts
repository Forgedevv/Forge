// @vitest-environment node
import type { Quote, TxPhase } from '@forge/shared';
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvePreview,
  claimPartnerFees,
  confirmSpec,
  getOwnerTransactionSummary,
  getQuote,
  payQuote,
  reactivateLaunchpad,
  requestModification,
  signOwnerTransaction,
} from '../actions';
import { bytesToBase64, base58Encode } from '../base58';
import { setWalletBridge } from '../wallet-bridge';

const owner = Keypair.generate().publicKey;
const SIG = base58Encode(new Uint8Array(64).fill(7));
const id = () => crypto.randomUUID();

function txB64(payer = owner): string {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
    ],
  }).compileToV0Message();
  return bytesToBase64(new VersionedTransaction(msg).serialize());
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler) {
  const fn = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function fakeConnection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sendRawTransaction: vi.fn().mockResolvedValue(SIG),
    getSignatureStatuses: vi
      .fn()
      .mockResolvedValue({ value: [{ err: null, confirmationStatus: 'confirmed' }] }),
    ...overrides,
  } as unknown as Connection & {
    sendRawTransaction: ReturnType<typeof vi.fn>;
    getSignatureStatuses: ReturnType<typeof vi.fn>;
  };
}

function setWallet(
  signTransaction: (<T extends VersionedTransaction>(tx: T) => Promise<T>) | undefined,
  connection: Connection | null = fakeConnection(),
) {
  setWalletBridge({ publicKey: owner, signTransaction, signMessage: undefined, connection });
}

function phases() {
  const list: TxPhase[] = [];
  return { list, on: (p: TxPhase) => void list.push(p) };
}

const rejection = () =>
  Object.assign(new Error('User rejected the request.'), { name: 'WalletSignTransactionError' });

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
    expect(JSON.parse(init.body as string)).toMatchObject({ conversationId, spec: { slug: 'acme' } });
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

describe('getQuote + payQuote', () => {
  function quoteResponse(overrides: Record<string, unknown> = {}) {
    return {
      paymentId: id(),
      kind: 'creation',
      lamports: '250000000',
      usdAmount: 45,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      transaction: txB64(),
      ...overrides,
    };
  }

  it('returns the quote without the transaction', async () => {
    const q = quoteResponse();
    mockFetch(() => json(q));
    const quote = await getQuote(id(), 'creation');
    expect(quote).toMatchObject({ paymentId: q.paymentId, lamports: '250000000', usdAmount: 45 });
    expect('transaction' in quote).toBe(false);
  });

  it('signs, sends, confirms and reports phases in order', async () => {
    const q = quoteResponse();
    const connection = fakeConnection();
    setWallet(async (tx) => tx, connection);
    const fetchFn = mockFetch((url) =>
      url === '/api/payments/quote' ? json(q) : json({ status: 'confirmed' }),
    );
    const quote = await getQuote(id(), 'creation');
    const p = phases();
    const result = await payQuote(quote, p.on);
    expect(result).toEqual({ phase: 'confirmed', signature: SIG });
    expect(p.list).toEqual(['awaiting_signature', 'sending', 'confirmed']);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/payments/confirm');
    expect(JSON.parse(init.body as string)).toEqual({ paymentId: q.paymentId, signature: SIG });
  });

  it('reports rejected (not error) when the user declines', async () => {
    const q = quoteResponse();
    setWallet(async () => {
      throw rejection();
    });
    mockFetch(() => json(q));
    const quote = await getQuote(id(), 'creation');
    const p = phases();
    const result = await payQuote(quote, p.on);
    expect(result).toEqual({ phase: 'rejected' });
    expect(p.list).toEqual(['awaiting_signature', 'rejected']);
  });

  it('returns an error phase when sending fails', async () => {
    const q = quoteResponse();
    setWallet(
      async (tx) => tx,
      fakeConnection({ sendRawTransaction: vi.fn().mockRejectedValue(new Error('blockhash not found')) }),
    );
    mockFetch(() => json(q));
    const quote = await getQuote(id(), 'creation');
    const p = phases();
    const result = await payQuote(quote, p.on);
    expect(result).toEqual({ phase: 'error', error: 'blockhash not found' });
    expect(p.list).toEqual(['awaiting_signature', 'sending', 'error']);
  });

  it('returns an error phase when the transaction fails on-chain', async () => {
    const q = quoteResponse();
    setWallet(
      async (tx) => tx,
      fakeConnection({
        getSignatureStatuses: vi.fn().mockResolvedValue({ value: [{ err: { InstructionError: [0, 'x'] } }] }),
      }),
    );
    mockFetch(() => json(q));
    const quote = await getQuote(id(), 'creation');
    const result = await payQuote(quote, () => undefined);
    expect(result.phase).toBe('error');
  });

  it('throws QUOTE_EXPIRED when the confirm route reports an expired payment', async () => {
    const q = quoteResponse();
    mockFetch((url) => (url === '/api/payments/quote' ? json(q) : json({ status: 'expired' })));
    const quote = await getQuote(id(), 'creation');
    const p = phases();
    await expect(payQuote(quote, p.on)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(p.list.at(-1)).toBe('error');
  });

  it('throws QUOTE_EXPIRED for an already expired quote, before any prompt', async () => {
    const sign = vi.fn();
    setWallet(sign);
    const quote: Quote = {
      paymentId: id(),
      kind: 'creation',
      lamports: '1',
      usdAmount: 1,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await expect(payQuote(quote, () => undefined)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(sign).not.toHaveBeenCalled();
  });

  it('throws QUOTE_EXPIRED for an unknown quote (page reload)', async () => {
    const quote: Quote = {
      paymentId: id(),
      kind: 'creation',
      lamports: '1',
      usdAmount: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await expect(payQuote(quote, () => undefined)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
  });

  it('confirms a free quote without touching the wallet', async () => {
    const sign = vi.fn();
    setWallet(sign);
    const q = quoteResponse({ lamports: '0', transaction: null });
    mockFetch(() => json(q));
    const quote = await getQuote(id(), 'modification');
    const p = phases();
    await expect(payQuote(quote, p.on)).resolves.toEqual({ phase: 'confirmed' });
    expect(p.list).toEqual(['confirmed']);
    expect(sign).not.toHaveBeenCalled();
  });

  it('requires a connected wallet', async () => {
    const q = quoteResponse();
    mockFetch(() => json(q));
    const quote = await getQuote(id(), 'creation');
    setWalletBridge({ publicKey: null, signTransaction: undefined, signMessage: undefined, connection: null });
    await expect(payQuote(quote, () => undefined)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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
      init?.method === 'POST' ? json({ signature: SIG }) : json({ transaction: txB64(), summary: summary() }),
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
    mockFetch(() => json({ transaction: txB64(), summary: summary(Keypair.generate().publicKey.toBase58()) }));
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
      init?.method === 'POST' ? json({ message: 'nope' }, 429) : json({ transaction: txB64(), summary: summary() }),
    );
    const p = phases();
    await expect(signOwnerTransaction(id(), p.on)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(p.list).toEqual(['awaiting_signature', 'sending', 'error']);
  });

  it('rejects an invalid transaction from the server', async () => {
    mockFetch(() => json({ transaction: 'AAAA', summary: summary() }));
    await expect(signOwnerTransaction(id(), () => undefined)).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('claimPartnerFees', () => {
  it('signs the server transaction and sends it through the connection', async () => {
    const lp = id();
    const connection = fakeConnection();
    setWallet(async (tx) => tx, connection);
    const fetchFn = mockFetch(() => json({ transaction: txB64() }));
    const p = phases();
    const result = await claimPartnerFees(lp, p.on);
    expect(result).toEqual({ phase: 'confirmed', signature: SIG });
    expect(p.list).toEqual(['awaiting_signature', 'sending', 'confirmed']);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(`/api/launchpads/${lp}/claim-transaction`);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('reports rejected on user rejection', async () => {
    setWallet(async () => {
      throw Object.assign(new Error('x'), { code: 4001 });
    });
    mockFetch(() => json({ transaction: txB64() }));
    const p = phases();
    await expect(claimPartnerFees(id(), p.on)).resolves.toEqual({ phase: 'rejected' });
    expect(p.list).toEqual(['awaiting_signature', 'rejected']);
  });

  it('maps UNAUTHORIZED from the server', async () => {
    mockFetch(() => json({}, 401));
    await expect(claimPartnerFees(id(), () => undefined)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
