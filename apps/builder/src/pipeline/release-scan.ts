import type { Violation } from '../scan/index.js';
import type { PipelineDeps } from './context.js';
import type { RepoTreeEntry } from './repo-snapshot.js';
import { scanInput } from './scan-input.js';
import { SITE_CONFIG_PATH } from './site-config.js';
import type { BaselineFile, TreeEntry } from './workdir.js';

/**
 * Scan of a release, right before the merge into the default branch: exactly what the merge
 * brings in (merge base -> job branch head), read from GitHub as bytes. The build step already
 * scanned the agent's work; this second pass covers what happened to the branch since (anything
 * pushed after the preview, the builder's own commits) so that nothing reaches production
 * unscanned. Only the files that differ are downloaded.
 */
export async function scanRelease(
  deps: PipelineDeps,
  repo: string,
  base: string,
  branch: string,
): Promise<{ violations: Violation[]; mergeBaseSha: string; headSha: string; changed: number }> {
  const cmp = await deps.github.compareCommits(repo, base, branch);
  const [before, after] = await Promise.all([
    deps.repoSource.listTree(repo, cmp.mergeBaseSha),
    deps.repoSource.listTree(repo, cmp.headSha),
  ]);
  const beforeByPath = new Map(before.entries.map((e) => [e.path, e]));
  const afterByPath = new Map(after.entries.map((e) => [e.path, e]));
  const differs = (a: RepoTreeEntry | undefined, b: RepoTreeEntry | undefined): boolean =>
    !a || !b || a.sha !== b.sha || a.executable !== b.executable;
  const changedPaths = new Set<string>();
  for (const p of new Set([...beforeByPath.keys(), ...afterByPath.keys()])) {
    if (differs(beforeByPath.get(p), afterByPath.get(p))) changedPaths.add(p);
  }
  // forge.config.json is always scanned (its theme/content against the merge base).
  const wanted = new Set([...changedPaths, SITE_CONFIG_PATH]);
  const needBefore = before.entries.filter((e) => wanted.has(e.path));
  const needAfter = after.entries.filter((e) => wanted.has(e.path));
  const [oldBlobs, newBlobs] = await Promise.all([
    deps.repoSource.readBlobs(repo, needBefore),
    deps.repoSource.readBlobs(repo, needAfter),
  ]);
  const baseline = new Map<string, BaselineFile>();
  for (const e of needBefore) {
    baseline.set(e.path, {
      content: oldBlobs.get(e.path) ?? Buffer.alloc(0),
      executable: e.executable,
    });
  }
  const tree: TreeEntry[] = needAfter.map((e) => ({
    path: e.path,
    mode: e.executable ? '100755' : '100644',
    content: newBlobs.get(e.path) ?? Buffer.alloc(0),
  }));
  const reference = oldBlobs.get(SITE_CONFIG_PATH)?.toString('utf8') ?? null;
  const changes = scanInput({ baseline, tree, configReference: reference });
  const result = deps.scan(changes, deps.config.scanOptions);
  return {
    violations: result.ok ? [] : result.violations,
    mergeBaseSha: cmp.mergeBaseSha,
    headSha: cmp.headSha,
    changed: changedPaths.size,
  };
}
