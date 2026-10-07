/**
 * Signer keystore: the only place FORGE private keys live.
 *
 * - One Solana keypair per role (`payer`, `cashbox`, `buyback`, `creator:<launchpadId>`),
 *   generated here with Node's CSPRNG. No function accepts a private key from a caller and
 *   no function returns raw secret key bytes.
 * - Each key is stored as one JSON file in SIGNER_KEYSTORE_DIR, encrypted with
 *   scrypt + AES-256-GCM under SIGNER_KEYSTORE_PASSPHRASE (see keystore/envelope.ts).
 *   The file name is derived from the role, so a role can never have two keys; the file
 *   is published with an exclusive hard link, so a race can never overwrite a key.
 * - Secrets are decrypted only inside `withSigner`, used through a signer object that can
 *   sign transactions and messages but never exposes its bytes, then zeroed (best effort:
 *   JavaScript cannot guarantee that copies made by libraries are erased).
 * - A public key is only handed out once this process has proven, by decrypting the key,
 *   that the file's public key matches the secret (cached per process after that).
 * - Opening the keystore verifies the passphrase against an existing key, so two different
 *   passphrases can never end up mixed in one directory.
 * - Logs go through a redacting child logger; errors carry static messages only.
 */

import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as ed25519Sign,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PublicKey, VersionedTransaction, type Transaction } from '@solana/web3.js';
import type pino from 'pino';
import {
  DEFAULT_SCRYPT,
  Envelope,
  SOLANA_SECRET_KEY_LENGTH,
  assertCreationParams,
  openEnvelope,
  sealSecret,
  type ScryptParams,
} from './keystore/envelope.js';
import { KeystoreError, wrapError } from './keystore/errors.js';
import {
  createKeystoreLogger,
  silentKeystoreLogger,
  type KeystoreLogger,
} from './keystore/logger.js';
import {
  newRef,
  parseRef,
  parseRole,
  roleFileName,
  roleFromFileName,
  type KeyRole,
} from './keystore/roles.js';

export { KeystoreError, isKeystoreError, type KeystoreErrorCode } from './keystore/errors.js';
export { creatorRole, parseRole, REF_RE, type KeyRole } from './keystore/roles.js';
export { DEFAULT_SCRYPT, MIN_SCRYPT, type ScryptParams } from './keystore/envelope.js';
export { redactSecrets, type KeystoreLogger } from './keystore/logger.js';

export const DEFAULT_KEYSTORE_DIR = './keystore';
export const MIN_PASSPHRASE_LENGTH = 32;

export interface KeystoreOptions {
  /** Directory holding one JSON file per key. Created (mode 0700) if missing. */
  dir: string;
  /** SIGNER_KEYSTORE_PASSPHRASE. At least 32 characters; used as-is, never trimmed. */
  passphrase: string;
  /** Parent pino logger; the keystore logs through a redacting child. Silent if absent. */
  logger?: pino.Logger;
  /** scrypt parameters for NEW keys (floors enforced). Existing keys keep their own. */
  scrypt?: Partial<ScryptParams>;
}

export interface CreatedKey {
  ref: string;
  publicKey: PublicKey;
  /** false when the role already had a key (idempotent call). */
  created: boolean;
}

export interface KeyRef {
  ref: string;
  role: KeyRole;
}

/** Signing capability handed to `withSigner` callbacks. Unusable once the callback returns. */
export interface KeystoreSigner {
  readonly ref: string;
  readonly role: KeyRole;
  readonly publicKey: PublicKey;
  /** Adds this key's signature to a legacy or versioned transaction (in place). */
  signTransaction(tx: Transaction | VersionedTransaction): void;
  /** Ed25519 detached signature (64 bytes) over arbitrary bytes. */
  signMessage(message: Uint8Array): Uint8Array;
}

export interface Keystore {
  /** Creates the key of a role, or returns the existing one. Never creates two keys for a role. */
  createKey(role: string): Promise<CreatedKey>;
  /** Public key of a ref, verified against the decrypted secret once per process. */
  getPublicKey(ref: string): Promise<PublicKey>;
  /** Ref of a role's key, if it exists. */
  findRef(role: string): Promise<string | undefined>;
  /** Decrypts the key in memory for the duration of `fn`, then zeroes it. */
  withSigner<T>(ref: string, fn: (signer: KeystoreSigner) => Promise<T> | T): Promise<T>;
  /** Every key on disk (ref and role only). */
  listRefs(): Promise<KeyRef[]>;
  /** Zeroes the in-memory passphrase; every later call fails with CLOSED. */
  close(): void;
}

/** Reads SIGNER_KEYSTORE_DIR (default ./keystore) and SIGNER_KEYSTORE_PASSPHRASE. */
export function keystoreOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<KeystoreOptions, 'dir' | 'passphrase'> {
  const passphrase = env.SIGNER_KEYSTORE_PASSPHRASE;
  if (typeof passphrase !== 'string') throw new KeystoreError('PASSPHRASE_INVALID');
  const dir = env.SIGNER_KEYSTORE_DIR || DEFAULT_KEYSTORE_DIR;
  return { dir: path.resolve(dir), passphrase };
}

export async function openKeystore(options: KeystoreOptions): Promise<Keystore> {
  const passphrase = passphraseToBuffer(options.passphrase);
  const scrypt: ScryptParams = { ...DEFAULT_SCRYPT, ...options.scrypt };
  assertCreationParams(scrypt);
  const logger = options.logger ? createKeystoreLogger(options.logger) : silentKeystoreLogger;
  const dir = path.resolve(options.dir);
  const store = new FileKeystore(dir, passphrase, scrypt, logger);
  try {
    await store.init();
  } catch (err) {
    passphrase.fill(0);
    throw err;
  }
  return store;
}

// ---------------------------------------------------------------------------------------
// Passphrase

function passphraseToBuffer(input: unknown): Buffer {
  if (typeof input !== 'string') throw new KeystoreError('PASSPHRASE_INVALID');
  if (input.length < MIN_PASSPHRASE_LENGTH) throw new KeystoreError('PASSPHRASE_INVALID');
  // Trailing spaces or a stray newline from an .env file would silently derive another key.
  if (input !== input.trim()) throw new KeystoreError('PASSPHRASE_INVALID');
  if (/\p{Cc}/u.test(input)) throw new KeystoreError('PASSPHRASE_INVALID');
  return Buffer.from(input, 'utf8');
}

// ---------------------------------------------------------------------------------------
// Ed25519 through Node's crypto (same curve and key layout as Solana: secret = seed || pub)

const SEED_LENGTH = 32;
const PUBLIC_KEY_LENGTH = 32;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  try {
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } finally {
    der.fill(0);
  }
}

function publicKeyBytesOf(privateKey: KeyObject): Buffer {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - PUBLIC_KEY_LENGTH);
}

/** Generates a fresh 64-byte Solana secret key. The caller must zero it. */
function generateSecretKey(): { secret: Buffer; publicKey: PublicKey } {
  const secret = Buffer.alloc(SOLANA_SECRET_KEY_LENGTH);
  randomBytes(SEED_LENGTH).copy(secret, 0);
  const privateKey = privateKeyFromSeed(secret.subarray(0, SEED_LENGTH));
  const pub = publicKeyBytesOf(privateKey);
  pub.copy(secret, SEED_LENGTH);
  return { secret, publicKey: new PublicKey(new Uint8Array(pub)) };
}

// ---------------------------------------------------------------------------------------
// Signer handed to callbacks

class ReleasableSigner implements KeystoreSigner {
  readonly ref: string;
  readonly role: KeyRole;
  readonly publicKey: PublicKey;
  #secret: Buffer | undefined;
  #privateKey: KeyObject | undefined;

  constructor(
    ref: string,
    role: KeyRole,
    publicKey: PublicKey,
    secret: Buffer,
    privateKey: KeyObject,
  ) {
    this.ref = ref;
    this.role = role;
    this.publicKey = publicKey;
    this.#secret = secret;
    this.#privateKey = privateKey;
  }

  signTransaction(tx: Transaction | VersionedTransaction): void {
    const secret = this.#live();
    // A view, not a copy: zeroing the secret in release() also zeroes what web3 saw.
    const secretKey = new Uint8Array(secret.buffer, secret.byteOffset, secret.length);
    const signer = { publicKey: this.publicKey, secretKey };
    // `message` only exists on versioned transactions (duck-typed in case of duplicate web3 copies).
    if (tx instanceof VersionedTransaction || 'message' in tx) {
      (tx as VersionedTransaction).sign([signer]);
    } else {
      tx.partialSign(signer);
    }
  }

  signMessage(message: Uint8Array): Uint8Array {
    this.#live();
    const privateKey = this.#privateKey as KeyObject;
    return new Uint8Array(ed25519Sign(null, message, privateKey));
  }

  release(): void {
    this.#secret?.fill(0);
    this.#secret = undefined;
    this.#privateKey = undefined;
  }

  #live(): Buffer {
    if (!this.#secret || !this.#privateKey) throw new KeystoreError('SIGNER_RELEASED');
    return this.#secret;
  }
}

// ---------------------------------------------------------------------------------------
// File-backed keystore

interface IndexEntry {
  ref: string;
  role: KeyRole;
  file: string;
}

class FileKeystore implements Keystore {
  readonly #dir: string;
  readonly #passphrase: Buffer;
  readonly #scrypt: ScryptParams;
  readonly #log: KeystoreLogger;
  readonly #byRef = new Map<string, IndexEntry>();
  readonly #byRole = new Map<KeyRole, IndexEntry>();
  /** Public keys proven to match their decrypted secret in this process. */
  readonly #verified = new Map<string, PublicKey>();
  readonly #verifying = new Map<string, Promise<PublicKey>>();
  #createChain: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(dir: string, passphrase: Buffer, scrypt: ScryptParams, log: KeystoreLogger) {
    this.#dir = dir;
    this.#passphrase = passphrase;
    this.#scrypt = scrypt;
    this.#log = log;
  }

  async init(): Promise<void> {
    try {
      await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw wrapError(err, 'IO');
    }
    await this.#restrictDirPermissions();
    await this.#scan();

    // Fail fast on a wrong passphrase: decrypt one existing key before accepting any call.
    const first = [...this.#byRef.values()].sort((a, b) => a.file.localeCompare(b.file))[0];
    if (first) {
      try {
        await this.#verify(first);
      } catch (err) {
        if (err instanceof KeystoreError && err.code === 'DECRYPT_FAILED') {
          throw new KeystoreError('PASSPHRASE_MISMATCH', { ref: first.ref });
        }
        throw err;
      }
    }
    this.#log.info({ dir: this.#dir, keys: this.#byRef.size }, 'keystore opened');
  }

  async createKey(roleInput: string): Promise<CreatedKey> {
    this.#assertOpen();
    const role = parseRole(roleInput);
    const run = this.#createChain.then(() => this.#createKeySerialized(role));
    this.#createChain = run.catch(() => undefined);
    return run;
  }

  async getPublicKey(refInput: string): Promise<PublicKey> {
    this.#assertOpen();
    const ref = parseRef(refInput);
    const cached = this.#verified.get(ref);
    if (cached) return cached;
    const entry = await this.#locate(ref);
    return this.#verify(entry);
  }

  async findRef(roleInput: string): Promise<string | undefined> {
    this.#assertOpen();
    const role = parseRole(roleInput);
    let entry = this.#byRole.get(role);
    if (!entry) {
      await this.#scan();
      entry = this.#byRole.get(role);
    }
    return entry?.ref;
  }

  async withSigner<T>(
    refInput: string,
    fn: (signer: KeystoreSigner) => Promise<T> | T,
  ): Promise<T> {
    this.#assertOpen();
    const ref = parseRef(refInput);
    const entry = await this.#locate(ref);
    const loaded = await this.#load(entry);
    const signer = new ReleasableSigner(
      entry.ref,
      entry.role,
      loaded.publicKey,
      loaded.secret,
      loaded.privateKey,
    );
    try {
      return await fn(signer);
    } finally {
      signer.release();
      loaded.secret.fill(0);
    }
  }

  async listRefs(): Promise<KeyRef[]> {
    this.#assertOpen();
    await this.#scan();
    return [...this.#byRef.values()]
      .map(({ ref, role }) => ({ ref, role }))
      .sort((a, b) => a.role.localeCompare(b.role));
  }

  close(): void {
    this.#closed = true;
    this.#passphrase.fill(0);
    this.#verified.clear();
  }

  // -- internals ------------------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) throw new KeystoreError('CLOSED');
  }

  async #createKeySerialized(role: KeyRole): Promise<CreatedKey> {
    this.#assertOpen();
    const existing = await this.#findEntry(role);
    if (existing) {
      return { ref: existing.ref, publicKey: await this.#verify(existing), created: false };
    }

    const ref = newRef();
    const fileName = roleFileName(role);
    const { secret, publicKey } = generateSecretKey();
    let written: boolean;
    try {
      const envelope = await sealSecret(
        secret,
        this.#passphrase,
        { ref, role, publicKey: publicKey.toBase58() },
        this.#scrypt,
      );
      written = await this.#writeExclusive(fileName, `${JSON.stringify(envelope, null, 2)}\n`);
    } finally {
      secret.fill(0);
    }

    if (!written) {
      // Lost a race against another writer: the file now holds that writer's key.
      this.#log.warn({ role }, 'key file appeared while creating; using the existing key');
      await this.#scan();
      const entry = this.#byRole.get(role);
      if (!entry) throw new KeystoreError('CORRUPT_FILE', { role, file: fileName });
      return { ref: entry.ref, publicKey: await this.#verify(entry), created: false };
    }

    const entry: IndexEntry = { ref, role, file: path.join(this.#dir, fileName) };
    this.#byRef.set(ref, entry);
    this.#byRole.set(role, entry);
    this.#verified.set(ref, publicKey);
    this.#log.info({ role, ref, address: publicKey.toBase58() }, 'key created');
    return { ref, publicKey, created: true };
  }

  async #findEntry(role: KeyRole): Promise<IndexEntry | undefined> {
    const cached = this.#byRole.get(role);
    if (cached) return cached;
    await this.#scan();
    return this.#byRole.get(role);
  }

  async #locate(ref: string): Promise<IndexEntry> {
    const cached = this.#byRef.get(ref);
    if (cached) return cached;
    await this.#scan();
    const entry = this.#byRef.get(ref);
    if (!entry) throw new KeystoreError('NOT_FOUND', { ref });
    return entry;
  }

  /** Proves that the file's public key matches its secret; caches the result. */
  #verify(entry: IndexEntry): Promise<PublicKey> {
    const cached = this.#verified.get(entry.ref);
    if (cached) return Promise.resolve(cached);
    const pending = this.#verifying.get(entry.ref);
    if (pending) return pending;
    const task = (async () => {
      const loaded = await this.#load(entry);
      loaded.secret.fill(0);
      return loaded.publicKey;
    })().finally(() => this.#verifying.delete(entry.ref));
    this.#verifying.set(entry.ref, task);
    return task;
  }

  /** Reads, decrypts and checks one key. The caller must zero `secret`. */
  async #load(
    entry: IndexEntry,
  ): Promise<{ publicKey: PublicKey; secret: Buffer; privateKey: KeyObject }> {
    const envelope = await this.#readEnvelope(entry.file);
    if (envelope.ref !== entry.ref || envelope.role !== entry.role) {
      throw new KeystoreError('CORRUPT_FILE', { ref: entry.ref, file: path.basename(entry.file) });
    }
    const secret = await openEnvelope(envelope, this.#passphrase);
    try {
      const privateKey = privateKeyFromSeed(secret.subarray(0, SEED_LENGTH));
      const derived = publicKeyBytesOf(privateKey);
      const recorded = new PublicKey(envelope.publicKey).toBytes();
      const tail = secret.subarray(SEED_LENGTH);
      if (!timingSafeEqual(derived, tail) || !timingSafeEqual(derived, recorded)) {
        throw new KeystoreError('KEY_MISMATCH', { ref: entry.ref });
      }
      const publicKey = new PublicKey(new Uint8Array(derived));
      this.#verified.set(entry.ref, publicKey);
      return { publicKey, secret, privateKey };
    } catch (err) {
      secret.fill(0);
      throw wrapError(err, 'KEY_MISMATCH', { ref: entry.ref });
    }
  }

  async #readEnvelope(file: string): Promise<Envelope> {
    const base = path.basename(file);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw wrapError(err, code === 'ENOENT' ? 'NOT_FOUND' : 'IO', { file: base });
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new KeystoreError('CORRUPT_FILE', { file: base });
    }
    const parsed = Envelope.safeParse(json);
    if (!parsed.success) throw new KeystoreError('CORRUPT_FILE', { file: base });
    const expectedRole = roleFromFileName(base);
    let role: KeyRole;
    try {
      role = parseRole(parsed.data.role);
    } catch {
      throw new KeystoreError('CORRUPT_FILE', { file: base });
    }
    if (role !== expectedRole) throw new KeystoreError('CORRUPT_FILE', { file: base });
    return parsed.data;
  }

  /** Rebuilds the index from disk. Refuses to continue on any corrupt or duplicate key file. */
  async #scan(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.#dir);
    } catch (err) {
      throw wrapError(err, 'IO');
    }
    const byRef = new Map<string, IndexEntry>();
    const byRole = new Map<KeyRole, IndexEntry>();
    for (const name of names.sort()) {
      const role = roleFromFileName(name);
      if (!role) continue;
      const file = path.join(this.#dir, name);
      const envelope = await this.#readEnvelope(file);
      if (byRef.has(envelope.ref)) {
        throw new KeystoreError('CORRUPT_FILE', { ref: envelope.ref, file: name });
      }
      const entry: IndexEntry = { ref: envelope.ref, role, file };
      byRef.set(entry.ref, entry);
      byRole.set(role, entry);
    }
    this.#byRef.clear();
    this.#byRole.clear();
    for (const [ref, entry] of byRef) this.#byRef.set(ref, entry);
    for (const [role, entry] of byRole) this.#byRole.set(role, entry);
  }

  /**
   * Writes `content` to a new file named `fileName`, atomically and without ever replacing
   * an existing file: write to a private temp file (mode 0600), fsync, hard-link it to the
   * final name (fails with EEXIST if present), unlink the temp file. Returns false if the
   * final file already existed.
   */
  async #writeExclusive(fileName: string, content: string): Promise<boolean> {
    const final = path.join(this.#dir, fileName);
    const tmp = path.join(this.#dir, `.${fileName}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      const handle = await fs.open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(tmp, final);
      } catch (err) {
        if ((err as { code?: string }).code === 'EEXIST') return false;
        throw err;
      }
      await this.#syncDir();
      return true;
    } catch (err) {
      throw wrapError(err, 'IO', { file: fileName });
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** Flushes the directory entry (best effort: not supported on every platform). */
  async #syncDir(): Promise<void> {
    try {
      const handle = await fs.open(this.#dir, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Windows cannot open a directory handle; the data file itself was already fsynced.
    }
  }

  async #restrictDirPermissions(): Promise<void> {
    if (process.platform === 'win32') return;
    try {
      await fs.chmod(this.#dir, 0o700);
    } catch (err) {
      this.#log.warn(
        { dir: this.#dir, ...wrapError(err, 'IO').details },
        'could not restrict keystore directory permissions',
      );
    }
  }
}
