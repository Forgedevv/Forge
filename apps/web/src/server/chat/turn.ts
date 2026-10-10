import type { ChatStreamEvent, LaunchpadSpecDraft } from '@forge/shared';
import { ModelError, type ContentBlock, type ModelMessage, type ModelStreamer } from './anthropic';
import { costUsd, estimateTokens, type ChatConfig } from './config';
import { buildSystemPrompt, LeakGuard } from './prompt';
import {
  applySpecPatch,
  buildUpdateSpecTool,
  draftKey,
  knownFieldLabel,
  UPDATE_SPEC_TOOL_NAME,
  validateDraft,
  type SpecMode,
} from './spec-draft';
import type { ChatStore, NewMessage } from './store';

export interface TurnInput {
  config: ChatConfig;
  streamer: ModelStreamer;
  store: ChatStore;
  wallet: string;
  conversationId: string;
  mode: SpecMode;
  /** Draft at the start of the turn (already normalized). */
  draft: LaunchpadSpecDraft;
  /** Draft as stored in the database, to know whether it must be written. */
  storedDraft: LaunchpadSpecDraft | null;
  /** History plus the new user message, already trimmed. */
  messages: ModelMessage[];
  /**
   * Spend still allowed before this turn (the lower of the conversation cap and the wallet daily
   * cap, minus what was already spent). No further model round starts once the turn spent it.
   */
  budgetUsd: number;
  /** Epoch ms by which the turn must be over (the request budget, see ChatLimits). */
  deadlineAt: number;
  /** Client disconnect. */
  signal: AbortSignal;
  now?: () => number;
}

const LEAK_NOTICE = "I can't share that. Let's get back to your launchpad.";

const TOO_SLOW: ChatStreamEvent = {
  type: 'error',
  code: 'NETWORK',
  message: 'The assistant took too long to answer. Please try again.',
};

function specEvent(draft: LaunchpadSpecDraft): ChatStreamEvent {
  return { type: 'spec', spec: draft, validation: validateDraft(draft) };
}

/** Text of the tool result: what was applied, what was rejected, what is still missing. */
function toolResultText(
  applied: string[],
  rejected: Record<string, string>,
  draft: LaunchpadSpecDraft,
): string {
  const lines: string[] = [];
  lines.push(applied.length > 0 ? `Applied: ${applied.join(', ')}.` : 'Nothing was applied.');
  for (const [path, why] of Object.entries(rejected)) {
    const label = knownFieldLabel(path);
    lines.push(`Rejected ${path}: ${label ? `${label} ` : ''}${why}`);
  }
  const validation = validateDraft(draft);
  if (validation.complete) {
    lines.push('The spec is complete and valid. Summarize it and ask the client to review it.');
  } else {
    const missing = Object.keys(validation.errors);
    lines.push(`Still missing or invalid: ${missing.join(', ')}.`);
  }
  return lines.join('\n');
}

function rejectionNote(rejected: Map<string, string>): string {
  const parts: string[] = [];
  for (const [path, why] of rejected) {
    const label = knownFieldLabel(path);
    if (label) parts.push(`${label} ${why}`);
  }
  return parts.length === 0 ? '' : `\n\nNot applied: ${parts.join(' ')}`;
}

/**
 * One assistant turn: streams the model reply, applies spec updates (server-validated) and
 * persists the result. Yields `text`, `spec` and `error` events; the caller adds the
 * `conversation` and `done` events. Never throws for provider or timeout failures.
 */
export async function* runTurn(input: TurnInput): AsyncGenerator<ChatStreamEvent> {
  const { config, store, wallet, conversationId, mode } = input;
  const { limits } = config;

  const now = input.now ?? Date.now;
  const turnMs = Math.min(limits.turnTimeoutMs, input.deadlineAt - now());
  if (turnMs < limits.minTurnMs) {
    yield TOO_SLOW;
    return;
  }
  const timeout = AbortSignal.timeout(turnMs);
  const signal = AbortSignal.any([input.signal, timeout]);
  const tool = buildUpdateSpecTool(mode);
  const guard = new LeakGuard();

  let draft = input.draft;
  const startKey = draftKey(input.storedDraft ?? input.draft);
  const rejected = new Map<string, string>();
  const messages: ModelMessage[] = [...input.messages];
  let emitted = '';
  let turnCost = 0;
  let leaked = false;

  // Spend and draft are written after EVERY model round, not only when the turn ends: a turn cut
  // short (timeout, platform kill, disconnect) has still recorded all completed rounds.
  let persistedCost = 0;
  let savedKey = startKey;
  let conversationCost = 0;
  const persist = async () => {
    const delta = turnCost - persistedCost;
    if (delta > 0) {
      conversationCost = await store.addCost(conversationId, wallet, delta);
      persistedCost += delta;
    }
    const key = draftKey(draft);
    if (key !== savedKey) {
      await store.saveDraft(conversationId, wallet, draft);
      savedKey = key;
    }
  };

  try {
    for (let round = 0; round < limits.maxModelRounds; round++) {
      const system = buildSystemPrompt(mode, draft);
      let roundText = '';
      const toolUses: Extract<ContentBlock, { type: 'tool_use' }>[] = [];
      const toolResults: ContentBlock[] = [];
      let usageSeen = false;
      let stopReason = 'end_turn';

      const roundInputEstimate = estimateTokens(system + JSON.stringify(messages));
      let roundOutputChars = 0;

      try {
        for await (const ev of input.streamer({
          model: config.model,
          system,
          messages,
          tools: [tool],
          maxTokens: limits.maxOutputTokens,
          signal,
        })) {
          if (ev.type === 'text') {
            roundText += ev.delta;
            roundOutputChars += ev.delta.length;
            const safe = guard.push(ev.delta);
            if (safe !== '') {
              emitted += safe;
              yield { type: 'text', delta: safe };
            }
            if (guard.leaked) {
              leaked = true;
              break;
            }
          } else if (ev.type === 'tool_use') {
            roundOutputChars += JSON.stringify(ev.input).length;
            toolUses.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
            if (ev.name !== UPDATE_SPEC_TOOL_NAME) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: ev.id,
                content: 'Unknown tool.',
                is_error: true,
              });
            } else if (ev.inputError !== null) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: ev.id,
                content: `${ev.inputError} Send a smaller, valid update.`,
                is_error: true,
              });
            } else {
              const before = draftKey(draft);
              const result = applySpecPatch(draft, ev.input, { ownerWallet: wallet, mode });
              draft = result.draft;
              for (const path of result.applied) rejected.delete(path);
              for (const [path, why] of Object.entries(result.rejected)) rejected.set(path, why);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: ev.id,
                content: toolResultText(result.applied, result.rejected, draft),
                is_error: Object.keys(result.rejected).length > 0 && result.applied.length === 0,
              });
              if (draftKey(draft) !== before) yield specEvent(draft);
            }
          } else if (ev.type === 'usage') {
            usageSeen = true;
            turnCost += costUsd(ev.inputTokens, ev.outputTokens);
          } else {
            stopReason = ev.reason;
          }
        }
      } finally {
        if (!usageSeen) {
          // The stream broke before the provider reported usage: charge an estimate.
          turnCost += costUsd(roundInputEstimate, Math.ceil(roundOutputChars / 3));
        }
      }
      // Fails closed: when the spend cannot be recorded, no further round runs.
      await persist();

      if (leaked) {
        emitted += LEAK_NOTICE;
        yield { type: 'text', delta: LEAK_NOTICE };
        break;
      }
      if (toolUses.length === 0 || stopReason !== 'tool_use') break;
      if (turnCost >= input.budgetUsd) break;
      if (conversationCost >= limits.conversationCostCapUsd) break;

      const assistantBlocks: ContentBlock[] = [];
      if (roundText !== '') assistantBlocks.push({ type: 'text', text: roundText });
      assistantBlocks.push(...toolUses);
      messages.push({ role: 'assistant', content: assistantBlocks });
      messages.push({ role: 'user', content: toolResults });
    }

    const tail = guard.flush();
    if (tail !== '') {
      emitted += tail;
      yield { type: 'text', delta: tail };
    }
    const note = rejectionNote(rejected);
    if (note !== '' && !leaked) {
      emitted += note;
      yield { type: 'text', delta: note };
    }
  } catch (error) {
    if (!input.signal.aborted) {
      yield errorEvent(error, timeout.aborted);
    }
  } finally {
    try {
      await persist();
    } catch {
      console.error('[chat] could not persist the turn cost or draft');
    }
    const rows: NewMessage[] = [];
    if (emitted.trim() !== '') rows.push({ role: 'assistant', content: emitted });
    try {
      await store.appendMessages(conversationId, rows);
    } catch {
      console.error('[chat] could not persist the turn');
    }
  }
}

function errorEvent(error: unknown, timedOut: boolean): ChatStreamEvent {
  if (timedOut) return TOO_SLOW;
  if (error instanceof ModelError) {
    console.error(`[chat] model error kind=${error.kind} status=${error.status ?? 'n/a'}`);
    if (error.kind === 'busy') {
      return {
        type: 'error',
        code: 'RATE_LIMITED',
        message: 'The assistant is busy right now. Please try again in a moment.',
      };
    }
  } else {
    console.error('[chat] unexpected error during a turn');
  }
  return {
    type: 'error',
    code: 'NETWORK',
    message: 'The assistant is temporarily unavailable. Please try again.',
  };
}
