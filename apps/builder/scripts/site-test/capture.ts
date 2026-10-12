/// <reference types="node" />
import { spawn } from 'node:child_process';
import { readCaptureOutput } from '../../src/pipeline/review/capture-output.js';
import { CAPTURE_SCRIPT, newCaptureDir, ToolError, updateState, type Layout } from './layout.js';

/**
 * Runs the pipeline's capture script (src/pipeline/review/capture.mjs) against the local site,
 * with a local Chrome or Edge, then reads its output back with the pipeline's own checks.
 */
export async function captureSite(
  layout: Layout,
  siteUrl: string,
  options: { browser?: string; label?: string } = {},
): Promise<string> {
  const outDir = newCaptureDir(layout, options.label);
  const args = [CAPTURE_SCRIPT, '--url', siteUrl, '--out', outDir, '--deadline-ms', '600000'];
  if (options.browser) args.push('--browser', options.browser);
  console.log(`capture: ${siteUrl} -> ${outDir}`);
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) throw new ToolError(`the capture failed (exit ${code})`);
  const result = await readCaptureOutput(outDir);
  for (const s of result.shots) {
    const where = `${s.path} ${s.viewport}`.padEnd(22);
    if (!s.ok || !s.layout) {
      console.log(`  ${where} not captured: ${s.error ?? 'unknown'}`);
      continue;
    }
    const overflow = s.layout.horizontalOverflow
      ? `OVERFLOW ${s.layout.scrollWidth}/${s.layout.clientWidth}px, ${s.layout.overflowingCount} element(s)`
      : 'no overflow';
    console.log(
      `  ${where} ${s.images.length} image(s), ${overflow}, ${s.consoleErrors} console error(s)`,
    );
  }
  updateState(layout, (state) => {
    state.captures.push(outDir);
  });
  return outDir;
}
