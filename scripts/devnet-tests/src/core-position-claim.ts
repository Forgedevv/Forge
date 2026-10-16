/**
 * `pnpm core:position-claim` — devnet proof of the DAMM v2 position fee claim of @forge/core
 * (packages/core/src/position-claims.ts) and of the signer's claims job on a migrated pool, with
 * throwaway wallets only (lib/wallets.ts). Devnet only: refuses to run unless RPC_URL contains
 * "devnet" (lib/env.ts).
 *
 * 1. A DBC config like the launchpad coin config (25% creator share, LP 100% permanently locked
 *    75/25 partner/creator, DAMM v2 FixedBps25) but with a LOW migration threshold
 *    (`THRESHOLD_SOL`, test-only: production is 10 SOL), a pool created by `forgeCreator`, buys
 *    by `trader` up to the threshold, then the scripted migration (lib/migration.ts).
 * 2. Swaps on the DAMM v2 pool: the creator's locked position accrues SOL fees.
 * 3. `findCreatorDammV2Positions` + `buildCreatorPositionFeeClaimTx` (receiver = `multisigStandIn`,
 *    payer = `funder`), signed by `forgeCreator` and `funder`, sent: the stand-in vault must get the
 *    pending fees plus the temporary WSOL rent; the creator wallet balance must not change; the
 *    position must stay permanently locked and held by the creator.
 * 4. More swaps, then the signer's claims job (apps/signer/src/jobs/claims.ts, real job code,
 *    keystore-shaped wrapper): run 1 claims the DBC creator share accrued during the fill, run 2
 *    claims the position fees through the new builder and the position claim policy.
 * Resumable (.state/state.json); writes reports/core-position-claim.md. Spend: about 0.5 SOL.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { ACCOUNT_SIZE, NATIVE_MINT } from '@solana/spl-token';
import { MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  buildCreatorPositionFeeClaimTx,
  findCreatorDammV2Positions,
} from '../../../packages/core/src/index.js';
import { createForgeSignerCore } from '../../../apps/signer/src/core-adapter.js';
import { creatorRole } from '../../../apps/signer/src/keystore.js';
import {
  ClaimJournalEntry,
  createClaimsJob,
  type ClaimOutcome,
} from '../../../apps/signer/src/jobs/claims.js';
import { createFileJournal, rpcFromConnection } from '../../../apps/signer/src/jobs/shared.js';
import { memoryFlags } from '../../../apps/signer/src/jobs/testing.js';
import { ensureFunded, runMain, totalBudgetLamports, type Budget } from './lib/funding.js';
import { STATE_DIR } from './lib/env.js';
import { State } from './lib/state.js';
import { loadOrCreateKeypair, loadWallets } from './lib/wallets.js';
import {
  ata,
  getBalance,
  getConnection,
  getTokenAccountBalance,
  getTxFee,
  sendSigned,
  tryAirdrop,
} from './lib/solana.js';
import {
  buildTestCurve,
  buyPartialFillOnChain,
  createConfigOnChain,
  createPoolOnChain,
  snapshotPool,
  type PoolSnapshot,
} from './lib/dbc.js';
import {
  dammSwap,
  ensureDammV2MigrationMetadata,
  migrateToDammV2,
  positionsOf,
  type DammSwapOutcome,
  type MigrateResult,
  type PositionInfo,
} from './lib/migration.js';
import { solToLamports } from './lib/math.js';
import { consoleAlerter, consoleLogger, walletKeystore } from './lib/signer-harness.js';
import { Report, accountLink, sol, txLink } from './lib/report.js';

const KEY = 'positionClaim';
/** Test-only threshold (production: 10 SOL, D16). The program only requires a threshold > 0. */
const THRESHOLD_SOL = 0.2;
const FEE_BPS = 100;
const CREATOR_PCT = 25;
const WORK_DIR = resolve(STATE_DIR, 'position-claim');
/** Devnet: claim whatever is there. */
const DEVNET_MIN_CLAIM_LAMPORTS = 1_000n;

/** Lamports each wallet should hold (config + pool + migration rent, fill, swaps, receiver rent). */
const BUDGET: Budget = {
  partner: 0.02,
  forgeCreator: 0.2,
  trader: 0.45,
  multisigStandIn: 0.002,
};

type ConfigStep = { config: string; signature: string };
type PoolStep = { pool: string; mint: string; signature: string };
type FillStep = { swaps: Array<{ signature: string; amountIn: string }>; final: PoolSnapshot };
type MigrateStep = MigrateResult & { metadataSignature: string | null };
type SwapsStep = { buy: DammSwapOutcome; sell: DammSwapOutcome; positions: PositionInfo[] };
type CoreClaimStep = {
  signature: string;
  dammPool: string;
  positions: string[];
  claimableQuote: string;
  receiverQuoteLamports: string;
  payerTotalLamports: string;
  creatorBefore: string;
  creatorAfter: string;
  receiverBefore: string;
  receiverAfter: string;
  payerBefore: string;
  payerAfter: string;
  feePaid: string;
  pendingAfter: string;
  lockedBefore: string;
  lockedAfter: string;
  txBytes: number;
};
type SignerRunStep = {
  outcomes: Array<{ kind: string | null; result: string; signature: string | null; lamports: string | null }>;
  alerts: string[];
  receiverBefore: string;
  receiverAfter: string;
};

function outcomeJson(o: ClaimOutcome): SignerRunStep['outcomes'][number] {
  return {
    kind: o.kind ?? null,
    result: o.result,
    signature: 'signature' in o ? o.signature : null,
    lamports: 'lamports' in o ? o.lamports.toString() : null,
  };
}

export async function runCorePositionClaim(): Promise<boolean> {
  console.log('=== @forge/core — DAMM v2 position fee claim (devnet) ===');
  const connection = getConnection(); // refuses non-devnet RPC URLs
  const state = State.load();
  const wallets = loadWallets();

  // Funding: the RPC faucet when it accepts, otherwise the human (exit code 2).
  const need = totalBudgetLamports([BUDGET]) + solToLamports(0.05);
  if ((await getBalance(wallets.funder.publicKey)) < need) {
    await tryAirdrop(wallets.funder.publicKey, solToLamports(1));
  }
  await ensureFunded(wallets, BUDGET);

  // 1. Config (low threshold, test only), pool, fill, migration.
  const configStep = await state.step<ConfigStep>(`${KEY}.config`, async () => {
    const configKeypair = loadOrCreateKeypair('position-claim-config');
    const params = buildTestCurve({
      feeBps: FEE_BPS,
      creatorTradingFeePercentage: CREATOR_PCT,
      poolCreationFeeSol: 0,
      enableFirstSwapWithMinFee: false,
      migrationQuoteThresholdSol: THRESHOLD_SOL,
      partnerPermanentLockedLiquidityPercentage: 75,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 25,
      creatorLiquidityPercentage: 0,
    });
    const signature = await createConfigOnChain({
      payer: wallets.partner,
      configKeypair,
      feeClaimer: wallets.partner.publicKey,
      leftoverReceiver: wallets.partner.publicKey,
      params,
    });
    return { config: configKeypair.publicKey.toBase58(), signature };
  });
  const config = new PublicKey(configStep.config);

  const poolStep = await state.step<PoolStep>(`${KEY}.pool`, async () => {
    const mint = loadOrCreateKeypair('position-claim-mint');
    const { pool, signature } = await createPoolOnChain({
      config,
      payer: wallets.forgeCreator,
      poolCreator: wallets.forgeCreator,
      mint,
      name: 'Forge Position Claim',
      symbol: 'FPC',
      uri: 'https://example.com/forge-position-claim.json',
    });
    return { pool, mint: mint.publicKey.toBase58(), signature };
  });
  const pool = new PublicKey(poolStep.pool);
  const mint = new PublicKey(poolStep.mint);
  const traderBaseAta = ata(wallets.trader.publicKey, mint);

  const fillStep = await state.step<FillStep>(`${KEY}.fill`, async () => {
    const swaps: FillStep['swaps'] = [];
    const threshold = solToLamports(THRESHOLD_SOL);
    for (let i = 0; i < 20; i++) {
      const snap = await snapshotPool(pool);
      if (snap.migrationProgress >= 1 || BigInt(snap.quoteReserve) >= threshold) {
        return { swaps, final: snap };
      }
      const remaining = threshold - BigInt(snap.quoteReserve);
      const gross = (remaining * 10_000n * 105n) / ((10_000n - BigInt(FEE_BPS)) * 100n);
      const amountIn = gross > solToLamports(0.15) ? solToLamports(0.15) : gross;
      const outcome = await buyPartialFillOnChain({
        pool,
        owner: wallets.trader,
        amountIn,
        referralTokenAccount: null,
      });
      swaps.push({ signature: outcome.signature, amountIn: amountIn.toString() });
    }
    return { swaps, final: await snapshotPool(pool) };
  });
  if (fillStep.final.migrationProgress < 1) {
    throw new Error(`Curve not completed (migrationProgress=${fillStep.final.migrationProgress})`);
  }

  const migrateStep = await state.step<MigrateStep>(`${KEY}.migrate`, async () => {
    const metadataSignature = await ensureDammV2MigrationMetadata(pool, wallets.forgeCreator);
    const result = await migrateToDammV2(pool, wallets.forgeCreator, MigrationFeeOption.FixedBps25);
    return { ...result, metadataSignature };
  });
  const dammPool = new PublicKey(migrateStep.dammPool);

  // 2. Swaps on the migrated pool.
  const swapsStep = await state.step<SwapsStep>(`${KEY}.dammSwaps`, async () => {
    const buy = await dammSwap({
      dammPool,
      owner: wallets.trader,
      inputMint: NATIVE_MINT,
      amountIn: solToLamports(0.05),
    });
    const held = await getTokenAccountBalance(traderBaseAta);
    const sell = await dammSwap({ dammPool, owner: wallets.trader, inputMint: mint, amountIn: held / 2n });
    return { buy, sell, positions: await positionsOf(dammPool, wallets.forgeCreator.publicKey) };
  });

  // 3. The core builder: find the creator positions, build, sign (creator + payer), send.
  const found = await findCreatorDammV2Positions(connection, {
    pool,
    creator: wallets.forgeCreator.publicKey,
  });
  if (!found) throw new Error('core does not see the pool as migrated');
  if (!found.dammPool.equals(dammPool)) {
    throw new Error(`core derived ${found.dammPool.toBase58()}, migration created ${dammPool.toBase58()}`);
  }
  console.log(
    `  creator positions: ${found.positions.map((p) => `${p.position.toBase58()} (pending ${p.pendingFees.quote} lamports)`).join(', ') || 'none'}`,
  );
  const receiver = wallets.multisigStandIn.publicKey;
  const coreClaim = await state.step<CoreClaimStep>(`${KEY}.coreClaim`, async () => {
    const creator = wallets.forgeCreator.publicKey;
    const payer = wallets.funder.publicKey;
    const lockedBefore = found.positions[0]?.liquidity.permanentLocked ?? 0n;
    const built = await buildCreatorPositionFeeClaimTx(connection, {
      pool,
      creator,
      receiver,
      payer,
    });
    if (!built.transaction) throw new Error(`nothing to claim: ${built.skipReason}`);
    const [creatorBefore, receiverBefore, payerBefore] = await Promise.all([
      getBalance(creator),
      getBalance(receiver),
      getBalance(payer),
    ]);
    const tx = built.transaction;
    tx.partialSign(wallets.forgeCreator);
    tx.partialSign(wallets.funder);
    const signature = await sendSigned(tx, 'core position claim');
    const after = await findCreatorDammV2Positions(connection, { pool, creator });
    return {
      signature,
      dammPool: built.summary.dammPool.toBase58(),
      positions: built.summary.positions.map((p) => p.position.toBase58()),
      claimableQuote: built.summary.claimable.quote.toString(),
      receiverQuoteLamports: built.summary.receiverQuoteLamports.toString(),
      payerTotalLamports: built.summary.costs.payerTotalLamports.toString(),
      creatorBefore: creatorBefore.toString(),
      creatorAfter: (await getBalance(creator)).toString(),
      receiverBefore: receiverBefore.toString(),
      receiverAfter: (await getBalance(receiver)).toString(),
      payerBefore: payerBefore.toString(),
      payerAfter: (await getBalance(payer)).toString(),
      feePaid: (await getTxFee(signature)).toString(),
      pendingAfter: (after?.claimable.quote ?? 0n).toString(),
      lockedBefore: lockedBefore.toString(),
      lockedAfter: (after?.positions[0]?.liquidity.permanentLocked ?? 0n).toString(),
      txBytes: tx.serialize().length,
    };
  });

  // 4. More swaps, then the signer's claims job: DBC share (run 1), position fees (run 2).
  const moreSwaps = await state.step<SwapsStep>(`${KEY}.moreSwaps`, async () => {
    const buy = await dammSwap({
      dammPool,
      owner: wallets.trader,
      inputMint: NATIVE_MINT,
      amountIn: solToLamports(0.05),
    });
    const held = await getTokenAccountBalance(traderBaseAta);
    const sell = await dammSwap({ dammPool, owner: wallets.trader, inputMint: mint, amountIn: held / 2n });
    return { buy, sell, positions: await positionsOf(dammPool, wallets.forgeCreator.publicKey) };
  });

  const launchpadId = state.get<string>(`${KEY}.launchpadId`) ?? randomUUID();
  state.set(`${KEY}.launchpadId`, launchpadId);
  const keystore = walletKeystore({
    payer: wallets.funder,
    [creatorRole(launchpadId)]: wallets.forgeCreator,
  });
  const creatorRef = (await keystore.findRef(creatorRole(launchpadId)))!;
  const core = createForgeSignerCore({ connection, cashbox: wallets.funder.publicKey, cluster: 'devnet' });
  const signerRun = async (name: string): Promise<SignerRunStep> =>
    state.step<SignerRunStep>(`${KEY}.${name}`, async () => {
      const alerts: string[] = [];
      const receiverBefore = await getBalance(receiver);
      const job = createClaimsJob({
        store: {
          listCreatorLaunchpads: async () => [
            {
              id: launchpadId,
              status: 'live',
              coinConfig: config.toBase58(),
              coinMint: mint.toBase58(),
              creatorWalletRef: creatorRef,
            },
          ],
        },
        core,
        rpc: rpcFromConnection(connection),
        keystore,
        journal: createFileJournal({
          dir: resolve(WORK_DIR, 'journal'),
          namespace: 'claims',
          schema: ClaimJournalEntry,
        }),
        flags: memoryFlags(),
        alerter: consoleAlerter(alerts),
        logger: consoleLogger('claims'),
        config: { vault: receiver, minClaimLamports: DEVNET_MIN_CLAIM_LAMPORTS, feePayer: 'payer' },
        onBeforeSend: () => undefined,
      });
      const report = await job.runOnce();
      for (const o of report.outcomes) {
        console.log(`  ${name}: ${o.kind ?? '-'} ${o.result}${'signature' in o ? ` ${o.signature}` : ''}`);
      }
      return {
        outcomes: report.outcomes.map(outcomeJson),
        alerts,
        receiverBefore: receiverBefore.toString(),
        receiverAfter: (await getBalance(receiver)).toString(),
      };
    });
  const run1 = await signerRun('signerRun1');
  const run2 = await signerRun('signerRun2');
  const run3 = await signerRun('signerRun3');

  // Checks.
  const WSOL_RENT = BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE));
  const receiverDelta = BigInt(coreClaim.receiverAfter) - BigInt(coreClaim.receiverBefore);
  const payerDelta = BigInt(coreClaim.payerBefore) - BigInt(coreClaim.payerAfter);
  const positionClaimed = (run: SignerRunStep) =>
    run.outcomes.find((o) => o.kind === 'position' && o.result === 'claimed');
  const dbcClaimed = (run: SignerRunStep) =>
    run.outcomes.find((o) => o.kind === 'dbc' && o.result === 'claimed');
  const checks: Array<[string, boolean]> = [
    ['core derives the DAMM v2 pool the migration created', coreClaim.dammPool === migrateStep.dammPool],
    ['core finds exactly one creator position, permanently locked', found.positions.length === 1 && BigInt(coreClaim.lockedBefore) > 0n],
    ['the position accrued SOL fees from the swaps', BigInt(coreClaim.claimableQuote) > 0n],
    [
      'the stand-in vault received at least the pending fees plus the temporary WSOL rent',
      receiverDelta >= BigInt(coreClaim.claimableQuote) + WSOL_RENT &&
        receiverDelta >= BigInt(coreClaim.receiverQuoteLamports),
    ],
    ['the creator wallet balance did not change (read-only signer)', coreClaim.creatorBefore === coreClaim.creatorAfter],
    [
      'the payer paid the fee and the rents of the summary (first claim: coin account + WSOL account)',
      payerDelta === BigInt(coreClaim.payerTotalLamports) && BigInt(coreClaim.feePaid) === 10_000n,
    ],
    ['nothing is pending after the claim', BigInt(coreClaim.pendingAfter) === 0n],
    ['the position stays permanently locked with the same liquidity', coreClaim.lockedAfter === coreClaim.lockedBefore],
    ['signer run 1 claims the DBC creator share accrued during the fill', !!dbcClaimed(run1)],
    ['signer run 2 claims the position fees through the position claim policy', !!positionClaimed(run2)],
    [
      'the stand-in vault received the position fees of run 2',
      BigInt(run2.receiverAfter) - BigInt(run2.receiverBefore) >= BigInt(positionClaimed(run2)?.lamports ?? '0') + WSOL_RENT,
    ],
    ['signer run 3 sends nothing (below threshold, journaled)', run3.outcomes.every((o) => o.result !== 'claimed')],
    ['no unexpected alert', [...run1.alerts, ...run2.alerts, ...run3.alerts].every((a) => a === 'pool_graduated')],
  ];
  const ok = checks.every(([, c]) => c);

  const r = new Report('@forge/core — DAMM v2 position fee claim');
  r.p(
    'Goal: after a launchpad coin migrates, the fees of the FORGE creator wallet\'s permanently locked DAMM v2 position are claimed to the multisig (stand-in) by the core builder and by the signer\'s claims job.',
  );
  r.h2('Setup');
  r.bullet(`Config: ${accountLink(configStep.config, configStep.config)} — ${txLink(configStep.signature)}`);
  r.bullet(
    `Trading fee ${FEE_BPS} bps, creatorTradingFeePercentage ${CREATOR_PCT}, LP 100% permanently locked (partner 75% / creator 25%), DAMM v2 FixedBps25; migration threshold **${THRESHOLD_SOL} SOL** (test only; production 10 SOL).`,
  );
  r.bullet(`Pool: ${accountLink(poolStep.pool, poolStep.pool)} — mint ${accountLink(poolStep.mint)} — ${txLink(poolStep.signature)}`);
  r.bullet(
    `Creator (forgeCreator): ${accountLink(wallets.forgeCreator.publicKey)}; payer (funder): ${accountLink(wallets.funder.publicKey)}; receiver (multisigStandIn): ${accountLink(receiver)}; trader: ${accountLink(wallets.trader.publicKey)}`,
  );
  r.h2('Fill and migration');
  r.table(
    ['Fill swap', 'Amount in', 'Tx'],
    fillStep.swaps.map((s, i) => [String(i + 1), sol(BigInt(s.amountIn)), txLink(s.signature)]),
  );
  r.bullet(
    migrateStep.metadataSignature
      ? `migrationDammV2CreateMetadata: ${txLink(migrateStep.metadataSignature)}`
      : 'migration metadata already existed',
  );
  r.bullet(
    `migrateToDammV2: ${txLink(migrateStep.signature)} → DAMM v2 pool ${accountLink(migrateStep.dammPool, migrateStep.dammPool)}`,
  );
  r.h2('Swaps on the migrated pool');
  r.table(
    ['Swap', 'Amount in', 'Quoted fee', 'Tx'],
    [
      ['buy', swapsStep.buy.amountIn, swapsStep.buy.quotedFee, txLink(swapsStep.buy.signature)],
      ['sell', swapsStep.sell.amountIn, swapsStep.sell.quotedFee, txLink(swapsStep.sell.signature)],
    ],
  );
  r.h2('Core builder: buildCreatorPositionFeeClaimTx');
  r.bullet(`Positions: ${coreClaim.positions.map((p) => accountLink(p, p)).join(', ')}`);
  r.bullet(`${txLink(coreClaim.signature)} (${coreClaim.txBytes} bytes), fee ${coreClaim.feePaid} lamports`);
  r.bullet(`Pending SOL fees at build time: ${sol(coreClaim.claimableQuote)}; summary receiverQuoteLamports ${sol(coreClaim.receiverQuoteLamports)}`);
  r.bullet(`Receiver ${coreClaim.receiverBefore} → ${coreClaim.receiverAfter} (Δ ${sol(receiverDelta)}, includes the ${WSOL_RENT} lamports rent of the closed temporary WSOL account)`);
  r.bullet(`Creator ${coreClaim.creatorBefore} → ${coreClaim.creatorAfter}; payer Δ ${sol(payerDelta)} (summary payerTotalLamports ${coreClaim.payerTotalLamports})`);
  r.bullet(`Permanently locked liquidity ${coreClaim.lockedBefore} → ${coreClaim.lockedAfter}; pending after ${coreClaim.pendingAfter}`);
  r.h2('Signer claims job (apps/signer/src/jobs/claims.ts)');
  r.table(
    ['Swap', 'Amount in', 'Quoted fee', 'Tx'],
    [
      ['buy', moreSwaps.buy.amountIn, moreSwaps.buy.quotedFee, txLink(moreSwaps.buy.signature)],
      ['sell', moreSwaps.sell.amountIn, moreSwaps.sell.quotedFee, txLink(moreSwaps.sell.signature)],
    ],
  );
  for (const [name, run] of [
    ['run 1', run1],
    ['run 2', run2],
    ['run 3', run3],
  ] as const) {
    r.bullet(
      `${name}: ${run.outcomes.map((o) => `${o.kind ?? '-'} ${o.result}${o.signature ? ` ${txLink(o.signature)}` : ''}${o.lamports ? ` (${sol(o.lamports)})` : ''}`).join('; ')} — receiver ${run.receiverBefore} → ${run.receiverAfter}; alerts: ${run.alerts.join(', ') || 'none'}`,
    );
  }
  r.h2('Checks');
  for (const [label, c] of checks) r.bullet(`${c ? 'OK' : 'FAIL'} — ${label}`);
  r.blank();
  r.verdict(
    ok,
    ok
      ? 'the creator position fees of a migrated pool reach the vault through the core builder and the signer job.'
      : 'see the failed checks above.',
  );
  r.write('core-position-claim.md');
  state.set(`${KEY}.result`, { ok, checks: checks.map(([label, c]) => ({ label, ok: c })) });
  return ok;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/core-position-claim.ts');
if (isMain) {
  await runMain(async () => {
    if (!(await runCorePositionClaim())) process.exitCode = 1;
  });
}
