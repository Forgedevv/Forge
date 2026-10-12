import type { AppProps } from 'next/app';
import { useWindowWidthListener } from '@/lib/device';
import { ThemeStyle } from '@/theme/ThemeStyle';
import Header from './Header';
import { SiteFooter } from './SiteFooter';

/**
 * Routes whose page lives in the locked zone and renders no site header of its own (the creator
 * fee claim page, `src/forge/pages/CreatorFeesPage.tsx`). The shell frames them with the site
 * header and footer so they look like the rest of the site; the page itself is unchanged.
 */
const FRAMED_LOCKED_ROUTES = new Set(['/creator-fees']);

/**
 * App shell (FREE ZONE). Global layout and design of the live site: theme variables, anything that
 * wraps every page. Rendered by `src/pages/_app.tsx` only when the site is live, inside the FORGE
 * providers (wallet, data, toasts). The site mode is not decided here: `@/forge/ModeGate` does it.
 */
export function AppShell({ Component, pageProps, router }: AppProps) {
  useWindowWidthListener();

  const page = <Component {...pageProps} />;

  return (
    <>
      <ThemeStyle />
      {router && FRAMED_LOCKED_ROUTES.has(router.pathname) ? (
        <div className="launchpad-framed-page flex min-h-screen flex-col bg-background text-foreground">
          <Header />
          <div className="launchpad-framed-body flex-1">{page}</div>
          <SiteFooter />
        </div>
      ) : (
        page
      )}
    </>
  );
}

export default AppShell;
