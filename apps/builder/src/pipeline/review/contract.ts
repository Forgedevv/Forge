/**
 * Contract of the visual review capture: the pages and viewports it renders, the names of the
 * files it writes and their limits. The in-container script (`capture.mjs`, plain Node ESM so it
 * runs as is in the review image and on a laptop) keeps its own copy of these values; a unit test
 * checks both copies are identical.
 */

export const REVIEW_PAGES = [
  { id: 'home', path: '/' },
  { id: 'create-pool', path: '/create-pool' },
  { id: 'about', path: '/about' },
  { id: 'creator-fees', path: '/creator-fees' },
] as const;

export type ReviewPageId = (typeof REVIEW_PAGES)[number]['id'];

/** Real device emulation (`Emulation.setDeviceMetricsOverride`), device scale factor 1. */
export const REVIEW_VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 900, mobile: false },
  { id: 'mobile', width: 390, height: 844, mobile: true },
] as const;

export type ReviewViewportId = (typeof REVIEW_VIEWPORTS)[number]['id'];

/** Full-page capture height cap, in CSS pixels (= image pixels at scale 1). */
export const SHOT_MAX_HEIGHT = 4000;
/**
 * A capture is saved in parts of at most this height, so each image stays readable once the model
 * scales it down: `<page>-<viewport>.png` (top), then `<page>-<viewport>-2.png`.
 */
export const SHOT_PART_HEIGHT = 2000;
export const SHOT_MAX_PARTS = Math.ceil(SHOT_MAX_HEIGHT / SHOT_PART_HEIGHT);
/** Elements listed per screenshot in the overflow report. */
export const MAX_OVERFLOWING = 20;
/** Console error messages kept per screenshot. */
export const MAX_CONSOLE_MESSAGES = 5;

export const REPORT_FILE = 'report.json';

/** Folder of the review input in the pass 2 workdir. Removed before the scan. */
export const REVIEW_DIR = '.forge-review';

/** File name of part `part` (1-based) of a capture. */
export function shotFile(page: string, viewport: string, part = 1): string {
  return part <= 1 ? `${page}-${viewport}.png` : `${page}-${viewport}-${part}.png`;
}

/** Every file name a capture may produce (the report and the screenshot parts). */
export function expectedCaptureFiles(): Set<string> {
  const names = new Set<string>([REPORT_FILE]);
  for (const page of REVIEW_PAGES) {
    for (const viewport of REVIEW_VIEWPORTS) {
      for (let part = 1; part <= SHOT_MAX_PARTS; part += 1) {
        names.add(shotFile(page.id, viewport.id, part));
      }
    }
  }
  return names;
}

/** Host-side caps on what is read back from the capture output folder. */
export const CAPTURE_LIMITS = {
  maxReportBytes: 256 * 1024,
  maxShotBytes: 6 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
  /** Entries of the output folder looked at (anything else is ignored). */
  maxEntries: 64,
} as const;

/** In-container locations (docker/review.Dockerfile). */
export const CAPTURE_IN_CONTAINER = {
  script: '/opt/forge/review/capture.mjs',
  browser: '/usr/bin/chromium',
  /** Fixed port of `next start` inside the container (loopback only, network `none`). */
  port: 3000,
} as const;
