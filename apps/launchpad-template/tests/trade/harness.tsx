import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { vi } from 'vitest';

/** Shared mutable fakes used by the vi.mock factories of the trade component tests. */
export const wallet = {
  publicKey: null as PublicKey | null,
  signTransaction: null as null | ((tx: Transaction) => Promise<Transaction>),
  setShowModal: vi.fn(),
};

export const site = { mode: 'live' as 'live' | 'sleeping' | 'disabled' };

export interface FakeConnection {
  getBalance: ReturnType<typeof vi.fn>;
  getAccountInfo: ReturnType<typeof vi.fn>;
  getMinimumBalanceForRentExemption: ReturnType<typeof vi.fn>;
  getLatestBlockhash: ReturnType<typeof vi.fn>;
  simulateTransaction: ReturnType<typeof vi.fn>;
  sendRawTransaction: ReturnType<typeof vi.fn>;
  getSignatureStatuses: ReturnType<typeof vi.fn>;
}

export function createFakeConnection(): FakeConnection {
  return {
    getBalance: vi.fn(async () => 5_000_000_000),
    getAccountInfo: vi.fn(async () => null),
    getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100,
    })),
    simulateTransaction: vi.fn(async () => ({
      context: { slot: 1 },
      value: { err: null, logs: [] },
    })),
    sendRawTransaction: vi.fn(async () => 'SIGNATURE_1'),
    getSignatureStatuses: vi.fn(async () => ({
      context: { slot: 1 },
      value: [{ err: null, confirmationStatus: 'confirmed' }],
    })),
  };
}

export const connectionRef: { current: FakeConnection | null } = { current: null };

export const keys = {
  pool: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  user: Keypair.generate().publicKey,
};

/** A wallet signTransaction that returns an object serialisable like a signed transaction. */
export function okSigner() {
  return vi.fn(async (tx: Transaction) => {
    (tx as unknown as { serialize: () => Uint8Array }).serialize = () => new Uint8Array([1, 2, 3]);
    return tx;
  });
}
