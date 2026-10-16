// @vitest-environment node
import { FEES } from '@forge/shared';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  checkLaunchConfig,
  decodeLaunchConfig,
  POOL_CONFIG_DISCRIMINATOR,
  POOL_CONFIG_SIZE,
  TOKEN_UPDATE_AUTHORITY_IMMUTABLE,
  verifyLaunchConfigOnChain,
  type LaunchConfigFields,
} from '../launch-config';
import { DBC_PROGRAM_ID, TransactionCheckError } from '../verify';
import { coinConfigAccount } from './helpers';

/*
 * The browser decodes the DBC `PoolConfig` account at fixed offsets. These tests check those
 * offsets against the pinned DBC SDK's own account coder (loaded the way @forge/core loads it,
 * read-only: the web app does not depend on the SDK).
 */

interface AccountsCoder {
  size(name: string): number;
  decode(name: string, data: Buffer): Record<string, unknown>;
}

const fromCore = createRequire(
  new URL('../../../../../packages/core/package.json', import.meta.url),
);
const sdkPath = fromCore.resolve('@meteora-ag/dynamic-bonding-curve-sdk');
const sdk = createRequire(sdkPath)(sdkPath) as {
  DynamicBondingCurveIdl: { accounts: { name: string; discriminator: number[] }[] };
  DYNAMIC_BONDING_CURVE_PROGRAM_ID: PublicKey;
  TokenAuthorityOption: Record<string, number>;
};
const anchor = createRequire(sdkPath)('@coral-xyz/anchor') as {
  BorshAccountsCoder: new (idl: unknown) => AccountsCoder;
};
const coder = new anchor.BorshAccountsCoder(sdk.DynamicBondingCurveIdl);

const owner = Keypair.generate().publicKey;

describe('PoolConfig layout (DBC SDK 1.5.13)', () => {
  it('matches the SDK program id, discriminator, size and token authority option', () => {
    expect(DBC_PROGRAM_ID).toBe(sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58());
    const idlAccount = sdk.DynamicBondingCurveIdl.accounts.find((a) => a.name === 'PoolConfig');
    expect(idlAccount?.discriminator).toEqual([...POOL_CONFIG_DISCRIMINATOR]);
    expect(coder.size('PoolConfig')).toBe(POOL_CONFIG_SIZE);
    expect(TOKEN_UPDATE_AUTHORITY_IMMUTABLE).toBe(sdk.TokenAuthorityOption.Immutable);
  });

  it('reads the fields where the SDK coder reads them', () => {
    const feeClaimer = Keypair.generate().publicKey;
    const account = coinConfigAccount({
      feeClaimer,
      creatorTradingFeePercentage: 37,
      tokenUpdateAuthority: 3,
      poolCreationFeeLamports: 123_456_789n,
    });
    const decoded = coder.decode('PoolConfig', account.data) as {
      fee_claimer: PublicKey;
      creator_trading_fee_percentage: number;
      token_update_authority: number;
      pool_creation_fee: { toString(): string };
    };
    expect(decoded.fee_claimer.toBase58()).toBe(feeClaimer.toBase58());
    expect(decoded.creator_trading_fee_percentage).toBe(37);
    expect(decoded.token_update_authority).toBe(3);
    expect(decoded.pool_creation_fee.toString()).toBe('123456789');
    expect(decodeLaunchConfig(account)).toEqual({
      feeClaimer: feeClaimer.toBase58(),
      creatorTradingFeePercentage: 37,
      tokenUpdateAuthority: 3,
      poolCreationFeeLamports: 123_456_789n,
    });
  });
});

describe('checkLaunchConfig', () => {
  const valid: LaunchConfigFields = {
    feeClaimer: owner.toBase58(),
    creatorTradingFeePercentage: FEES.forgeCreatorSharePct,
    tokenUpdateAuthority: TOKEN_UPDATE_AUTHORITY_IMMUTABLE,
    poolCreationFeeLamports: 0n,
  };

  it('accepts the launchpad coin config of the owner', () => {
    expect(FEES.forgeCreatorSharePct).toBe(25);
    expect(() => checkLaunchConfig(valid, owner.toBase58())).not.toThrow();
  });

  it.each([
    ['another fee claimer', { feeClaimer: Keypair.generate().publicKey.toBase58() }, /your wallet/],
    ['a creation fee', { poolCreationFeeLamports: 1n }, /coin creation fee/],
    ['another creator share', { creatorTradingFeePercentage: 24 }, /25% creator share/],
    ['no creator share', { creatorTradingFeePercentage: 0 }, /25% creator share/],
    ['a creator update authority', { tokenUpdateAuthority: 0 }, /metadata be changed/],
    ['a partner update authority', { tokenUpdateAuthority: 2 }, /metadata be changed/],
  ])('refuses %s, with nothing signed', (_label, change, message) => {
    let caught: unknown;
    try {
      checkLaunchConfig({ ...valid, ...change }, owner.toBase58());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TransactionCheckError);
    expect((caught as Error).message).toMatch(message);
    expect((caught as Error).message).toMatch(/Nothing was signed\.$/);
  });
});

describe('verifyLaunchConfigOnChain', () => {
  it('reads the config at the confirmed commitment and returns its fields', async () => {
    const config = Keypair.generate().publicKey;
    const getAccountInfo = vi.fn(async () => coinConfigAccount({ feeClaimer: owner }));
    await expect(
      verifyLaunchConfigOnChain(
        { getAccountInfo },
        { config: config.toBase58(), owner: owner.toBase58() },
      ),
    ).resolves.toMatchObject({ feeClaimer: owner.toBase58(), poolCreationFeeLamports: 0n });
    expect(getAccountInfo).toHaveBeenCalledWith(config, 'confirmed');
  });

  it('refuses an invalid config address without reading anything', async () => {
    const getAccountInfo = vi.fn();
    await expect(
      verifyLaunchConfigOnChain(
        { getAccountInfo },
        { config: 'not-a-key', owner: owner.toBase58() },
      ),
    ).rejects.toThrow(/launch details from the server are invalid/);
    expect(getAccountInfo).not.toHaveBeenCalled();
  });
});
