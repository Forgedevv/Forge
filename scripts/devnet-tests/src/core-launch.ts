/**
 * Devnet check of the wave 4 launch changes of @forge/core.
 *
 * 1. Launchpad coin launch (`buildLaunchCoinTx`, recent blockhash) on the launchpad coin config
 *    created by core-config-pool (fee claimer = `client`): pool creator = `forgeCreator`, owner =
 *    `client`, first buy 0.001 SOL. Before sending, the same transaction is simulated (free,
 *    sigVerify off) twice: as built (no referral) and with a referral token account put in the
 *    swap's referral slot, to re-check the finding that a referral on the first buy loses the
 *    first-swap minimum fee. Core must also refuse an explicit referral (`REFERRAL_UNSUPPORTED`).
 *    Then the launch is signed (creator + mint, then the client last) and sent; it must land at
 *    the quote, at the 1% minimum fee, and debit the client exactly the summary.
 * 2. User coin launch (`buildUserCoinLaunchTx`) on the launchpad config of core-config-pool by
 *    `trader`: pool creator = rent payer = fee payer = buyer = trader, the mint signs too.
 * 3. Seeded nonce account (`buildCreateNonceAccountWithSeedTx`): created from base `forgeCreator`
 *    and a fixed seed, read back at the re-derived address (`deriveSeededNonceAccount` +
 *    `readNonce`), then withdrawn back to `forgeCreator` (closes it, the rent comes back).
 *
 * Devnet only: refuses to run unless RPC_URL contains "devnet". Run with the environment from the
 * caller: `node --env-file=<secrets file> --import tsx src/core-launch.ts`. Resumable: finished
 * steps are read back from `.state/state.json`. Spend: about 0.025 SOL per launch (rent, Metaplex
 * fee, creation fee, first buy) plus fees.
 */
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type Keypair,
} from '@solana/web3.js';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  LaunchCoinError,
  assertSignedCopyOf,
  buildCreateNonceAccountWithSeedTx,
  buildLaunchCoinTx,
  buildUserCoinLaunchTx,
  confirmSignature,
  deriveSeededNonceAccount,
  deserializeTransactionBase64,
  readNonce,
  serializeTransactionBase64,
  transactionSignature,
} from '../../../packages/core/src/index.js';
import { ensureFunded, runMain } from './lib/funding.js';
import { State, type Json } from './lib/state.js';
import { loadOrCreateKeypair, loadWallets } from './lib/wallets.js';
import {
  COMMITMENT,
  ata,
  getBalance,
  getConnection,
  getTokenAccountBalance,
  getTxFee,
} from './lib/solana.js';
import { decodeEvents, jsonify, pickSwapEvent, poolAddress, snapshotPool } from './lib/dbc.js';
import { solToLamports } from './lib/math.js';
import { Report, accountLink, sol, txLink } from './lib/report.js';

const KEY = 'coreLaunch';
const CONFIRM_DEADLINE_MS = 120_000;
const FIRST_BUY = solToLamports(0.001);
/** Launchpad coin config of core-config-pool (reports/core-config-pool.md), fee claimer = client. */
const COIN_CONFIG = new PublicKey('GkTXTK179N4gBi64rk2pp1KbpWrjgMv6LENf8mQrqh8J');
/** Launchpad config of core-config-pool (reports/core-config-pool.md), fee claimer = client. */
const LAUNCHPAD_CONFIG = new PublicKey('HKn8RwgnguT8SisxfgnMg8EsPsJY2sq7PjnQ3UHvVjws');
/** Seed of the deterministic nonce account (base = forgeCreator). */
const NONCE_SEED = 'forge-core-launch-check-v1';
/** Index of `referral_token_account` in the DBC swap accounts. */
const SWAP_REFERRAL_INDEX = 12;
/** DBC `ExceededSlippage`. */
const EXCEEDED_SLIPPAGE = 6002;

type Simulation = { ok: boolean; error: string | null; exceededSlippage: boolean };

type LaunchStep = {
  signature: string;
  pool: string;
  mint: string;
  txBytes: number;
  payerSolBefore: string;
  payerSolAfter: string;
  creatorSolBefore: string | null;
  creatorSolAfter: string | null;
  tokens: string;
  txFee: string;
  poolCreator: string;
  event: Record<string, Json> | null;
  simulationWithoutReferral: Simulation;
  simulationWithReferral: Simulation;
  explicitReferralRefused: boolean | null;
  summary: Json;
};

type NonceStep = {
  nonceAccount: string;
  createSignature: string;
  rentLamports: string;
  rederived: boolean;
  authorityRead: string;
  nonceValue: string;
  withdrawSignature: string;
  closedAfterWithdraw: boolean;
  baseSolBefore: string;
  baseSolAfter: string;
  fees: string;
};

/** Sends a fully signed transaction (preflight on) and confirms it by polling. */
async function sendSigned(
  transaction: Transaction,
  label: string,
  lastValidBlockHeight: number,
): Promise<string> {
  const conn = getConnection();
  const raw = Buffer.from(
    serializeTransactionBase64(transaction, { requireAllSignatures: true }),
    'base64',
  );
  const expected = transactionSignature(transaction);
  let signature: string;
  try {
    signature = await conn.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: COMMITMENT,
      maxRetries: 5,
    });
  } catch (error) {
    const logs = (error as { logs?: string[] }).logs;
    if (logs) console.error(logs.join('\n'));
    throw error;
  }
  if (signature !== expected) throw new Error(`unexpected signature ${signature} != ${expected}`);
  await confirmSignature(conn, signature, {
    deadlineMs: CONFIRM_DEADLINE_MS,
    lastValidBlockHeight,
  });
  console.log(`    tx ${label} ${signature} (${raw.length} bytes)`);
  return signature;
}

/** Simulates an unsigned legacy transaction (no signature check, fresh blockhash: no cost). */
async function simulate(transaction: Transaction): Promise<Simulation> {
  const result = await getConnection().simulateTransaction(
    new VersionedTransaction(transaction.compileMessage()),
    { sigVerify: false, replaceRecentBlockhash: true, commitment: COMMITMENT },
  );
  const err = result.value.err;
  const custom =
    err && typeof err === 'object' && 'InstructionError' in err
      ? (err.InstructionError as [number, unknown])[1]
      : null;
  const exceededSlippage =
    (typeof custom === 'object' &&
      custom !== null &&
      (custom as { Custom?: number }).Custom === EXCEEDED_SLIPPAGE) ||
    (result.value.logs ?? []).some((l) => /ExceededSlippage/.test(l));
  return { ok: err === null, error: err === null ? null : JSON.stringify(err), exceededSlippage };
}

/**
 * A copy of the transaction with `referral` in the referral slot of its DBC swap (the last DBC
 * instruction: the pool creation comes first). The original is left untouched.
 */
function withReferralOnFirstBuy(transaction: Transaction, referral: PublicKey): Transaction {
  const instructions = transaction.instructions.map(
    (ix) =>
      new TransactionInstruction({
        programId: ix.programId,
        keys: ix.keys.map((k) => ({ ...k })),
        data: Buffer.from(ix.data),
      }),
  );
  const swap = [...instructions]
    .reverse()
    .find((ix) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID));
  const slot = swap?.keys[SWAP_REFERRAL_INDEX];
  if (!swap || !slot || !slot.pubkey.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) {
    throw new Error('no first buy with an empty referral slot in the launch transaction');
  }
  swap.keys[SWAP_REFERRAL_INDEX] = { pubkey: referral, isSigner: false, isWritable: true };
  const copy = new Transaction({
    feePayer: transaction.feePayer!,
    blockhash: transaction.recentBlockhash!,
    lastValidBlockHeight: transaction.lastValidBlockHeight!,
  });
  return copy.add(...instructions);
}

async function launchStep(
  state: State,
  key: string,
  run: () => Promise<LaunchStep>,
  poolOfPending: () => PublicKey,
): Promise<LaunchStep> {
  const conn = getConnection();
  const pendingKey = `${key}Pending`;
  const step = await state.step<LaunchStep>(key, async () => {
    const pending = state.get<{ signature: string }>(pendingKey);
    if (pending) {
      const status = (
        await conn.getSignatureStatuses([pending.signature], { searchTransactionHistory: true })
      ).value[0];
      if (status && !status.err) {
        throw new Error(`launch ${pending.signature} landed in an earlier run: inspect it by hand`);
      }
      if (await conn.getAccountInfo(poolOfPending(), COMMITMENT)) {
        throw new Error('the pool exists but the launch was not recorded: inspect it by hand');
      }
    }
    return run();
  });
  if (state.has(pendingKey)) state.delete(pendingKey);
  return step;
}

export async function runCoreLaunch(): Promise<boolean> {
  console.log('=== @forge/core — launches without referral, user coin, seeded nonce (devnet) ===');
  const conn = getConnection(); // refuses to run unless RPC_URL contains "devnet"
  const state = State.load();
  const wallets = loadWallets();
  const creator = wallets.forgeCreator;
  const client = wallets.client;
  const trader = wallets.trader;
  const referral = new PublicKey(
    state.require<{ tokenAccount: string }>('test4.referralAccount').tokenAccount,
  );
  await ensureFunded(wallets, { client: 0.035, trader: 0.05, forgeCreator: 0.01 });

  // 1. Launchpad coin, no referral on the first buy.
  console.log('\n=== 1. launchpad coin (buildLaunchCoinTx) ===');
  const coinMint = loadOrCreateKeypair('core-launch-mint');
  const coin = await launchStep(
    state,
    `${KEY}.coin`,
    async () => {
      const params = {
        connection: conn,
        config: COIN_CONFIG,
        creator: creator.publicKey,
        owner: client.publicKey,
        mint: coinMint.publicKey,
        name: 'Forge Launch Check',
        symbol: 'FLAUNCH',
        metadataUri: 'https://example.com/forge/core-launch/metadata.json',
        firstBuyLamports: FIRST_BUY,
      };
      let explicitReferralRefused = false;
      try {
        await buildLaunchCoinTx({ ...params, referralTokenAccount: referral });
      } catch (error) {
        explicitReferralRefused =
          error instanceof LaunchCoinError && error.code === 'REFERRAL_UNSUPPORTED';
      }
      const { transaction, summary } = await buildLaunchCoinTx(params);
      const simulationWithoutReferral = await simulate(transaction);
      const simulationWithReferral = await simulate(withReferralOnFirstBuy(transaction, referral));
      console.log(`  simulation without referral: ${JSON.stringify(simulationWithoutReferral)}`);
      console.log(`  simulation with referral:    ${JSON.stringify(simulationWithReferral)}`);
      if (!simulationWithoutReferral.ok) throw new Error('the launch as built fails in simulation');

      // Signer side, then the client last, then the web check, as in production.
      transaction.partialSign(creator, coinMint);
      const stored = serializeTransactionBase64(transaction);
      const clientTx = deserializeTransactionBase64(stored);
      clientTx.partialSign(client);
      const toSend = assertSignedCopyOf(
        stored,
        serializeTransactionBase64(clientTx, { requireAllSignatures: true }),
      );
      const payerSolBefore = await getBalance(client.publicKey);
      const creatorSolBefore = await getBalance(creator.publicKey);
      state.set(`${KEY}.coinPending`, { signature: transactionSignature(toSend)! });
      const signature = await sendSigned(toSend, 'launch coin', summary.lastValidBlockHeight!);
      return {
        signature,
        pool: summary.pool.toBase58(),
        mint: coinMint.publicKey.toBase58(),
        txBytes: summary.txBytes,
        payerSolBefore: payerSolBefore.toString(),
        payerSolAfter: (await getBalance(client.publicKey)).toString(),
        creatorSolBefore: creatorSolBefore.toString(),
        creatorSolAfter: (await getBalance(creator.publicKey)).toString(),
        tokens: (
          await getTokenAccountBalance(ata(client.publicKey, coinMint.publicKey))
        ).toString(),
        txFee: (await getTxFee(signature)).toString(),
        poolCreator: (await snapshotPool(summary.pool)).creator,
        event: pickSwapEvent(await decodeEvents(signature)),
        simulationWithoutReferral,
        simulationWithReferral,
        explicitReferralRefused,
        summary: jsonify(summary),
      };
    },
    () => poolAddress(COIN_CONFIG, coinMint.publicKey),
  );

  // 2. User coin on the client's launchpad config.
  console.log('\n=== 2. user coin (buildUserCoinLaunchTx) ===');
  const userMint = loadOrCreateKeypair('core-user-coin-mint');
  const user = await launchStep(
    state,
    `${KEY}.userCoin`,
    async () => {
      const { transaction, summary } = await buildUserCoinLaunchTx({
        connection: conn,
        config: LAUNCHPAD_CONFIG,
        wallet: trader.publicKey,
        mint: userMint.publicKey,
        name: 'Forge User Coin Check',
        symbol: 'FUSER',
        metadataUri: 'https://example.com/forge/core-launch/user-coin.json',
        firstBuyLamports: FIRST_BUY,
      });
      const simulationWithoutReferral = await simulate(transaction);
      const simulationWithReferral = await simulate(withReferralOnFirstBuy(transaction, referral));
      console.log(`  simulation without referral: ${JSON.stringify(simulationWithoutReferral)}`);
      console.log(`  simulation with referral:    ${JSON.stringify(simulationWithReferral)}`);
      if (!simulationWithoutReferral.ok) throw new Error('the launch as built fails in simulation');

      // The mint signs first (server side in the template), the user last (wallet).
      transaction.partialSign(userMint);
      const userTx = deserializeTransactionBase64(serializeTransactionBase64(transaction));
      userTx.partialSign(trader);
      const payerSolBefore = await getBalance(trader.publicKey);
      state.set(`${KEY}.userCoinPending`, { signature: transactionSignature(userTx)! });
      const signature = await sendSigned(userTx, 'user coin', summary.lastValidBlockHeight);
      return {
        signature,
        pool: summary.pool.toBase58(),
        mint: userMint.publicKey.toBase58(),
        txBytes: summary.txBytes,
        payerSolBefore: payerSolBefore.toString(),
        payerSolAfter: (await getBalance(trader.publicKey)).toString(),
        creatorSolBefore: null,
        creatorSolAfter: null,
        tokens: (
          await getTokenAccountBalance(ata(trader.publicKey, userMint.publicKey))
        ).toString(),
        txFee: (await getTxFee(signature)).toString(),
        poolCreator: (await snapshotPool(summary.pool)).creator,
        event: pickSwapEvent(await decodeEvents(signature)),
        simulationWithoutReferral,
        simulationWithReferral,
        explicitReferralRefused: null,
        summary: jsonify(summary),
      };
    },
    () => poolAddress(LAUNCHPAD_CONFIG, userMint.publicKey),
  );

  // 3. Seeded nonce account: create, re-derive, read, withdraw.
  console.log('\n=== 3. seeded nonce account ===');
  const nonce = await state.step<NonceStep>(`${KEY}.seededNonce`, async () => {
    const baseSolBefore = await getBalance(creator.publicKey);
    const built = await buildCreateNonceAccountWithSeedTx({
      connection: conn,
      base: creator.publicKey,
      seed: NONCE_SEED,
      authority: creator.publicKey,
    });
    let createSignature = '';
    if (await conn.getAccountInfo(built.nonceAccount, COMMITMENT)) {
      console.log('  the seeded nonce account already exists: reading it');
    } else {
      built.transaction.sign(creator);
      createSignature = await sendSigned(
        built.transaction,
        'create seeded nonce',
        built.lastValidBlockHeight,
      );
    }
    const rederived = await deriveSeededNonceAccount(creator.publicKey, NONCE_SEED);
    const info = await readNonce(conn, rederived, { expectedAuthority: creator.publicKey });
    const balance = await conn.getBalance(rederived, COMMITMENT);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(COMMITMENT);
    const withdraw = new Transaction({
      feePayer: creator.publicKey,
      blockhash,
      lastValidBlockHeight,
    });
    withdraw.add(
      SystemProgram.nonceWithdraw({
        noncePubkey: rederived,
        authorizedPubkey: creator.publicKey,
        toPubkey: creator.publicKey,
        lamports: balance,
      }),
    );
    withdraw.sign(creator);
    const withdrawSignature = await sendSigned(withdraw, 'withdraw nonce', lastValidBlockHeight);
    const baseSolAfter = await getBalance(creator.publicKey);
    const fees =
      (createSignature ? await getTxFee(createSignature) : 0n) +
      (await getTxFee(withdrawSignature));
    return {
      nonceAccount: built.nonceAccount.toBase58(),
      createSignature,
      rentLamports: built.rentLamports.toString(),
      rederived: rederived.equals(built.nonceAccount),
      authorityRead: info.authority.toBase58(),
      nonceValue: info.nonce,
      withdrawSignature,
      closedAfterWithdraw: (await conn.getAccountInfo(rederived, COMMITMENT)) === null,
      baseSolBefore: baseSolBefore.toString(),
      baseSolAfter: baseSolAfter.toString(),
      fees: fees.toString(),
    };
  });

  // 4. Checks.
  type Costs = Record<string, string>;
  const costsOf = (s: LaunchStep) => (s.summary as { costs: Costs }).costs;
  const expectedOf = (s: LaunchStep) =>
    (s.summary as { expectedTokensOut: string }).expectedTokensOut;
  const eventFee = (s: LaunchStep) =>
    s.event
      ? BigInt(String(s.event.tradingFee)) +
        BigInt(String(s.event.protocolFee)) +
        BigInt(String(s.event.referralFee))
      : -1n;
  const launchChecks = (label: string, s: LaunchStep, payer: Keypair): Array<[string, boolean]> => [
    [
      `${label}: the transaction as built (no referral) succeeds in simulation`,
      s.simulationWithoutReferral.ok,
    ],
    [
      `${label}: the same transaction with a referral on the first buy fails with ExceededSlippage`,
      !s.simulationWithReferral.ok && s.simulationWithReferral.exceededSlippage,
    ],
    [`${label}: the first buy carried no referral`, s.event?.hasReferral === false],
    [
      `${label}: received exactly the quoted tokens`,
      s.tokens === expectedOf(s) && String(s.event?.outputAmount) === expectedOf(s),
    ],
    [
      `${label}: first buy paid the minimum fee (1%), as summarized`,
      eventFee(s) === FIRST_BUY / 100n && eventFee(s) === BigInt(costsOf(s).firstBuyFeeLamports!),
    ],
    [
      `${label}: payer debit = summary.costs.ownerTotalLamports`,
      BigInt(s.payerSolBefore) - BigInt(s.payerSolAfter) === BigInt(costsOf(s).ownerTotalLamports!),
    ],
    [`${label}: network fee = summary`, BigInt(s.txFee) === BigInt(costsOf(s).networkFeeLamports!)],
    [
      `${label}: pool creator is ${payer === trader ? 'the user' : 'the FORGE creator wallet'}`,
      s.poolCreator === (payer === trader ? trader : creator).publicKey.toBase58(),
    ],
  ];
  const checks: Array<[string, boolean]> = [
    [
      'core refuses an explicit referral on the first buy (REFERRAL_UNSUPPORTED)',
      coin.explicitReferralRefused === true,
    ],
    ...launchChecks('launchpad coin', coin, client),
    [
      'launchpad coin: the creator wallet was not debited',
      coin.creatorSolBefore === coin.creatorSolAfter,
    ],
    ...launchChecks('user coin', user, trader),
    ['seeded nonce: the address re-derived from base + seed is the created one', nonce.rederived],
    [
      'seeded nonce: readNonce accepts it, authority = forgeCreator',
      nonce.authorityRead === creator.publicKey.toBase58() && nonce.nonceValue.length > 0,
    ],
    ['seeded nonce: closed by the withdrawal', nonce.closedAfterWithdraw],
    [
      'seeded nonce: only the fees were spent (rent came back)',
      BigInt(nonce.baseSolBefore) - BigInt(nonce.baseSolAfter) === BigInt(nonce.fees),
    ],
  ];
  const ok = checks.every(([, c]) => c);

  // 5. Report.
  const r = new Report('@forge/core — launches without referral, user coin, seeded nonce');
  r.p(
    'Goal: check on devnet the wave 4 launch changes of `@forge/core`: no referral on the first buy of `buildLaunchCoinTx` (and the finding behind it), the new `buildUserCoinLaunchTx`, and the seeded durable nonce account of `buildCreateNonceAccountWithSeedTx`.',
  );
  r.h2('Finding: no referral on the first buy');
  r.p(
    'Each launch transaction was simulated before sending (sigVerify off, no cost): as built by core, and with a referral token account put in the referral slot of the first buy. With the referral, the DBC program does not apply the first-swap minimum fee: the swap pays the anti-sniper fee and fails with `ExceededSlippage` (6002). Without it, the launch lands exactly at the quote. Core therefore never adds a referral to the first buy and refuses an explicit one.',
  );
  r.table(
    ['Launch', 'Without referral (as built)', `With the referral ${accountLink(referral)}`],
    [
      [
        'launchpad coin',
        coin.simulationWithoutReferral.ok
          ? 'succeeds'
          : `fails: ${coin.simulationWithoutReferral.error}`,
        coin.simulationWithReferral.ok ? 'succeeds' : `fails: ${coin.simulationWithReferral.error}`,
      ],
      [
        'user coin',
        user.simulationWithoutReferral.ok
          ? 'succeeds'
          : `fails: ${user.simulationWithoutReferral.error}`,
        user.simulationWithReferral.ok ? 'succeeds' : `fails: ${user.simulationWithReferral.error}`,
      ],
    ],
  );
  r.h2('Transactions');
  r.table(
    ['Step', 'Account', 'Transaction', 'Notes'],
    [
      [
        'launchpad coin (owner client, creator forgeCreator)',
        accountLink(coin.pool, coin.pool),
        txLink(coin.signature),
        `${coin.txBytes} bytes, config ${accountLink(COIN_CONFIG)}`,
      ],
      [
        'user coin (wallet trader)',
        accountLink(user.pool, user.pool),
        txLink(user.signature),
        `${user.txBytes} bytes, config ${accountLink(LAUNCHPAD_CONFIG)}`,
      ],
      [
        'seeded nonce creation',
        accountLink(nonce.nonceAccount, nonce.nonceAccount),
        nonce.createSignature ? txLink(nonce.createSignature) : 'existed',
        `seed \`${NONCE_SEED}\`, base forgeCreator, rent ${sol(nonce.rentLamports)}`,
      ],
      [
        'seeded nonce withdrawal',
        accountLink(nonce.nonceAccount, nonce.nonceAccount),
        txLink(nonce.withdrawSignature),
        'all lamports back to forgeCreator',
      ],
    ],
  );
  r.h2('Signatures (full)');
  r.code(
    [
      `launchpad coin        ${coin.signature}`,
      `user coin             ${user.signature}`,
      `seeded nonce create   ${nonce.createSignature}`,
      `seeded nonce withdraw ${nonce.withdrawSignature}`,
    ].join('\n'),
  );
  for (const [label, s] of [
    ['Launchpad coin', coin],
    ['User coin', user],
  ] as const) {
    r.h2(label);
    r.bullet(`Mint ${accountLink(s.mint, s.mint)}; pool creator ${s.poolCreator}`);
    r.bullet(`Tokens received: ${s.tokens} (quoted ${expectedOf(s)})`);
    r.bullet(
      `First buy fee (event): ${sol(eventFee(s))}; referral on the swap: ${String(s.event?.hasReferral)}`,
    );
    r.bullet(
      `Payer SOL ${s.payerSolBefore} -> ${s.payerSolAfter} (debit ${sol(BigInt(s.payerSolBefore) - BigInt(s.payerSolAfter))})`,
    );
    r.blank();
    r.table(
      ['Summary shown before signing', 'Lamports'],
      Object.entries(costsOf(s)).map(([k, v]) => [k, String(v)]),
    );
  }
  r.h2('Checks');
  for (const [label, c] of checks) r.bullet(`${c ? 'OK' : 'FAIL'} — ${label}`);
  r.blank();
  r.verdict(
    ok,
    ok
      ? 'launches without referral land at the quote, the user coin builder works, and the seeded nonce account can be re-derived.'
      : 'see the failed checks above.',
  );
  r.write('core-launch.md');
  state.set(`${KEY}.result`, { ok, checks: checks.map(([label, c]) => ({ label, ok: c })) });
  for (const [label, c] of checks) console.log(`  ${c ? 'OK  ' : 'FAIL'} ${label}`);
  return ok;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/core-launch.ts');
if (isMain) {
  await runMain(async () => {
    const ok = await runCoreLaunch();
    if (!ok) process.exitCode = 1;
  });
}
