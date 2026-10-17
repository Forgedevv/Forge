import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * package.json declares `"sideEffects": false`: bundlers (the launchpad template, the web app)
 * may then drop any module of @forge/core whose exports are not used. That is only safe if
 * importing a module does nothing but define its exports. These tests import every module and
 * check that nothing outside them changes. No module of this package is imported statically here,
 * so the dynamic imports below are their first evaluation in this test file.
 */

const SRC = new URL('./', import.meta.url);
const modules = readdirSync(SRC)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort();

describe('@forge/core has no import side effects', () => {
  it('declares sideEffects: false', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      sideEffects?: unknown;
    };
    expect(pkg.sideEffects).toBe(false);
  });

  it('loading every module adds no global, and neither reads nor writes process.env', async () => {
    // Dependencies first: what they do when loaded is not this package's behaviour.
    await import('@solana/web3.js');
    await import('@solana/spl-token');
    await import('@meteora-ag/dynamic-bonding-curve-sdk');
    await import('@meteora-ag/cp-amm-sdk');
    await import('bn.js');
    await import('@noble/hashes/sha2');
    await import('@forge/shared');

    const globalsBefore = Object.getOwnPropertyNames(globalThis).sort();
    const original = process.env;
    const envBefore = JSON.stringify(original);
    const envReads: string[] = [];
    const envWrites: string[] = [];
    process.env = new Proxy(original, {
      get(target, property, receiver) {
        if (typeof property === 'string') envReads.push(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
      set(target, property, value, receiver) {
        if (typeof property === 'string') envWrites.push(property);
        return Reflect.set(target, property, value, receiver);
      },
    });
    try {
      expect(modules).toContain('index.ts');
      for (const name of modules) {
        await import(/* @vite-ignore */ `./${name.replace(/\.ts$/, '.js')}`);
      }
    } finally {
      process.env = original;
    }

    expect(envReads).toEqual([]);
    expect(envWrites).toEqual([]);
    expect(JSON.stringify(process.env)).toBe(envBefore);
    expect(Object.getOwnPropertyNames(globalThis).sort()).toEqual(globalsBefore);
  });
});
