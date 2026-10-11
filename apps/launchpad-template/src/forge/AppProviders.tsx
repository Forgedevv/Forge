import { Adapter, UnifiedWalletProvider } from '@jup-ag/wallet-adapter';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from 'next-themes';
import { useMemo, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { siteConfig } from './config';

/**
 * LOCKED ZONE. Providers of the live site (data, wallet, toasts), rendered by `src/pages/_app.tsx`
 * inside the mode gate. The layout and design live in the free-zone `@/components/AppShell`.
 */

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

  const walletTheme = resolvedTheme === 'light' ? 'light' : 'dark';

  return (
    <QueryClientProvider client={queryClient}>
      <UnifiedWalletProvider
        wallets={wallets}
        config={{
          env: 'mainnet-beta',
          autoConnect: true,
          metadata: {
            name: siteConfig.name,
            description: siteConfig.content.tagline,
            url: 'https://jup.ag',
            iconUrls: ['https://jup.ag/favicon.ico'],
          },
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
