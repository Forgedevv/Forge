/**
 * Graduation on devnet, scripted (no Meteora bot on devnet — docs/METEORA.md):
 *   1. `migrationDammV2CreateMetadata` (on-chain instruction not wrapped by SDK 1.5.13: called through
 *      the SDK's anchor program object),
 *   2. `migrateToDammV2` (SDK), which creates the DAMM v2 pool and the two locked positions
 *      (partner and creator) in one transaction.
 * Then swaps and position-fee claims on the DAMM v2 pool through @meteora-ag/cp-amm-sdk.
 */
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  MigrationFeeOption,
  deriveDammV2MigrationMetadataAddress,
  deriveDammV2PoolAddress,
  deriveDbcEventAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, getUnClaimLpFee, type PoolState, type PositionState } from '@meteora-ag/cp-amm-sdk';
import { getConnection, sendAndConfirm } from './solana.js';
import { big, bn, getDbc, getPoolState } from './dbc.js';

let cpAmm: CpAmm | undefined;

export function getCpAmm(): CpAmm {
  if (!cpAmm) cpAmm = new CpAmm(getConnection());
  return cpAmm;
}

export function dammConfigFor(option: MigrationFeeOption): PublicKey {
  const address = DAMM_V2_MIGRATION_FEE_ADDRESS[option];
  if (!address) throw new Error(`No DAMM v2 config for migration fee option ${option}`);
  return address;
}

/** Creates the DAMM v2 migration metadata account if it does not exist yet. Returns the signature or null. */
export async function ensureDammV2MigrationMetadata(pool: PublicKey, payer: Keypair): Promise<string | null> {
  const metadata = deriveDammV2MigrationMetadataAddress(pool);
  const existing = await getConnection().getAccountInfo(metadata);
  if (existing) return null;
  const { virtualPool } = await getPoolState(pool);
  const program = getDbc().migration.getProgram();
  // The IDL carries no address for these accounts, so anchor cannot resolve them: pass all of them.
  const tx = await program.methods
    .migrationDammV2CreateMetadata()
    .accountsStrict({
      virtualPool: pool,
      config: virtualPool.poolState.config,
      migrationMetadata: metadata,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
      eventAuthority: deriveDbcEventAuthority(),
      program: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    })
    .transaction();
  return sendAndConfirm(tx, payer, { label: 'migrationDammV2CreateMetadata' });
}

export type MigrateResult = {
  signature: string;
  dammPool: string;
  dammConfig: string;
  firstPositionNftMint: string;
  secondPositionNftMint: string;
};

export async function migrateToDammV2(pool: PublicKey, payer: Keypair, option: MigrationFeeOption): Promise<MigrateResult> {
  const dammConfig = dammConfigFor(option);
  const { virtualPool } = await getPoolState(pool);
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await getDbc().migration.migrateToDammV2({
    payer: payer.publicKey,
    pool,
    dammConfig,
  });
  const signature = await sendAndConfirm(transaction, payer, {
    signers: [firstPositionNftKeypair, secondPositionNftKeypair],
    label: 'migrateToDammV2',
  });
  const dammPool = deriveDammV2PoolAddress(dammConfig, virtualPool.poolState.baseMint, NATIVE_MINT);
  return {
    signature,
    dammPool: dammPool.toBase58(),
    dammConfig: dammConfig.toBase58(),
    firstPositionNftMint: firstPositionNftKeypair.publicKey.toBase58(),
    secondPositionNftMint: secondPositionNftKeypair.publicKey.toBase58(),
  };
}

function tokenProgramOf(flag: number): PublicKey {
  return flag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export interface DammSwapArgs {
  dammPool: PublicKey;
  owner: Keypair;
  inputMint: PublicKey;
  amountIn: bigint;
  slippageBps?: number;
}

export type DammSwapOutcome = {
  signature: string;
  amountIn: string;
  quotedOut: string;
  quotedFee: string;
  txBytes: number;
};

/** Swap on the migrated DAMM v2 pool (the template will use Jupiter for this; here cp-amm-sdk directly). */
export async function dammSwap(a: DammSwapArgs): Promise<DammSwapOutcome> {
  const amm = getCpAmm();
  const poolState = await amm.fetchPoolState(a.dammPool);
  const conn = getConnection();
  const slot = await conn.getSlot('confirmed');
  const blockTime = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const outputMint = a.inputMint.equals(poolState.tokenAMint) ? poolState.tokenBMint : poolState.tokenAMint;
  const quote = amm.getQuote({
    inAmount: bn(a.amountIn),
    inputTokenMint: a.inputMint,
    slippage: 0,
    poolState,
    currentTime: blockTime,
    currentSlot: slot,
    tokenADecimal: 6,
    tokenBDecimal: 9,
  });
  const slippage = BigInt(a.slippageBps ?? 100);
  const minimumAmountOut = (big(quote.swapOutAmount) * (10_000n - slippage)) / 10_000n;
  const tx = await amm.swap({
    payer: a.owner.publicKey,
    pool: a.dammPool,
    inputTokenMint: a.inputMint,
    outputTokenMint: outputMint,
    amountIn: bn(a.amountIn),
    minimumAmountOut: bn(minimumAmountOut),
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: tokenProgramOf(poolState.tokenAFlag),
    tokenBProgram: tokenProgramOf(poolState.tokenBFlag),
    referralTokenAccount: null,
    poolState,
  });
  const signature = await sendAndConfirm(tx, a.owner, { label: 'damm v2 swap' });
  return {
    signature,
    amountIn: a.amountIn.toString(),
    quotedOut: quote.swapOutAmount.toString(),
    quotedFee: quote.totalFee.toString(),
    txBytes: tx.serialize({ requireAllSignatures: false }).length,
  };
}

export type PositionInfo = {
  position: string;
  positionNftAccount: string;
  unlockedLiquidity: string;
  vestedLiquidity: string;
  permanentLockedLiquidity: string;
  pendingFeeA: string; // base token
  pendingFeeB: string; // SOL (lamports)
};

export async function positionsOf(dammPool: PublicKey, owner: PublicKey): Promise<PositionInfo[]> {
  const amm = getCpAmm();
  const poolState = await amm.fetchPoolState(dammPool);
  const positions = await amm.getUserPositionByPool(dammPool, owner);
  return positions.map((p) => describePosition(poolState, p.position, p.positionNftAccount, p.positionState));
}

function describePosition(
  poolState: PoolState,
  position: PublicKey,
  positionNftAccount: PublicKey,
  state: PositionState,
): PositionInfo {
  const pending = getUnClaimLpFee(poolState, state, new BN(Math.floor(Date.now() / 1000)));
  return {
    position: position.toBase58(),
    positionNftAccount: positionNftAccount.toBase58(),
    unlockedLiquidity: state.unlockedLiquidity.toString(),
    vestedLiquidity: state.vestedLiquidity.toString(),
    permanentLockedLiquidity: state.permanentLockedLiquidity.toString(),
    pendingFeeA: pending.feeTokenA.toString(),
    pendingFeeB: pending.feeTokenB.toString(),
  };
}

export interface ClaimPositionArgs {
  dammPool: PublicKey;
  owner: Keypair;
  position: PublicKey;
  positionNftAccount: PublicKey;
  receiver: PublicKey;
}

/** Claims the trading fees of a (locked) DAMM v2 position to `receiver`; the position owner signs. */
export async function claimPositionFee(a: ClaimPositionArgs): Promise<string> {
  const amm = getCpAmm();
  const poolState = await amm.fetchPoolState(a.dammPool);
  const tx = await amm.claimPositionFee({
    owner: a.owner.publicKey,
    position: a.position,
    pool: a.dammPool,
    positionNftAccount: a.positionNftAccount,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: tokenProgramOf(poolState.tokenAFlag),
    tokenBProgram: tokenProgramOf(poolState.tokenBFlag),
    receiver: a.receiver,
    feePayer: a.owner.publicKey,
    // Required by cp-amm when a receiver is set and one side is SOL: the fees land on the owner's
    // WSOL token account, which is then closed to the receiver (same pattern as the DBC claim).
    tempWSolAccount: a.owner.publicKey,
  });
  return sendAndConfirm(tx, a.owner, { label: 'claimPositionFee' });
}
