/**
 * `pnpm core:reads` — devnet integration of @forge/core claims, reads, payments and gating.
 *
 * 1. Reads the wave-1 devnet configs and pools through `listCoinsOfConfig` / `readCoin`:
 *    graduation, curve progress (bps) and claimable fees.
 * 2. Reads the fake $FORGE balance of its holder and of the client with `getForgeBalance`.
 * 3. Pays 0.001 SOL from `client` to a cashbox STAND-IN with `buildPaymentTx`, then checks it with
 *    `verifyPayment` (plus negative checks of the same signature: wrong amount, job, payer).
 *    Cashbox stand-in: the `platformFee` throwaway wallet (already rent-exempt from test 4). Its
 *    address is passed to @forge/core as `FORGE_CASHBOX_WALLET` through the `env` option only.
 * 4. One partner claim (`buildPartnerClaimTx`, signed by the `partner` wallet = feeClaimer of the
 *    test configs) on the first pool that has claimable partner fees.
 *
 * Writes reports/core-reads.md. Resumable: the payment and the claim are recorded in .state and
 * never redone. Refuses to run unless RPC_URL contains "devnet" (lib/env.ts).
 */
import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  buildPartnerClaimTx,
  buildPaymentTx,
  getForgeBalance,
  listCoinsOfConfig,
  readCoin,
  verifyPayment,
  type CoinOfConfig,
  type PaymentVerification,
} from '../../../packages/core/src/index.js';
import { runMain } from './lib/funding.js';
import { State } from './lib/state.js';
import { loadWallets } from './lib/wallets.js';
import { getBalance, getConnection, sendSigned, sleep } from './lib/solana.js';
import { Report, accountLink, sol, txLink } from './lib/report.js';

const PAYMENT_LAMPORTS = 1_000_000n; // 0.001 SOL
/** The partner pays the claim fee and advances temporary account rent: keep a small floor. */
const PARTNER_MIN_BALANCE = 10_000_000n;
const VERIFY_DEADLINE_MS = 90_000;

const CONFIG_STEPS = ['test1.config', 'test2.config', 'test3.config', 'test4.config'] as const;

type PaymentStep = { jobId: string; signature: string; cashbox: string; lamports: string };
type ClaimStep = {
  pool: string;
  signature: string;
  claimableQuote: string;
  partnerQuoteFeeAfter: string;
  partnerBalanceBefore: string;
  partnerBalanceAfter: string;
};

function describeVerification(v: PaymentVerification): string {
  if (v.status === 'confirmed') return `confirmed (slot ${v.slot}, ${v.confirmationStatus})`;
  if (v.status === 'invalid') return `invalid: ${v.reason} — ${v.detail}`;
  return 'pending';
}

export async function runCoreReads(): Promise<boolean> {
  console.log('=== @forge/core — claims, reads, payments, gating (devnet) ===');
  const connection = getConnection(); // refuses non-devnet RPC URLs
  const state = State.load();
  const wallets = loadWallets();
  const cashbox = wallets.platformFee.publicKey;
  const coreEnv = { FORGE_CASHBOX_WALLET: cashbox.toBase58(), SOLANA_CLUSTER: 'devnet' };

  // 1. Reads.
  const configs = CONFIG_STEPS.filter((k) => state.has(k)).map((k) => ({
    step: k,
    config: new PublicKey(state.require<{ config: string }>(k).config),
  }));
  const coinsByConfig: Array<{ step: string; config: PublicKey; coins: CoinOfConfig[] }> = [];
  for (const c of configs) {
    const coins = await listCoinsOfConfig(connection, c.config);
    coinsByConfig.push({ ...c, coins });
    for (const coin of coins) {
      console.log(
        `  ${c.step} pool ${coin.pool.toBase58()}: ${coin.graduation}, progress ${coin.progress.bps} bps, ` +
          `partner ${coin.fees.claimable.partner.quote} / creator ${coin.fees.claimable.creator.quote} lamports claimable`,
      );
    }
  }
  const knownPool = new PublicKey(state.require<{ pool: string }>('test1.pool').pool);
  const single = await readCoin(connection, knownPool);
  const listedKnown = coinsByConfig
    .flatMap((c) => c.coins)
    .find((coin) => coin.pool.equals(knownPool));

  // 2. Gating.
  const forgeMint = state.get<{ mint: string; holder: string }>('forgeMint');
  const gating = forgeMint
    ? {
        holder: await getForgeBalance(connection, new PublicKey(forgeMint.holder), {
          env: { FORGE_MINT: forgeMint.mint },
        }),
        client: await getForgeBalance(connection, wallets.client.publicKey, {
          env: { FORGE_MINT: forgeMint.mint },
        }),
      }
    : null;
  const disabled = await getForgeBalance(connection, wallets.client.publicKey, { env: {} });

  // 3. Payment: client -> cashbox stand-in, then verification.
  const cashboxBefore = await getBalance(cashbox);
  const payment = await state.step<PaymentStep>('coreReads.payment', async () => {
    const jobId = randomUUID();
    const built = await buildPaymentTx(
      connection,
      { payer: wallets.client.publicKey, lamports: PAYMENT_LAMPORTS, jobId },
      { env: coreEnv },
    );
    built.transaction.sign(wallets.client);
    const signature = await sendSigned(built.transaction, 'payment');
    return {
      jobId,
      signature,
      cashbox: built.recipient.toBase58(),
      lamports: PAYMENT_LAMPORTS.toString(),
    };
  });
  const expected = {
    payer: wallets.client.publicKey,
    lamports: BigInt(payment.lamports),
    jobId: payment.jobId,
  };
  const verifyEnv = { ...coreEnv, FORGE_CASHBOX_WALLET: payment.cashbox };
  let verification: PaymentVerification = { status: 'pending', signature: payment.signature };
  const deadline = Date.now() + VERIFY_DEADLINE_MS;
  while (verification.status === 'pending' && Date.now() < deadline) {
    verification = await verifyPayment(connection, payment.signature, expected, { env: verifyEnv });
    if (verification.status === 'pending') await sleep(2000);
  }
  console.log(`  verifyPayment: ${describeVerification(verification)}`);
  const finalized = await verifyPayment(connection, payment.signature, expected, {
    env: verifyEnv,
    commitment: 'finalized',
  });
  const negatives = {
    wrongAmount: await verifyPayment(
      connection,
      payment.signature,
      { ...expected, lamports: expected.lamports + 1n },
      { env: verifyEnv },
    ),
    otherJob: await verifyPayment(
      connection,
      payment.signature,
      { ...expected, jobId: randomUUID() },
      { env: verifyEnv },
    ),
    otherPayer: await verifyPayment(
      connection,
      payment.signature,
      { ...expected, payer: wallets.trader.publicKey },
      { env: verifyEnv },
    ),
    otherRecipient: await verifyPayment(connection, payment.signature, expected, {
      env: { ...verifyEnv, FORGE_CASHBOX_WALLET: wallets.multisigStandIn.publicKey.toBase58() },
    }),
  };
  for (const [name, v] of Object.entries(negatives)) {
    console.log(`  verifyPayment (${name}): ${describeVerification(v)}`);
  }

  // 4. One partner claim.
  const partner = wallets.partner.publicKey;
  const partnerBalance = await getBalance(partner);
  let claim: ClaimStep | null = state.get<ClaimStep>('coreReads.partnerClaim') ?? null;
  let claimSkipped: string | null = null;
  if (!claim) {
    const candidate = coinsByConfig
      .flatMap((c) => c.coins)
      .find((coin) => coin.fees.claimable.partner.quote > 0n);
    if (!candidate) claimSkipped = 'no pool has claimable partner fees';
    else if (partnerBalance < PARTNER_MIN_BALANCE)
      claimSkipped = `partner wallet holds ${partnerBalance} lamports, below the ${PARTNER_MIN_BALANCE} floor`;
    else {
      claim = await state.step<ClaimStep>('coreReads.partnerClaim', async () => {
        const built = await buildPartnerClaimTx(connection, {
          pool: candidate.pool,
          feeClaimer: partner,
        });
        if (!built.transaction) throw new Error('Expected a claim transaction');
        built.transaction.sign(wallets.partner);
        const signature = await sendSigned(built.transaction, 'partner claim');
        const after = await readCoin(connection, candidate.pool);
        return {
          pool: candidate.pool.toBase58(),
          signature,
          claimableQuote: built.summary.claimable.quote.toString(),
          partnerQuoteFeeAfter: after.fees.claimable.partner.quote.toString(),
          partnerBalanceBefore: partnerBalance.toString(),
          partnerBalanceAfter: (await getBalance(partner)).toString(),
        };
      });
    }
  }

  // Checks and report.
  const checks: Array<[string, boolean]> = [
    ['every wave-1 config lists its pool(s)', coinsByConfig.every((c) => c.coins.length >= 1)],
    [
      'the migrated test 2 pool reads as migrated with 10,000 bps progress',
      coinsByConfig
        .find((c) => c.step === 'test2.config')
        ?.coins.every((coin) => coin.graduation === 'migrated' && coin.progress.bps === 10_000) ??
        false,
    ],
    [
      'readCoin agrees with listCoinsOfConfig',
      listedKnown !== undefined &&
        single.progress.bps === listedKnown.progress.bps &&
        single.fees.claimable.partner.quote === listedKnown.fees.claimable.partner.quote,
    ],
    [
      'gating: the fake $FORGE holder has a positive balance, disabled without FORGE_MINT',
      !!gating && gating.holder.enabled && gating.holder.balance > 0n && !disabled.enabled,
    ],
    ['payment verified (confirmed)', verification.status === 'confirmed'],
    [
      'wrong amount / other job / other payer / other recipient are rejected',
      negatives.wrongAmount.status === 'invalid' &&
        negatives.wrongAmount.reason === 'amount_mismatch' &&
        negatives.otherJob.status === 'invalid' &&
        negatives.otherJob.reason === 'memo_mismatch' &&
        negatives.otherPayer.status === 'invalid' &&
        negatives.otherPayer.reason === 'payer_not_signer' &&
        negatives.otherRecipient.status === 'invalid' &&
        negatives.otherRecipient.reason === 'recipient_mismatch',
    ],
    [
      'partner claim empties the partner fees of the pool',
      claim !== null &&
        BigInt(claim.partnerQuoteFeeAfter) === 0n &&
        BigInt(claim.claimableQuote) > 0n,
    ],
  ];
  const ok = checks.every(([, c]) => c);

  const r = new Report('@forge/core — claims, reads, payments, gating');
  r.p(
    'Devnet integration of `packages/core/src/{reads,claims,payments,gating}.ts` against the wave-1 test pools ' +
      '(`pnpm --filter @forge/devnet-tests core:reads`).',
  );
  r.h2('Reads (`listCoinsOfConfig`, `curveProgress`, `feeMetrics`, `isGraduated`)');
  r.table(
    [
      'Config',
      'Pool',
      'Graduation',
      'Progress',
      'Quote reserve / threshold',
      'Partner claimable',
      'Creator claimable',
      'Lifetime trading fees',
    ],
    coinsByConfig.flatMap((c) =>
      c.coins.map((coin) => [
        `${c.step} ${accountLink(c.config)}`,
        accountLink(coin.pool),
        coin.graduation,
        `${coin.progress.bps} bps`,
        `${coin.progress.quoteReserve} / ${coin.progress.migrationQuoteThreshold}`,
        coin.fees.claimable.partner.quote.toString(),
        coin.fees.claimable.creator.quote.toString(),
        coin.fees.lifetime.trading.quote.toString(),
      ]),
    ),
  );
  r.p(
    'Amounts in lamports. Progress = floor(quoteReserve × 10,000 / threshold), 10,000 once graduated.',
  );
  r.h2('Gating (`getForgeBalance`)');
  if (gating && forgeMint) {
    r.bullet(`Fake $FORGE mint ${accountLink(forgeMint.mint)}`);
    r.bullet(
      `Holder ${accountLink(forgeMint.holder)}: ${gating.holder.enabled ? `${gating.holder.balance} raw units (${gating.holder.decimals} decimals)` : 'disabled'}`,
    );
    r.bullet(
      `Client ${accountLink(wallets.client.publicKey)}: ${gating.client.enabled ? `${gating.client.balance} raw units` : 'disabled'}`,
    );
  }
  r.bullet(
    `Without FORGE_MINT: ${disabled.enabled ? 'enabled (unexpected)' : '`{ enabled: false }`'}`,
  );
  r.blank();
  r.h2('Payment (`buildPaymentTx` + `verifyPayment`)');
  r.bullet(
    `Cashbox stand-in: the \`platformFee\` throwaway wallet ${accountLink(payment.cashbox)} (passed as FORGE_CASHBOX_WALLET through the \`env\` option; no real cashbox on devnet).`,
  );
  r.bullet(`Payer: client ${accountLink(wallets.client.publicKey)} — ${sol(payment.lamports)}`);
  r.bullet(`Memo: \`forge:job:${payment.jobId}\` — ${txLink(payment.signature)}`);
  r.bullet(`Cashbox balance when this run started: ${sol(cashboxBefore)}`);
  r.bullet(`verifyPayment (confirmed): ${describeVerification(verification)}`);
  r.bullet(`verifyPayment (finalized required): ${describeVerification(finalized)}`);
  for (const [name, v] of Object.entries(negatives)) {
    r.bullet(`verifyPayment, ${name}: ${describeVerification(v)}`);
  }
  r.blank();
  r.h2('Partner claim (`buildPartnerClaimTx`)');
  if (claim) {
    r.bullet(
      `Pool ${accountLink(claim.pool)} — ${txLink(claim.signature)} (signed by the partner = feeClaimer)`,
    );
    r.bullet(
      `Claimable at build time: ${sol(claim.claimableQuote)}; partnerQuoteFee after: ${claim.partnerQuoteFeeAfter}`,
    );
    r.bullet(
      `Partner balance ${claim.partnerBalanceBefore} → ${claim.partnerBalanceAfter} lamports ` +
        '(claimed fees minus network fee and the base-token ATA rent created for the receiver; the temporary WSOL account rent is refunded on close).',
    );
  } else {
    r.bullet(`Skipped: ${claimSkipped ?? 'unknown reason'}`);
  }
  r.blank();
  r.h2('Checks');
  for (const [label, c] of checks) r.bullet(`${c ? 'OK' : 'FAIL'} — ${label}`);
  r.blank();
  r.verdict(
    ok,
    ok
      ? 'reads, payments, gating and the partner claim behave as specified on devnet.'
      : 'see the failed checks above.',
  );
  r.write('core-reads.md');
  return ok;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/core-reads.ts');
if (isMain)
  await runMain(async () => {
    if (!(await runCoreReads())) process.exitCode = 1;
  });
