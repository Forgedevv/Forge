import { Adapter, UnifiedWalletProvider } from '@jup-ag/wallet-adapter';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from 'next-themes';
import { useMemo, type ComponentProps, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import type { SiteConfig, SolanaCluster } from '@forge/shared';
import { cluster, siteConfig } from './config';

/**
 * LOCKED ZONE. Providers of the live site (data, wallet, toasts), rendered by `src/pages/_app.tsx`
 * inside the mode gate. The layout and design live in the free-zone `@/components/AppShell`.
 */

type WalletConfig = ComponentProps<typeof UnifiedWalletProvider>['config'];

/** Wallet adapter network of this site: the cluster configured in forge.config.json. */
export function walletEnv(value: SolanaCluster): WalletConfig['env'] {
  return value === 'devnet' ? 'devnet' : 'mainnet-beta';
}

/** The site's own origin in the browser (empty during server rendering, where no wallet runs). */
export function siteOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** What the wallet shows about the app: this site's name, tagline, URL and icon. */
export function walletMetadata(
  site: Pick<SiteConfig, 'name' | 'content'>,
  origin: string,
): WalletConfig['metadata'] {
  return {
    name: site.name,
    description: site.content.tagline,
    url: origin,
    iconUrls: origin ? [`${origin}/favicon.ico`] : [],
  };
}

/** Colour mode provider. The default mode comes from forge.config.json (`theme.darkMode`). */
export function ForgeThemeProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme={siteConfig.theme.darkMode ? 'dark' : 'light'}
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();

  const wallets: Adapter[] = useMemo(() => {
    return [new PhantomWalletAdapter(), new SolflareWalletAdapter()].filter(
      (item) => item && item.name && item.icon,
    ) as Adapter[];
  }, []);

  const queryClient = useMemo(() => new QueryClient(), []);
  const metadata = useMemo(() => walletMetadata(siteConfig, siteOrigin()), []);

  const walletTheme = resolvedTheme === 'light' ? 'light' : 'dark';

  return (
    <QueryClientProvider client={queryClient}>
      <UnifiedWalletProvider
        wallets={wallets}
        config={{
          env: walletEnv(cluster),
          autoConnect: true,
          metadata,
          theme: walletTheme,
          lang: 'en',
        }}
      >
        <Toaster theme={walletTheme} richColors closeButton />
        {children}
      </UnifiedWalletProvider>
    </QueryClientProvider>
  );
}

export default AppProviders;
