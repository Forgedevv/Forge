import type { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';

/**
 * Non-React functions (payQuote, signOwnerTransaction, ...) need the connected wallet. The
 * ForgeClientProvider keeps this bridge up to date from the wallet adapter hooks.
 */
export interface WalletBridge {
  publicKey: PublicKey | null;
  signTransaction: (<T extends VersionedTransaction>(tx: T) => Promise<T>) | undefined;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
  connection: Connection | null;
}

let bridge: WalletBridge = {
  publicKey: null,
  signTransaction: undefined,
  signMessage: undefined,
  connection: null,
};

export function setWalletBridge(next: WalletBridge): void {
  bridge = next;
}

export function getWalletBridge(): WalletBridge {
  return bridge;
}
