import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { VerificationError } from './errors';

/**
 * LOCKED ZONE. Turns a legacy or v0 transaction into a flat, program-agnostic view so that every
 * instruction can be checked against an allowlist before the wallet is asked to sign.
 *
 * Address lookup tables are refused: the browser would have to trust whatever the tables contain at
 * execution time, so a transaction that uses them cannot be verified here.
 */

export interface DecodedAccount {
  key: string;
  signer: boolean;
  writable: boolean;
}

export interface DecodedInstruction {
  /** Position in the transaction (for error messages). */
  index: number;
  programId: string;
  accounts: DecodedAccount[];
  data: Uint8Array;
}

export interface DecodedTransaction {
  feePayer: string;
  /** Required signers, in message order (the fee payer first). */
  requiredSigners: string[];
  /** Required signers that already carry a (non-zero) signature. */
  signed: ReadonlySet<string>;
  instructions: DecodedInstruction[];
  /** Serialized message: what every signer signs. */
  messageBytes: Uint8Array;
}

function isSignedBytes(signature: Uint8Array | null | undefined): boolean {
  return !!signature && signature.some((byte) => byte !== 0);
}

interface MessageLike {
  staticAccountKeys: { toBase58(): string }[];
  header: { numRequiredSignatures: number };
  compiledInstructions: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[];
  isAccountSigner(index: number): boolean;
  isAccountWritable(index: number): boolean;
  serialize(): Uint8Array;
}

function fromMessage(message: MessageLike, signatureOf: (key: string, i: number) => boolean) {
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  const required = message.header.numRequiredSignatures;
  if (required < 1 || keys.length < required) {
    throw new VerificationError('The transaction has no fee payer. Nothing was signed.');
  }
  const requiredSigners = keys.slice(0, required);
  const signed = new Set<string>();
  requiredSigners.forEach((key, i) => {
    if (signatureOf(key, i)) signed.add(key);
  });

  const instructions: DecodedInstruction[] = message.compiledInstructions.map((ix, index) => {
    const programId = keys[ix.programIdIndex];
    if (programId === undefined) {
      throw new VerificationError('The transaction references an unknown program. Nothing was signed.');
    }
    const accounts = ix.accountKeyIndexes.map((i) => {
      const key = keys[i];
      if (key === undefined) {
        throw new VerificationError(
          'The transaction references an unknown account. Nothing was signed.',
        );
      }
      return { key, signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) };
    });
    return { index, programId, accounts, data: Uint8Array.from(ix.data) };
  });

  return {
    feePayer: keys[0] as string,
    requiredSigners,
    signed,
    instructions,
    messageBytes: Uint8Array.from(message.serialize()),
  };
}

/** Decodes a transaction. Throws `VerificationError` when it cannot be verified. */
export function decodeTransaction(tx: Transaction | VersionedTransaction): DecodedTransaction {
  if (tx instanceof VersionedTransaction) {
    const message = tx.message;
    if ('addressTableLookups' in message && message.addressTableLookups.length > 0) {
      throw new VerificationError(
        'The transaction uses address lookup tables, which cannot be verified here. Nothing was signed.',
      );
    }
    return fromMessage(message as unknown as MessageLike, (_key, i) =>
      isSignedBytes(tx.signatures[i]),
    );
  }
  if (tx instanceof Transaction) {
    let message;
    try {
      message = tx.compileMessage();
    } catch {
      throw new VerificationError(
        'The transaction is incomplete (fee payer or blockhash missing). Nothing was signed.',
      );
    }
    const bySigner = new Map(tx.signatures.map((s) => [s.publicKey.toBase58(), s.signature]));
    return fromMessage(message as unknown as MessageLike, (key) =>
      isSignedBytes(bySigner.get(key) ?? null),
    );
  }
  throw new VerificationError('Unsupported transaction format. Nothing was signed.');
}

// ---------------------------------------------------------------------------------------------
// Little-endian readers (no Buffer dependency in the browser)
// ---------------------------------------------------------------------------------------------

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function readU32(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) throw new VerificationError('Malformed instruction data.');
  return view(data).getUint32(offset, true);
}

export function readU64(data: Uint8Array, offset: number): bigint {
  if (offset + 8 > data.length) throw new VerificationError('Malformed instruction data.');
  return view(data).getBigUint64(offset, true);
}

/** Borsh string (u32 length + UTF-8 bytes). Returns the value and the next offset. */
export function readBorshString(data: Uint8Array, offset: number): [string, number] {
  const length = readU32(data, offset);
  const start = offset + 4;
  if (length > 1024 || start + length > data.length) {
    throw new VerificationError('Malformed instruction data.');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(start, start + length));
  return [text, start + length];
}

export function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  if (data.length < prefix.length) return false;
  return prefix.every((byte, i) => data[i] === byte);
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
