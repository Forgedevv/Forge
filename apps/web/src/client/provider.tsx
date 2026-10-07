'use client';

import { ConnectionProvider, WalletProvider, useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import type { VersionedTransaction } from '@solana/web3.js';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  getServerSessionSnapshot,
  getSessionSnapshot,
  subscribeSession,
} from './session-store';
import { startSupabaseAuth, stopSupabaseAuth } from './supabase';
import { setWalletBridge } from './wallet-bridge';

const RPC_PATH = '/api/rpc';

function Bridge({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signMessage } = useWallet();
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getServerSessionSnapshot,
  );
  const wallet = session?.wallet ?? null;

  useEffect(() => {
    setWalletBridge({
      publicKey,
      connection,
      signMessage,
      signTransaction: signTransaction
        ? <T extends VersionedTransaction>(tx: T) => signTransaction(tx)
        : undefined,
    });
  }, [publicKey, connection, signMessage, signTransaction]);

  // Authenticate the Supabase browser client while a session exists.
  useEffect(() => {
    if (!wallet) {
      stopSupabaseAuth();
      return;
    }
    let cancelled = false;
    startSupabaseAuth().catch(() => {
      if (!cancelled) stopSupabaseAuth();
    });
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  return <>{children}</>;
}

/**
 * Wraps the app: Solana wallet adapter (RPC through the `/api/rpc` relay, standard wallets
 * auto-detected) and the Supabase browser client (token from `/api/auth/supabase-token`).
 */
export function ForgeClientProvider({ children }: { children: ReactNode }) {
  const [endpoint] = useState(() =>
    typeof window === 'undefined' ? `http://localhost${RPC_PATH}` : `${window.location.origin}${RPC_PATH}`,
  );
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <Bridge>{children}</Bridge>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
