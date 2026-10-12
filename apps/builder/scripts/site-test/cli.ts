/// <reference types="node" />
/**
 * FORGE site test tool (development only, never used in production): reproduces the building
 * step of the pipeline on a laptop, without Docker, GitHub, Vercel, the chain or payments. Same
 * template, prompts, agent argv, scan and capture script as production.
 *
 *   pnpm --filter @forge/builder site-test <command> --out <dir> [options]
 *
 * Commands:
 *   prepare  --brief <file>   standalone template + forge.config.json + baseline + prompts
 *   agent                     first agent pass with the local CLI (production argv)
 *   scan                      the production gate on site/
 *   serve                     next dev on 127.0.0.1 (devnet, local RPC proxy) until Ctrl+C
 *   capture                   screenshots + layout report with a local Chrome or Edge
 *   review                    second agent pass on the latest capture
 *   all      --brief <file>   prepare, agent, scan, capture, review, scan, capture again
 *
 * Options: --model <id> (default claude-sonnet-5-5), --agent-bin <path>, --max-turns <n>,
 *   --port <n> (site, default 3100), --rpc-port <n> (default 3101), --browser <path>,
 *   --capture <dir> (review). Ports 3001, 3002 and 8899 are refused.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runLocalAgent } from './agent.js';
import { captureSite } from './capture.js';
import { layoutOf, requirePrepared, ToolError, type Layout } from './layout.js';
import { parseCli, type Options } from './options.js';
import { prepare } from './prepare.js';
import { reviewSite } from './review.js';
import { scanSite } from './scan.js';
import { portAnswers, startSite, type RunningSite } from './serve.js';

/** What this process started, stopped on exit or Ctrl+C. */
const running = new Set<RunningSite>();

async function withSite<T>(
  layout: Layout,
  o: Options,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  if (await portAnswers(o.sitePort)) {
    console.log(`using the site already running on port ${o.sitePort}`);
    return fn(`http://127.0.0.1:${o.sitePort}`);
  }
  const site = await startSite(layout, o.sitePort, o.rpcPort);
  running.add(site);
  try {
    return await fn(site.url);
  } finally {
    running.delete(site);
    await site.stop();
  }
}

function prompt(layout: Layout, name: string): string {
  return readFileSync(path.join(layout.prompts, name), 'utf8');
}

async function main(o: Options): Promise<number> {
  const layout = layoutOf(o.out);
  switch (o.command) {
    case 'prepare':
      await prepare(layout, o.brief!);
      return 0;
    case 'agent':
      requirePrepared(layout);
      await runLocalAgent(
        layout,
        'pass1',
        prompt(layout, 'system.txt'),
        prompt(layout, 'task.txt'),
        o.agent,
      );
      return 0;
    case 'scan':
      requirePrepared(layout);
      return (await scanSite(layout)).ok ? 0 : 1;
    case 'serve': {
      requirePrepared(layout);
      const site = await startSite(layout, o.sitePort, o.rpcPort);
      running.add(site);
      console.log('press Ctrl+C to stop');
      await new Promise(() => undefined);
      return 0;
    }
    case 'capture':
      requirePrepared(layout);
      await withSite(layout, o, (url) =>
        captureSite(layout, url, { ...(o.browser ? { browser: o.browser } : {}) }),
      );
      return 0;
    case 'review':
      requirePrepared(layout);
      await reviewSite(layout, o.agent, o.capture);
      return 0;
    case 'all': {
      const t0 = Date.now();
      await prepare(layout, o.brief!);
      await runLocalAgent(
        layout,
        'pass1',
        prompt(layout, 'system.txt'),
        prompt(layout, 'task.txt'),
        o.agent,
      );
      if (!(await scanSite(layout)).ok) {
        console.log('the first pass is blocked by the scan: in production the job would fail here');
        return 1;
      }
      const browser = o.browser ? { browser: o.browser } : {};
      const results = await withSite(layout, o, async (url) => {
        const before = await captureSite(layout, url, { ...browser, label: 'capture' });
        await reviewSite(layout, o.agent, before);
        const scan = await scanSite(layout);
        if (!scan.ok) {
          console.log(
            'the second pass is blocked by the scan: in production the first pass would be kept',
          );
        }
        const after = await captureSite(layout, url, { ...browser, label: 'after' });
        return { before, after, scanOk: scan.ok };
      });
      console.log('');
      console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s. Where to look:`);
      console.log(`  site:            ${layout.site}`);
      console.log(`  prompts:         ${layout.prompts}`);
      console.log(
        `  agent results:   ${path.join(layout.out, 'agent-pass1.json')}, agent-pass2.json`,
      );
      console.log(`  first pass:      ${results.before}`);
      console.log(`  after review:    ${results.after}`);
      return results.scanOk ? 0 : 1;
    }
  }
}

async function stopAll(): Promise<void> {
  await Promise.all([...running].map((s) => s.stop().catch(() => undefined)));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stopAll().then(() => process.exit(130));
  });
}

let options: Options;
try {
  options = parseCli(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
main(options).then(
  async (code) => {
    await stopAll();
    process.exit(code);
  },
  async (err: unknown) => {
    await stopAll();
    console.error(err instanceof ToolError ? err.message : err);
    process.exit(1);
  },
);
