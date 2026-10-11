import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { describe, expect, it, vi } from 'vitest';
import { ForgeAddressError } from './addresses.js';
import { GatingError, getForgeBalance, passesForgeGate } from './gating.js';

/** The fake devnet $FORGE mint and its holder's ATA: see __fixtures__/dbc-devnet-accounts.json. */
interface FixtureAccount {
  address: string;
  owner: string;
  lamports: number;
  data: string;
}
const FIXTURES = JSON.parse(
  readFileSync(new URL('./__fixtures__/dbc-devnet-accounts.json', import.meta.url), 'utf8'),
) as { accounts: Record<string, FixtureAccount> };
const MINT = FIXTURES.accounts.forgeMint!;
const HOLDER_ATA = FIXTURES.accounts.forgeHolderAta!;
const HOLDER = new PublicKey('EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u');
const env = { FORGE_MINT: MINT.address };
const noRetry = { attempts: 1, baseDelayMs: 0 };

function info(a: FixtureAccount, owner = new PublicKey(a.owner)): AccountInfo<Buffer> {
  return {
    data: Buffer.from(a.data, 'base64'),
    owner,
    lamports: a.lamports,
    executable: false,
    rentEpoch: 0,
  };
}

function mockConnection(accounts: Map<string, AccountInfo<Buffer>>) {
  const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) =>
    keys.map((k) => accounts.get(k.toBase58()) ?? null),
  );
  return {
    connection: { getMultipleAccountsInfo } as unknown as Connection,
    getMultipleAccountsInfo,
  };
}

const classic = () =>
  new Map([
    [MINT.address, info(MINT)],
    [HOLDER_ATA.address, info(HOLDER_ATA)],
  ]);

describe('getForgeBalance', () => {
  it('is disabled without FORGE_MINT, without any RPC call', async () => {
    const { connection, getMultipleAccountsInfo } = mockConnection(new Map());
    expect(await getForgeBalance(connection, HOLDER, { env: {} })).toEqual({ enabled: false });
    expect(await getForgeBalance(connection, HOLDER, { env: { FORGE_MINT: '' } })).toEqual({
      enabled: false,
    });
    expect(getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it('reads the holder ATA balance (fixture: fake devnet $FORGE)', async () => {
    expect(getAssociatedTokenAddressSync(new PublicKey(MINT.address), HOLDER).toBase58()).toBe(
      HOLDER_ATA.address,
    );
    const { connection } = mockConnection(classic());
    const result = await getForgeBalance(connection, HOLDER, { env, retry: noRetry });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.mint.toBase58()).toBe(MINT.address);
    expect(result.tokenAccount.toBase58()).toBe(HOLDER_ATA.address);
    expect(result.tokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(result.decimals).toBe(6);
    expect(result.balance).toBeGreaterThan(0n);
    expect(passesForgeGate(result, result.balance)).toBe(true);
    expect(passesForgeGate(result, result.balance + 1n)).toBe(false);
  });

  it('returns 0 for a wallet without an ATA', async () => {
    const { connection } = mockConnection(classic());
    const result = await getForgeBalance(connection, Keypair.generate().publicKey, {
      env,
      retry: noRetry,
    });
    expect(result.enabled && result.balance).toBe(0n);
  });

  it('ignores an ATA-address account owned by another program', async () => {
    const accounts = classic();
    accounts.set(HOLDER_ATA.address, info(HOLDER_ATA, Keypair.generate().publicKey));
    const result = await getForgeBalance(mockConnection(accounts).connection, HOLDER, {
      env,
      retry: noRetry,
    });
    expect(result.enabled && result.balance).toBe(0n);
  });

  it('supports a Token-2022 mint', async () => {
    const mint = new PublicKey(MINT.address);
    const ata2022 = getAssociatedTokenAddressSync(mint, HOLDER, true, TOKEN_2022_PROGRAM_ID);
    const accounts = new Map([
      [MINT.address, info(MINT, TOKEN_2022_PROGRAM_ID)],
      [ata2022.toBase58(), info(HOLDER_ATA, TOKEN_2022_PROGRAM_ID)],
      // A classic-program account at the classic ATA must not be counted for a 2022 mint.
      [HOLDER_ATA.address, info(HOLDER_ATA)],
    ]);
    const result = await getForgeBalance(mockConnection(accounts).connection, HOLDER, {
      env,
      retry: noRetry,
    });
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(result.tokenAccount.equals(ata2022)).toBe(true);
    expect(result.balance).toBeGreaterThan(0n);
  });

  it('throws when the configured mint does not exist', async () => {
    const err = await getForgeBalance(mockConnection(new Map()).connection, HOLDER, {
      env,
      retry: noRetry,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GatingError);
    expect((err as GatingError).code).toBe('mint_not_found');
  });

  it('throws when FORGE_MINT is not a token mint', async () => {
    const accounts = new Map([[MINT.address, info(MINT, Keypair.generate().publicKey)]]);
    const err = await getForgeBalance(mockConnection(accounts).connection, HOLDER, {
      env,
      retry: noRetry,
    }).catch((e) => e);
    expect((err as GatingError).code).toBe('not_a_mint');
  });

  it('throws on an invalid FORGE_MINT', async () => {
    await expect(
      getForgeBalance(mockConnection(new Map()).connection, HOLDER, {
        env: { FORGE_MINT: 'nope' },
      }),
    ).rejects.toThrow(ForgeAddressError);
  });
});

describe('passesForgeGate', () => {
  it('lets everybody through when gating is disabled', () => {
    expect(passesForgeGate({ enabled: false }, 10n ** 18n)).toBe(true);
  });
});
