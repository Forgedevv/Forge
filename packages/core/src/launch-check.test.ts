import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  LAUNCH_CHECK_DBC_PROGRAM_ID,
  LAUNCH_DBC_DISCRIMINATORS,
  launchPoolAddress,
  verifyLaunchCoinTransaction,
} from './launch-check.js';

/*
 * The launch check keeps its own copies of the protocol constants (so that it only depends on
 * @solana/web3.js and can run in the browser): they must match the pinned SDK. The checks on
 * real transactions built by `buildLaunchCoinTx` are in pool.test.ts.
 */

const anchor = (name: string) => [
  ...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8),
];

describe('launch check constants', () => {
  it('uses the DBC program id of the pinned SDK', () => {
    expect(LAUNCH_CHECK_DBC_PROGRAM_ID.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)).toBe(true);
  });

  it('uses the Anchor discriminators of the launch instructions', () => {
    expect([...LAUNCH_DBC_DISCRIMINATORS.initializeVirtualPoolWithSplToken]).toEqual(
      anchor('initialize_virtual_pool_with_spl_token'),
    );
    expect([...LAUNCH_DBC_DISCRIMINATORS.swap]).toEqual(anchor('swap'));
  });

  it('derives the pool like the SDK, whichever mint sorts first', () => {
    for (let i = 0; i < 20; i++) {
      const config = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      expect(
        launchPoolAddress(config, mint).equals(deriveDbcPoolAddress(NATIVE_MINT, mint, config)),
      ).toBe(true);
    }
  });

  it('stays browser-light: only @solana/web3.js (the web client imports it directly)', () => {
    const imports = (file: string) =>
      [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/from '([^']+)'/g)].map(
        (m) => m[1],
      );
    expect(new Set(imports('./launch-check.ts'))).toEqual(new Set(['@solana/web3.js', './tx.js']));
    expect(new Set(imports('./tx.ts'))).toEqual(new Set(['@solana/web3.js']));
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, { default: string }>;
    };
    expect(pkg.exports['./launch-check']?.default).toBe('./dist/launch-check.js');
  });

  it('refuses a malformed expectation as a caller bug', () => {
    expect(() =>
      verifyLaunchCoinTransaction(new Uint8Array(1), { owner: 'not-a-key', firstBuyLamports: 0n }),
    ).toThrow(TypeError);
    expect(() =>
      verifyLaunchCoinTransaction(new Uint8Array(1), {
        owner: Keypair.generate().publicKey,
        firstBuyLamports: -1n,
      }),
    ).toThrow(TypeError);
  });
});
