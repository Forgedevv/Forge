'use client';

import { useSyncExternalStore } from 'react';
import {
  ClientError,
  type WebClient,
  type UseSessionResult,
  type UseGatingResult,
  type UseChatResult,
  type Job,
  type JobEvent,
  type JobStatus,
  type LaunchpadSummary,
  type TxPhase,
  type TxResult,
} from '@forge/shared';
import {
  detailFor,
  eventFor,
  fixtureJob,
  fixturePad,
  fixturePads,
  fullSpec,
  mockChatCopy,
  mockWallet,
  otherWallet,
  ownerSummary,
} from './fixtures';
import { formatSol, formatUsd, shortAddress, explorerTxUrl } from '../workspace/format';

type ChatState = Omit<UseChatResult, 'send'> & { turns: number };
interface Snapshot {
  session: UseSessionResult['session'];
  sessionStatus: UseSessionResult['status'];
  gating: UseGatingResult['gating'];
  loading: boolean;
  networkError: boolean;
  jobs: Record<string, Job>;
  events: Record<string, JobEvent[]>;
  pads: LaunchpadSummary[];
  chats: Record<string, ChatState>;
  signupsPaused: boolean;
}

export function createMockController(scenario = 'journey') {
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let started = false;
  const initialStatus = scenario.startsWith('job:')
    ? (scenario.slice(4).split('-')[0] as JobStatus)
    : 'spec_ready';
  const job: Job = {
    ...fixtureJob,
    status: initialStatus,
    type: scenario.includes('modification') ? 'modify_launchpad' : 'create_launchpad',
  };
  if (scenario.includes('retry')) {
    job.status = 'failed';
    job.failedStage = 'build';
    job.attempts = 1;
  }
  if (scenario.includes('build-exhausted')) {
    job.status = 'failed';
    job.failedStage = 'build';
    job.attempts = 2;
  }
  if (scenario.includes('onchain') && scenario.includes('failed')) {
    job.status = 'failed';
    job.failedStage = 'onchain';
    job.error = 'Configuration could not be completed.';
  }
  if (scenario.includes('deploy-failed')) {
    job.status = 'failed';
    job.failedStage = 'deploy';
    job.error = 'Deployment could not be completed.';
  }
  if (scenario.includes('refunded')) {
    job.status = 'refunded';
    job.refund = { lamports: '300000000', signature: 'demo-refund-confirmation' };
  }
  const emptyChat = (modification = false): ChatState => ({
    messages: [
      {
        role: 'assistant',
        content: modification ? mockChatCopy.modificationWelcome : mockChatCopy.welcome,
      },
    ],
    streaming: false,
    spec: {},
    validation: { complete: false, errors: {} },
    rateLimited: scenario === 'chat:rate-limited',
    conversationId: 'demo-conversation',
    turns: 0,
  });
  const chat = emptyChat();
  if (scenario === 'chat:streaming') {
    chat.streaming = true;
    chat.messages.push({ role: 'assistant', content: 'Your blueprint is taking shape' });
  }
  if (scenario.startsWith('launch:')) job.status = 'awaiting_owner_signature';
  if (
    ['chat:conversation', 'chat:incomplete', 'chat:ready', 'chat:confirming'].includes(scenario)
  ) {
    chat.spec =
      scenario === 'chat:conversation'
        ? { name: fullSpec.name, slug: fullSpec.slug }
        : { ...fullSpec };
    chat.validation = {
      complete: scenario === 'chat:ready' || scenario === 'chat:confirming',
      errors:
        scenario === 'chat:incomplete' ? { 'launchpadCoin.symbol': mockChatCopy.fieldError } : {},
    };
    if (scenario === 'chat:incomplete')
      chat.spec.launchpadCoin = { ...fullSpec.launchpadCoin, symbol: '' };
    chat.messages.push(
      { role: 'user', content: 'A midnight launchpad called Orbit.' },
      { role: 'assistant', content: mockChatCopy.replies[chat.validation.complete ? 3 : 0] },
    );
    chat.turns = chat.validation.complete ? 4 : 1;
  }
  let state: Snapshot = {
    session:
      scenario === 'journey' ||
      (scenario.startsWith('session:') && scenario !== 'session:connected') ||
      scenario === 'global:disconnected'
        ? null
        : { wallet: scenario === 'launch:wrong-wallet' ? otherWallet : mockWallet },
    sessionStatus:
      scenario === 'session:signing' ? 'signing' : scenario === 'session:error' ? 'error' : 'idle',
    gating: {
      ok: scenario !== 'gating:insufficient',
      required: '1000000',
      balance: scenario === 'gating:insufficient' ? '250000' : '2500000',
      enabled: scenario !== 'gating:disabled',
    },
    loading: scenario.endsWith(':loading') || scenario === 'gating:checking',
    networkError: scenario === 'global:network-error',
    jobs: scenario === 'global:not-found' ? {} : { 'demo-job': job },
    events: { 'demo-job': [eventFor(job, 1)] },
    pads:
      scenario === 'dashboard:empty'
        ? []
        : scenario === 'dashboard:three'
          ? fixturePads.map((p) => ({ ...p }))
          : [
              {
                ...fixturePad,
                claimablePartnerFeesLamports: [
                  'dashboard:no-fees',
                  'dashboard:claim-confirmed',
                ].includes(scenario)
                  ? '0'
                  : fixturePad.claimablePartnerFeesLamports,
                activeJobId: scenario === 'dashboard:active-job' ? 'demo-job' : null,
                status: scenario === 'dashboard:draft' ? 'draft' : 'live',
              },
            ],
    chats: {
      create: chat,
      modify:
        scenario === 'chat:modification'
          ? {
              ...emptyChat(true),
              messages: [
                { role: 'user', content: mockChatCopy.sampleRequest },
                { role: 'assistant', content: mockChatCopy.modificationReply },
              ],
              validation: { complete: true, errors: {} },
              turns: 1,
            }
          : emptyChat(true),
    },
    signupsPaused: scenario === 'home:paused',
  };
  const notify = (patch: Partial<Snapshot>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  function useSnapshot() {
    const snapshot = useSyncExternalStore(
      subscribe,
      () => state,
      () => state,
    );
    if (snapshot.networkError)
      throw new ClientError('NETWORK', 'The preview connection is unavailable.');
    return snapshot;
  }
  const later = (fn: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) fn();
    }, delay);
    timers.add(timer);
  };
  const wait = (delay = 450) => new Promise<void>((resolve) => later(resolve, delay));
  const updateJob = (id: string, status: JobStatus, extra: Partial<Job> = {}) => {
    const previous = state.jobs[id];
    if (!previous) return;
    const next = { ...previous, ...extra, status, updatedAt: new Date().toISOString() };
    const previousEvents = state.events[id] ?? [];
    notify({
      jobs: { ...state.jobs, [id]: next },
      events: {
        ...state.events,
        [id]: [...previousEvents, eventFor(next, previousEvents.length + 1)],
      },
    });
  };
  const progress = (id: string, autoplay = false) =>
    later(() => {
      const current = state.jobs[id];
      if (!current) return;
      const steps: JobStatus[] =
        current.type === 'modify_launchpad'
          ? ['paid', 'building', 'preview_ready', 'approved', 'deploying', 'live']
          : [
              'paid',
              'building',
              'preview_ready',
              'approved',
              'onchain_setup',
              'awaiting_owner_signature',
              'owner_signed',
              'deploying',
              'live',
            ];
      if (
        !autoplay &&
        ['preview_ready', 'awaiting_owner_signature', 'live'].includes(current.status)
      )
        return;
      if (current.status === 'failed' && current.failedStage === 'build' && current.attempts < 2) {
        updateJob(id, 'building', { attempts: 2, failedStage: null });
        progress(id, autoplay);
        return;
      }
      const next = steps[steps.indexOf(current.status) + 1];
      if (!next || current.status === 'failed' || current.status === 'refunded') return;
      updateJob(id, next);
      if (next === 'live')
        notify({
          pads: state.pads.map((p) =>
            p.id === current.launchpadId ? { ...p, status: 'live', activeJobId: null } : p,
          ),
        });
      if (next !== 'live') progress(id, autoplay);
    }, 3000);
  const transaction = async (onPhase: (phase: TxPhase) => void): Promise<TxResult> => {
    onPhase('awaiting_signature');
    await wait(800);
    if (scenario.includes('rejected')) {
      onPhase('rejected');
      return { phase: 'rejected' };
    }
    onPhase('sending');
    await wait(900);
    if (scenario.includes('send-error') || scenario === 'payment:check-failed') {
      onPhase('error');
      return {
        phase: 'error',
        error: 'The simulated transaction check failed. Try again or open help.',
      };
    }
    onPhase('confirmed');
    return { phase: 'confirmed', signature: 'demo-transaction-confirmation' };
  };
  let quoteSequence = 0;
  const client: WebClient = {
    useSession() {
      const s = useSnapshot();
      return {
        session: s.session,
        status: s.sessionStatus,
        connect: async () => {
          notify({ sessionStatus: 'signing' });
          await wait(800);
          if (scenario === 'session:rejected') {
            notify({ sessionStatus: 'idle' });
            throw new Error('Signature declined. Nothing was sent.');
          }
          if (scenario === 'session:error') {
            notify({ sessionStatus: 'error' });
            throw new ClientError('NETWORK', 'The wallet connection could not be completed.');
          }
          notify({ session: { wallet: mockWallet }, sessionStatus: 'idle' });
        },
        disconnect: async () => {
          notify({ session: null, sessionStatus: 'idle' });
        },
      };
    },
    useFlags() {
      return { signupsPaused: useSnapshot().signupsPaused };
    },
    useGating() {
      const s = useSnapshot();
      return {
        gating: s.loading ? null : s.gating,
        loading: s.loading,
        recheck: async () => {
          notify({ loading: true });
          await wait();
          notify({
            loading: false,
            gating: { ok: true, enabled: true, required: '1000000', balance: '2500000' },
          });
        },
      };
    },
    useChat(opts) {
      const key = opts.launchpadId ? 'modify' : 'create';
      const current = useSnapshot().chats[key]!;
      return {
        ...current,
        send(text) {
          if (scenario === 'chat:error') throw new ClientError('NETWORK', mockChatCopy.network);
          const before = state.chats[key]!;
          if (before.streaming || before.rateLimited || !text.trim()) return;
          const turns = before.turns + 1;
          const reply =
            key === 'modify'
              ? mockChatCopy.modificationReply
              : mockChatCopy.replies[Math.min(3, turns - 1)]!;
          const messages: ChatState['messages'] = [
            ...before.messages,
            { role: 'user', content: text },
            { role: 'assistant', content: '' },
          ];
          notify({ chats: { ...state.chats, [key]: { ...before, messages, streaming: true } } });
          const words = reply.split(' ');
          let shown = 0;
          const stream = () => {
            shown++;
            const nextMessages = [
              ...messages.slice(0, -1),
              { role: 'assistant' as const, content: words.slice(0, shown).join(' ') },
            ];
            const complete = shown >= words.length;
            const spec =
              turns >= 4
                ? fullSpec
                : turns >= 3
                  ? { ...before.spec, theme: fullSpec.theme }
                  : turns >= 2
                    ? {
                        ...before.spec,
                        tradingFeeBps: fullSpec.tradingFeeBps,
                        coinCreatorSharePct: fullSpec.coinCreatorSharePct,
                        poolCreationFeeSol: fullSpec.poolCreationFeeSol,
                        antiSniper: fullSpec.antiSniper,
                        ownerWallet: mockWallet,
                      }
                    : { name: fullSpec.name, slug: fullSpec.slug };
            notify({
              chats: {
                ...state.chats,
                [key]: {
                  ...before,
                  messages: nextMessages,
                  streaming: !complete,
                  spec: complete ? spec : before.spec,
                  validation: {
                    complete: complete && (turns >= 4 || key === 'modify'),
                    errors: {},
                  },
                  turns,
                },
              },
            });
            if (!complete) later(stream, 35);
          };
          later(stream, 35);
        },
      };
    },
    async confirmSpec(_conversationId, spec) {
      await wait();
      if (state.signupsPaused) throw new ClientError('SIGNUPS_PAUSED', 'Creation is paused.');
      if (!state.chats.create!.validation.complete)
        throw new Error('Complete your blueprint first.');
      const pad = {
        ...fixturePad,
        name: spec.name,
        slug: spec.slug,
        status: 'draft' as const,
        activeJobId: 'demo-job',
      };
      notify({
        pads: [pad, ...state.pads.filter((p) => p.id !== pad.id)],
        jobs: { ...state.jobs, 'demo-job': { ...fixtureJob } },
      });
      return { launchpadId: pad.id, jobId: 'demo-job' };
    },
    async requestModification(launchpadId, _conversationId, request) {
      await wait();
      if (!request.trim()) throw new Error('Describe your change first.');
      const next = {
        ...fixtureJob,
        id: 'demo-change-job',
        launchpadId,
        type: 'modify_launchpad' as const,
      };
      notify({
        jobs: { ...state.jobs, [next.id]: next },
        events: { ...state.events, [next.id]: [eventFor(next, 1)] },
      });
      return { jobId: next.id };
    },
    async getQuote(jobId, kind) {
      await wait();
      if (!state.jobs[jobId]) throw new Error('Job not found.');
      quoteSequence++;
      const included =
        (kind === 'modification' &&
          (state.pads.find((p) => p.id === state.jobs[jobId]?.launchpadId)
            ?.includedModificationsLeft ?? 0) > 0) ||
        scenario === 'payment:included';
      return {
        paymentId: `demo-quote-${quoteSequence}`,
        kind,
        lamports: included ? '0' : kind === 'creation' ? '300000000' : '50000000',
        usdAmount: included ? 0 : kind === 'creation' ? 33 : 5.5,
        expiresAt: new Date(
          Date.now() +
            (scenario === 'payment:expired' && quoteSequence === 1
              ? -1000
              : scenario === 'payment:expires-soon' && quoteSequence === 1
                ? 10000
                : 120000),
        ).toISOString(),
      };
    },
    async payQuote(quote, onPhase) {
      if (Date.parse(quote.expiresAt) <= Date.now())
        throw new ClientError('QUOTE_EXPIRED', 'This quote has expired. Get a new quote.');
      const result =
        quote.lamports === '0' ? { phase: 'confirmed' as const } : await transaction(onPhase);
      if (result.phase === 'confirmed') {
        if (quote.lamports === '0') onPhase('confirmed');
        const id =
          quote.kind === 'modification' && state.jobs['demo-change-job']
            ? 'demo-change-job'
            : 'demo-job';
        updateJob(id, 'paid');
        progress(id);
      }
      return result;
    },
    useJob(id) {
      const s = useSnapshot();
      return {
        job: s.loading ? null : (s.jobs[id] ?? null),
        events: s.events[id] ?? [],
        loading: s.loading,
      };
    },
    async approvePreview(id) {
      await wait();
      if (state.jobs[id]?.status !== 'preview_ready')
        throw new Error('The preview is not ready for approval.');
      updateJob(id, 'approved');
      progress(id);
    },
    async getOwnerTransactionSummary(id) {
      await wait();
      if (!state.jobs[id]) throw new Error('Job not found.');
      return ownerSummary;
    },
    async signOwnerTransaction(id, onPhase) {
      if (state.session?.wallet !== mockWallet)
        throw new ClientError('WRONG_WALLET', 'Connect the owner wallet to launch.');
      const result = await transaction(onPhase);
      if (result.phase === 'confirmed') {
        updateJob(id, 'owner_signed');
        progress(id);
      }
      return result;
    },
    useLaunchpads() {
      const s = useSnapshot();
      return { launchpads: s.pads, loading: s.loading, refresh: () => notify({ loading: false }) };
    },
    useLaunchpad(id) {
      const s = useSnapshot();
      const pad = s.pads.find((p) => p.id === id);
      return {
        launchpad: pad
          ? detailFor(
              pad,
              Object.values(s.jobs).filter((j) => j.launchpadId === id),
            )
          : null,
        loading: s.loading,
      };
    },
    async claimPartnerFees(id, onPhase) {
      const pad = state.pads.find((p) => p.id === id);
      if (!pad || pad.claimablePartnerFeesLamports === '0') return { phase: 'idle' };
      const result = await transaction(onPhase);
      if (result.phase === 'confirmed')
        notify({
          pads: state.pads.map((p) =>
            p.id === id ? { ...p, claimablePartnerFeesLamports: '0' } : p,
          ),
        });
      return result;
    },
    async reactivateLaunchpad(id) {
      await wait(700);
      notify({
        pads: state.pads.map((p) =>
          p.id === id && p.status === 'sleeping' ? { ...p, status: 'live' } : p,
        ),
      });
    },
    formatSol,
    formatUsd,
    shortAddress,
    explorerTxUrl,
  };
  return {
    client,
    scenario,
    start() {
      if (started) return;
      started = true;
      disposed = false;
      if (scenario === 'journey:auto') {
        updateJob('demo-job', 'paid');
        progress('demo-job', true);
      }
      if (scenario === 'job:retry') progress('demo-job', true);
    },
    recover() {
      notify({ networkError: false, loading: false });
    },
    dispose() {
      disposed = true;
      started = false;
      timers.forEach(clearTimeout);
      timers.clear();
    },
    snapshot: () => state,
  };
}

export type MockController = ReturnType<typeof createMockController>;
