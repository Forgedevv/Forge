import Head from 'next/head';
import { lazy, Suspense, useState } from 'react';
import { CoinLink } from '../CoinLink';
import { onchainConfig, siteConfig } from '../config';

/**
 * LOCKED ZONE. Lightweight page shown when the launchpad is sleeping. It imports nothing from the
 * free zones and loads no data (no RPC, no Jupiter, no indexer).
 *
 * The one action left is the creator fee claim (decision D29): a coin creator opens it with a
 * button, which loads `SleepingClaim` (wallet connection + the locked claim widget) in its own
 * chunk. Until then the page is static. Without the on-chain setup no coin exists, so the claim
 * entry is not shown.
 */
export const SLEEPING_TEXT = {
  title: 'This launchpad is sleeping',
  body: 'Trading is paused here. You can still find the coin on Jupiter.',
  viewOnJupiter: 'View the coin on Jupiter',
  claimTitle: 'Created a coin here?',
  claimBody: 'You can still claim the creator fees your coins have earned.',
  openClaim: 'Claim your creator fees',
  loadingClaim: 'Loading...',
} as const;

const SleepingClaim = lazy(() => import('./SleepingClaim'));

export function SleepingPage() {
  const [claimOpen, setClaimOpen] = useState(false);
  return (
    <>
      <Head>
        <title>{siteConfig.name}</title>
      </Head>
      <main
        data-forge-mode-page="sleeping"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 py-10 text-center text-foreground"
      >
        <h1 className="text-3xl font-bold">{siteConfig.name}</h1>
        <p className="text-neutral-400">{siteConfig.content.tagline}</p>
        <h2 className="text-xl font-semibold">{SLEEPING_TEXT.title}</h2>
        <p className="max-w-md text-neutral-400">{SLEEPING_TEXT.body}</p>
        <CoinLink className="rounded-full bg-primary px-6 py-3 font-semibold text-primary-950">
          {SLEEPING_TEXT.viewOnJupiter}
        </CoinLink>
        {onchainConfig && (
          <section
            aria-label="Creator fees"
            data-forge="sleeping-claim-entry"
            className="mt-6 flex w-full flex-col items-center gap-3"
          >
            {claimOpen ? (
              <Suspense
                fallback={
                  <p role="status" className="text-sm text-neutral-400">
                    {SLEEPING_TEXT.loadingClaim}
                  </p>
                }
              >
                <SleepingClaim />
              </Suspense>
            ) : (
              <>
                <h3 className="font-semibold">{SLEEPING_TEXT.claimTitle}</h3>
                <p className="max-w-md text-sm text-neutral-400">{SLEEPING_TEXT.claimBody}</p>
                <button
                  type="button"
                  className="rounded-full border border-neutral-750 px-5 py-2.5 text-sm font-medium"
                  onClick={() => setClaimOpen(true)}
                >
                  {SLEEPING_TEXT.openClaim}
                </button>
              </>
            )}
          </section>
        )}
      </main>
    </>
  );
}

export default SleepingPage;
