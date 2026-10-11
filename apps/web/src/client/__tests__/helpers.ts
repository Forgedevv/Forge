import type { TxPhase } from '@forge/shared';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js';
import { vi } from 'vitest';
import { base58Encode, bytesToBase64 } from '../base58';
import { setSession } from '../session-store';
import { setWalletBridge } from '../wallet-bridge';

/*
 * Test helpers. Public keys are random; nothing is signed with a private key: the fake wallet
 * writes a constant 64-byte "signature" into the fee payer slot.
 */

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export const owner = Keypair.generate().publicKey;
export const SIG_BYTES = new Uint8Array(64).fill(7);
export const SIG = base58Encode(SIG_BYTES);
export const id = () => crypto.randomUUID();
export const blockhash = () => Keypair.generate().publicKey.toBase58();

export function encode(tx: VersionedTransaction): string {
  return bytesToBase64(tx.serialize());
}

export function compile(payer: PublicKey, instructions: TransactionInstruction[]) {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash(),
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

/** Any transaction paid by `payer` (one small transfer). */
export function txB64(payer = owner): string {
  return encode(
    compile(payer, [
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ]),
  );
}

export function memoIx(text: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, 'utf8'),
  });
}

export interface PaymentTxOptions {
  payer?: PublicKey;
  lamports: bigint | string;
  jobId: string;
  cashbox?: PublicKey;
  extra?: TransactionInstruction[];
  memo?: string;
  computeBudget?: boolean;
}

/** The payment transaction built by @forge/core: one transfer to the cashbox + one memo. */
export function paymentTx(o: PaymentTxOptions): VersionedTransaction {
  const payer = o.payer ?? owner;
  const ixs: TransactionInstruction[] = [];
  if (o.computeBudget) {
    ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  }
  ixs.push(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: o.cashbox ?? Keypair.generate().publicKey,
      lamports: BigInt(o.lamports),
    }),
    memoIx(o.memo ?? `forge:job:${o.jobId.toLowerCase()}`, payer),
    ...(o.extra ?? []),
  );
  return compile(payer, ixs);
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
export function mockFetch(handler: Handler) {
  const fn = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve().then(() => handler(url, init)),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function fakeConnection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sendRawTransaction: vi.fn().mockResolvedValue(SIG),
    getSignatureStatuses: vi
      .fn()
      .mockResolvedValue({ value: [{ err: null, confirmationStatus: 'confirmed' }] }),
    ...overrides,
  } as unknown as Connection & {
    sendRawTransaction: ReturnType<typeof vi.fn>;
    getSignatureStatuses: ReturnType<typeof vi.fn>;
  };
}

/** A wallet that "signs" by writing SIG_BYTES into the slot of its own key. */
export function fakeSign(key: PublicKey = owner) {
  return async <T extends VersionedTransaction>(tx: T): Promise<T> => {
    const keys = tx.message.staticAccountKeys;
    const i = keys.findIndex((k) => k.equals(key));
    if (i >= 0 && i < tx.message.header.numRequiredSignatures) tx.signatures[i] = SIG_BYTES;
    return tx;
  };
}

type SignFn = <T extends VersionedTransaction>(tx: T) => Promise<T>;

/** `signTransaction` may be a plain `vi.fn()` (typed loosely on purpose). */
export function setWallet(
  signTransaction: ((tx: never) => unknown) | undefined,
  connection: Connection | null = fakeConnection(),
  publicKey: PublicKey | null = owner,
) {
  setWalletBridge({
    publicKey,
    signTransaction: signTransaction as SignFn | undefined,
    signMessage: undefined,
    connection,
  });
}

/** Signs in `wallet` (the session) and connects the same wallet. */
export function signIn(connection: Connection | null = fakeConnection(), key: PublicKey = owner) {
  setSession({ wallet: key.toBase58() });
  setWallet(fakeSign(key), connection, key);
  return connection;
}

export function phases() {
  const list: TxPhase[] = [];
  return { list, on: (p: TxPhase) => void list.push(p) };
}

export const rejection = () =>
  Object.assign(new Error('User rejected the request.'), { name: 'WalletSignTransactionError' });

export function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}
