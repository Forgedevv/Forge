import { describe, expect, it } from 'vitest';
import { cluster, forgeConfig, readPoolCreationFeeSol, siteConfig } from '@/forge/config';

describe('readPoolCreationFeeSol', () => {
  it('is undefined when absent', () => {
    expect(readPoolCreationFeeSol({})).toBeUndefined();
    expect(readPoolCreationFeeSol({ onchain: {} })).toBeUndefined();
    expect(readPoolCreationFeeSol(null)).toBeUndefined();
  });

  it('accepts zero and the 0.001 to 1 SOL range', () => {
    for (const fee of [0, 0.001, 0.5, 1]) {
      expect(readPoolCreationFeeSol({ onchain: { poolCreationFeeSol: fee } })).toBe(fee);
    }
  });

  it('rejects out-of-range values so a bad config fails the build', () => {
    for (const fee of [0.0005, 1.5, -1, 'abc']) {
      expect(() => readPoolCreationFeeSol({ onchain: { poolCreationFeeSol: fee } })).toThrow();
    }
  });
});

describe('bundled forge.config.json', () => {
  it('exposes the mode through the site config', () => {
    expect(siteConfig.mode).toBe(forgeConfig.mode);
    expect(['live', 'sleeping', 'disabled']).toContain(siteConfig.mode);
  });

  it('is frozen: no code of the site can change it at runtime', () => {
    expect(Object.isFrozen(forgeConfig)).toBe(true);
    expect(Object.isFrozen(forgeConfig.theme)).toBe(true);
    expect(() => {
      (forgeConfig as { mode: string }).mode = 'live';
    }).toThrow(TypeError);
  });

  it('defaults the cluster to devnet before the on-chain setup', () => {
    // The bundled example has no on-chain block and the tests set no cluster variable.
    expect(forgeConfig.onchain).toBeUndefined();
    expect(cluster).toBe('devnet');
  });
});
