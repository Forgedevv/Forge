import { ChatRequest, type ChatStreamEvent } from '@forge/shared';
import { z } from 'zod';
import { checkOrigin, requireSession } from '@/server/auth';
import { createAnthropicStreamer, type ModelStreamer } from './anthropic';
import { ChatConfigError, loadChatConfig, type ChatConfig } from './config';
import { GatingError, getDefaultGatingCheck, type GatingCheck } from './gating';
import { buildModelMessages } from './history';
import { apiError, readBoundedJson } from './http';
import { clientIp, getDefaultRateLimiter, type RateLimiter } from './rate-limit';
import { initialDraft, normalizeDraft, validateDraft, type SpecMode } from './spec-draft';
import { getDefaultStore, StoreError, type ChatStore } from './store';
import { runTurn } from './turn';

/*
 * POST /api/chat. Everything that can fail before the model is called (origin, session, body,
 * limits, gating, conversation ownership) answers with a plain HTTP error `{ code, message }`.
 * Once the stream is open, failures are `error` events followed by `done`.
 */

export interface ChatDeps {
  store: () => ChatStore;
  limiter: () => RateLimiter;
  gating: GatingCheck;
  loadConfig: () => ChatConfig;
  streamerFor: (config: ChatConfig) => ModelStreamer;
  now?: () => number;
}

export function defaultChatDeps(): ChatDeps {
  return {
    store: getDefaultStore,
    limiter: getDefaultRateLimiter,
    gating: (wallet) => getDefaultGatingCheck()(wallet),
    loadConfig: () => loadChatConfig(),
    streamerFor: (config) =>
      createAnthropicStreamer({ apiKey: config.apiKey, apiUrl: config.apiUrl }),
  };
}

const CONTROL_CHARS = /[^\P{Cc}\n\t]|[\p{Zl}\p{Zp}]/gu;

/** Removes control characters and surrounding whitespace from a user message. */
export function cleanMessage(message: string): string {
  return message.replace(CONTROL_CHARS, '').trim();
}

function bodySchema(maxChars: number) {
  return z.strictObject({
    ...ChatRequest.shape,
    message: z.string().min(1).max(maxChars),
  });
}

export function encodeSse(event: ChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

function limited(retryAfterSeconds: number, message: string): Response {
  return apiError(429, 'RATE_LIMITED', message, { 'Retry-After': String(retryAfterSeconds) });
}

const DAY_MS = 24 * 60 * 60_000;

export async function handleChat(
  request: Request,
  deps: ChatDeps = defaultChatDeps(),
): Promise<Response> {
  const now = deps.now ?? Date.now;
  // Everything below, pre-turn work included, must fit in limits.requestBudgetMs.
  const receivedAt = now();
  let release: (() => void) | null = null;
  try {
    let forbidden: Response | null;
    try {
      forbidden = checkOrigin(request);
    } catch {
      return apiError(500, 'SERVER_ERROR', 'The chat is temporarily unavailable.');
    }
    if (forbidden) return forbidden;

    const session = requireSession(request);
    if (session instanceof Response) return session;
    const wallet = session.wallet;

    let config: ChatConfig;
    try {
      config = deps.loadConfig();
    } catch (error) {
      if (error instanceof ChatConfigError) console.error(`[chat] configuration: ${error.message}`);
      return apiError(503, 'SERVER_ERROR', 'The design chat is temporarily unavailable.');
    }
    const { limits } = config;

    const raw = await readBoundedJson(request);
    const parsed = bodySchema(limits.maxMessageChars).safeParse(raw);
    if (!parsed.success) {
      const tooLong =
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as { message?: unknown }).message === 'string' &&
        (raw as { message: string }).message.length > limits.maxMessageChars;
      return apiError(
        400,
        'BAD_REQUEST',
        tooLong
          ? `Messages are limited to ${limits.maxMessageChars} characters.`
          : 'Invalid chat request.',
      );
    }
    const body = parsed.data;
    const message = cleanMessage(body.message);
    if (message === '') return apiError(400, 'BAD_REQUEST', 'Invalid chat request.');

    // Rate limits: per IP, then per wallet (short window and daily).
    const limiter = deps.limiter();
    const byIp = await limiter.consume(
      `chat:ip:${clientIp(request)}`,
      limits.ipPerWindow,
      limits.ipWindowMs,
    );
    if (!byIp.allowed) {
      return limited(
        byIp.retryAfterSeconds,
        'Too many requests. Please wait a moment and try again.',
      );
    }
    const byWallet = await limiter.consume(
      `chat:wallet:${wallet}`,
      limits.walletPerWindow,
      limits.walletWindowMs,
    );
    if (!byWallet.allowed) {
      return limited(
        byWallet.retryAfterSeconds,
        'You are sending messages too quickly. Please wait a moment.',
      );
    }
    const byDay = await limiter.consume(`chat:wallet-day:${wallet}`, limits.walletPerDay, DAY_MS);
    if (!byDay.allowed) {
      return limited(
        byDay.retryAfterSeconds,
        'You reached the daily message limit. Please come back later.',
      );
    }
    release = await limiter.acquire(`chat:inflight:${wallet}`);
    if (release === null) {
      return limited(
        2,
        'Please wait for the current reply to finish before sending another message.',
      );
    }

    const store = deps.store();

    if (body.conversationId === undefined && body.launchpadId === undefined) {
      if (await store.getFlag('signups_paused')) {
        release();
        return apiError(403, 'SIGNUPS_PAUSED', 'New signups are temporarily paused.');
      }
    }

    const gate = await deps.gating(wallet);
    if (!gate.ok) {
      release();
      return apiError(
        403,
        'GATING_REQUIRED',
        'You need to hold more $FORGE to use the design assistant.',
      );
    }

    // Conversation: owned by the session wallet, or created for it.
    let conversationId: string;
    let launchpadId: string | null;
    const isNew = body.conversationId === undefined;
    if (body.conversationId !== undefined) {
      const conversation = await store.getConversation(body.conversationId, wallet);
      if (!conversation) {
        release();
        return apiError(404, 'NOT_FOUND', 'Conversation not found.');
      }
      if (body.launchpadId !== undefined && conversation.launchpadId !== body.launchpadId) {
        release();
        return apiError(400, 'BAD_REQUEST', 'This conversation belongs to another launchpad.');
      }
      conversationId = conversation.id;
      launchpadId = conversation.launchpadId;
    } else {
      launchpadId = body.launchpadId ?? null;
      if (launchpadId !== null && (await store.getLaunchpadSpec(launchpadId, wallet)) === null) {
        release();
        return apiError(404, 'NOT_FOUND', 'Launchpad not found.');
      }
      conversationId = await store.createConversation(wallet, launchpadId);
    }
    const mode: SpecMode = launchpadId === null ? 'create' : 'modify';

    const state = await store.loadState(conversationId, wallet);
    if (state.userMessageCount >= limits.maxUserMessagesPerConversation) {
      release();
      return limited(60, 'This conversation reached its message limit. Please start a new one.');
    }
    if (state.costUsd >= limits.conversationCostCapUsd) {
      release();
      return limited(60, 'This conversation reached its usage limit. Please start a new one.');
    }
    // Daily spend of the wallet, from the database (holds across server instances).
    const daySpend = await store.walletSpendSince(wallet, new Date(now() - DAY_MS));
    if (daySpend >= limits.walletDailyCostCapUsd) {
      release();
      return limited(
        60 * 60,
        'You reached the daily usage limit of the design assistant. Please come back tomorrow.',
      );
    }
    const budgetUsd = Math.min(
      limits.conversationCostCapUsd - state.costUsd,
      limits.walletDailyCostCapUsd - daySpend,
    );
    const deadlineAt = receivedAt + limits.requestBudgetMs;
    if (deadlineAt - now() < limits.minTurnMs) {
      release();
      return apiError(503, 'SERVER_ERROR', 'The design chat is busy. Please try again.');
    }

    let base = state.draft;
    if (base === null && launchpadId !== null)
      base = await store.getLaunchpadSpec(launchpadId, wallet);
    const draft = normalizeDraft(base ?? initialDraft(wallet), wallet);

    await store.appendMessages(conversationId, [{ role: 'user', content: message }]);
    const messages = buildModelMessages(state.history, message, limits.historyTokenBudget);

    // From here the response is a stream; the lock is released when it ends or is cancelled.
    const abort = new AbortController();
    request.signal.addEventListener('abort', () => abort.abort(), { once: true });
    const releaseOnce = release;
    release = null;
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      releaseOnce();
    };

    const streamer = deps.streamerFor(config);
    const events = (async function* (): AsyncGenerator<ChatStreamEvent> {
      yield { type: 'conversation', conversationId };
      if (state.draft !== null || mode === 'modify') {
        yield { type: 'spec', spec: draft, validation: validateDraft(draft) };
      }
      yield* runTurn({
        config,
        streamer,
        store,
        wallet,
        conversationId,
        mode,
        draft,
        storedDraft: state.draft,
        messages,
        budgetUsd,
        deadlineAt,
        signal: abort.signal,
        now,
      });
    })();
    void isNew;

    // Set by cancel(): nothing may be enqueued afterwards (the controller is closed).
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await events.next();
          if (cancelled) return;
          if (next.done) {
            controller.enqueue(encodeSse({ type: 'done' }));
            controller.close();
            finish();
            return;
          }
          controller.enqueue(encodeSse(next.value));
        } catch {
          if (cancelled) return;
          console.error('[chat] stream failed');
          controller.enqueue(
            encodeSse({
              type: 'error',
              code: 'NETWORK',
              message: 'The assistant is temporarily unavailable. Please try again.',
            }),
          );
          controller.enqueue(encodeSse({ type: 'done' }));
          controller.close();
          finish();
        }
      },
      async cancel() {
        cancelled = true;
        abort.abort();
        try {
          await events.return(undefined);
        } finally {
          finish();
        }
      },
    });
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  } catch (error) {
    release?.();
    if (error instanceof StoreError || error instanceof GatingError) {
      console.error(`[chat] ${error.name}: ${error.message}`);
    } else {
      console.error('[chat] unexpected error');
    }
    return apiError(503, 'SERVER_ERROR', 'The design chat is temporarily unavailable.');
  }
}
