/** Types of the exports of capture.mjs (plain Node ESM, run as is in the review image). */

export declare const PAGES: ReadonlyArray<{ id: string; path: string }>;
export declare const VIEWPORTS: ReadonlyArray<{
  id: string;
  width: number;
  height: number;
  mobile: boolean;
}>;
export declare const SHOT_MAX_HEIGHT: number;
export declare const SHOT_PART_HEIGHT: number;
export declare const MAX_OVERFLOWING: number;
export declare const MAX_CONSOLE_MESSAGES: number;
export declare const REPORT_FILE: string;
export declare const DATAPI_ORIGIN: string;

export declare function shotFile(page: string, viewport: string, part?: number): string;
export declare function routeRequest(
  rawUrl: string,
  siteOrigin: string,
): 'continue' | 'fixture' | 'block';
export declare function datapiFixture(
  rawUrl: string,
  method: string,
  headers?: Record<string, string>,
): { status: number; headers: Array<{ name: string; value: string }>; body: string };
export declare function findBrowser(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  exists?: (file: string) => boolean,
): string | null;
export declare function browserArgs(options: { userDataDir: string; noSandbox: boolean }): string[];

export interface CaptureOptions {
  out?: string;
  site?: string;
  url?: string;
  port: number;
  browser?: string;
  noSandbox: boolean;
  deadlineMs: number;
  pages: string[];
  viewports: string[];
}
export declare function parseArgs(argv: string[]): CaptureOptions;
export declare function capture(options: CaptureOptions): Promise<unknown>;
