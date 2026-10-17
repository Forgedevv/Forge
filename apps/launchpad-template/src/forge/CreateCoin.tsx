import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import type { SiteMode } from '@forge/shared';
import { cluster, onchainConfig, poolCreationFeeSol, rpcRelayEndpoint, siteConfig } from './config';
import { ModeBanner } from './ModeBanner';
import { capabilitiesFor, currentMode } from './mode-guard';
import { createHttpLaunchApi, type LaunchApi } from './create/api';
import { formatSol, parseSolToLamports, solNumberToLamports } from './create/amounts';
import { createRpcChainClient, type ChainClient, type ConfirmOptions } from './create/chain';
import { CREATE_COIN_TEXT } from './create/copy';
import {
  REVIEW_FRESH_MS,
  REVIEW_MAX_AGE_MS,
  TxError,
  affordableFirstBuyLamports,
  canRebuild,
  costRose,
  executeLaunch,
  messageForUser,
  prepareLaunch,
  rebuildLaunch,
  reviewAge,
  waitForLaunch,
  type LaunchDeps,
  type LaunchResult,
  type LaunchReview,
  type PrepareStep,
  type SignMessage,
  type SignTransaction,
  type TxErrorCode,
} from './create/flow';
import { firstBuyPlatformFee } from './create/platform-fee';
import {
  DESCRIPTION_MAX,
  FIRST_BUY_MAX_SOL,
  SYMBOL_MAX,
  VALIDATION_TEXT,
  invalidFields,
  nameUsage,
  normalizeSymbol,
  validateCreateCoin,
  validateImageFile,
  type CreateCoinErrors,
  type CreateCoinField,
  type ValidatedCoin,
} from './create/validation';
import { CoinPreview } from './create/ui/CoinPreview';
import { ImageDropzone } from './create/ui/ImageDropzone';
import { LaunchSuccess } from './create/ui/LaunchSuccess';
import { PrepareSteps, Spinner } from './create/ui/PrepareSteps';
import { ui } from './create/ui/styles';
import { formatBps, formatUnits } from './trade/amounts';
import { DEFAULT_TOKEN_DECIMALS, PLATFORM_FEE_BPS } from './trade/constants';

/**
 * LOCKED ZONE. Coin creation form for this launchpad.
 *
 * Sequence: form -> the wallet signs a free upload authorization -> prepare (image + transaction
 * built by the server; every instruction decoded and the transaction simulated here) -> REVIEW
 * (full cost summary: creation fee, first buy, FORGE platform fee on the first buy, metadata fee,
 * network fee, account rent, total) -> the user signs -> send through the RPC relay -> poll for
 * confirmation -> success. No transaction is signed before the review is displayed.
 *
 * Nothing the visitor typed is ever lost on the way: going back, an expired or failed transaction
 * and a lower first buy all keep the form. When only the transaction must change (fresh
 * blockhash, another first buy), the server rebuilds the same launch without a new upload or
 * signature (`rebuildLaunch`); a review older than `REVIEW_FRESH_MS` is rebuilt before signing.
 * Every text comes from `create/copy.ts`.
 */

const TEXT = CREATE_COIN_TEXT;
const PERCENT = formatBps(PLATFORM_FEE_BPS);
const FIRST_BUY_PRESETS = ['0.1', '0.5', '1'] as const;

const FIELD_IDS: Record<CreateCoinField, string> = {
  image: 'coinImage',
  name: 'coinName',
  symbol: 'coinSymbol',
  description: 'coinDescription',
  firstBuySol: 'firstBuySol',
};

const FIELD_LABELS: Record<CreateCoinField, string> = {
  image: TEXT.image.label,
  name: TEXT.details.nameLabel,
  symbol: TEXT.details.symbolLabel,
  description: TEXT.details.descriptionLabel,
  firstBuySol: TEXT.firstBuy.title,
};

export interface CreateCoinProps {
  /** Overrides the site mode (tests). */
  mode?: SiteMode;
  /** Overrides the HTTP preparation API (tests, previews). */
  api?: LaunchApi;
  /** Overrides the RPC relay client (tests, previews). */
  chain?: ChainClient;
  /** Overrides the creation fee from forge.config.json, in SOL (tests). */
  poolCreationFeeSol?: number;
  confirmOptions?: ConfirmOptions;
  /** Clock (tests). */
  now?: () => Date;
}

type Phase =
  | 'form'
  | 'preparing'
  | 'rebuilding'
  | 'review'
  | 'refreshing'
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

/** Object URL of a picked file for the previews, revoked when the file changes. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );
}

/** Scrolls to a field and focuses its control. */
function focusField(field: CreateCoinField) {
  if (typeof document === 'undefined') return;
  const control = document.getElementById(FIELD_IDS[field]);
  const block = document.getElementById(`${FIELD_IDS[field]}-field`) ?? control;
  block?.scrollIntoView?.({
    block: 'center',
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
  control?.focus({ preventScroll: true });
}

function explorerTxUrl(signature: string): string {
  const suffix = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${suffix}`;
}

/** The same coin texts and image as the review: only the transaction may need to change. */
function sameCoin(
  review: LaunchReview,
  coin: ValidatedCoin,
  image: File | null,
  reviewImage: File | null,
) {
  return (
    image !== null &&
    image === reviewImage &&
    review.coin.name === coin.name &&
    review.coin.symbol === coin.symbol &&
    review.coin.description === coin.description
  );
}

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
  // The config coins are created on comes from forge.config.json only (no prop can change it).
  const launchpadConfig = onchainConfig?.launchpadConfig;
  // Without the config address and the creation fee, nothing the server prepares can be checked.
  const configured = launchpadConfig !== undefined && feeLamports !== undefined;

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [firstBuySol, setFirstBuySol] = useState('');
  const [errors, setErrors] = useState<CreateCoinErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const imageUrl = useObjectUrl(image);

  const [phase, setPhase] = useState<Phase>('form');
  const [step, setStep] = useState<PrepareStep>('sign');
  /** The last verified review; kept when going back so the launch can be rebuilt. */
  const [review, setReview] = useState<LaunchReview | null>(null);
  const [reviewImage, setReviewImage] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sentSignature, setSentSignature] = useState<string | null>(null);
  const [expiryHeight, setExpiryHeight] = useState<number | undefined>(undefined);
  const [failedCode, setFailedCode] = useState<TxErrorCode | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const busy = useRef(false);

  const form = { name, symbol, description, image, firstBuySol };

  const revalidate = (next: Partial<typeof form>) => {
    if (!submitted) return;
    const check = validateCreateCoin({ ...form, ...next });
    setErrors(check.ok ? {} : check.errors);
  };

  const deps = useCallback((): LaunchDeps | null => {
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
      now: props.now,
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
    props.now,
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
    setReviewImage(null);
    setMessage(null);
    setNotice(null);
    setSentSignature(null);
    setExpiryHeight(undefined);
    setFailedCode(null);
    setResult(null);
    setPhase('form');
  };

  /** Back to the form with every input kept, and a message. */
  const backToForm = (text: string | null, keepReview: boolean) => {
    if (!keepReview) {
      setReview(null);
      setReviewImage(null);
    }
    setMessage(text);
    setNotice(null);
    setSentSignature(null);
    setFailedCode(null);
    setPhase('form');
  };

  const onPickImage = (file: File | null) => {
    if (file) {
      const problem = validateImageFile(file);
      if (problem) {
        // Refused at once: the previous image (if any) stays.
        setErrors((current) => ({ ...current, image: problem }));
        return;
      }
    }
    setImage(file);
    if (submitted || file) {
      const check = validateCreateCoin({ ...form, image: file });
      setErrors((current) =>
        submitted ? (check.ok ? {} : check.errors) : { ...current, image: undefined },
      );
    }
  };

  const onPrepare = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    setSubmitted(true);
    const check = validateCreateCoin(form);
    if (!check.ok) {
      setErrors(check.errors);
      const first = invalidFields(check.errors)[0];
      if (first) focusField(first);
      return;
    }
    setErrors({});
    const d = deps();
    if (!d || !image) return;
    const coin = check.value;

    busy.current = true;
    setMessage(null);
    setNotice(null);
    try {
      // Same coin as the last review: only the first buy or the blockhash changes.
      if (
        review &&
        canRebuild(review, d) &&
        review.summary.creatorWallet === d.wallet &&
        sameCoin(review, coin, image, reviewImage)
      ) {
        setPhase('rebuilding');
        try {
          setReview(await rebuildLaunch(review, coin.firstBuyLamports, d));
          setPhase('review');
          return;
        } catch (error) {
          if (!(error instanceof TxError && error.code === 'prepare_again')) throw error;
          // The server forgot this launch: prepare it again in full.
        }
      }
      setStep('sign');
      setPhase('preparing');
      const prepared = await prepareLaunch(coin, image, d, setStep);
      setReview(prepared);
      setReviewImage(image);
      setPhase('review');
    } catch (error) {
      setMessage(messageForUser(error, TEXT.errors.unexpected));
      setPhase('form');
    } finally {
      busy.current = false;
    }
  };

  /** Signs and sends `current`; maps the outcome to the next phase. */
  const submit = async (current: LaunchReview, d: LaunchDeps) => {
    try {
      const done = await executeLaunch(current, d, (next, signature) => {
        setPhase(next === 'signing' ? 'signing' : next === 'sending' ? 'sending' : 'confirming');
        if (signature) setSentSignature(signature);
      });
      setResult(done);
      setPhase('success');
    } catch (error) {
      setMessage(messageForUser(error, TEXT.errors.unexpected));
      if (error instanceof TxError) {
        if (error.signature) setSentSignature(error.signature);
        setExpiryHeight(error.expiryHeight);
        if (error.code === 'timeout') setPhase('unconfirmed');
        else if (error.code === 'onchain_failed' || error.code === 'expired') {
          setFailedCode(error.code);
          setPhase('failed');
        } else setPhase('review');
      } else {
        setPhase('review');
      }
    }
  };

  const onSign = async () => {
    if (busy.current || !review) return;
    const d = deps();
    if (!d) {
      setMessage(TEXT.errors.walletDisconnected);
      return;
    }
    if (review.summary.creatorWallet !== d.wallet) {
      backToForm(TEXT.errors.walletChanged, false);
      return;
    }
    busy.current = true;
    setMessage(null);
    setNotice(null);
    try {
      let current = review;
      const age = reviewAge(current, d);
      if (age > REVIEW_FRESH_MS) {
        // Its blockhash is getting old: get a fresh transaction for the same launch first.
        let refreshed: LaunchReview | null = null;
        if (canRebuild(current, d)) {
          setPhase('refreshing');
          try {
            refreshed = await rebuildLaunch(current, current.coin.firstBuyLamports, d);
          } catch (error) {
            if (!(error instanceof TxError && error.code === 'prepare_again')) {
              setMessage(messageForUser(error, TEXT.errors.unexpected));
              setPhase('review');
              return;
            }
          }
        }
        if (refreshed) {
          setReview(refreshed);
          if (refreshed.insufficientBalance || costRose(current, refreshed)) {
            // Never sign a higher total than the one on screen without showing it.
            setNotice(refreshed.insufficientBalance ? null : TEXT.errors.totalChanged);
            setPhase('review');
            return;
          }
          current = refreshed;
        } else if (age > REVIEW_MAX_AGE_MS) {
          backToForm(TEXT.errors.reviewOutdated, false);
          return;
        }
      }
      await submit(current, d);
    } finally {
      busy.current = false;
    }
  };

  /** "Try again" after an expired or failed transaction: same launch, fresh transaction. */
  const onRetry = async () => {
    if (busy.current || !review) return;
    const d = deps();
    if (!d) {
      setMessage(TEXT.errors.walletDisconnected);
      return;
    }
    if (!canRebuild(review, d) || review.summary.creatorWallet !== d.wallet) {
      backToForm(TEXT.errors.retryKept, false);
      return;
    }
    busy.current = true;
    setMessage(null);
    setPhase('refreshing');
    try {
      const next = await rebuildLaunch(review, review.coin.firstBuyLamports, d);
      setReview(next);
      setSentSignature(null);
      setExpiryHeight(undefined);
      setFailedCode(null);
      setPhase('review');
    } catch (error) {
      if (error instanceof TxError && error.code === 'prepare_again') {
        backToForm(TEXT.errors.retryKept, false);
      } else {
        setMessage(messageForUser(error, TEXT.errors.unexpected));
        setFailedCode(error instanceof TxError ? error.code : null);
        setPhase('failed');
      }
    } finally {
      busy.current = false;
    }
  };

  /** Lower (or change) the first buy from the review: same launch, rebuilt with the new amount. */
  const onChangeFirstBuy = async (sol: string): Promise<string | null> => {
    const lamports = parseSolToLamports(sol);
    if (lamports === null) return VALIDATION_TEXT.firstBuyFormat;
    if (lamports > BigInt(FIRST_BUY_MAX_SOL) * BigInt(1000000000))
      return VALIDATION_TEXT.firstBuyMax;
    setFirstBuySol(lamports === BigInt(0) ? '' : sol.trim());
    if (busy.current || !review) return null;
    const d = deps();
    if (!d) return TEXT.errors.walletDisconnected;
    if (!canRebuild(review, d) || review.summary.creatorWallet !== d.wallet) {
      backToForm(TEXT.errors.retryKept, false);
      return null;
    }
    busy.current = true;
    setMessage(null);
    setNotice(null);
    setPhase('refreshing');
    try {
      setReview(await rebuildLaunch(review, lamports, d));
      setPhase('review');
    } catch (error) {
      if (error instanceof TxError && error.code === 'prepare_again') {
        backToForm(TEXT.errors.retryKept, false);
      } else {
        setMessage(messageForUser(error, TEXT.errors.unexpected));
        setPhase('review');
      }
    } finally {
      busy.current = false;
    }
    return null;
  };

  const onCheckAgain = async () => {
    const d = deps();
    if (busy.current || !review || !sentSignature || !d) return;
    busy.current = true;
    setMessage(null);
    setPhase('confirming');
    try {
      setResult(await waitForLaunch(review.mint, sentSignature, d, expiryHeight));
      setPhase('success');
    } catch (error) {
      setMessage(messageForUser(error, TEXT.errors.unexpected));
      if (error instanceof TxError && error.code === 'timeout') setPhase('unconfirmed');
      else {
        setFailedCode(error instanceof TxError ? error.code : null);
        setPhase('failed');
      }
    } finally {
      busy.current = false;
    }
  };

  if (phase === 'success' && result) {
    return (
      <LaunchSuccess
        mint={result.mint}
        name={review?.coin.name ?? name.trim()}
        symbol={review?.coin.symbol ?? normalizeSymbol(symbol)}
        imageUrl={imageUrl}
        siteName={siteConfig.name}
        transactionUrl={explorerTxUrl(result.signature)}
        onAnother={reset}
      />
    );
  }

  if (
    review &&
    (phase === 'review' || phase === 'refreshing' || phase === 'signing' || phase === 'sending')
  ) {
    return (
      <Review
        review={review}
        phase={phase}
        message={message}
        notice={notice}
        imageUrl={imageUrl}
        walletConnected={Boolean(wallet)}
        onConnect={() => setShowModal(true)}
        onSign={onSign}
        onChangeFirstBuy={onChangeFirstBuy}
        canChangeFirstBuy={Boolean(api.rebuild && review.rebuildToken)}
        onBack={() => backToForm(null, true)}
      />
    );
  }

  if (phase === 'confirming' || phase === 'unconfirmed' || phase === 'failed') {
    const retryable = failedCode === 'expired' || failedCode === 'onchain_failed';
    return (
      <section data-forge="create-coin-status" className="space-y-4">
        {phase === 'confirming' && (
          <p role="status" className="flex items-center gap-3 text-neutral-300">
            <Spinner />
            {TEXT.status.confirming}
          </p>
        )}
        {phase === 'unconfirmed' && (
          <>
            <p role="alert" className={ui.alert}>
              {message}
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className={ui.primaryButton} onClick={onCheckAgain}>
                {TEXT.actions.checkAgain}
              </button>
            </div>
          </>
        )}
        {phase === 'failed' && (
          <>
            <p role="alert" className={ui.alert}>
              {message}
            </p>
            <div className="flex flex-wrap gap-3">
              {retryable && (
                <button type="button" className={ui.primaryButton} onClick={onRetry}>
                  {TEXT.actions.tryAgain}
                </button>
              )}
              <button
                type="button"
                className={ui.secondaryButton}
                onClick={() => backToForm(null, failedCode !== 'already_launched')}
              >
                {TEXT.actions.edit}
              </button>
            </div>
          </>
        )}
        {sentSignature && (
          <p className="break-all text-xs text-neutral-500">
            {TEXT.status.transaction}:{' '}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={explorerTxUrl(sentSignature)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {sentSignature}
            </a>
          </p>
        )}
      </section>
    );
  }

  const locked = phase === 'preparing' || phase === 'rebuilding';
  const usage = nameUsage(name);
  const symbolPreview = normalizeSymbol(symbol);
  const invalid = submitted ? invalidFields(errors) : [];
  const firstBuyLamports = parseSolToLamports(firstBuySol.trim() || '0');
  const firstBuyFee = firstBuyLamports ? firstBuyPlatformFee(firstBuyLamports) : BigInt(0);
  const canSignMessages = typeof signMessage === 'function';

  return (
    <form
      onSubmit={onPrepare}
      noValidate
      aria-busy={locked || undefined}
      className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_15rem] xl:items-start"
      data-forge="create-coin-form"
    >
      <section className={`${ui.section} xl:col-start-1`}>
        <h2 className={ui.sectionTitle}>{TEXT.details.title}</h2>

        <div className="grid gap-5 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-6">
          <Field
            id={FIELD_IDS.image}
            label={TEXT.image.label}
            required
            error={errors.image}
            hint={TEXT.image.formats}
          >
            <ImageDropzone
              id={FIELD_IDS.image}
              file={image}
              previewUrl={imageUrl}
              onPick={onPickImage}
              disabled={locked}
              invalid={Boolean(errors.image)}
              describedBy={`${FIELD_IDS.image}-hint ${FIELD_IDS.image}-error`}
            />
          </Field>

          <div className="min-w-0 space-y-4">
            <Field
              id={FIELD_IDS.name}
              label={TEXT.details.nameLabel}
              required
              error={errors.name}
              counter={{
                text: `${usage.used}/${usage.max}`,
                over: usage.used > usage.max,
                label: usage.multibyte
                  ? TEXT.details.counterBytes(usage.used, usage.max)
                  : TEXT.details.counter(usage.used, usage.max),
              }}
            >
              <input
                id={FIELD_IDS.name}
                type="text"
                autoComplete="off"
                className={ui.input}
                placeholder={TEXT.details.namePlaceholder}
                value={name}
                disabled={locked}
                onChange={(e) => {
                  setName(e.target.value);
                  revalidate({ name: e.target.value });
                }}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={`${FIELD_IDS.name}-count ${FIELD_IDS.name}-error`}
              />
            </Field>

            <Field
              id={FIELD_IDS.symbol}
              label={TEXT.details.symbolLabel}
              required
              error={errors.symbol}
              hint={TEXT.details.symbolHint}
              counter={{
                text: `${symbolPreview.length}/${SYMBOL_MAX}`,
                over: symbolPreview.length > SYMBOL_MAX,
                label: TEXT.details.counter(symbolPreview.length, SYMBOL_MAX),
              }}
            >
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-neutral-500"
                >
                  $
                </span>
                <input
                  id={FIELD_IDS.symbol}
                  type="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className={`${ui.input} pl-7 uppercase`}
                  placeholder={TEXT.details.symbolPlaceholder}
                  maxLength={SYMBOL_MAX + 6}
                  value={symbol}
                  disabled={locked}
                  onChange={(e) => {
                    const next = e.target.value.toUpperCase();
                    setSymbol(next);
                    revalidate({ symbol: next });
                  }}
                  aria-invalid={Boolean(errors.symbol)}
                  aria-describedby={`${FIELD_IDS.symbol}-count ${FIELD_IDS.symbol}-hint ${FIELD_IDS.symbol}-error`}
                />
              </div>
            </Field>
          </div>
        </div>

        <Field
          id={FIELD_IDS.description}
          label={TEXT.details.descriptionLabel}
          error={errors.description}
          counter={{
            text: `${description.trim().length}/${DESCRIPTION_MAX}`,
            over: description.trim().length > DESCRIPTION_MAX,
            label: TEXT.details.counter(description.trim().length, DESCRIPTION_MAX),
            note: TEXT.details.optional,
          }}
          className="mt-4"
        >
          <textarea
            id={FIELD_IDS.description}
            className={`${ui.input} min-h-[6rem] resize-y`}
            rows={3}
            placeholder={TEXT.details.descriptionPlaceholder}
            value={description}
            disabled={locked}
            onChange={(e) => {
              setDescription(e.target.value);
              revalidate({ description: e.target.value });
            }}
            aria-invalid={Boolean(errors.description)}
            aria-describedby={`${FIELD_IDS.description}-count ${FIELD_IDS.description}-error`}
          />
        </Field>
      </section>

      <CoinPreview
        name={name}
        symbol={symbolPreview}
        description={description}
        imageUrl={imageUrl}
        className="min-w-0 xl:sticky xl:top-[calc(var(--header-height,4.5rem)+1.5rem)] xl:col-start-2 xl:row-span-2 xl:row-start-1"
      />

      <div className="min-w-0 space-y-8 xl:col-start-1">
        <section className={ui.section}>
          <h2 className={ui.sectionTitle}>{TEXT.firstBuy.title}</h2>
          <Field
            id={FIELD_IDS.firstBuySol}
            label={TEXT.firstBuy.label}
            error={errors.firstBuySol}
            hint={TEXT.firstBuy.hint(FIRST_BUY_MAX_SOL)}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative sm:max-w-[14rem] sm:flex-1">
                <input
                  id={FIELD_IDS.firstBuySol}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  className={`${ui.input} pr-12 tabular-nums`}
                  placeholder="0.1"
                  value={firstBuySol}
                  disabled={locked}
                  onChange={(e) => {
                    setFirstBuySol(e.target.value);
                    revalidate({ firstBuySol: e.target.value });
                  }}
                  aria-invalid={Boolean(errors.firstBuySol)}
                  aria-describedby={`${FIELD_IDS.firstBuySol}-hint ${FIELD_IDS.firstBuySol}-error`}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-neutral-500"
                >
                  {TEXT.firstBuy.unit}
                </span>
              </div>
              <div role="group" aria-label={TEXT.firstBuy.presets} className="flex flex-wrap gap-2">
                {['', ...FIRST_BUY_PRESETS].map((preset) => (
                  <button
                    key={preset || 'none'}
                    type="button"
                    className={ui.chip}
                    aria-pressed={firstBuySol.trim() === preset}
                    disabled={locked}
                    onClick={() => {
                      setFirstBuySol(preset);
                      revalidate({ firstBuySol: preset });
                    }}
                  >
                    {preset ? `${preset} ${TEXT.firstBuy.unit}` : TEXT.firstBuy.none}
                  </button>
                ))}
              </div>
            </div>
          </Field>

          <dl className={`${ui.dl} mt-2`} data-forge="create-coin-estimate">
            <div className="flex justify-between gap-4">
              <dt className={ui.muted}>{TEXT.costs.creationFee(siteConfig.name)}</dt>
              <dd className="tabular-nums">
                {feeSol === undefined
                  ? TEXT.costs.creationFeeLater
                  : `${formatSol(feeLamports as bigint)} SOL`}
              </dd>
            </div>
            {firstBuyLamports !== null && firstBuyLamports > BigInt(0) && (
              <>
                <div className="flex justify-between gap-4">
                  <dt className={ui.muted}>{TEXT.costs.firstBuy}</dt>
                  <dd className="tabular-nums">{formatSol(firstBuyLamports)} SOL</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className={ui.muted}>{TEXT.costs.platformFee(PERCENT)}</dt>
                  <dd className="tabular-nums">{formatSol(firstBuyFee)} SOL</dd>
                </div>
              </>
            )}
          </dl>
          <p className={ui.hint}>{TEXT.costs.note(PERCENT)}</p>
        </section>

        <section className={`${ui.section} space-y-4`}>
          {phase === 'preparing' && <PrepareSteps current={step} />}
          {phase === 'rebuilding' && (
            <p role="status" className="flex items-center gap-3 text-sm text-neutral-300">
              <Spinner />
              {TEXT.steps.rebuilding}
            </p>
          )}

          {invalid.length > 0 && (
            <div role="alert" className={ui.alert} data-forge="create-coin-error-summary">
              <p className="font-medium">{TEXT.errors.summary(invalid.length)}</p>
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {invalid.map((field) => (
                  <li key={field}>
                    <button
                      type="button"
                      className="underline underline-offset-2 hover:no-underline"
                      onClick={() => focusField(field)}
                    >
                      {FIELD_LABELS[field]}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {message && (
            <p role="alert" className={ui.alert}>
              {message}
            </p>
          )}

          <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
            {!wallet ? (
              <button type="button" className={ui.primaryButton} onClick={() => setShowModal(true)}>
                {TEXT.actions.connect}
              </button>
            ) : !chain ? (
              <p role="status" className={ui.note}>
                {TEXT.errors.unavailable}
              </p>
            ) : !configured ? (
              <p role="status" className={ui.note}>
                {TEXT.errors.notConfigured}
              </p>
            ) : !canSignMessages ? (
              <p role="alert" className={ui.alert}>
                {TEXT.errors.noMessageSigning}
              </p>
            ) : (
              <>
                <p className="text-xs text-neutral-500 sm:mr-auto sm:max-w-sm">
                  {TEXT.actions.reviewHint}
                </p>
                <button type="submit" className={ui.primaryButton} disabled={locked}>
                  {locked && <Spinner />}
                  {phase === 'preparing'
                    ? TEXT.actions.preparing
                    : phase === 'rebuilding'
                      ? TEXT.actions.updating
                      : TEXT.actions.review}
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    </form>
  );
}

function Field(props: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  counter?: { text: string; over: boolean; label: string; note?: string };
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div id={`${props.id}-field`} className={`min-w-0 ${props.className ?? ''}`}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={props.id} className={ui.label}>
          {props.label}
          {props.required && (
            <span aria-hidden="true" className="text-primary">
              *
            </span>
          )}
        </label>
        {props.counter && (
          <span
            id={`${props.id}-count`}
            className={`shrink-0 text-xs tabular-nums ${props.counter.over ? 'font-medium text-rose' : 'text-neutral-500'}`}
          >
            {props.counter.note && <span className="mr-2">{props.counter.note}</span>}
            <span aria-hidden="true">{props.counter.text}</span>
            <span className="sr-only">{props.counter.label}</span>
          </span>
        )}
      </div>
      {props.children}
      {props.hint && !props.error && (
        <p id={`${props.id}-hint`} className={ui.hint}>
          {props.hint}
        </p>
      )}
      {props.error && (
        <p id={`${props.id}-error`} className={ui.fieldError}>
          {props.error}
        </p>
      )}
    </div>
  );
}

function Review(props: {
  review: LaunchReview;
  phase: 'review' | 'refreshing' | 'signing' | 'sending';
  message: string | null;
  notice: string | null;
  imageUrl: string | null;
  walletConnected: boolean;
  canChangeFirstBuy: boolean;
  onConnect: () => void;
  onSign: () => void;
  onChangeFirstBuy: (sol: string) => Promise<string | null>;
  onBack: () => void;
}) {
  const { review } = props;
  const { summary } = review;
  const working = props.phase !== 'review';
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <section data-forge="create-coin-review" aria-busy={working || undefined}>
      <h2
        ref={heading}
        tabIndex={-1}
        className="mb-1 text-xl font-bold text-foreground outline-none md:text-2xl"
      >
        {TEXT.review.title}
      </h2>
      <p className="mb-5 text-sm text-neutral-400">{TEXT.review.intro}</p>

      <CoinPreview
        compact
        name={summary.coinName}
        symbol={summary.coinSymbol}
        imageUrl={props.imageUrl}
        className="mb-5"
      />

      <dl className={ui.dl}>
        <Row label={TEXT.review.coin} value={`${summary.coinName} (${summary.coinSymbol})`} />
        <Row
          label={TEXT.review.creationFee(siteConfig.name)}
          value={`${formatSol(summary.poolCreationFeeLamports)} SOL`}
        />
        <Row label={TEXT.review.firstBuy} value={`${formatSol(summary.firstBuyLamports)} SOL`} />
        {summary.firstBuyLamports > BigInt(0) && (
          <Row
            label={TEXT.review.platformFee(PERCENT)}
            value={`${formatSol(summary.platformFeeLamports)} SOL`}
            testId="review-platform-fee"
          />
        )}
        {summary.firstBuyLamports > BigInt(0) && (
          <Row
            label={TEXT.review.receiveAtLeast}
            value={`${formatUnits(summary.firstBuyMinimumTokensOut, DEFAULT_TOKEN_DECIMALS)} ${summary.coinSymbol}`}
          />
        )}
        <Row
          label={TEXT.review.metadataFee}
          value={`${formatSol(summary.metadataFeeLamports)} SOL`}
        />
        <Row
          label={TEXT.review.networkFee}
          value={`${formatSol(summary.estimatedNetworkFeeLamports)} SOL`}
        />
        <Row label={TEXT.review.deposit} value={`${formatSol(summary.accountRentLamports)} SOL`} />
        <div className="flex justify-between gap-4 border-t border-neutral-850 pt-2 text-base font-semibold">
          <dt>{TEXT.review.total}</dt>
          <dd data-testid="review-total" className="tabular-nums">
            {formatSol(summary.totalLamports)} SOL
          </dd>
        </div>
      </dl>

      <div className="mt-4 space-y-1 text-xs text-neutral-500">
        <p className="break-all">
          {TEXT.review.creatorWallet}: {summary.creatorWallet}
        </p>
        <p className="break-all">
          {TEXT.review.mint}: {review.mint}
        </p>
      </div>

      {review.insufficientBalance && review.balanceLamports !== null && (
        <div className="mt-5 space-y-3">
          <p role="alert" className={ui.alert}>
            {TEXT.review.notEnoughSol(
              formatSol(summary.totalLamports),
              formatSol(review.balanceLamports),
            )}
          </p>
          {props.canChangeFirstBuy && summary.firstBuyLamports > BigInt(0) && (
            <FirstBuyEditor review={review} disabled={working} onSubmit={props.onChangeFirstBuy} />
          )}
        </div>
      )}
      {props.notice && (
        <p role="status" className={`${ui.note} mt-4`}>
          {props.notice}
        </p>
      )}
      {props.message && (
        <p role="alert" className={`${ui.alert} mt-4`}>
          {props.message}
        </p>
      )}
      {!props.walletConnected && (
        <p role="status" className={`${ui.note} mt-4`}>
          {TEXT.errors.walletDisconnected}
        </p>
      )}
      {working && (
        <p role="status" className="mt-4 flex items-center gap-3 text-sm text-neutral-300">
          <Spinner />
          {props.phase === 'refreshing'
            ? TEXT.steps.refreshing
            : props.phase === 'signing'
              ? TEXT.review.signing
              : TEXT.review.sending}
        </p>
      )}

      <div className="mt-6 flex flex-col-reverse justify-end gap-3 sm:flex-row">
        <button
          type="button"
          className={ui.secondaryButton}
          onClick={props.onBack}
          disabled={working}
        >
          {TEXT.actions.back}
        </button>
        {props.walletConnected ? (
          <button
            type="button"
            className={ui.primaryButton}
            onClick={props.onSign}
            disabled={working || review.insufficientBalance}
          >
            {TEXT.actions.sign}
          </button>
        ) : (
          <button type="button" className={ui.primaryButton} onClick={props.onConnect}>
            {TEXT.actions.connect}
          </button>
        )}
      </div>
    </section>
  );
}

/** Lower first buy from the review (insufficient balance), with the amount that fits. */
function FirstBuyEditor(props: {
  review: LaunchReview;
  disabled: boolean;
  onSubmit: (sol: string) => Promise<string | null>;
}) {
  const fit = affordableFirstBuyLamports(props.review, PLATFORM_FEE_BPS);
  const [value, setValue] = useState(fit > BigInt(0) ? formatSol(fit) : '0');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(await props.onSubmit(value));
  };
  return (
    <div className={ui.note} data-forge="create-coin-lower-first-buy">
      <p>{TEXT.review.lowerFirstBuy}</p>
      {fit > BigInt(0) && (
        <p className="mt-1 text-neutral-400">{TEXT.review.affordable(formatSol(fit))}</p>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 sm:max-w-[12rem]">
          <label htmlFor="reviewFirstBuy" className={ui.label}>
            {TEXT.review.newFirstBuy}
          </label>
          <input
            id="reviewFirstBuy"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className={`${ui.input} tabular-nums`}
            value={value}
            disabled={props.disabled}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'reviewFirstBuy-error' : undefined}
          />
        </div>
        <button
          type="button"
          className={ui.primaryButton}
          disabled={props.disabled}
          onClick={submit}
        >
          {TEXT.actions.updateFirstBuy}
        </button>
      </div>
      {error && (
        <p id="reviewFirstBuy-error" className={ui.fieldError}>
          {error}
        </p>
      )}
    </div>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-4" data-testid={testId}>
      <dt className={ui.muted}>{label}</dt>
      <dd className="text-right tabular-nums [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}
