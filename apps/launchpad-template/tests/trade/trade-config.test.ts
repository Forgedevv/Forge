import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  explorerTxUrl,
  resolveJupiterReferral,
  resolveRelayUrl,
} from '../../src/forge/trade/trade-config';

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
