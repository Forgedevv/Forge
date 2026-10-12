/// <reference types="node" />
import { lstat, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewShotSummary } from '../../prompts/review.js';
import { PipelineError } from '../errors.js';
import type { WorkdirFile } from '../workdir.js';
import type { CaptureResult } from './capture-output.js';
import { REPORT_FILE, REVIEW_DIR } from './contract.js';

/**
 * The review input of the second pass: the validated screenshots and a normalized report, written
 * under `.forge-review/` in the pass 2 workdir, and removed from it before the scan. Nothing in it
 * is ever scanned, committed or built.
 */

/** Project-relative path of a review input file. */
export function reviewPath(file: string): string {
  return `${REVIEW_DIR}/${file}`;
}

/** True for `.forge-review` and anything under it. */
export function isReviewPath(p: string): boolean {
  return p === REVIEW_DIR || p.startsWith(`${REVIEW_DIR}/`);
}

/** The report as the agent reads it: rebuilt from the validated data, never the raw file. */
export function normalizedReport(result: CaptureResult): string {
  const shots = result.shots.map((s) => ({
    page: s.page,
    path: s.path,
    viewport: s.viewport,
    width: s.width,
    height: s.height,
    captured: s.ok,
    error: s.ok ? null : 'the page could not be captured',
    status: s.status,
    screenshots: s.images.map((i) => ({ file: reviewPath(i.file), top: i.y, height: i.height })),
    pageHeight: s.pageHeight,
    truncated: s.truncated,
    layout: s.layout,
    consoleErrors: s.consoleErrors,
    consoleMessages: s.consoleMessages,
    blockedRequests: s.requests.blocked,
  }));
  return `${JSON.stringify(
    {
      about:
        'Measured by FORGE in a headless browser with no network, on day one (no coin yet). ' +
        'Requests to other sites were blocked; the coin list answered with empty lists.',
      shots,
    },
    null,
    2,
  )}\n`;
}

/** Files of `.forge-review/`: every valid screenshot part and the normalized report. */
export function reviewInputFiles(result: CaptureResult): WorkdirFile[] {
  const files: WorkdirFile[] = [];
  for (const shot of result.shots) {
    for (const image of shot.images) {
      files.push({ path: reviewPath(image.file), content: image.png, executable: false });
    }
  }
  files.push({
    path: reviewPath(REPORT_FILE),
    content: Buffer.from(normalizedReport(result), 'utf8'),
    executable: false,
  });
  return files;
}

/** Summary of each page and viewport, for `reviewTaskPrompt`. */
export function reviewShotSummaries(result: CaptureResult): ReviewShotSummary[] {
  return result.shots.map((s) => ({
    page: s.page,
    path: s.path,
    viewport: s.viewport,
    width: s.width,
    height: s.height,
    captured: s.ok && s.images.length > 0,
    images: s.images.map((i) => reviewPath(i.file)),
    truncated: s.truncated,
    layout: s.layout
      ? {
          clientWidth: s.layout.clientWidth,
          scrollWidth: s.layout.scrollWidth,
          overflowingCount: s.layout.overflowingCount,
          overflowing: s.layout.overflowing.map((e) => ({
            tag: e.tag,
            id: e.id,
            classes: e.classes,
            right: e.right,
          })),
        }
      : null,
    consoleErrors: s.consoleErrors,
  }));
}

/**
 * Removes `.forge-review` from a workdir, whatever the agent turned it into (folder, file or
 * symlink: a link is removed itself, never followed). Throws if it is still there afterwards.
 */
export async function removeReviewInput(workdir: string): Promise<void> {
  const target = path.join(workdir, REVIEW_DIR);
  let st;
  try {
    st = await lstat(target);
  } catch {
    return;
  }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    // `rm` does not follow symlinks inside the tree: it removes the links themselves.
    await rm(target, { recursive: true, force: true, maxRetries: 3 });
  } else {
    // A file or a link. A directory link on Windows (junction) needs rmdir, which removes the
    // link without touching its target.
    await unlink(target).catch(() => rmdir(target));
  }
  const still = await lstat(target).then(
    () => true,
    () => false,
  );
  if (still) throw new PipelineError('could not remove the review input from the job folder');
}
