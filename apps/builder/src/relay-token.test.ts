/// <reference types="node" />
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RELAY_TOKEN_ENV, RELAY_TOKEN_RE, rpcRelayToken } from './relay-token.js';

const SECRET = 'relay-secret-for-tests-0123456789abcdef';

describe('rpcRelayToken', () => {
  it('is "v1." + slug + "." + hex(HMAC-SHA256(secret, "forge-rpc-relay:v1:" + slug))', () => {
    const mac = createHmac('sha256', SECRET).update('forge-rpc-relay:v1:moonpad').digest('hex');
    expect(rpcRelayToken(SECRET, 'moonpad')).toBe(`v1.moonpad.${mac}`);
    expect(rpcRelayToken(SECRET, 'moonpad')).toMatch(RELAY_TOKEN_RE);
    // One token per launchpad, and per secret.
    expect(rpcRelayToken(SECRET, 'sunpad')).not.toBe(rpcRelayToken(SECRET, 'moonpad'));
    expect(rpcRelayToken(`${SECRET}x`, 'moonpad')).not.toBe(rpcRelayToken(SECRET, 'moonpad'));
  });

  it('is a server-only variable', () => {
    expect(RELAY_TOKEN_ENV).toBe('FORGE_RPC_RELAY_TOKEN');
    expect(RELAY_TOKEN_ENV.startsWith('NEXT_PUBLIC_')).toBe(false);
  });

  it('refuses a short secret or a bad slug, without echoing the secret', () => {
    const short = 's'.repeat(31);
    let message = '';
    try {
      rpcRelayToken(short, 'moonpad');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/RPC_RELAY_TOKEN_SECRET/);
    expect(message).not.toContain(short);
    expect(() => rpcRelayToken(SECRET, 'Moon.Pad')).toThrow(/slug/);
    expect(() => rpcRelayToken(SECRET, 'ab')).toThrow(/slug/);
  });
});
