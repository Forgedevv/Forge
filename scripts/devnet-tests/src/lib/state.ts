/**
 * Resumable state for the devnet tests.
 *
 * Everything lives in `scripts/devnet-tests/.state/state.json` (gitignored). Each completed step
 * stores its result under a key; rerunning a script returns the stored result instead of redoing
 * the step. Keypairs are stored separately in `.state/wallets/` (see wallets.ts).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATE_DIR } from './env.js';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface StateFile {
  version: 1;
  steps: Record<string, Json>;
}

const STATE_PATH = resolve(STATE_DIR, 'state.json');

export class State {
  private data: StateFile;

  constructor(data: StateFile) {
    this.data = data;
  }

  static load(): State {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    if (!existsSync(STATE_PATH)) return new State({ version: 1, steps: {} });
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as StateFile;
    if (parsed.version !== 1 || typeof parsed.steps !== 'object') {
      throw new Error(`Unexpected state file format at ${STATE_PATH}`);
    }
    return new State(parsed);
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.steps, key);
  }

  get<T extends Json>(key: string): T | undefined {
    return this.data.steps[key] as T | undefined;
  }

  require<T extends Json>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined)
      throw new Error(`Missing state step "${key}": run the previous steps first`);
    return value;
  }

  set(key: string, value: Json): void {
    this.data.steps[key] = value;
    this.save();
  }

  delete(key: string): void {
    delete this.data.steps[key];
    this.save();
  }

  keys(prefix = ''): string[] {
    return Object.keys(this.data.steps).filter((k) => k.startsWith(prefix));
  }

  /**
   * Runs `fn` once: if `key` already has a stored result, returns it without running `fn`.
   * The result must be JSON (strings for pubkeys and signatures, strings for bigints).
   */
  async step<T extends Json>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.get<T>(key);
    if (existing !== undefined) {
      console.log(`  [skip] ${key} (already done)`);
      return existing;
    }
    console.log(`  [run ] ${key}`);
    const result = await fn();
    this.set(key, result);
    return result;
  }

  private save(): void {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
    renameSync(tmp, STATE_PATH);
  }
}
