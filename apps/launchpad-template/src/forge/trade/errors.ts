/** Stable error codes shown to the user. Raw RPC and program messages never reach the UI as is. */
export type TradeErrorCode =
  | 'wallet_not_connected'
  | 'user_rejected'
  | 'insufficient_funds'
  | 'insufficient_rent'
  | 'slippage_exceeded'
  | 'price_moved'
  | 'quote_invalid'
  | 'pool_graduated'
  | 'blockhash_expired'
  | 'simulation_failed'
  | 'tx_failed'
  | 'confirm_timeout'
  | 'previous_trade_pending'
  | 'previous_trade_landed'
  | 'rate_limited'
  | 'network'
  | 'not_configured'
  /** The coin is not on this launchpad's configs: this site does not trade it. */
  | 'not_on_launchpad'
  | 'core_unavailable'
  | 'unknown';

export const TRADE_ERROR_MESSAGES: Record<TradeErrorCode, string> = {
  wallet_not_connected: 'Connect your wallet to trade.',
  user_rejected: 'You cancelled the request in your wallet. Nothing was sent.',
  insufficient_funds: 'Your wallet does not have enough funds for this trade and its fees.',
  insufficient_rent:
    'The transaction would leave an account below the minimum balance. Try a slightly larger amount or keep more SOL in your wallet.',
  slippage_exceeded:
    'The price moved beyond your slippage tolerance. Review the new quote or raise the slippage.',
  price_moved: 'The price moved since the last quote. Review the updated quote and try again.',
  quote_invalid:
    'The quote could not be verified, so the trade was blocked. Try again in a moment.',
  pool_graduated: 'This coin has graduated. Trading continues through Jupiter.',
  blockhash_expired:
    'The transaction expired before it was confirmed. Nothing was charged; try again.',
  simulation_failed:
    'The transaction would fail, so it was not sent. Review the amount and try again.',
  tx_failed: 'The transaction failed on-chain.',
  confirm_timeout:
    'The transaction was sent but is not confirmed yet. Check the explorer link before retrying.',
  previous_trade_pending:
    'Your previous trade may still land. Wait until it is confirmed or expires (about a minute) before trading again.',
  previous_trade_landed:
    'Your previous trade went through. Check your balance and the explorer link before trading again.',
  rate_limited: 'The network is busy. Wait a few seconds and try again.',
  network: 'Network error while reaching the Solana network. Check your connection and try again.',
  not_configured: 'Trading is not configured on this site.',
  not_on_launchpad: 'This coin is not on this launchpad, so it cannot be traded here.',
  core_unavailable: 'Trading is temporarily unavailable.',
  unknown: 'Something went wrong. Nothing was charged unless a transaction link is shown.',
};

export class TradeError extends Error {
  readonly code: TradeErrorCode;
  readonly signature?: string;
  constructor(
    code: TradeErrorCode,
    message?: string,
    options?: { signature?: string; cause?: unknown },
  ) {
    super(
      message ?? TRADE_ERROR_MESSAGES[code],
      options?.cause ? { cause: options.cause } : undefined,
    );
    this.name = 'TradeError';
    this.code = code;
    this.signature = options?.signature;
  }
}

function stringify(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? '';
  } catch {
    return '';
  }
}

/**
 * Maps any thrown value (wallet adapter, web3.js, relay, core) to a `TradeError`. Existing
 * `TradeError`s pass through untouched.
 */
export function mapTradeError(error: unknown): TradeError {
  if (error instanceof TradeError) return error;
  const message = stringify(error).toLowerCase();
  const coded = (error as { code?: unknown } | null)?.code;
  const make = (code: TradeErrorCode) => new TradeError(code, undefined, { cause: error });

  if (
    message.includes('user rejected') ||
    message.includes('rejected the request') ||
    message.includes('user denied') ||
    message.includes('declined') ||
    coded === 4001
  ) {
    return make('user_rejected');
  }
  if (message.includes('swapcorenotlinked') || message.includes('core is not linked')) {
    return make('core_unavailable');
  }
  if (
    message.includes('poolisgraduated') ||
    message.includes('pool is graduated') ||
    message.includes('poolcompleted') ||
    message.includes('pool is completed')
  ) {
    return make('pool_graduated');
  }
  if (message.includes('exceededslippage') || message.includes('slippage')) {
    return make('slippage_exceeded');
  }
  if (
    message.includes('insufficientfundsforrent') ||
    message.includes('insufficient funds for rent')
  ) {
    return make('insufficient_rent');
  }
  if (
    message.includes('insufficient lamports') ||
    message.includes('insufficient funds') ||
    message.includes('insufficientfunds') ||
    message.includes('custom program error: 0x1')
  ) {
    return make('insufficient_funds');
  }
  if (
    message.includes('blockhash not found') ||
    message.includes('blockhashnotfound') ||
    message.includes('block height exceeded') ||
    message.includes('transaction expired')
  ) {
    return make('blockhash_expired');
  }
  if (
    /\b429\b/.test(message) ||
    message.includes('too many requests') ||
    message.includes('rate limit')
  ) {
    return make('rate_limited');
  }
  if (
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('networkerror') ||
    message.includes('network request failed') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    /\b502\b/.test(message) ||
    /\b503\b/.test(message) ||
    /\b504\b/.test(message)
  ) {
    return make('network');
  }
  if (message.includes('simulation failed')) {
    return make('simulation_failed');
  }
  return make('unknown');
}

/**
 * Maps the `err` object (and logs) of a failed simulation or a confirmed-with-error status. Raw
 * JSON stays in `cause` for diagnostics and is never shown.
 */
export function mapChainError(
  err: unknown,
  logs: readonly string[] | null | undefined,
  signature?: string,
): TradeError {
  const joined = `${stringify(err)} ${(logs ?? []).join(' ')}`;
  const mapped = mapTradeError(joined);
  if (mapped.code !== 'unknown') {
    return new TradeError(mapped.code, undefined, { signature, cause: err });
  }
  return new TradeError(signature ? 'tx_failed' : 'simulation_failed', undefined, {
    signature,
    cause: err,
  });
}
