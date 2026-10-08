import { Keypair, PublicKey } from '@solana/web3.js';
import { buildFixtureTx } from '../create/test-fixtures';
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
      return buildFixtureTx({ payer: new PublicKey(args.creator) });
    },
  };
}

export function mockCoin(overrides: Partial<CreatorCoin> = {}): CreatorCoin {
  return {
    pool: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    name: 'Moon Coin',
    symbol: 'MOON',
    graduated: false,
    claimableQuoteLamports: BigInt(1500000000),
    claimableBaseRaw: BigInt(0),
    baseDecimals: 6,
    ...overrides,
  };
}
