/// <reference types="node" />
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LaunchpadSpec } from '@forge/shared';
import { readCaptureOutput } from '../../src/pipeline/review/capture-output.js';
import { REPORT_FILE, REVIEW_DIR } from '../../src/pipeline/review/contract.js';
import {
  removeReviewInput,
  reviewInputFiles,
  reviewPath,
  reviewShotSummaries,
} from '../../src/pipeline/review/review-input.js';
import { writeWorkdirFiles } from '../../src/pipeline/workdir.js';
import { builderSystemPrompt } from '../../src/prompts/index.js';
import { reviewTaskPrompt } from '../../src/prompts/review.js';
import { runLocalAgent, type LocalAgentOptions } from './agent.js';
import { readState, ToolError, type Layout } from './layout.js';

/**
 * The second pass, as in the pipeline: the validated capture goes into site/.forge-review/, the
 * agent runs with `reviewTaskPrompt` (and the same system prompt), and `.forge-review/` is removed
 * afterwards, whatever happened.
 */
export async function reviewSite(
  layout: Layout,
  agent: LocalAgentOptions,
  captureDir?: string,
): Promise<void> {
  const dir = captureDir ?? readState(layout).captures.at(-1);
  if (!dir) throw new ToolError('no capture yet: run "capture" first');
  const result = await readCaptureOutput(dir);
  const usable = result.shots.filter((s) => s.ok && s.images.length > 0);
  if (usable.length === 0) throw new ToolError(`${dir} has no usable screenshot`);
  const spec = LaunchpadSpec.parse(JSON.parse(readFileSync(layout.spec, 'utf8')));
  const task = reviewTaskPrompt(
    {
      reviewDir: REVIEW_DIR,
      reportPath: reviewPath(REPORT_FILE),
      shots: reviewShotSummaries(result),
    },
    spec,
  );
  writeFileSync(path.join(layout.prompts, 'review.txt'), task);
  await removeReviewInput(layout.site);
  try {
    await writeWorkdirFiles(layout.site, reviewInputFiles(result));
    console.log(`review input: ${usable.length} page/viewport capture(s) from ${dir}`);
    await runLocalAgent(layout, 'pass2', builderSystemPrompt(), task, agent);
  } finally {
    await removeReviewInput(layout.site);
  }
}
