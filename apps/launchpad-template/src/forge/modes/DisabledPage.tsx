import Head from 'next/head';
import { siteConfig } from '../config';

/**
 * LOCKED ZONE. Static maintenance page shown when the site is disabled. It imports nothing from the
 * free zones, so no design change can alter what a disabled site serves.
 */
export const DISABLED_TITLE = 'This site is unavailable.';

export function DisabledPage() {
  return (
    <>
      <Head>
        <title>{siteConfig.name}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <main
        data-forge-mode-page="disabled"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center text-foreground"
      >
        <h1 className="text-2xl font-semibold">{DISABLED_TITLE}</h1>
      </main>
    </>
  );
}

export default DisabledPage;
