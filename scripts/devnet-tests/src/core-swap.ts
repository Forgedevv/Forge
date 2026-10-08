/**
 * `pnpm core:swap` — devnet integration test of the @forge/core swap builders (wave 3, task 3.2).
 *
 * On an existing devnet pool with a production-like config (test 3: anti-sniper fee scheduler,
 * `enableFirstSwapWithMinFee`, 25% creator share), the `trader` wallet buys 0.01 SOL of the coin
 * with `buildBuyTx`, then sells half of what it bought with `buildSellTx`. Each transaction is
 * signed by the trader only, sent, and confirmed by polling `getSignatureStatuses` (deadline: the
 * blockhash's last valid block height).
 *
 * Checks, from the transaction's own meta (so concurrent activity on the shared devnet wallets
 * cannot skew them) and from the `evtSwap` self-CPI event:
 *   - the platform fee wallet received exactly the platform fee of the quote (30 bps, rounded up);
 *   - the referral token account received exactly `evtSwap.referralFee` (> 0);
 *   - the trader's SOL moved by exactly what the layout implies;
 *   - size <= 1,232 bytes, compute units within the limit.
 * Also checks the refusals without sending anything: a migrated pool (test 2) and a platform fee
 * wallet that is not rent-exempt.
 *
 * The FORGE fee accounts are devnet stand-ins injected through the `env` parameter of the builders
 * (read by addresses.ts): FORGE_METEORA_REFERRAL_ACCOUNT = the `referral` wallet's WSOL ATA (tests 1
 * and 4), FORGE_PLATFORM_FEE_WALLET = the `platformFee` wallet. Refuses to run unless RPC_URL
 * contains "devnet". Resumable: a stored step is not sent again.
 */
import { Keypair, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import {
  PLATFORM_FEE_BPS,
  SwapError,
  assertSwapFeeAccountsReady,
  buildBuyTx,
  buildSellTx,
  platformFeeLamports,
  quoteSwap,
  type BuiltSwapTransaction,
  type SwapErrorCode,
} from '../../../packages/core/src/index.js';
import { ensureFunded, runMain } from './lib/funding.js';
import { loadEnv } from './lib/env.js';
import { State, type Json } from './lib/state.js';
import { loadWallets, type Wallets } from './lib/wallets.js';
import { COMMITMENT, ata, confirmBySignature, getConnection, sleep } from './lib/solana.js';
import { decodeEvents, pickSwapEvent } from './lib/dbc.js';
import { solToLamports } from './lib/math.js';
import { Report, accountLink, txLink } from './lib/report.js';

export const CORE_SWAP_BUY = solToLamports(0.01);
export const CORE_SWAP_SLIPPAGE_BPS = 100;
export const MAX_TX_BYTES = 1232;

type SwapStep = {
  kind: 'buy' | 'sell';
  signature: string;
  amountIn: string;
  quotedOut: string;
  minAmountOut: string;
  quotedTradingFee: string;
  quotedProtocolFee: string;
  quotedReferralFee: string;
  platformFee: string;
  sizeBytes: number;
  signedBytes: number;
  computeUnitLimit: number;
  computeUnitsConsumed: number | null;
  txFee: string;
  newCoinAccountRent: string;
  platformDelta: string;
  referralDelta: string;
  traderSolDelta: string;
  traderTokenDelta: string;
  event: Record<string, Json> | null;
};

type Refusal = { label: string; expected: SwapErrorCode; got: string; ok: boolean };

/** Lamports and token balance deltas of `account` in a confirmed transaction (from its meta). */
function deltas(tx: VersionedTransactionResponse, account: PublicKey) {
  const meta = tx.meta;
  if (!meta) throw new Error('transaction meta missing');
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: meta.loadedAddresses ?? undefined,
  });
  let index = -1;
  for (let i = 0; i < keys.length; i++) if (keys.get(i)?.equals(account)) index = i;
  if (index < 0) return { lamports: 0n, tokens: 0n };
  const lamports = BigInt(meta.postBalances[index]!) - BigInt(meta.preBalances[index]!);
  const amountAt = (list: typeof meta.preTokenBalances) =>
    BigInt(list?.find((b) => b.accountIndex === index)?.uiTokenAmount.amount ?? '0');
  const tokens = amountAt(meta.postTokenBalances) - amountAt(meta.preTokenBalances);
  return { lamports, tokens };
}

async function getConfirmedTransaction(signature: string): Promise<VersionedTransactionResponse> {
  const conn = getConnection();
  for (let attempt = 0; attempt < 8; attempt++) {
    const tx = await conn.getTransaction(signature, {
      commitment: COMMITMENT,
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta) return tx;
    await sleep(1500);
  }
  throw new Error(`Transaction ${signature} not found after confirmation`);
}

/** Signs with the trader only, sends, confirms by polling, and measures the outcome. */
async function execute(
  kind: 'buy' | 'sell',
  built: BuiltSwapTransaction,
  wallets: Wallets,
  referralTokenAccount: PublicKey,
  traderCoinAta: PublicKey,
): Promise<SwapStep> {
  const conn = getConnection();
  built.transaction.sign([wallets.trader]);
  const raw = built.transaction.serialize();
  const signature = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  console.log(`    sent ${kind} ${signature} (${raw.length} bytes)`);
  await confirmBySignature(signature, built.lastValidBlockHeight);
  const tx = await getConfirmedTransaction(signature);
  const platform = deltas(tx, wallets.platformFee.publicKey);
  const referral = deltas(tx, referralTokenAccount);
  const trader = deltas(tx, wallets.trader.publicKey);
  const traderCoin = deltas(tx, traderCoinAta);
  const q = built.quote;
  return {
    kind,
    signature,
    amountIn: q.amountIn.toString(),
    quotedOut: q.expectedAmountOut.toString(),
    minAmountOut: q.minAmountOut.toString(),
    quotedTradingFee: q.fees.tradingFee.toString(),
    quotedProtocolFee: q.fees.protocolFee.toString(),
    quotedReferralFee: q.fees.referralFee.toString(),
    platformFee: q.fees.platformFee.toString(),
    sizeBytes: built.sizeBytes,
    signedBytes: raw.length,
    computeUnitLimit: built.computeUnitLimit,
    computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
    txFee: String(tx.meta?.fee ?? 0),
    newCoinAccountRent: built.newCoinAccountRentLamports.toString(),
    platformDelta: platform.lamports.toString(),
    referralDelta: referral.tokens.toString(),
    traderSolDelta: trader.lamports.toString(),
    traderTokenDelta: traderCoin.tokens.toString(),
    event: pickSwapEvent(await decodeEvents(signature)),
  };
}

async function expectRefusal(
  label: string,
  expected: SwapErrorCode,
  attempt: () => Promise<unknown>,
): Promise<Refusal> {
  try {
    await attempt();
    return { label, expected, got: 'built (no refusal)', ok: false };
  } catch (error) {
    const got = error instanceof SwapError ? error.code : `${(error as Error).name}`;
    return { label, expected, got, ok: got === expected };
  }
}

export async function runCoreSwap(): Promise<boolean> {
  console.log('=== @forge/core swap: buy + sell with referral and platform fee ===');
  loadEnv(); // refuses unless RPC_URL contains "devnet"
  const conn = getConnection();
  const state = State.load();
  const wallets = loadWallets();
  await ensureFunded(wallets, { trader: 0.05 });

  const pool = new PublicKey(state.require<{ pool: string }>('test3.launch').pool);
  const mint = new PublicKey(state.require<{ mint: string }>('test3.launch').mint);
  const migratedPool = new PublicKey(state.require<{ pool: string }>('test2.pool').pool);
  const referralTokenAccount = ata(wallets.referral.publicKey, NATIVE_MINT);
  const traderCoinAta = ata(wallets.trader.publicKey, mint);
  const env = {
    ...process.env,
    FORGE_METEORA_REFERRAL_ACCOUNT: referralTokenAccount.toBase58(),
    FORGE_PLATFORM_FEE_WALLET: wallets.platformFee.publicKey.toBase58(),
  };
  const user = wallets.trader.publicKey;

  // Startup check of the fee accounts (rent-exempt platform wallet, WSOL referral account).
  await assertSwapFeeAccountsReady({ connection: conn, env });

  // Refusals: nothing is sent.
  const refusals: Refusal[] = [
    await expectRefusal('buy on a migrated pool (test 2)', 'POOL_GRADUATED', () =>
      buildBuyTx({
        connection: conn,
        pool: migratedPool,
        user,
        amountInLamports: CORE_SWAP_BUY,
        slippageBps: CORE_SWAP_SLIPPAGE_BPS,
        env,
      }),
    ),
    await expectRefusal(
      'buy with a platform fee wallet that does not exist (not rent-exempt)',
      'PLATFORM_FEE_WALLET_NOT_RENT_EXEMPT',
      () =>
        buildBuyTx({
          connection: conn,
          pool,
          user,
          amountInLamports: CORE_SWAP_BUY,
          slippageBps: CORE_SWAP_SLIPPAGE_BPS,
          env: { ...env, FORGE_PLATFORM_FEE_WALLET: Keypair.generate().publicKey.toBase58() },
        }),
    ),
  ];
  for (const r of refusals) console.log(`  refusal: ${r.label} -> ${r.got}`);

  const buy = await state.step<SwapStep>('coreSwap.buy', async () => {
    const quote = await quoteSwap({
      connection: conn,
      pool,
      side: 'buy',
      amountIn: CORE_SWAP_BUY,
      slippageBps: CORE_SWAP_SLIPPAGE_BPS,
    });
    console.log(
      `  quote: ${quote.expectedAmountOut} raw out, pool fee ${quote.fees.totalPoolFee}, referral ${quote.fees.referralFee}, platform ${quote.fees.platformFee}`,
    );
    const built = await buildBuyTx({
      connection: conn,
      pool,
      user,
      amountInLamports: CORE_SWAP_BUY,
      slippageBps: CORE_SWAP_SLIPPAGE_BPS,
      env,
    });
    return execute('buy', built, wallets, referralTokenAccount, traderCoinAta);
  });

  const sell = await state.step<SwapStep>('coreSwap.sell', async () => {
    const bought = BigInt(buy.traderTokenDelta);
    if (bought <= 0n) throw new Error('the buy did not credit any coin');
    const built = await buildSellTx({
      connection: conn,
      pool,
      user,
      amountInTokens: bought / 2n,
      slippageBps: CORE_SWAP_SLIPPAGE_BPS,
      env,
    });
    return execute('sell', built, wallets, referralTokenAccount, traderCoinAta);
  });

  const big = (v: Json | undefined) => BigInt(String(v ?? '0'));
  const ev = (s: SwapStep, field: string) => big(s.event?.[field]);
  const checks: Array<[string, boolean]> = [];
  for (const s of [buy, sell]) {
    const base = s.kind === 'buy' ? BigInt(s.amountIn) : ev(s, 'outputAmount');
    checks.push(
      [`${s.kind}: evtSwap decoded, with referral`, s.event?.hasReferral === true],
      [
        `${s.kind}: platform fee wallet received exactly the quoted platform fee (${PLATFORM_FEE_BPS} bps, rounded up)`,
        BigInt(s.platformDelta) === BigInt(s.platformFee) && BigInt(s.platformFee) > 0n,
      ],
      [
        `${s.kind}: platform fee = ceil(${PLATFORM_FEE_BPS} bps x ${s.kind === 'buy' ? 'SOL spent' : 'quoted SOL out'})`,
        BigInt(s.platformFee) ===
          platformFeeLamports(s.kind === 'buy' ? BigInt(s.amountIn) : BigInt(s.quotedOut)),
      ],
      [
        `${s.kind}: referral account received exactly evtSwap.referralFee (> 0)`,
        BigInt(s.referralDelta) === ev(s, 'referralFee') && ev(s, 'referralFee') > 0n,
      ],
      [
        `${s.kind}: referral = 20% of the protocol share`,
        ev(s, 'referralFee') === ((ev(s, 'protocolFee') + ev(s, 'referralFee')) * 20n) / 100n,
      ],
      [
        `${s.kind}: output >= minAmountOut`,
        ev(s, 'outputAmount') >= BigInt(s.minAmountOut) && base > 0n,
      ],
      [
        `${s.kind}: transaction within ${MAX_TX_BYTES} bytes`,
        s.signedBytes <= MAX_TX_BYTES && s.signedBytes === s.sizeBytes,
      ],
      [
        `${s.kind}: compute units within the limit`,
        s.computeUnitsConsumed !== null && s.computeUnitsConsumed <= s.computeUnitLimit,
      ],
    );
  }
  checks.push(
    [
      'buy: trader SOL delta = -(amount + platform fee + tx fee + new coin ATA rent)',
      BigInt(buy.traderSolDelta) ===
        -(
          BigInt(buy.amountIn) +
          BigInt(buy.platformFee) +
          BigInt(buy.txFee) +
          BigInt(buy.newCoinAccountRent)
        ),
    ],
    [
      'buy: trader received the coins of evtSwap',
      BigInt(buy.traderTokenDelta) === ev(buy, 'outputAmount'),
    ],
    [
      'sell: trader SOL delta = evtSwap output - platform fee - tx fee',
      BigInt(sell.traderSolDelta) ===
        ev(sell, 'outputAmount') - BigInt(sell.platformFee) - BigInt(sell.txFee),
    ],
    ['sell: trader sent the coins sold', BigInt(sell.traderTokenDelta) === -BigInt(sell.amountIn)],
  );
  for (const r of refusals) checks.push([`refusal: ${r.label} -> ${r.expected}`, r.ok]);
  const ok = checks.every(([, c]) => c);

  const r = new Report('@forge/core swap — buy and sell with referral and platform fee');
  r.p(
    `Goal: run \`buildBuyTx\` / \`buildSellTx\` from \`packages/core/src/swap.ts\` end to end on devnet: DBC swap with the FORGE referral account plus a ${PLATFORM_FEE_BPS} bps SOL transfer to the platform fee wallet, signed by the trader only, confirmed by polling \`getSignatureStatuses\`.`,
  );
  r.h2('Setup');
  r.bullet(
    `Pool: ${accountLink(pool, pool.toBase58())} (test 3 config: 1% fee after a 99% anti-sniper schedule, \`enableFirstSwapWithMinFee\`, 25% creator share) — coin ${accountLink(mint)}`,
  );
  r.bullet(
    `FORGE_METEORA_REFERRAL_ACCOUNT (devnet stand-in, WSOL ATA of the referral wallet): ${accountLink(referralTokenAccount, referralTokenAccount.toBase58())}`,
  );
  r.bullet(
    `FORGE_PLATFORM_FEE_WALLET (devnet stand-in): ${accountLink(wallets.platformFee.publicKey, wallets.platformFee.publicKey.toBase58())}`,
  );
  r.bullet(`Trader (signer and fee payer): ${accountLink(user, user.toBase58())}`);
  r.bullet(
    `Slippage ${CORE_SWAP_SLIPPAGE_BPS} bps; buy ${CORE_SWAP_BUY} lamports; sell = half of the coins bought.`,
  );
  r.blank();
  r.h2('Swaps');
  r.table(
    [
      'Swap',
      'Amount in',
      'Quoted out',
      'evtSwap out',
      'Platform fee',
      'Platform wallet Δ',
      'Referral Δ',
      'evtSwap referralFee',
      'Trader SOL Δ',
      'Tx fee',
      'Size',
      'CU used / limit',
      'Tx',
    ],
    [buy, sell].map((s) => [
      s.kind,
      s.amountIn,
      s.quotedOut,
      String(s.event?.outputAmount ?? 'n/a'),
      s.platformFee,
      s.platformDelta,
      s.referralDelta,
      String(s.event?.referralFee ?? 'n/a'),
      s.traderSolDelta,
      s.txFee,
      `${s.signedBytes} bytes`,
      `${s.computeUnitsConsumed ?? 'n/a'} / ${s.computeUnitLimit}`,
      txLink(s.signature),
    ]),
  );
  r.bullet(
    'Instruction layout: setComputeUnitLimit, create WSOL ATA (idempotent), [buy: create coin ATA, wrap SOL + SyncNative], DBC swap (referral + instructions sysvar), close WSOL ATA, platform fee transfer.',
  );
  r.bullet(
    'Deltas are read from each transaction’s own meta (pre/post balances), so other activity on the shared devnet wallets cannot affect them.',
  );
  r.blank();
  r.h2('Signatures');
  for (const s of [buy, sell]) r.bullet(`${s.kind}: \`${s.signature}\``);
  r.blank();
  r.h2('Checks');
  for (const [label, c] of checks) r.bullet(`${c ? 'OK' : 'FAIL'} — ${label}`);
  r.blank();
  r.verdict(
    ok,
    ok
      ? 'the core builders produce swaps that pay the referral and exactly the platform fee, within the size limit, and refuse graduated pools and a non rent-exempt fee wallet.'
      : 'see the failed checks above.',
  );
  r.write('core-swap.md');
  state.set('coreSwap.result', { ok, checks: checks.map(([label, c]) => ({ label, ok: c })) });
  for (const [label, c] of checks) console.log(`  ${c ? 'OK  ' : 'FAIL'} ${label}`);
  return ok;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/core-swap.ts');
if (isMain)
  await runMain(async () => {
    if (!(await runCoreSwap())) process.exitCode = 1;
  });
