import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ onchain: undefined as { cluster: string } | undefined }));
vi.mock('../../src/forge/config', () => ({
  get onchainConfig() {
    return state.onchain;
  },
}));

import {
  explorerTxUrl,
  resolveCluster,
  resolveJupiterReferral,
  resolveRelayUrl,
} from '../../src/forge/trade/trade-config';

afterEach(() => {
  state.onchain = undefined;
});

describe('resolveCluster (devnet by default)', () => {
  it('is devnet unless mainnet-beta is explicit', () => {
    expect(resolveCluster({})).toBe('devnet');
    expect(resolveCluster({ cluster: 'devnet' })).toBe('devnet');
    expect(resolveCluster({ cluster: 'mainnet' })).toBe('devnet');
    expect(resolveCluster({ cluster: 'testnet' })).toBe('devnet');
    expect(resolveCluster({ cluster: 'mainnet-beta' })).toBe('mainnet-beta');
  });

  it("follows the launchpad's on-chain cluster when it is set", () => {
    state.onchain = { cluster: 'mainnet-beta' };
    expect(resolveCluster({ cluster: 'devnet' })).toBe('mainnet-beta');
    state.onchain = { cluster: 'devnet' };
    expect(resolveCluster({ cluster: 'mainnet-beta' })).toBe('devnet');
  });
});

describe('resolveRelayUrl', () => {
  it('appends the relay path to a bare origin', () => {
    expect(resolveRelayUrl('https://forge.example')).toBe('https://forge.example/api/rpc');
    expect(resolveRelayUrl('https://forge.example/')).toBe('https://forge.example/api/rpc');
  });
  it('keeps an explicit path and rejects unusable values', () => {
    expect(resolveRelayUrl('https://forge.example/custom/rpc')).toBe(
      'https://forge.example/custom/rpc',
    );
    expect(resolveRelayUrl(undefined)).toBeNull();
    expect(resolveRelayUrl('')).toBeNull();
    expect(resolveRelayUrl('not a url')).toBeNull();
    expect(resolveRelayUrl('wss://forge.example')).toBeNull();
  });
});

describe('resolveJupiterReferral', () => {
  it('accepts a valid address only', () => {
    const key = Keypair.generate().publicKey.toBase58();
    expect(resolveJupiterReferral(key)).toBe(key);
    expect(resolveJupiterReferral('11111111111111111111111111111111')).toBeNull();
    expect(resolveJupiterReferral('nope')).toBeNull();
    expect(resolveJupiterReferral(undefined)).toBeNull();
  });
});

describe('explorerTxUrl', () => {
  it('adds the cluster outside mainnet', () => {
    expect(explorerTxUrl('abc', 'devnet')).toBe(
      'https://explorer.solana.com/tx/abc?cluster=devnet',
    );
    expect(explorerTxUrl('abc', 'mainnet-beta')).toBe('https://explorer.solana.com/tx/abc');
  });
});
