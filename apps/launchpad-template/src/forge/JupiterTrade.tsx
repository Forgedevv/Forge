import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { siteConfig } from './config';
import { JUPITER_REFERRAL_FEE_BPS } from './trade/constants';
import { TRADE_TEXT } from './trade/copy';
import { TradeError } from './trade/errors';
import { isLaunchpadPool, type LaunchpadPool } from './trade/launchpad-pool';
import {
  readTradeEnv,
  resolveJupiterReferral,
  resolveJupiterReferralFee,
} from './trade/trade-config';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PLUGIN_CONTAINER_ID = 'jupiter-plugin';
const PLUGIN_HEIGHT = 568;
const PLUGIN_SCRIPT_ID = 'jupiter-plugin-script';
const PLUGIN_SCRIPT_URL = 'https://plugin.jup.ag/plugin-v1.js';

/** Loads the Jupiter Plugin script once (kept here so no free zone injects external scripts). */
function ensurePluginScript() {
  if (typeof document === 'undefined' || document.getElementById(PLUGIN_SCRIPT_ID)) {
    return;
  }
  const script = document.createElement('script');
  script.id = PLUGIN_SCRIPT_ID;
  script.src = PLUGIN_SCRIPT_URL;
  script.async = true;
  document.head.appendChild(script);
}

export interface JupiterTradeProps {
  /**
   * The coin's pool on this launchpad, as found by `findLaunchpadPool` (it carries the mint). There
   * is no mint prop: a handle that was not issued by `findLaunchpadPool` (a raw mint, a forged
   * object, another launchpad's coin, a look-alike on the launchpad coin config) opens nothing.
   */
  launchpadPool: LaunchpadPool;
}

/**
 * Trading for a graduated coin: the Jupiter Plugin (successor of Jupiter Terminal) in integrated
 * display mode, with the FORGE integrator fee (`referralAccount` + `referralFee`, 50 bps).
 *
 * - Not part of the free-zone API: `TradePanel` (through `CoinTradePanel`) renders it once the
 *   coin's pool on this launchpad graduated, with the pool handle it looked up.
 * - Renders nothing and loads no script when the site is not live.
 * - Refuses (notice, no script) anything but a pool handle issued by `findLaunchpadPool`.
 * - The referral account comes from the environment (never hardcoded). Without a valid one the
 *   plugin is NOT loaded: the platform fee would be lost silently, so the widget fails closed.
 * - The referral fee must be one Jupiter accepts (50 to 255 bps, `resolveJupiterReferralFee`):
 *   Jupiter refuses every swap with any other fee, so the widget fails closed the same way.
 * - Jupiter does not index devnet: this can only be exercised on mainnet.
 *
 * @see https://dev.jup.ag/docs/tool-kits/plugin
 * @see https://github.com/jup-ag/plugin
 */
export function JupiterTrade({ launchpadPool }: JupiterTradeProps) {
  if (siteConfig.mode !== 'live') return null;
  if (!isLaunchpadPool(launchpadPool)) {
    return (
      <p
        role="alert"
        className="text-sm text-[var(--color-text-muted)]"
        data-testid="jupiter-not-on-launchpad"
      >
        {new TradeError('not_on_launchpad').message}
      </p>
    );
  }
  const mint = launchpadPool.mint;
  const referralAccount = resolveJupiterReferral(readTradeEnv().jupiterReferral);
  const referralFee = resolveJupiterReferralFee(JUPITER_REFERRAL_FEE_BPS);
  if (!referralAccount || referralFee === null) {
    return (
      <div
        role="alert"
        className="rounded-[var(--radius)] border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]"
        data-testid="jupiter-not-configured"
      >
        {TRADE_TEXT.jupiter.notConfigured}
      </div>
    );
  }
  return <JupiterPlugin mint={mint} referralAccount={referralAccount} referralFee={referralFee} />;
}

function JupiterPlugin({
  mint,
  referralAccount,
  referralFee,
}: {
  mint: string;
  referralAccount: string;
  referralFee: number;
}) {
  const walletContext = useWallet();
  const { setShowModal } = useUnifiedWalletContext();

  const [isReady, setIsReady] = useState(false);

  // The plugin script is injected on mount, so poll until it is available
  useEffect(() => {
    ensurePluginScript();
    if (typeof window.Jupiter?.init === 'function') {
      setIsReady(true);
      return;
    }

    const intervalId = setInterval(() => {
      if (typeof window.Jupiter?.init === 'function') {
        setIsReady(true);
        clearInterval(intervalId);
      }
    }, 250);

    return () => clearInterval(intervalId);
  }, []);

  // (Re-)initialize the plugin when it is ready or the token changes
  useEffect(() => {
    if (!isReady) {
      return;
    }

    window.Jupiter.init({
      displayMode: 'integrated',
      integratedTargetId: PLUGIN_CONTAINER_ID,
      // A fixed height prevents the token search modal from collapsing the
      // plugin, see https://dev.jup.ag/docs/tool-kits/plugin/faq
      containerStyles: {
        height: `${PLUGIN_HEIGHT}px`,
      },
      formProps: {
        initialInputMint: SOL_MINT,
        initialOutputMint: mint,
        referralAccount,
        referralFee,
      },
      // Reuse the app's wallet connection instead of the plugin's own adapter
      enableWalletPassthrough: true,
      passthroughWalletContextState: walletContext,
      onRequestConnectWallet: () => setShowModal(true),
    });

    return () => {
      window.Jupiter?.close?.();
    };
    // walletContext is synced separately below to avoid re-initializing
  }, [isReady, mint, referralAccount, referralFee, setShowModal]);

  // Keep the plugin's wallet state in sync with the app's wallet
  useEffect(() => {
    if (!isReady || !window.Jupiter?.syncProps) {
      return;
    }
    window.Jupiter.syncProps({
      passthroughWalletContextState: walletContext,
    });
  }, [isReady, walletContext]);

  return (
    <div className="flex h-full w-full flex-col">
      {!isReady ? (
        <div className="flex w-full flex-col items-center justify-start gap-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <span className="mt-4 text-sm text-neutral-500">{TRADE_TEXT.jupiter.loading}</span>
        </div>
      ) : (
        <div
          id={PLUGIN_CONTAINER_ID}
          className="w-full overflow-hidden"
          style={{ height: PLUGIN_HEIGHT }}
        />
      )}
    </div>
  );
}

export default JupiterTrade;
