'use client';

import type { ReactNode } from 'react';
import { ForgeClientProvider, realClient } from '@/client';
import { WorkspaceStateProvider } from './provider';
import '@solana/wallet-adapter-react-ui/styles.css';

/** The backend-owned provider handles wallets, the RPC relay and Supabase authentication. */
export function LiveWorkspaceProvider({ children }: { children: ReactNode }) {
  return (
    <ForgeClientProvider>
      <WorkspaceStateProvider client={realClient}>{children}</WorkspaceStateProvider>
    </ForgeClientProvider>
  );
}
