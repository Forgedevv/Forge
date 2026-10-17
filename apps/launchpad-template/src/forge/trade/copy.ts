/**
 * LOCKED ZONE. Every visible text of the trade flow (`TradePanel`, `TradeForm`, `QuoteSummary`,
 * `BuyButton`, `JupiterTrade`), in one place so the wording stays consistent and other languages
 * can be added later. Like the other locked-zone copy (`create/copy.ts`, `claims/copy.ts`), it
 * lives next to the code that renders it and imports nothing from the free zones, so a site
 * redesign can never break the flow.
 *
 * Plain strings, or small functions for the texts that carry a value. The error sentences of a
 * trade are `TRADE_ERROR_MESSAGES` (errors.ts, re-exported here).
 */

export { TRADE_ERROR_MESSAGES } from './errors';

export const TRADE_TEXT = {
  panel: {
    paused: 'Trading is paused',
    unavailable: 'Trading is unavailable',
    sleepingNote: 'This launchpad is sleeping.',
    unavailableNote: 'This site is currently unavailable.',
    loading: 'Loading trading data...',
    retry: 'Retry',
    graduated: (fee: string) =>
      `This coin graduated. Swaps run through Jupiter and include a ${fee} FORGE platform fee.`,
  },
  form: {
    sideLabel: 'Trade side',
    sides: { buy: 'Buy', sell: 'Sell' },
    /** Unit of token amounts when the coin data has no ticker. */
    tokenUnit: 'tokens',
    amountBuy: 'Amount to spend (SOL)',
    amountSell: (symbol: string | undefined) =>
      symbol ? `Amount to sell (${symbol})` : 'Amount to sell',
    amountPlaceholder: '0.0',
    presetSol: (amount: string) => `${amount} SOL`,
    max: 'Max',
    balance: 'Balance:',
    retry: 'Retry',
    slippageLegend: 'Slippage tolerance',
    slippageCustom: 'Custom slippage in percent',
    percent: '%',
    slippageHigh: 'High slippage: you may get a noticeably worse price.',
    quoteLoading: 'Getting a quote...',
    quoteEmpty: 'Enter an amount to see the output, price impact and every fee before you sign.',
    /** The quote on screen is being refreshed (it stays usable meanwhile). */
    quoteRefreshing: 'Updating the quote...',
    /** A refresh failed: the last quote stays on screen until it is too old to sign. */
    quoteRefreshFailed: "Couldn't refresh the quote. Retrying...",
    /** The last quote is too old to sign: a new one is needed first. */
    quoteExpired: 'This quote is out of date.',
    refreshQuote: 'Refresh quote',
    viewTransaction: 'View transaction on the explorer',
    confirmed: 'Trade confirmed.',
    feeNote: (fee: string) =>
      `Trades include a ${fee} FORGE platform fee, shown above before you sign.`,
  },
  amountError: {
    invalid: 'Enter a number, for example 0.5.',
    tooManyDecimals: (decimals: number) => `At most ${decimals} decimals.`,
    zero: 'The amount must be greater than zero.',
    tooLarge: 'That amount is too large.',
  },
  slippageError: {
    tooLow: (min: string) => `Slippage must be at least ${min}.`,
    tooHigh: (max: string) => `Slippage must be at most ${max}.`,
    invalid: (min: string, max: string) => `Enter a slippage between ${min} and ${max}.`,
  },
  /** Label of the submit button. */
  button: {
    status: {
      quoting: 'Checking the price...',
      building: 'Preparing the transaction...',
      simulating: 'Checking the transaction...',
      signing: 'Confirm in your wallet...',
      sending: 'Sending...',
      confirming: 'Confirming...',
    } as Record<string, string>,
    working: 'Working...',
    misconfigured: 'Trading unavailable',
    readingCoin: 'Reading the coin...',
    coinUnavailable: 'Coin unavailable',
    enterAmount: 'Enter an amount',
    fixSlippage: 'Fix slippage',
    gettingQuote: 'Getting quote...',
    quoteUnavailable: 'Quote unavailable',
    quoteExpired: 'Quote out of date',
    connect: 'Connect wallet',
    insufficient: 'Insufficient balance',
    trade: (side: 'buy' | 'sell', symbol: string | undefined) =>
      `${side === 'buy' ? 'Buy' : 'Sell'}${symbol ? ` ${symbol}` : ''}`,
  },
  quote: {
    label: 'Quote',
    youPay: 'You pay',
    youReceive: 'You receive (estimated)',
    minimumReceived: 'Minimum received',
    youSell: 'You sell',
    proceeds: 'Proceeds (estimated)',
    minimumProceeds: 'Minimum proceeds',
    priceImpact: 'Price impact',
    tradingFee: 'Trading fee (pool)',
    platformFee: (fee: string) => `FORGE platform fee (${fee})`,
    networkFee: 'Network fee (estimate)',
    priorityFee: 'Priority fee (at most)',
    accountRent: 'Token account deposit (one time)',
    totalBuy: 'Total from your wallet (at most)',
    totalSell: 'Estimated SOL you keep',
  },
  buyButton: {
    label: 'Buy',
    notAvailable: 'Trading is not available',
    dialogTitle: (symbol: string | undefined) => `Trade ${symbol ?? 'coin'}`,
  },
  jupiter: {
    notConfigured: 'Trading is not configured on this site.',
    loading: 'Loading Jupiter Plugin...',
    failedTitle: 'The Jupiter swap widget did not load.',
    failedBody:
      'It may be blocked by your browser or network, or Jupiter may be slow right now. Retry, or trade this coin on jup.ag.',
    retry: 'Retry',
    openOnJupiter: 'Trade on jup.ag',
  },
} as const;
