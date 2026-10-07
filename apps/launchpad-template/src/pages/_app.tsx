import '@/styles/globals.css';
import '@/theme/theme.css';
import { Adapter, UnifiedWalletProvider } from '@jup-ag/wallet-adapter';
import type { AppProps } from 'next/app';
import { ThemeProvider, useTheme } from 'next-themes';
import { Toaster } from 'sonner';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWindowWidthListener } from '@/lib/device';
import { ThemeStyle } from '@/theme/ThemeStyle';
import { defaultColorMode } from '@/theme';
import { siteConfig } from '@/content';
import { SleepingPage } from '@/components/modes/SleepingPage';
import { DisabledPage } from '@/components/modes/DisabledPage';

function AppProviders({ Component, pageProps }: AppProps) {
  const { resolvedTheme } = useTheme();

  const wallets: Adapter[] = useMemo(() => {
    return [new PhantomWalletAdapter(), new SolflareWalletAdapter()].filter(
      (item) => item && item.name && item.icon
    ) as Adapter[];
  }, []);

  const queryClient = useMemo(() => new QueryClient(), []);

  useWindowWidthListener();

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
          // notificationCallback: WalletNotification,
          theme: walletTheme,
          lang: 'en',
        }}
      >
        <Toaster theme={walletTheme} richColors closeButton />
        <Component {...pageProps} />
      </UnifiedWalletProvider>
    </QueryClientProvider>
  );
}

export default function App(props: AppProps) {
  // sleeping / disabled: static pages only, no wallet, no data providers, no RPC, no Jupiter.
  if (siteConfig.mode !== 'live') {
    return (
      <ThemeProvider attribute="class" defaultTheme={defaultColorMode} disableTransitionOnChange>
        <ThemeStyle />
        {siteConfig.mode === 'sleeping' ? <SleepingPage /> : <DisabledPage />}
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider attribute="class" defaultTheme={defaultColorMode} disableTransitionOnChange>
      <ThemeStyle />
      <AppProviders {...props} />
    </ThemeProvider>
  );
}
