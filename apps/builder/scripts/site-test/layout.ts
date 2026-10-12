/// <reference types="node" />
/**
 * Folder layout and state of the local site test tool. Everything it writes lives in one output
 * folder, outside the repository:
 *
 *   <out>/brief.json          copy of the brief
 *   <out>/spec.json           the LaunchpadSpec built from it (dummy owner, fees...)
 *   <out>/baseline.json       files the agent starts from (what the scan compares to)
 *   <out>/prompts/            system.txt, task.txt, review.txt (exactly what the agent gets)
 *   <out>/site/               the standalone template, then the agent's work
 *   <out>/agent-pass1.json    raw CLI result of each agent pass (and .stderr.txt)
 *   <out>/capture-<time>/     screenshots + report.json of each capture
 *   <out>/state.json          what the tool created in site/ (so the scan ignores only that)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** apps/builder/scripts/site-test -> repository root. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'apps', 'launchpad-template');
export const CAPTURE_SCRIPT = path.join(
  REPO_ROOT,
  'apps',
  'builder',
  'src',
  'pipeline',
  'review',
  'capture.mjs',
);

/** Ports the tool never uses (the team's own dev servers and local validator). */
export const RESERVED_PORTS = new Set([3001, 3002, 8899]);

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Paths given on the command line are relative to where pnpm was started. */
export function resolveUserPath(p: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The output folder: absolute, and never inside the repository (nor the repository itself). */
export function checkOutDir(out: string, repoRoot: string = REPO_ROOT): string {
  const abs = path.resolve(out);
  if (inside(path.resolve(repoRoot), abs)) {
    throw new ToolError(`the output folder must be outside the repository (${repoRoot})`);
  }
  if (inside(abs, path.resolve(repoRoot))) {
    throw new ToolError('the output folder must not contain the repository');
  }
  return abs;
}

export function checkPort(port: number, name: string): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ToolError(`${name} must be a port between 1024 and 65535`);
  }
  if (RESERVED_PORTS.has(port)) {
    throw new ToolError(`${name} ${port} is reserved (3001, 3002 and 8899 are never used)`);
  }
  return port;
}

export interface Layout {
  out: string;
  site: string;
  brief: string;
  spec: string;
  baseline: string;
  prompts: string;
  state: string;
}

export function layoutOf(out: string): Layout {
  const abs = checkOutDir(out);
  return {
    out: abs,
    site: path.join(abs, 'site'),
    brief: path.join(abs, 'brief.json'),
    spec: path.join(abs, 'spec.json'),
    baseline: path.join(abs, 'baseline.json'),
    prompts: path.join(abs, 'prompts'),
    state: path.join(abs, 'state.json'),
  };
}

const StateSchema = z.object({
  version: z.literal(1),
  /** Created by `serve` in site/: the scan leaves exactly these out. */
  linkedNodeModules: z.boolean().default(false),
  envLocal: z.boolean().default(false),
  /** next dev ran in site/ (.next, tsconfig.tsbuildinfo, next-env.d.ts rewrite). */
  nextDev: z.boolean().default(false),
  captures: z.array(z.string()).default([]),
});
export type ToolState = z.infer<typeof StateSchema>;

export function readState(layout: Layout): ToolState {
  if (!existsSync(layout.state)) {
    return StateSchema.parse({ version: 1 });
  }
  return StateSchema.parse(JSON.parse(readFileSync(layout.state, 'utf8')));
}

export function writeState(layout: Layout, state: ToolState): void {
  writeFileSync(layout.state, `${JSON.stringify(state, null, 2)}\n`);
}

export function updateState(layout: Layout, change: (s: ToolState) => void): ToolState {
  const state = readState(layout);
  change(state);
  writeState(layout, state);
  return state;
}

export function requirePrepared(layout: Layout): void {
  if (!existsSync(layout.baseline) || !existsSync(layout.site)) {
    throw new ToolError(`${layout.out} is not prepared: run "prepare" first`);
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** A fresh capture folder name, ordered by time. */
export function newCaptureDir(layout: Layout, label = 'capture'): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');
  let dir = path.join(layout.out, `${label}-${stamp}`);
  for (let i = 2; existsSync(dir); i += 1) dir = path.join(layout.out, `${label}-${stamp}-${i}`);
  mkdirSync(dir);
  return dir;
}
