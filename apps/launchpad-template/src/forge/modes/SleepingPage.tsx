import Head from 'next/head';
import { CoinLink } from '../CoinLink';
import { siteConfig } from '../config';

/**
 * LOCKED ZONE. Static page shown when the launchpad is sleeping. Loads no data (no RPC, no
 * Jupiter) and imports nothing from the free zones.
 */
export const SLEEPING_TEXT = {
  title: 'This launchpad is sleeping',
  body: 'Trading is paused here. You can still find the coin on Jupiter.',
  viewOnJupiter: 'View the coin on Jupiter',
} as const;

export function SleepingPage() {
  return (
    <>
      <Head>
        <title>{siteConfig.name}</title>
      </Head>
      <main
        data-forge-mode-page="sleeping"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center text-foreground"
      >
        <h1 className="text-3xl font-bold">{siteConfig.name}</h1>
        <p className="text-neutral-400">{siteConfig.content.tagline}</p>
        <h2 className="text-xl font-semibold">{SLEEPING_TEXT.title}</h2>
        <p className="max-w-md text-neutral-400">{SLEEPING_TEXT.body}</p>
        <CoinLink className="rounded-full bg-primary px-6 py-3 font-semibold text-primary-950">
          {SLEEPING_TEXT.viewOnJupiter}
        </CoinLink>
      </main>
    </>
  );
}

export default SleepingPage;
