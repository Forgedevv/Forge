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
import { resetLaunchpadReads } from '../launchpads';
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
        return Promise.resolve(
          json({ nonce: 'abc123', message, expiresAt: '2030-01-01T00:00:00.000Z' }),
        );
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
    expect(new TextDecoder().decode(sign.mock.calls[0]?.[0] as Uint8Array)).toBe(message);
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
      signMessage: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('User rejected'), { code: 4001 })),
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
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
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
      vi
        .fn()
        .mockResolvedValue(
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
      job_events: [
        { id: 1, job_id: JOB_ID, message: 'Starting', created_at: '2026-01-01T00:00:01Z' },
      ],
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
        new: {
          id: 2,
          job_id: JOB_ID,
          message: 'Writing files',
          created_at: '2026-01-01T00:00:02Z',
        },
      }),
    );
    act(() =>
      events?.fn({
        new: {
          id: 2,
          job_id: JOB_ID,
          message: 'Writing files',
          created_at: '2026-01-01T00:00:02Z',
        },
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

describe('useLaunchpads / useLaunchpad (API)', () => {
  const summary = (over: Record<string, unknown> = {}) => ({
    id: LP_ID,
    name: 'Acme',
    slug: 'acme',
    siteUrl: 'https://acme.clients.example',
    status: 'live',
    coin: { name: 'Acme Coin', symbol: 'ACME', mint: 'Mint111', imageUrl: 'https://x.io/a.png' },
    coinsCount: 3,
    claimablePartnerFeesLamports: '1234567',
    includedModificationsLeft: 2,
    activeJobId: null,
    onchainAvailable: true,
    ...over,
  });
  const detail = (over: Record<string, unknown> = {}) => ({
    ...summary(),
    spec: { name: 'Acme', theme: { primaryColor: '#112233' } },
    onchain: { launchpadConfig: 'Cfg1', launchpadCoinConfig: 'Cfg2', launchpadCoinMint: 'Mint111' },
    versions: [
      { jobId: JOB_ID, createdAt: '2026-01-02T00:00:00Z', request: 'Blue', previewUrl: null },
    ],
    jobs: [
      {
        id: JOB_ID,
        launchpadId: LP_ID,
        type: 'create_launchpad',
        status: 'live',
        attempts: 1,
        failedStage: null,
        error: null,
        previewUrl: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ],
    quotas: { includedModificationsLeft: 2 },
    ...over,
  });

  beforeEach(() => {
    resetLaunchpadReads();
    setSession({ wallet: 'Owner1111111111111111111111111111111111111' });
  });

  it('lists launchpads from GET /api/launchpads with the server figures', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        json({ launchpads: [summary({ onchainAvailable: false, coinsCount: 0 })], quotas: {} }),
      );
    vi.stubGlobal('fetch', fetchFn);
    const { result, unmount } = renderHook(() => useLaunchpads());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/launchpads');
    expect(result.current.launchpads[0]).toMatchObject({
      id: LP_ID,
      siteUrl: 'https://acme.clients.example',
      coinsCount: 0,
      claimablePartnerFeesLamports: '1234567',
      onchainAvailable: false,
    });
    expect(result.current.error).toBeNull();
    unmount();
  });

  it('keeps what the dashboard needs to start a refunded draft again', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      json({
        launchpads: [
          summary({ status: 'draft', canStartAgain: true, activeJobStatus: null }),
          summary({
            id: 'lp-2',
            status: 'draft',
            activeJobId: JOB_ID,
            activeJobStatus: 'spec_ready',
          }),
          // An older server: neither field.
          summary({ id: 'lp-3' }),
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchFn);
    const { result, unmount } = renderHook(() => useLaunchpads());
    await waitFor(() => expect(result.current.launchpads).toHaveLength(3));
    expect(result.current.launchpads[0]).toMatchObject({
      canStartAgain: true,
      activeJobStatus: null,
    });
    expect(result.current.launchpads[1]).toMatchObject({ activeJobStatus: 'spec_ready' });
    expect(result.current.launchpads[2]!.canStartAgain).toBeUndefined();
    unmount();
  });

  it('refuses an unknown job status in a summary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ launchpads: [summary({ activeJobStatus: 'bogus' })] })),
    );
    const { result, unmount } = renderHook(() => useLaunchpads());
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.launchpads).toEqual([]);
    unmount();
  });

  it('shares one request between components mounted together', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ launchpads: [summary()] }));
    vi.stubGlobal('fetch', fetchFn);
    const a = renderHook(() => useLaunchpads());
    const b = renderHook(() => useLaunchpads());
    await waitFor(() => expect(b.result.current.launchpads).toHaveLength(1));
    expect(a.result.current.launchpads).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
  });

  it('reports a failed read instead of an empty list, and refresh retries', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json({ code: 'SERVER_ERROR', message: 'Temporarily unavailable.' }, 500),
      )
      .mockResolvedValue(json({ launchpads: [summary()] }));
    vi.stubGlobal('fetch', fetchFn);
    const { result, unmount } = renderHook(() => useLaunchpads());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Temporarily unavailable.');
    expect(result.current.launchpads).toEqual([]);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.launchpads).toHaveLength(1));
    expect(result.current.error).toBeNull();
    unmount();
  });

  it('reads again after a Realtime change (debounced) through one shared channel', async () => {
    const sb = makeSb({});
    fakeSb.client = sb.client;
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url !== '/api/launchpads') return Promise.resolve(json(detail()));
        calls++;
        return Promise.resolve(json({ launchpads: [summary({ coinsCount: calls })] }));
      }),
    );
    const list = renderHook(() => useLaunchpads());
    const other = renderHook(() => useLaunchpad(crypto.randomUUID()));
    await waitFor(() => expect(list.result.current.launchpads[0]?.coinsCount).toBe(1));
    expect(sb.client.channel).toHaveBeenCalledTimes(1);
    const jobs = sb.handlers.find((h) => h.table === 'jobs');
    act(() => jobs?.fn({ new: { launchpad_id: LP_ID } }));
    act(() => jobs?.fn({ new: { launchpad_id: LP_ID } }));
    await waitFor(() => expect(list.result.current.launchpads[0]?.coinsCount).toBe(2), {
      timeout: 3000,
    });
    expect(calls).toBe(2);
    list.unmount();
    other.unmount();
    expect(sb.client.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('returns the detail from GET /api/launchpads/:id, and null on 404', async () => {
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(
        url === `/api/launchpads/${LP_ID}`
          ? json(detail())
          : json({ code: 'NOT_FOUND', message: 'Launchpad not found.' }, 404),
      ),
    );
    vi.stubGlobal('fetch', fetchFn);
    const { result, unmount } = renderHook(() => useLaunchpad(LP_ID));
    await waitFor(() => expect(result.current.launchpad).not.toBeNull());
    expect(result.current.launchpad).toMatchObject({
      siteUrl: 'https://acme.clients.example',
      coinsCount: 3,
      onchain: { launchpadCoinMint: 'Mint111' },
      versions: [{ jobId: JOB_ID, request: 'Blue' }],
    });
    expect(result.current.launchpad?.jobs).toHaveLength(1);
    const missing = renderHook(() => useLaunchpad(crypto.randomUUID()));
    await waitFor(() => expect(missing.result.current.loading).toBe(false));
    expect(missing.result.current.launchpad).toBeNull();
    expect(missing.result.current.error).toBeNull();
    unmount();
    missing.unmount();
  });
});
