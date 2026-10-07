import { randomBytes, verify as ed25519Verify } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KEYSTORE_DIR,
  REF_RE,
  creatorRole,
  isKeystoreError,
  keystoreOptionsFromEnv,
  openKeystore,
  type KeystoreSigner,
} from './keystore.js';
import { Envelope, openEnvelope } from './keystore/envelope.js';

const PASSPHRASE = 'correct horse battery staple correct horse battery staple';
const OTHER_PASSPHRASE = 'correct horse battery staple correct horse battery stable';
const FAST = { N: 1 << 14, r: 8, p: 1 };
const LAUNCHPAD_ID = '7d444840-9dc0-41a7-9a4e-4d0f2b8f6a3c';
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let dir: string;
const open = (overrides: Partial<Parameters<typeof openKeystore>[0]> = {}) =>
  openKeystore({ dir, passphrase: PASSPHRASE, scrypt: FAST, ...overrides });

function verifyEd25519(publicKey: PublicKey, message: Uint8Array, signature: Uint8Array): boolean {
  const key = Buffer.concat([SPKI_ED25519_PREFIX, publicKey.toBytes()]);
  return ed25519Verify(null, message, { key, format: 'der', type: 'spki' }, signature);
}

function fakeBlockhash(): string {
  return new PublicKey(randomBytes(32)).toBase58();
}

async function keyFiles(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
}

async function readEnvelope(file: string): Promise<Envelope> {
  return Envelope.parse(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')));
}

async function writeEnvelope(file: string, envelope: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, file), JSON.stringify(envelope, null, 2));
}

function rejectsWith(code: Parameters<typeof isKeystoreError>[1]) {
  return (e: unknown) => isKeystoreError(e, code);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-keystore-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('passphrase policy', () => {
  it('refuses a passphrase shorter than 32 characters', async () => {
    await expect(open({ passphrase: 'a'.repeat(31) })).rejects.toSatisfy(
      rejectsWith('PASSPHRASE_INVALID'),
    );
    await expect(open({ passphrase: '' })).rejects.toSatisfy(rejectsWith('PASSPHRASE_INVALID'));
  });

  it('refuses surrounding whitespace, control characters and non-strings', async () => {
    await expect(open({ passphrase: `${PASSPHRASE}\n` })).rejects.toSatisfy(
      rejectsWith('PASSPHRASE_INVALID'),
    );
    await expect(open({ passphrase: ` ${PASSPHRASE}` })).rejects.toSatisfy(
      rejectsWith('PASSPHRASE_INVALID'),
    );
    await expect(
      open({ passphrase: `${PASSPHRASE.slice(0, 20)}\t${PASSPHRASE}` }),
    ).rejects.toSatisfy(rejectsWith('PASSPHRASE_INVALID'));
    await expect(open({ passphrase: undefined as unknown as string })).rejects.toSatisfy(
      rejectsWith('PASSPHRASE_INVALID'),
    );
    expect(await keyFiles()).toEqual([]);
  });

  it('refuses KDF parameters below the floor', async () => {
    await expect(open({ scrypt: { N: 1 << 10 } })).rejects.toSatisfy(rejectsWith('INVALID_PARAMS'));
  });

  it('reads its configuration from the environment with a default directory', () => {
    expect(() => keystoreOptionsFromEnv({})).toThrow();
    const opts = keystoreOptionsFromEnv({ SIGNER_KEYSTORE_PASSPHRASE: PASSPHRASE });
    expect(opts.passphrase).toBe(PASSPHRASE);
    expect(opts.dir).toBe(path.resolve(DEFAULT_KEYSTORE_DIR));
    expect(
      keystoreOptionsFromEnv({ SIGNER_KEYSTORE_PASSPHRASE: PASSPHRASE, SIGNER_KEYSTORE_DIR: dir })
        .dir,
    ).toBe(path.resolve(dir));
  });
});

describe('createKey', () => {
  it('creates one key per role, idempotently', async () => {
    const ks = await open();
    const first = await ks.createKey('payer');
    expect(first.created).toBe(true);
    expect(first.ref).toMatch(REF_RE);

    const again = await ks.createKey('payer');
    expect(again.created).toBe(false);
    expect(again.ref).toBe(first.ref);
    expect(again.publicKey.equals(first.publicKey)).toBe(true);

    const creator = await ks.createKey(creatorRole(LAUNCHPAD_ID));
    expect(creator.ref).not.toBe(first.ref);
    expect(await keyFiles()).toEqual([`creator-${LAUNCHPAD_ID}.json`, 'payer.json']);
    expect(await ks.findRef('payer')).toBe(first.ref);
    expect(await ks.findRef('cashbox')).toBeUndefined();
    expect(await ks.listRefs()).toEqual([
      { ref: creator.ref, role: `creator:${LAUNCHPAD_ID}` },
      { ref: first.ref, role: 'payer' },
    ]);
  });

  it('is idempotent under concurrent calls for the same role', async () => {
    const ks = await open();
    const results = await Promise.all(Array.from({ length: 5 }, () => ks.createKey('buyback')));
    const refs = new Set(results.map((r) => r.ref));
    expect(refs.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await keyFiles()).toEqual(['buyback.json']);
  });

  it('is idempotent across keystore instances on the same directory', async () => {
    const a = await open();
    const created = await a.createKey('cashbox');
    await a.close();
    const b = await open();
    const again = await b.createKey('cashbox');
    expect(again).toEqual({ ref: created.ref, publicKey: created.publicKey, created: false });
    expect((await b.getPublicKey(created.ref)).equals(created.publicKey)).toBe(true);
  });

  it('rejects invalid roles and refs before touching the disk', async () => {
    const ks = await open();
    for (const role of [
      '',
      'admin',
      'creator:',
      'creator:not-a-uuid',
      `creator:${LAUNCHPAD_ID.toUpperCase()}`,
      'creator:../x',
      'payer.json',
    ]) {
      await expect(ks.createKey(role)).rejects.toSatisfy(rejectsWith('INVALID_ROLE'));
    }
    for (const ref of ['', '../payer', 'payer', 'ks_short', `ks_${'g'.repeat(32)}`]) {
      await expect(ks.getPublicKey(ref)).rejects.toSatisfy(rejectsWith('INVALID_REF'));
      await expect(ks.withSigner(ref, () => undefined)).rejects.toSatisfy(
        rejectsWith('INVALID_REF'),
      );
    }
    await expect(ks.getPublicKey(`ks_${'0'.repeat(32)}`)).rejects.toSatisfy(
      rejectsWith('NOT_FOUND'),
    );
    expect(await keyFiles()).toEqual([]);
  });

  it('writes refs that carry no key material', async () => {
    const ks = await open();
    const { ref, publicKey } = await ks.createKey('payer');
    const envelope = await readEnvelope('payer.json');
    const secret = await openEnvelope(envelope, Buffer.from(PASSPHRASE, 'utf8'));
    const text = JSON.stringify(envelope);
    for (const enc of ['base64', 'hex'] as const) {
      expect(text).not.toContain(secret.toString(enc));
      expect(text).not.toContain(secret.subarray(0, 32).toString(enc));
      expect(secret.toString(enc)).not.toContain(ref.slice(3));
    }
    expect(publicKey.toBase58()).not.toContain(ref.slice(3));
    expect(envelope.publicKey).toBe(publicKey.toBase58());

    // The ref is random, not derived from the role: another keystore gets another ref.
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-keystore-'));
    try {
      const other = await openKeystore({ dir: otherDir, passphrase: PASSPHRASE, scrypt: FAST });
      expect((await other.createKey('payer')).ref).not.toBe(ref);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'writes files and directory with restrictive permissions',
    async () => {
      const ks = await open();
      await ks.createKey('payer');
      const file = await fs.stat(path.join(dir, 'payer.json'));
      expect(file.mode & 0o777).toBe(0o600);
      const directory = await fs.stat(dir);
      expect(directory.mode & 0o777).toBe(0o700);
    },
  );

  it('leaves no temporary file behind', async () => {
    const ks = await open();
    await ks.createKey('payer');
    await ks.createKey('cashbox');
    expect((await fs.readdir(dir)).sort()).toEqual(['cashbox.json', 'payer.json']);
  });
});

describe('withSigner', () => {
  it('signs messages, legacy and versioned transactions with the advertised public key', async () => {
    const ks = await open();
    const { ref, publicKey } = await ks.createKey('payer');
    const message = Buffer.from('forge keystore test message');

    const result = await ks.withSigner(ref, (signer) => {
      expect(signer.ref).toBe(ref);
      expect(signer.role).toBe('payer');
      expect(signer.publicKey.equals(publicKey)).toBe(true);

      const signature = signer.signMessage(message);
      expect(signature).toHaveLength(64);
      expect(verifyEd25519(publicKey, message, signature)).toBe(true);
      expect(verifyEd25519(publicKey, Buffer.from('other'), signature)).toBe(false);

      const transfer = SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: new PublicKey(randomBytes(32)),
        lamports: 1,
      });
      const legacy = new Transaction({ feePayer: publicKey, recentBlockhash: fakeBlockhash() }).add(
        transfer,
      );
      signer.signTransaction(legacy);
      expect(legacy.verifySignatures(true)).toBe(true);

      const v0 = new VersionedTransaction(
        new TransactionMessage({
          payerKey: publicKey,
          recentBlockhash: fakeBlockhash(),
          instructions: [transfer],
        }).compileToV0Message(),
      );
      signer.signTransaction(v0);
      expect(v0.signatures).toHaveLength(1);
      expect(verifyEd25519(publicKey, v0.message.serialize(), v0.signatures[0] as Uint8Array)).toBe(
        true,
      );
      return 'done';
    });
    expect(result).toBe('done');
  });

  it('releases the signer after the callback, even when it throws', async () => {
    const ks = await open();
    const { ref } = await ks.createKey('payer');
    let escaped: KeystoreSigner | undefined;
    await ks.withSigner(ref, (signer) => {
      escaped = signer;
    });
    expect(() => escaped?.signMessage(Buffer.from('x'))).toThrow(/released/);
    expect(() => escaped?.signTransaction(new Transaction())).toThrow(/released/);

    await expect(
      ks.withSigner(ref, (signer) => {
        escaped = signer;
        throw new Error('callback failure');
      }),
    ).rejects.toThrow('callback failure');
    expect(() => escaped?.signMessage(Buffer.from('x'))).toThrow(/released/);
  });

  it('rejects a tampered ciphertext (GCM authentication)', async () => {
    const ks = await open();
    const { ref } = await ks.createKey('payer');
    const envelope = await readEnvelope('payer.json');
    const bytes = Buffer.from(envelope.cipher.ciphertext, 'base64');
    bytes[5] = (bytes[5] ?? 0) ^ 0x80;
    await writeEnvelope('payer.json', {
      ...envelope,
      cipher: { ...envelope.cipher, ciphertext: bytes.toString('base64') },
    });
    await expect(ks.withSigner(ref, () => undefined)).rejects.toSatisfy(
      rejectsWith('DECRYPT_FAILED'),
    );
    // A fresh instance refuses to open at all: it cannot prove the passphrase.
    await expect(open()).rejects.toSatisfy(rejectsWith('PASSPHRASE_MISMATCH'));
  });

  it('rejects a swapped public key (bound as authenticated data)', async () => {
    const ks = await open();
    const { ref } = await ks.createKey('payer');
    const envelope = await readEnvelope('payer.json');
    await writeEnvelope('payer.json', {
      ...envelope,
      publicKey: new PublicKey(randomBytes(32)).toBase58(),
    });
    await expect(ks.withSigner(ref, () => undefined)).rejects.toSatisfy(
      rejectsWith('DECRYPT_FAILED'),
    );
  });
});

describe('opening an existing directory', () => {
  it('rejects a wrong passphrase before any key is used', async () => {
    const ks = await open();
    await ks.createKey('payer');
    await ks.close();
    await expect(open({ passphrase: OTHER_PASSPHRASE })).rejects.toSatisfy(
      rejectsWith('PASSPHRASE_MISMATCH'),
    );
    expect(await keyFiles()).toEqual(['payer.json']);
  });

  it('refuses corrupt key files and files whose role does not match their name', async () => {
    const ks = await open();
    await ks.createKey('payer');
    const envelope = await readEnvelope('payer.json');
    await ks.close();

    await fs.writeFile(path.join(dir, 'cashbox.json'), '{ not json');
    await expect(open()).rejects.toSatisfy(rejectsWith('CORRUPT_FILE'));
    await fs.rm(path.join(dir, 'cashbox.json'));

    await writeEnvelope('cashbox.json', envelope); // says "payer" inside
    await expect(open()).rejects.toSatisfy(rejectsWith('CORRUPT_FILE'));
    await fs.rm(path.join(dir, 'cashbox.json'));

    await writeEnvelope('buyback.json', { ...envelope, role: 'buyback', extra: 1 });
    await expect(open()).rejects.toSatisfy(rejectsWith('CORRUPT_FILE'));
    await fs.rm(path.join(dir, 'buyback.json'));

    // Unrelated files are ignored.
    await fs.writeFile(path.join(dir, 'README.txt'), 'not a key');
    await fs.writeFile(path.join(dir, 'notes.json'), '{}');
    const reopened = await open();
    expect(await reopened.listRefs()).toEqual([{ ref: envelope.ref, role: 'payer' }]);
  });

  it('refuses two files sharing one ref', async () => {
    const ks = await open();
    await ks.createKey('payer');
    const envelope = await readEnvelope('payer.json');
    await ks.close();
    await writeEnvelope('cashbox.json', { ...envelope, role: 'cashbox' });
    await expect(open()).rejects.toSatisfy(rejectsWith('CORRUPT_FILE'));
  });

  it('rejects every call after close()', async () => {
    const ks = await open();
    const { ref } = await ks.createKey('payer');
    await ks.close();
    await expect(ks.createKey('cashbox')).rejects.toSatisfy(rejectsWith('CLOSED'));
    await expect(ks.getPublicKey(ref)).rejects.toSatisfy(rejectsWith('CLOSED'));
    await expect(ks.withSigner(ref, () => undefined)).rejects.toSatisfy(rejectsWith('CLOSED'));
    await expect(ks.listRefs()).rejects.toSatisfy(rejectsWith('CLOSED'));
  });

  it('does not seal a key under a zeroed passphrase when close() runs mid-createKey', async () => {
    const ks = await open();
    const role = creatorRole(LAUNCHPAD_ID);
    const realReaddir = fs.readdir.bind(fs);
    let closing: Promise<void> | undefined;
    // close() lands while createKey is scanning the directory (after its first open check).
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((
      ...args: Parameters<typeof fs.readdir>
    ) => {
      closing ??= ks.close();
      return realReaddir(...args);
    }) as typeof fs.readdir);
    try {
      await expect(ks.createKey(role)).rejects.toSatisfy(rejectsWith('CLOSED'));
    } finally {
      spy.mockRestore();
    }
    await closing;
    expect(await keyFiles()).toEqual([]);
  });

  it('close() waits for calls in flight before zeroing the passphrase', async () => {
    const first = await open();
    await first.createKey('buyback');
    const { ref } = await first.createKey('payer');
    await first.close();

    const ks = await open(); // verifies buyback.json only: payer is decrypted on demand
    const realReadFile = fs.readFile.bind(fs);
    let closing: Promise<void> | undefined;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(((
      ...args: Parameters<typeof fs.readFile>
    ) => {
      closing ??= ks.close();
      return realReadFile(...args);
    }) as typeof fs.readFile);
    try {
      const publicKey = await ks.getPublicKey(ref);
      expect(publicKey.toBase58()).toBe((await readEnvelope('payer.json')).publicKey);
    } finally {
      spy.mockRestore();
    }
    expect(closing).toBeDefined();
    await closing;
    await expect(ks.getPublicKey(ref)).rejects.toSatisfy(rejectsWith('CLOSED'));
  });

  it('creates keys with the default KDF parameters', { timeout: 60_000 }, async () => {
    const ks = await openKeystore({ dir, passphrase: PASSPHRASE });
    const { ref } = await ks.createKey('payer');
    const envelope = await readEnvelope('payer.json');
    expect(envelope.kdf).toMatchObject({ name: 'scrypt', N: 131072, r: 8, p: 1 });
    await ks.close();
    const reopened = await openKeystore({ dir, passphrase: PASSPHRASE });
    expect((await reopened.getPublicKey(ref)).toBase58()).toBe(envelope.publicKey);
  });
});

describe('logging', () => {
  it('never logs the passphrase or key material, even on errors', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'trace' }, { write: (line: string) => void lines.push(line) });
    const ks = await open({ logger });
    const { ref, publicKey } = await ks.createKey('payer');
    await ks.withSigner(ref, (signer) => signer.signMessage(Buffer.from('m')));
    const envelope = await readEnvelope('payer.json');
    const secret = await openEnvelope(envelope, Buffer.from(PASSPHRASE, 'utf8'));

    // Error paths: tampered file, wrong passphrase, then open with the logger again.
    await writeEnvelope('payer.json', {
      ...envelope,
      cipher: { ...envelope.cipher, tag: envelope.cipher.nonce + 'AAAAAA' },
    });
    await ks.withSigner(ref, () => undefined).catch(() => undefined);
    await open({ logger, passphrase: OTHER_PASSPHRASE }).catch(() => undefined);
    await open({ logger }).catch(() => undefined);

    const text = lines.join('');
    expect(lines.length).toBeGreaterThan(0);
    expect(text).toContain('"module":"keystore"');
    expect(text).toContain('key created');
    expect(text).toContain(ref);
    expect(text).toContain(publicKey.toBase58());
    for (const forbidden of [
      PASSPHRASE,
      OTHER_PASSPHRASE,
      secret.toString('base64'),
      secret.toString('hex'),
      secret.subarray(0, 32).toString('base64'),
      secret.subarray(0, 32).toString('hex'),
      envelope.cipher.ciphertext,
      envelope.kdf.salt,
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('wraps third-party failures so their messages never reach the caller', async () => {
    const ks = await open();
    const { ref } = await ks.createKey('payer');
    await fs.rm(path.join(dir, 'payer.json'));
    const err = await ks.withSigner(ref, () => undefined).catch((e: unknown) => e);
    expect(isKeystoreError(err, 'NOT_FOUND')).toBe(true);
    expect((err as Error).message).not.toContain(dir);
    expect((err as Error).message).not.toContain(PASSPHRASE);
  });
});
