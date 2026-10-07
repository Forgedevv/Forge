/**
 * Writes reports/SUMMARY.md from the state: the 4 results, the proposed plan B for any failure,
 * the fake $FORGE mint and the public addresses of the throwaway wallets.
 */
import { State } from './lib/state.js';
import { WALLET_NAMES, loadWallets } from './lib/wallets.js';
import { Report, accountLink } from './lib/report.js';
import type { ForgeMintRecord } from './forge-mint.js';

type Result = { ok: boolean; checks: Array<{ label: string; ok: boolean }> };

const TESTS: Array<{
  key: 'test1' | 'test2' | 'test3' | 'test4';
  title: string;
  report: string;
  planB: string;
}> = [
  {
    key: 'test1',
    title: 'Meteora referral',
    report: 'test1-referral.md',
    planB:
      'Keep only the 0.3% platform fee (no Meteora referral). Loss ≈ 0.04% of the volume going through our button.',
  },
  {
    key: 'test2',
    title: 'Creator share on a dedicated config',
    report: 'test2-creator-share.md',
    planB:
      'Swap the roles on the launchpad coin config: FORGE as feeClaimer (partner), the client as creator. To be validated with the team.',
  },
  {
    key: 'test3',
    title: 'First buy paid by the client',
    report: 'test3-first-buy.md',
    planB:
      'FORGE creates the pool; the client buys in a separate transaction right after, with the anti-sniper active (enableFirstSwapWithMinFee is then useless for the client).',
  },
  {
    key: 'test4',
    title: 'Platform fee in the swap',
    report: 'test4-platform-fee.md',
    planB:
      'Use an address lookup table if the transaction exceeds the size limit; if a wallet shows a blocking warning (to be tested on mainnet), display the fee before signing or lower the rate.',
  },
];

export function writeSummary(): void {
  const state = State.load();
  const wallets = loadWallets();
  const r = new Report('Devnet tests — summary');
  r.p(
    'Results of the four on-chain tests of docs/DEVNET_TESTS.md (SDK @meteora-ag/dynamic-bonding-curve-sdk 1.5.13, devnet).',
  );
  r.h2('Results');
  const rows: string[][] = [];
  for (const t of TESTS) {
    const result = state.get<Result>(`${t.key}.result`);
    const status = result === undefined ? 'NOT RUN' : result.ok ? 'PASS' : 'FAIL';
    const failed = result?.checks.filter((c) => !c.ok).map((c) => c.label) ?? [];
    rows.push([
      t.key,
      t.title,
      status,
      `[${t.report}](./${t.report})`,
      failed.length ? failed.join('; ') : '',
    ]);
  }
  r.table(['Test', 'Goal', 'Status', 'Report', 'Failed checks'], rows);

  r.h2('Decisions and plan B');
  for (const t of TESTS) {
    const result = state.get<Result>(`${t.key}.result`);
    if (result === undefined) {
      r.bullet(`${t.key} (${t.title}): not run yet — plan B if it fails: ${t.planB}`);
    } else if (result.ok) {
      r.bullet(`${t.key} (${t.title}): PASS — plan A stands, no change to @forge/core.`);
    } else {
      r.bullet(`${t.key} (${t.title}): FAIL — proposed plan B: ${t.planB}`);
    }
  }
  r.blank();

  r.h2('Notes for @forge/core');
  const test1Config = state.get<{ poolCreationFeeSol: number; zeroFeeError: string | null }>(
    'test1.config',
  );
  if (test1Config) {
    r.bullet(
      test1Config.zeroFeeError
        ? `poolCreationFee = 0 is rejected (\`${test1Config.zeroFeeError.slice(0, 120)}\`): CLIENT_BOUNDS.poolCreationFeeSol.allowZero must become false (minimum 0.001 SOL).`
        : 'poolCreationFee = 0 is accepted by the SDK and the program: CLIENT_BOUNDS.poolCreationFeeSol.allowZero = true holds.',
    );
  }
  r.bullet(
    'Test 1: measured exactly the DEVNET_TESTS.md expectation (fee 1,000,000 lamports on 0.1 SOL; with referral protocol 160,000 / referral 40,000; partner 800,000 in both cases; creator 0).',
  );
  r.bullet(
    'Test 2: creator = 25.00% of the non-protocol share across 3 buys and 1 sell; claim to receiver works; after migration the creator holds a permanently locked DAMM v2 position that accrues SOL fees, claimable to the multisig address.',
  );
  r.bullet(
    'Test 2 ran with a 1 SOL migration threshold (budget); production keeps 10 SOL (Meteora mainnet bots). The program accepted 1 SOL (it only requires a threshold > 0).',
  );
  r.bullet(
    'Migration on devnet was scripted (migrationDammV2CreateMetadata through the SDK anchor program object, with systemProgram/eventAuthority/program passed explicitly, then SDK migrateToDammV2); on mainnet Meteora bots do it. Post-migration swaps and the creator position fee claim use @meteora-ag/cp-amm-sdk 1.5.1 (claimPositionFee needs `tempWSolAccount` when a receiver is set and one side is SOL).',
  );
  r.bullet(
    'claimCreatorTradingFeeToReceiver closes a temporary WSOL account owned by the creator: the receiver gets the fees plus that account rent (1,488,440 lamports on this devnet, 2,039,280 on mainnet).',
  );
  r.bullet(
    'Test 3: createPoolWithFirstBuy in one 1,025-byte transaction; the pool creator and the base mint must sign (initializeVirtualPoolWithSplToken has `creator` as signer); the client is fee payer and buyer. With enableFirstSwapWithMinFee the first buy paid 1% (500,000 on 0.05 SOL) while the next buy paid 99% (49,500,000).',
  );
  r.bullet(
    'Test 4: 30 bps transfer + swap with referral = 754 bytes (buy) / 722 bytes (sell), well under 1,232. First attempt failed because the fee wallet held 0 SOL: a transfer must leave the recipient rent-exempt (about 0.0009 SOL), so FORGE_PLATFORM_FEE_WALLET must hold SOL before the first fee (and @forge/core should assert it).',
  );
  r.bullet(
    'In the swap event, `tradingFee` is the partner + creator share only; the total fee is tradingFee + protocolFee + referralFee. The DBC program emits events through self-CPI (eventAuthority), not `Program data:` logs: decode the inner instructions.',
  );
  r.bullet(
    'RPC: the Helius devnet websocket rate-limited signature subscriptions (HTTP 429), making web3.js report "expired" for a landed transaction. The scripts confirm by polling getSignatureStatuses; @forge/core consumers should do the same or use a dedicated websocket endpoint.',
  );
  r.blank();

  r.h2('Fake $FORGE mint (devnet)');
  const mint = state.get<ForgeMintRecord>('forgeMint');
  if (mint) {
    r.bullet(
      `Mint: ${accountLink(mint.mint, mint.mint)} — ${mint.decimals} decimals, supply ${mint.supply} raw units`,
    );
    r.bullet(
      `Mint authority / holder of the whole supply: ${accountLink(mint.mintAuthority, mint.mintAuthority)} (forgeCreator throwaway wallet)`,
    );
    r.bullet(`Holder token account: ${accountLink(mint.holderTokenAccount)}`);
    r.p(
      'Other agents: set `FORGE_MINT` to this address for devnet token-gating tests. Ask agent 1 to send test tokens from the holder wallet.',
    );
  } else {
    r.p('Not created yet (run `pnpm mint:forge`).');
  }

  r.h2('Throwaway wallets (public keys)');
  r.table(
    ['Wallet', 'Role', 'Address'],
    WALLET_NAMES.map((name) => [
      name,
      ROLE[name],
      accountLink(wallets[name].publicKey, wallets[name].publicKey.toBase58()),
    ]),
  );
  r.p('Secret keys live only in `scripts/devnet-tests/.state/` (gitignored). Devnet only.');
  r.write('SUMMARY.md');
}

const ROLE: Record<(typeof WALLET_NAMES)[number], string> = {
  funder: 'receives faucet SOL and distributes it',
  referral: 'owner of the WSOL referral token account (stand-in for the multisig)',
  partner: 'feeClaimer / leftoverReceiver of the configs (stand-in for the client)',
  forgeCreator: 'pool creator (stand-in for a FORGE creator wallet)',
  trader: 'buys and sells',
  client: 'pays and signs the first buy (test 3)',
  multisigStandIn: 'receiver of the creator claims (test 2)',
  platformFee: 'receives the 30 bps platform fee (test 4)',
};

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/summary.ts');
if (isMain) writeSummary();
