/**
 * Fake $FORGE: a plain SPL mint on devnet (6 decimals, 1,000,000,000 supply minted to forgeCreator),
 * for the other agents' token-gating tests. Recorded in `.state/` and in reports/SUMMARY.md.
 *
 * Run alone with `pnpm mint:forge`; also run by `test:all`.
 */
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { BUDGETS, ensureFunded, runMain } from './lib/funding.js';
import { State } from './lib/state.js';
import { loadOrCreateKeypair, loadWallets } from './lib/wallets.js';
import { COMMITMENT, getConnection, solscanAccount } from './lib/solana.js';

export interface ForgeMintRecord {
  mint: string;
  decimals: number;
  supply: string;
  mintAuthority: string;
  holder: string;
  holderTokenAccount: string;
  signature: string;
  [key: string]: string | number;
}

export const FORGE_DECIMALS = 6;
export const FORGE_SUPPLY = 1_000_000_000n * 10n ** BigInt(FORGE_DECIMALS);

export async function ensureForgeMint(state: State): Promise<ForgeMintRecord> {
  const existing = state.get<ForgeMintRecord>('forgeMint');
  if (existing) return existing;
  const wallets = loadWallets();
  await ensureFunded(wallets, BUDGETS.mint);
  return state.step<ForgeMintRecord>('forgeMint', async () => {
    const conn = getConnection();
    const payer = wallets.forgeCreator;
    const mintKeypair = loadOrCreateKeypair('forge-mint');
    const mint = await createMint(
      conn,
      payer,
      payer.publicKey,
      null,
      FORGE_DECIMALS,
      mintKeypair,
      { commitment: COMMITMENT },
    );
    const holderAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey, false, COMMITMENT);
    const signature = await mintTo(conn, payer, mint, holderAta.address, payer, FORGE_SUPPLY, [], {
      commitment: COMMITMENT,
    });
    console.log(`  fake $FORGE mint: ${mint.toBase58()} ${solscanAccount(mint)}`);
    return {
      mint: mint.toBase58(),
      decimals: FORGE_DECIMALS,
      supply: FORGE_SUPPLY.toString(),
      mintAuthority: payer.publicKey.toBase58(),
      holder: payer.publicKey.toBase58(),
      holderTokenAccount: holderAta.address.toBase58(),
      signature,
    };
  });
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/forge-mint.ts');
if (isMain) {
  await runMain(async () => {
    const record = await ensureForgeMint(State.load());
    console.log(`Fake $FORGE mint: ${record.mint}`);
  });
}
