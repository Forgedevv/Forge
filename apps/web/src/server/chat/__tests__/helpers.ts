import type { ChatStreamEvent, LaunchpadSpec, LaunchpadSpecDraft } from '@forge/shared';
import type { ModelEvent, ModelRequest, ModelStreamer } from '../anthropic';
import { DEFAULT_LIMITS, type ChatConfig, type ChatLimits } from '../config';
import { MemoryRateLimiter } from '../rate-limit';
import { createSessionToken } from '@/server/auth/session';
import type { ChatDeps } from '../handler';
import type {
  ChatStore,
  ConfirmOutcome,
  ConversationRecord,
  ConversationState,
  NewMessage,
} from '../store';

export const SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
export const APP = 'https://forge.app';
export const WALLET = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
export const OTHER_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

export function setTestEnv(): void {
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.NEXT_PUBLIC_APP_URL = APP;
}

export function sessionCookie(wallet = WALLET): string {
  return `__Host-forge_session=${createSessionToken(Buffer.from(SESSION_SECRET), wallet)}`;
}

export function postJson(
  path: string,
  body: unknown,
  opts: { cookie?: string | null; headers?: Record<string, string> } = {},
): Request {
  const cookie = opts.cookie === undefined ? sessionCookie() : opts.cookie;
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: APP,
      ...(cookie ? { cookie } : {}),
      ...opts.headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Reads a whole SSE response into parsed events and the raw text. */
export async function readEvents(
  response: Response,
): Promise<{ events: ChatStreamEvent[]; raw: string }> {
  const raw = await response.text();
  const events: ChatStreamEvent[] = [];
  for (const block of raw.split('\n\n')) {
    if (block === '') continue;
    expectDataLine(block);
    events.push(JSON.parse(block.slice('data: '.length)) as ChatStreamEvent);
  }
  return { events, raw };
}

function expectDataLine(block: string): void {
  if (!block.startsWith('data: ') || block.includes('\n')) {
    throw new Error(`Not a single data line: ${block}`);
  }
}

export function testConfig(limits: Partial<ChatLimits> = {}): ChatConfig {
  return {
    apiKey: 'test-key-not-real',
    apiUrl: 'https://api.example.test/v1/messages',
    model: 'claude-sonnet-5-5',
    limits: { ...DEFAULT_LIMITS, ...limits },
  };
}

/** A streamer that replays scripted rounds and records the requests it received. */
export function scriptedStreamer(rounds: (ModelEvent[] | Error)[]): ModelStreamer & {
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let i = 0;
  const fn = async function* (request: ModelRequest): AsyncGenerator<ModelEvent> {
    requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ModelRequest);
    const round = rounds[Math.min(i, rounds.length - 1)];
    i++;
    if (round instanceof Error) throw round;
    for (const ev of round ?? []) {
      yield ev;
      // Let abort signals and consumers interleave like a real network stream.
      await Promise.resolve();
    }
  };
  return Object.assign(fn, { requests });
}

/** Rejects with an AbortError as soon as the signal aborts (immediately if it already did). */
export function rejectOnAbort(signal: AbortSignal, onAbort?: () => void): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fire = () => {
      onAbort?.();
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal.aborted) fire();
    else signal.addEventListener('abort', fire, { once: true });
  });
}

export const usage = (input = 100, output = 50): ModelEvent => ({
  type: 'usage',
  inputTokens: input,
  outputTokens: output,
});
export const stop = (reason = 'end_turn'): ModelEvent => ({ type: 'stop', reason });
export const text = (delta: string): ModelEvent => ({ type: 'text', delta });
export const toolUse = (input: unknown, id = 'toolu_1'): ModelEvent => ({
  type: 'tool_use',
  id,
  name: 'update_spec',
  input,
  inputError: null,
});

/** In-memory ChatStore with the same wallet scoping as the Supabase one. */
export class MemoryStore implements ChatStore {
  conversations = new Map<
    string,
    {
      owner: string;
      launchpadId: string | null;
      spec: LaunchpadSpecDraft | null;
      costUsd: number;
      lastActivity: number;
    }
  >();
  messages = new Map<string, NewMessage[]>();
  launchpads = new Map<string, { owner: string; spec: LaunchpadSpecDraft }>();
  flags: Record<string, boolean> = {};
  users = new Set<string>();
  confirmed: { wallet: string; conversationId: string; spec: LaunchpadSpec }[] = [];
  confirmOutcome: ConfirmOutcome = { status: 'created', launchpadId: 'lp-1', jobId: 'job-1' };
  /** Every cost increment, in order (to assert per-round persistence). */
  costWrites: { conversationId: string; deltaUsd: number }[] = [];
  /** Every draft write, in order. */
  draftWrites: LaunchpadSpecDraft[] = [];
  /** When set, addCost rejects (database down). */
  failCost = false;
  /** Hook run at each cost increment (tests inspect the stream state at that moment). */
  onCost: ((total: number) => void) | null = null;
  clock: () => number = Date.now;
  private next = 0;

  ensureUser(wallet: string): Promise<void> {
    this.users.add(wallet);
    return Promise.resolve();
  }

  createConversation(wallet: string, launchpadId: string | null): Promise<string> {
    const id = `00000000-0000-4000-8000-${String(++this.next).padStart(12, '0')}`;
    this.conversations.set(id, {
      owner: wallet,
      launchpadId,
      spec: null,
      costUsd: 0,
      lastActivity: 0,
    });
    this.messages.set(id, []);
    this.users.add(wallet);
    return Promise.resolve(id);
  }

  getConversation(id: string, wallet: string): Promise<ConversationRecord | null> {
    const c = this.conversations.get(id);
    return Promise.resolve(c && c.owner === wallet ? { id, launchpadId: c.launchpadId } : null);
  }

  getLaunchpadSpec(launchpadId: string, wallet: string): Promise<LaunchpadSpecDraft | null> {
    const l = this.launchpads.get(launchpadId);
    return Promise.resolve(l && l.owner === wallet ? l.spec : null);
  }

  loadState(conversationId: string, wallet: string): Promise<ConversationState> {
    const c = this.conversations.get(conversationId);
    const mine = c && c.owner === wallet ? c : null;
    const rows = mine ? (this.messages.get(conversationId) ?? []) : [];
    return Promise.resolve({
      draft: mine?.spec ?? null,
      costUsd: mine?.costUsd ?? 0,
      userMessageCount: rows.filter((r) => r.role === 'user').length,
      history: rows.map((r) => ({ role: r.role, content: r.content })),
    });
  }

  appendMessages(conversationId: string, rows: NewMessage[]): Promise<void> {
    this.messages.get(conversationId)?.push(...rows);
    const c = this.conversations.get(conversationId);
    if (c && rows.length > 0) c.lastActivity = this.clock();
    return Promise.resolve();
  }

  saveDraft(conversationId: string, wallet: string, draft: LaunchpadSpecDraft): Promise<void> {
    const c = this.conversations.get(conversationId);
    if (c && c.owner === wallet) {
      c.spec = structuredClone(draft);
      this.draftWrites.push(structuredClone(draft));
    }
    return Promise.resolve();
  }

  addCost(conversationId: string, wallet: string, deltaUsd: number): Promise<number> {
    if (this.failCost) return Promise.reject(new Error('database down'));
    const c = this.conversations.get(conversationId);
    if (!c || c.owner !== wallet) return Promise.reject(new Error('no conversation'));
    c.costUsd += deltaUsd;
    this.costWrites.push({ conversationId, deltaUsd });
    this.onCost?.(c.costUsd);
    return Promise.resolve(c.costUsd);
  }

  walletSpendSince(wallet: string, since: Date): Promise<number> {
    let total = 0;
    for (const c of this.conversations.values()) {
      if (c.owner === wallet && c.lastActivity >= since.getTime()) total += c.costUsd;
    }
    return Promise.resolve(total);
  }

  getFlag(key: 'signups_paused'): Promise<boolean> {
    return Promise.resolve(this.flags[key] === true);
  }

  confirmSpec(input: {
    wallet: string;
    conversationId: string;
    spec: LaunchpadSpec;
  }): Promise<ConfirmOutcome> {
    this.confirmed.push(input);
    return Promise.resolve(this.confirmOutcome);
  }

  /** Messages of a conversation as stored, by role. */
  rows(conversationId: string, role?: NewMessage['role']): NewMessage[] {
    return (this.messages.get(conversationId) ?? []).filter((m) => !role || m.role === role);
  }

  /** Total model spend recorded for a conversation. */
  cost(conversationId: string): number {
    return this.conversations.get(conversationId)?.costUsd ?? 0;
  }
}

export function makeDeps(
  overrides: Partial<Omit<ChatDeps, 'store'>> & {
    store?: MemoryStore;
    streamer?: ModelStreamer;
  } = {},
): Omit<ChatDeps, 'store'> & { store: () => MemoryStore } {
  const { store: given, streamer, ...rest } = overrides;
  const store = given ?? new MemoryStore();
  const limiter = new MemoryRateLimiter();
  return {
    store: () => store,
    limiter: () => limiter,
    gating: () => Promise.resolve({ enabled: false, ok: true }),
    loadConfig: () => testConfig(),
    streamerFor: () => streamer ?? scriptedStreamer([[text('Hi'), usage(), stop()]]),
    ...rest,
  };
}

export function validSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    ownerWallet: WALLET,
    name: 'MoonPad',
    slug: 'moonpad',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0.01,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: 'Launch your next moonshot',
      designNotes: 'Dark, glossy, space themed hero with rounded cards.',
    },
    launchpadCoin: {
      name: 'Moon Coin',
      symbol: 'MOON',
      description: 'The coin of MoonPad.',
      imageUrl: 'https://cdn.example.com/moon.png',
      firstBuySol: 1,
    },
    ...overrides,
  };
}
