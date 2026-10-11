import { useCallback, useMemo, useRef, useState } from 'react';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import type { SiteMode } from '@forge/shared';
import { cluster, onchainConfig, poolCreationFeeSol, rpcRelayEndpoint, siteConfig } from './config';
import { ModeBanner } from './ModeBanner';
import { capabilitiesFor, currentMode } from './mode-guard';
import { createHttpLaunchApi, type LaunchApi } from './create/api';
import { formatSol, solNumberToLamports } from './create/amounts';
import { createRpcChainClient, type ChainClient, type ConfirmOptions } from './create/chain';
import {
  TxError,
  executeLaunch,
  prepareLaunch,
  waitForLaunch,
  type LaunchReview,
  type LaunchResult,
  type SignMessage,
  type SignTransaction,
} from './create/flow';
import { formatUnits } from './trade/amounts';
import { DEFAULT_TOKEN_DECIMALS } from './trade/constants';
import {
  DESCRIPTION_MAX,
  FIRST_BUY_MAX_SOL,
  IMAGE_TYPES,
  NAME_MAX,
  SYMBOL_MAX,
  normalizeSymbol,
  validateCreateCoin,
  type CreateCoinErrors,
} from './create/validation';

/**
 * LOCKED ZONE. Coin creation form for this launchpad.
 *
 * Sequence: form -> the wallet signs the upload authorization -> prepare (image + transaction
 * built by the server; every instruction decoded and the transaction simulated here) -> REVIEW
 * (full cost summary: creation fee, first buy, metadata fee, network fee, account rent, total)
 * -> the user signs -> send through the RPC relay -> poll for confirmation -> success. No
 * transaction is signed before the review is displayed.
 */

const inputClassName =
  'w-full rounded-lg border border-neutral-750 bg-background p-3 text-sm text-foreground placeholder:text-neutral-500 transition-colors focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/40';
const primaryButtonClassName =
  'inline-flex items-center justify-center gap-2 rounded-full bg-primary px-6 py-3 font-semibold text-primary-950 transition-colors hover:bg-primary-300 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButtonClassName =
  'inline-flex items-center justify-center rounded-full border border-neutral-750 px-6 py-3 font-medium text-neutral-200 transition-colors hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-50';
const cardClassName = 'rounded-xl border border-neutral-850 bg-neutral-925 p-5 sm:p-8';

export interface CreateCoinProps {
  /** Overrides the site mode (tests). */
  mode?: SiteMode;
  /** Overrides the HTTP preparation API (tests, previews). */
  api?: LaunchApi;
  /** Overrides the RPC relay client (tests, previews). */
  chain?: ChainClient;
  /** Overrides the creation fee from forge.config.json, in SOL (tests). */
  poolCreationFeeSol?: number;
  /** Overrides `forge.config.json#onchain.launchpadConfig` (tests). */
  launchpadConfig?: string;
  confirmOptions?: ConfirmOptions;
}

type Phase =
  | 'form'
  | 'preparing'
  | 'review'
  | 'signing'
  | 'sending'
  | 'confirming'
  | 'unconfirmed'
  | 'failed'
  | 'success';

export function CreateCoin(props: CreateCoinProps) {
  const mode = props.mode ?? currentMode();
  if (!capabilitiesFor(mode).create) {
    // No wallet, no RPC, no network: the gate renders before any hook that could touch them.
    return (
      <div data-forge="create-coin-disabled">
        <ModeBanner mode={mode} />
      </div>
    );
  }
  return <CreateCoinForm {...props} />;
}

export default CreateCoin;

function CreateCoinForm(props: CreateCoinProps) {
  const { publicKey, signTransaction, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const wallet = useMemo(() => publicKey?.toBase58(), [publicKey]);

  const api = useMemo(() => props.api ?? createHttpLaunchApi(), [props.api]);
  const chain = useMemo(
    () =>
      props.chain ?? (rpcRelayEndpoint ? createRpcChainClient({ url: rpcRelayEndpoint }) : null),
    [props.chain],
  );
  const feeSol = props.poolCreationFeeSol ?? poolCreationFeeSol;
  const feeLamports = feeSol === undefined ? undefined : solNumberToLamports(feeSol);
  const launchpadConfig = props.launchpadConfig ?? onchainConfig?.launchpadConfig;
  // Without the config address and the creation fee, nothing the server prepares can be checked.
  const configured = launchpadConfig !== undefined && feeLamports !== undefined;

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [firstBuySol, setFirstBuySol] = useState('');
  const [errors, setErrors] = useState<CreateCoinErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const [phase, setPhase] = useState<Phase>('form');
  const [review, setReview] = useState<LaunchReview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sentSignature, setSentSignature] = useState<string | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const busy = useRef(false);

  const form = { name, symbol, description, image, firstBuySol };

  const revalidate = (next: Partial<typeof form>) => {
    if (!submitted) return;
    const check = validateCreateCoin({ ...form, ...next });
    setErrors(check.ok ? {} : check.errors);
  };

  const deps = useCallback(() => {
    if (!wallet || !signTransaction || !chain) return null;
    return {
      api,
      chain,
      wallet,
      signTransaction: signTransaction as SignTransaction,
      signMessage: signMessage as SignMessage | undefined,
      launchpadConfig,
      poolCreationFeeLamports: feeLamports,
      confirm: props.confirmOptions,
    };
  }, [
    api,
    chain,
    wallet,
    signTransaction,
    signMessage,
    launchpadConfig,
    feeLamports,
    props.confirmOptions,
  ]);

  const reset = () => {
    setName('');
    setSymbol('');
    setDescription('');
    setImage(null);
    setFirstBuySol('');
    setErrors({});
    setSubmitted(false);
    setReview(null);
    setMessage(null);
    setSentSignature(null);
    setResult(null);
    setPhase('form');
  };

  const onPrepare = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    setSubmitted(true);
    const check = validateCreateCoin(form);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    const d = deps();
    if (!d || !image) return;

    busy.current = true;
    setMessage(null);
    setPhase('preparing');
    try {
      const prepared = await prepareLaunch(check.value, image, d);
      setReview(prepared);
      setPhase('review');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not prepare the coin.');
      setPhase('form');
    } finally {
      busy.current = false;
    }
  };

  const onSign = async () => {
    const d = deps();
    if (busy.current || !review || !d) return;
    busy.current = true;
    setMessage(null);
    try {
      const done = await executeLaunch(review, d, (next, signature) => {
        setPhase(next === 'signing' ? 'signing' : next === 'sending' ? 'sending' : 'confirming');
        if (signature) setSentSignature(signature);
      });
      setResult(done);
      setPhase('success');
    } catch (error) {
      if (error instanceof TxError) {
        setMessage(error.message);
        if (error.signature) setSentSignature(error.signature);
        if (error.code === 'timeout') setPhase('unconfirmed');
        else if (error.code === 'onchain_failed' || error.code === 'expired') setPhase('failed');
        else setPhase('review');
      } else {
        setMessage(error instanceof Error ? error.message : 'Unexpected error.');
        setPhase('review');
      }
    } finally {
      busy.current = false;
    }
  };

  const onCheckAgain = async () => {
    const d = deps();
    if (busy.current || !review || !sentSignature || !d) return;
    busy.current = true;
    setMessage(null);
    setPhase('confirming');
    try {
      setResult(await waitForLaunch(review.mint, sentSignature, d));
      setPhase('success');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unexpected error.');
      setPhase(error instanceof TxError && error.code === 'timeout' ? 'unconfirmed' : 'failed');
    } finally {
      busy.current = false;
    }
  };

  if (phase === 'success' && result) {
    return <Success result={result} onAnother={reset} />;
  }

  if (phase === 'review' || phase === 'signing' || phase === 'sending') {
    if (review) {
      return (
        <Review
          review={review}
          phase={phase}
          message={message}
          creationFeeRecipient={siteConfig.name}
          onSign={onSign}
          onBack={() => {
            setMessage(null);
            setPhase('form');
          }}
        />
      );
    }
  }

  if (phase === 'confirming' || phase === 'unconfirmed' || phase === 'failed') {
    return (
      <div className={cardClassName} data-forge="create-coin-status">
        {phase === 'confirming' && (
          <p role="status" className="text-neutral-300">
            Waiting for the network to confirm your coin...
          </p>
        )}
        {phase === 'unconfirmed' && (
          <>
            <p role="alert" className="text-rose">
              {message}
            </p>
            <div className="mt-4 flex gap-3">
              <button type="button" className={primaryButtonClassName} onClick={onCheckAgain}>
                Check again
              </button>
            </div>
          </>
        )}
        {phase === 'failed' && (
          <>
            <p role="alert" className="text-rose">
              {message}
            </p>
            <div className="mt-4 flex gap-3">
              <button type="button" className={secondaryButtonClassName} onClick={reset}>
                Start over
              </button>
            </div>
          </>
        )}
        {sentSignature && (
          <p className="mt-4 break-all text-xs text-neutral-500">
            Transaction:{' '}
            <a
              className="underline"
              href={explorerTxUrl(sentSignature)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {sentSignature}
            </a>
          </p>
        )}
      </div>
    );
  }

  const preparing = phase === 'preparing';
  const symbolPreview = normalizeSymbol(symbol);

  return (
    <form onSubmit={onPrepare} noValidate className="space-y-8" data-forge="create-coin-form">
      <div className={cardClassName}>
        <h2 className="mb-4 text-xl font-bold md:text-2xl">Coin details</h2>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <Field label="Name*" htmlFor="coinName" error={errors.name}>
              <input
                id="coinName"
                type="text"
                className={inputClassName}
                placeholder="e.g. Moon Coin"
                maxLength={NAME_MAX + 8}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  revalidate({ name: e.target.value });
                }}
                aria-invalid={Boolean(errors.name)}
              />
            </Field>
            <Field label="Symbol*" htmlFor="coinSymbol" error={errors.symbol}>
              <input
                id="coinSymbol"
                type="text"
                className={inputClassName}
                placeholder="e.g. MOON"
                maxLength={SYMBOL_MAX + 4}
                value={symbol}
                onChange={(e) => {
                  setSymbol(e.target.value);
                  revalidate({ symbol: e.target.value });
                }}
                aria-invalid={Boolean(errors.symbol)}
              />
            </Field>
          </div>

          <Field label="Coin image*" htmlFor="coinImage" error={errors.image}>
            <input
              id="coinImage"
              type="file"
              accept={IMAGE_TYPES.join(',')}
              className={inputClassName}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setImage(file);
                revalidate({ image: file });
              }}
              aria-invalid={Boolean(errors.image)}
            />
            <p className="mt-1 text-xs text-neutral-500">
              {image?.name ?? 'PNG, JPEG, WebP or GIF, 2 MB maximum'}
            </p>
          </Field>
        </div>

        <Field label="Description" htmlFor="coinDescription" error={errors.description}>
          <textarea
            id="coinDescription"
            className={inputClassName}
            rows={3}
            placeholder="What is this coin about?"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              revalidate({ description: e.target.value });
            }}
            aria-invalid={Boolean(errors.description)}
          />
          <p className="mt-1 text-xs text-neutral-500">
            {description.trim().length}/{DESCRIPTION_MAX}
          </p>
        </Field>
      </div>

      <div className={cardClassName}>
        <h2 className="mb-4 text-xl font-bold md:text-2xl">First buy</h2>
        <Field
          label="First buy (SOL, optional)"
          htmlFor="firstBuySol"
          error={errors.firstBuySol}
          hint={`Buy your own coin in the same transaction, up to ${FIRST_BUY_MAX_SOL} SOL. Leave empty for none.`}
        >
          <input
            id="firstBuySol"
            type="text"
            inputMode="decimal"
            className={inputClassName}
            placeholder="0.1"
            value={firstBuySol}
            onChange={(e) => {
              setFirstBuySol(e.target.value);
              revalidate({ firstBuySol: e.target.value });
            }}
            aria-invalid={Boolean(errors.firstBuySol)}
          />
        </Field>

        <dl className="mt-4 space-y-1 text-sm text-neutral-300" data-forge="create-coin-estimate">
          <div className="flex justify-between gap-4">
            <dt>Creation fee (paid to {siteConfig.name})</dt>
            <dd>
              {feeSol === undefined
                ? 'shown in the review'
                : `${formatSol(feeLamports as bigint)} SOL`}
            </dd>
          </div>
        </dl>
        <p className="pt-1 text-xs text-neutral-500">
          The network fee and the deposit for new accounts are added in the review. You always see
          the full total before anything is signed.
        </p>
      </div>

      {message && (
        <p
          role="alert"
          className="rounded-lg border border-rose/40 bg-rose/10 p-4 text-sm text-rose"
        >
          {message}
        </p>
      )}

      <div className="flex items-center justify-end gap-4">
        {symbolPreview && <span className="text-xs text-neutral-500">${symbolPreview}</span>}
        {!wallet ? (
          <button
            type="button"
            className={primaryButtonClassName}
            onClick={() => setShowModal(true)}
          >
            Connect wallet
          </button>
        ) : !chain ? (
          <p role="alert" className="text-sm text-rose">
            Coin creation is not configured on this site (RPC relay missing).
          </p>
        ) : !configured ? (
          <p role="alert" className="text-sm text-rose">
            Coin creation is not configured on this site yet.
          </p>
        ) : (
          <button type="submit" className={primaryButtonClassName} disabled={preparing}>
            {preparing ? 'Preparing...' : 'Review launch'}
          </button>
        )}
      </div>
    </form>
  );
}

function Field(props: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <label htmlFor={props.htmlFor} className="mb-1.5 block text-sm font-medium text-neutral-300">
        {props.label}
      </label>
      {props.children}
      {props.hint && !props.error && <p className="mt-1 text-xs text-neutral-500">{props.hint}</p>}
      {props.error && (
        <p role="alert" className="mt-1 text-xs text-rose">
          {props.error}
        </p>
      )}
    </div>
  );
}

function Review(props: {
  review: LaunchReview;
  phase: 'review' | 'signing' | 'sending';
  message: string | null;
  creationFeeRecipient: string;
  onSign: () => void;
  onBack: () => void;
}) {
  const { summary } = props.review;
  const working = props.phase !== 'review';
  return (
    <div className={cardClassName} data-forge="create-coin-review">
      <h2 className="mb-1 text-xl font-bold md:text-2xl">Review your launch</h2>
      <p className="mb-4 text-sm text-neutral-400">
        Check every line. The transaction was decoded and simulated in your browser and matches this
        summary. Your wallet will ask you to sign once; nothing is charged before that.
      </p>

      <dl className="space-y-2 text-sm">
        <Row label="Coin" value={`${summary.coinName} (${summary.coinSymbol})`} />
        <Row
          label={`Creation fee (paid to ${props.creationFeeRecipient})`}
          value={`${formatSol(summary.poolCreationFeeLamports)} SOL`}
        />
        <Row label="First buy" value={`${formatSol(summary.firstBuyLamports)} SOL`} />
        {summary.firstBuyLamports > BigInt(0) && (
          <Row
            label="You receive at least"
            value={`${formatUnits(summary.firstBuyMinimumTokensOut, DEFAULT_TOKEN_DECIMALS)} ${summary.coinSymbol}`}
          />
        )}
        <Row
          label="Metadata fee (Metaplex)"
          value={`${formatSol(summary.metadataFeeLamports)} SOL`}
        />
        <Row label="Network fee" value={`${formatSol(summary.estimatedNetworkFeeLamports)} SOL`} />
        <Row
          label="Deposit for new accounts"
          value={`${formatSol(summary.accountRentLamports)} SOL`}
        />
        <div className="flex justify-between gap-4 border-t border-neutral-850 pt-2 font-semibold">
          <dt>Total</dt>
          <dd data-testid="review-total">{formatSol(summary.totalLamports)} SOL</dd>
        </div>
      </dl>

      <p className="mt-4 break-all text-xs text-neutral-500">
        Creator wallet (receives the creator fee share): {summary.creatorWallet}
      </p>
      <p className="break-all text-xs text-neutral-500">Mint: {props.review.mint}</p>

      {props.review.insufficientBalance && props.review.balanceLamports !== null && (
        <p role="alert" className="mt-4 text-sm text-rose">
          Not enough SOL: this launch needs {formatSol(summary.totalLamports)} SOL and your wallet
          holds {formatSol(props.review.balanceLamports)} SOL.
        </p>
      )}
      {props.message && (
        <p role="alert" className="mt-4 text-sm text-rose">
          {props.message}
        </p>
      )}
      {working && (
        <p role="status" className="mt-4 text-sm text-neutral-300">
          {props.phase === 'signing'
            ? 'Waiting for your signature...'
            : 'Sending to the network...'}
        </p>
      )}

      <div className="mt-6 flex flex-col justify-end gap-3 sm:flex-row">
        <button
          type="button"
          className={secondaryButtonClassName}
          onClick={props.onBack}
          disabled={working}
        >
          Back
        </button>
        <button
          type="button"
          className={primaryButtonClassName}
          onClick={props.onSign}
          disabled={working || props.review.insufficientBalance}
        >
          Sign and launch
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-400">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function explorerTxUrl(signature: string): string {
  const suffix = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${suffix}`;
}

function Success({ result, onAnother }: { result: LaunchResult; onAnother: () => void }) {
  return (
    <div className={`${cardClassName} text-center`} data-forge="create-coin-success">
      <h2 className="mb-4 text-2xl font-bold md:text-3xl">Your coin is live</h2>
      <p className="mx-auto mb-2 max-w-lg text-neutral-400">
        The transaction is confirmed. Your coin can now be traded on {siteConfig.name}.
      </p>
      <p className="mb-6 break-all text-xs text-neutral-500">Mint: {result.mint}</p>
      <div className="flex flex-col justify-center gap-3 sm:flex-row sm:gap-4">
        <a className={primaryButtonClassName} href={`/token/${encodeURIComponent(result.mint)}`}>
          View your coin
        </a>
        <a
          className={secondaryButtonClassName}
          href={explorerTxUrl(result.signature)}
          target="_blank"
          rel="noopener noreferrer"
        >
          View transaction
        </a>
        <button type="button" className={secondaryButtonClassName} onClick={onAnother}>
          Create another coin
        </button>
      </div>
    </div>
  );
}
