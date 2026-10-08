/**
 * Devnet integration of @forge/core: the two DBC configs and the launch of the launchpad coin.
 *
 * 1. Both configs are built from a LaunchpadSpec (`buildCreateConfigTx`), signed by the payer and
 *    the config keypair, sent and confirmed by polling. Their on-chain values are checked.
 * 2. A durable nonce account is created (`buildCreateNonceAccountTx`), authority = creator.
 * 3. The launch transaction (`buildLaunchCoinTx`, durable nonce, first buy <= 0.01 SOL) goes
 *    through the production path: build -> partial sign (creator + mint) -> base64 -> decode ->
 *    the client signs last -> send -> confirm by polling `getSignatureStatuses`.
 *
 * Throwaway devnet wallets: `forgeCreator` = FORGE creator wallet (pool creator, nonce authority,
 * and stand-in for the signer's payer wallet that pays the configs and the nonce account);
 * `client` = the owner (fee claimer and leftover receiver of both configs, fee payer and buyer).
 *
 * Devnet only: refuses to run unless RPC_URL contains "devnet". The environment comes from the
 * caller, e.g. `pnpm exec tsx --env-file=<secrets file> src/core-config-pool.ts`. Resumable: steps
 * already done are read back from `.state/state.json`.
 */
import { PublicKey, SystemInstruction, SystemProgram, type Transaction } from '@solana/web3.js';
import {
  DynamicBondingCurveClient,
  deriveMintMetadata,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { LaunchpadSpec } from '@forge/shared';
import {
  LaunchCoinError,
  METADATA_ACCOUNT_SIZE,
  MAX_TRANSACTION_BYTES,
  MIGRATION_THRESHOLD_LAMPORTS,
  assertLaunchCoinConfig,
  assertRentExempt,
  buildCreateConfigTx,
  buildCreateNonceAccountTx,
  buildLaunchCoinTx,
  confirmSignature,
  deserializeTransactionBase64,
  missingSigners,
  readNonce,
  serializeTransactionBase64,
  transactionSignature,
  type ConfigKind,
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

const KEY = 'coreConfigPool';
const CONFIRM_DEADLINE_MS = 120_000;
const FIRST_BUY = solToLamports(0.01);
const LAUNCHPAD_CREATOR_SHARE_PCT = 20;

const COIN = {
  name: 'Forge Core Devnet Coin',
  symbol: 'FCORE',
  metadataUri: 'https://example.com/forge/core-config-pool/metadata.json',
};

type ConfigStep = { config: string; signature: string; rentLamports: string; txBytes: number };
type NonceStep = {
  nonceAccount: string;
  authority: string;
  signature: string;
  rentLamports: string;
};
type LaunchPending = { mint: string; pool: string; signature: string; nonceBefore: string };
type LaunchStep = {
  signature: string;
  pool: string;
  mint: string;
  txBytes: number;
  firstInstruction: string;
  recentBlockhash: string;
  nonceBefore: string;
  nonceAfter: string;
  signersAfterSignerSide: string[];
  signersAfterClient: string[];
  clientSolBefore: string;
  clientSolAfter: string;
  creatorSolBefore: string;
  creatorSolAfter: string;
  clientTokens: string;
  txFee: string;
  metadataAccountSize: number;
  poolCreator: string;
  event: Record<string, Json> | null;
  summary: Json;
};

function makeSpec(owner: PublicKey): LaunchpadSpec {
  return {
    version: 1,
    ownerWallet: owner.toBase58(),
    name: 'Forge Core Devnet',
    slug: 'forge-core-devnet',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: LAUNCHPAD_CREATOR_SHARE_PCT,
    poolCreationFeeSol: 0.001,
    antiSniper: true,
    theme: {
      primaryColor: '#7C3AED',
      accentColor: '#F59E0B',
      darkMode: true,
      tagline: 'Devnet integration of @forge/core',
      designNotes: '',
    },
    launchpadCoin: {
      name: COIN.name,
      symbol: COIN.symbol,
      description: 'Devnet test coin',
      imageUrl: 'https://example.com/forge/core-config-pool/image.png',
      firstBuySol: 0.01,
    },
  };
}

/** Sends a fully signed transaction and confirms it by polling, with a deadline. */
async function sendAndConfirmRaw(
  transaction: Transaction,
  label: string,
  lastValidBlockHeight?: number,
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
    ...(lastValidBlockHeight !== undefined ? { lastValidBlockHeight } : {}),
  });
  console.log(`    tx ${label} ${signature} (${raw.length} bytes)`);
  return signature;
}

async function readConfig(address: PublicKey): Promise<PoolConfig> {
  const dbc = DynamicBondingCurveClient.create(getConnection(), COMMITMENT);
  const config = await dbc.state.getPoolConfig(address);
  if (!config) throw new Error(`config ${address.toBase58()} not found`);
  return config;
}

export async function runCoreConfigPool(): Promise<boolean> {
  console.log('=== @forge/core — configs + launch coin with durable nonce (devnet) ===');
  const conn = getConnection(); // refuses to run unless RPC_URL contains "devnet"
  const state = State.load();
  const wallets = loadWallets();
  const creator = wallets.forgeCreator;
  const client = wallets.client;
  await ensureFunded(wallets, { forgeCreator: 0.05, client: 0.06 });
  const spec = makeSpec(client.publicKey);

  // 1. Configs.
  const configs = {} as Record<ConfigKind, ConfigStep>;
  for (const kind of ['launchpad', 'launchpadCoin'] as const) {
    configs[kind] = await state.step<ConfigStep>(`${KEY}.config.${kind}`, async () => {
      const keypair = loadOrCreateKeypair(`core-${kind}-config`);
      const existing = await conn.getAccountInfo(keypair.publicKey, COMMITMENT);
      if (existing) {
        // An earlier run sent it but did not record it: recover the signature.
        const [first] = await conn.getSignaturesForAddress(
          keypair.publicKey,
          { limit: 1 },
          COMMITMENT,
        );
        return {
          config: keypair.publicKey.toBase58(),
          signature: first?.signature ?? '',
          rentLamports: String(existing.lamports),
          txBytes: 0,
        };
      }
      const built = await buildCreateConfigTx({
        connection: conn,
        spec,
        kind,
        config: keypair.publicKey,
        payer: creator.publicKey,
      });
      built.transaction.partialSign(creator, keypair);
      const txBytes = built.transaction.serialize().length;
      const signature = await sendAndConfirmRaw(
        built.transaction,
        `createConfig (${kind})`,
        built.lastValidBlockHeight,
      );
      return {
        config: keypair.publicKey.toBase58(),
        signature,
        rentLamports: built.rentLamports.toString(),
        txBytes,
      };
    });
  }
  const launchpadConfigAddress = new PublicKey(configs.launchpad.config);
  const coinConfigAddress = new PublicKey(configs.launchpadCoin.config);
  const launchpadConfig = await readConfig(launchpadConfigAddress);
  const coinConfig = await readConfig(coinConfigAddress);

  let wrongConfigRefused = false;
  try {
    assertLaunchCoinConfig(launchpadConfig, client.publicKey);
  } catch (error) {
    wrongConfigRefused = error instanceof LaunchCoinError && error.code === 'CONFIG_MISMATCH';
  }

  // 2. Durable nonce account (authority = the creator wallet, already a signer of the launch).
  const nonceStep = await state.step<NonceStep>(`${KEY}.nonce`, async () => {
    const keypair = loadOrCreateKeypair('core-nonce');
    const existing = await conn.getAccountInfo(keypair.publicKey, COMMITMENT);
    if (existing) {
      const info = await readNonce(conn, keypair.publicKey, {
        expectedAuthority: creator.publicKey,
      });
      const [first] = await conn.getSignaturesForAddress(
        keypair.publicKey,
        { limit: 1 },
        COMMITMENT,
      );
      return {
        nonceAccount: info.nonceAccount.toBase58(),
        authority: info.authority.toBase58(),
        signature: first?.signature ?? '',
        rentLamports: String(existing.lamports),
      };
    }
    const built = await buildCreateNonceAccountTx({
      connection: conn,
      payer: creator.publicKey,
      nonceAccount: keypair,
      authority: creator.publicKey,
    });
    built.transaction.partialSign(creator, keypair);
    const signature = await sendAndConfirmRaw(
      built.transaction,
      'createNonceAccount',
      built.lastValidBlockHeight,
    );
    return {
      nonceAccount: keypair.publicKey.toBase58(),
      authority: creator.publicKey.toBase58(),
      signature,
      rentLamports: built.rentLamports.toString(),
    };
  });
  const nonceAccount = new PublicKey(nonceStep.nonceAccount);

  // Fee recipient stand-ins must be rent-exempt (devnet finding): read-only pre-flight check.
  let recipientsRentExempt = true;
  try {
    await assertRentExempt(conn, [
      {
        address: wallets.platformFee.publicKey,
        label: 'platformFee (FORGE_PLATFORM_FEE_WALLET stand-in)',
      },
      {
        address: wallets.multisigStandIn.publicKey,
        label: 'multisigStandIn (FORGE_MULTISIG_VAULT stand-in)',
      },
    ]);
  } catch (error) {
    recipientsRentExempt = false;
    console.warn(`  rent check: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 3. Launch with the durable nonce.
  const launch = await state.step<LaunchStep>(`${KEY}.launch`, async () => {
    const pending = state.get<LaunchPending>(`${KEY}.launchPending`);
    if (pending) {
      const status = (
        await conn.getSignatureStatuses([pending.signature], { searchTransactionHistory: true })
      ).value[0];
      if (status && !status.err) {
        throw new Error(
          `launch ${pending.signature} landed in an earlier run but was not recorded: inspect it by hand`,
        );
      }
      if (await conn.getAccountInfo(new PublicKey(pending.pool), COMMITMENT)) {
        throw new Error(`pool ${pending.pool} exists but the launch was not recorded`);
      }
      console.log(`  earlier launch attempt ${pending.signature} did not land: rebuilding`);
    }
    const mint = loadOrCreateKeypair('core-mint');
    const nonceBefore = await readNonce(conn, nonceAccount, {
      expectedAuthority: creator.publicKey,
    });
    const clientSolBefore = await getBalance(client.publicKey);
    const creatorSolBefore = await getBalance(creator.publicKey);

    // Signer side: build, partial sign, serialize.
    const { transaction, summary } = await buildLaunchCoinTx({
      connection: conn,
      config: coinConfigAddress,
      creator: creator.publicKey,
      owner: client.publicKey,
      mint: mint.publicKey,
      name: COIN.name,
      symbol: COIN.symbol,
      metadataUri: COIN.metadataUri,
      firstBuyLamports: FIRST_BUY,
      durableNonce: { nonceAccount, authority: creator.publicKey },
    });
    transaction.partialSign(creator, mint);
    const base64 = serializeTransactionBase64(transaction);
    const signersAfterSignerSide = transaction.signatures
      .filter((s) => s.signature)
      .map((s) => s.publicKey.toBase58());

    // Client side: decode, check, sign last, send, confirm by polling.
    const clientTx = deserializeTransactionBase64(base64);
    const missing = missingSigners(clientTx);
    if (missing.length !== 1 || !missing[0]!.equals(client.publicKey)) {
      throw new Error(`client expected to be the only missing signer, got ${missing.join(', ')}`);
    }
    clientTx.partialSign(client);
    const signersAfterClient = clientTx.signatures
      .filter((s) => s.signature)
      .map((s) => s.publicKey.toBase58());
    const expectedSignature = transactionSignature(clientTx)!;
    state.set(`${KEY}.launchPending`, {
      mint: mint.publicKey.toBase58(),
      pool: summary.pool.toBase58(),
      signature: expectedSignature,
      nonceBefore: nonceBefore.nonce,
    });
    const signature = await sendAndConfirmRaw(clientTx, 'createPoolWithFirstBuy (durable nonce)');

    const firstIx = clientTx.instructions[0]!;
    const firstInstruction = firstIx.programId.equals(SystemProgram.programId)
      ? SystemInstruction.decodeInstructionType(firstIx)
      : firstIx.programId.toBase58();
    const nonceAfter = await readNonce(conn, nonceAccount);
    const pool = poolAddress(coinConfigAddress, mint.publicKey);
    const metadata = await conn.getAccountInfo(deriveMintMetadata(mint.publicKey), COMMITMENT);
    return {
      signature,
      pool: pool.toBase58(),
      mint: mint.publicKey.toBase58(),
      txBytes: Buffer.from(base64, 'base64').length,
      firstInstruction,
      recentBlockhash: clientTx.recentBlockhash ?? '',
      nonceBefore: nonceBefore.nonce,
      nonceAfter: nonceAfter.nonce,
      signersAfterSignerSide,
      signersAfterClient,
      clientSolBefore: clientSolBefore.toString(),
      clientSolAfter: (await getBalance(client.publicKey)).toString(),
      creatorSolBefore: creatorSolBefore.toString(),
      creatorSolAfter: (await getBalance(creator.publicKey)).toString(),
      clientTokens: (
        await getTokenAccountBalance(ata(client.publicKey, mint.publicKey))
      ).toString(),
      txFee: (await getTxFee(signature)).toString(),
      metadataAccountSize: metadata?.data.length ?? -1,
      poolCreator: (await snapshotPool(pool)).creator,
      event: pickSwapEvent(await decodeEvents(signature)),
      summary: jsonify(summary),
    };
  });
  state.delete(`${KEY}.launchPending`);

  // 4. Checks.
  const summary = launch.summary as unknown as Record<string, Json> & {
    costs: Record<string, string>;
    expectedTokensOut: string;
  };
  const costs = summary.costs;
  const clientDebit = BigInt(launch.clientSolBefore) - BigInt(launch.clientSolAfter);
  const eventFee = launch.event
    ? BigInt(String(launch.event.tradingFee)) +
      BigInt(String(launch.event.protocolFee)) +
      BigInt(String(launch.event.referralFee))
    : -1n;
  const owner = client.publicKey;
  const configChecks = (c: PoolConfig, creatorPct: number): boolean =>
    c.feeClaimer.equals(owner) &&
    c.leftoverReceiver.equals(owner) &&
    c.creatorTradingFeePercentage === creatorPct &&
    c.creatorPermanentLockedLiquidityPercentage === creatorPct &&
    c.partnerPermanentLockedLiquidityPercentage === 100 - creatorPct &&
    BigInt(c.poolCreationFee.toString()) === 1_000_000n &&
    BigInt(c.migrationQuoteThreshold.toString()) === MIGRATION_THRESHOLD_LAMPORTS &&
    c.enableFirstSwapWithMinFee === 1 &&
    c.tokenUpdateAuthority === 1 &&
    c.poolFees.baseFee.firstFactor === 10 &&
    BigInt(c.poolFees.baseFee.secondFactor.toString()) === 6n &&
    BigInt(c.poolFees.baseFee.cliffFeeNumerator.toString()) === 990_000_000n;

  const checks: Array<[string, boolean]> = [
    [
      `launchpad config on-chain: fee claimer = leftover receiver = client, creator share ${LAUNCHPAD_CREATOR_SHARE_PCT}%, 0.001 SOL creation fee, 10 SOL threshold, anti-sniper 99% -> 1% in 10 x 6 s, immutable metadata, first swap at minimum fee`,
      configChecks(launchpadConfig, LAUNCHPAD_CREATOR_SHARE_PCT),
    ],
    [
      'launchpad coin config on-chain: same, creator share 25% (FORGE)',
      configChecks(coinConfig, 25),
    ],
    ['the launchpad config is refused as a launch coin config', wrongConfigRefused],
    ['fee recipient stand-ins are rent-exempt', recipientsRentExempt],
    ['first instruction is nonceAdvance', launch.firstInstruction === 'AdvanceNonceAccount'],
    [
      'recentBlockhash = nonce value read before the launch',
      launch.recentBlockhash === launch.nonceBefore,
    ],
    ['the nonce advanced', launch.nonceAfter !== launch.nonceBefore],
    [
      'creator + mint signed on the signer side, the client signed last',
      launch.signersAfterSignerSide.length === 2 &&
        launch.signersAfterSignerSide.includes(creator.publicKey.toBase58()) &&
        launch.signersAfterSignerSide.includes(launch.mint) &&
        launch.signersAfterClient.length === 3 &&
        launch.signersAfterClient.includes(owner.toBase58()),
    ],
    ['transaction fits the size limit', launch.txBytes <= MAX_TRANSACTION_BYTES],
    [
      'pool creator is the FORGE creator wallet',
      launch.poolCreator === creator.publicKey.toBase58(),
    ],
    [
      'client received exactly the quoted tokens',
      launch.clientTokens === summary.expectedTokensOut &&
        String(launch.event?.outputAmount) === summary.expectedTokensOut,
    ],
    [
      'first buy paid the minimum fee (1%), as summarized',
      eventFee === FIRST_BUY / 100n && eventFee === BigInt(costs.firstBuyFeeLamports!),
    ],
    [
      'client debit = summary.costs.ownerTotalLamports',
      clientDebit === BigInt(costs.ownerTotalLamports!),
    ],
    ['network fee = summary', BigInt(launch.txFee) === BigInt(costs.networkFeeLamports!)],
    [
      'creator wallet not debited by the launch (needs no SOL)',
      launch.creatorSolBefore === launch.creatorSolAfter,
    ],
    [
      'metadata account size = METADATA_ACCOUNT_SIZE',
      launch.metadataAccountSize === METADATA_ACCOUNT_SIZE,
    ],
  ];
  const ok = checks.every(([, c]) => c);

  // 5. Report.
  const r = new Report('@forge/core — configs and launch coin with durable nonce');
  r.p(
    'Goal: run the production path of `@forge/core` on devnet: both configs built from a LaunchpadSpec, a durable nonce account, and the launch transaction (pool creation + first buy) built by `buildLaunchCoinTx`, partially signed by the creator wallet and the mint, serialized to base64, decoded, signed last by the client, sent and confirmed by polling `getSignatureStatuses`.',
  );
  r.h2('Wallets');
  r.bullet(
    `forgeCreator (pool creator, nonce authority, payer of the configs and the nonce account): ${accountLink(creator.publicKey)}`,
  );
  r.bullet(
    `client (owner: fee claimer + leftover receiver of both configs, fee payer, buyer): ${accountLink(owner)}`,
  );
  r.h2('Transactions');
  r.table(
    ['Step', 'Account', 'Transaction', 'Notes'],
    [
      [
        'createConfig (launchpad)',
        accountLink(configs.launchpad.config, configs.launchpad.config),
        configs.launchpad.signature ? txLink(configs.launchpad.signature) : 'recovered',
        `rent ${sol(configs.launchpad.rentLamports)}`,
      ],
      [
        'createConfig (launchpad coin)',
        accountLink(configs.launchpadCoin.config, configs.launchpadCoin.config),
        configs.launchpadCoin.signature ? txLink(configs.launchpadCoin.signature) : 'recovered',
        `rent ${sol(configs.launchpadCoin.rentLamports)}`,
      ],
      [
        'createNonceAccount',
        accountLink(nonceStep.nonceAccount, nonceStep.nonceAccount),
        nonceStep.signature ? txLink(nonceStep.signature) : 'recovered',
        `rent ${sol(nonceStep.rentLamports)}, authority forgeCreator`,
      ],
      [
        'createPoolWithFirstBuy (durable nonce)',
        accountLink(launch.pool, launch.pool),
        txLink(launch.signature),
        `${launch.txBytes} bytes, mint ${accountLink(launch.mint, launch.mint)}`,
      ],
    ],
  );
  r.h2('Signatures (full)');
  r.code(
    [
      `createConfig launchpad      ${configs.launchpad.signature}`,
      `createConfig launchpad coin ${configs.launchpadCoin.signature}`,
      `createNonceAccount          ${nonceStep.signature}`,
      `launch (durable nonce)      ${launch.signature}`,
    ].join('\n'),
  );
  r.h2('Launch transaction');
  r.bullet(
    `First instruction: ${launch.firstInstruction}; recentBlockhash ${launch.recentBlockhash} = nonce before (${launch.nonceBefore}); nonce after ${launch.nonceAfter}`,
  );
  r.bullet(`Signatures after the signer side: ${launch.signersAfterSignerSide.join(', ')}`);
  r.bullet(`Signatures after the client: ${launch.signersAfterClient.join(', ')}`);
  r.bullet(
    `Pool creator: ${launch.poolCreator}; client tokens: ${launch.clientTokens} (quoted ${summary.expectedTokensOut})`,
  );
  r.bullet(
    `Client SOL ${launch.clientSolBefore} -> ${launch.clientSolAfter} (debit ${sol(clientDebit)})`,
  );
  r.bullet(`forgeCreator SOL ${launch.creatorSolBefore} -> ${launch.creatorSolAfter}`);
  r.bullet(
    `Network fee paid: ${sol(launch.txFee)}; metadata account size ${launch.metadataAccountSize} bytes`,
  );
  r.h2('Summary shown before signing (lamports)');
  r.table(
    ['Item', 'Lamports'],
    Object.entries(costs).map(([k, v]) => [k, String(v)]),
  );
  r.h2('Checks');
  for (const [label, c] of checks) r.bullet(`${c ? 'OK' : 'FAIL'} — ${label}`);
  r.blank();
  r.verdict(
    ok,
    ok
      ? 'the configs and the durable-nonce launch built by @forge/core work end to end on devnet.'
      : 'see the failed checks above.',
  );
  r.write('core-config-pool.md');
  state.set(`${KEY}.result`, { ok, checks: checks.map(([label, c]) => ({ label, ok: c })) });
  for (const [label, c] of checks) console.log(`  ${c ? 'OK  ' : 'FAIL'} ${label}`);
  return ok;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/core-config-pool.ts');
if (isMain) {
  await runMain(async () => {
    const ok = await runCoreConfigPool();
    if (!ok) process.exitCode = 1;
  });
}
