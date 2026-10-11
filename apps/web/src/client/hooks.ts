'use client';

import {
  AuthNonceRequest,
  AuthNonceResponse,
  AuthVerifyRequest,
  AuthLogoutResponse,
  AuthVerifyResponse,
  ChatRequest,
  ClientError,
  FlagsResponse,
  GatingResponse,
  WEB_API_ROUTES,
  type Flags,
  type Gating,
  type Job,
  type JobEvent,
  type LaunchpadSpecDraft,
  type SpecValidation,
  type UiChatMessage,
  type UseChatOptions,
  type UseChatResult,
  type UseGatingResult,
  type UseJobResult,
  type UseSessionResult,
} from '@forge/shared';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { base58Encode } from './base58';
import {
  fetchJob,
  fetchJobEvents,
  JobEventRowSchema,
  JobRowSchema,
  mapJob,
  mapJobEvent,
} from './data';
import { errorMessage, isUserRejection } from './errors';
import { rawRequest, request, validateBody } from './http';
import {
  fetchLaunchpadDetail,
  fetchLaunchpadList,
  subscribeLaunchpadChanges,
  type LaunchpadChange,
} from './launchpads';
import {
  getServerSessionSnapshot,
  getSessionSnapshot,
  setSession,
  subscribeSession,
} from './session-store';
import { readChatStream } from './stream';
import { getServerSupabaseSnapshot, getSupabaseSnapshot, subscribeSupabase } from './supabase';
import type {
  LaunchpadDetailView,
  LaunchpadSummaryView,
  UseLaunchpadView,
  UseLaunchpadsView,
} from './types';

function useSupabaseClient(): SupabaseClient | null {
  return useSyncExternalStore(subscribeSupabase, getSupabaseSnapshot, getServerSupabaseSnapshot);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export function useSession(): UseSessionResult {
  const stored = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getServerSessionSnapshot,
  );
  const wallet = useWallet();
  const modal = useWalletModal();
  const [status, setStatus] = useState<UseSessionResult['status']>('idle');
  // Bumped by connect/disconnect so a late session restore never overrides them.
  const epoch = useRef(0);

  // Restore the cookie session (the HttpOnly cookie is the source of truth).
  useEffect(() => {
    const ctrl = new AbortController();
    const startedAt = epoch.current;
    request(WEB_API_ROUTES.authSession.path, AuthVerifyResponse, {
      signal: ctrl.signal,
      keepSessionOn401: true,
    })
      .then((res) => {
        if (!ctrl.signal.aborted && epoch.current === startedAt) setSession({ wallet: res.wallet });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || epoch.current !== startedAt) return;
        if (err instanceof ClientError && err.code === 'UNAUTHORIZED') setSession(null);
      });
    return () => ctrl.abort();
  }, []);

  const connectedWallet = wallet.publicKey?.toBase58() ?? null;
  // A stored session only counts while the same wallet is connected (or still reconnecting).
  const session =
    stored && (connectedWallet === null ? wallet.connecting : connectedWallet === stored.wallet)
      ? stored
      : null;

  const connect = useCallback(async () => {
    setStatus('idle');
    epoch.current += 1;
    try {
      if (!wallet.connected) {
        if (!wallet.wallet) {
          modal.setVisible(true);
          return;
        }
        await wallet.connect();
      }
      const adapter = wallet.wallet?.adapter;
      const publicKey = wallet.publicKey ?? adapter?.publicKey ?? null;
      const adapterSign =
        adapter && 'signMessage' in adapter && typeof adapter.signMessage === 'function'
          ? (m: Uint8Array) => adapter.signMessage(m)
          : undefined;
      const signMessage = wallet.signMessage ?? adapterSign;
      if (!publicKey) return;
      if (!signMessage) {
        throw new Error('This wallet cannot sign messages.');
      }
      setStatus('signing');
      const address = publicKey.toBase58();
      const { nonce, message } = await request(WEB_API_ROUTES.authNonce.path, AuthNonceResponse, {
        method: 'POST',
        body: validateBody(AuthNonceRequest, { wallet: address }),
      });
      let signature: Uint8Array;
      try {
        signature = await signMessage(new TextEncoder().encode(message));
      } catch (err) {
        if (isUserRejection(err)) {
          setStatus('idle');
          return;
        }
        throw err;
      }
      const res = await request(WEB_API_ROUTES.authVerify.path, AuthVerifyResponse, {
        method: 'POST',
        body: validateBody(AuthVerifyRequest, {
          wallet: address,
          signature: base58Encode(signature),
          nonce,
        }),
      });
      setSession({ wallet: res.wallet });
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }
  }, [wallet, modal]);

  const disconnect = useCallback(async () => {
    epoch.current += 1;
    setStatus('idle');
    try {
      await request(WEB_API_ROUTES.authLogout.path, AuthLogoutResponse, { method: 'POST' });
    } catch {
      // the local state is cleared anyway
    }
    setSession(null);
    try {
      await wallet.disconnect();
    } catch {
      // already disconnected
    }
  }, [wallet]);

  return { session, connect, disconnect, status };
}

// ---------------------------------------------------------------------------
// Flags / gating
// ---------------------------------------------------------------------------

export function useFlags(): Flags {
  const [flags, setFlags] = useState<Flags>({ signupsPaused: false });
  useEffect(() => {
    const ctrl = new AbortController();
    request(WEB_API_ROUTES.flags.path, FlagsResponse, { signal: ctrl.signal })
      .then((f) => setFlags({ signupsPaused: f.signupsPaused }))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);
  return flags;
}

export function useGating(): UseGatingResult {
  const stored = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getServerSessionSnapshot,
  );
  const [gating, setGating] = useState<Gating | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const recheck = useCallback(async () => {
    setLoading(true);
    try {
      const g = await request(WEB_API_ROUTES.gating.path, GatingResponse);
      if (mounted.current) setGating(g);
    } catch {
      if (mounted.current) setGating(null);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void recheck();
    return () => {
      mounted.current = false;
    };
  }, [recheck, stored?.wallet]);

  return { gating, loading, recheck };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const EMPTY_VALIDATION: SpecValidation = { complete: false, errors: {} };

export function useChat(opts: UseChatOptions): UseChatResult {
  const [messages, setMessages] = useState<UiChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [spec, setSpec] = useState<LaunchpadSpecDraft>({});
  const [validation, setValidation] = useState<SpecValidation>(EMPTY_VALIDATION);
  const [rateLimited, setRateLimited] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(opts.conversationId ?? null);
  const conversationRef = useRef<string | null>(opts.conversationId ?? null);
  const busy = useRef(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const appendAssistant = useCallback((text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant') {
        return [...prev.slice(0, -1), { role: 'assistant', content: last.content + text }];
      }
      return [...prev, { role: 'assistant', content: text }];
    });
  }, []);

  const send = useCallback(
    (text: string) => {
      const message = text.trim();
      if (!message || busy.current) return;
      busy.current = true;
      setRateLimited(false);
      setStreaming(true);
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: message },
        { role: 'assistant', content: '' },
      ]);
      const ctrl = new AbortController();
      abort.current = ctrl;

      const run = async () => {
        let wroteText = false;
        const fail = (code: string, msg: string) => {
          if (code === 'RATE_LIMITED') setRateLimited(true);
          appendAssistant(wroteText ? `\n\n${msg}` : msg);
          wroteText = true;
        };
        try {
          const body = validateBody(ChatRequest, {
            ...(conversationRef.current ? { conversationId: conversationRef.current } : {}),
            ...(opts.launchpadId ? { launchpadId: opts.launchpadId } : {}),
            message,
          });
          const res = await rawRequest(WEB_API_ROUTES.chat.path, {
            method: 'POST',
            body,
            signal: ctrl.signal,
          });
          if (!res.body) throw new ClientError('NETWORK', 'The server sent an empty response.');
          for await (const ev of readChatStream(res.body)) {
            if (ev.type === 'conversation') {
              conversationRef.current = ev.conversationId;
              setConversationId(ev.conversationId);
            } else if (ev.type === 'text') {
              wroteText = wroteText || ev.delta.length > 0;
              appendAssistant(ev.delta);
            } else if (ev.type === 'spec') {
              setSpec(ev.spec);
              setValidation(ev.validation);
            } else if (ev.type === 'error') {
              fail(ev.code, ev.message);
            } else {
              break;
            }
          }
        } catch (err) {
          if (ctrl.signal.aborted) return;
          if (err instanceof ClientError) fail(err.code, err.message);
          else fail('NETWORK', errorMessage(err));
        } finally {
          busy.current = false;
          if (!ctrl.signal.aborted) setStreaming(false);
        }
      };
      void run();
    },
    [appendAssistant, opts.launchpadId],
  );

  return { messages, send, streaming, spec, validation, rateLimited, conversationId };
}

// ---------------------------------------------------------------------------
// Realtime job
// ---------------------------------------------------------------------------

export function useJob(jobId: string): UseJobResult {
  const sb = useSupabaseClient();
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sb) return;
    let active = true;
    setLoading(true);
    const channel = sb
      .channel(`job:${jobId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'jobs', filter: `id=eq.${jobId}` },
        (payload) => {
          const parsed = JobRowSchema.safeParse(payload.new);
          if (!active || !parsed.success) return;
          setJob((prev) => {
            const next = mapJob(parsed.data);
            return prev?.refund !== undefined ? { ...next, refund: prev.refund } : next;
          });
          if (parsed.data.status === 'refunded') {
            void fetchJob(sb, jobId)
              .then((j) => active && j && setJob(j))
              .catch(() => undefined);
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'job_events', filter: `job_id=eq.${jobId}` },
        (payload) => {
          const parsed = JobEventRowSchema.safeParse(payload.new);
          if (!active || !parsed.success) return;
          const ev = mapJobEvent(parsed.data);
          setEvents((prev) =>
            prev.some((e) => e.id === ev.id) ? prev : [...prev, ev].sort((a, b) => a.id - b.id),
          );
        },
      )
      .subscribe();

    Promise.all([fetchJob(sb, jobId), fetchJobEvents(sb, jobId)])
      .then(([j, evs]) => {
        if (!active) return;
        // realtime payloads that arrived first win over the older initial fetch
        setJob((prev) => prev ?? j);
        setEvents((prev) => {
          const map = new Map<number, JobEvent>();
          for (const e of [...evs, ...prev]) map.set(e.id, e);
          return [...map.values()].sort((a, b) => a.id - b.id);
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      void sb.removeChannel(channel);
    };
  }, [sb, jobId]);

  return { job, events, loading };
}

// ---------------------------------------------------------------------------
// Launchpads (API reads, refreshed on Realtime changes)
// ---------------------------------------------------------------------------

/** Bursts of Realtime changes (a job moving through statuses) are read once. */
export const LAUNCHPAD_REFRESH_DEBOUNCE_MS = 1_000;

/**
 * Calls `onChange(at)` after Realtime changes matching `filter` (debounced); `at` is the time of
 * the first change of the burst, so the read that follows ignores older shared reads.
 */
function useLaunchpadChanges(
  sb: SupabaseClient | null,
  filter: (change: LaunchpadChange) => boolean,
  onChange: (at: number) => void,
): void {
  const latest = useRef({ filter, onChange });
  latest.current = { filter, onChange };
  useEffect(() => {
    if (!sb) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let since = 0;
    const off = subscribeLaunchpadChanges(sb, (change) => {
      if (!latest.current.filter(change)) return;
      if (timer) return;
      since = change.at;
      timer = setTimeout(() => {
        timer = null;
        latest.current.onChange(since);
      }, LAUNCHPAD_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [sb]);
}

export function useLaunchpads(): UseLaunchpadsView {
  const sb = useSupabaseClient();
  const [launchpads, setLaunchpads] = useState<LaunchpadSummaryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `notBefore` of the next read: 0 on mount (a recent shared read is fine), then fresher.
  const [readSince, setReadSince] = useState<number | null>(null);
  const refresh = useCallback(() => setReadSince(Date.now()), []);
  useLaunchpadChanges(sb, () => true, setReadSince);

  useEffect(() => {
    let active = true;
    fetchLaunchpadList(readSince === null ? {} : { notBefore: readSince })
      .then((list) => {
        if (!active) return;
        setLaunchpads(list);
        setError(null);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [readSince]);

  return { launchpads, loading, refresh, error };
}

export function useLaunchpad(id: string): UseLaunchpadView {
  const sb = useSupabaseClient();
  const [launchpad, setLaunchpad] = useState<LaunchpadDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readSince, setReadSince] = useState<number | null>(null);
  const refresh = useCallback(() => setReadSince(Date.now()), []);
  useLaunchpadChanges(
    sb,
    (change) => change.launchpadId === null || change.launchpadId === id,
    setReadSince,
  );

  useEffect(() => {
    let active = true;
    fetchLaunchpadDetail(id, readSince === null ? {} : { notBefore: readSince })
      .then((detail) => {
        if (!active) return;
        setLaunchpad(detail);
        setError(null);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, readSince]);

  return { launchpad, loading, error, refresh };
}
