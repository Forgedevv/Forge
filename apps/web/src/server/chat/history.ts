import type { ModelMessage } from './anthropic';
import { estimateTokens } from './config';
import type { HistoryMessage } from './store';

/**
 * Builds the messages sent to the model: the most recent turns that fit the token budget,
 * starting with a user turn, consecutive same-role turns merged, ending with the new message.
 * Stored `system` rows never reach this function.
 */
export function buildModelMessages(
  history: readonly HistoryMessage[],
  newMessage: string,
  budgetTokens: number,
): ModelMessage[] {
  const kept: HistoryMessage[] = [];
  let used = estimateTokens(newMessage);
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (!item || item.content.trim() === '') continue;
    const cost = estimateTokens(item.content);
    if (used + cost > budgetTokens) break;
    used += cost;
    kept.unshift(item);
  }
  while (kept[0] && kept[0].role !== 'user') kept.shift();

  const messages: ModelMessage[] = [];
  for (const item of [...kept, { role: 'user' as const, content: newMessage }]) {
    const last = messages[messages.length - 1];
    if (last && last.role === item.role && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${item.content}`;
    } else {
      messages.push({ role: item.role, content: item.content });
    }
  }
  return messages;
}
