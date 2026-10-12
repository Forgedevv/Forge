import type { ChangedFile, ScanOptions, Violation } from '../scan/index.js';
import type { ScanFn } from './context.js';
import { checkAgentSiteConfig, SITE_CONFIG_PATH } from './site-config.js';
import { scanInput } from './scan-input.js';
import type { BaselineFile, TreeEntry } from './workdir.js';

/**
 * The blocking gate of the agent's work (docs/SECURITY.md §1), shared by every agent pass and by
 * the local site test tool: the scan of the diff against the builder's baseline, the
 * `forge.config.json` check, and regular files only. Pure: the caller reads the tree.
 */

export interface GateBaseline {
  /** Files the agent started from. */
  map: ReadonlyMap<string, BaselineFile>;
  /** forge.config.json as written by the builder (the agent's version is checked against it). */
  configText: string;
  /** forge.config.json whose theme/content the scan compares to (template sample, live site). */
  configReference: string | null;
}

export interface GateResult {
  /** What the scan looked at. */
  changes: ChangedFile[];
  /** Deduplicated; empty when the tree may be installed, built and published. */
  violations: Violation[];
}

function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.rule}|${v.file}|${v.line ?? ''}|${v.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function gateTree(
  tree: readonly TreeEntry[],
  baseline: GateBaseline,
  scan: ScanFn,
  scanOptions?: ScanOptions,
): GateResult {
  const changes = scanInput({
    baseline: baseline.map,
    tree,
    configReference: baseline.configReference,
  });
  const violations: Violation[] = [];
  const result = scan(changes, scanOptions);
  if (!result.ok) violations.push(...result.violations);
  const configEntry = tree.find((e) => e.path === SITE_CONFIG_PATH);
  violations.push(
    ...checkAgentSiteConfig(
      baseline.configText,
      configEntry && configEntry.mode === '100644' ? configEntry.content.toString('utf8') : null,
    ),
  );
  for (const entry of tree) {
    if (entry.mode !== '100644' && entry.mode !== '100755') {
      violations.push({
        rule: 'file-mode',
        file: entry.path,
        line: null,
        reason: 'only regular files can be published',
      });
    }
  }
  return { changes, violations: dedupe(violations) };
}
