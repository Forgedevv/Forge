import {
  DEFAULT_FIRST_BUY_SLIPPAGE_BPS,
  ForgeAddressError,
  LAUNCH_COIN_COMPUTE_UNITS,
  LaunchCoinError,
  METADATA_ACCOUNT_SIZE,
  METAPLEX_CREATE_METADATA_FEE_LAMPORTS,
  assertUserCoinConfig,
  buildUserCoinLaunchTx,
  type OnchainConfigExpectation,
} from '@forge/core';
import { DynamicBondingCurveClient, type PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type Keypair,
} from '@solana/web3.js';
import { SITE_PRIORITY_FEE } from '../priority-fee';
import type { PrepareLaunchResponse } from './api';
import { decodeTransaction } from '../tx/decode';
import { networkFeeLamports } from '../tx/fees';
import { MAX_FIRST_BUY_SLIPPAGE_BPS } from './verify';

/**
 * LOCKED ZONE. Server-only. Builds the launch transaction of a coin created by a user on this
 * launchpad's config with `@forge/core` (`buildUserCoinLaunchTx`, PLANEXECUTE rule 6): the user is
 * pool creator, rent payer, fee payer and buyer; the fresh mint signs; the user signs last in the
 * browser. Its priority fee is `SITE_PRIORITY_FEE` (../priority-fee.ts), priced by core. A first buy pays the 0.3% FORGE platform fee (one SOL transfer to
 * `FORGE_PLATFORM_FEE_WALLET`, the last instruction, added by core). Core compares the on-chain
 * config field by field with the launchpad config it builds (owner wallet and creation fee of
 * this site pinned), checks the platform fee wallet, quotes the first buy and reads the rent from
 * the cluster. Every chain read goes through the FORGE RPC relay connection handed in.
 *
 * This module only re-encodes core's instructions as a v0 message (the format the browser
 * verifies), signs it with the mint and maps core's summary to the wire summary. The output is
 * checked by the same verifier as the browser (`verify.ts`) before it is returned.
 */

/** Constants shared with `@forge/core` (single source of truth). */
export const LAUNCH_COMPUTE_UNITS = LAUNCH_COIN_COMPUTE_UNITS;
export {
  DEFAULT_FIRST_BUY_SLIPPAGE_BPS,
  METADATA_ACCOUNT_SIZE,
  METAPLEX_CREATE_METADATA_FEE_LAMPORTS,
};
/** Solana packet limit. */
export const MAX_TRANSACTION_BYTES = 1232;

export type LaunchBuildErrorCode =
  | 'config_not_found'
  | 'config_unsupported'
  | 'creation_fee_mismatch'
  | 'mint_exists'
  | 'first_buy_too_large'
  | 'too_large'
  | 'unexpected_signers'
  /** FORGE_PLATFORM_FEE_WALLET is missing, invalid or not rent-exempt: no first buy possible. */
  | 'platform_fee_unavailable';

export class LaunchBuildError extends Error {
  constructor(
    readonly code: LaunchBuildErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LaunchBuildError';
  }
}

export interface LoadedLaunchpadConfig {
  address: PublicKey;
  poolConfig: PoolConfig;
  poolCreationFeeLamports: bigint;
}

export interface LaunchBuildInput {
  mint: Keypair;
  wallet: string;
  name: string;
  symbol: string;
  metadataUri: string;
  firstBuyLamports: bigint;
  slippageBps?: number;
}

export interface LaunchBuilder {
  /** Reads and checks the launchpad config (before anything is uploaded). */
  loadConfig(): Promise<LoadedLaunchpadConfig>;
  /** Builds the transaction (signed by the mint only) and its summary. */
  build(config: LoadedLaunchpadConfig, input: LaunchBuildInput): Promise<PrepareLaunchResponse>;
}

export interface LaunchBuilderOptions {
  /** Connection to the FORGE RPC relay. */
  connection: Connection;
  /** `forge.config.json#onchain.launchpadConfig`. */
  launchpadConfig: string;
  /** `forge.config.json#onchain.poolCreationFeeSol`, in lamports. */
  poolCreationFeeLamports: bigint;
  /** `forge.config.json#onchain.ownerWallet`: the config's fee claimer and leftover receiver. */
  ownerWallet?: string;
  /** FORGE_PLATFORM_FEE_WALLET (`launchPlatformFeeWallet()`): recipient of the first-buy fee. */
  platformFeeWallet: string | null;
}

const toBigInt = (value: { toString(): string } | number | bigint): bigint =>
  BigInt(value.toString());

/** Maps a refusal of core to a builder error; anything else is a chain access failure. */
function mapCoreError(error: unknown): unknown {
  if (error instanceof ForgeAddressError) {
    return new LaunchBuildError(
      'platform_fee_unavailable',
      'Coins with a first buy cannot be created on this site right now.',
    );
  }
  if (!(error instanceof LaunchCoinError)) return error;
  switch (error.code) {
    case 'CONFIG_NOT_FOUND':
      return new LaunchBuildError(
        'config_not_found',
        'The launchpad config was not found on-chain.',
      );
    case 'CONFIG_MISMATCH':
      return /poolCreationFee is/.test(error.message)
        ? new LaunchBuildError(
            'creation_fee_mismatch',
            'The on-chain creation fee differs from this site configuration.',
          )
        : new LaunchBuildError(
            'config_unsupported',
            'The launchpad config is not a FORGE launchpad config for this site.',
          );
    case 'POOL_EXISTS':
    case 'MINT_EXISTS':
      return new LaunchBuildError('mint_exists', 'The generated coin address is already in use.');
    case 'FIRST_BUY_EXCEEDS_CURVE':
      return new LaunchBuildError(
        'first_buy_too_large',
        'The first buy is larger than what the curve sells before graduation.',
      );
    case 'QUOTE_FAILED':
      return new LaunchBuildError('first_buy_too_large', 'The first buy could not be quoted.');
    case 'TX_TOO_LARGE':
      return new LaunchBuildError(
        'too_large',
        'The launch transaction is too large: shorten the coin name or symbol.',
      );
    case 'UNEXPECTED_SIGNERS':
      return new LaunchBuildError(
        'unexpected_signers',
        'The launch transaction must be signed by the wallet and the mint only.',
      );
    case 'PLATFORM_FEE_WALLET_NOT_READY':
      return new LaunchBuildError(
        'platform_fee_unavailable',
        'Coins with a first buy cannot be created on this site right now.',
      );
    case 'INVALID_INPUT':
      return new RangeError(error.message);
    default:
      return error;
  }
}

export function createLaunchBuilder(options: LaunchBuilderOptions): LaunchBuilder {
  const { connection } = options;
  const configKey = new PublicKey(options.launchpadConfig);
  const expectedConfig: OnchainConfigExpectation = {
    poolCreationFeeLamports: options.poolCreationFeeLamports,
    ...(options.ownerWallet ? { owner: new PublicKey(options.ownerWallet) } : {}),
  };

  return {
    async loadConfig() {
      // Read only (decoded by the pinned SDK); the transaction itself is built by @forge/core.
      const client = new DynamicBondingCurveClient(connection, 'confirmed');
      const poolConfig = await client.state.getPoolConfig(configKey);
      if (!poolConfig) {
        throw new LaunchBuildError(
          'config_not_found',
          'The launchpad config was not found on-chain.',
        );
      }
      const fee = toBigInt(poolConfig.poolCreationFee);
      if (fee !== options.poolCreationFeeLamports) {
        throw new LaunchBuildError(
          'creation_fee_mismatch',
          'The on-chain creation fee differs from this site configuration.',
        );
      }
      try {
        assertUserCoinConfig(poolConfig, expectedConfig);
      } catch (error) {
        throw mapCoreError(error);
      }
      return { address: configKey, poolConfig, poolCreationFeeLamports: fee };
    },

    async build(config, input) {
      const wallet = new PublicKey(input.wallet);
      const slippageBps = input.slippageBps ?? DEFAULT_FIRST_BUY_SLIPPAGE_BPS;
      if (
        !Number.isInteger(slippageBps) ||
        slippageBps < 0 ||
        slippageBps > MAX_FIRST_BUY_SLIPPAGE_BPS
      ) {
        throw new RangeError('slippageBps out of range');
      }

      let built;
      try {
        built = await buildUserCoinLaunchTx({
          connection,
          config: config.address,
          wallet,
          mint: input.mint.publicKey,
          name: input.name,
          symbol: input.symbol,
          metadataUri: input.metadataUri,
          firstBuyLamports: input.firstBuyLamports,
          slippageBps,
          computeUnitLimit: LAUNCH_COMPUTE_UNITS,
          priority: SITE_PRIORITY_FEE,
          // The fee wallet of this site's public environment, and nothing else.
          env: { FORGE_PLATFORM_FEE_WALLET: options.platformFeeWallet ?? undefined },
          expectedConfig,
        });
      } catch (error) {
        throw mapCoreError(error);
      }
      const { summary } = built;

      // Same instructions, as the v0 message the browser verifies.
      const message = new TransactionMessage({
        payerKey: wallet,
        recentBlockhash: summary.recentBlockhash,
        instructions: built.transaction.instructions,
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      const mint = input.mint.publicKey;
      const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
      if (signers.length !== 2 || !signers[0]?.equals(wallet) || !signers[1]?.equals(mint)) {
        throw new LaunchBuildError(
          'unexpected_signers',
          'The launch transaction must be signed by the wallet and the mint only.',
        );
      }
      const tooLarge = () =>
        new LaunchBuildError(
          'too_large',
          'The launch transaction is too large: shorten the coin name or symbol.',
        );
      let bytes: Uint8Array;
      try {
        // web3.js serializes into a packet-sized buffer and throws a RangeError beyond it.
        tx.sign([input.mint]);
        bytes = tx.serialize();
      } catch (error) {
        if (error instanceof RangeError) throw tooLarge();
        throw error;
      }
      if (bytes.length > MAX_TRANSACTION_BYTES) throw tooLarge();

      // Pool, mint, metadata, two vaults; plus the user's coin account with a first buy. The
      // wrapped SOL account is created and closed in the transaction: its rent comes back.
      const { costs } = summary;
      const accountRent = costs.poolAccountsRentLamports + costs.ownerTokenAccountRentLamports;

      return {
        success: true,
        poolTx: Buffer.from(bytes).toString('base64'),
        mint: mint.toBase58(),
        summary: {
          coinName: input.name,
          coinSymbol: input.symbol,
          creatorWallet: wallet.toBase58(),
          poolCreationFeeLamports: costs.poolCreationFeeLamports.toString(),
          firstBuyLamports: costs.firstBuyLamports.toString(),
          firstBuyExpectedTokensOut: summary.expectedTokensOut.toString(),
          firstBuyMinimumTokensOut: summary.minimumTokensOut.toString(),
          platformFeeLamports: summary.platformFeeLamports.toString(),
          estimatedNetworkFeeLamports: networkFeeLamports(decodeTransaction(tx)).toString(),
          accountRentLamports: accountRent.toString(),
          metadataFeeLamports: costs.metaplexFeeLamports.toString(),
        },
      };
    },
  };
}
