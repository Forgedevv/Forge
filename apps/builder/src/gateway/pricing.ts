/**
 * Cost computation for the AI gateway. Prices are never hard-coded here: they
 * come from a `PricingTable` passed in the gateway config (see `config.ts` for
 * the default table).
 */

/** USD per million tokens for one model. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  /** 5-minute cache writes (the default TTL). */
  cacheWritePerMTok: number;
  /** 1-hour cache writes. Falls back to `cacheWritePerMTok` when absent. */
  cacheWrite1hPerMTok?: number;
}

export type PricingTable = Readonly<Record<string, ModelPrice>>;

/** Token counts read from an Anthropic `usage` object. Missing fields are 0. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /** Total cache write tokens (5m + 1h). */
  cacheCreationInputTokens: number;
  /** Part of `cacheCreationInputTokens` written with the 1-hour TTL. */
  cacheCreation1hInputTokens: number;
}

export const EMPTY_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
});

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Parses an Anthropic `usage` object; unknown shapes yield zeros. */
export function parseUsage(raw: unknown): Usage {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_USAGE };
  const u = raw as Record<string, unknown>;
  const creation = u.cache_creation as Record<string, unknown> | undefined;
  const oneHour = count(creation?.ephemeral_1h_input_tokens);
  const fiveMin = count(creation?.ephemeral_5m_input_tokens);
  const total = Math.max(count(u.cache_creation_input_tokens), oneHour + fiveMin);
  return {
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheReadInputTokens: count(u.cache_read_input_tokens),
    cacheCreationInputTokens: total,
    cacheCreation1hInputTokens: Math.min(oneHour, total),
  };
}

/**
 * Merges two usage snapshots of the same message by taking the max of each
 * field. Streamed `message_delta` usage is cumulative, so the max is the final
 * value and a missing field never lowers an earlier count.
 */
export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadInputTokens: Math.max(a.cacheReadInputTokens, b.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(a.cacheCreationInputTokens, b.cacheCreationInputTokens),
    cacheCreation1hInputTokens: Math.max(a.cacheCreation1hInputTokens, b.cacheCreation1hInputTokens),
  };
}

/** Cost in USD of `usage` at `price`. */
export function computeCostUsd(usage: Usage, price: ModelPrice): number {
  const oneHour = usage.cacheCreation1hInputTokens;
  const fiveMin = usage.cacheCreationInputTokens - oneHour;
  const micro =
    usage.inputTokens * price.inputPerMTok +
    usage.outputTokens * price.outputPerMTok +
    usage.cacheReadInputTokens * price.cacheReadPerMTok +
    fiveMin * price.cacheWritePerMTok +
    oneHour * (price.cacheWrite1hPerMTok ?? price.cacheWritePerMTok);
  return micro / 1_000_000;
}

/** Throws if a price is missing or not a finite non-negative number. */
export function assertValidPricing(table: PricingTable, models: readonly string[]): void {
  for (const model of models) {
    const price = table[model];
    if (!price) throw new Error(`gateway: no pricing for allowed model "${model}"`);
    for (const [field, value] of Object.entries(price)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`gateway: invalid price ${field} for model "${model}"`);
      }
    }
  }
}
