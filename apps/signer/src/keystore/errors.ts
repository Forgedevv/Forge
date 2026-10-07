/**
 * Keystore errors. Every message is a static string: it never embeds a passphrase,
 * key bytes, ciphertext or anything derived from them. Only non-secret identifiers
 * (role, ref, file name) may be attached, under `details`.
 */

export type KeystoreErrorCode =
  | 'PASSPHRASE_INVALID'
  | 'PASSPHRASE_MISMATCH'
  | 'INVALID_PARAMS'
  | 'INVALID_ROLE'
  | 'INVALID_REF'
  | 'NOT_FOUND'
  | 'DECRYPT_FAILED'
  | 'CORRUPT_FILE'
  | 'KEY_MISMATCH'
  | 'IO'
  | 'SIGNER_RELEASED'
  | 'CLOSED';

const MESSAGES: Record<KeystoreErrorCode, string> = {
  PASSPHRASE_INVALID:
    'Keystore passphrase is invalid: it must be at least 32 characters, without leading/trailing whitespace or control characters',
  PASSPHRASE_MISMATCH:
    'Keystore passphrase does not decrypt an existing key (wrong passphrase or tampered key file)',
  INVALID_PARAMS: 'Keystore parameters are below the minimum allowed',
  INVALID_ROLE: 'Invalid key role',
  INVALID_REF: 'Invalid key reference',
  NOT_FOUND: 'Key not found',
  DECRYPT_FAILED: 'Key decryption failed: wrong passphrase or tampered key file',
  CORRUPT_FILE: 'Key file is corrupt or has an unexpected format',
  KEY_MISMATCH: 'Decrypted key does not match the public key recorded in the key file',
  IO: 'Keystore file operation failed',
  SIGNER_RELEASED: 'Signer was released: it cannot be used outside withSigner',
  CLOSED: 'Keystore is closed',
};

/** Non-secret context attached to an error. */
export interface KeystoreErrorDetails {
  role?: string;
  ref?: string;
  file?: string;
  /** `code` of an underlying Node error (ENOENT, EEXIST...), never its message. */
  causeCode?: string;
  causeName?: string;
}

export class KeystoreError extends Error {
  override readonly name = 'KeystoreError';
  readonly code: KeystoreErrorCode;
  readonly details: KeystoreErrorDetails;

  constructor(code: KeystoreErrorCode, details: KeystoreErrorDetails = {}) {
    super(MESSAGES[code]);
    this.code = code;
    this.details = details;
  }
}

export function isKeystoreError(err: unknown, code?: KeystoreErrorCode): err is KeystoreError {
  return err instanceof KeystoreError && (code === undefined || err.code === code);
}

/**
 * Summarizes an unknown error into non-secret fields. The original message is dropped
 * on purpose: third-party messages are not under our control.
 */
export function causeSummary(err: unknown): Pick<KeystoreErrorDetails, 'causeCode' | 'causeName'> {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: unknown };
    return {
      causeCode: typeof e.code === 'string' ? e.code : undefined,
      causeName: typeof e.name === 'string' ? e.name : undefined,
    };
  }
  return {};
}

/** Wraps any non-keystore error into a KeystoreError with the given code. */
export function wrapError(
  err: unknown,
  code: KeystoreErrorCode,
  details: KeystoreErrorDetails = {},
): KeystoreError {
  if (err instanceof KeystoreError) return err;
  return new KeystoreError(code, { ...details, ...causeSummary(err) });
}
