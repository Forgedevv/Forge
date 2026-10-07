/**
 * Test 4 — Platform fee in the swap (docs/DEVNET_TESTS.md).
 *
 * A 30 bps SOL transfer to `platformFee` is added to the same transaction as the swap (with
 * referral), on a buy and on a sell. Checks balances and the transaction size.
 */
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, NATIVE_MINT } from '@solana/spl-token';
import { SwapMode, getCurrentPoint } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { BUDGETS, ensureFunded, runMain } from './lib/funding.js';
import { State, type Json } from './lib/state.js';
import { loadOrCreateKeypair, loadWallets } from './lib/wallets.js';
import { ata, getBalance, getConnection, getTokenAccountBalance, getTxFee, sendAndConfirm } from './lib/solana.js';
import {
  bn,
  buildTestCurve,
  createConfigOnChain,
  createPoolOnChain,
  decodeEvents,
  getDbc,
  getPoolState,
  pickSwapEvent,
  swapOnChain,
  withSwapEvent,
} from './lib/dbc.js';
import { platformFeeLamports, solToLamports } from './lib/math.js';
import { Report, accountLink, txLink } from './lib/report.js';

export const TEST4_FEE_BPS = 100;
export const PLATFORM_FEE_BPS = 30;
export const TEST4_BUY = solToLamports(0.1);
export const MAX_TX_BYTES = 1232;

type ConfigStep = { config: string; signature: string };
type PoolStep = { pool: string; mint: string; signature: string };
type ReferralStep = { tokenAccount: string; signature: string | null };
type SwapStep = {
  kind: 'buy' | 'sell';
  amountIn: string;
  platformFee: string;
  signature: string;
  txBytes: number;
  txFee: string;
  platformBefore: string;
  platformAfter: string;
  traderBefore: string;
  traderAfter: string;
  referralBefore: string;
  referralAfter: string;
  quotedOut: string;
  event: Record<string, Json> | null;
};

export async function runTest4(): Promise<boolean> {
  console.log('=== Test 4 — Platform fee in the swap ===');
  const state = State.load();
  const wallets = loadWallets();
  await ensureFunded(wallets, BUDGETS.test4);

  const configStep = await state.step<ConfigStep>('test4.config', async () => {
    const configKeypair = loadOrCreateKeypair('test4-config');
    const params = buildTestCurve({
      feeBps: TEST4_FEE_BPS,
      creatorTradingFeePercentage: 0,
      poolCreationFeeSol: 0.001,
      enableFirstSwapWithMinFee: false,
      migrationQuoteThresholdSol: 10,
      partnerPermanentLockedLiquidityPercentage: 100,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
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

  const poolStep = await state.step<PoolStep>('test4.pool', async () => {
    const mint = loadOrCreateKeypair('test4-mint');
    const { pool, signature } = await createPoolOnChain({
      config,
      payer: wallets.forgeCreator,
      poolCreator: wallets.forgeCreator,
      mint,
      name: 'Forge Test Four',
      symbol: 'FT4',
      uri: 'https://example.com/forge-test-4.json',
    });
    return { pool, mint: mint.publicKey.toBase58(), signature };
  });
  const pool = new PublicKey(poolStep.pool);
  const mint = new PublicKey(poolStep.mint);

  const referralStep = await state.step<ReferralStep>('test4.referralAccount', async () => {
    const tokenAccount = ata(wallets.referral.publicKey, NATIVE_MINT);
    if (await getConnection().getAccountInfo(tokenAccount)) return { tokenAccount: tokenAccount.toBase58(), signature: null };
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(wallets.referral.publicKey, tokenAccount, wallets.referral.publicKey, NATIVE_MINT),
    );
    const signature = await sendAndConfirm(tx, wallets.referral, { label: 'referral WSOL ATA' });
    return { tokenAccount: tokenAccount.toBase58(), signature };
  });
  const referralTokenAccount = new PublicKey(referralStep.tokenAccount);

  const platformTransfer = (lamports: bigint) =>
    SystemProgram.transfer({ fromPubkey: wallets.trader.publicKey, toPubkey: wallets.platformFee.publicKey, lamports });

  const measure = async (kind: 'buy' | 'sell', amountIn: bigint, platformFee: bigint, quotedOut: string): Promise<SwapStep> => {
    const platformBefore = await getBalance(wallets.platformFee.publicKey);
    const traderBefore = await getBalance(wallets.trader.publicKey);
    const referralBefore = await getTokenAccountBalance(referralTokenAccount);
    const outcome = await swapOnChain({
      pool,
      owner: wallets.trader,
      amountIn,
      swapBaseForQuote: kind === 'sell',
      referralTokenAccount,
      preInstructions: [platformTransfer(platformFee)],
    });
    return {
      kind,
      amountIn: amountIn.toString(),
      platformFee: platformFee.toString(),
      signature: outcome.signature,
      txBytes: outcome.txBytes,
      txFee: (await getTxFee(outcome.signature)).toString(),
      platformBefore: platformBefore.toString(),
      platformAfter: (await getBalance(wallets.platformFee.publicKey)).toString(),
      traderBefore: traderBefore.toString(),
      traderAfter: (await getBalance(wallets.trader.publicKey)).toString(),
      referralBefore: referralBefore.toString(),
      referralAfter: (await getTokenAccountBalance(referralTokenAccount)).toString(),
      quotedOut,
      event: pickSwapEvent(await decodeEvents(outcome.signature)),
    };
  };

  // 1-2. Buy: platform fee = 30 bps of the SOL spent.
  const buy = await withSwapEvent(
    state,
    'test4.buy',
    await state.step<SwapStep>('test4.buy', async () => measure('buy', TEST4_BUY, platformFeeLamports(TEST4_BUY, PLATFORM_FEE_BPS), '')),
  );

  // Sell everything bought: platform fee = 30 bps of the expected SOL out (from the quote).
  const sellStep = await state.step<SwapStep>('test4.sell', async () => {
    const held = await getTokenAccountBalance(ata(wallets.trader.publicKey, mint));
    const { virtualPool, config: poolConfig } = await getPoolState(pool);
    const currentPoint = await getCurrentPoint(getConnection(), poolConfig.activationType);
    const quote = getDbc().pool.swapQuote2({
      virtualPool,
      config: poolConfig,
      swapBaseForQuote: true,
      hasReferral: true,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint,
      slippageBps: 100,
      swapMode: SwapMode.ExactIn,
      amountIn: bn(held),
    });
    const expectedSolOut = BigInt(quote.outputAmount.toString());
    return measure('sell', held, platformFeeLamports(expectedSolOut, PLATFORM_FEE_BPS), expectedSolOut.toString());
  });
  const sell = await withSwapEvent(state, 'test4.sell', sellStep);

  const platformDelta = (s: SwapStep) => BigInt(s.platformAfter) - BigInt(s.platformBefore);
  const referralDelta = (s: SwapStep) => BigInt(s.referralAfter) - BigInt(s.referralBefore);
  const traderDelta = (s: SwapStep) => BigInt(s.traderAfter) - BigInt(s.traderBefore);
  const sellOut = sell.event ? BigInt(String(sell.event.outputAmount)) : 0n;
  const checks: Array<[string, boolean]> = [
    ['buy: platform fee received in the swap transaction', platformDelta(buy) === BigInt(buy.platformFee)],
    ['buy: referral still credited', referralDelta(buy) > 0n],
    ['buy: transaction within the size limit', buy.txBytes <= MAX_TX_BYTES],
    ['sell: platform fee received in the swap transaction', platformDelta(sell) === BigInt(sell.platformFee)],
    ['sell: referral still credited', referralDelta(sell) > 0n],
    ['sell: transaction within the size limit', sell.txBytes <= MAX_TX_BYTES],
    ['sell: trader received the SOL of the sale minus platform fee and tx fee', traderDelta(sell) === sellOut - BigInt(sell.platformFee) - BigInt(sell.txFee)],
  ];
  const ok = checks.every(([, c]) => c);

  const r = new Report('Test 4 — Platform fee in the swap');
  r.p(`Goal: confirm that a ${PLATFORM_FEE_BPS} bps SOL transfer can be added in the same transaction as the swap (with referral), on both buy and sell, within the Solana transaction size limit.`);
  r.h2('Setup');
  r.bullet(`Config: ${accountLink(configStep.config, configStep.config)} — ${txLink(configStep.signature)} (trading fee ${TEST4_FEE_BPS} bps, no creator share)`);
  r.bullet(`Pool: ${accountLink(poolStep.pool, poolStep.pool)} — mint ${accountLink(poolStep.mint)} — ${txLink(poolStep.signature)}`);
  r.bullet(`Referral WSOL token account: ${accountLink(referralStep.tokenAccount, referralStep.tokenAccount)}${referralStep.signature ? ` — ${txLink(referralStep.signature)}` : ' (already existed)'}`);
  r.bullet(`Platform fee wallet: ${accountLink(wallets.platformFee.publicKey)}; trader: ${accountLink(wallets.trader.publicKey)}`);
  r.h2('Swaps');
  r.table(
    ['Swap', 'Amount in', 'Platform fee (30 bps)', 'Platform wallet Δ', 'Referral Δ', 'Trader SOL Δ', 'Tx fee', 'Size', 'Tx'],
    [buy, sell].map((s) => [
      s.kind,
      s.amountIn,
      s.platformFee,
      platformDelta(s).toString(),
      referralDelta(s).toString(),
      traderDelta(s).toString(),
      s.txFee,
      `${s.txBytes} bytes`,
      txLink(s.signature),
    ]),
  );
  r.bullet(`Sell: SDK quoted ${sell.quotedOut} lamports out (platform fee computed on the quote), on-chain outputAmount ${sellOut}.`);
  r.bullet('Instruction layout: [SystemProgram.transfer to platform fee wallet] + SDK swap instructions (ATA creation, wrap SOL, swap, unwrap).');
  r.blank();
  r.h2('Checks');
  for (const [label, c] of checks) r.bullet(`${c ? 'OK' : 'FAIL'} — ${label}`);
  r.blank();
  r.verdict(ok, ok ? 'the platform fee transfer fits in the swap transaction on buy and sell, alongside the referral. Plan A holds.' : 'see failed checks; plan B in SUMMARY.md (address lookup table / display the fee before signing / lower rate).');
  r.write('test4-platform-fee.md');
  state.set('test4.result', { ok, checks: checks.map(([label, c]) => ({ label, ok: c })) });
  return ok;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/test4.ts');
if (isMain) await runMain(async () => void (await runTest4()));
