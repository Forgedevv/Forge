/**
 * Environment loading for the devnet test scripts.
 *
 * `scripts/devnet-tests/.env` holds SOLANA_CLUSTER and RPC_URL (the RPC URL embeds an API key).
 * The values are never printed, logged or written to a report: only `describeRpc()` is safe to show.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Absolute path of `scripts/devnet-tests/`. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_DIR = resolve(PACKAGE_DIR, '.state');
export const REPORTS_DIR = resolve(PACKAGE_DIR, 'reports');

export interface Env {
  cluster: 'devnet';
  rpcUrl: string;
}

/**
 * Minimal dotenv-style parser: `KEY=value` lines, `#` comments, optional single or double quotes,
 * `export ` prefix tolerated. Does not expand variables.
 */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2]!;
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Throws unless the RPC URL contains "devnet" (PLANEXECUTE.md rule 4). */
export function assertDevnet(cluster: string | undefined, rpcUrl: string | undefined): Env {
  if (!rpcUrl) throw new Error('RPC_URL is missing: set it in scripts/devnet-tests/.env');
  if (!rpcUrl.toLowerCase().includes('devnet')) {
    throw new Error('Refusing to run: RPC_URL does not contain "devnet". These scripts are devnet only.');
  }
  if (cluster !== undefined && cluster !== 'devnet') {
    throw new Error(`Refusing to run: SOLANA_CLUSTER is "${cluster}", expected "devnet".`);
  }
  return { cluster: 'devnet', rpcUrl };
}

/** A description of the RPC endpoint that is safe to print (host only, no path or query). */
export function describeRpc(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return '<invalid url>';
  }
}

/** Loads `.env` (if present) on top of `process.env`, then validates the devnet rule. */
export function loadEnv(): Env {
  const envPath = resolve(PACKAGE_DIR, '.env');
  const fromFile = existsSync(envPath) ? parseDotenv(readFileSync(envPath, 'utf8')) : {};
  const cluster = process.env.SOLANA_CLUSTER ?? fromFile.SOLANA_CLUSTER;
  const rpcUrl = process.env.RPC_URL ?? fromFile.RPC_URL;
  return assertDevnet(cluster, rpcUrl);
}
