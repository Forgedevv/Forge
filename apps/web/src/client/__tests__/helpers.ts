import type { TxPhase } from '@forge/shared';
import { launchPoolAddress } from '@forge/core/launch-check';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
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
 * Test helpers. Public keys are random. The fake wallet writes a constant 64-byte "signature"
 * into the fee payer slot; only the launch transaction carries real signatures, by throwaway
 * creator and mint keys generated here (as the signer prepares it).
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

const METAPLEX_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const INIT_POOL = [140, 85, 215, 176, 102, 54, 104, 79];
const SWAP = [248, 198, 158, 145, 225, 117, 135, 200];

/** What the default launch transaction does (matches the summaries of the launch tests). */
export const LAUNCH = { firstBuyLamports: 1n, name: 'Acme', symbol: 'ACME' } as const;

const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

const dbcPda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, DBC_PROGRAM)[0];

export interface LaunchTxOptions {
  /** The wallet the launch is prepared for (fee payer, rent payer, buyer). */
  payer?: PublicKey;
  /** Signatures pre-filled by FORGE (default both, real ed25519 signatures). */
  presign?: boolean | 'creator' | 'mint';
  firstBuyLamports?: bigint;
  name?: string;
  symbol?: string;
  /** Extra instructions appended (to tamper with the launch); they are signed as well. */
  extra?: (keys: {
    payer: PublicKey;
    creator: PublicKey;
    mint: PublicKey;
  }) => TransactionInstruction[];
}

/**
 * The launch transaction the signer prepares with @forge/core (`buildLaunchCoinTx`: durable nonce
 * held by the creator wallet, rent and first buy paid by the owner), signed by throwaway creator
 * and mint keys: the shape `verifyLaunchCoinTransaction` accepts.
 */
export function launchTx(o: LaunchTxOptions = {}): VersionedTransaction {
  const payer = o.payer ?? owner;
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const config = Keypair.generate().publicKey;
  const nonceAccount = Keypair.generate().publicKey;
  const firstBuy = o.firstBuyLamports ?? LAUNCH.firstBuyLamports;
  const pool = launchPoolAddress(config, mint.publicKey);
  const poolAuthority = dbcPda(Buffer.from('pool_authority'));
  const eventAuthority = dbcPda(Buffer.from('__event_authority'));
  const baseVault = dbcPda(Buffer.from('token_vault'), mint.publicKey.toBuffer(), pool.toBuffer());
  const quoteVault = dbcPda(Buffer.from('token_vault'), WSOL.toBuffer(), pool.toBuffer());
  const metadata = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mint.publicKey.toBuffer()],
    METAPLEX_PROGRAM,
  )[0];
  const payerWsol = ata(payer, WSOL);
  const payerCoin = ata(payer, mint.publicKey);

  const instructions: TransactionInstruction[] = [
    SystemProgram.nonceAdvance({ noncePubkey: nonceAccount, authorizedPubkey: creator.publicKey }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    createAtaIdempotentIx(payer, payer, WSOL),
    new TransactionInstruction({
      programId: DBC_PROGRAM,
      keys: [
        meta(config),
        meta(poolAuthority),
        meta(creator.publicKey, true),
        meta(mint.publicKey, true, true),
        meta(WSOL),
        meta(pool, false, true),
        meta(baseVault, false, true),
        meta(quoteVault, false, true),
        meta(metadata, false, true),
        meta(METAPLEX_PROGRAM),
        meta(payer, true, true),
        meta(TOKEN_PROGRAM),
        meta(TOKEN_PROGRAM),
        meta(SystemProgram.programId),
        meta(eventAuthority),
        meta(DBC_PROGRAM),
      ],
      data: Buffer.concat([
        Buffer.from(INIT_POOL),
        borshString(o.name ?? LAUNCH.name),
        borshString(o.symbol ?? LAUNCH.symbol),
        borshString('https://example.com/acme.json'),
      ]),
    }),
  ];
  if (firstBuy > 0n) {
    instructions.push(
      createAtaIdempotentIx(payer, payer, mint.publicKey),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: payerWsol, lamports: firstBuy }),
      new TransactionInstruction({
        programId: TOKEN_PROGRAM,
        keys: [meta(payerWsol, false, true)],
        data: Buffer.from([17]),
      }),
      new TransactionInstruction({
        programId: DBC_PROGRAM,
        keys: [
          meta(poolAuthority),
          meta(config),
          meta(pool, false, true),
          meta(payerWsol, false, true),
          meta(payerCoin, false, true),
          meta(baseVault, false, true),
          meta(quoteVault, false, true),
          meta(mint.publicKey),
          meta(WSOL),
          meta(payer, true),
          meta(TOKEN_PROGRAM),
          meta(TOKEN_PROGRAM),
          meta(DBC_PROGRAM),
          meta(eventAuthority),
          meta(DBC_PROGRAM),
          meta(SYSVAR_INSTRUCTIONS_PUBKEY),
        ],
        data: Buffer.concat([Buffer.from(SWAP), u64(firstBuy), u64(1_000_000n)]),
      }),
      closeAccountIx(payerWsol, payer, payer),
    );
  }
  instructions.push(
    ...(o.extra?.({ payer, creator: creator.publicKey, mint: mint.publicKey }) ?? []),
  );
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash() }).add(
    ...instructions,
  );
  const presign = o.presign ?? true;
  if (presign === true) tx.partialSign(creator, mint);
  else if (presign === 'creator') tx.partialSign(creator);
  else if (presign === 'mint') tx.partialSign(mint);
  return VersionedTransaction.deserialize(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
}
