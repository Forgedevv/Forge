import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import type { SiteMode } from '@forge/shared';
import { cluster, forgeConfig, rpcRelayEndpoint } from './config';
import { ModeBanner } from './ModeBanner';
import { capabilitiesFor, currentMode } from './mode-guard';
import { formatSol } from './create/amounts';
import { createRpcChainClient, type ChainClient, type ConfirmOptions } from './create/chain';
import { TxError, messageForUser, waitForSignature, type SignTransaction } from './create/flow';
import { claimsCore, type ClaimsCore, type CreatorCoin } from './claims/core-adapter';
import { CLAIM_TEXT } from './claims/copy';
import {
  executeClaim,
  loadCreatorCoins,
  prepareClaim,
  type ClaimDeps,
  type ClaimReview,
} from './claims/flow';

/**
 * LOCKED ZONE. Creator fee claims for the connected wallet's coins on this launchpad.
 *
 * The connected wallet sees the coins it created and what each has earned for it. A claim goes to
 * the wallet itself (receiver = creator). Sequence: choose a coin -> review (amount, receiver,
 * the core's costs: network fee, one-time coin account rent, temporary WSOL rent) -> sign -> send
 * -> poll for confirmation. The launchpad owner's partner fees are
 * claimed on the FORGE dashboard, not here.
 */

const primaryButtonClassName =
  'inline-flex items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-950 transition-colors hover:bg-primary-300 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButtonClassName =
  'inline-flex items-center justify-center rounded-full border border-neutral-750 px-5 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-50';
const cardClassName = 'rounded-xl border border-neutral-850 bg-neutral-925 p-5 sm:p-8';

export interface ClaimCreatorFeesProps {
  mode?: SiteMode;
  core?: ClaimsCore;
  chain?: ChainClient;
  confirmOptions?: ConfirmOptions;
  /** Configs of this launchpad; useful for composed sites and isolated UI tests. */
  launchpadConfigs?: readonly string[];
}

type ClaimPhase = 'preparing' | 'review' | 'signing' | 'sending' | 'confirming' | 'unconfirmed';

export function ClaimCreatorFees(props: ClaimCreatorFeesProps) {
  const mode = props.mode ?? currentMode();
  if (!capabilitiesFor(mode).claim) {
    return (
      <div data-forge="claim-fees-disabled">
        <ModeBanner mode={mode} />
      </div>
    );
  }
  return <ClaimCreatorFeesList {...props} />;
}

export default ClaimCreatorFees;

function ClaimCreatorFeesList(props: ClaimCreatorFeesProps) {
  const { publicKey, signTransaction } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const wallet = useMemo(() => publicKey?.toBase58(), [publicKey]);

  const core = props.core ?? claimsCore;
  const chain = useMemo(
    () =>
      props.chain ?? (rpcRelayEndpoint ? createRpcChainClient({ url: rpcRelayEndpoint }) : null),
    [props.chain],
  );

  const [coins, setCoins] = useState<CreatorCoin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<{ pool: string; phase: ClaimPhase } | null>(null);
  const [review, setReview] = useState<ClaimReview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [done, setDone] = useState<{ amounts: string[]; signature: string } | null>(null);
  const busy = useRef(false);

  const deps = useCallback((): ClaimDeps | null => {
    if (!wallet || !signTransaction || !chain) return null;
    return {
      core,
      chain,
      wallet,
      launchpadConfigs:
        props.launchpadConfigs ??
        (forgeConfig.onchain ? [forgeConfig.onchain.launchpadConfig] : []),
      signTransaction: signTransaction as SignTransaction,
      confirm: props.confirmOptions,
    };
  }, [core, chain, wallet, signTransaction, props.confirmOptions, props.launchpadConfigs]);

  const load = useCallback(async () => {
    if (!wallet) return;
    setLoadError(null);
    try {
      setCoins(await loadCreatorCoins(core, wallet));
    } catch (error) {
      setCoins(null);
      setLoadError(messageForUser(error, CLAIM_TEXT.loadFailed));
    }
  }, [core, wallet]);

  useEffect(() => {
    setCoins(null);
    setActive(null);
    setReview(null);
    setDone(null);
    void load();
  }, [load]);

  const cancel = () => {
    setActive(null);
    setReview(null);
    setMessage(null);
  };

  const onClaim = async (coin: CreatorCoin) => {
    const d = deps();
    if (busy.current || !d) return;
    busy.current = true;
    setMessage(null);
    setDone(null);
    setSignature(null);
    setActive({ pool: coin.pool, phase: 'preparing' });
    try {
      setReview(await prepareClaim(coin, d));
      setActive({ pool: coin.pool, phase: 'review' });
    } catch (error) {
      setMessage(messageForUser(error, CLAIM_TEXT.prepareFailed));
      setActive(null);
    } finally {
      busy.current = false;
    }
  };

  const onSign = async () => {
    const d = deps();
    if (busy.current || !d || !review) return;
    busy.current = true;
    setMessage(null);
    const pool = review.coin.pool;
    try {
      const sig = await executeClaim(review, d, (phase, sent) => {
        setActive({
          pool,
          phase: phase === 'signing' ? 'signing' : phase === 'sending' ? 'sending' : 'confirming',
        });
        if (sent) setSignature(sent);
      });
      setDone({ amounts: claimedAmounts(review), signature: sig });
      setActive(null);
      setReview(null);
      await load();
    } catch (error) {
      if (error instanceof TxError) {
        setMessage(error.message);
        if (error.signature) setSignature(error.signature);
        if (error.code === 'timeout') setActive({ pool, phase: 'unconfirmed' });
        else if (error.code === 'onchain_failed' || error.code === 'expired')
          cancel2(error.message);
        else setActive({ pool, phase: 'review' });
      } else {
        setMessage(messageForUser(error, CLAIM_TEXT.signFailed));
        setActive({ pool, phase: 'review' });
      }
    } finally {
      busy.current = false;
    }
  };

  // On-chain failure: leave the review, keep the message visible.
  const cancel2 = (text: string) => {
    setActive(null);
    setReview(null);
    setMessage(text);
  };

  const onCheckAgain = async () => {
    const d = deps();
    if (busy.current || !d || !review || !signature) return;
    busy.current = true;
    setMessage(null);
    setActive({ pool: review.coin.pool, phase: 'confirming' });
    try {
      await waitForSignature(signature, d);
      setDone({ amounts: claimedAmounts(review), signature });
      setActive(null);
      setReview(null);
      await load();
    } catch (error) {
      setMessage(messageForUser(error, CLAIM_TEXT.checkFailed));
      if (error instanceof TxError && error.code === 'timeout') {
        setActive({ pool: review.coin.pool, phase: 'unconfirmed' });
      } else {
        setActive(null);
        setReview(null);
      }
    } finally {
      busy.current = false;
    }
  };

  if (!wallet) {
    return (
      <div className={cardClassName} data-forge="claim-fees-connect">
        <p className="mb-4 text-neutral-300">{CLAIM_TEXT.connectIntro}</p>
        <button type="button" className={primaryButtonClassName} onClick={() => setShowModal(true)}>
          {CLAIM_TEXT.connect}
        </button>
      </div>
    );
  }

  if (!chain) {
    return (
      <p role="alert" className="text-sm text-rose">
        {CLAIM_TEXT.notConfigured}
      </p>
    );
  }

  const working = active !== null && active.phase !== 'review' && active.phase !== 'unconfirmed';

  return (
    <div className={`${cardClassName} space-y-6`} data-forge="claim-fees">
      <div>
        <h2 className="text-xl font-bold md:text-2xl">{CLAIM_TEXT.title}</h2>
        <p className="mt-1 text-sm text-neutral-400">{CLAIM_TEXT.intro}</p>
      </div>

      {done && (
        <p role="status" className="rounded-lg border border-emerald/40 bg-emerald/10 p-4 text-sm">
          {CLAIM_TEXT.claimed(done.amounts)}{' '}
          <a
            className="underline"
            href={explorerTxUrl(done.signature)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {CLAIM_TEXT.viewTransaction}
          </a>
        </p>
      )}
      {message && !review && (
        <p
          role="alert"
          className="rounded-lg border border-rose/40 bg-rose/10 p-4 text-sm text-rose"
        >
          {message}
        </p>
      )}

      {loadError && (
        <div role="alert" className="text-sm text-rose">
          <p>{loadError}</p>
          <button
            type="button"
            className={`${secondaryButtonClassName} mt-3`}
            onClick={() => void load()}
          >
            {CLAIM_TEXT.retry}
          </button>
        </div>
      )}
      {!loadError && coins === null && (
        <p role="status" className="text-sm text-neutral-400">
          {CLAIM_TEXT.loading}
        </p>
      )}
      {coins !== null && coins.length === 0 && (
        <p className="text-sm text-neutral-400">{CLAIM_TEXT.empty}</p>
      )}

      {coins !== null && coins.length > 0 && (
        <ul className="divide-y divide-neutral-850">
          {coins.map((coin) => {
            const nothing =
              coin.claimableQuoteLamports <= BigInt(0) && coin.claimableBaseRaw <= BigInt(0);
            return (
              <li
                key={coin.pool}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">
                    {coin.name ?? shorten(coin.mint)}
                    {coin.symbol ? ` (${coin.symbol})` : ''}
                  </p>
                  <p className="text-sm text-neutral-400">
                    {CLAIM_TEXT.claimable(
                      coin.claimableBaseRaw > BigInt(0)
                        ? [
                            solAmount(coin.claimableQuoteLamports),
                            tokenAmount(coin.claimableBaseRaw, coin),
                          ]
                        : [solAmount(coin.claimableQuoteLamports)],
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  className={primaryButtonClassName}
                  disabled={nothing || active !== null}
                  onClick={() => void onClaim(coin)}
                  aria-label={CLAIM_TEXT.claimLabel(coin.name ?? coin.mint)}
                >
                  {active?.pool === coin.pool && active.phase === 'preparing'
                    ? CLAIM_TEXT.preparing
                    : CLAIM_TEXT.claim}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {review && active && (
        <div
          className="rounded-lg border border-neutral-750 p-4"
          data-forge="claim-fees-review"
          aria-label={CLAIM_TEXT.review.label}
        >
          <h3 className="mb-2 font-semibold">{CLAIM_TEXT.review.title}</h3>
          <dl className="space-y-1 text-sm">
            <ReviewRow
              label={CLAIM_TEXT.review.coin}
              value={`${review.coin.name ?? shorten(review.coin.mint)}${review.coin.symbol ? ` (${review.coin.symbol})` : ''}`}
            />
            <ReviewRow
              label={CLAIM_TEXT.review.youReceive}
              value={solAmount(review.claimQuoteLamports)}
            />
            {review.claimBaseRaw > BigInt(0) && (
              <ReviewRow
                label={CLAIM_TEXT.review.and}
                value={tokenAmount(review.claimBaseRaw, review.coin)}
              />
            )}
            <ReviewRow
              label={CLAIM_TEXT.review.networkFee}
              value={solAmount(review.estimatedNetworkFeeLamports)}
            />
            {review.coinAccountRentLamports > BigInt(0) && (
              <ReviewRow
                label={CLAIM_TEXT.review.coinAccountRent}
                value={solAmount(review.coinAccountRentLamports)}
              />
            )}
            <ReviewRow
              label={CLAIM_TEXT.review.totalCost}
              value={solAmount(review.totalCostLamports)}
            />
            {review.temporaryLamports > BigInt(0) && (
              <ReviewRow
                label={CLAIM_TEXT.review.temporaryDeposit}
                value={solAmount(review.temporaryLamports)}
              />
            )}
            <ReviewRow
              label={CLAIM_TEXT.review.needed}
              value={solAmount(review.requiredBalanceLamports)}
            />
          </dl>
          <p className="mt-2 break-all text-xs text-neutral-500">
            {CLAIM_TEXT.review.receiver(review.receiver)}
          </p>
          {review.insufficientBalance && (
            <p role="alert" className="mt-2 text-sm text-rose">
              {CLAIM_TEXT.review.insufficient(solAmount(review.requiredBalanceLamports))}
            </p>
          )}
          {message && (
            <p role="alert" className="mt-2 text-sm text-rose">
              {message}
            </p>
          )}
          {active.phase === 'signing' && (
            <p role="status" className="mt-2 text-sm text-neutral-300">
              {CLAIM_TEXT.review.signing}
            </p>
          )}
          {active.phase === 'sending' && (
            <p role="status" className="mt-2 text-sm text-neutral-300">
              {CLAIM_TEXT.review.sending}
            </p>
          )}
          {active.phase === 'confirming' && (
            <p role="status" className="mt-2 text-sm text-neutral-300">
              {CLAIM_TEXT.review.confirming}
            </p>
          )}
          <div className="mt-4 flex gap-3">
            {active.phase === 'unconfirmed' ? (
              <button
                type="button"
                className={primaryButtonClassName}
                onClick={() => void onCheckAgain()}
              >
                {CLAIM_TEXT.review.checkAgain}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={secondaryButtonClassName}
                  onClick={cancel}
                  disabled={working}
                >
                  {CLAIM_TEXT.review.cancel}
                </button>
                <button
                  type="button"
                  className={primaryButtonClassName}
                  onClick={() => void onSign()}
                  disabled={working || review.insufficientBalance}
                >
                  {CLAIM_TEXT.review.sign}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-400">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function solAmount(lamports: bigint): string {
  return `${formatSol(lamports)} SOL`;
}

function tokenAmount(raw: bigint, coin: CreatorCoin): string {
  return `${formatUnits(raw, coin.baseDecimals)} ${coin.symbol ?? CLAIM_TEXT.tokenUnit}`;
}

/** Every amount a confirmed claim sent to the wallet: its SOL, then the coin's own tokens. */
function claimedAmounts(review: ClaimReview): string[] {
  const amounts: string[] = [];
  if (review.claimQuoteLamports > BigInt(0) || review.claimBaseRaw <= BigInt(0)) {
    amounts.push(solAmount(review.claimQuoteLamports));
  }
  if (review.claimBaseRaw > BigInt(0)) amounts.push(tokenAmount(review.claimBaseRaw, review.coin));
  return amounts;
}

function shorten(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

function formatUnits(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const base = BigInt(10) ** BigInt(decimals);
  const fraction = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${(raw / base).toString()}${fraction ? `.${fraction}` : ''}`;
}

function explorerTxUrl(signature: string): string {
  const suffix = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${suffix}`;
}
