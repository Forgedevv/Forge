import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
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
  getBlockHeight: ReturnType<typeof vi.fn>;
}

/** On-chain account of an initialized SPL mint with these decimals. */
export function mintAccount(decimals: number, owner = SPL_TOKEN_PROGRAM) {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = 1;
  return { data, owner: new PublicKey(owner), lamports: 1_461_600, executable: false };
}

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

/** On-chain account of the coin's DBC pool (what findLaunchpadPool looks for). */
export function poolAccount() {
  return {
    data: new Uint8Array(8),
    owner: new PublicKey(DBC_PROGRAM),
    lamports: 1,
    executable: false,
  };
}

/**
 * Account reads by address: the coin's pool (a DBC account), the coin mint (6 decimals by
 * default), any other account from `others`.
 */
export function accountsByAddress(
  others: (address: string) => unknown = () => null,
  mint: unknown = mintAccount(6),
) {
  return async (address: PublicKey) => {
    const key = address.toBase58();
    if (key === keys.pool || key === keys.ownPool) return poolAccount();
    return key === keys.mint || key === keys.ownMint ? mint : others(key);
  };
}

/** Pools of this launchpad by `mint|config`, for the mocked `launchpadPoolForMint`. */
export function derivedPool(mint: string, config: string | null | undefined): string | null {
  if (mint === keys.mint && config === keys.config) return keys.pool;
  if (mint === keys.ownMint && config === keys.coinConfig) return keys.ownPool;
  return null;
}

export function createFakeConnection(): FakeConnection {
  return {
    getBalance: vi.fn(async () => 5_000_000_000),
    getAccountInfo: vi.fn(accountsByAddress()),
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
    getBlockHeight: vi.fn(async () => 50),
  };
}

export const connectionRef: { current: FakeConnection | null } = { current: null };

export const keys = {
  /** This launchpad's configs (users' coins, then its own coin). */
  config: Keypair.generate().publicKey.toBase58(),
  coinConfig: Keypair.generate().publicKey.toBase58(),
  /** Pool of `mint` on `config` (the derivation is mocked: jsdom breaks PDAs). */
  pool: Keypair.generate().publicKey.toBase58(),
  /** The launchpad's own coin and its pool, on `coinConfig`. */
  ownMint: Keypair.generate().publicKey.toBase58(),
  ownPool: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  user: Keypair.generate().publicKey,
};

/** Fee-payer signature written by `okSigner`, and its base58 form (the trade signature). */
export const SIGNATURE_BYTES = new Uint8Array(64).fill(7);
export const SIGNED_SIGNATURE = bs58.encode(SIGNATURE_BYTES);

/** A wallet signTransaction that returns an object serialisable like a signed transaction. */
export function okSigner() {
  return vi.fn(async (tx: Transaction) => {
    tx.signatures = [
      { publicKey: tx.feePayer as PublicKey, signature: Buffer.from(SIGNATURE_BYTES) },
    ];
    (tx as unknown as { serialize: () => Uint8Array }).serialize = () => new Uint8Array([1, 2, 3]);
    return tx;
  });
}
