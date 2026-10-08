/**
 * Test and development fixtures for the coin creation and claim flows. Never imported by
 * production code. Builds real (unsigned or partially signed) web3.js transactions so the
 * verification code runs on genuine message bytes.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { PrepareLaunchResponse } from './api';
import { bytesToBase64 } from './base64';
import { DBC_PROGRAM } from './verify';

export interface FixtureTxOptions {
  payer: PublicKey;
  /** Additional keypairs that are required signers and sign the transaction. */
  signers?: Keypair[];
  /** Additional required signers that stay unsigned (to simulate a bad transaction). */
  unsignedSigners?: PublicKey[];
  programId?: string;
}

export function buildFixtureTx(options: FixtureTxOptions): VersionedTransaction {
  const keys = [
    { pubkey: options.payer, isSigner: true, isWritable: true },
    ...(options.signers ?? []).map((k) => ({
      pubkey: k.publicKey,
      isSigner: true,
      isWritable: true,
    })),
    ...(options.unsignedSigners ?? []).map((pubkey) => ({
      pubkey,
      isSigner: true,
      isWritable: false,
    })),
  ];
  const instructions = [
    new TransactionInstruction({
      programId: new PublicKey(options.programId ?? DBC_PROGRAM),
      keys,
      data: Buffer.from([1, 2, 3]),
    }),
    SystemProgram.transfer({
      fromPubkey: options.payer,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  ];
  const message = new TransactionMessage({
    payerKey: options.payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToLegacyMessage();
  const tx = new VersionedTransaction(message);
  if (options.signers?.length) tx.sign(options.signers);
  return tx;
}

export function txToBase64(tx: VersionedTransaction): string {
  return bytesToBase64(tx.serialize());
}

export interface FixtureLaunchOptions {
  wallet: PublicKey;
  name: string;
  symbol: string;
  firstBuyLamports: bigint;
  poolCreationFeeLamports?: bigint;
  networkFeeLamports?: bigint;
  accountRentLamports?: bigint;
}

/** A well-formed `prepare` answer: mint signed, fee payer = wallet, wallet signature missing. */
export function buildFixtureLaunch(options: FixtureLaunchOptions): {
  response: PrepareLaunchResponse;
  mint: Keypair;
} {
  const mint = Keypair.generate();
  const tx = buildFixtureTx({ payer: options.wallet, signers: [mint] });
  return {
    mint,
    response: {
      poolTx: txToBase64(tx),
      mint: mint.publicKey.toBase58(),
      summary: {
        coinName: options.name,
        coinSymbol: options.symbol,
        creatorWallet: options.wallet.toBase58(),
        poolCreationFeeLamports: String(options.poolCreationFeeLamports ?? BigInt(10000000)),
        firstBuyLamports: String(options.firstBuyLamports),
        estimatedNetworkFeeLamports: String(options.networkFeeLamports ?? BigInt(10000)),
        accountRentLamports: String(options.accountRentLamports ?? BigInt(20000000)),
      },
    },
  };
}
