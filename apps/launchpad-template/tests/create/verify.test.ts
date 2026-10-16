import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { base64ToBytes } from '@/forge/create/base64';
import { describe, expect, it } from 'vitest';
import {
  buildFixtureLaunch,
  buildFixtureTx,
  FIXTURE_LAUNCHPAD_CONFIG,
  FIXTURE_PLATFORM_FEE_WALLET,
  txToBase64,
} from '@/forge/create/test-fixtures';
import { VerificationError, verifyPreparedLaunch } from '@/forge/create/verify';

const wallet = Keypair.generate().publicKey;

function launch(overrides: Partial<Parameters<typeof buildFixtureLaunch>[0]> = {}) {
  return buildFixtureLaunch({
    wallet,
    name: 'Moon Coin',
    symbol: 'MOON',
    firstBuyLamports: BigInt(500000000),
    launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
    ...overrides,
  });
}

const expected = {
  wallet: wallet.toBase58(),
  name: 'Moon Coin',
  symbol: 'MOON',
  firstBuyLamports: BigInt(500000000),
  launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG.toBase58(),
  poolCreationFeeLamports: BigInt(10000000),
  platformFeeWallet: FIXTURE_PLATFORM_FEE_WALLET.toBase58(),
};

/** 0.3% of the 0.5 SOL first buy. */
const PLATFORM_FEE = BigInt(1500000);

describe('verifyPreparedLaunch', () => {
  it('accepts a well-formed answer and totals every cost', () => {
    const { response } = launch({
      poolCreationFeeLamports: BigInt(10000000),
      networkFeeLamports: BigInt(10000),
      accountRentLamports: BigInt(20000000),
    });
    const verified = verifyPreparedLaunch(response, {
      ...expected,
      poolCreationFeeLamports: BigInt(10000000),
    });
    expect(verified.summary.totalLamports).toBe(
      BigInt(500000000) + PLATFORM_FEE + BigInt(10000000) + BigInt(10000) + BigInt(20000000),
    );
    expect(verified.summary.platformFeeLamports).toBe(PLATFORM_FEE);
    expect(verified.mint).toBe(response.mint);
  });

  it('refuses a coin that differs from the form', () => {
    const { response } = launch({ name: 'Other' });
    expect(() => verifyPreparedLaunch(response, expected)).toThrow(/does not match/);
    const { response: r2 } = launch({ symbol: 'OTHER' });
    expect(() => verifyPreparedLaunch(r2, expected)).toThrow(VerificationError);
  });

  it('refuses a first buy that differs from the typed amount', () => {
    const { response } = launch({ firstBuyLamports: BigInt(900000000) });
    expect(() => verifyPreparedLaunch(response, expected)).toThrow(/first buy/);
  });

  it('refuses a creation fee that differs from the launchpad configuration', () => {
    const { response } = launch({ poolCreationFeeLamports: BigInt(500000000) });
    expect(() =>
      verifyPreparedLaunch(response, { ...expected, poolCreationFeeLamports: BigInt(10000000) }),
    ).toThrow(/creation fee/);
  });

  it('refuses a coin created by another wallet', () => {
    const { response } = launch({ wallet: Keypair.generate().publicKey });
    expect(() => verifyPreparedLaunch(response, expected)).toThrow(/created by your wallet/);
  });

  it('refuses a transaction whose fee payer is not the wallet', () => {
    const { response } = launch();
    const other = buildFixtureTx({ payer: Keypair.generate().publicKey });
    expect(() =>
      verifyPreparedLaunch({ ...response, poolTx: txToBase64(other) }, expected),
    ).toThrow(/fee payer/);
  });

  it('refuses an unknown program', () => {
    const { response, mint } = launch();
    const evil = buildFixtureTx({
      payer: wallet,
      signers: [mint],
      programId: Keypair.generate().publicKey.toBase58(),
    });
    expect(() => verifyPreparedLaunch({ ...response, poolTx: txToBase64(evil) }, expected)).toThrow(
      /unexpected program/,
    );
  });

  it('refuses a transaction with another unsigned required signer', () => {
    const { response, mint } = launch();
    const tx = buildFixtureTx({
      payer: wallet,
      signers: [mint],
      unsignedSigners: [Keypair.generate().publicKey],
    });
    expect(() => verifyPreparedLaunch({ ...response, poolTx: txToBase64(tx) }, expected)).toThrow(
      /signature alone/,
    );
  });

  it('refuses a transaction where the mint did not sign', () => {
    const { response, mint } = launch();
    const tx = buildFixtureTx({ payer: wallet, unsignedSigners: [mint.publicKey] });
    expect(() => verifyPreparedLaunch({ ...response, poolTx: txToBase64(tx) }, expected)).toThrow(
      /signature alone/,
    );
  });

  it('refuses a mint that is not part of the transaction', () => {
    const { response } = launch();
    expect(() =>
      verifyPreparedLaunch(
        { ...response, mint: Keypair.generate().publicKey.toBase58() },
        expected,
      ),
    ).toThrow(/signature alone/);
  });

  it('refuses garbage instead of a transaction', () => {
    const { response } = launch();
    expect(() => verifyPreparedLaunch({ ...response, poolTx: 'AAAA' }, expected)).toThrow(
      /could not be decoded/,
    );
  });
});

describe('verifyPreparedLaunch: FORGE platform fee on the first buy', () => {
  it('computes the fee itself: 0.3% of the first buy, rounded up', () => {
    const { response } = launch({ firstBuyLamports: BigInt(1000001) });
    const verified = verifyPreparedLaunch(response, {
      ...expected,
      firstBuyLamports: BigInt(1000001),
    });
    expect(verified.summary.platformFeeLamports).toBe(BigInt(3001));
  });

  it('refuses a launch without the fee transfer', () => {
    const { response } = launch({ omitPlatformFee: true });
    expect(() => verifyPreparedLaunch(response, expected)).toThrow(/platform fee/);
  });

  it('refuses a fee of another amount, even with a matching summary', () => {
    for (const lamports of [PLATFORM_FEE - BigInt(1), PLATFORM_FEE + BigInt(1), BigInt(0)]) {
      const { response } = launch({ platformFeeLamports: lamports });
      expect(() =>
        verifyPreparedLaunch(
          { ...response, summary: { ...response.summary, platformFeeLamports: String(lamports) } },
          expected,
        ),
      ).toThrow(VerificationError);
    }
  });

  it('refuses a summary announcing another fee', () => {
    const { response } = launch();
    expect(() =>
      verifyPreparedLaunch(
        { ...response, summary: { ...response.summary, platformFeeLamports: '0' } },
        expected,
      ),
    ).toThrow(/not 0.3%/);
  });

  it('refuses a fee sent to any other wallet (e.g. the launchpad owner)', () => {
    const { response } = launch({ platformFeeWallet: Keypair.generate().publicKey });
    expect(() => verifyPreparedLaunch(response, expected)).toThrow(/unexpected account/);
  });

  it('refuses the fee transfer anywhere but last, and a second one', () => {
    const { response, mint } = launch();
    const tx = VersionedTransaction.deserialize(base64ToBytes(response.poolTx));
    const instructions = TransactionMessage.decompile(tx.message).instructions;
    const fee = instructions[instructions.length - 1]!;
    const rebuilt = (ixs: TransactionInstruction[]) => {
      const message = new TransactionMessage({
        payerKey: wallet,
        recentBlockhash: tx.message.recentBlockhash,
        instructions: ixs,
      }).compileToV0Message();
      const next = new VersionedTransaction(message);
      next.sign([mint]);
      return { ...response, poolTx: txToBase64(next) };
    };
    const moved = [fee, ...instructions.slice(0, -1)];
    expect(() => verifyPreparedLaunch(rebuilt(moved), expected)).toThrow(/platform fee/);
    expect(() => verifyPreparedLaunch(rebuilt([...instructions, fee]), expected)).toThrow(
      /platform fee/,
    );
  });

  it('refuses a launch with a first buy when this site has no fee wallet', () => {
    const { response } = launch();
    expect(() => verifyPreparedLaunch(response, { ...expected, platformFeeWallet: null })).toThrow(
      /platform fee not configured/,
    );
  });

  it('owes no fee, and needs no fee wallet, without a first buy', () => {
    const { response } = launch({ firstBuyLamports: BigInt(0) });
    const verified = verifyPreparedLaunch(response, {
      ...expected,
      firstBuyLamports: BigInt(0),
      platformFeeWallet: null,
    });
    expect(verified.summary.platformFeeLamports).toBe(BigInt(0));
  });
});
