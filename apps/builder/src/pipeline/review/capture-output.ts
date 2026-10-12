/// <reference types="node" />
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  CAPTURE_LIMITS,
  expectedCaptureFiles,
  MAX_CONSOLE_MESSAGES,
  MAX_OVERFLOWING,
  REPORT_FILE,
  REVIEW_PAGES,
  REVIEW_VIEWPORTS,
  SHOT_MAX_HEIGHT,
  SHOT_MAX_PARTS,
  SHOT_PART_HEIGHT,
  shotFile,
  type ReviewPageId,
  type ReviewViewportId,
} from './contract.js';
import { PngError, sanitizePng } from './png.js';

/**
 * Reads back what the review capture wrote into its output folder. The capture ran the agent's
 * site and a browser on it: every byte is untrusted. Only the expected file names are looked at,
 * never through a symlink, with size caps; the report is parsed with zod and checked against the
 * contract; every screenshot must be a well-formed PNG of the expected size (rebuilt from its
 * critical chunks); every string is cut short and stripped to a safe character set.
 */

export class CaptureOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureOutputError';
  }
}

const PAGE_IDS = REVIEW_PAGES.map((p) => p.id) as [ReviewPageId, ...ReviewPageId[]];
const VIEWPORT_IDS = REVIEW_VIEWPORTS.map((v) => v.id) as [ReviewViewportId, ...ReviewViewportId[]];

const int = (min: number, max: number) => z.number().int().min(min).max(max);

const OverflowingSchema = z.object({
  tag: z.string().max(256),
  id: z.string().max(1024).default(''),
  classes: z.array(z.string().max(1024)).max(64).default([]),
  left: z.number().min(-1e7).max(1e7),
  right: z.number().min(-1e7).max(1e7),
  width: z.number().min(0).max(1e7),
  text: z.string().max(4096).default(''),
});

const LayoutSchema = z.object({
  clientWidth: int(0, 100_000),
  scrollWidth: int(0, 10_000_000),
  overflowingCount: int(0, 10_000_000),
  overflowing: z.array(OverflowingSchema).max(MAX_OVERFLOWING),
});

const ShotSchema = z.object({
  page: z.enum(PAGE_IDS),
  path: z.string().max(256),
  viewport: z.enum(VIEWPORT_IDS),
  width: int(1, 100_000),
  height: int(1, 100_000),
  ok: z.boolean(),
  error: z.string().max(4096).nullable().default(null),
  status: int(0, 999).nullable().default(null),
  files: z
    .array(
      z.object({
        file: z.string().max(128),
        y: int(0, SHOT_MAX_HEIGHT),
        height: int(1, SHOT_PART_HEIGHT),
      }),
    )
    .max(SHOT_MAX_PARTS)
    .default([]),
  pageHeight: int(0, 100_000_000).default(0),
  truncated: z.boolean().default(false),
  layout: LayoutSchema.nullable().default(null),
  consoleErrors: int(0, 100_000_000).default(0),
  consoleMessages: z.array(z.string().max(4096)).max(MAX_CONSOLE_MESSAGES).default([]),
  requests: z
    .object({ fixture: int(0, 100_000_000), blocked: int(0, 100_000_000) })
    .default({ fixture: 0, blocked: 0 }),
});

const ReportSchema = z.object({
  version: z.literal(1),
  shots: z.array(ShotSchema).max(REVIEW_PAGES.length * REVIEW_VIEWPORTS.length),
});

export interface OverflowingElement {
  tag: string;
  id: string;
  classes: string[];
  left: number;
  right: number;
  width: number;
  /** First characters of the element's text, sanitized (report file only, never the prompt). */
  text: string;
}

export interface CaptureImage {
  /** Contract file name (`home-mobile.png`, `home-mobile-2.png`). */
  file: string;
  /** Top of this part in the page, CSS pixels. */
  y: number;
  height: number;
  /** PNG rebuilt from its critical chunks. */
  png: Buffer;
}

export interface CaptureShot {
  page: ReviewPageId;
  path: string;
  viewport: ReviewViewportId;
  width: number;
  height: number;
  /** Screenshot taken and every part valid. */
  ok: boolean;
  error: string | null;
  status: number | null;
  images: CaptureImage[];
  pageHeight: number;
  truncated: boolean;
  layout: {
    clientWidth: number;
    scrollWidth: number;
    /** Recomputed on the host: `scrollWidth > clientWidth`. */
    horizontalOverflow: boolean;
    overflowingCount: number;
    overflowing: OverflowingElement[];
  } | null;
  consoleErrors: number;
  consoleMessages: string[];
  requests: { fixture: number; blocked: number };
}

export interface CaptureResult {
  shots: CaptureShot[];
  /** Entries of the output folder that were not looked at (unexpected names, links, folders). */
  ignoredEntries: number;
  imageBytes: number;
}

// Hidden, zero-width and bidirectional characters, and the C0/C1 controls.
const UNSAFE_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Printable text, whitespace collapsed, at most `max` characters. */
export function cleanText(value: string, max: number): string {
  return value
    .replace(UNSAFE_CHARS_RE, ' ')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const TAG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Class names worth showing: Tailwind-like tokens, no quote, bracket of a tag, brace or space. */
const CLASS_RE = /^[A-Za-z0-9_:/.[\]%#()!-]{1,64}$/;

function cleanElement(e: z.infer<typeof OverflowingSchema>): OverflowingElement {
  const tag = e.tag.toLowerCase();
  return {
    tag: TAG_RE.test(tag) ? tag : 'element',
    id: ID_RE.test(e.id) ? e.id : '',
    classes: e.classes.filter((c) => CLASS_RE.test(c)).slice(0, 6),
    left: Math.round(e.left),
    right: Math.round(e.right),
    width: Math.round(e.width),
    text: cleanText(e.text, 60),
  };
}

/** Reads a regular file without following a symlink, refusing anything larger than `max`. */
async function readCapped(file: string, max: number): Promise<Buffer> {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new CaptureOutputError('not a regular file');
    if (st.size > max) throw new CaptureOutputError('file too large');
    const content = await handle.readFile();
    if (content.length > max) throw new CaptureOutputError('file too large');
    return content;
  } finally {
    await handle.close();
  }
}

/**
 * Validates the capture output folder. Throws `CaptureOutputError` when the report is missing or
 * invalid; a screenshot that fails its checks only marks its shot as failed.
 */
export async function readCaptureOutput(
  outDir: string,
  limits: Partial<typeof CAPTURE_LIMITS> = {},
): Promise<CaptureResult> {
  const max = { ...CAPTURE_LIMITS, ...limits };
  const dirStat = await lstat(outDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new CaptureOutputError('the capture output is not a real folder');
  }
  const expected = expectedCaptureFiles();
  const entries = await readdir(outDir, { withFileTypes: true });
  const files = new Set<string>();
  let ignoredEntries = 0;
  for (const entry of entries.slice(0, max.maxEntries)) {
    if (expected.has(entry.name) && entry.isFile()) files.add(entry.name);
    else ignoredEntries += 1;
  }
  ignoredEntries += Math.max(0, entries.length - max.maxEntries);

  if (!files.has(REPORT_FILE)) throw new CaptureOutputError('the capture wrote no report');
  let raw: unknown;
  try {
    const text = (await readCapped(path.join(outDir, REPORT_FILE), max.maxReportBytes)).toString(
      'utf8',
    );
    raw = JSON.parse(text);
  } catch (err) {
    throw new CaptureOutputError(
      err instanceof CaptureOutputError
        ? `report: ${err.message}`
        : err instanceof SyntaxError
          ? 'the report is not valid JSON'
          : 'the report cannot be read',
    );
  }
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) {
    const where = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new CaptureOutputError(
      `the report does not match the contract (${where.slice(0, 5).join(', ')})`,
    );
  }

  const seen = new Set<string>();
  const shots: CaptureShot[] = [];
  let imageBytes = 0;
  for (const s of parsed.data.shots) {
    const page = REVIEW_PAGES.find((p) => p.id === s.page)!;
    const viewport = REVIEW_VIEWPORTS.find((v) => v.id === s.viewport)!;
    const key = `${s.page}/${s.viewport}`;
    if (seen.has(key)) throw new CaptureOutputError(`the report lists ${key} twice`);
    seen.add(key);
    if (s.path !== page.path || s.width !== viewport.width || s.height !== viewport.height) {
      throw new CaptureOutputError(`the report entry ${key} does not match the contract`);
    }
    const shot: CaptureShot = {
      page: s.page,
      path: page.path,
      viewport: s.viewport,
      width: viewport.width,
      height: viewport.height,
      ok: s.ok,
      error: s.error === null ? null : cleanText(s.error, 200),
      status: s.status,
      images: [],
      pageHeight: s.pageHeight,
      truncated: s.truncated,
      layout: s.layout
        ? {
            clientWidth: s.layout.clientWidth,
            scrollWidth: s.layout.scrollWidth,
            horizontalOverflow: s.layout.scrollWidth > s.layout.clientWidth,
            overflowingCount: Math.max(s.layout.overflowingCount, s.layout.overflowing.length),
            overflowing: s.layout.overflowing.map(cleanElement),
          }
        : null,
      consoleErrors: s.consoleErrors,
      consoleMessages: s.consoleMessages.map((m) => cleanText(m, 200)),
      requests: s.requests,
    };
    if (shot.ok) {
      try {
        if (s.files.length === 0) throw new CaptureOutputError('no screenshot');
        let part = 0;
        for (const ref of s.files) {
          part += 1;
          if (ref.file !== shotFile(s.page, s.viewport, part)) {
            throw new CaptureOutputError('unexpected screenshot name');
          }
          if (ref.y !== (part - 1) * SHOT_PART_HEIGHT)
            throw new CaptureOutputError('unexpected part offset');
          if (!files.has(ref.file)) throw new CaptureOutputError('screenshot missing');
          const content = await readCapped(path.join(outDir, ref.file), max.maxShotBytes);
          if (imageBytes + content.length > max.maxTotalBytes) {
            throw new CaptureOutputError('screenshots too large in total');
          }
          const png = sanitizePng(content);
          if (png.width !== viewport.width || png.height !== ref.height) {
            throw new CaptureOutputError('screenshot size does not match the report');
          }
          imageBytes += png.png.length;
          shot.images.push({ file: ref.file, y: ref.y, height: ref.height, png: png.png });
        }
      } catch (err) {
        for (const image of shot.images) imageBytes -= image.png.length;
        shot.images = [];
        shot.ok = false;
        shot.error =
          err instanceof CaptureOutputError || err instanceof PngError
            ? `invalid screenshot: ${err.message}`
            : 'invalid screenshot';
      }
    }
    shots.push(shot);
  }
  return { shots, ignoredEntries, imageBytes };
}
