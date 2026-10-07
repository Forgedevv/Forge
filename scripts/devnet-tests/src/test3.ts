/**
 * Test 3 — First buy paid by the client (docs/DEVNET_TESTS.md).
 *
 * One transaction creates the pool (signed by forgeCreator + the mint keypair) and performs the
 * first buy, paid and signed by `client`, with the tokens received by `client`. The config has the
 * anti-sniper fee scheduler and `enableFirstSwapWithMinFee = true`, so the first buy must pay the
 * minimum (ending) fee while the next buy pays the high launch fee.
 */
import { PublicKey, Transaction } from '@solana/web3.js';
import { SwapMode, getCurrentPoint } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { BUDGETS, ensureFunded, runMain } from './lib/funding.js';
import { State, type Json } from './lib/state.js';
import { loadOrCreateKeypair, loadWallets } from './lib/wallets.js';
import {
  ata,
  getBalance,
  getConnection,
  getTokenAccountBalance,
  sendSigned,
} from './lib/solana.js';
import {
  big,
  bn,
  buildTestCurve,
  createConfigOnChain,
  decodeEvents,
  getDbc,
  pickSwapEvent,
  poolAddress,
  quoteConfigFromPoolConfig,
  snapshotPool,
  swapOnChain,
  withSwapEvent,
  type PoolSnapshot,
} from './lib/dbc.js';
import { approxEqual, expectedFeeSplit, solToLamports } from './lib/math.js';
import { Report, accountLink, sol, txLink } from './lib/report.js';

export const TEST3_FEE_BPS = 100;
export const TEST3_ANTI_SNIPER = {
  startingFeeBps: 9900,
  numberOfPeriod: 10,
  totalDurationSeconds: 600,
};
export const TEST3_FIRST_BUY = solToLamports(0.05);
export const TEST3_SECOND_BUY = solToLamports(0.05);
export const MAX_TX_BYTES = 1232;

type ConfigStep = { config: string; signature: string };
type LaunchStep = {
  pool: string;
  mint: string;
  signature: string;
  txBytes: number;
  signersAfterForge: string[];
  signersAfterClient: string[];
  clientSolBefore: string;
  clientSolAfter: string;
  forgeSolBefore: string;
  forgeSolAfter: string;
  clientTokens: string;
  quotedOut: string;
  quotedTradingFee: string;
  event: Record<string, Json> | null;
  poolAfter: PoolSnapshot;
};
type SecondBuyStep = { signature: string; event: Record<string, Json> | null; txBytes: number };

export async function runTest3(): Promise<boolean> {
  console.log('=== Test 3 — First buy paid by the client ===');
  const state = State.load();
  const wallets = loadWallets();
  await ensureFunded(wallets, BUDGETS.test3);

  const configStep = await state.step<ConfigStep>('test3.config', async () => {
    const configKeypair = loadOrCreateKeypair('test3-config');
    const params = buildTestCurve({
      feeBps: TEST3_FEE_BPS,
      antiSniper: TEST3_ANTI_SNIPER,
      creatorTradingFeePercentage: 25,
      poolCreationFeeSol: 0.001,
      enableFirstSwapWithMinFee: true,
      migrationQuoteThresholdSol: 10,
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
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

  // 1-3. createPoolWithFirstBuy, partially signed by forgeCreator + mint, then by client, then sent.
  const launch = await state.step<LaunchStep>('test3.launch', async () => {
    const dbc = getDbc();
    const conn = getConnection();
    // A previous attempt may have landed on-chain without the script recording it (confirmation
    // failure): use a fresh mint in that case and keep the earlier pool's signatures in the state.
    let mint = loadOrCreateKeypair('test3-mint');
    const previousAttempts: Array<{ pool: string; signatures: string[] }> = [];
    for (const suffix of ['', '-b', '-c', '-d']) {
      mint = loadOrCreateKeypair(`test3-mint${suffix}`);
      const existing = poolAddress(config, mint.publicKey);
      if (!(await conn.getAccountInfo(existing))) break;
      const sigs = await conn.getSignaturesForAddress(existing, { limit: 5 }, 'confirmed');
      previousAttempts.push({
        pool: existing.toBase58(),
        signatures: sigs.map((s) => s.signature),
      });
      console.log(
        `  pool ${existing.toBase58()} already exists (earlier attempt), using another mint`,
      );
    }
    if (previousAttempts.length) state.set('test3.previousAttempts', previousAttempts);
    const poolConfig = await dbc.state.getPoolConfig(config);
    if (!poolConfig) throw new Error('config not found');
    const currentPoint = await getCurrentPoint(conn, poolConfig.activationType);
    const quote = dbc.pool.getQuoteFromInputAmount({
      config: quoteConfigFromPoolConfig(poolConfig),
      swapBaseForQuote: false,
      amountIn: bn(TEST3_FIRST_BUY),
      swapMode: SwapMode.ExactIn,
      slippageBps: 100,
      hasReferral: false,
      currentPoint,
      eligibleForFirstSwapWithMinFee: true,
    });
    const minimumAmountOut = (big(quote.outputAmount) * 99n) / 100n;

    const tx = await dbc.creator.createPoolWithFirstBuy({
      createPoolParam: {
        name: 'Forge Test Three',
        symbol: 'FT3',
        uri: 'https://example.com/forge-test-3.json',
        payer: wallets.forgeCreator.publicKey,
        poolCreator: wallets.forgeCreator.publicKey,
        config,
        baseMint: mint.publicKey,
      },
      firstBuyParam: {
        buyer: wallets.client.publicKey,
        receiver: wallets.client.publicKey,
        buyAmount: bn(TEST3_FIRST_BUY),
        minimumAmountOut: bn(minimumAmountOut),
        referralTokenAccount: null,
      },
    });

    // Signer side (FORGE): fee payer = client, partial signature by forgeCreator and the mint.
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = wallets.client.publicKey;
    tx.partialSign(wallets.forgeCreator, mint);
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: true });
    const signersAfterForge = tx.signatures
      .filter((s) => s.signature)
      .map((s) => s.publicKey.toBase58());

    // Client side: deserialize, sign, send.
    const clientSolBefore = await getBalance(wallets.client.publicKey);
    const forgeSolBefore = await getBalance(wallets.forgeCreator.publicKey);
    const clientTx = Transaction.from(serialized);
    clientTx.partialSign(wallets.client);
    const signersAfterClient = clientTx.signatures
      .filter((s) => s.signature)
      .map((s) => s.publicKey.toBase58());
    const signature = await sendSigned(clientTx, 'createPoolWithFirstBuy');

    const pool = poolAddress(config, mint.publicKey);
    const clientTokens = await getTokenAccountBalance(
      ata(wallets.client.publicKey, mint.publicKey),
    );
    return {
      pool: pool.toBase58(),
      mint: mint.publicKey.toBase58(),
      signature,
      txBytes: serialized.length,
      signersAfterForge,
      signersAfterClient,
      clientSolBefore: clientSolBefore.toString(),
      clientSolAfter: (await getBalance(wallets.client.publicKey)).toString(),
      forgeSolBefore: forgeSolBefore.toString(),
      forgeSolAfter: (await getBalance(wallets.forgeCreator.publicKey)).toString(),
      clientTokens: clientTokens.toString(),
      quotedOut: quote.outputAmount.toString(),
      quotedTradingFee: quote.tradingFee.toString(),
      event: pickSwapEvent(await decodeEvents(signature)),
      poolAfter: await snapshotPool(pool),
    };
  });
  const pool = new PublicKey(launch.pool);
  const launchWithEvent = await withSwapEvent(state, 'test3.launch', launch);

  // 4b. A second buy right after launch must pay the anti-sniper fee.
  const second = await withSwapEvent(
    state,
    'test3.secondBuy',
    await state.step<SecondBuyStep>('test3.secondBuy', async () => {
      const outcome = await swapOnChain({
        pool,
        owner: wallets.trader,
        amountIn: TEST3_SECOND_BUY,
        swapBaseForQuote: false,
        referralTokenAccount: null,
        slippageBps: 500,
      });
      return {
        signature: outcome.signature,
        event: pickSwapEvent(await decodeEvents(outcome.signature)),
        txBytes: outcome.txBytes,
      };
    }),
  );
  launch.event = launchWithEvent.event;

  // In the swap event, `tradingFee` is the partner + creator share and `protocolFee` (+ `referralFee`)
  // the rest: the total fee charged on the input is their sum.
  const totalFeeOf = (ev: Record<string, Json> | null): bigint =>
    ev
      ? BigInt(String(ev.tradingFee)) +
        BigInt(String(ev.protocolFee)) +
        BigInt(String(ev.referralFee))
      : -1n;
  const firstFee = totalFeeOf(launch.event);
  const secondFee = totalFeeOf(second.event);
  const minFee = expectedFeeSplit(TEST3_FIRST_BUY, TEST3_FEE_BPS, 25, false).totalFee;
  const clientDebit = BigInt(launch.clientSolBefore) - BigInt(launch.clientSolAfter);
  const eventOut = launch.event ? BigInt(String(launch.event.outputAmount)) : -1n;
  const checks: Array<[string, boolean]> = [
    ['one transaction creates the pool and performs the first buy', launch.signature.length > 0],
    ['transaction fits the size limit', launch.txBytes <= MAX_TX_BYTES],
    [
      'forgeCreator and the mint signed first, client signed last',
      launch.signersAfterForge.length === 2 && launch.signersAfterClient.length === 3,
    ],
    [
      'pool creator is forgeCreator',
      launch.poolAfter.creator === wallets.forgeCreator.publicKey.toBase58(),
    ],
    [
      'tokens received by client',
      BigInt(launch.clientTokens) > 0n && BigInt(launch.clientTokens) === eventOut,
    ],
    ['SOL debited from client (buy + tx fee + token account rents)', clientDebit > TEST3_FIRST_BUY],
    ['first buy pays the minimum fee (1%) despite the 99% anti-sniper fee', firstFee === minFee],
    ['second buy pays the anti-sniper fee (> 50%)', secondFee > TEST3_SECOND_BUY / 2n],
    [
      'SDK quote matches the on-chain output',
      eventOut === BigInt(launch.quotedOut) ||
        approxEqual(eventOut, BigInt(launch.quotedOut), BigInt(launch.quotedOut) / 100n),
    ],
  ];
  const ok = checks.every(([, c]) => c);

  const r = new Report('Test 3 — First buy paid by the client');
  r.p(
    'Goal: confirm that a single transaction can create the pool (signed by forgeCreator) and make the first buy paid and signed by client, with tokens received by client; and that with `enableFirstSwapWithMinFee` the first buy pays the minimum fee under the anti-sniper schedule.',
  );
  r.h2('Setup');
  r.bullet(
    `Config: ${accountLink(configStep.config, configStep.config)} — ${txLink(configStep.signature)}`,
  );
  r.bullet(
    `Fee scheduler: ${TEST3_ANTI_SNIPER.startingFeeBps} bps → ${TEST3_FEE_BPS} bps over ${TEST3_ANTI_SNIPER.totalDurationSeconds} s (${TEST3_ANTI_SNIPER.numberOfPeriod} periods, linear), enableFirstSwapWithMinFee = true, creator share 25%`,
  );
  r.bullet(
    `forgeCreator: ${accountLink(wallets.forgeCreator.publicKey)}; client: ${accountLink(wallets.client.publicKey)}; trader: ${accountLink(wallets.trader.publicKey)}`,
  );
  r.h2('Launch transaction');
  for (const attempt of state.get<Array<{ pool: string; signatures: string[] }>>(
    'test3.previousAttempts',
  ) ?? []) {
    r.bullet(
      `Earlier attempt: pool ${accountLink(attempt.pool, attempt.pool)} was created on-chain (${attempt.signatures.map((s) => txLink(s)).join(', ')}) ` +
        'but the script lost the confirmation (RPC websocket rate limit, HTTP 429); the measurements below come from a fresh pool.',
    );
  }
  r.bullet(`${txLink(launch.signature)} — ${launch.txBytes} bytes (limit ${MAX_TX_BYTES})`);
  r.bullet(
    `Pool ${accountLink(launch.pool, launch.pool)}, mint ${accountLink(launch.mint, launch.mint)}, creator in pool state: ${launch.poolAfter.creator}`,
  );
  r.bullet(`Signatures after the signer side: ${launch.signersAfterForge.join(', ')}`);
  r.bullet(`Signatures after the client side: ${launch.signersAfterClient.join(', ')}`);
  r.bullet(
    `Client SOL ${launch.clientSolBefore} → ${launch.clientSolAfter} (debit ${sol(clientDebit)}; buy ${sol(TEST3_FIRST_BUY)})`,
  );
  r.bullet(
    `forgeCreator SOL ${launch.forgeSolBefore} → ${launch.forgeSolAfter} (pays the pool rent and the pool creation fee, not the buy)`,
  );
  r.bullet(
    `Client token balance: ${launch.clientTokens} (event outputAmount ${eventOut}, SDK quote ${launch.quotedOut})`,
  );
  r.h2('Fees');
  r.table(
    [
      'Swap',
      'Amount in',
      'On-chain total fee (tradingFee + protocolFee + referralFee)',
      'Expected',
      'Tx',
    ],
    [
      [
        'First buy (client, inside creation tx)',
        TEST3_FIRST_BUY.toString(),
        firstFee.toString(),
        `${minFee} (min fee ${TEST3_FEE_BPS} bps)`,
        txLink(launch.signature),
      ],
      [
        'Second buy (trader, right after)',
        TEST3_SECOND_BUY.toString(),
        secondFee.toString(),
        `≈ ${TEST3_ANTI_SNIPER.startingFeeBps} bps (anti-sniper)`,
        txLink(second.signature),
      ],
    ],
  );
  r.h2('Checks');
  for (const [label, c] of checks) r.bullet(`${c ? 'OK' : 'FAIL'} — ${label}`);
  r.blank();
  r.verdict(
    ok,
    ok
      ? 'the client pays and signs the first buy inside the pool creation transaction, with the minimum fee. Plan A holds.'
      : 'see failed checks; plan B in SUMMARY.md (FORGE creates the pool, the client buys in a separate transaction).',
  );
  r.write('test3-first-buy.md');
  state.set('test3.result', { ok, checks: checks.map(([label, c]) => ({ label, ok: c })) });
  return ok;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/test3.ts');
if (isMain) await runMain(async () => void (await runTest3()));
