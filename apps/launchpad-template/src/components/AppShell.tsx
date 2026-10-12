import type { AppProps } from 'next/app';
import { useWindowWidthListener } from '@/lib/device';
import { ThemeStyle } from '@/theme/ThemeStyle';

/**
 * App shell (FREE ZONE). Global layout and design of the live site: theme variables, anything that
 * wraps every page. Rendered by `src/pages/_app.tsx` only when the site is live, inside the FORGE
 * providers (wallet, data, toasts). The site mode is not decided here: `@/forge/ModeGate` does it.
 */
export function AppShell({ Component, pageProps }: AppProps) {
  useWindowWidthListener();

  return (
    <>
      <ThemeStyle />
      <Component {...pageProps} />
    </>
  );
}

export default AppShell;
