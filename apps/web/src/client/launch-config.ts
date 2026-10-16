import { FEES } from '@forge/shared';
import { PublicKey, type AccountInfo, type Commitment } from '@solana/web3.js';
import { DBC_PROGRAM_ID, TransactionCheckError } from './verify';

/*
 * On-chain check of the launchpad coin config, run in the browser BEFORE the owner signs the
 * launch (after verifyLaunchTransaction pinned the transaction to the config of the server
 * response). The launch check proves the transaction creates the coin on that config; it cannot
 * tell what the config itself does, and the config address comes from the same server response.
 * So the config account is read from the chain, through the client's own connection (the FORGE
 * RPC relay), and must be the launchpad coin config @forge/core creates for this owner:
 * - fee claimer = the owner's wallet (the partner trading fees go to the client);
 * - pool creation fee = 0 (the launchpad coin is created by the owner, at no fee);
 * - creator trading fee percentage = FORGE's creator share (FEES.forgeCreatorSharePct, 25);
 * - token update authority = immutable (the coin metadata can never be changed).
 * Anything else, an account that is not a DBC config, or a config that cannot be read: nothing is
 * signed.
 *
 * Read-only. The account is decoded at the fixed offsets of the `PoolConfig` account of the
 * pinned DBC SDK 1.5.13 IDL (bytemuck, repr C, 1048 bytes with the discriminator); the test
 * checks them against the SDK's own account coder.
 */

/** Anchor discriminator of the DBC `PoolConfig` account (SDK 1.5.13 IDL). */
export const POOL_CONFIG_DISCRIMINATOR: readonly number[] = [26, 108, 14, 123, 116, 230, 129, 43];
/** Size of a `PoolConfig` account, discriminator included. */
export const POOL_CONFIG_SIZE = 1048;
/** Byte offsets of the fields checked, discriminator included. */
export const POOL_CONFIG_OFFSETS = {
  feeClaimer: 40,
  creatorTradingFeePercentage: 245,
  tokenUpdateAuthority: 246,
  /** u64, little endian, lamports. */
  poolCreationFee: 368,
} as const;
/** `TokenAuthorityOption.Immutable` of the DBC SDK. */
export const TOKEN_UPDATE_AUTHORITY_IMMUTABLE = 1;

export interface LaunchConfigFields {
  feeClaimer: string;
  creatorTradingFeePercentage: number;
  tokenUpdateAuthority: number;
  poolCreationFeeLamports: bigint;
}

/** What the check needs from a connection (a web3.js `Connection` fits). */
export interface LaunchConfigReader {
  getAccountInfo(key: PublicKey, commitment?: Commitment): Promise<AccountInfo<Buffer> | null>;
}

const NOT_A_CONFIG = 'The launchpad coin config on-chain is not a Meteora coin config.';

function refuse(message: string): never {
  throw new TransactionCheckError(message);
}

/** Decodes the checked fields of a `PoolConfig` account. @throws TransactionCheckError */
export function decodeLaunchConfig(
  account: Pick<AccountInfo<Uint8Array>, 'owner' | 'data'>,
): LaunchConfigFields {
  if (!account.owner.equals(new PublicKey(DBC_PROGRAM_ID))) refuse(NOT_A_CONFIG);
  const data = account.data;
  if (data.length !== POOL_CONFIG_SIZE) refuse(NOT_A_CONFIG);
  if (POOL_CONFIG_DISCRIMINATOR.some((byte, i) => data[i] !== byte)) refuse(NOT_A_CONFIG);
  const o = POOL_CONFIG_OFFSETS;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    feeClaimer: new PublicKey(data.subarray(o.feeClaimer, o.feeClaimer + 32)).toBase58(),
    creatorTradingFeePercentage: data[o.creatorTradingFeePercentage]!,
    tokenUpdateAuthority: data[o.tokenUpdateAuthority]!,
    poolCreationFeeLamports: view.getBigUint64(o.poolCreationFee, true),
  };
}

/** The decoded config is the launchpad coin config of `owner`. @throws TransactionCheckError */
export function checkLaunchConfig(fields: LaunchConfigFields, owner: string): void {
  if (fields.feeClaimer !== owner) {
    refuse('The launchpad coin config on-chain does not pay its trading fees to your wallet.');
  }
  if (fields.poolCreationFeeLamports !== 0n) {
    refuse('The launchpad coin config on-chain charges a coin creation fee.');
  }
  if (fields.creatorTradingFeePercentage !== FEES.forgeCreatorSharePct) {
    refuse(
      `The launchpad coin config on-chain does not set the ${FEES.forgeCreatorSharePct}% creator ` +
        'share of the trading fees.',
    );
  }
  if (fields.tokenUpdateAuthority !== TOKEN_UPDATE_AUTHORITY_IMMUTABLE) {
    refuse('The launchpad coin config on-chain lets the coin metadata be changed.');
  }
}

/**
 * Reads the launchpad coin config `config` on-chain and checks it for `owner`.
 * @throws TransactionCheckError (nothing was signed) when it cannot be read or does not match.
 */
export async function verifyLaunchConfigOnChain(
  connection: LaunchConfigReader | null | undefined,
  expected: { config: string; owner: string },
): Promise<LaunchConfigFields> {
  const unreadable =
    'The launchpad coin config could not be read on-chain to check it. Please try again.';
  if (!connection) refuse(unreadable);
  let key: PublicKey;
  try {
    key = new PublicKey(expected.config);
  } catch {
    refuse('The launch details from the server are invalid.');
  }
  let account: AccountInfo<Buffer> | null;
  try {
    account = await connection.getAccountInfo(key, 'confirmed');
  } catch {
    refuse(unreadable);
  }
  if (!account) refuse('The launchpad coin config does not exist on-chain.');
  const fields = decodeLaunchConfig(account);
  checkLaunchConfig(fields, expected.owner);
  return fields;
}
