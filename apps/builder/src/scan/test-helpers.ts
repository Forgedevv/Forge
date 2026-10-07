import { base58Encode } from './base58.js';
import { scanDiff } from './scan.js';
import type { ChangedFile, FileContent, RuleId, ScanOptions, ScanResult } from './types.js';

/** A valid-looking Solana address (USDC mint) and a few generated ones. */
export const ADDR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const ADDR_BYTES = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256);
export const ADDR2 = base58Encode(ADDR_BYTES);

export function added(path: string, content: FileContent, mode?: string): ChangedFile {
  return { path, status: 'added', oldContent: null, newContent: content, ...(mode ? { mode } : {}) };
}

export function modified(path: string, oldContent: FileContent, newContent: FileContent, mode?: string): ChangedFile {
  return { path, status: 'modified', oldContent, newContent, ...(mode ? { mode } : {}) };
}

export function deleted(path: string, oldContent: FileContent): ChangedFile {
  return { path, status: 'deleted', oldContent, newContent: null };
}

export function renamed(oldPath: string, path: string, content: FileContent): ChangedFile {
  return { path, oldPath, status: 'renamed', oldContent: content, newContent: content };
}

export function rulesOf(result: ScanResult): RuleId[] {
  return result.ok ? [] : result.violations.map((v) => v.rule);
}

export function scan(files: ChangedFile[], options?: ScanOptions): ScanResult {
  return scanDiff({ files }, options);
}

/** Scans a single new component file. */
export function scanComponent(source: string, options?: ScanOptions, path = 'src/components/Widget.tsx'): RuleId[] {
  return rulesOf(scan([added(path, source)], options));
}

export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
export const WOFF2 = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]);
export const ELF = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
