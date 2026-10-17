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

/**
 * Wallet adapter network of this site: the cluster configured in forge.config.json. Anything but
 * an explicit `mainnet-beta` is devnet (PLANEXECUTE rule 4).
 */
export function walletEnv(value: SolanaCluster): WalletConfig['env'] {
  return value === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
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

/** Theme of the wallet modal and toasts, from the colour mode in use. */
function useWalletTheme(): 'light' | 'dark' {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === 'light' ? 'light' : 'dark';
}

/**
 * The wallet provider alone (Phantom, Solflare and wallet-standard wallets, this site's cluster and
 * metadata). The live site renders it inside `AppProviders`; the sleeping page renders it around
 * the creator fee claim widget only (decision D29), without the data providers.
 */
export function ForgeWalletProvider({ children }: { children: ReactNode }) {
  const walletTheme = useWalletTheme();

  const wallets: Adapter[] = useMemo(() => {
    return [new PhantomWalletAdapter(), new SolflareWalletAdapter()].filter(
      (item) => item && item.name && item.icon,
    ) as Adapter[];
  }, []);

  const metadata = useMemo(() => walletMetadata(siteConfig, siteOrigin()), []);

  return (
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
      {children}
    </UnifiedWalletProvider>
  );
}

/**
 * Query retry policy: coin data that is unavailable right now (`DataUnavailableError` of
 * `data/source.ts`, matched by name: the providers load nothing from `data/`) is not retried at
 * once, so the UI shows its unavailable state without waiting; the queries' regular refetch tries
 * again. Any other failure is retried up to 3 times (react-query's default).
 */
export function retryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof Error && error.name === 'DataUnavailableError') return false;
  return failureCount < 3;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const walletTheme = useWalletTheme();
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: retryQuery } } }),
    [],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ForgeWalletProvider>
        <Toaster theme={walletTheme} richColors closeButton />
        {children}
      </ForgeWalletProvider>
    </QueryClientProvider>
  );
}

export default AppProviders;
