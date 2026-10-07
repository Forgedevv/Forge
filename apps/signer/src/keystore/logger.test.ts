import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { KeystoreError } from './errors.js';
import { REDACTED, REDACTED_BYTES, createKeystoreLogger, redactSecrets } from './logger.js';

function capture() {
  const lines: string[] = [];
  const logger = pino({ level: 'trace' }, { write: (line: string) => void lines.push(line) });
  return { lines, logger };
}

describe('redactSecrets', () => {
  it('redacts fields named like key/secret/token/private/passphrase at any depth', () => {
    const out = redactSecrets({
      secretKey: 'S1',
      apiToken: 'T1',
      privateKey: 'P1',
      passphrase: 'PP',
      SIGNER_HMAC_SECRET: 'H1',
      nested: { list: [{ seed: 'X' }, { fine: 'ok' }], KEY: 'K' },
      address: 'addr',
    }) as Record<string, unknown>;
    expect(out).toEqual({
      secretKey: REDACTED,
      apiToken: REDACTED,
      privateKey: REDACTED,
      passphrase: REDACTED,
      SIGNER_HMAC_SECRET: REDACTED,
      nested: { list: [{ seed: REDACTED }, { fine: 'ok' }], KEY: REDACTED },
      address: 'addr',
    });
  });

  it('redacts byte arrays wherever they are', () => {
    const out = redactSecrets({
      data: Buffer.from('abc'),
      arr: new Uint8Array(3),
      ab: new ArrayBuffer(2),
    });
    expect(out).toEqual({ data: REDACTED_BYTES, arr: REDACTED_BYTES, ab: REDACTED_BYTES });
  });

  it('reduces errors to name and code, keeping the message only for keystore errors', () => {
    const plain = new Error('contains something we do not control');
    const out = redactSecrets({ err: plain }) as { err: Record<string, unknown> };
    expect(out.err).toEqual({ name: 'Error' });

    const ks = new KeystoreError('NOT_FOUND', { ref: 'ks_0123456789abcdef0123456789abcdef' });
    const out2 = redactSecrets({ err: ks }) as { err: Record<string, unknown> };
    expect(out2.err).toMatchObject({
      name: 'KeystoreError',
      code: 'NOT_FOUND',
      message: ks.message,
    });
  });

  it('handles cycles and depth without throwing', () => {
    const a: Record<string, unknown> = { ok: 1 };
    a.self = a;
    expect(() => redactSecrets(a)).not.toThrow();
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { deep };
    expect(JSON.stringify(redactSecrets(deep))).toContain('[TRUNCATED]');
  });
});

describe('createKeystoreLogger', () => {
  it('never writes secret-looking fields to the pino stream', () => {
    const { lines, logger } = capture();
    const log = createKeystoreLogger(logger);
    log.info(
      {
        secretKey: 'DO-NOT-LOG-ME',
        passphrase: 'NOR-ME',
        bytes: Buffer.from('NEITHER'),
        address: 'addr',
      },
      'hello',
    );
    log.error({ err: new Error('OR-ME'), ref: 'ks_0123456789abcdef0123456789abcdef' }, 'failed');
    const text = lines.join('');
    expect(lines).toHaveLength(2);
    expect(text).not.toContain('DO-NOT-LOG-ME');
    expect(text).not.toContain('NOR-ME');
    expect(text).not.toContain('NEITHER');
    expect(text).not.toContain('OR-ME');
    expect(text).toContain('"module":"keystore"');
    expect(text).toContain('"address":"addr"');
    expect(text).toContain('ks_0123456789abcdef0123456789abcdef');
  });
});
