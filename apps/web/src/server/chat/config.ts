/*
 * Design chat configuration. Limits are code defaults; a few can be tuned through environment
 * variables (numbers only). The API key is read lazily and never logged.
 */

export const CHAT_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

/** USD per million tokens (first-party rates for the model above, see the builder gateway table). */
export const CHAT_PRICING = { inputPerMTok: 2, outputPerMTok: 10 } as const;

/** Environment variables as read by the chat (a subset of process.env). */
export type Env = Readonly<Record<string, string | undefined>>;

export class ChatConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatConfigError';
  }
}

export interface ChatLimits {
  /** Max characters of one user message. */
  maxMessageChars: number;
  /** Max tokens the model may generate per request. */
  maxOutputTokens: number;
  /** Approximate token budget of the history sent to the model (older turns are dropped). */
  historyTokenBudget: number;
  /** Whole turn, tool rounds included (model calls only). */
  turnTimeoutMs: number;
  /**
   * Budget of the whole request from its arrival: pre-turn work (session, limits, gating,
   * database reads) plus the turn. Kept well under the route `maxDuration`
   * (app/api/chat/route.ts) so the last cost write always runs before the platform kills the
   * function. The turn gets min(turnTimeoutMs, what is left of this budget).
   */
  requestBudgetMs: number;
  /** A turn with less time than this left is not started (the model call would be cut short). */
  minTurnMs: number;
  /** Model calls per turn (a tool call needs one more call to get the follow-up text). */
  maxModelRounds: number;
  /** Total model spend allowed for one conversation. */
  conversationCostCapUsd: number;
  /**
   * Model spend allowed per wallet over a rolling 24 hours, all conversations together. Computed
   * from `conversations.cost_usd` in the database, so it holds across server instances.
   */
  walletDailyCostCapUsd: number;
  /** User messages allowed in one conversation. */
  maxUserMessagesPerConversation: number;
  /** Per wallet: messages per short window and per day. */
  walletPerWindow: number;
  walletWindowMs: number;
  walletPerDay: number;
  /** Per IP: messages per window. */
  ipPerWindow: number;
  ipWindowMs: number;
}

export const DEFAULT_LIMITS: ChatLimits = {
  maxMessageChars: 2000,
  maxOutputTokens: 1500,
  historyTokenBudget: 6000,
  turnTimeoutMs: 45_000,
  requestBudgetMs: 50_000,
  minTurnMs: 5_000,
  maxModelRounds: 3,
  conversationCostCapUsd: 1,
  walletDailyCostCapUsd: 5,
  maxUserMessagesPerConversation: 60,
  walletPerWindow: 15,
  walletWindowMs: 10 * 60_000,
  walletPerDay: 150,
  ipPerWindow: 40,
  ipWindowMs: 10 * 60_000,
};

export interface ChatConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
  limits: ChatLimits;
}

function positiveNumber(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadChatConfig(env: Env = process.env): ChatConfig {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new ChatConfigError('ANTHROPIC_API_KEY is not set');
  }
  const d = DEFAULT_LIMITS;
  return {
    apiKey,
    apiUrl: ANTHROPIC_API_URL,
    model: CHAT_MODEL,
    limits: {
      ...d,
      conversationCostCapUsd: positiveNumber(
        env,
        'CHAT_CONVERSATION_COST_CAP_USD',
        d.conversationCostCapUsd,
      ),
      walletDailyCostCapUsd: positiveNumber(
        env,
        'CHAT_WALLET_DAILY_COST_CAP_USD',
        d.walletDailyCostCapUsd,
      ),
      walletPerWindow: positiveNumber(env, 'CHAT_WALLET_MESSAGES_PER_10_MIN', d.walletPerWindow),
      walletPerDay: positiveNumber(env, 'CHAT_WALLET_MESSAGES_PER_DAY', d.walletPerDay),
      ipPerWindow: positiveNumber(env, 'CHAT_IP_MESSAGES_PER_10_MIN', d.ipPerWindow),
    },
  };
}

/** Cost in USD of a model call. */
export function costUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * CHAT_PRICING.inputPerMTok + outputTokens * CHAT_PRICING.outputPerMTok) /
    1_000_000
  );
}

/** Conservative token estimate (3 characters per token) used for the history budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
