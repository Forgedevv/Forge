import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { RelayRequiredError, resolveSendConnection } from '../../src/forge/useSendTransaction';

const root = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('no server-side send route', () => {
  it('the /api/send-transaction route is gone', () => {
    expect(existsSync(join(root, 'src/pages/api/send-transaction.ts'))).toBe(false);
  });

  it('nothing in the site calls it', () => {
    for (const file of sourceFiles(join(root, 'src'))) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('send-transaction');
    }
  });
});

describe('resolveSendConnection', () => {
  const relay = 'https://forge.example/api/rpc';

  it('uses the relay connection by default (bare origin normalised to /api/rpc)', () => {
    const own = new Connection(relay);
    const factory = vi.fn(() => own);
    expect(resolveSendConnection(undefined, 'https://forge.example', factory)).toBe(own);
    expect(factory).toHaveBeenCalledWith('https://forge.example');
  });

  it('accepts a caller connection only when it points at the relay', () => {
    const own = new Connection(relay);
    expect(resolveSendConnection(own, 'https://forge.example')).toBe(own);
  });

  it('refuses any other endpoint, e.g. an RPC provider URL', () => {
    const provider = new Connection('https://mainnet.helius-rpc.com/?api-key=x');
    expect(() => resolveSendConnection(provider, relay)).toThrow(RelayRequiredError);
    expect(() =>
      resolveSendConnection(new Connection('https://evil.example/api/rpc'), relay),
    ).toThrow(/only be sent through the FORGE RPC relay/);
  });

  it('fails closed without a usable relay', () => {
    const own = new Connection(relay);
    expect(() => resolveSendConnection(own, undefined)).toThrow(/RPC relay missing/);
    expect(() => resolveSendConnection(undefined, 'ftp://forge.example')).toThrow(
      RelayRequiredError,
    );
    expect(() => resolveSendConnection(undefined, relay, () => null)).toThrow(RelayRequiredError);
  });
});
