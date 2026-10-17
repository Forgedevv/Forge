import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import { PublicKey, type Connection } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatBps, formatUnits, parseAmount, parseSlippagePercent } from './amounts';
import { DEFAULT_TOKEN_DECIMALS, PLATFORM_FEE_BPS, SLIPPAGE_BPS, SOL_DECIMALS } from './constants';
import type { TradeSide } from './core-adapter';
import { TradeError } from './errors';
import { isLaunchpadPool, launchpadPoolKey, type LaunchpadPool } from './launchpad-pool';
import { QuoteSummary } from './QuoteSummary';
import { TRADE_TEXT } from './copy';
import { explorerTxUrl, resolveCluster } from './trade-config';
import { BUSY_STATUSES, useTradeExecution } from './useTradeExecution';
import { useMintDecimals } from './useMintDecimals';
import { useQuote } from './useQuote';
import { estimateNetworkFee, useWalletBalances } from './useWalletBalances';
import type { ConfirmOptions } from './confirm';

export interface TradeFormProps {
  connection: Connection;
  /**
   * The coin's pool on this launchpad, as found by findLaunchpadPool (it carries the mint). There
   * is no raw pool or mint prop: a handle that was not issued by findLaunchpadPool trades nothing.
   */
  launchpadPool: LaunchpadPool;
  /** Ticker of the coin; labels stay neutral without one. */
  symbol?: string;
  /**
   * Decimals from a data API, for display only while the on-chain mint is being read. Raw amounts
   * (sell input, Max) always use the decimals of the on-chain mint.
   */
  displayDecimals?: number;
  /** Called once a trade is confirmed on-chain. */
  onConfirmed?: (signature: string) => void;
  /** Called when the chain says the pool graduated (the panel then switches to Jupiter). */
  onGraduated?: () => void;
  /** Tuning knobs, mostly for tests. */
  quoteDebounceMs?: number;
  quoteRefreshMs?: number;
  quoteMaxAgeMs?: number;
  confirmOptions?: ConfirmOptions;
}

const BUY_PRESETS = ['0.1', '0.5', '1'];
const SLIPPAGE_PRESETS = ['0.5', '1', '3'];

const TEXT = TRADE_TEXT.form;

/*
 * Colours are theme tokens only: `primary` is the brand colour and `primary-950` the readable text
 * on it (dark or white, from its luminance), so light brands (yellow, lime) stay legible. Small
 * controls stay compact on desktop and grow to a 40px tap target on touch screens and phones
 * (`touch:` variant, tailwind.config.js).
 */
const chipClass =
  'inline-flex items-center justify-center rounded-[var(--radius)] border px-2 py-1 text-xs touch:min-h-[2.5rem] touch:min-w-[2.75rem] touch:px-3 touch:text-sm';
const textButtonClass = 'self-start underline touch:min-h-[2.5rem]';

function safeKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

/** Buy/sell form for a coin that is still on the bonding curve (swaps built by the core). */
export function TradeForm(props: TradeFormProps) {
  const {
    connection,
    launchpadPool,
    symbol,
    displayDecimals = DEFAULT_TOKEN_DECIMALS,
    onConfirmed,
    onGraduated,
    quoteDebounceMs,
    quoteRefreshMs,
    quoteMaxAgeMs,
    confirmOptions,
  } = props;
  /** Unit of token amounts: the ticker, or a neutral word when the coin data has none. */
  const tokenUnit = symbol || TEXT.tokenUnit;

  const { setShowModal } = useUnifiedWalletContext();
  const execution = useTradeExecution(confirmOptions);
  const { publicKey } = execution;

  const poolKey = useMemo(() => launchpadPoolKey(launchpadPool), [launchpadPool]);
  const mintKey = useMemo(
    () => (isLaunchpadPool(launchpadPool) ? safeKey(launchpadPool.mint) : null),
    [launchpadPool],
  );

  const [side, setSide] = useState<TradeSide>('buy');
  const [amountText, setAmountText] = useState('');
  const [slippageText, setSlippageText] = useState(String(SLIPPAGE_BPS.default / 100));
  const [touched, setTouched] = useState(false);
  const [balanceVersion, setBalanceVersion] = useState(0);

  // The coin's decimals come from its on-chain mint; the data API value only fills the display.
  const { state: mintDecimals, retry: retryMintDecimals } = useMintDecimals(connection, mintKey);
  const chainDecimals = mintDecimals.status === 'ready' ? mintDecimals.decimals : null;
  const tokenDecimals = chainDecimals ?? displayDecimals;
  const inputDecimals = side === 'buy' ? SOL_DECIMALS : chainDecimals;
  const amount = useMemo(
    (): ReturnType<typeof parseAmount> =>
      inputDecimals === null
        ? { ok: false, reason: 'empty' }
        : parseAmount(amountText, inputDecimals),
    [amountText, inputDecimals],
  );
  const slippage = useMemo(() => parseSlippagePercent(slippageText), [slippageText]);

  const busy = BUSY_STATUSES.includes(execution.status);

  const { state: balancesState } = useWalletBalances(
    connection,
    publicKey,
    mintKey,
    balanceVersion,
  );
  const balances = balancesState.status === 'ready' ? balancesState.balances : null;
  const networkFee = useMemo(() => estimateNetworkFee(side, balances), [side, balances]);

  const quoteState = useQuote({
    connection,
    launchpadPool: poolKey ? launchpadPool : null,
    side,
    amountIn: amount.ok ? amount.value : null,
    slippageBps: slippage.ok ? slippage.bps : null,
    enabled: !busy && execution.status !== 'success',
    debounceMs: quoteDebounceMs,
    refreshMs: quoteRefreshMs,
    maxAgeMs: quoteMaxAgeMs,
  });
  const quote = quoteState.status === 'ready' ? quoteState.quote : null;
  // A quote too old to sign stays on screen (stale) until a refresh replaces it.
  const quoteExpired = quoteState.status === 'ready' && quoteState.expired;
  const quoteRefreshFailed = quoteState.status === 'ready' && quoteState.refreshError !== null;
  const quoteStale = quoteExpired || quoteRefreshFailed;

  const resetOutcome = execution.reset;
  const changeSide = (next: TradeSide) => {
    if (busy) return;
    setSide(next);
    setAmountText('');
    setTouched(false);
    resetOutcome();
  };
  const editAmount = (value: string) => {
    setAmountText(value);
    setTouched(true);
    if (execution.status === 'success' || execution.status === 'error') resetOutcome();
  };

  // Inputs
  const amountError =
    !touched || amountText === '' || inputDecimals === null
      ? null
      : amountErrorText(amount, inputDecimals);
  const slippageError = slippageErrorText(slippage);

  // Balance check (skipped silently when the balance could not be read).
  const insufficient = useMemo(() => {
    if (!balances || !amount.ok) return false;
    if (side === 'sell') return amount.value > balances.token;
    const needed = amount.value + (quote?.platformFee ?? BigInt(0)) + networkFee.total;
    return needed > balances.sol;
  }, [balances, amount, side, quote, networkFee]);

  const notifyConfirmed = useCallback(
    (signature: string) => {
      setBalanceVersion((n) => n + 1);
      onConfirmed?.(signature);
    },
    [onConfirmed],
  );

  const submit = async () => {
    if (!publicKey) {
      setShowModal(true);
      return;
    }
    if (!poolKey || !quote || quoteExpired || !amount.ok || !slippage.ok) return;
    if (side === 'sell' && chainDecimals === null) return;
    const result = await execution.execute({
      connection,
      launchpadPool,
      side,
      amountIn: amount.value,
      slippageBps: slippage.bps,
      displayedQuote: quote,
    });
    if (result.ok) {
      setAmountText('');
      notifyConfirmed(result.signature);
    } else if (result.error.code === 'pool_graduated') {
      onGraduated?.();
    } else if (result.error.code === 'price_moved') {
      quoteState.refresh();
    }
  };

  // Late detection of graduation from a failing quote.
  useEffect(() => {
    if (quoteState.status === 'error' && quoteState.error.code === 'pool_graduated')
      onGraduated?.();
  }, [quoteState, onGraduated]);

  const misconfigured = !poolKey || !mintKey;
  const button = buttonState({
    misconfigured,
    busyStatus: busy ? execution.status : null,
    amountOk: amount.ok,
    slippageOk: slippage.ok,
    quoteStatus: quoteState.status,
    quoteExpired,
    connected: publicKey !== null,
    insufficient,
    side,
    symbol,
    sellDecimals: side === 'sell' ? mintDecimals.status : null,
  });

  const cluster = resolveCluster();
  const error: TradeError | null =
    execution.status === 'error'
      ? execution.error
      : quoteState.status === 'error'
        ? quoteState.error
        : null;
  const errorSignature = execution.status === 'error' ? execution.error?.signature : undefined;
  const slippageWarn = slippage.ok && slippage.bps > SLIPPAGE_BPS.warnAbove;

  return (
    <div className="flex flex-col gap-4" data-testid="trade-form">
      <div role="tablist" aria-label={TEXT.sideLabel} className="grid grid-cols-2 gap-1">
        {(['buy', 'sell'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={side === tab}
            disabled={busy}
            onClick={() => changeSide(tab)}
            className={`min-h-[2.5rem] rounded-[var(--radius)] px-3 py-2 text-sm font-semibold transition-colors touch:min-h-[2.75rem] ${
              side === tab
                ? 'bg-primary text-primary-950'
                : 'bg-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {TEXT.sides[tab]}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="forge-trade-amount" className="text-sm text-[var(--color-text-muted)]">
          {side === 'buy' ? TEXT.amountBuy : TEXT.amountSell(symbol)}
        </label>
        <input
          id="forge-trade-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder={TEXT.amountPlaceholder}
          value={amountText}
          disabled={busy}
          onChange={(event) => editAmount(event.target.value)}
          aria-invalid={amountError !== null}
          aria-describedby={amountError ? 'forge-trade-amount-error' : undefined}
          className="w-full rounded-[var(--radius)] border border-[var(--color-border)] bg-transparent p-3 text-base text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-primary"
        />
        {amountError ? (
          <p
            id="forge-trade-amount-error"
            role="alert"
            className="text-xs text-[var(--color-danger)]"
          >
            {amountError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {side === 'buy'
            ? BUY_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={busy}
                  onClick={() => editAmount(preset)}
                  className={`${chipClass} border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}
                >
                  {TEXT.presetSol(preset)}
                </button>
              ))
            : null}
          {side === 'sell' && balances && chainDecimals !== null ? (
            <button
              type="button"
              disabled={busy || balances.token === BigInt(0)}
              onClick={() =>
                editAmount(formatUnits(balances.token, chainDecimals).replace(/,/g, ''))
              }
              className={`${chipClass} border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]`}
            >
              {TEXT.max}
            </button>
          ) : null}
          {balances ? (
            <span className="ml-auto text-xs text-[var(--color-text-muted)]" data-testid="balance">
              {TEXT.balance}{' '}
              {side === 'buy'
                ? `${formatUnits(balances.sol, SOL_DECIMALS, 4)} SOL`
                : `${formatUnits(balances.token, tokenDecimals, 4)} ${tokenUnit}`}
            </span>
          ) : null}
        </div>
        {side === 'sell' && mintDecimals.status === 'error' ? (
          <div role="alert" className="flex flex-col gap-1 text-xs" data-testid="mint-error">
            <p className="text-[var(--color-danger)]">{mintDecimals.error}</p>
            <button type="button" onClick={retryMintDecimals} className={textButtonClass}>
              {TEXT.retry}
            </button>
          </div>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm text-[var(--color-text-muted)]">{TEXT.slippageLegend}</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          {SLIPPAGE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={busy}
              aria-pressed={slippageText === preset}
              onClick={() => setSlippageText(preset)}
              className={`${chipClass} ${
                slippageText === preset
                  ? 'border-primary text-[var(--color-text)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
              }`}
            >
              {preset}%
            </button>
          ))}
          <label className="sr-only" htmlFor="forge-trade-slippage">
            {TEXT.slippageCustom}
          </label>
          <input
            id="forge-trade-slippage"
            inputMode="decimal"
            autoComplete="off"
            value={slippageText}
            disabled={busy}
            onChange={(event) => setSlippageText(event.target.value)}
            aria-invalid={slippageError !== null}
            className="w-20 rounded-[var(--radius)] border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-primary touch:min-h-[2.5rem] touch:text-base"
          />
          <span className="text-xs text-[var(--color-text-muted)]">{TEXT.percent}</span>
        </div>
        {slippageError ? (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {slippageError}
          </p>
        ) : slippageWarn ? (
          <p className="text-xs text-[var(--color-danger)]">{TEXT.slippageHigh}</p>
        ) : null}
      </fieldset>

      <div className="min-h-[2rem]" aria-live="polite">
        {quote ? (
          <>
            <div
              className={`transition-opacity ${quoteStale ? 'opacity-60' : ''}`}
              data-testid="quote-freshness"
              data-stale={quoteStale ? 'true' : 'false'}
            >
              <QuoteSummary
                quote={quote}
                symbol={tokenUnit}
                tokenDecimals={tokenDecimals}
                networkFee={networkFee}
              />
            </div>
            {/* Space kept for the hint, so the panel does not jump on every refresh. */}
            <div className="mt-1.5 flex min-h-[1rem] flex-wrap items-center gap-x-2 text-xs text-[var(--color-text-muted)]">
              {quoteStale ? (
                <>
                  <span data-testid="quote-stale-hint">
                    {quoteExpired ? TEXT.quoteExpired : TEXT.quoteRefreshFailed}
                  </span>
                  <button
                    type="button"
                    onClick={quoteState.refresh}
                    className="underline touch:min-h-[2.5rem]"
                  >
                    {TEXT.refreshQuote}
                  </button>
                </>
              ) : quoteState.status === 'ready' && quoteState.refreshing ? (
                // Visual only: a screen reader is not told about every routine refresh.
                <span aria-hidden="true" data-testid="quote-refreshing">
                  {TEXT.quoteRefreshing}
                </span>
              ) : null}
            </div>
          </>
        ) : quoteState.status === 'loading' ? (
          <p className="text-sm text-[var(--color-text-muted)]" data-testid="quote-loading">
            {TEXT.quoteLoading}
          </p>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">{TEXT.quoteEmpty}</p>
        )}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-[var(--radius)] border border-[var(--color-danger)] p-3 text-sm text-[var(--color-danger)]"
          data-testid="trade-error"
          data-code={error.code}
        >
          <p>{error.message}</p>
          {errorSignature ? (
            <a
              className="underline"
              href={explorerTxUrl(errorSignature, cluster)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {TEXT.viewTransaction}
            </a>
          ) : null}
        </div>
      ) : null}

      {execution.status === 'success' && execution.signature ? (
        <div
          role="status"
          className="rounded-[var(--radius)] border border-[var(--color-success)] p-3 text-sm text-[var(--color-success)]"
          data-testid="trade-success"
        >
          <p>{TEXT.confirmed}</p>
          <a
            className="underline"
            href={explorerTxUrl(execution.signature, cluster)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {TEXT.viewTransaction}
          </a>
        </div>
      ) : null}

      <button
        type="button"
        onClick={submit}
        disabled={button.disabled}
        data-testid="trade-submit"
        className="min-h-[2.75rem] w-full rounded-[var(--radius)] bg-primary px-4 py-3 text-sm font-semibold text-primary-950 transition-[background-color,opacity] enabled:hover:bg-primary-300 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {button.label}
      </button>

      <p className="text-xs text-[var(--color-text-muted)]" data-testid="fee-note">
        {TEXT.feeNote(formatBps(PLATFORM_FEE_BPS))}
      </p>
    </div>
  );
}

function amountErrorText(parsed: ReturnType<typeof parseAmount>, decimals: number): string | null {
  if (parsed.ok) return null;
  switch (parsed.reason) {
    case 'invalid':
      return TRADE_TEXT.amountError.invalid;
    case 'too_many_decimals':
      return TRADE_TEXT.amountError.tooManyDecimals(decimals);
    case 'zero':
      return TRADE_TEXT.amountError.zero;
    case 'too_large':
      return TRADE_TEXT.amountError.tooLarge;
    default:
      return null;
  }
}

function slippageErrorText(parsed: ReturnType<typeof parseSlippagePercent>): string | null {
  if (parsed.ok) return null;
  const min = formatBps(SLIPPAGE_BPS.min);
  const max = formatBps(SLIPPAGE_BPS.max);
  if (parsed.reason === 'too_low') return TRADE_TEXT.slippageError.tooLow(min);
  if (parsed.reason === 'too_high') return TRADE_TEXT.slippageError.tooHigh(max);
  return TRADE_TEXT.slippageError.invalid(min, max);
}

function buttonState(args: {
  misconfigured: boolean;
  busyStatus: string | null;
  amountOk: boolean;
  slippageOk: boolean;
  quoteStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** The quote on screen is too old to sign. */
  quoteExpired: boolean;
  connected: boolean;
  insufficient: boolean;
  side: TradeSide;
  symbol: string | undefined;
  /** Status of the on-chain mint read, on the sell side only. */
  sellDecimals: 'idle' | 'loading' | 'ready' | 'error' | null;
}): { label: string; disabled: boolean } {
  const label = TRADE_TEXT.button;
  if (args.misconfigured) return { label: label.misconfigured, disabled: true };
  if (args.busyStatus) {
    return { label: label.status[args.busyStatus] ?? label.working, disabled: true };
  }
  if (args.sellDecimals === 'idle' || args.sellDecimals === 'loading') {
    return { label: label.readingCoin, disabled: true };
  }
  if (args.sellDecimals === 'error') return { label: label.coinUnavailable, disabled: true };
  if (!args.amountOk) return { label: label.enterAmount, disabled: true };
  if (!args.slippageOk) return { label: label.fixSlippage, disabled: true };
  if (args.quoteStatus === 'loading' || args.quoteStatus === 'idle') {
    return { label: label.gettingQuote, disabled: true };
  }
  if (args.quoteStatus === 'error') return { label: label.quoteUnavailable, disabled: true };
  if (args.quoteExpired) return { label: label.quoteExpired, disabled: true };
  if (!args.connected) return { label: label.connect, disabled: false };
  if (args.insufficient) return { label: label.insufficient, disabled: true };
  return { label: label.trade(args.side, args.symbol), disabled: false };
}
