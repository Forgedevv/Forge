/// <reference types="node" />
/** Test helpers of the visual review: valid PNGs and a capture output folder, no browser. */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  REPORT_FILE,
  REVIEW_PAGES,
  REVIEW_VIEWPORTS,
  SHOT_MAX_HEIGHT,
  SHOT_PART_HEIGHT,
  shotFile,
} from './contract.js';
import { crc32 } from './png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk with its length and CRC. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid RGB PNG of the given size (a flat color), with optional extra chunks after IHDR. */
export function makePng(width: number, height: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc(height * (1 + width * 3), 0x40);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * 3)] = 0; // filter: none
  return Buffer.concat([
    SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...extra,
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface FakeCaptureOptions {
  /** Height of every page (default 900: one part). */
  pageHeight?: number;
  /** Shots (`page/viewport`) reported as failed, with no file. */
  failed?: string[];
  /** Mobile pages whose layout overflows (one overflowing element). */
  mobileOverflow?: string[];
}

/** Writes what a successful capture writes: every screenshot part and the report. */
export async function writeFakeCapture(
  outDir: string,
  opts: FakeCaptureOptions = {},
): Promise<void> {
  const pageHeight = opts.pageHeight ?? 900;
  const shots: unknown[] = [];
  for (const viewport of REVIEW_VIEWPORTS) {
    for (const page of REVIEW_PAGES) {
      const key = `${page.id}/${viewport.id}`;
      const failed = opts.failed?.includes(key) ?? false;
      const total = Math.min(Math.max(pageHeight, viewport.height), SHOT_MAX_HEIGHT);
      const files: Array<{ file: string; y: number; height: number }> = [];
      if (!failed) {
        for (let part = 1, y = 0; y < total; part += 1, y += SHOT_PART_HEIGHT) {
          const height = Math.min(SHOT_PART_HEIGHT, total - y);
          const file = shotFile(page.id, viewport.id, part);
          await writeFile(path.join(outDir, file), makePng(viewport.width, height));
          files.push({ file, y, height });
        }
      }
      const overflow = viewport.mobile && (opts.mobileOverflow?.includes(page.id) ?? false);
      shots.push({
        page: page.id,
        path: page.path,
        viewport: viewport.id,
        width: viewport.width,
        height: viewport.height,
        ok: !failed,
        error: failed ? 'navigation failed: timeout' : null,
        status: failed ? null : 200,
        files,
        pageHeight,
        truncated: pageHeight > SHOT_MAX_HEIGHT,
        layout: failed
          ? null
          : {
              clientWidth: viewport.width,
              scrollWidth: overflow ? viewport.width + 32 : viewport.width,
              horizontalOverflow: overflow,
              overflowingCount: overflow ? 1 : 0,
              overflowing: overflow
                ? [
                    {
                      tag: 'div',
                      id: '',
                      classes: ['hero-art', 'w-[420px]'],
                      left: 0,
                      right: viewport.width + 32,
                      width: viewport.width + 32,
                      text: 'Launch',
                    },
                  ]
                : [],
            },
        consoleErrors: 0,
        consoleMessages: [],
        requests: { fixture: 1, blocked: 2 },
      });
    }
  }
  await writeFile(
    path.join(outDir, REPORT_FILE),
    `${JSON.stringify({ version: 1, generator: 'test', shots }, null, 2)}\n`,
  );
}
