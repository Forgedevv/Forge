import type { ChangedFile } from '../scan/index.js';
import { configScanBaseline, SITE_CONFIG_PATH } from './site-config.js';
import { diffAgainstBaseline, type BaselineFile, type TreeEntry } from './workdir.js';

/**
 * Input of the blocking scan: every file that differs between `baseline` and `tree`, plus
 * `forge.config.json` whenever it exists, compared to a baseline that keeps its locked fields and
 * takes `theme` / `content` from `configReference` (see `configScanBaseline`). So the values the
 * builder wrote from the spec are scanned like the agent's, at build time already.
 */
export function scanInput(input: {
  baseline: ReadonlyMap<string, BaselineFile>;
  tree: readonly TreeEntry[];
  /** forge.config.json the theme/content are compared to (template sample, live site...). */
  configReference: string | null;
}): ChangedFile[] {
  const changes = diffAgainstBaseline(input.baseline, input.tree);
  const config = input.tree.find((e) => e.path === SITE_CONFIG_PATH);
  if (!config || config.mode !== '100644') return changes;
  const next = config.content.toString('utf8');
  const old = configScanBaseline(input.configReference, next);
  const rest = changes.filter((c) => c.path !== SITE_CONFIG_PATH);
  if (old === null) {
    // No reference to compare to: the file is scanned as added (refused by the scan).
    rest.push({
      path: SITE_CONFIG_PATH,
      status: 'added',
      oldContent: null,
      newContent: config.content,
      mode: config.mode,
    });
  } else {
    rest.push({
      path: SITE_CONFIG_PATH,
      status: 'modified',
      oldContent: Buffer.from(old, 'utf8'),
      newContent: config.content,
      mode: config.mode,
      oldMode: '100644',
    });
  }
  return rest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
