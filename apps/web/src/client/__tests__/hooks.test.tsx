import { Keypair } from '@solana/web3.js';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base58Encode } from '../base58';

const walletState = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
const setVisible = vi.hoisted(() => vi.fn());
const fakeSb = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => walletState.value,
}));
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  useWalletModal: () => ({ setVisible }),
}));
vi.mock('../supabase', () => ({
  subscribeSupabase: () => () => undefined,
  getSupabaseSnapshot: () => fakeSb.client,
  getServerSupabaseSnapshot: () => null,
}));

import {
  useChat,
  useFlags,
  useGating,
  useJob,
  useLaunchpad,
  useLaunchpads,
  useSession,
} from '../hooks';
import { getSessionSnapshot, setSession } from '../session-store';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sseResponse(chunks: string[], status = 200) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

beforeEach(() => {
  setSession(null);
  fakeSb.client = null;
  setVisible.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('useFlags / useGating', () => {
  it('useFlags reads /api/flags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ signupsPaused: true })));
    const { result } = renderHook(() => useFlags());
    expect(result.current.signupsPaused).toBe(false);
    await waitFor(() => expect(result.current.signupsPaused).toBe(true));
  });

  it('useGating loads and rechecks', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ ok: false, enabled: true, required: '100', balance: '0' }))
      .mockResolvedValueOnce(json({ ok: true, enabled: true, required: '100', balance: '150' }));
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => useGating());
    await waitFor(() => expect(result.current.gating?.ok).toBe(false));
    expect(result.current.loading).toBe(false);
    await act(async () => {
      await result.current.recheck();
    });
    expect(result.current.gating?.ok).toBe(true);
  });

  it('useGating yields null gating on UNAUTHORIZED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
    const { result } = renderHook(() => useGating());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gating).toBeNull();
  });
});

describe('useSession', () => {
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();

  function wallet(overrides: Record<string, unknown> = {}) {
    walletState.value = {
      connected: true,
      connecting: false,
      publicKey: keypair.publicKey,
      wallet: { adapter: {} },
      connect: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      signMessage: vi.fn().mockResolvedValue(new Uint8Array(64).fill(3)),
      ...overrides,
    };
  }

  it('runs nonce -> signMessage -> verify and stores the session', async () => {
    wallet();
    const message = 'forge.example wants you to sign in. Nonce: abc123';
    const fetchFn = vi.fn((url: string) => {
      if (url === '/api/auth/nonce') {
        return Promise.resolve(json({ nonce: 'abc123', message, expiresAt: '2030-01-01T00:00:00.000Z' }));
      }
      if (url === '/api/auth/verify') return Promise.resolve(json({ wallet: address }));
      if (url === '/api/auth/session') {
        return Promise.resolve(json({ code: 'UNAUTHORIZED', message: 'Not signed in.' }, 401));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => useSession());
    expect(result.current.session).toBeNull();
    await act(async () => {
      await result.current.connect();
    });
    const sign = walletState.value.signMessage as ReturnType<typeof vi.fn>;
    expect(new TextDecoder().decode(sign.mock.calls[0]?.[0] as Uint8Array)).toBe(
      message,
    );
    const verifyCall = fetchFn.mock.calls.find((c) => c[0] === '/api/auth/verify') as unknown[];
    const verifyInit = verifyCall[1] as RequestInit;
    expect(JSON.parse(verifyInit.body as string)).toEqual({
      wallet: address,
      signature: base58Encode(new Uint8Array(64).fill(3)),
      nonce: 'abc123',
    });
        await waitFor(() => expect(result.current.session).toEqual({ wallet: address }));
    expect(result.current.status).toBe('idle');
  });

  it('treats a rejected signature as idle, without calling verify', async () => {
    wallet({
      signMessage: vi.fn().mockRejectedValue(Object.assign(new Error('User rejected'), { code: 4001 })),
    });
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(
        url === '/api/auth/nonce'
          ? json({ nonce: 'n', message: 'sign me', expiresAt: '2030-01-01T00:00:00.000Z' })
          : json({ code: 'UNAUTHORIZED', message: 'Not signed in.' }, 401),
      ),
    );
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => useSession());
    await act(async () => {
      await result.current.connect();
    });
    expect(fetchFn.mock.calls.map((c) => c[0])).not.toContain('/api/auth/verify');
    expect(result.current.session).toBeNull();
    expect(result.current.status).toBe('idle');
  });

  it('sets status error and rejects with a ClientError on server failure', async () => {
    wallet();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({ message: 'paused' }, 503))),
    );
    const { result } = renderHook(() => useSession());
    let caught: unknown;
    await act(async () => {
      await result.current.connect().catch((e: unknown) => {
        caught = e;
      });
    });
    expect(caught).toMatchObject({ code: 'NETWORK', message: 'paused' });
    expect(result.current.status).toBe('error');
  });

  it('opens the wallet modal when no wallet is selected', async () => {
    wallet({ connected: false, publicKey: null, wallet: null });
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(json({ code: 'UNAUTHORIZED', message: url }, 401)),
    );
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => useSession());
    await act(async () => {
      await result.current.connect();
    });
    expect(setVisible).toHaveBeenCalledWith(true);
    expect(fetchFn.mock.calls.map((c) => c[0])).not.toContain('/api/auth/nonce');
  });

  it('restores the session from GET /api/auth/session on mount', async () => {
    wallet();
    const fetchFn = vi.fn().mockResolvedValue(json({ wallet: address }));
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.session).toEqual({ wallet: address }));
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/auth/session');
  });

  it('clears a stored session when /api/auth/session answers 401', async () => {
    wallet();
    setSession({ wallet: address });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ code: 'UNAUTHORIZED', message: 'Not signed in.' }, 401)),
    );
    renderHook(() => useSession());
    await waitFor(() => expect(getSessionSnapshot()).toBeNull());
  });

  it('ignores a stored session of another wallet and clears it on disconnect', async () => {
    wallet();
    setSession({ wallet: Keypair.generate().publicKey.toBase58() });
    const { result } = renderHook(() => useSession());
    expect(result.current.session).toBeNull();
    setSession({ wallet: address });
    await waitFor(() => expect(result.current.session).toEqual({ wallet: address }));
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(url === '/api/auth/logout' ? json({ ok: true }) : json({ wallet: address })),
    );
    vi.stubGlobal('fetch', fetchFn);
    await act(async () => {
      await result.current.disconnect();
    });
    expect(fetchFn).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
    expect(getSessionSnapshot()).toBeNull();
  });
});

describe('useChat', () => {
  const CONV = crypto.randomUUID();

  it('streams text incrementally, fills the spec and tracks the conversation', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse([
        ev({ type: 'conversation', conversationId: CONV }),
        ev({ type: 'text', delta: 'Hel' }).slice(0, 20),
        ev({ type: 'text', delta: 'Hel' }).slice(20) + ev({ type: 'text', delta: 'lo' }),
        ev({
          type: 'spec',
          spec: { name: 'Acme' },
          validation: { complete: false, errors: { slug: 'Required' } },
        }),
        ev({ type: 'done' }),
      ]),
    );
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => useChat({}));
    act(() => result.current.send('Make me a launchpad'));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.messages).toEqual([
      { role: 'user', content: 'Make me a launchpad' },
      { role: 'assistant', content: 'Hello' },
    ]);
    expect(result.current.spec).toEqual({ name: 'Acme' });
    expect(result.current.validation.errors).toEqual({ slug: 'Required' });
    expect(result.current.conversationId).toBe(CONV);
    expect(result.current.rateLimited).toBe(false);
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ message: 'Make me a launchpad' });
  });

  it('sends the conversation id on the next message', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          sseResponse([ev({ type: 'conversation', conversationId: CONV }), ev({ type: 'done' })]),
        ),
      );
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => useChat({ launchpadId: crypto.randomUUID() }));
    act(() => result.current.send('one'));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    act(() => result.current.send('two'));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    const body = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({ conversationId: CONV, message: 'two' });
    expect(body.launchpadId).toBeDefined();
  });

  it('flags rateLimited on a RATE_LIMITED stream error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          ev({ type: 'conversation', conversationId: CONV }),
          ev({ type: 'error', code: 'RATE_LIMITED', message: 'Message limit reached' }),
          ev({ type: 'done' }),
        ]),
      ),
    );
    const { result } = renderHook(() => useChat({}));
    act(() => result.current.send('hi'));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.rateLimited).toBe(true);
    expect(result.current.messages.at(-1)?.content).toBe('Message limit reached');
  });

  it('flags rateLimited on an HTTP 429 and surfaces other HTTP errors as messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Too fast' }, 429)));
    const { result } = renderHook(() => useChat({}));
    act(() => result.current.send('hi'));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.rateLimited).toBe(true);
    expect(result.current.messages.at(-1)).toEqual({ role: 'assistant', content: 'Too fast' });
  });

  it('ignores empty messages', () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => useChat({}));
    act(() => result.current.send('   '));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Supabase-backed hooks
// ---------------------------------------------------------------------------

type Handler = (payload: { new: unknown }) => void;

function builder(result: unknown) {
  const b: Record<string, unknown> = {};
  for (const k of ['select', 'eq', 'order', 'in']) b[k] = () => b;
  b.maybeSingle = () => Promise.resolve(result);
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return b;
}

function makeSb(tables: Record<string, unknown>) {
  const handlers: { table: string; fn: Handler }[] = [];
  const channel = {
    on(_t: string, cfg: { table: string; filter?: string }, fn: Handler) {
      handlers.push({ table: cfg.table, fn });
      return channel;
    },
    subscribe: () => channel,
  };
  const filters: string[] = [];
  const client = {
    from: (t: string) => builder({ data: tables[t] ?? [], error: null }),
    channel: vi.fn((name: string) => {
      filters.push(name);
      return channel;
    }),
    removeChannel: vi.fn(),
  };
  return { client, handlers, filters };
}

const JOB_ID = crypto.randomUUID();
const LP_ID = crypto.randomUUID();
const jobRow = (over: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  launchpad_id: LP_ID,
  type: 'create_launchpad',
  status: 'paid',
  attempts: 0,
  failed_stage: null,
  request: null,
  preview_url: null,
  error: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

describe('useJob', () => {
  it('fetches the job and its events then applies realtime changes', async () => {
    const sb = makeSb({
      jobs: jobRow(),
      job_events: [{ id: 1, job_id: JOB_ID, message: 'Starting', created_at: '2026-01-01T00:00:01Z' }],
    });
    fakeSb.client = sb.client;
    const { result } = renderHook(() => useJob(JOB_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.job).toMatchObject({ id: JOB_ID, status: 'paid', launchpadId: LP_ID });
    expect(result.current.events).toHaveLength(1);

    const jobs = sb.handlers.find((h) => h.table === 'jobs');
    const events = sb.handlers.find((h) => h.table === 'job_events');
    act(() => jobs?.fn({ new: jobRow({ status: 'building', attempts: 1 }) }));
    expect(result.current.job).toMatchObject({ status: 'building', attempts: 1 });
    act(() =>
      events?.fn({
        new: { id: 2, job_id: JOB_ID, message: 'Writing files', created_at: '2026-01-01T00:00:02Z' },
      }),
    );
    act(() =>
      events?.fn({
        new: { id: 2, job_id: JOB_ID, message: 'Writing files', created_at: '2026-01-01T00:00:02Z' },
      }),
    );
    expect(result.current.events.map((e) => e.message)).toEqual(['Starting', 'Writing files']);
    expect(sb.filters).toContain(`job:${JOB_ID}`);
  });

  it('stays loading while Supabase is not ready and ignores malformed rows', async () => {
    const { result } = renderHook(() => useJob(JOB_ID));
    expect(result.current).toEqual({ job: null, events: [], loading: true });

    const sb = makeSb({ jobs: jobRow(), job_events: [] });
    fakeSb.client = sb.client;
    const second = renderHook(() => useJob(JOB_ID));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    act(() => sb.handlers.find((h) => h.table === 'jobs')?.fn({ new: { id: 'x' } }));
    expect(second.result.current.job?.status).toBe('paid');
  });
});

describe('useLaunchpads / useLaunchpad', () => {
  const lpRow = {
    id: LP_ID,
    slug: 'acme',
    spec: {
      name: 'Acme',
      launchpadCoin: { name: 'Acme Coin', symbol: 'ACME', imageUrl: 'https://x.io/a.png' },
    },
    launchpad_config: null,
    launchpad_coin_config: null,
    launchpad_coin_mint: 'Mint111',
    included_modifications_left: 2,
    status: 'live',
    created_at: '2026-01-01T00:00:00Z',
  };

  it('lists launchpads with their active job', async () => {
    const sb = makeSb({ launchpads: [lpRow], jobs: [jobRow({ status: 'building' })] });
    fakeSb.client = sb.client;
    const { result } = renderHook(() => useLaunchpads());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.launchpads[0]).toMatchObject({
      id: LP_ID,
      name: 'Acme',
      slug: 'acme',
      status: 'live',
      coin: { name: 'Acme Coin', symbol: 'ACME', mint: 'Mint111', imageUrl: 'https://x.io/a.png' },
      includedModificationsLeft: 2,
      activeJobId: JOB_ID,
    });
    expect(typeof result.current.refresh).toBe('function');
  });

  it('returns the launchpad detail with jobs and versions', async () => {
    const sb = makeSb({
      launchpads: lpRow,
      jobs: [jobRow({ status: 'live', preview_url: 'https://p.dev', request: 'Blue' })],
    });
    fakeSb.client = sb.client;
    const { result } = renderHook(() => useLaunchpad(LP_ID));
    await waitFor(() => expect(result.current.launchpad).not.toBeNull());
    expect(result.current.launchpad?.onchain.launchpadCoinMint).toBe('Mint111');
    expect(result.current.launchpad?.jobs).toHaveLength(1);
    expect(result.current.launchpad?.versions[0]).toMatchObject({
      jobId: JOB_ID,
      request: 'Blue',
      previewUrl: 'https://p.dev',
    });
    expect(result.current.loading).toBe(false);
  });
});
