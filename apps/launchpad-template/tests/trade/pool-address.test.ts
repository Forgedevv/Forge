import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { launchpadPoolForMint } from '../../src/forge/trade/pool-address';
import { dbcPoolAddress } from '../../src/forge/tx/programs';

const config = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();

describe('launchpadPoolForMint', () => {
  it('derives the DBC pool of the mint on this launchpad config', () => {
    const pool = launchpadPoolForMint(mint, config);
    expect(pool).toBe(dbcPoolAddress(config, mint));
    expect(pool).not.toBe(dbcPoolAddress(Keypair.generate().publicKey.toBase58(), mint));
  });

  it('returns null without a launchpad config (before the on-chain setup)', () => {
    expect(launchpadPoolForMint(mint, undefined)).toBeNull();
    expect(launchpadPoolForMint(mint, null)).toBeNull();
  });

  it('returns null for an invalid or non-canonical mint', () => {
    expect(launchpadPoolForMint('not-a-key', config)).toBeNull();
    expect(launchpadPoolForMint('', config)).toBeNull();
    expect(launchpadPoolForMint('11111111111111111111111111111111', config)).toBeNull();
    expect(launchpadPoolForMint(config, config)).toBeNull();
  });
});
