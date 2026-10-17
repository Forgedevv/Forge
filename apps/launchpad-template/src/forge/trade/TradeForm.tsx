import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import { PublicKey, type Connection } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatBps, formatUnits, parseAmount, parseSlippagePercent } from './amounts';
import { DEFAULT_TOKEN_DECIMALS, PLATFORM_FEE_BPS, SLIPPAGE_BPS, SOL_DECIMALS } from './constants';
import type { TradeSide } from './core-adapter';
import { TradeError } from './errors';
import { isLaunchpadPool, launchpadPoolKey, type LaunchpadPool } from './launchpad-pool';
import { QuoteSummary } from './QuoteSummary';
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
  confirmOptions?: ConfirmOptions;
}

const BUY_PRESETS = ['0.1', '0.5', '1'];
const SLIPPAGE_PRESETS = ['0.5', '1', '3'];

const STATUS_LABEL: Record<string, string> = {
  quoting: 'Checking the price...',
  building: 'Preparing the transaction...',
  simulating: 'Checking the transaction...',
  signing: 'Confirm in your wallet...',
  sending: 'Sending...',
  confirming: 'Confirming...',
};

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
    confirmOptions,
  } = props;
  /** Unit of token amounts: the ticker, or a neutral word when the coin data has none. */
  const tokenUnit = symbol || 'tokens';

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
  });
  const quote = quoteState.status === 'ready' ? quoteState.quote : null;

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
    if (!poolKey || !quote || !amount.ok || !slippage.ok) return;
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
      <div role="tablist" aria-label="Trade side" className="grid grid-cols-2 gap-1">
        {(['buy', 'sell'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={side === tab}
            disabled={busy}
            onClick={() => changeSide(tab)}
            className={`rounded-[var(--radius)] px-3 py-2 text-sm font-semibold capitalize transition-colors ${
              side === tab
                ? 'bg-[var(--color-primary,#7c3aed)] text-white'
                : 'bg-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="forge-trade-amount" className="text-sm text-[var(--color-text-muted)]">
          {side === 'buy'
            ? 'Amount to spend (SOL)'
            : symbol
              ? `Amount to sell (${symbol})`
              : 'Amount to sell'}
        </label>
        <input
          id="forge-trade-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={amountText}
          disabled={busy}
          onChange={(event) => editAmount(event.target.value)}
          aria-invalid={amountError !== null}
          aria-describedby={amountError ? 'forge-trade-amount-error' : undefined}
          className="w-full rounded-[var(--radius)] border border-[var(--color-border)] bg-transparent p-3 text-base text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary,#7c3aed)]"
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
                  className="rounded-[var(--radius)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >
                  {preset} SOL
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
              className="rounded-[var(--radius)] border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              Max
            </button>
          ) : null}
          {balances ? (
            <span className="ml-auto text-xs text-[var(--color-text-muted)]" data-testid="balance">
              Balance:{' '}
              {side === 'buy'
                ? `${formatUnits(balances.sol, SOL_DECIMALS, 4)} SOL`
                : `${formatUnits(balances.token, tokenDecimals, 4)} ${tokenUnit}`}
            </span>
          ) : null}
        </div>
        {side === 'sell' && mintDecimals.status === 'error' ? (
          <div role="alert" className="flex flex-col gap-1 text-xs" data-testid="mint-error">
            <p className="text-[var(--color-danger)]">{mintDecimals.error}</p>
            <button type="button" onClick={retryMintDecimals} className="self-start underline">
              Retry
            </button>
          </div>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm text-[var(--color-text-muted)]">Slippage tolerance</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          {SLIPPAGE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={busy}
              aria-pressed={slippageText === preset}
              onClick={() => setSlippageText(preset)}
              className={`rounded-[var(--radius)] border px-2 py-1 text-xs ${
                slippageText === preset
                  ? 'border-[var(--color-primary,#7c3aed)] text-[var(--color-text)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
              }`}
            >
              {preset}%
            </button>
          ))}
          <label className="sr-only" htmlFor="forge-trade-slippage">
            Custom slippage in percent
          </label>
          <input
            id="forge-trade-slippage"
            inputMode="decimal"
            autoComplete="off"
            value={slippageText}
            disabled={busy}
            onChange={(event) => setSlippageText(event.target.value)}
            aria-invalid={slippageError !== null}
            className="w-20 rounded-[var(--radius)] border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs text-[var(--color-text)]"
          />
          <span className="text-xs text-[var(--color-text-muted)]">%</span>
        </div>
        {slippageError ? (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {slippageError}
          </p>
        ) : slippageWarn ? (
          <p className="text-xs text-[var(--color-danger)]">
            High slippage: you may get a noticeably worse price.
          </p>
        ) : null}
      </fieldset>

      <div className="min-h-[2rem]" aria-live="polite">
        {quote ? (
          <QuoteSummary
            quote={quote}
            symbol={tokenUnit}
            tokenDecimals={tokenDecimals}
            networkFee={networkFee}
          />
        ) : quoteState.status === 'loading' ? (
          <p className="text-sm text-[var(--color-text-muted)]" data-testid="quote-loading">
            Getting a quote...
          </p>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">
            Enter an amount to see the output, price impact and every fee before you sign.
          </p>
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
              View transaction on the explorer
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
          <p>Trade confirmed.</p>
          <a
            className="underline"
            href={explorerTxUrl(execution.signature, cluster)}
            target="_blank"
            rel="noopener noreferrer"
          >
            View transaction on the explorer
          </a>
        </div>
      ) : null}

      <button
        type="button"
        onClick={submit}
        disabled={button.disabled}
        data-testid="trade-submit"
        className="w-full rounded-[var(--radius)] bg-[var(--color-primary,#7c3aed)] px-4 py-3 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
      >
        {button.label}
      </button>

      <p className="text-xs text-[var(--color-text-muted)]" data-testid="fee-note">
        Trades include a {formatBps(PLATFORM_FEE_BPS)} FORGE platform fee, shown above before you
        sign.
      </p>
    </div>
  );
}

function amountErrorText(parsed: ReturnType<typeof parseAmount>, decimals: number): string | null {
  if (parsed.ok) return null;
  switch (parsed.reason) {
    case 'invalid':
      return 'Enter a number, for example 0.5.';
    case 'too_many_decimals':
      return `At most ${decimals} decimals.`;
    case 'zero':
      return 'The amount must be greater than zero.';
    case 'too_large':
      return 'That amount is too large.';
    default:
      return null;
  }
}

function slippageErrorText(parsed: ReturnType<typeof parseSlippagePercent>): string | null {
  if (parsed.ok) return null;
  const min = formatBps(SLIPPAGE_BPS.min);
  const max = formatBps(SLIPPAGE_BPS.max);
  if (parsed.reason === 'too_low') return `Slippage must be at least ${min}.`;
  if (parsed.reason === 'too_high') return `Slippage must be at most ${max}.`;
  return `Enter a slippage between ${min} and ${max}.`;
}

function buttonState(args: {
  misconfigured: boolean;
  busyStatus: string | null;
  amountOk: boolean;
  slippageOk: boolean;
  quoteStatus: 'idle' | 'loading' | 'ready' | 'error';
  connected: boolean;
  insufficient: boolean;
  side: TradeSide;
  symbol: string | undefined;
  /** Status of the on-chain mint read, on the sell side only. */
  sellDecimals: 'idle' | 'loading' | 'ready' | 'error' | null;
}): { label: string; disabled: boolean } {
  if (args.misconfigured) return { label: 'Trading unavailable', disabled: true };
  if (args.busyStatus) {
    return { label: STATUS_LABEL[args.busyStatus] ?? 'Working...', disabled: true };
  }
  if (args.sellDecimals === 'idle' || args.sellDecimals === 'loading') {
    return { label: 'Reading the coin...', disabled: true };
  }
  if (args.sellDecimals === 'error') return { label: 'Coin unavailable', disabled: true };
  if (!args.amountOk) return { label: 'Enter an amount', disabled: true };
  if (!args.slippageOk) return { label: 'Fix slippage', disabled: true };
  if (args.quoteStatus === 'loading' || args.quoteStatus === 'idle') {
    return { label: 'Getting quote...', disabled: true };
  }
  if (args.quoteStatus === 'error') return { label: 'Quote unavailable', disabled: true };
  if (!args.connected) return { label: 'Connect wallet', disabled: false };
  if (args.insufficient) return { label: 'Insufficient balance', disabled: true };
  return {
    label: `${args.side === 'buy' ? 'Buy' : 'Sell'}${args.symbol ? ` ${args.symbol}` : ''}`,
    disabled: false,
  };
}
