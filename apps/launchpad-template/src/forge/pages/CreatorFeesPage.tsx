import Head from 'next/head';
import Link from 'next/link';
import { ClaimCreatorFees } from '../ClaimCreatorFees';
import { siteConfig } from '../config';

/**
 * LOCKED ZONE. The creator fee claim page of every live site, served at `CREATOR_FEES_PATH` by the
 * locked route `src/pages/creator-fees.tsx`. Coin creators connect their wallet and claim the
 * creator share their coins earned on this launchpad (`ClaimCreatorFees`, every chain call through
 * the FORGE RPC relay).
 *
 * It imports nothing from the free zones; it renders inside the live providers and the free-zone
 * app shell like any page, so it follows the site's theme. Free-zone pages may link to it. When
 * the site is sleeping or disabled, the mode gate (`_app`) renders the mode page instead, as for
 * every route: a sleeping site keeps its own claim entry (decision D29).
 */

/** Route of this page; free-zone navigation links here. */
export const CREATOR_FEES_PATH = '/creator-fees';

export const CREATOR_FEES_TEXT = {
  title: 'Creator fees',
  intro: 'Created a coin on this launchpad? Claim the creator fees it earned for you.',
  backHome: 'Back to the launchpad',
} as const;

export function CreatorFeesPage() {
  return (
    <>
      <Head>
        <title>{`${CREATOR_FEES_TEXT.title} - ${siteConfig.name}`}</title>
      </Head>
      <main
        data-forge-page="creator-fees"
        className="flex min-h-screen flex-col items-center gap-6 bg-background px-4 py-10 text-foreground"
      >
        <header className="flex w-full max-w-xl flex-col gap-2">
          <Link href="/" className="w-fit text-sm text-neutral-400 underline">
            {CREATOR_FEES_TEXT.backHome}
          </Link>
          <h1 className="text-2xl font-bold">{CREATOR_FEES_TEXT.title}</h1>
          <p className="text-neutral-400">{CREATOR_FEES_TEXT.intro}</p>
        </header>
        <section aria-label={CREATOR_FEES_TEXT.title} className="w-full max-w-xl">
          <ClaimCreatorFees />
        </section>
      </main>
    </>
  );
}

export default CreatorFeesPage;
