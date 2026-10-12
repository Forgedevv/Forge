/// <reference types="node" />
import { gateTree } from '../../src/pipeline/gate.js';
import { readWorkdirTree, type TreeEntry } from '../../src/pipeline/workdir.js';
import { scanDiff } from '../../src/scan/index.js';
import { readState, type Layout, type ToolState } from './layout.js';
import { loadBaseline } from './prepare.js';

/**
 * Entries of site/ the tool itself created, left out of the scan: only those `serve` recorded in
 * state.json (linked node_modules, .env.local, next dev output). Nothing else is ever skipped.
 */
export function toolCreated(state: ToolState): Set<string> {
  const skip = new Set<string>();
  if (state.linkedNodeModules) skip.add('node_modules');
  if (state.envLocal) skip.add('.env.local');
  if (state.nextDev) {
    skip.add('.next');
    skip.add('tsconfig.tsbuildinfo');
  }
  return skip;
}

export interface LocalScanResult {
  ok: boolean;
  ignored: string[];
}

/** The production gate (scan + forge.config.json check + file modes) on site/. */
export async function scanSite(layout: Layout): Promise<LocalScanResult> {
  const state = readState(layout);
  const baseline = loadBaseline(layout);
  const skip = toolCreated(state);
  const ignored = [...skip];
  let tree: TreeEntry[] = await readWorkdirTree(layout.site, {}, (rel) => skip.has(rel));
  // next dev rewrites next-env.d.ts: that change (and only after next dev ran) is not the agent's.
  if (state.nextDev) {
    const before = baseline.map.get('next-env.d.ts');
    const current = tree.find((e) => e.path === 'next-env.d.ts');
    if (current && !before) {
      ignored.push('next-env.d.ts (written by next dev)');
      tree = tree.filter((e) => e !== current);
    } else if (current && before && !current.content.equals(before.content)) {
      ignored.push('next-env.d.ts (rewritten by next dev)');
      tree = tree.map((e) => (e === current ? { ...e, content: before.content } : e));
    }
  }
  const { changes, violations } = gateTree(tree, baseline, scanDiff);
  console.log(
    ignored.length > 0
      ? `ignored (created by this tool, not by the agent): ${ignored.join(', ')}`
      : 'ignored: nothing',
  );
  console.log(`changed files: ${changes.length}`);
  for (const c of changes) console.log(`  ${c.status.padEnd(8)} ${c.path}`);
  if (violations.length === 0) {
    console.log('SCAN OK');
    return { ok: true, ignored };
  }
  console.log(`SCAN BLOCKED: ${violations.length} violation(s)`);
  for (const v of violations) console.log(`  [${v.rule}] ${v.file}:${v.line ?? '-'} ${v.reason}`);
  return { ok: false, ignored };
}
