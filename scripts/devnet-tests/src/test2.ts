/**
 * Test 2 — Creator share on a dedicated config (docs/DEVNET_TESTS.md).
 *
 * Confirms that the pool creator earns `creatorTradingFeePercentage` and can claim it to another
 * address, then fills the curve, migrates to DAMM v2 and claims the fees of the creator's locked
 * liquidity after post-migration swaps.
 *
 * Budget note: the production threshold is 10 SOL; to keep the devnet budget small this test uses
 * TEST2_THRESHOLD_SOL (the program only requires a threshold > 0). The mechanism is identical.
 */
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { BUDGETS, ensureFunded, runMain } from './lib/funding.js';
import { State, type Json } from './lib/state.js';
import { loadOrCreateKeypair, loadWallets } from './lib/wallets.js';
import { ata, getBalance, getTokenAccountBalance, getTxFee } from './lib/solana.js';
import {
  buildTestCurve,
  buyPartialFillOnChain,
  claimCreatorFeeToReceiver,
  createConfigOnChain,
  createPoolOnChain,
  decodeEvents,
  pickSwapEvent,
  snapshotPool,
  swapOnChain,
  type PoolSnapshot,
} from './lib/dbc.js';
import {
  claimPositionFee,
  dammSwap,
  ensureDammV2MigrationMetadata,
  migrateToDammV2,
  positionsOf,
  type DammSwapOutcome,
  type MigrateResult,
  type PositionInfo,
} from './lib/migration.js';
import { approxEqual, pct, solToLamports } from './lib/math.js';
import { Report, accountLink, sol, txLink } from './lib/report.js';

export const TEST2_FEE_BPS = 100;
export const TEST2_CREATOR_PCT = 25;
export const TEST2_THRESHOLD_SOL = 1;
export const TEST2_CREATOR_LOCKED_PCT = 50;
export const TEST2_PARTNER_LOCKED_PCT = 50;
/** Rent of a WSOL token account, returned to the receiver when the temporary account is closed. */
const WSOL_ACCOUNT_RENT = 2_039_280n;

type ConfigStep = { config: string; signature: string };
type PoolStep = { pool: string; mint: string; signature: string };
type TradeStep = {
  kind: 'buy' | 'sell';
  amountIn: string;
  signature: string;
  before: PoolSnapshot;
  after: PoolSnapshot;
  event: Record<string, Json> | null;
};
type ClaimStep = {
  signature: string;
  creatorQuoteFeeBefore: string;
  creatorQuoteFeeAfter: string;
  receiverBefore: string;
  receiverAfter: string;
  creatorFeePaid: string;
};
type FillStep = { swaps: Array<{ signature: string; amountIn: string }>; final: PoolSnapshot };
type MigrateStep = MigrateResult & { metadataSignature: string | null };
type DammStep = { buy: DammSwapOutcome; sell: DammSwapOutcome; positionsBefore: PositionInfo[]; positionsAfter: PositionInfo[] };
type PositionClaimStep = {
  signature: string;
  position: string;
  receiverSolBefore: string;
  receiverSolAfter: string;
  receiverBaseBefore: string;
  receiverBaseAfter: string;
  pendingFeeB: string;
};

const TRADES: Array<{ kind: 'buy' | 'sell'; sol?: number; fraction?: number }> = [
  { kind: 'buy', sol: 0.1 },
  { kind: 'buy', sol: 0.15 },
  { kind: 'sell', fraction: 0.5 },
  { kind: 'buy', sol: 0.05 },
];

export async function runTest2(): Promise<boolean> {
  console.log('=== Test 2 — Creator share on a dedicated config ===');
  const state = State.load();
  const wallets = loadWallets();
  await ensureFunded(wallets, BUDGETS.test2);

  // 1. Config: creatorTradingFeePercentage 25, creator liquidity permanently locked.
  const configStep = await state.step<ConfigStep>('test2.config', async () => {
    const configKeypair = loadOrCreateKeypair('test2-config');
    const params = buildTestCurve({
      feeBps: TEST2_FEE_BPS,
      creatorTradingFeePercentage: TEST2_CREATOR_PCT,
      poolCreationFeeSol: 0.001,
      enableFirstSwapWithMinFee: false,
      migrationQuoteThresholdSol: TEST2_THRESHOLD_SOL,
      partnerPermanentLockedLiquidityPercentage: TEST2_PARTNER_LOCKED_PCT,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: TEST2_CREATOR_LOCKED_PCT,
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

  // 2. Pool created with poolCreator = forgeCreator.
  const poolStep = await state.step<PoolStep>('test2.pool', async () => {
    const mint = loadOrCreateKeypair('test2-mint');
    const { pool, signature } = await createPoolOnChain({
      config,
      payer: wallets.forgeCreator,
      poolCreator: wallets.forgeCreator,
      mint,
      name: 'Forge Test Two',
      symbol: 'FT2',
      uri: 'https://example.com/forge-test-2.json',
    });
    return { pool, mint: mint.publicKey.toBase58(), signature };
  });
  const pool = new PublicKey(poolStep.pool);
  const mint = new PublicKey(poolStep.mint);
  const traderBaseAta = ata(wallets.trader.publicKey, mint);

  // 3. Several buys and sells from trader.
  const trades: TradeStep[] = [];
  for (let i = 0; i < TRADES.length; i++) {
    const plan = TRADES[i]!;
    trades.push(
      await state.step<TradeStep>(`test2.trade.${i + 1}`, async () => {
        const before = await snapshotPool(pool);
        let amountIn: bigint;
        if (plan.kind === 'buy') {
          amountIn = solToLamports(plan.sol!);
        } else {
          const held = await getTokenAccountBalance(traderBaseAta);
          amountIn = (held * BigInt(Math.round(plan.fraction! * 1000))) / 1000n;
        }
        const outcome = await swapOnChain({
          pool,
          owner: wallets.trader,
          amountIn,
          swapBaseForQuote: plan.kind === 'sell',
          referralTokenAccount: null,
        });
        const after = await snapshotPool(pool);
        return {
          kind: plan.kind,
          amountIn: amountIn.toString(),
          signature: outcome.signature,
          before,
          after,
          event: pickSwapEvent(await decodeEvents(outcome.signature)),
        };
      }),
    );
  }

  // 4. claimCreatorTradingFeeToReceiver to multisigStandIn.
  const claimStep = await state.step<ClaimStep>('test2.claim', async () => {
    const before = await snapshotPool(pool);
    const receiverBefore = await getBalance(wallets.multisigStandIn.publicKey);
    const signature = await claimCreatorFeeToReceiver({
      pool,
      creator: wallets.forgeCreator,
      receiver: wallets.multisigStandIn.publicKey,
    });
    const after = await snapshotPool(pool);
    const receiverAfter = await getBalance(wallets.multisigStandIn.publicKey);
    return {
      signature,
      creatorQuoteFeeBefore: before.creatorQuoteFee,
      creatorQuoteFeeAfter: after.creatorQuoteFee,
      receiverBefore: receiverBefore.toString(),
      receiverAfter: receiverAfter.toString(),
      creatorFeePaid: (await getTxFee(signature)).toString(),
    };
  });

  // 5a. Fill the curve up to the threshold (partial-fill buys so the last one lands exactly).
  const fillStep = await state.step<FillStep>('test2.fill', async () => {
    const swaps: FillStep['swaps'] = [];
    const threshold = solToLamports(TEST2_THRESHOLD_SOL);
    for (let i = 0; i < 20; i++) {
      const snap = await snapshotPool(pool);
      if (snap.migrationProgress >= 1 || BigInt(snap.quoteReserve) >= threshold) return { swaps, final: snap };
      const remaining = threshold - BigInt(snap.quoteReserve);
      // Fees are taken from the input: gross up by the fee, plus 5% so the partial fill completes the curve.
      const gross = (remaining * 10_000n * 105n) / ((10_000n - BigInt(TEST2_FEE_BPS)) * 100n);
      const amountIn = gross > solToLamports(0.5) ? solToLamports(0.5) : gross;
      const outcome = await buyPartialFillOnChain({ pool, owner: wallets.trader, amountIn, referralTokenAccount: null });
      swaps.push({ signature: outcome.signature, amountIn: amountIn.toString() });
    }
    return { swaps, final: await snapshotPool(pool) };
  });
  if (fillStep.final.migrationProgress < 1) {
    throw new Error(`Curve not completed (migrationProgress=${fillStep.final.migrationProgress}); rerun test:2`);
  }

  // 5b. Migrate (scripted: metadata + migrateToDammV2). No locker: lockedVesting is zero.
  const migrateStep = await state.step<MigrateStep>('test2.migrate', async () => {
    const metadataSignature = await ensureDammV2MigrationMetadata(pool, wallets.forgeCreator);
    const result = await migrateToDammV2(pool, wallets.forgeCreator, MigrationFeeOption.FixedBps25);
    return { ...result, metadataSignature };
  });
  const dammPool = new PublicKey(migrateStep.dammPool);

  // 5c. Swaps on the migrated pool, then the creator's locked position accrues fees.
  const dammStep = await state.step<DammStep>('test2.dammSwaps', async () => {
    const positionsBefore = await positionsOf(dammPool, wallets.forgeCreator.publicKey);
    const buy = await dammSwap({ dammPool, owner: wallets.trader, inputMint: NATIVE_MINT, amountIn: solToLamports(0.05) });
    const held = await getTokenAccountBalance(traderBaseAta);
    const sell = await dammSwap({ dammPool, owner: wallets.trader, inputMint: mint, amountIn: held / 2n });
    const positionsAfter = await positionsOf(dammPool, wallets.forgeCreator.publicKey);
    return { buy, sell, positionsBefore, positionsAfter };
  });

  // 5d. Claim the creator position fees to multisigStandIn.
  const creatorPosition = dammStep.positionsAfter[0];
  const positionClaim = creatorPosition
    ? await state.step<PositionClaimStep>('test2.positionClaim', async () => {
        const receiverBaseAta = ata(wallets.multisigStandIn.publicKey, mint);
        const receiverSolBefore = await getBalance(wallets.multisigStandIn.publicKey);
        const receiverBaseBefore = await getTokenAccountBalance(receiverBaseAta);
        const signature = await claimPositionFee({
          dammPool,
          owner: wallets.forgeCreator,
          position: new PublicKey(creatorPosition.position),
          positionNftAccount: new PublicKey(creatorPosition.positionNftAccount),
          receiver: wallets.multisigStandIn.publicKey,
        });
        return {
          signature,
          position: creatorPosition.position,
          receiverSolBefore: receiverSolBefore.toString(),
          receiverSolAfter: (await getBalance(wallets.multisigStandIn.publicKey)).toString(),
          receiverBaseBefore: receiverBaseBefore.toString(),
          receiverBaseAfter: (await getTokenAccountBalance(receiverBaseAta)).toString(),
          pendingFeeB: creatorPosition.pendingFeeB,
        };
      })
    : null;

  // Measurements.
  const lastTrade = trades[trades.length - 1]!;
  const creatorAccrued = BigInt(lastTrade.after.creatorQuoteFee) - BigInt(trades[0]!.before.creatorQuoteFee);
  const partnerAccrued = BigInt(lastTrade.after.partnerQuoteFee) - BigInt(trades[0]!.before.partnerQuoteFee);
  const nonProtocol = creatorAccrued + partnerAccrued;
  const expectedCreator = (nonProtocol * BigInt(TEST2_CREATOR_PCT)) / 100n;
  const receiverDelta = BigInt(claimStep.receiverAfter) - BigInt(claimStep.receiverBefore);
  const claimed = BigInt(claimStep.creatorQuoteFeeBefore) - BigInt(claimStep.creatorQuoteFeeAfter);
  const positionReceiverDelta = positionClaim ? BigInt(positionClaim.receiverSolAfter) - BigInt(positionClaim.receiverSolBefore) : 0n;
  const checks: Array<[string, boolean]> = [
    [`creator share ≈ ${TEST2_CREATOR_PCT}% of the non-protocol fees before migration`, approxEqual(creatorAccrued, expectedCreator, BigInt(TRADES.length))],
    ['claim empties creatorQuoteFee', BigInt(claimStep.creatorQuoteFeeAfter) === 0n && claimed > 0n],
    ['claimed amount lands on the receiver (+ rent of the temporary WSOL account)', approxEqual(receiverDelta, claimed + WSOL_ACCOUNT_RENT, 10_000n)],
    ['curve completed and migrated to DAMM v2', migrateStep.signature.length > 0 && fillStep.final.migrationProgress >= 1],
    ['creator owns a permanently locked position on the DAMM v2 pool', !!creatorPosition && BigInt(creatorPosition.permanentLockedLiquidity) > 0n],
    ['creator position accrues SOL fees from post-migration swaps', !!creatorPosition && BigInt(creatorPosition.pendingFeeB) > 0n],
    ['position fees claimed to the receiver', !!positionClaim && positionReceiverDelta > 0n],
  ];
  const ok = checks.every(([, c]) => c);

  const r = new Report('Test 2 — Creator share on a dedicated config');
  r.p(
    'Goal: confirm that the creator wallet earns `creatorTradingFeePercentage` and can claim it to another address, ' +
      'and that the creator keeps earning from its permanently locked liquidity after migration.',
  );
  r.h2('Setup');
  r.bullet(`Config: ${accountLink(configStep.config, configStep.config)} — ${txLink(configStep.signature)}`);
  r.bullet(
    `Trading fee ${TEST2_FEE_BPS} bps, creatorTradingFeePercentage ${TEST2_CREATOR_PCT}, partner locked ${TEST2_PARTNER_LOCKED_PCT}% / creator locked ${TEST2_CREATOR_LOCKED_PCT}% of post-migration liquidity, migration DAMM v2 (fixed 25 bps)`,
  );
  r.bullet(
    `Migration threshold: **${TEST2_THRESHOLD_SOL} SOL** instead of the production 10 SOL, to keep the devnet budget small ` +
      '(the SDK and program only require a threshold > 0; mainnet bots require 10 SOL, which is enforced in @forge/core).',
  );
  r.bullet(`Pool: ${accountLink(poolStep.pool, poolStep.pool)} — mint ${accountLink(poolStep.mint)} — ${txLink(poolStep.signature)}`);
  r.bullet(`Pool creator (forgeCreator): ${accountLink(wallets.forgeCreator.publicKey)}; creator recorded in pool state: ${trades[0]!.before.creator}`);
  r.bullet(`Partner / feeClaimer: ${accountLink(wallets.partner.publicKey)}; trader: ${accountLink(wallets.trader.publicKey)}; receiver (multisigStandIn): ${accountLink(wallets.multisigStandIn.publicKey)}`);
  r.h2('Trades before migration');
  r.table(
    ['#', 'Kind', 'Amount in', 'Tx', 'Event tradingFee', 'creatorQuoteFee Δ', 'partnerQuoteFee Δ', 'protocolQuoteFee Δ'],
    trades.map((t, i) => [
      String(i + 1),
      t.kind,
      t.amountIn,
      txLink(t.signature),
      t.event ? String(t.event.tradingFee) : '?',
      (BigInt(t.after.creatorQuoteFee) - BigInt(t.before.creatorQuoteFee)).toString(),
      (BigInt(t.after.partnerQuoteFee) - BigInt(t.before.partnerQuoteFee)).toString(),
      (BigInt(t.after.protocolQuoteFee) - BigInt(t.before.protocolQuoteFee)).toString(),
    ]),
  );
  r.bullet(`Creator accrued ${sol(creatorAccrued)}, partner accrued ${sol(partnerAccrued)} → creator = ${pct(creatorAccrued, nonProtocol)} of the non-protocol share (expected ${TEST2_CREATOR_PCT}%).`);
  r.blank();
  r.h2('Creator claim to receiver');
  r.bullet(`${txLink(claimStep.signature)} — creatorQuoteFee ${claimStep.creatorQuoteFeeBefore} → ${claimStep.creatorQuoteFeeAfter}`);
  r.bullet(`Receiver balance ${claimStep.receiverBefore} → ${claimStep.receiverAfter} (Δ ${sol(receiverDelta)}; includes the ${WSOL_ACCOUNT_RENT} lamports rent of the closed temporary WSOL account)`);
  r.bullet(`Transaction fee paid by the creator wallet: ${claimStep.creatorFeePaid} lamports`);
  r.h2('Curve fill and migration');
  r.table(['Fill swap', 'Amount in', 'Tx'], fillStep.swaps.map((s, i) => [String(i + 1), sol(BigInt(s.amountIn)), txLink(s.signature)]));
  r.bullet(`Final quoteReserve ${sol(BigInt(fillStep.final.quoteReserve))}, migrationProgress ${fillStep.final.migrationProgress}, isMigrated ${fillStep.final.isMigrated}`);
  r.bullet(migrateStep.metadataSignature ? `migrationDammV2CreateMetadata: ${txLink(migrateStep.metadataSignature)}` : 'migration metadata already existed');
  r.bullet(`migrateToDammV2: ${txLink(migrateStep.signature)} → DAMM v2 pool ${accountLink(migrateStep.dammPool, migrateStep.dammPool)} (config ${accountLink(migrateStep.dammConfig)})`);
  r.bullet(`Position NFT mints: ${accountLink(migrateStep.firstPositionNftMint)} / ${accountLink(migrateStep.secondPositionNftMint)}`);
  r.h2('Post-migration swaps and creator position');
  r.table(
    ['Swap', 'Amount in', 'Quoted out', 'Quoted fee', 'Tx', 'Size'],
    [
      ['buy (SOL → token)', dammStep.buy.amountIn, dammStep.buy.quotedOut, dammStep.buy.quotedFee, txLink(dammStep.buy.signature), `${dammStep.buy.txBytes} bytes`],
      ['sell (token → SOL)', dammStep.sell.amountIn, dammStep.sell.quotedOut, dammStep.sell.quotedFee, txLink(dammStep.sell.signature), `${dammStep.sell.txBytes} bytes`],
    ],
  );
  r.table(
    ['Creator position', 'Permanently locked liquidity', 'Pending fee SOL (before swaps)', 'Pending fee SOL (after swaps)', 'Pending fee token (after)'],
    dammStep.positionsAfter.map((p, i) => [
      accountLink(p.position),
      p.permanentLockedLiquidity,
      dammStep.positionsBefore[i]?.pendingFeeB ?? '0',
      p.pendingFeeB,
      p.pendingFeeA,
    ]),
  );
  if (positionClaim) {
    r.bullet(`claimPositionFee to receiver: ${txLink(positionClaim.signature)} — receiver SOL Δ ${sol(positionReceiverDelta)}, receiver token Δ ${BigInt(positionClaim.receiverBaseAfter) - BigInt(positionClaim.receiverBaseBefore)}`);
  } else {
    r.bullet('No creator position found on the DAMM v2 pool: nothing to claim.');
  }
  r.h2('Checks');
  for (const [label, c] of checks) r.bullet(`${c ? 'OK' : 'FAIL'} — ${label}`);
  r.blank();
  r.verdict(
    ok,
    ok
      ? 'the creator share and the post-migration creator liquidity fees work as the revenue model assumes. Plan A holds.'
      : 'see the failed checks above; plan B in SUMMARY.md (swap the roles on the launchpad coin config).',
  );
  r.write('test2-creator-share.md');
  state.set('test2.result', { ok, checks: checks.map(([label, c]) => ({ label, ok: c })) });
  return ok;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/test2.ts');
if (isMain) await runMain(async () => void (await runTest2()));
