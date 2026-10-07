/**
 * `pnpm fund:status` — prints the funder public address, every wallet balance, and the SOL
 * still needed to run all four tests. Nothing secret is printed.
 */
import { BUDGETS, roundUpToTenth } from './lib/funding.js';
import { State } from './lib/state.js';
import { WALLET_NAMES, loadWallets } from './lib/wallets.js';
import { formatSol, getBalance, solscanAccount } from './lib/solana.js';
import { solToLamports } from './lib/math.js';

const wallets = loadWallets();
const state = State.load();

console.log('Funder (send devnet SOL here, https://faucet.solana.com):');
console.log(`  ${wallets.funder.publicKey.toBase58()}`);
console.log(`  ${solscanAccount(wallets.funder.publicKey)}`);
console.log('');
console.log('Wallet balances:');
const balances = new Map<string, bigint>();
for (const name of WALLET_NAMES) {
  const balance = await getBalance(wallets[name].publicKey);
  balances.set(name, balance);
  console.log(`  ${name.padEnd(16)} ${wallets[name].publicKey.toBase58()}  ${formatSol(balance)}`);
}

console.log('');
console.log('Remaining need per test (budget minus what the wallets already hold):');
let totalShortfall = 0n;
for (const [test, budget] of Object.entries(BUDGETS)) {
  const done = state.has(`${test}.result`) || (test === 'mint' && state.has('forgeMint'));
  let shortfall = 0n;
  for (const [name, solAmount] of Object.entries(budget)) {
    const required = solToLamports(solAmount ?? 0);
    const have = balances.get(name) ?? 0n;
    if (have < required) shortfall += required - have;
  }
  if (done) shortfall = 0n;
  totalShortfall += shortfall;
  console.log(`  ${test.padEnd(6)} ${done ? 'done' : formatSol(shortfall)}`);
}
const funder = balances.get('funder') ?? 0n;
const reserve = solToLamports(0.05);
const missing = totalShortfall + reserve > funder ? totalShortfall + reserve - funder : 0n;
console.log('');
console.log(
  `Funder holds ${formatSol(funder)}; total still to distribute ${formatSol(totalShortfall)} (+ reserve).`,
);
if (missing > 0n) {
  console.log(
    `=> Send at least ${formatSol(roundUpToTenth(missing))} to ${wallets.funder.publicKey.toBase58()}`,
  );
} else {
  console.log('=> Funding is sufficient for the remaining tests.');
}
