import { Keypair } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { describe, expect, it, vi } from 'vitest';
import {
  MintReadError,
  TOKEN_PROGRAM_IDS,
  parseMintDecimals,
  readMintDecimals,
} from '../../src/forge/trade/useMintDecimals';

function mintData(decimals: number, length = 82): Uint8Array {
  const data = new Uint8Array(length);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

describe('parseMintDecimals: token program owners', () => {
  it('accepts the SPL Token and Token-2022 program ids of the SPL library', () => {
    expect([...TOKEN_PROGRAM_IDS].sort()).toEqual(
      [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].sort(),
    );
    expect(parseMintDecimals({ owner: TOKEN_PROGRAM_ID, data: mintData(6) })).toBe(6);
    // Token-2022 mints may carry extensions after the base layout.
    expect(parseMintDecimals({ owner: TOKEN_2022_PROGRAM_ID, data: mintData(9, 234) })).toBe(9);
  });

  it('refuses any other owner', () => {
    const owner = Keypair.generate().publicKey;
    expect(() => parseMintDecimals({ owner, data: mintData(6) })).toThrow(MintReadError);
    expect(() =>
      parseMintDecimals({
        owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PE5ZG5JSmhMvbW',
        data: mintData(6),
      }),
    ).toThrow(/not a token mint/);
  });

  it('reads a Token-2022 mint through the connection', async () => {
    const connection = {
      getAccountInfo: vi.fn(async () => ({ owner: TOKEN_2022_PROGRAM_ID, data: mintData(6) })),
    };
    await expect(readMintDecimals(connection as never, Keypair.generate().publicKey)).resolves.toBe(
      6,
    );
  });
});
