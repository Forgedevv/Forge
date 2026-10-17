import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import { describe, expect, it } from 'vitest';
import {
  FORGE_ADDRESS_NAMES,
  ForgeAddressError,
  ForgeSquadsConfigError,
  getCashboxWallet,
  getForgeMint,
  getJupiterReferralAccount,
  getMeteoraReferralAccount,
  getMultisigVault,
  getPlatformFeeWallet,
  getRevenueWallet,
  readOptionalAddress,
  readSquadsAddresses,
  requireAddresses,
  type ForgeAddressName,
} from './addresses.js';

const key = () => Keypair.generate().publicKey.toBase58();

function fullEnv(): Record<ForgeAddressName, string> {
  return {
    FORGE_MULTISIG_VAULT: key(),
    FORGE_METEORA_REFERRAL_ACCOUNT: key(),
    FORGE_PLATFORM_FEE_WALLET: key(),
    FORGE_REVENUE_WALLET: key(),
    FORGE_JUPITER_REFERRAL_ACCOUNT: key(),
    FORGE_CASHBOX_WALLET: key(),
    FORGE_MINT: key(),
    FORGE_SQUADS_MULTISIG: key(),
    FORGE_SQUADS_SPENDING_LIMIT: key(),
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
    expect(getRevenueWallet(env).toBase58()).toBe(env.FORGE_REVENUE_WALLET);
    expect(getJupiterReferralAccount(env).toBase58()).toBe(env.FORGE_JUPITER_REFERRAL_ACCOUNT);
    expect(getCashboxWallet(env).toBase58()).toBe(env.FORGE_CASHBOX_WALLET);
    expect(getForgeMint(env)?.toBase58()).toBe(env.FORGE_MINT);
  });

  it('throw when their address is missing, except getForgeMint', () => {
    expect(() => getMultisigVault({})).toThrow(ForgeAddressError);
    expect(() => getMeteoraReferralAccount({})).toThrow(ForgeAddressError);
    expect(() => getPlatformFeeWallet({})).toThrow(ForgeAddressError);
    expect(() => getRevenueWallet({})).toThrow(ForgeAddressError);
    expect(() => getJupiterReferralAccount({})).toThrow(ForgeAddressError);
    expect(() => getCashboxWallet({})).toThrow(ForgeAddressError);
    expect(getForgeMint({})).toBeNull();
  });
});

describe('readOptionalAddress', () => {
  it('returns the address when set, null when absent or empty, and refuses an invalid one', () => {
    const env = fullEnv();
    expect(readOptionalAddress('FORGE_MULTISIG_VAULT', env)?.toBase58()).toBe(
      env.FORGE_MULTISIG_VAULT,
    );
    expect(readOptionalAddress('FORGE_MULTISIG_VAULT', {})).toBeNull();
    expect(readOptionalAddress('FORGE_MULTISIG_VAULT', { FORGE_MULTISIG_VAULT: '' })).toBeNull();
    const error = catchError(() =>
      readOptionalAddress('FORGE_MULTISIG_VAULT', { FORGE_MULTISIG_VAULT: 'not-a-key' }),
    );
    expect(error.invalid).toEqual(['FORGE_MULTISIG_VAULT']);
    expect(error.message).not.toContain('not-a-key');
  });
});

describe('readSquadsAddresses', () => {
  const MULTISIG = key();
  const LIMIT = key();
  const both = { FORGE_SQUADS_MULTISIG: MULTISIG, FORGE_SQUADS_SPENDING_LIMIT: LIMIT };

  function squadsError(fn: () => unknown): ForgeSquadsConfigError {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ForgeSquadsConfigError);
      return error as ForgeSquadsConfigError;
    }
    throw new Error('expected a ForgeSquadsConfigError');
  }

  it('is null when both addresses are absent or empty', () => {
    expect(readSquadsAddresses({})).toBeNull();
    expect(
      readSquadsAddresses({ FORGE_SQUADS_MULTISIG: '', FORGE_SQUADS_SPENDING_LIMIT: '' }),
    ).toBeNull();
    expect(readSquadsAddresses({ ...both, FORGE_SQUADS_MULTISIG: '', FORGE_SQUADS_SPENDING_LIMIT: '', FORGE_SQUADS_VAULT_INDEX: '' })).toBeNull();
  });

  it('reads both with the default vault index 0, or an explicit index up to 255', () => {
    const read = readSquadsAddresses(both);
    expect(read?.multisig.toBase58()).toBe(MULTISIG);
    expect(read?.spendingLimit.toBase58()).toBe(LIMIT);
    expect(read?.vaultIndex).toBe(0);
    expect(readSquadsAddresses({ ...both, FORGE_SQUADS_VAULT_INDEX: '7' })?.vaultIndex).toBe(7);
    expect(readSquadsAddresses({ ...both, FORGE_SQUADS_VAULT_INDEX: '255' })?.vaultIndex).toBe(255);
  });

  it('refuses one address without the other', () => {
    const error = squadsError(() => readSquadsAddresses({ FORGE_SQUADS_MULTISIG: MULTISIG }));
    expect(error.problem).toBe('incomplete');
    expect(error.message).toMatch(/set together/);
    expect(error.message).not.toContain(MULTISIG);
    expect(
      squadsError(() => readSquadsAddresses({ FORGE_SQUADS_SPENDING_LIMIT: LIMIT })).problem,
    ).toBe('incomplete');
  });

  it('refuses a vault index without the addresses', () => {
    const error = squadsError(() => readSquadsAddresses({ FORGE_SQUADS_VAULT_INDEX: '1' }));
    expect(error.problem).toBe('index_without_multisig');
    expect(error.message).toMatch(/needs FORGE_SQUADS_MULTISIG/);
    expect(
      squadsError(() => readSquadsAddresses({ FORGE_SQUADS_VAULT_INDEX: '255' })).problem,
    ).toBe('index_without_multisig');
  });

  it('tolerates the default vault index 0 spelled out without the addresses', () => {
    // The .env.example used to ship FORGE_SQUADS_VAULT_INDEX=0 next to empty addresses: that
    // is the default, not a configuration, and must not disable the buyback at startup.
    expect(readSquadsAddresses({ FORGE_SQUADS_VAULT_INDEX: '0' })).toBeNull();
    expect(
      readSquadsAddresses({
        FORGE_SQUADS_MULTISIG: '',
        FORGE_SQUADS_SPENDING_LIMIT: '',
        FORGE_SQUADS_VAULT_INDEX: '0',
      }),
    ).toBeNull();
    // Only the exact spelling `0` is the default: `00` or ` 0` is a mistake to report.
    expect(
      squadsError(() => readSquadsAddresses({ FORGE_SQUADS_VAULT_INDEX: '00' })).problem,
    ).toBe('index_without_multisig');
  });

  it.each(['-1', '256', '1.5', 'a', '01', ' 1', '1 ', '0x1'])(
    'refuses the vault index %j',
    (index) => {
      const error = squadsError(() =>
        readSquadsAddresses({ ...both, FORGE_SQUADS_VAULT_INDEX: index }),
      );
      expect(error.problem).toBe('invalid_index');
    },
  );

  it('refuses an invalid address through ForgeAddressError, names only', () => {
    const error = catchError(() =>
      readSquadsAddresses({ ...both, FORGE_SQUADS_MULTISIG: 'nope-not-a-key' }),
    );
    expect(error.invalid).toEqual(['FORGE_SQUADS_MULTISIG']);
    expect(error.message).not.toContain('nope-not-a-key');
    expect(
      catchError(() => readSquadsAddresses({ ...both, FORGE_SQUADS_SPENDING_LIMIT: 'x' })).invalid,
    ).toEqual(['FORGE_SQUADS_SPENDING_LIMIT']);
  });

  it('refuses a spending limit equal to the multisig', () => {
    const error = squadsError(() =>
      readSquadsAddresses({ ...both, FORGE_SQUADS_SPENDING_LIMIT: MULTISIG }),
    );
    expect(error.problem).toBe('not_distinct');
  });

  it('is served by requireAddresses as optional names', () => {
    expect(requireAddresses(['FORGE_SQUADS_MULTISIG'], {}).FORGE_SQUADS_MULTISIG).toBeNull();
    expect(
      requireAddresses(['FORGE_SQUADS_SPENDING_LIMIT'], both).FORGE_SQUADS_SPENDING_LIMIT?.toBase58(),
    ).toBe(LIMIT);
  });
});
