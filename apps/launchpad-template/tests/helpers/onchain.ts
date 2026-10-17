import { readFileSync } from 'node:fs';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { vi } from 'vitest';
import {
  PYTH_RECEIVER_PROGRAM_ID,
  PYTH_SOL_USD_ACCOUNT,
  metadataAddress,
} from '../../src/forge/data/onchain/accounts';
import { TOKEN_METADATA_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../src/forge/tx/programs';

/** Real devnet DBC pools and configs (copied from @forge/core's fixtures). */
interface FixtureAccount {
  address: string;
  owner: string;
  lamports: number;
  data: string;
}
const FIXTURES = JSON.parse(
  readFileSync(new URL('../fixtures/dbc-pools.json', import.meta.url), 'utf8'),
) as { accounts: Record<string, FixtureAccount> };

export function fixture(name: string): FixtureAccount {
  const account = FIXTURES.accounts[name];
  if (!account) throw new Error(`fixture ${name} missing`);
  return account;
}

export interface RawFixture {
  owner: string;
  data: Buffer;
}

export function fixtureRaw(name: string): RawFixture {
  const a = fixture(name);
  return { owner: a.owner, data: Buffer.from(a.data, 'base64') };
}

/** Base mint of a fixture pool (offset 136). */
export function poolMint(name: string): string {
  return new PublicKey(fixtureRaw(name).data.subarray(136, 168)).toBase58();
}

/** Config of a fixture pool (offset 72). */
export function poolConfig(name: string): string {
  return new PublicKey(fixtureRaw(name).data.subarray(72, 104)).toBase58();
}

/** An initialized SPL mint account (82 bytes). */
export function mintAccount(supply: bigint, decimals: number): RawFixture {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(supply, 36);
  data[44] = decimals;
  data[45] = 1;
  return { owner: TOKEN_PROGRAM_ID, data };
}

function borsh(value: string, padTo: number): Buffer {
  const bytes = Buffer.alloc(padTo);
  Buffer.from(value, 'utf8').copy(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(padTo);
  return Buffer.concat([length, bytes]);
}

/** A Metaplex `MetadataV1` account (strings null-padded to their limits, like the program). */
export function metadataAccount(
  mint: string,
  meta: { name: string; symbol: string; uri: string },
): RawFixture {
  const data = Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(32, 1),
    Buffer.from(new PublicKey(mint).toBytes()),
    borsh(meta.name, 32),
    borsh(meta.symbol, 10),
    borsh(meta.uri, 200),
    Buffer.alloc(40),
  ]);
  return { owner: TOKEN_METADATA_PROGRAM_ID, data };
}

/** Mainnet Pyth SOL/USD account read on 2026-10-17 (price 104.63693949, 10:27:43 UTC). */
export const PYTH_SOL_USD_DATA =
  'IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bX1Mr28CAAAA1gErAAAAAAD4////n03TagAAAACeTdNqAAAAAEQdXnACAAAALfYvAAAAAAAzk0wbAAAAAAA=';
export const PYTH_SOL_USD_PRICE = 104.63693949;
export const PYTH_PUBLISH_MS = Date.parse('2026-10-17T10:27:43Z');

export function pythAccount(): RawFixture {
  return { owner: PYTH_RECEIVER_PROGRAM_ID, data: Buffer.from(PYTH_SOL_USD_DATA, 'base64') };
}

function info(raw: RawFixture): AccountInfo<Buffer> {
  return {
    data: raw.data,
    owner: new PublicKey(raw.owner),
    lamports: 1_000_000,
    executable: false,
    rentEpoch: 0,
  };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s: string): Buffer {
  let n = BigInt(0);
  for (const c of s) n = n * BigInt(58) + BigInt(B58.indexOf(c));
  const bytes: number[] = [];
  while (n > BigInt(0)) {
    bytes.unshift(Number(n & BigInt(0xff)));
    n >>= BigInt(8);
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

type Filter = { memcmp?: { offset: number; bytes: string } };

/**
 * A Connection serving `accounts` (address -> raw account): account reads, the program scan
 * (memcmp filters applied) and the slot. Every call is a spy.
 */
export function mockChain(accounts: Map<string, RawFixture>) {
  const getAccountInfoAndContext = vi.fn(async (address: PublicKey) => {
    const raw = accounts.get(address.toBase58());
    return { context: { slot: 1 }, value: raw ? info(raw) : null };
  });
  const getAccountInfo = vi.fn(async (address: PublicKey) => {
    const raw = accounts.get(address.toBase58());
    return raw ? info(raw) : null;
  });
  const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) =>
    keys.map((k) => {
      const raw = accounts.get(k.toBase58());
      return raw ? info(raw) : null;
    }),
  );
  const getProgramAccounts = vi.fn(
    async (programId: PublicKey, config?: { filters?: Filter[] }) => {
      const out: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] = [];
      for (const [address, raw] of accounts) {
        if (raw.owner !== programId.toBase58()) continue;
        const ok = (config?.filters ?? []).every((f) => {
          if (!f.memcmp) return true;
          const bytes = base58Decode(f.memcmp.bytes);
          return raw.data.subarray(f.memcmp.offset, f.memcmp.offset + bytes.length).equals(bytes);
        });
        if (ok) out.push({ pubkey: new PublicKey(address), account: info(raw) });
      }
      return out;
    },
  );
  const getSlot = vi.fn(async () => 1_000);
  const connection = {
    commitment: 'confirmed',
    rpcEndpoint: 'http://relay.invalid/api/rpc',
    getAccountInfoAndContext,
    getAccountInfo,
    getMultipleAccountsInfo,
    getProgramAccounts,
    getSlot,
  };
  return {
    connection: connection as unknown as Connection,
    getMultipleAccountsInfo,
    getProgramAccounts,
    getAccountInfoAndContext,
    getSlot,
  };
}

export const STORAGE = 'https://storage.example';

/** The accounts of a fixture coin: its mint (1B coins, 6 decimals) and metadata on STORAGE. */
export function coinAccounts(pool: string, name: string, symbol: string) {
  const mint = poolMint(pool);
  return new Map<string, RawFixture>([
    [fixture(pool).address, fixtureRaw(pool)],
    [mint, mintAccount(BigInt(1_000_000_000) * BigInt(1_000_000), 6)],
    [
      metadataAddress(mint),
      metadataAccount(mint, {
        name,
        symbol,
        uri: `${STORAGE}/launchpads/moon/metadata/${mint}.json`,
      }),
    ],
  ]);
}

export function withPyth(map: Map<string, RawFixture>): Map<string, RawFixture> {
  map.set(PYTH_SOL_USD_ACCOUNT, pythAccount());
  return map;
}
