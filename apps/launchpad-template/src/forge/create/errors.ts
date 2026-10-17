import { mapTradeError, type TradeErrorCode } from '../trade/errors';

/**
 * LOCKED ZONE. Human messages for the coin creation and fee claim flows. Raw program errors, RPC
 * texts and wallet adapter messages never reach the UI as is: they are classified into a stable
 * reason (with the same rules as the trade flow, `trade/errors.ts`) and shown as a short sentence.
 * The raw value stays available to the caller (`TxError.cause`) for diagnostics.
 */

export type ChainFailureReason =
  | 'insufficient_funds'
  | 'insufficient_rent'
  | 'slippage'
  | 'expired'
  | 'already_exists'
  | 'busy'
  | 'network'
  | 'unknown';

export const CHAIN_FAILURE_TEXT: Record<ChainFailureReason, string> = {
  insufficient_funds: 'Your wallet did not have enough SOL for the whole transaction and its fees.',
  insufficient_rent:
    'Your wallet would drop below the small minimum balance Solana requires. Keep a little more SOL in it.',
  slippage: 'The price of the first buy moved beyond the allowed range.',
  expired: 'The transaction expired before the network processed it.',
  already_exists: 'This coin address is already in use on-chain.',
  busy: 'The network is busy right now.',
  network: 'The Solana network could not be reached.',
  unknown: 'The network refused the transaction.',
};

export const WALLET_ERROR_TEXT = {
  rejected: 'You declined the request in your wallet. Nothing was signed.',
  messageFailed:
    'Your wallet could not sign the message. Unlock it and try again, or use another wallet.',
  transactionFailed:
    'Your wallet could not sign the transaction. Nothing was sent. Unlock it and try again.',
  differentTransaction:
    'Your wallet returned a different transaction than the one you reviewed. Nothing was sent.',
  incomplete: 'Your wallet returned an incomplete signature. Nothing was sent. Try again.',
} as const;

export const SEND_ERROR_TEXT = {
  prefix: 'The transaction was not sent.',
  retry: 'Nothing was charged. Try again.',
} as const;

const REASON_BY_TRADE_CODE: Partial<Record<TradeErrorCode, ChainFailureReason>> = {
  insufficient_funds: 'insufficient_funds',
  insufficient_rent: 'insufficient_rent',
  slippage_exceeded: 'slippage',
  price_moved: 'slippage',
  blockhash_expired: 'expired',
  rate_limited: 'busy',
  network: 'network',
};

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name} ${value.message}`;
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? '';
  } catch {
    return '';
  }
}

/** Stable reason of an on-chain error (`err` of a status or a simulation, plus its logs). */
export function chainFailureReason(
  err: unknown,
  logs?: readonly string[] | null,
): ChainFailureReason {
  const text = `${stringify(err)} ${(logs ?? []).join(' ')}`;
  if (/already in use|accountalreadyinitialized|already initialized/i.test(text)) {
    return 'already_exists';
  }
  return REASON_BY_TRADE_CODE[mapTradeError(text).code] ?? 'unknown';
}

/** One human sentence for an on-chain error. Never the raw JSON. */
export function describeChainFailure(err: unknown, logs?: readonly string[] | null): string {
  return CHAIN_FAILURE_TEXT[chainFailureReason(err, logs)];
}

/** True when a wallet error means the user declined (adapters word it differently). */
export function isUserRejection(error: unknown): boolean {
  const coded = (error as { code?: unknown } | null)?.code;
  if (coded === 4001) return true;
  const text = `${(error as { name?: string })?.name ?? ''} ${(error as { message?: string })?.message ?? ''}`;
  return /reject|denied|declin|cancel/i.test(text);
}

/** Message for a failed `sendTransaction` (preflight refusal, relay down...). */
export function describeSendFailure(error: unknown): string {
  const holder = error as { logs?: unknown; data?: { logs?: unknown; err?: unknown } } | null;
  const logs = Array.isArray(holder?.data?.logs)
    ? (holder.data.logs as string[])
    : Array.isArray(holder?.logs)
      ? (holder.logs as string[])
      : null;
  const reason = chainFailureReason(`${stringify(error)} ${stringify(holder?.data?.err ?? '')}`, logs);
  const detail = reason === 'unknown' ? '' : ` ${CHAIN_FAILURE_TEXT[reason]}`;
  return `${SEND_ERROR_TEXT.prefix}${detail} ${SEND_ERROR_TEXT.retry}`;
}
