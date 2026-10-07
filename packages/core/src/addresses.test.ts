import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import { describe, expect, it } from 'vitest';
import {
  FORGE_ADDRESS_NAMES,
  ForgeAddressError,
  getCashboxWallet,
  getForgeMint,
  getJupiterReferralAccount,
  getMeteoraReferralAccount,
  getMultisigVault,
  getPlatformFeeWallet,
  requireAddresses,
  type ForgeAddressName,
} from './addresses.js';

const key = () => Keypair.generate().publicKey.toBase58();

function fullEnv(): Record<ForgeAddressName, string> {
  return {
    FORGE_MULTISIG_VAULT: key(),
    FORGE_METEORA_REFERRAL_ACCOUNT: key(),
    FORGE_PLATFORM_FEE_WALLET: key(),
    FORGE_JUPITER_REFERRAL_ACCOUNT: key(),
    FORGE_CASHBOX_WALLET: key(),
    FORGE_MINT: key(),
  };
}

function catchError(fn: () => unknown): ForgeAddressError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeAddressError);
    return error as ForgeAddressError;
  }
  throw new Error('expected a ForgeAddressError');
}

describe('requireAddresses', () => {
  it('returns every valid address as a PublicKey', () => {
    const env = fullEnv();
    const addresses = requireAddresses(FORGE_ADDRESS_NAMES, env);
    for (const name of FORGE_ADDRESS_NAMES) {
      expect(addresses[name]).toBeInstanceOf(PublicKey);
      expect(addresses[name]?.toBase58()).toBe(env[name]);
    }
  });

  it('only requires the names it is given', () => {
    const env = { FORGE_CASHBOX_WALLET: key() };
    expect(requireAddresses(['FORGE_CASHBOX_WALLET'], env).FORGE_CASHBOX_WALLET.toBase58()).toBe(
      env.FORGE_CASHBOX_WALLET,
    );
  });

  it('accepts off-curve addresses (PDAs and token accounts)', () => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault')],
      Keypair.generate().publicKey,
    );
    expect(PublicKey.isOnCurve(pda.toBytes())).toBe(false);
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, pda, true);
    const env = {
      FORGE_MULTISIG_VAULT: pda.toBase58(),
      FORGE_METEORA_REFERRAL_ACCOUNT: ata.toBase58(),
    };
    const result = requireAddresses(
      ['FORGE_MULTISIG_VAULT', 'FORGE_METEORA_REFERRAL_ACCOUNT'],
      env,
    );
    expect(result.FORGE_MULTISIG_VAULT.equals(pda)).toBe(true);
    expect(result.FORGE_METEORA_REFERRAL_ACCOUNT.equals(ata)).toBe(true);
  });

  it('reports every missing name at once (absent or empty)', () => {
    const env = { ...fullEnv(), FORGE_MULTISIG_VAULT: undefined, FORGE_CASHBOX_WALLET: '' };
    const error = catchError(() => requireAddresses(FORGE_ADDRESS_NAMES, env));
    expect(error.missing).toEqual(['FORGE_MULTISIG_VAULT', 'FORGE_CASHBOX_WALLET']);
    expect(error.invalid).toEqual([]);
    expect(error.message).toContain('FORGE_MULTISIG_VAULT');
    expect(error.message).toContain('FORGE_CASHBOX_WALLET');
  });

  it.each([
    ['not base58', '0OIl-not-a-key'],
    ['too short', '1111'],
    ['fewer than 32 bytes', 'abcdefghijkmnopqrstuvwxyzABCDEFG'],
    ['surrounding whitespace', ` ${Keypair.generate().publicKey.toBase58()} `],
    ['all-zero key', PublicKey.default.toBase58()],
    ['hex', 'a'.repeat(64)],
  ])('rejects an invalid value (%s) without printing it', (_label, value) => {
    const env = { ...fullEnv(), FORGE_PLATFORM_FEE_WALLET: value };
    const error = catchError(() => requireAddresses(['FORGE_PLATFORM_FEE_WALLET'], env));
    expect(error.invalid).toEqual(['FORGE_PLATFORM_FEE_WALLET']);
    expect(error.missing).toEqual([]);
    if (value.trim() !== '') expect(error.message).not.toContain(value.trim());
  });

  it('reports missing and invalid names together, never the values', () => {
    const env = fullEnv();
    const secretLooking = env.FORGE_JUPITER_REFERRAL_ACCOUNT.slice(0, 20);
    const bad = {
      ...env,
      FORGE_MULTISIG_VAULT: undefined,
      FORGE_JUPITER_REFERRAL_ACCOUNT: secretLooking,
    };
    const error = catchError(() => requireAddresses(FORGE_ADDRESS_NAMES, bad));
    expect(error.missing).toEqual(['FORGE_MULTISIG_VAULT']);
    expect(error.invalid).toEqual(['FORGE_JUPITER_REFERRAL_ACCOUNT']);
    expect(error.message).not.toContain(secretLooking);
    for (const value of Object.values(env)) expect(error.message).not.toContain(value);
  });

  it('treats FORGE_MINT as optional: absent or empty gives null', () => {
    expect(requireAddresses(['FORGE_MINT'], {}).FORGE_MINT).toBeNull();
    expect(requireAddresses(['FORGE_MINT'], { FORGE_MINT: '' }).FORGE_MINT).toBeNull();
    const env = { ...fullEnv(), FORGE_MINT: undefined };
    expect(requireAddresses(FORGE_ADDRESS_NAMES, env).FORGE_MINT).toBeNull();
  });

  it('still validates FORGE_MINT when it is present', () => {
    const error = catchError(() => requireAddresses(['FORGE_MINT'], { FORGE_MINT: 'nope' }));
    expect(error.invalid).toEqual(['FORGE_MINT']);
  });

  it('rejects unknown names', () => {
    expect(() => requireAddresses(['FORGE_UNKNOWN' as ForgeAddressName], fullEnv())).toThrow(
      TypeError,
    );
  });

  it('reads process.env by default', () => {
    const value = key();
    const previous = process.env.FORGE_CASHBOX_WALLET;
    process.env.FORGE_CASHBOX_WALLET = value;
    try {
      expect(requireAddresses(['FORGE_CASHBOX_WALLET']).FORGE_CASHBOX_WALLET.toBase58()).toBe(
        value,
      );
      expect(getCashboxWallet().toBase58()).toBe(value);
    } finally {
      if (previous === undefined) delete process.env.FORGE_CASHBOX_WALLET;
      else process.env.FORGE_CASHBOX_WALLET = previous;
    }
  });
});

describe('typed getters', () => {
  it('return the matching address', () => {
    const env = fullEnv();
    expect(getMultisigVault(env).toBase58()).toBe(env.FORGE_MULTISIG_VAULT);
    expect(getMeteoraReferralAccount(env).toBase58()).toBe(env.FORGE_METEORA_REFERRAL_ACCOUNT);
    expect(getPlatformFeeWallet(env).toBase58()).toBe(env.FORGE_PLATFORM_FEE_WALLET);
    expect(getJupiterReferralAccount(env).toBase58()).toBe(env.FORGE_JUPITER_REFERRAL_ACCOUNT);
    expect(getCashboxWallet(env).toBase58()).toBe(env.FORGE_CASHBOX_WALLET);
    expect(getForgeMint(env)?.toBase58()).toBe(env.FORGE_MINT);
  });

  it('throw when their address is missing, except getForgeMint', () => {
    expect(() => getMultisigVault({})).toThrow(ForgeAddressError);
    expect(() => getMeteoraReferralAccount({})).toThrow(ForgeAddressError);
    expect(() => getPlatformFeeWallet({})).toThrow(ForgeAddressError);
    expect(() => getJupiterReferralAccount({})).toThrow(ForgeAddressError);
    expect(() => getCashboxWallet({})).toThrow(ForgeAddressError);
    expect(getForgeMint({})).toBeNull();
  });
});
