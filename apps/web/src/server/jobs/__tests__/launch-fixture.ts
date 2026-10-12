import { launchPoolAddress } from '@forge/core';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

/*
 * The launchpad coin launch as the signer prepares it with @forge/core (`buildLaunchCoinTx`:
 * durable nonce held by the creator wallet, rent and first buy paid by the owner), signed by
 * throwaway creator and mint keys: the shape `verifyLaunchCoinTransaction` accepts.
 */

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const INIT_POOL = [140, 85, 215, 176, 102, 54, 104, 79];
const SWAP = [248, 198, 158, 145, 225, 117, 135, 200];

const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

const pda = (program: PublicKey, ...seeds: Uint8Array[]) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

const ata = (wallet: PublicKey, mint: PublicKey) =>
  pda(ATA, wallet.toBuffer(), TOKEN.toBuffer(), mint.toBuffer());

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

function createAta(payer: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA,
    keys: [
      meta(payer, true, true),
      meta(ata(payer, mint), false, true),
      meta(payer),
      meta(mint),
      meta(SystemProgram.programId),
      meta(TOKEN),
    ],
    data: Buffer.from([1]),
  });
}

export interface CoinLaunchOptions {
  /** Default 0.5 SOL (the first buy of the fakes' spec). */
  firstBuyLamports?: bigint;
  name?: string;
  symbol?: string;
  config?: PublicKey;
  /** Coin metadata URI written by the pool creation. */
  metadataUri?: string;
  /** Extra instructions appended (tampering); they are signed as well. */
  extra?: (owner: PublicKey) => TransactionInstruction[];
}

export function coinLaunch(owner: Keypair, o: CoinLaunchOptions = {}) {
  const payer = owner.publicKey;
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const config = o.config ?? Keypair.generate().publicKey;
  const nonceAccount = Keypair.generate().publicKey;
  const metadataUri = o.metadataUri ?? 'https://example.com/moon.json';
  const firstBuy = o.firstBuyLamports ?? 500_000_000n;
  const pool = launchPoolAddress(config, mint.publicKey);
  const poolAuthority = pda(DBC, Buffer.from('pool_authority'));
  const eventAuthority = pda(DBC, Buffer.from('__event_authority'));
  const baseVault = pda(
    DBC,
    Buffer.from('token_vault'),
    mint.publicKey.toBuffer(),
    pool.toBuffer(),
  );
  const quoteVault = pda(DBC, Buffer.from('token_vault'), WSOL.toBuffer(), pool.toBuffer());
  const metadata = pda(
    METAPLEX,
    Buffer.from('metadata'),
    METAPLEX.toBuffer(),
    mint.publicKey.toBuffer(),
  );
  const wsol = ata(payer, WSOL);
  const coin = ata(payer, mint.publicKey);

  const tx = new Transaction({
    feePayer: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  tx.add(
    SystemProgram.nonceAdvance({
      noncePubkey: nonceAccount,
      authorizedPubkey: creator.publicKey,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    createAta(payer, WSOL),
    new TransactionInstruction({
      programId: DBC,
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
        meta(METAPLEX),
        meta(payer, true, true),
        meta(TOKEN),
        meta(TOKEN),
        meta(SystemProgram.programId),
        meta(eventAuthority),
        meta(DBC),
      ],
      data: Buffer.concat([
        Buffer.from(INIT_POOL),
        borshString(o.name ?? 'Moon'),
        borshString(o.symbol ?? 'MOON'),
        borshString(metadataUri),
      ]),
    }),
    createAta(payer, mint.publicKey),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: wsol, lamports: firstBuy }),
    new TransactionInstruction({
      programId: TOKEN,
      keys: [meta(wsol, false, true)],
      data: Buffer.from([17]),
    }),
    new TransactionInstruction({
      programId: DBC,
      keys: [
        meta(poolAuthority),
        meta(config),
        meta(pool, false, true),
        meta(wsol, false, true),
        meta(coin, false, true),
        meta(baseVault, false, true),
        meta(quoteVault, false, true),
        meta(mint.publicKey),
        meta(WSOL),
        meta(payer, true),
        meta(TOKEN),
        meta(TOKEN),
        meta(DBC),
        meta(eventAuthority),
        meta(DBC),
        meta(SYSVAR_INSTRUCTIONS_PUBKEY),
      ],
      data: Buffer.concat([Buffer.from(SWAP), u64(firstBuy), u64(1_000_000n)]),
    }),
    new TransactionInstruction({
      programId: TOKEN,
      keys: [meta(wsol, false, true), meta(payer, false, true), meta(payer, true)],
      data: Buffer.from([9]),
    }),
    ...(o.extra?.(payer) ?? []),
  );
  tx.partialSign(creator, mint);
  const base64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
  return { tx, base64, creator, mint, config, nonceAccount, metadataUri };
}
