import { describe, expect, it } from 'vitest';
import { assertDevnet, describeRpc, parseDotenv } from './env.js';

describe('parseDotenv', () => {
  it('parses keys, quotes, comments and export prefixes', () => {
    const parsed = parseDotenv(
      ['# comment', 'A=1', 'B="two words"', "C='x'", 'export D=4 # trailing', '', 'bad line', 'E='].join('\n'),
    );
    expect(parsed).toEqual({ A: '1', B: 'two words', C: 'x', D: '4', E: '' });
  });
});

describe('assertDevnet', () => {
  it('refuses a URL without devnet', () => {
    expect(() => assertDevnet('devnet', 'https://mainnet.helius-rpc.com/?api-key=x')).toThrow(/devnet/);
    expect(() => assertDevnet('mainnet-beta', 'https://devnet.helius-rpc.com/?api-key=x')).toThrow(/devnet/);
    expect(() => assertDevnet(undefined, undefined)).toThrow(/RPC_URL/);
  });
  it('accepts a devnet URL', () => {
    expect(assertDevnet('devnet', 'https://devnet.helius-rpc.com/?api-key=x')).toEqual({
      cluster: 'devnet',
      rpcUrl: 'https://devnet.helius-rpc.com/?api-key=x',
    });
    expect(assertDevnet(undefined, 'https://api.devnet.solana.com').cluster).toBe('devnet');
  });
});

describe('describeRpc', () => {
  it('only exposes the host', () => {
    expect(describeRpc('https://devnet.helius-rpc.com/?api-key=secret')).toBe('devnet.helius-rpc.com');
    expect(describeRpc('not a url')).toBe('<invalid url>');
  });
});
