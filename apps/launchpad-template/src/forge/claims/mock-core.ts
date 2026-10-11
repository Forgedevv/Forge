import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { FIXTURE_LAUNCHPAD_CONFIG } from '../create/test-fixtures';
import { DBC_DISCRIMINATORS, DBC_PROGRAM_ID, WSOL_MINT, dbcEventAuthority, dbcPoolAddress, dbcPoolAuthority, dbcVaultAddress } from '../tx/programs';
import type { ClaimsCore, CreatorCoin } from './core-adapter';

/**
 * Mock of the `@forge/core` claim functions, for tests and local previews only.
 * SWITCH TO @forge/core AT MERGE: production code uses `claimsCore` from `core-adapter.ts`.
 */
export function createMockClaimsCore(coins: CreatorCoin[]): ClaimsCore & {
  built: { pool: string; creator: string; receiver: string }[];
} {
  const built: { pool: string; creator: string; receiver: string }[] = [];
  return {
    built,
    async listCreatorCoins() {
      return coins.map((c) => ({ ...c }));
    },
    async buildCreatorClaimTx(args) {
      built.push(args);
      const creator = new PublicKey(args.creator);
      const mint = coins.find((coin) => coin.pool === args.pool)?.mint;
      if (!mint) throw new Error('Unknown fixture coin.');
      const coinKey = new PublicKey(mint);
      const pool = dbcPoolAddress(FIXTURE_LAUNCHPAD_CONFIG.toBase58(), mint);
      const coinAta = getAssociatedTokenAddressSync(coinKey, creator, true, TOKEN_PROGRAM_ID);
      const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, creator, true, TOKEN_PROGRAM_ID);
      const writable = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
      const readonly = (address: string | PublicKey) => ({ pubkey: typeof address === 'string' ? new PublicKey(address) : address, isSigner: false, isWritable: false });
      const data = Buffer.alloc(24);
      Buffer.from(DBC_DISCRIMINATORS.claimCreatorTradingFee).copy(data, 0);
      const instruction = new TransactionInstruction({
        programId: new PublicKey(DBC_PROGRAM_ID),
        keys: [
          readonly(dbcPoolAuthority()), writable(new PublicKey(pool)), writable(coinAta), writable(wsolAta),
          writable(new PublicKey(dbcVaultAddress(pool, mint))), writable(new PublicKey(dbcVaultAddress(pool, WSOL_MINT))),
          readonly(coinKey), readonly(NATIVE_MINT), { pubkey: creator, isSigner: true, isWritable: true },
          readonly(TOKEN_PROGRAM_ID), readonly(TOKEN_PROGRAM_ID), readonly(dbcEventAuthority()), readonly(DBC_PROGRAM_ID),
        ],
        data,
      });
      const message = new TransactionMessage({ payerKey: creator, recentBlockhash: PublicKey.default.toBase58(), instructions: [instruction] }).compileToV0Message();
      return new VersionedTransaction(message);
    },
  };
}

export function mockCoin(overrides: Partial<CreatorCoin> = {}): CreatorCoin {
  const mint = Keypair.generate().publicKey.toBase58();
  return {
    pool: dbcPoolAddress(FIXTURE_LAUNCHPAD_CONFIG.toBase58(), mint),
    mint,
    name: 'Moon Coin',
    symbol: 'MOON',
    graduated: false,
    claimableQuoteLamports: BigInt(1500000000),
    claimableBaseRaw: BigInt(0),
    baseDecimals: 6,
    ...overrides,
  };
}
