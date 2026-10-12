import type { ReactNode } from 'react';
import { currentMode } from './mode-guard';
import { DisabledPage } from './modes/DisabledPage';
import { ModeThemeStyle } from './modes/ModeThemeStyle';
import { SleepingPage } from './modes/SleepingPage';

/**
 * LOCKED ZONE. App-level mode gate, rendered by `src/pages/_app.tsx`.
 *
 * The mode is read only from the builder-written forge.config.json, through `./config` (never from
 * the free-zone `@/content`). Anything but `live` renders the static sleeping or disabled page and
 * nothing else: `children` (the free-zone app shell and pages, wallet, data providers, RPC,
 * Jupiter) is never rendered. An unknown mode fails closed to the disabled page.
 */
export function ModeGate({ children }: { children: ReactNode }) {
  const mode: string = currentMode();
  if (mode === 'live') return <>{children}</>;
  return (
    <>
      <ModeThemeStyle />
      {mode === 'sleeping' ? <SleepingPage /> : <DisabledPage />}
    </>
  );
}

export default ModeGate;
