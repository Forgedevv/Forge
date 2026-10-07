/**
 * Test 1 — Meteora referral (docs/DEVNET_TESTS.md).
 *
 * Confirms that a swap with `referralTokenAccount` gives 20% of the protocol share to the referral
 * account without touching the partner share.
 */
import { PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, NATIVE_MINT } from '@solana/spl-token';
import { BUDGETS, ensureFunded, runMain } from './lib/funding.js';
import { State, type Json } from './lib/state.js';
import { loadOrCreateKeypair, loadWallets } from './lib/wallets.js';
import { ata, getTokenAccountBalance, sendAndConfirm } from './lib/solana.js';
import {
  buildTestCurve,
  createConfigOnChain,
  createPoolOnChain,
  decodeEvents,
  pickSwapEvent,
  snapshotPool,
  swapOnChain,
  withSwapEvent,
  type PoolSnapshot,
} from './lib/dbc.js';
import { expectedFeeSplit, solToLamports } from './lib/math.js';
import { Report, accountLink, sol, txLink } from './lib/report.js';

export const TEST1_FEE_BPS = 100;
export const TEST1_BUY_LAMPORTS = solToLamports(0.1);

type ConfigStep = { config: string; signature: string; poolCreationFeeSol: number; zeroFeeError: string | null };
type PoolStep = { pool: string; mint: string; signature: string };
type ReferralStep = { owner: string; tokenAccount: string; signature: string };
type BuyStep = {
  signature: string;
  withReferral: boolean;
  before: PoolSnapshot;
  after: PoolSnapshot;
  referralBefore: string;
  referralAfter: string;
  quote: Record<string, string>;
  txBytes: number;
  event: Record<string, Json> | null;
};

const delta = (after: string, before: string): bigint => BigInt(after) - BigInt(before);

export async function runTest1(): Promise<boolean> {
  console.log('=== Test 1 — Meteora referral ===');
  const state = State.load();
  const wallets = loadWallets();
  await ensureFunded(wallets, BUDGETS.test1);

  // 1. Simple config: quote SOL, 1% fee, creatorTradingFeePercentage = 0.
  const configStep = await state.step<ConfigStep>('test1.config', async () => {
    const configKeypair = loadOrCreateKeypair('test1-config');
    const base = {
      feeBps: TEST1_FEE_BPS,
      creatorTradingFeePercentage: 0,
      enableFirstSwapWithMinFee: false,
      migrationQuoteThresholdSol: 10,
      partnerPermanentLockedLiquidityPercentage: 100,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    };
    // INTERFACES.md §1: whether the SDK/program accepts a 0 pool creation fee is to be confirmed here.
    let zeroFeeError: string | null = null;
    try {
      const params = buildTestCurve({ ...base, poolCreationFeeSol: 0 });
      const signature = await createConfigOnChain({
        payer: wallets.partner,
        configKeypair,
        feeClaimer: wallets.partner.publicKey,
        leftoverReceiver: wallets.partner.publicKey,
        params,
      });
      return { config: configKeypair.publicKey.toBase58(), signature, poolCreationFeeSol: 0, zeroFeeError };
    } catch (err) {
      zeroFeeError = err instanceof Error ? err.message : String(err);
      console.log(`  poolCreationFee = 0 rejected: ${zeroFeeError.slice(0, 200)}`);
    }
    const params = buildTestCurve({ ...base, poolCreationFeeSol: 0.001 });
    const signature = await createConfigOnChain({
      payer: wallets.partner,
      configKeypair,
      feeClaimer: wallets.partner.publicKey,
      leftoverReceiver: wallets.partner.publicKey,
      params,
    });
    return { config: configKeypair.publicKey.toBase58(), signature, poolCreationFeeSol: 0.001, zeroFeeError };
  });
  const config = new PublicKey(configStep.config);

  // 2. Pool.
  const poolStep = await state.step<PoolStep>('test1.pool', async () => {
    const mint = loadOrCreateKeypair('test1-mint');
    const { pool, signature } = await createPoolOnChain({
      config,
      payer: wallets.forgeCreator,
      poolCreator: wallets.forgeCreator,
      mint,
      name: 'Forge Test One',
      symbol: 'FT1',
      uri: 'https://example.com/forge-test-1.json',
    });
    return { pool, mint: mint.publicKey.toBase58(), signature };
  });
  const pool = new PublicKey(poolStep.pool);

  // 3. WSOL account of the referral wallet.
  const referralStep = await state.step<ReferralStep>('test1.referralAccount', async () => {
    const tokenAccount = ata(wallets.referral.publicKey, NATIVE_MINT);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        wallets.referral.publicKey,
        tokenAccount,
        wallets.referral.publicKey,
        NATIVE_MINT,
      ),
    );
    const signature = await sendAndConfirm(tx, wallets.referral, { label: 'referral WSOL ATA' });
    return { owner: wallets.referral.publicKey.toBase58(), tokenAccount: tokenAccount.toBase58(), signature };
  });
  const referralTokenAccount = new PublicKey(referralStep.tokenAccount);

  // 4. Buy 0.1 SOL with referral, then the same without referral.
  const buy = async (withReferral: boolean): Promise<BuyStep> => {
    const before = await snapshotPool(pool);
    const referralBefore = await getTokenAccountBalance(referralTokenAccount);
    const outcome = await swapOnChain({
      pool,
      owner: wallets.trader,
      amountIn: TEST1_BUY_LAMPORTS,
      swapBaseForQuote: false,
      referralTokenAccount: withReferral ? referralTokenAccount : null,
    });
    const after = await snapshotPool(pool);
    const referralAfter = await getTokenAccountBalance(referralTokenAccount);
    const event = pickSwapEvent(await decodeEvents(outcome.signature));
    return {
      signature: outcome.signature,
      withReferral,
      before,
      after,
      referralBefore: referralBefore.toString(),
      referralAfter: referralAfter.toString(),
      quote: outcome.quote,
      txBytes: outcome.txBytes,
      event,
    };
  };
  const withRef = await withSwapEvent(state, 'test1.buyWithReferral', await state.step<BuyStep>('test1.buyWithReferral', () => buy(true)));
  const withoutRef = await withSwapEvent(state, 'test1.buyWithoutReferral', await state.step<BuyStep>('test1.buyWithoutReferral', () => buy(false)));

  // 5. Measure.
  const expWith = expectedFeeSplit(TEST1_BUY_LAMPORTS, TEST1_FEE_BPS, 0, true);
  const expWithout = expectedFeeSplit(TEST1_BUY_LAMPORTS, TEST1_FEE_BPS, 0, false);
  const measure = (s: BuyStep) => ({
    referral: delta(s.referralAfter, s.referralBefore),
    partner: delta(s.after.partnerQuoteFee, s.before.partnerQuoteFee),
    protocol: delta(s.after.protocolQuoteFee, s.before.protocolQuoteFee),
    creator: delta(s.after.creatorQuoteFee, s.before.creatorQuoteFee),
    totalTrading: delta(s.after.totalTradingQuoteFee, s.before.totalTradingQuoteFee),
    totalProtocol: delta(s.after.totalProtocolQuoteFee, s.before.totalProtocolQuoteFee),
  });
  const mWith = measure(withRef);
  const mWithout = measure(withoutRef);
  const checks: Array<[string, boolean]> = [
    ['referral receives 20% of the protocol share with referral', mWith.referral === expWith.referral],
    ['referral receives nothing without referral', mWithout.referral === 0n],
    ['partner share identical with and without referral', mWith.partner === mWithout.partner],
    ['partner share = 80% of the fee', mWith.partner === expWith.partner],
    ['protocol share reduced by the referral share', mWith.protocol === expWith.protocol],
    ['protocol share without referral = 20% of the fee', mWithout.protocol === expWithout.protocol],
    ['creator share stays 0', mWith.creator === 0n && mWithout.creator === 0n],
  ];
  const ok = checks.every(([, c]) => c);

  const r = new Report('Test 1 — Meteora referral');
  r.p(
    'Goal: confirm that a swap with `referralTokenAccount` gives 20% of the protocol share (HOST_FEE_PERCENT) ' +
      'to the referral account, without touching the partner share.',
  );
  r.h2('Setup');
  r.bullet(`Config: ${accountLink(configStep.config, configStep.config)} — ${txLink(configStep.signature)}`);
  r.bullet(
    `Trading fee ${TEST1_FEE_BPS} bps, creatorTradingFeePercentage 0, quote SOL, pool creation fee ${configStep.poolCreationFeeSol} SOL`,
  );
  r.bullet(
    configStep.zeroFeeError
      ? `poolCreationFee = 0 was REJECTED (\`${configStep.zeroFeeError.slice(0, 160)}\`); the config uses 0.001 SOL. ` +
          'INTERFACES.md: `poolCreationFeeSol.allowZero` must become false (minimum 0.001 SOL).'
      : 'poolCreationFee = 0 was ACCEPTED by the SDK and the program (INTERFACES.md `allowZero: true` holds).',
  );
  r.bullet(`Pool: ${accountLink(poolStep.pool, poolStep.pool)} — mint ${accountLink(poolStep.mint)} — ${txLink(poolStep.signature)}`);
  r.bullet(`Pool creator (forgeCreator): ${accountLink(wallets.forgeCreator.publicKey)}`);
  r.bullet(`Partner / feeClaimer: ${accountLink(wallets.partner.publicKey)}`);
  r.bullet(
    `Referral WSOL token account: ${accountLink(referralStep.tokenAccount, referralStep.tokenAccount)} (owner ${accountLink(referralStep.owner)}) — ${txLink(referralStep.signature)}`,
  );
  r.bullet(`Trader: ${accountLink(wallets.trader.publicKey)}`);
  r.h2('Swaps');
  r.table(
    ['Swap', 'Amount in', 'Tx', 'Size'],
    [
      ['Buy with referral', sol(TEST1_BUY_LAMPORTS), txLink(withRef.signature), `${withRef.txBytes} bytes`],
      ['Buy without referral', sol(TEST1_BUY_LAMPORTS), txLink(withoutRef.signature), `${withoutRef.txBytes} bytes`],
    ],
  );
  r.h2('Measured fee deltas (lamports)');
  r.table(
    ['Quantity', 'With referral (measured)', 'Expected', 'Without referral (measured)', 'Expected'],
    [
      ['Referral token account', mWith.referral.toString(), expWith.referral.toString(), mWithout.referral.toString(), '0'],
      ['partnerQuoteFee', mWith.partner.toString(), expWith.partner.toString(), mWithout.partner.toString(), expWithout.partner.toString()],
      ['protocolQuoteFee', mWith.protocol.toString(), expWith.protocol.toString(), mWithout.protocol.toString(), expWithout.protocol.toString()],
      ['creatorQuoteFee', mWith.creator.toString(), '0', mWithout.creator.toString(), '0'],
      ['metrics.totalTradingQuoteFee', mWith.totalTrading.toString(), '', mWithout.totalTrading.toString(), ''],
      ['metrics.totalProtocolQuoteFee', mWith.totalProtocol.toString(), '', mWithout.totalProtocol.toString(), ''],
    ],
  );
  r.h2('SDK quote vs on-chain swap event');
  r.table(
    ['Swap', 'Quote tradingFee / protocolFee / referralFee', 'Event tradingFee / protocolFee / referralFee'],
    [withRef, withoutRef].map((s) => [
      s.withReferral ? 'with referral' : 'without referral',
      `${s.quote.tradingFee} / ${s.quote.protocolFee} / ${s.quote.referralFee}`,
      s.event ? `${String(s.event.tradingFee)} / ${String(s.event.protocolFee)} / ${String(s.event.referralFee)}` : 'event not decoded',
    ]),
  );
  r.h2('Checks');
  for (const [label, c] of checks) r.bullet(`${c ? 'OK' : 'FAIL'} — ${label}`);
  r.blank();
  r.verdict(
    ok,
    ok
      ? 'the referral earns 20% of the protocol share and the partner share is unchanged. Plan A holds.'
      : 'the measured split differs from the expectation; see plan B in SUMMARY.md (keep only the 0.3% platform fee).',
  );
  r.write('test1-referral.md');
  state.set('test1.result', { ok, checks: checks.map(([label, c]) => ({ label, ok: c })) });
  return ok;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/test1.ts');
if (isMain) await runMain(async () => void (await runTest1()));
