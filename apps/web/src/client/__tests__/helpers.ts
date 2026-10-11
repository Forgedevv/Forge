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

// ---------------------------------------------------------------------------------------------
// Partner claim transactions (the shape @forge/core builds for receiver = payer = owner)
// ---------------------------------------------------------------------------------------------

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
export const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const DBC_POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
const CLAIM_TRADING_FEE = [8, 236, 89, 49, 152, 125, 177, 81];
const CLAIM_PARTNER_POOL_CREATION_FEE = [250, 238, 26, 4, 139, 10, 101, 248];

export function ata(wallet: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM): PublicKey {
  return PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

export function createAtaIdempotentIx(payer: PublicKey, wallet: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(wallet, mint), isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export function closeAccountIx(account: PublicKey, destination: PublicKey, authority: PublicKey) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

export interface ClaimIxOptions {
  claimer?: PublicKey;
  baseReceiver?: PublicKey;
  quoteReceiver?: PublicKey;
  mint?: PublicKey;
}

export function claimTradingFeeIx(o: ClaimIxOptions = {}) {
  const claimer = o.claimer ?? owner;
  const mint = o.mint ?? Keypair.generate().publicKey;
  const data = Buffer.alloc(24);
  Buffer.from(CLAIM_TRADING_FEE).copy(data, 0);
  data.writeBigUInt64LE(0n, 8);
  data.writeBigUInt64LE(18_446_744_073_709_551_615n, 16);
  const random = () => Keypair.generate().publicKey;
  return new TransactionInstruction({
    programId: DBC_PROGRAM,
    keys: [
      { pubkey: DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: random(), isSigner: false, isWritable: false },
      { pubkey: random(), isSigner: false, isWritable: true },
      { pubkey: o.baseReceiver ?? ata(claimer, mint), isSigner: false, isWritable: true },
      { pubkey: o.quoteReceiver ?? ata(claimer, WSOL), isSigner: false, isWritable: true },
      { pubkey: random(), isSigner: false, isWritable: true },
      { pubkey: random(), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: WSOL, isSigner: false, isWritable: false },
      { pubkey: claimer, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: random(), isSigner: false, isWritable: false },
      { pubkey: DBC_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function claimPoolCreationFeeIx(receiver: PublicKey = owner, claimer: PublicKey = owner) {
  const random = () => Keypair.generate().publicKey;
  return new TransactionInstruction({
    programId: DBC_PROGRAM,
    keys: [
      { pubkey: random(), isSigner: false, isWritable: false },
      { pubkey: random(), isSigner: false, isWritable: true },
      { pubkey: claimer, isSigner: true, isWritable: false },
      { pubkey: receiver, isSigner: false, isWritable: true },
      { pubkey: random(), isSigner: false, isWritable: false },
      { pubkey: DBC_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(CLAIM_PARTNER_POOL_CREATION_FEE),
  });
}

/** The partner claim built by @forge/core (receiver = payer = owner), optionally tampered. */
export function partnerClaimTx(
  o: { payer?: PublicKey; extra?: TransactionInstruction[]; claim?: ClaimIxOptions } = {},
) {
  const payer = o.payer ?? owner;
  const mint = o.claim?.mint ?? Keypair.generate().publicKey;
  return compile(payer, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    createAtaIdempotentIx(payer, owner, mint),
    createAtaIdempotentIx(payer, owner, WSOL),
    claimTradingFeeIx({ ...o.claim, mint }),
    closeAccountIx(ata(owner, WSOL), payer, owner),
    claimPoolCreationFeeIx(),
    ...(o.extra ?? []),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Launch transactions (paid by the owner, pre-signed by FORGE's creator wallet and the mint)
// ---------------------------------------------------------------------------------------------

export const FORGE_SIGNATURE = new Uint8Array(64).fill(9);

export function launchTx(o: { payer?: PublicKey; presign?: boolean } = {}) {
  const payer = o.payer ?? owner;
  const ix = new TransactionInstruction({
    programId: DBC_PROGRAM,
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
    ],
    data: Buffer.from([1, 2, 3]),
  });
  const tx = compile(payer, [ix]);
  if (o.presign !== false) {
    tx.message.staticAccountKeys.forEach((key, i) => {
      if (i < tx.message.header.numRequiredSignatures && !key.equals(owner)) {
        tx.signatures[i] = FORGE_SIGNATURE;
      }
    });
  }
  return tx;
}
