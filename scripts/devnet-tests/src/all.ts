/**
 * `pnpm test:all` — fake $FORGE mint, then tests 1 to 4 in order, then SUMMARY.md.
 * A failed test does not stop the next ones; a funding shortfall does (exit code 2).
 */
import { FundingNeeded, printFundingRequest, EXIT_FUNDING_NEEDED } from './lib/funding.js';
import { State } from './lib/state.js';
import { ensureForgeMint } from './forge-mint.js';
import { runTest1 } from './test1.js';
import { runTest2 } from './test2.js';
import { runTest3 } from './test3.js';
import { runTest4 } from './test4.js';
import { writeSummary } from './summary.js';

const tests: Array<[string, () => Promise<boolean>]> = [
  ['test1', runTest1],
  ['test2', runTest2],
  ['test3', runTest3],
  ['test4', runTest4],
];

const results: Record<string, string> = {};
let fundingStop: FundingNeeded | undefined;
try {
  await ensureForgeMint(State.load());
  for (const [name, run] of tests) {
    try {
      results[name] = (await run()) ? 'PASS' : 'FAIL';
    } catch (err) {
      if (err instanceof FundingNeeded) {
        fundingStop = err;
        results[name] = 'FUNDING NEEDED';
        break;
      }
      results[name] = `ERROR: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
      console.error(err);
    }
  }
} catch (err) {
  if (err instanceof FundingNeeded) fundingStop = err;
  else throw err;
}

writeSummary();
console.log('');
for (const [name, status] of Object.entries(results)) console.log(`${name}: ${status}`);
if (fundingStop) {
  printFundingRequest(fundingStop);
  process.exit(EXIT_FUNDING_NEEDED);
}
