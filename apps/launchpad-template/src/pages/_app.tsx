import '@/styles/globals.css';
import '@/theme/theme.css';
import type { AppProps } from 'next/app';
import { AppShell } from '@/components/AppShell';
import { AppProviders, ForgeThemeProvider } from '@/forge/AppProviders';
import { ModeGate } from '@/forge/ModeGate';

/**
 * LOCKED FILE (owned by FORGE, refused by the builder scan). Kept minimal: providers, the mode
 * gate, and the free-zone app shell. The site mode is decided by `@/forge/ModeGate` from
 * forge.config.json; when the site is sleeping or disabled, nothing below the gate is rendered.
 * Global CSS has to be imported here (Next.js); layout and design belong in `@/components/AppShell`.
 */
export default function App(props: AppProps) {
  return (
    <ForgeThemeProvider>
      <ModeGate>
        <AppProviders>
          <AppShell {...props} />
        </AppProviders>
      </ModeGate>
    </ForgeThemeProvider>
  );
}
