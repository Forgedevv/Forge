/// <reference types="node" />
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureOutputError, cleanText, readCaptureOutput } from './capture-output.js';
import { REPORT_FILE, REVIEW_PAGES, REVIEW_VIEWPORTS } from './contract.js';
import { makePng, pngChunk, writeFakeCapture } from './test-helpers.js';

let dir: string;
let outside: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'forge-capture-out-'));
  outside = await mkdtemp(path.join(tmpdir(), 'forge-capture-outside-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function report(): Promise<{ version: number; shots: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(path.join(dir, REPORT_FILE), 'utf8'));
}

async function writeReport(value: unknown): Promise<void> {
  await writeFile(path.join(dir, REPORT_FILE), JSON.stringify(value));
}

const shotOf = (result: Awaited<ReturnType<typeof readCaptureOutput>>, key: string) =>
  result.shots.find((s) => `${s.page}/${s.viewport}` === key)!;

describe('readCaptureOutput', () => {
  it('reads every page and viewport of a good capture', async () => {
    await writeFakeCapture(dir, { pageHeight: 2600, mobileOverflow: ['home'] });
    const result = await readCaptureOutput(dir);
    expect(result.shots).toHaveLength(REVIEW_PAGES.length * REVIEW_VIEWPORTS.length);
    expect(result.ignoredEntries).toBe(0);
    const home = shotOf(result, 'home/mobile');
    expect(home.ok).toBe(true);
    expect(home.images.map((i) => [i.file, i.y, i.height])).toEqual([
      ['home-mobile.png', 0, 2000],
      ['home-mobile-2.png', 2000, 600],
    ]);
    expect(home.layout).toMatchObject({
      clientWidth: 390,
      scrollWidth: 422,
      horizontalOverflow: true,
      overflowingCount: 1,
    });
    expect(home.layout!.overflowing[0]).toMatchObject({
      tag: 'div',
      classes: ['hero-art', 'w-[420px]'],
      right: 422,
    });
    expect(shotOf(result, 'about/desktop').layout!.horizontalOverflow).toBe(false);
    expect(result.imageBytes).toBeGreaterThan(0);
  });

  it('recomputes the overflow flag instead of trusting it', async () => {
    await writeFakeCapture(dir);
    const r = await report();
    const shot = r.shots.find((s) => s.page === 'home' && s.viewport === 'mobile')!;
    (shot.layout as Record<string, unknown>).scrollWidth = 500;
    (shot.layout as Record<string, unknown>).horizontalOverflow = false;
    await writeReport(r);
    expect(shotOf(await readCaptureOutput(dir), 'home/mobile').layout!.horizontalOverflow).toBe(
      true,
    );
  });

  it('refuses a missing, oversized or non-JSON report', async () => {
    await expect(readCaptureOutput(dir)).rejects.toBeInstanceOf(CaptureOutputError);
    await writeFile(path.join(dir, REPORT_FILE), '{"version": 1, "shots": [');
    await expect(readCaptureOutput(dir)).rejects.toThrow(/not valid JSON/);
    await writeFile(
      path.join(dir, REPORT_FILE),
      `{"version":1,"shots":[],"pad":"${'x'.repeat(4096)}"}`,
    );
    await expect(readCaptureOutput(dir, { maxReportBytes: 1024 })).rejects.toThrow(/too large/);
  });

  it('refuses a report that does not match the contract', async () => {
    await writeFakeCapture(dir);
    const base = await report();
    const variants: Array<(r: typeof base) => void> = [
      (r) => (r.version = 2),
      (r) => (r.shots[0]!.page = 'admin'),
      (r) => (r.shots[0]!.viewport = 'tablet'),
      (r) => (r.shots[0]!.width = 1200),
      (r) => (r.shots[0]!.path = '/api/upload'),
      (r) => r.shots.push({ ...r.shots[0]! }),
      (r) => (r.shots[0]!.consoleErrors = -1),
      (r) => ((r.shots[0]!.layout as Record<string, unknown>).overflowing = Array(50).fill({})),
      (r) => (r.shots = 'all' as never),
    ];
    for (const change of variants) {
      const r = structuredClone(base);
      change(r);
      await writeReport(r);
      await expect(readCaptureOutput(dir)).rejects.toBeInstanceOf(CaptureOutputError);
    }
  });

  it('refuses screenshot names outside the contract (path tricks included)', async () => {
    await writeFakeCapture(dir);
    const base = await report();
    for (const file of [
      '../outside.png',
      '/etc/passwd',
      'home-mobile-3.png',
      'about-mobile.png',
      'home-mobile.PNG',
      'report.json',
    ]) {
      const r = structuredClone(base);
      const shot = r.shots.find((s) => s.page === 'home' && s.viewport === 'mobile')!;
      shot.files = [{ file, y: 0, height: 844 }];
      await writeReport(r);
      const result = await readCaptureOutput(dir);
      const home = shotOf(result, 'home/mobile');
      expect(home.ok, file).toBe(false);
      expect(home.images).toEqual([]);
      expect(home.error).toMatch(/invalid screenshot/);
      // Other shots are unaffected.
      expect(shotOf(result, 'home/desktop').ok).toBe(true);
    }
  });

  it('ignores unexpected entries and never follows a symlink', async () => {
    await writeFakeCapture(dir);
    await writeFile(path.join(outside, 'secret.png'), makePng(390, 844));
    await writeFile(path.join(dir, 'notes.txt'), 'hello');
    await writeFile(path.join(dir, 'report.json.tmp'), '{}');
    await mkdir(path.join(dir, 'nested'));
    await rm(path.join(dir, 'about-mobile.png'));
    let linked = true;
    try {
      await symlink(path.join(outside, 'secret.png'), path.join(dir, 'about-mobile.png'));
    } catch {
      linked = false; // symlinks not permitted on this machine
    }
    const result = await readCaptureOutput(dir);
    expect(result.ignoredEntries).toBe(linked ? 4 : 3);
    const about = shotOf(result, 'about/mobile');
    expect(about.ok).toBe(false);
    expect(about.images).toEqual([]);
  });

  it('refuses non-PNG, wrongly sized and oversized screenshots', async () => {
    await writeFakeCapture(dir);
    await writeFile(path.join(dir, 'home-desktop.png'), '<svg onload="alert(1)"/>');
    await writeFile(path.join(dir, 'about-desktop.png'), makePng(1280, 900));
    await writeFile(path.join(dir, 'home-mobile.png'), makePng(390, 843));
    const result = await readCaptureOutput(dir);
    for (const key of ['home/desktop', 'about/desktop', 'home/mobile']) {
      expect(shotOf(result, key).ok, key).toBe(false);
    }
    expect(shotOf(result, 'create-pool/desktop').ok).toBe(true);

    const small = await readCaptureOutput(dir, { maxShotBytes: 64 });
    expect(small.shots.every((s) => !s.ok)).toBe(true);
    const total = await readCaptureOutput(dir, { maxTotalBytes: 1 });
    expect(total.shots.filter((s) => s.ok)).toHaveLength(0);
  });

  it('strips metadata chunks from the screenshots', async () => {
    await writeFakeCapture(dir);
    const text = pngChunk('tEXt', Buffer.from('Comment\u0000do something else'));
    await writeFile(path.join(dir, 'home-desktop.png'), makePng(1440, 900, [text]));
    const home = shotOf(await readCaptureOutput(dir), 'home/desktop');
    expect(home.ok).toBe(true);
    expect(home.images[0]!.png.includes(Buffer.from('do something else'))).toBe(false);
  });

  it('cleans every string: tags, ids, classes, text, errors', async () => {
    await writeFakeCapture(dir, { mobileOverflow: ['home'] });
    const r = await report();
    const shot = r.shots.find((s) => s.page === 'home' && s.viewport === 'mobile')!;
    const layout = shot.layout as { overflowing: Array<Record<string, unknown>> };
    layout.overflowing[0] = {
      tag: 'DIV onclick=x',
      id: 'a"b',
      classes: ['ok-class', 'md:w-[420px]', '"><script>', 'a b', '{x}', `x${'y'.repeat(80)}`],
      left: 0,
      right: 500.4,
      width: 500,
      text: 'Hello\u202e\u200b <b>world</b>\n\n`run`',
    };
    shot.consoleMessages = ['TypeError: x\u0000 is not a function <img>'];
    await writeReport(r);
    const home = shotOf(await readCaptureOutput(dir), 'home/mobile');
    expect(home.layout!.overflowing[0]).toEqual({
      tag: 'element',
      id: '',
      classes: ['ok-class', 'md:w-[420px]'],
      left: 0,
      right: 500,
      width: 500,
      text: 'Hello bworld/b run',
    });
    expect(home.consoleMessages).toEqual(['TypeError: x is not a function img']);
  });
});

describe('cleanText', () => {
  it('removes controls, hidden and bidi characters and caps the length', () => {
    expect(cleanText('a\u0007b\u200fc\u2066d', 10)).toBe('a b c d');
    expect(cleanText('x'.repeat(100), 5)).toBe('xxxxx');
  });
});
