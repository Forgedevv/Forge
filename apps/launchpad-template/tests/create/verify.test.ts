import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { buildFixtureLaunch, buildFixtureTx, txToBase64 } from '@/forge/create/test-fixtures';
import { VerificationError, verifyPreparedLaunch } from '@/forge/create/verify';

const wallet = Keypair.generate().publicKey;

function launch(overrides: Partial<Parameters<typeof buildFixtureLaunch>[0]> = {}) {
  return buildFixtureLaunch({
    wallet,
    name: 'Moon Coin',
    symbol: 'MOON',
    firstBuyLamports: BigInt(500000000),
    ...overrides,
  });
}

const expected = {
  wallet: wallet.toBase58(),
  name: 'Moon Coin',
  symbol: 'MOON',
  firstBuyLamports: BigInt(500000000),
};

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
      BigInt(500000000) + BigInt(10000000) + BigInt(10000) + BigInt(20000000),
    );
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
    ).toThrow(/mint/);
  });

  it('refuses garbage instead of a transaction', () => {
    const { response } = launch();
    expect(() => verifyPreparedLaunch({ ...response, poolTx: 'AAAA' }, expected)).toThrow(
      /could not be decoded/,
    );
  });
});
