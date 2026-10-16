/**
 * `pnpm fixtures:cp-amm` — captures, READ-ONLY, the devnet accounts of the test 2 migration for
 * the @forge/core unit tests of the DAMM v2 position fee claim (packages/core/src/position-claims.ts):
 * the migrated DBC pool and its config, the DAMM v2 pool and its config, and the creator's and the
 * partner's locked positions with their position NFT mints and NFT token accounts.
 *
 * Writes packages/core/src/__fixtures__/cp-amm-devnet-accounts.json (same shape as
 * dbc-devnet-accounts.json). No wallet, no transaction. Refuses to run unless RPC_URL contains
 * "devnet" (lib/env.ts); the public devnet endpoint is enough.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, derivePositionNftAccount } from '@meteora-ag/cp-amm-sdk';
import { PACKAGE_DIR } from './lib/env.js';
import { getConnection } from './lib/solana.js';
import { getPoolState } from './lib/dbc.js';
import { runMain } from './lib/funding.js';

/** Test 2 (reports/test2-creator-share.md): migrated DBC pool, its creator and its partner. */
const DBC_POOL = new PublicKey('FFmhczktj2CeAoYrEnndurenYZe4Doc57np85JZDHd43');
const CREATOR = new PublicKey('EARQA94FiunfJeB9ZdQALU2EU4AXLEuwxhMRReZ5Lf2u');
const PARTNER = new PublicKey('Gvit1eRKU5pv2c1p1m1gk1yjk3RWsxsxqYVLs4qCxJNa');

const OUTPUT = resolve(
  PACKAGE_DIR,
  '..',
  '..',
  'packages',
  'core',
  'src',
  '__fixtures__',
  'cp-amm-devnet-accounts.json',
);

interface Captured {
  address: string;
  owner: string;
  lamports: number;
  executable: boolean;
  data: string;
}

function captured(address: PublicKey, info: AccountInfo<Buffer>): Captured {
  return {
    address: address.toBase58(),
    owner: info.owner.toBase58(),
    lamports: info.lamports,
    executable: info.executable,
    data: info.data.toString('base64'),
  };
}

async function main(): Promise<void> {
  const connection = getConnection();
  const { virtualPool, config } = await getPoolState(DBC_POOL);
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) throw new Error(`unsupported migration fee option ${config.migrationFeeOption}`);
  const dammPool = deriveDammV2PoolAddress(
    dammConfig,
    virtualPool.poolState.baseMint,
    config.quoteMint,
  );
  console.log(`DBC pool ${DBC_POOL.toBase58()} -> DAMM v2 pool ${dammPool.toBase58()}`);

  const cpAmm = new CpAmm(connection);
  const creatorPositions = await cpAmm.getUserPositionByPool(dammPool, CREATOR);
  const partnerPositions = await cpAmm.getUserPositionByPool(dammPool, PARTNER);
  if (creatorPositions.length === 0) throw new Error('no creator position on the DAMM v2 pool');
  if (partnerPositions.length === 0) throw new Error('no partner position on the DAMM v2 pool');
  const creatorPosition = creatorPositions[0]!;
  const partnerPosition = partnerPositions[0]!;
  console.log(`creator position ${creatorPosition.position.toBase58()}`);
  console.log(`partner position ${partnerPosition.position.toBase58()}`);

  const names: Array<[string, PublicKey]> = [
    ['dbcPool', DBC_POOL],
    ['dbcConfig', virtualPool.poolState.config],
    ['dammPool', dammPool],
    ['dammConfig', dammConfig],
    ['creatorPosition', creatorPosition.position],
    ['creatorPositionNftMint', creatorPosition.positionState.nftMint],
    ['creatorPositionNftAccount', derivePositionNftAccount(creatorPosition.positionState.nftMint)],
    ['partnerPosition', partnerPosition.position],
    ['partnerPositionNftMint', partnerPosition.positionState.nftMint],
    ['partnerPositionNftAccount', derivePositionNftAccount(partnerPosition.positionState.nftMint)],
  ];
  if (!creatorPosition.positionNftAccount.equals(names[6]![1])) {
    throw new Error('creator position NFT account is not the derived PDA');
  }
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(
    names.map(([, address]) => address),
    'confirmed',
  );
  const accounts: Record<string, Captured> = {};
  names.forEach(([name, address], i) => {
    const info = value[i];
    if (!info) throw new Error(`account ${name} (${address.toBase58()}) not found`);
    accounts[name] = captured(address, info);
    console.log(`  ${name}: ${address.toBase58()} (${info.data.length} bytes)`);
  });
  const out = {
    capturedAt: new Date().toISOString(),
    cluster: 'devnet',
    slot: context.slot,
    source: 'scripts/devnet-tests/src/capture-cp-amm-fixtures.ts (test 2 migration, read-only)',
    wallets: { creator: CREATOR.toBase58(), partner: PARTNER.toBase58() },
    accounts,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`Fixtures written: ${OUTPUT}`);
}

await runMain(main);
