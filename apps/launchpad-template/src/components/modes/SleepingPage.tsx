import Head from 'next/head';
import { content } from '@/content';
import { CoinLink } from '@/forge/CoinLink';

/** Static page shown when the launchpad is sleeping. Loads no data (no RPC, no Jupiter). */
export function SleepingPage() {
  return (
    <>
      <Head>
        <title>{content.name}</title>
      </Head>
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center text-foreground">
        <h1 className="text-3xl font-bold">{content.name}</h1>
        <p className="text-neutral-400">{content.tagline}</p>
        <h2 className="text-xl font-semibold">{content.strings.sleepingTitle}</h2>
        <p className="max-w-md text-neutral-400">{content.strings.sleepingBody}</p>
        <CoinLink className="rounded-full bg-primary px-6 py-3 font-semibold text-primary-950">
          {content.strings.viewOnJupiter}
        </CoinLink>
      </main>
    </>
  );
}

export default SleepingPage;
