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
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { PrepareLaunchResponse } from './api';
import { bytesToBase64 } from './base64';
import { firstBuyPlatformFee } from './platform-fee';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DBC_DISCRIMINATORS,
  DBC_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_METADATA_PROGRAM_ID,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM_ADDRESS,
  WSOL_MINT,
  dbcEventAuthority,
  dbcPoolAddress,
  dbcPoolAuthority,
  dbcVaultAddress,
  metadataAddress,
} from '../tx/programs';

export const FIXTURE_LAUNCHPAD_CONFIG = Keypair.generate().publicKey;
/** FORGE_PLATFORM_FEE_WALLET of the fixtures (tests stub the public environment to it). */
export const FIXTURE_PLATFORM_FEE_WALLET = Keypair.generate().publicKey;

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
      programId: new PublicKey(options.programId ?? DBC_PROGRAM_ID),
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
  launchpadConfig?: PublicKey;
  name: string;
  symbol: string;
  firstBuyLamports: bigint;
  poolCreationFeeLamports?: bigint;
  networkFeeLamports?: bigint;
  accountRentLamports?: bigint;
  /** Recipient of the platform fee transfer (default `FIXTURE_PLATFORM_FEE_WALLET`). */
  platformFeeWallet?: PublicKey;
  /** Lamports of the platform fee transfer (default: 0.3% of the first buy, rounded up). */
  platformFeeLamports?: bigint;
  /** Leave the platform fee transfer out (to simulate a launch that skips it). */
  omitPlatformFee?: boolean;
  /** Mint to build for (a rebuild of the same launch); a fresh one by default. */
  mint?: Keypair;
}

/** A well-formed `prepare` answer: mint signed, fee payer = wallet, wallet signature missing. */
export function buildFixtureLaunch(options: FixtureLaunchOptions): {
  response: PrepareLaunchResponse;
  mint: Keypair;
} {
  const mint = options.mint ?? Keypair.generate();
  const config = options.launchpadConfig ?? FIXTURE_LAUNCHPAD_CONFIG;
  const pool = dbcPoolAddress(config.toBase58(), mint.publicKey.toBase58());
  const baseVault = dbcVaultAddress(pool, mint.publicKey.toBase58());
  const quoteVault = dbcVaultAddress(pool, WSOL_MINT);
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, options.wallet, true, TOKEN_PROGRAM_ID);
  const coinAta = getAssociatedTokenAddressSync(mint.publicKey, options.wallet, true, TOKEN_PROGRAM_ID);
  const meta = (key: string | PublicKey, isSigner = false, isWritable = false) => ({
    pubkey: typeof key === 'string' ? new PublicKey(key) : key,
    isSigner,
    isWritable,
  });
  const borshString = (value: string) => {
    const bytes = Buffer.from(value, 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const initialize = new TransactionInstruction({
    programId: new PublicKey(DBC_PROGRAM_ID),
    keys: [
      meta(config), meta(dbcPoolAuthority()), meta(options.wallet, true, true),
      meta(mint.publicKey, true, true), meta(NATIVE_MINT), meta(pool, false, true),
      meta(baseVault, false, true), meta(quoteVault, false, true),
      meta(metadataAddress(mint.publicKey.toBase58()), false, true), meta(TOKEN_METADATA_PROGRAM_ID),
      meta(options.wallet, true, true), meta(TOKEN_PROGRAM_ADDRESS), meta(TOKEN_PROGRAM_ADDRESS),
      meta(SYSTEM_PROGRAM_ID), meta(dbcEventAuthority()), meta(DBC_PROGRAM_ID),
    ],
    data: Buffer.concat([
      Buffer.from(DBC_DISCRIMINATORS.initializeVirtualPoolWithSplToken),
      borshString(options.name), borshString(options.symbol), borshString('https://example.test/metadata.json'),
    ]),
  });
  const instructions = [initialize];
  const firstBuy = options.firstBuyLamports;
  const expectedOut = firstBuy > BigInt(0) ? BigInt(1_000_000) : BigInt(0);
  const minimumOut = firstBuy > BigInt(0) ? BigInt(900_000) : BigInt(0);
  if (firstBuy > BigInt(0)) {
    instructions.push(
      new TransactionInstruction({
        programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
        keys: [meta(options.wallet, true, true), meta(wsol, false, true), meta(options.wallet), meta(NATIVE_MINT), meta(SYSTEM_PROGRAM_ID), meta(TOKEN_PROGRAM_ADDRESS)],
        data: Buffer.from([1]),
      }),
      new TransactionInstruction({
        programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
        keys: [meta(options.wallet, true, true), meta(coinAta, false, true), meta(options.wallet), meta(mint.publicKey), meta(SYSTEM_PROGRAM_ID), meta(TOKEN_PROGRAM_ADDRESS)],
        data: Buffer.from([1]),
      }),
      SystemProgram.transfer({ fromPubkey: options.wallet, toPubkey: wsol, lamports: Number(firstBuy) }),
      new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [meta(wsol, false, true)], data: Buffer.from([17]) }),
    );
    const swapData = Buffer.alloc(24);
    Buffer.from(DBC_DISCRIMINATORS.swap).copy(swapData, 0);
    swapData.writeBigUInt64LE(firstBuy, 8);
    swapData.writeBigUInt64LE(minimumOut, 16);
    instructions.push(new TransactionInstruction({
      programId: new PublicKey(DBC_PROGRAM_ID),
      keys: [meta(dbcPoolAuthority()), meta(config), meta(pool, false, true), meta(wsol, false, true),
        meta(coinAta, false, true), meta(baseVault, false, true), meta(quoteVault, false, true),
        meta(mint.publicKey, false, true), meta(NATIVE_MINT, false, true), meta(options.wallet, true, true),
        meta(TOKEN_PROGRAM_ADDRESS), meta(TOKEN_PROGRAM_ADDRESS), meta(DBC_PROGRAM_ID), meta(dbcEventAuthority()),
        meta(DBC_PROGRAM_ID)],
      data: swapData,
    }));
    instructions.push(new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [meta(wsol, false, true), meta(options.wallet, false, true), meta(options.wallet, true)],
      data: Buffer.from([9]),
    }));
    if (!options.omitPlatformFee) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: options.wallet,
          toPubkey: options.platformFeeWallet ?? FIXTURE_PLATFORM_FEE_WALLET,
          lamports: options.platformFeeLamports ?? firstBuyPlatformFee(firstBuy),
        }),
      );
    }
  }
  const message = new TransactionMessage({
    payerKey: options.wallet,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([mint]);
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
        firstBuyExpectedTokensOut: String(expectedOut),
        firstBuyMinimumTokensOut: String(minimumOut),
        platformFeeLamports: String(firstBuyPlatformFee(firstBuy)),
        estimatedNetworkFeeLamports: String(options.networkFeeLamports ?? BigInt(10000)),
        accountRentLamports: String(options.accountRentLamports ?? BigInt(20000000)),
        metadataFeeLamports: '0',
      },
    },
  };
}
