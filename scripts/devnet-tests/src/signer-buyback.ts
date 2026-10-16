/**
 * `pnpm signer:buyback` — devnet proof of the LIVE $FORGE buyback loop of the signer
 * (apps/signer/src/jobs/buyback.ts, squads.ts, buyback-dbc.ts), with throwaway wallets only:
 *
 *   1. a devnet DBC coin standing in for $FORGE: config by `partner`, pool by `forgeCreator`;
 *   2. a throwaway Squads v4 multisig: `squadsCreator` is the creator and only voter (threshold 1),
 *      `buybackBot` a member WITHOUT any permission; vault 0; a daily SOL spending limit for the
 *      bot (members = [bot], destinations = [bot], 0.05 SOL);
 *   3. the vault funded with a little devnet SOL by `funder`; the bot's and the vault's coin
 *      token accounts created once (on mainnet: a one-time setup, or paid from the bot reserve);
 *   4. the signer's buyback job in live mode on devnet (FORGE_BUYBACK_DEVNET_TEST=true,
 *      BUYBACK_ROUTE=dbc-devnet), run by run with a controlled clock: the spending-limit
 *      withdrawal, two buys (TWAP slices), the bought tokens returned to the vault's token account.
 *
 * Refuses to run unless RPC_URL contains "devnet" (lib/env.ts). Steps 1 to 3 are resumable
 * (.state); step 4 runs fresh every time with its own journal directory. Only public data is
 * printed. Report: reports/signer-buyback.md.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { Keypair, PublicKey, Transaction, type VersionedTransaction } from '@solana/web3.js';
import type { KeystoreSigner } from '../../../apps/signer/src/keystore.js';
import {
  BuybackJournalEntry,
  DAY_MS,
  buybackConfigFromEnv,
  createBuybackJob,
  createRpcForgeTokenReader,
  dayJournalKey,
  dayStartMs,
  utcDay,
  type BuybackOutcome,
  type Rng,
} from '../../../apps/signer/src/jobs/buyback.js';
import { createDbcDevnetBuybackRoute } from '../../../apps/signer/src/jobs/buyback-dbc.js';
import {
  createSquadsJournal,
  createSquadsSpendingLimitWithdrawer,
  squadsConfigFromEnv,
} from '../../../apps/signer/src/jobs/squads.js';
import {
  Mutex,
  createMemoryJournal,
  rpcFromConnection,
  scrubText,
  type JobAlerter,
  type JobLogger,
  type KeystoreLike,
} from '../../../apps/signer/src/jobs/shared.js';
import { memoryFlags } from '../../../apps/signer/src/jobs/testing.js';
import { STATE_DIR, loadEnv } from './lib/env.js';
import { FundingNeeded, ensureFunded, runMain, type Budget } from './lib/funding.js';
import { State, type Json } from './lib/state.js';
import { loadOrCreateKeypair, loadWallets, type Wallets } from './lib/wallets.js';
import {
  ata,
  formatSol,
  getBalance,
  getConnection,
  getTokenAccountBalance,
  sendAndConfirm,
  transferSol,
} from './lib/solana.js';
import { buildTestCurve, createConfigOnChain, createPoolOnChain, poolAddress } from './lib/dbc.js';
import { solToLamports } from './lib/math.js';
import { Report, accountLink, sol, txLink } from './lib/report.js';
import { addDailySolSpendingLimit, createMultisigOnChain } from './lib/squads.js';

const KEY = 'signerBuyback';
const SPENDING_LIMIT_LAMPORTS = solToLamports(0.05);
const VAULT_FUNDING_LAMPORTS = solToLamports(0.1);
const BUDGET: Budget = {
  partner: 0.06,
  forgeCreator: 0.06,
  referral: 0.01,
  platformFee: 0.01,
  squadsCreator: 0.08,
  buybackBot: 0.03,
};
/** Buyback settings of the proof (lamports as strings, like the signer environment). */
const BUYBACK_ENV = {
  BUYBACK_DAILY_CAP_LAMPORTS: '40000000',
  BUYBACK_ORDERS_PER_DAY: '2',
  BUYBACK_MIN_ORDER_LAMPORTS: '10000000',
  BUYBACK_MAX_ORDER_LAMPORTS: '30000000',
  BUYBACK_SLIPPAGE_BPS: '100',
  BUYBACK_MAX_PRICE_IMPACT_BPS: '100',
  BUYBACK_FEE_RESERVE_LAMPORTS: '10000000',
  BUYBACK_MAX_LATENESS_MINUTES: '1440',
  BUYBACK_DAY_MARGIN_MINUTES: '0',
  BUYBACK_MAX_PRIORITY_FEE_LAMPORTS: '0',
};

type ConfigStep = { config: string; signature: string };
type PoolStep = { pool: string; mint: string; signature: string };
type AtaStep = { account: string; signature: string };
type MultisigStep = { multisigPda: string; vault: string; createKey: string; signature: string };
type LimitStep = {
  spendingLimit: string;
  createKey: string;
  transactionIndex: string;
  signatures: Record<string, string>;
};
type FundingStep = { signature: string; lamports: string };
type AtasStep = { botAta: string; vaultAta: string; signature: string };

function consoleLogger(prefix: string): JobLogger {
  const out =
    (level: string) =>
    (fields: Record<string, unknown>, msg: string): void => {
      const json = JSON.stringify(fields, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      console.log(scrubText(`    [${prefix}:${level}] ${msg} ${json}`).slice(0, 400));
    };
  return { debug: () => undefined, info: out('info'), warn: out('warn'), error: out('error') };
}

function consoleAlerter(alerts: string[]): JobAlerter {
  return {
    async alert(level, code, message, details) {
      alerts.push(code);
      console.log(
        scrubText(`    ALERT [${level}] ${code}: ${message} ${JSON.stringify(details ?? {})}`),
      );
    },
  };
}

/** Keystore-shaped signer over the throwaway bot wallet (script-only stand-in, rule 5). */
function botKeystore(bot: Keypair): KeystoreLike {
  const ref = `ks_${randomBytes(16).toString('hex')}`;
  return {
    findRef: async (role) => (role === 'buyback' ? ref : undefined),
    getPublicKey: async (r) => {
      if (r !== ref) throw new Error('unknown ref');
      return bot.publicKey;
    },
    withSigner: async (r, fn) => {
      if (r !== ref) throw new Error('unknown ref');
      const signer: KeystoreSigner = {
        ref,
        role: 'buyback',
        publicKey: bot.publicKey,
        signTransaction(tx: Transaction | VersionedTransaction) {
          if ('message' in tx) tx.sign([bot]);
          else tx.partialSign(bot);
        },
        signMessage() {
          throw new Error('not needed');
        },
      };
      return fn(signer);
    },
  };
}

/** The shared funder is often empty: top it up from the `trader` test wallet when it can. */
async function topUpFunder(wallets: Wallets, lamports: bigint): Promise<void> {
  const have = await getBalance(wallets.funder.publicKey);
  if (have >= lamports) return;
  const missing = lamports - have;
  const trader = await getBalance(wallets.trader.publicKey);
  if (trader < missing + solToLamports(0.02)) {
    throw new FundingNeeded(wallets.funder.publicKey, missing);
  }
  console.log(`  topping the funder up from the trader wallet (${formatSol(missing)})`);
  await transferSol(wallets.trader, wallets.funder.publicKey, missing, 'top up funder');
}

async function ensureCoin(state: State, wallets: Wallets): Promise<{ config: ConfigStep; pool: PoolStep }> {
  const config = await state.step<ConfigStep>(`${KEY}.coin.config`, async () => {
    const configKeypair = loadOrCreateKeypair('signer-buyback-config');
    const signature = await createConfigOnChain({
      payer: wallets.partner,
      configKeypair,
      feeClaimer: wallets.partner.publicKey,
      leftoverReceiver: wallets.partner.publicKey,
      params: buildTestCurve({
        feeBps: 100,
        creatorTradingFeePercentage: 25,
        poolCreationFeeSol: 0,
        enableFirstSwapWithMinFee: true,
        migrationQuoteThresholdSol: 10,
        partnerPermanentLockedLiquidityPercentage: 50,
        partnerLiquidityPercentage: 0,
        creatorPermanentLockedLiquidityPercentage: 50,
        creatorLiquidityPercentage: 0,
      }),
    });
    return { config: configKeypair.publicKey.toBase58(), signature };
  });
  const pool = await state.step<PoolStep>(`${KEY}.coin.pool`, async () => {
    const mint = loadOrCreateKeypair('signer-buyback-mint');
    const config_ = new PublicKey(config.config);
    const conn = getConnection();
    const existing = poolAddress(config_, mint.publicKey);
    if (await conn.getAccountInfo(existing)) {
      return { pool: existing.toBase58(), mint: mint.publicKey.toBase58(), signature: 'existing' };
    }
    const created = await createPoolOnChain({
      config: config_,
      payer: wallets.forgeCreator,
      poolCreator: wallets.forgeCreator,
      mint,
      name: 'FORGE devnet stand-in',
      symbol: 'FORGEDEV',
      uri: 'https://example.invalid/forge-devnet-stand-in.json',
    });
    return { ...created, mint: mint.publicKey.toBase58() };
  });
  return { config, pool };
}

async function ensureReferralAta(state: State, wallets: Wallets): Promise<AtaStep> {
  return state.step<AtaStep>(`${KEY}.referralAta`, async () => {
    const account = ata(wallets.referral.publicKey, NATIVE_MINT);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        wallets.referral.publicKey,
        account,
        wallets.referral.publicKey,
        NATIVE_MINT,
      ),
    );
    const signature = await sendAndConfirm(tx, wallets.referral, { label: 'referral WSOL ATA' });
    return { account: account.toBase58(), signature };
  });
}

async function ensureSquads(
  state: State,
  wallets: Wallets,
): Promise<{ multisig: MultisigStep; limit: LimitStep }> {
  const multisig = await state.step<MultisigStep>(`${KEY}.squads.multisig`, async () => {
    const createKey = loadOrCreateKeypair('signer-buyback-squads-create');
    const created = await createMultisigOnChain({
      creator: wallets.squadsCreator,
      createKey,
      bot: wallets.buybackBot.publicKey,
    });
    return { ...created, createKey: createKey.publicKey.toBase58() };
  });
  const limit = await state.step<LimitStep>(`${KEY}.squads.spendingLimit`, async () => {
    const createKey = loadOrCreateKeypair('signer-buyback-limit-create').publicKey;
    const added = await addDailySolSpendingLimit({
      creator: wallets.squadsCreator,
      multisigPda: new PublicKey(multisig.multisigPda),
      createKey,
      bot: wallets.buybackBot.publicKey,
      amountLamports: SPENDING_LIMIT_LAMPORTS,
    });
    return { ...added, createKey: createKey.toBase58() };
  });
  return { multisig, limit };
}

export async function runSignerBuyback(): Promise<boolean> {
  console.log('=== Signer buyback — live loop on devnet (Squads spending limit, DBC route) ===');
  loadEnv();
  const state = State.load();
  const wallets = loadWallets();
  const conn = getConnection();
  const budgetLamports = Object.values(BUDGET).reduce((a, v) => a + solToLamports(v ?? 0), 0n);
  await topUpFunder(wallets, budgetLamports + VAULT_FUNDING_LAMPORTS + solToLamports(0.05));
  await ensureFunded(wallets, BUDGET);
  const bot = wallets.buybackBot;

  // 1. The stand-in coin and the fee accounts core needs.
  const { config, pool } = await ensureCoin(state, wallets);
  const referral = await ensureReferralAta(state, wallets);
  const forgeMint = new PublicKey(pool.mint);
  const poolKey = new PublicKey(pool.pool);

  // 2. The throwaway multisig, its vault and the bot's daily spending limit.
  const { multisig, limit } = await ensureSquads(state, wallets);
  const vault = new PublicKey(multisig.vault);

  // 3. Vault funding and the two coin token accounts (bot, vault).
  const funding = await state.step<FundingStep>(`${KEY}.vaultFunding`, async () => {
    const signature = await transferSol(wallets.funder, vault, VAULT_FUNDING_LAMPORTS, 'fund vault');
    return { signature, lamports: VAULT_FUNDING_LAMPORTS.toString() };
  });
  const atas = await state.step<AtasStep>(`${KEY}.coinAtas`, async () => {
    const botAta = ata(bot.publicKey, forgeMint);
    const vaultAta = ata(vault, forgeMint);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        wallets.funder.publicKey,
        botAta,
        bot.publicKey,
        forgeMint,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        wallets.funder.publicKey,
        vaultAta,
        vault,
        forgeMint,
      ),
    );
    const signature = await sendAndConfirm(tx, wallets.funder, { label: 'coin ATAs' });
    return { botAta: botAta.toBase58(), vaultAta: vaultAta.toBase58(), signature };
  });

  // 4. The signer job, live, on devnet.
  const env = {
    SOLANA_CLUSTER: 'devnet',
    FORGE_BUYBACK_LIVE: 'true',
    FORGE_BUYBACK_DEVNET_TEST: 'true',
    BUYBACK_ROUTE: 'dbc-devnet',
    BUYBACK_DEVNET_DBC_POOL: pool.pool,
    FORGE_PLATFORM_FEE_WALLET: wallets.platformFee.publicKey.toBase58(),
    FORGE_METEORA_REFERRAL_ACCOUNT: referral.account,
    FORGE_SQUADS_MULTISIG: multisig.multisigPda,
    FORGE_SQUADS_SPENDING_LIMIT: limit.spendingLimit,
    FORGE_SQUADS_VAULT_INDEX: '0',
    ...BUYBACK_ENV,
  };
  const { config: buybackConfig } = buybackConfigFromEnv(env, { vault, forgeMint });
  const squads = squadsConfigFromEnv(env, vault);
  if (!squads) throw new Error('squads configuration missing');
  const runDir = resolve(STATE_DIR, 'signer-buyback', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });
  const keystore = botKeystore(bot);
  const rpc = rpcFromConnection(conn);
  const alerts: string[] = [];
  const announced: string[] = [];
  // Controlled clock: the day starts "now" so both slices lie ahead; the slot times come from an
  // injected random source (first slice 20 s ahead, second slice at half the day).
  const dayStart = dayStartMs(Date.now());
  const clock = { offset: dayStart + 60 * 60_000 - Date.now() };
  const now = () => Date.now() + clock.offset;
  const draws = [(60 * 60_000 + 20_000) / (DAY_MS / 2), 0, 0.5, 0.5];
  let drawIndex = 0;
  const rng: Rng = () => draws[drawIndex++] ?? 0.5;
  const withdrawer = createSquadsSpendingLimitWithdrawer({
    config: squads,
    connection: conn,
    rpc,
    keystore,
    journal: createSquadsJournal(runDir),
    logger: consoleLogger('squads'),
    now,
  });
  const route = createDbcDevnetBuybackRoute({
    connection: conn,
    pool: poolKey,
    forgeMint,
    env,
    keystore,
    cluster: 'devnet',
    maxPriorityFeeLamports: buybackConfig.maxPriorityFeeLamports,
  });
  const journal = createMemoryJournal(BuybackJournalEntry);
  const job = createBuybackJob({
    config: buybackConfig,
    journal,
    flags: memoryFlags({ buyback_paused: false }),
    alerter: consoleAlerter(alerts),
    logger: consoleLogger('buyback'),
    quotes: route.quotes,
    rng,
    now,
    withdrawer,
    keystore,
    rpc,
    swapPreparer: route.swapPreparer,
    tokens: createRpcForgeTokenReader(conn),
    walletLock: new Mutex(),
    onBeforeSend: (signature) => announced.push(signature),
  });
  console.log(`  job mode: ${job.mode}`);
  if (job.mode !== 'live') throw new Error('the job is not live');

  const before = {
    vaultSol: await getBalance(vault),
    botSol: await getBalance(bot.publicKey),
    vaultCoins: await getTokenAccountBalance(new PublicKey(atas.vaultAta)),
    botCoins: await getTokenAccountBalance(new PublicKey(atas.botAta)),
  };
  const outcomes: BuybackOutcome[] = [];
  const run = async (label: string): Promise<BuybackOutcome> => {
    const r = await job.runOnce();
    console.log(`  run ${label}: ${r.status} ${JSON.stringify(r.outcome ?? {}, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (r.status !== 'ran' || !r.outcome) throw new Error(`run ${label}: ${r.status} ${r.reason ?? ''}`);
    outcomes.push(r.outcome);
    return r.outcome;
  };
  await run('1 (plan + funding)');
  const day = utcDay(now());
  const planned = await journal.get(dayJournalKey(day));
  if (planned?.kind !== 'day') throw new Error('no day plan');
  console.log(`  funding: ${JSON.stringify(planned.funding)}`);
  clock.offset += 25_000;
  const buy1 = await run('2 (first slice)');
  const ret1 = await run('3 (return to the vault)');
  clock.offset += DAY_MS / 2;
  const buy2 = await run('4 (second slice)');
  const ret2 = await run('5 (return to the vault)');
  const idle = await run('6 (nothing left)');
  const after = {
    vaultSol: await getBalance(vault),
    botSol: await getBalance(bot.publicKey),
    vaultCoins: await getTokenAccountBalance(new PublicKey(atas.vaultAta)),
    botCoins: await getTokenAccountBalance(new PublicKey(atas.botAta)),
  };
  const final = await journal.get(dayJournalKey(day));
  const fundingRecord = final?.kind === 'day' ? final.funding : null;
  const withdrawn = fundingRecord?.status === 'confirmed' ? BigInt(fundingRecord.lamports) : 0n;
  const returned = [ret1, ret2].reduce(
    (a, o) => a + (o.result === 'returned' ? o.amount : 0n),
    0n,
  );
  const checks: Array<[string, boolean]> = [
    ['funding confirmed through the spending limit', fundingRecord?.status === 'confirmed'],
    ['first slice bought', buy1.result === 'swapped'],
    ['first return landed', ret1.result === 'returned'],
    ['second slice bought', buy2.result === 'swapped'],
    ['second return landed', ret2.result === 'returned'],
    ['no third order', idle.result === 'idle'],
    ['vault SOL dropped by exactly the withdrawal', before.vaultSol - after.vaultSol === withdrawn],
    ['vault received every bought coin', after.vaultCoins - before.vaultCoins === returned && returned > 0n],
    ['bot keeps no coin', after.botCoins === 0n],
    ['bot keeps its fee reserve', after.botSol >= buybackConfig.feeReserveLamports],
    ['every signature announced to the watcher first', announced.length >= 5],
    ['no alert', alerts.length === 0],
  ];
  const ok = checks.every(([, v]) => v);

  const sig = (o: BuybackOutcome) => ('signature' in o && o.signature ? o.signature : '-');
  const report = new Report('Signer buyback — live loop on devnet (Squads spending limit + DBC route)')
    .h2('Setup')
    .bullet(`Stand-in coin: mint ${accountLink(forgeMint)}, pool ${accountLink(poolKey)}, config ${accountLink(config.config)} (${txLink(config.signature, 'createConfig')}, ${pool.signature === 'existing' ? 'pool existing' : txLink(pool.signature, 'createPool')})`)
    .bullet(`Squads multisig ${accountLink(multisig.multisigPda)}, vault 0 ${accountLink(vault)} (${txLink(multisig.signature, 'multisigCreateV2')}); members: squadsCreator (all permissions, threshold 1), bot ${accountLink(bot.publicKey)} (no permission)`)
    .bullet(`Spending limit ${accountLink(limit.spendingLimit)}: SOL, Day, ${sol(SPENDING_LIMIT_LAMPORTS)}, members = [bot], destinations = [bot]; config transaction #${limit.transactionIndex}: ${Object.entries(limit.signatures).map(([k, v]) => txLink(v, k)).join(', ')}`)
    .bullet(`Vault funded with ${sol(funding.lamports)} (${txLink(funding.signature)}); coin token accounts of the bot and the vault created (${txLink(atas.signature)})`)
    .bullet(`Job settings: cap ${sol(BUYBACK_ENV.BUYBACK_DAILY_CAP_LAMPORTS)}, 2 slices of ${sol(BUYBACK_ENV.BUYBACK_MIN_ORDER_LAMPORTS)} to ${sol(BUYBACK_ENV.BUYBACK_MAX_ORDER_LAMPORTS)}, slippage ${BUYBACK_ENV.BUYBACK_SLIPPAGE_BPS} bps, price impact cap ${BUYBACK_ENV.BUYBACK_MAX_PRICE_IMPACT_BPS} bps, fee reserve ${sol(BUYBACK_ENV.BUYBACK_FEE_RESERVE_LAMPORTS)}, order fee allowance ${sol(buybackConfig.orderFeeAllowanceLamports)}; mode ${job.mode} (FORGE_BUYBACK_DEVNET_TEST=true, BUYBACK_ROUTE=dbc-devnet)`)
    .h2('Run')
    .table(
      ['Step', 'Result', 'Transaction'],
      [
        ['Spending-limit withdrawal (vault -> bot)', `${fundingRecord?.status ?? '-'} ${fundingRecord ? sol(fundingRecord.lamports) : ''}`, fundingRecord?.signature ? txLink(fundingRecord.signature) : '-'],
        ['Slice 1 buy (DBC pool, core buildBuyTx)', `${buy1.result} ${'lamports' in buy1 ? sol(buy1.lamports) : ''}`, txLink(sig(buy1))],
        ['Return 1 (bot -> vault token account)', `${ret1.result} ${'amount' in ret1 ? `${ret1.amount} raw units` : ''}`, txLink(sig(ret1))],
        ['Slice 2 buy', `${buy2.result} ${'lamports' in buy2 ? sol(buy2.lamports) : ''}`, txLink(sig(buy2))],
        ['Return 2', `${ret2.result} ${'amount' in ret2 ? `${ret2.amount} raw units` : ''}`, txLink(sig(ret2))],
        ['Next run', idle.result, '-'],
      ],
    )
    .h2('Balances')
    .table(
      ['Account', 'Before', 'After'],
      [
        ['Vault SOL', sol(before.vaultSol), sol(after.vaultSol)],
        ['Vault coin account', before.vaultCoins.toString(), after.vaultCoins.toString()],
        ['Bot SOL', sol(before.botSol), sol(after.botSol)],
        ['Bot coin account', before.botCoins.toString(), after.botCoins.toString()],
      ],
    )
    .h2('Checks');
  for (const [name, v] of checks) report.bullet(`${v ? 'PASS' : 'FAIL'} — ${name}`);
  report.verdict(ok, ok ? 'the vault funded the bot through its spending limit, the bot bought in two slices and every coin landed in the vault' : 'see the failed checks');
  report.write('signer-buyback.md');
  state.set(`${KEY}.lastRun`, {
    at: new Date().toISOString(),
    ok,
    withdrawal: fundingRecord?.signature ?? null,
    buys: [sig(buy1), sig(buy2)],
    returns: [sig(ret1), sig(ret2)],
  } as Json);
  return ok;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/signer-buyback.ts');
if (isMain) {
  await runMain(async () => {
    const ok = await runSignerBuyback();
    if (!ok) process.exit(1);
  });
}
