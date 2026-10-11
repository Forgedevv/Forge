import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  clientIp,
  createNonceStore,
  createRateLimiter,
  sha256HexNode,
  verifyWalletSignature,
} from '@/forge/create/server-guards';
import { signWithKeypair } from './sign';

describe('createRateLimiter', () => {
  it('allows `limit` requests per window and key, then answers with Retry-After', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
    expect(limiter.take('1.1.1.1').allowed).toBe(true);
    expect(limiter.take('1.1.1.1').allowed).toBe(true);
    const third = limiter.take('1.1.1.1');
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBe(60);
    expect(limiter.take('2.2.2.2').allowed).toBe(true);
    t = 30_000;
    expect(limiter.take('1.1.1.1').retryAfterSeconds).toBe(30);
    t = 60_000;
    expect(limiter.take('1.1.1.1').allowed).toBe(true);
  });

  it('keeps memory bounded', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2, now: () => 0 });
    limiter.take('a');
    limiter.take('b');
    limiter.take('c');
    // 'a' was evicted: it starts over.
    expect(limiter.take('a').allowed).toBe(true);
  });
});

describe('createNonceStore', () => {
  it('accepts a (wallet, nonce) once within the TTL', () => {
    let t = 0;
    const store = createNonceStore({ ttlMs: 1000, now: () => t });
    expect(store.consume('w', 'n1')).toBe(true);
    expect(store.consume('w', 'n1')).toBe(false);
    expect(store.consume('other', 'n1')).toBe(true);
    t = 1001;
    expect(store.consume('w', 'n1')).toBe(true);
  });
});

describe('clientIp', () => {
  it('takes the first X-Forwarded-For hop, then X-Real-IP, then the socket', () => {
    expect(clientIp({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, '127.0.0.1')).toBe('9.9.9.9');
    expect(clientIp({ 'x-real-ip': '8.8.8.8' }, '127.0.0.1')).toBe('8.8.8.8');
    expect(clientIp({}, '127.0.0.1')).toBe('127.0.0.1');
    expect(clientIp({})).toBe('unknown');
  });
});

describe('verifyWalletSignature', () => {
  const wallet = Keypair.generate();
  const message = new TextEncoder().encode('hello');

  it('accepts the wallet signature of the message', () => {
    const signature = signWithKeypair(wallet, message);
    expect(verifyWalletSignature(wallet.publicKey.toBase58(), message, signature)).toBe(true);
  });

  it('refuses another message, another wallet or a malformed signature', () => {
    const signature = signWithKeypair(wallet, message);
    expect(
      verifyWalletSignature(
        wallet.publicKey.toBase58(),
        new TextEncoder().encode('hellO'),
        signature,
      ),
    ).toBe(false);
    expect(verifyWalletSignature(Keypair.generate().publicKey.toBase58(), message, signature)).toBe(
      false,
    );
    expect(
      verifyWalletSignature(wallet.publicKey.toBase58(), message, signature.slice(0, 63)),
    ).toBe(false);
    expect(verifyWalletSignature('not-a-wallet', message, signature)).toBe(false);
  });
});

describe('sha256HexNode', () => {
  it('hashes bytes to lowercase hex', () => {
    expect(sha256HexNode(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
