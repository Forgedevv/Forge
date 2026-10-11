import {
  DynamicBondingCurveClient,
  type PoolConfig,
  type SwapQuoteConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  ACCOUNT_SIZE,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import type { PrepareLaunchResponse } from './api';
import { decodeTransaction } from '../tx/decode';
import { networkFeeLamports } from '../tx/fees';
import { ASSOCIATED_TOKEN_PROGRAM_ID, dbcPoolAddress } from '../tx/programs';
import { MAX_FIRST_BUY_SLIPPAGE_BPS } from './verify';

/**
 * LOCKED ZONE. Server-only. Builds the launch transaction of a coin created by a user on this
 * launchpad's config, with the pinned Meteora SDK (`createPoolWithFirstBuy`): the user is pool
 * creator, rent payer, fee payer and buyer; the fresh mint signs; the user signs last in the
 * browser. Every chain read goes through the FORGE RPC relay connection handed in; rent is read
 * from the cluster (`getMinimumBalanceForRentExemption`), never hardcoded.
 *
 * SWITCH TO @forge/core: once `@forge/core` exports a builder for user coins on a launchpad config
 * (creator = payer = buyer) and the template depends on it, replace this module with a thin wrapper.
 * The output is checked by the same verifier as the browser (`verify.ts`) before it is returned.
 */

/** Compute unit limit of the launch transaction (same as `@forge/core` LAUNCH_COIN_COMPUTE_UNITS). */
export const LAUNCH_COMPUTE_UNITS = 300_000;
/** Default slippage applied to the first buy minimum (same default as `@forge/core`). */
export const DEFAULT_FIRST_BUY_SLIPPAGE_BPS = 100;
/** Size of the Metaplex metadata account created with the pool (measured on devnet, @forge/core). */
export const METADATA_ACCOUNT_SIZE = 607;
/** Metaplex Token Metadata creation fee (0.01 SOL, measured on devnet, @forge/core). */
export const METAPLEX_CREATE_METADATA_FEE_LAMPORTS = BigInt(10_000_000);
/** Solana packet limit. */
export const MAX_TRANSACTION_BYTES = 1232;

export type LaunchBuildErrorCode =
  | 'config_not_found'
  | 'config_unsupported'
  | 'creation_fee_mismatch'
  | 'mint_exists'
  | 'first_buy_too_large'
  | 'too_large'
  | 'unexpected_signers';

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

/** The parts of the SDK client used here (injectable in tests). */
export interface DbcClientLike {
  state: { getPoolConfig(config: PublicKey): Promise<PoolConfig | null> };
  pool: {
    getQuoteFromInputAmount(params: {
      config: SwapQuoteConfig;
      swapBaseForQuote: boolean;
      amountIn: BN;
      slippageBps?: number;
      hasReferral?: boolean;
      eligibleForFirstSwapWithMinFee?: boolean;
    }): { outputAmount: BN; minimumAmountOut?: BN };
  };
  creator: {
    createPoolWithFirstBuy(params: {
      createPoolParam: {
        name: string;
        symbol: string;
        uri: string;
        payer: PublicKey;
        poolCreator: PublicKey;
        config: PublicKey;
        baseMint: PublicKey;
      };
      firstBuyParam?: {
        buyer: PublicKey;
        receiver?: PublicKey;
        buyAmount: BN;
        minimumAmountOut: BN;
        referralTokenAccount: PublicKey | null;
      };
    }): Promise<{ instructions: TransactionInstruction[] }>;
    getProgram(): { account: { virtualPool: { size: number } } };
  };
}

export interface LaunchBuilderOptions {
  /** Connection to the FORGE RPC relay. */
  connection: Connection;
  /** `forge.config.json#onchain.launchpadConfig`. */
  launchpadConfig: string;
  /** `forge.config.json#onchain.poolCreationFeeSol`, in lamports. */
  poolCreationFeeLamports: bigint;
  client?: DbcClientLike;
}

const toBigInt = (value: BN | number | bigint): bigint => BigInt(value.toString());

/** The quote inputs of a pool config, for a pool that does not exist yet. */
function quoteConfigOf(config: PoolConfig): SwapQuoteConfig {
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: config.poolFees.baseFee.cliffFeeNumerator,
        firstFactor: config.poolFees.baseFee.firstFactor,
        secondFactor: config.poolFees.baseFee.secondFactor,
        thirdFactor: config.poolFees.baseFee.thirdFactor,
        baseFeeMode: config.poolFees.baseFee.baseFeeMode,
      },
      dynamicFee: config.poolFees.dynamicFee,
    },
    collectFeeMode: config.collectFeeMode,
    sqrtStartPrice: config.sqrtStartPrice,
    migrationQuoteThreshold: config.migrationQuoteThreshold,
    curve: config.curve,
    migrationSqrtPrice: config.migrationSqrtPrice,
  } as SwapQuoteConfig;
}

function createsAta(instructions: readonly TransactionInstruction[], ata: PublicKey): boolean {
  return instructions.some(
    (ix) =>
      ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID && ix.keys[1]?.pubkey.equals(ata),
  );
}

export function createLaunchBuilder(options: LaunchBuilderOptions): LaunchBuilder {
  const { connection } = options;
  const client: DbcClientLike =
    options.client ??
    (new DynamicBondingCurveClient(connection, 'confirmed') as unknown as DbcClientLike);
  const configKey = new PublicKey(options.launchpadConfig);

  return {
    async loadConfig() {
      const poolConfig = await client.state.getPoolConfig(configKey);
      if (!poolConfig) {
        throw new LaunchBuildError(
          'config_not_found',
          'The launchpad config was not found on-chain.',
        );
      }
      // The browser only accepts SPL coins quoted in SOL (verify.ts).
      if (!new PublicKey(poolConfig.quoteMint).equals(NATIVE_MINT) || poolConfig.tokenType !== 0) {
        throw new LaunchBuildError(
          'config_unsupported',
          'The launchpad config is not an SPL coin quoted in SOL.',
        );
      }
      const fee = toBigInt(poolConfig.poolCreationFee);
      if (fee !== options.poolCreationFeeLamports) {
        throw new LaunchBuildError(
          'creation_fee_mismatch',
          'The on-chain creation fee differs from this site configuration.',
        );
      }
      return { address: configKey, poolConfig, poolCreationFeeLamports: fee };
    },

    async build(config, input) {
      const wallet = new PublicKey(input.wallet);
      const mint = input.mint.publicKey;
      const slippageBps = input.slippageBps ?? DEFAULT_FIRST_BUY_SLIPPAGE_BPS;
      if (
        !Number.isInteger(slippageBps) ||
        slippageBps < 0 ||
        slippageBps > MAX_FIRST_BUY_SLIPPAGE_BPS
      ) {
        throw new RangeError('slippageBps out of range');
      }
      const hasBuy = input.firstBuyLamports > BigInt(0);
      const pool = new PublicKey(dbcPoolAddress(config.address.toBase58(), mint.toBase58()));

      // A fresh mint never exists; refuse anything else rather than build on top of it.
      const [mintInfo, poolInfo] = await connection.getMultipleAccountsInfo(
        [mint, pool],
        'confirmed',
      );
      if (mintInfo || poolInfo) {
        throw new LaunchBuildError('mint_exists', 'The generated coin address is already in use.');
      }

      // First buy quote on the fresh pool, at the minimum fee (nothing trades before it).
      let expectedOut = BigInt(0);
      let minimumOut = BigInt(0);
      if (hasBuy) {
        let quote;
        try {
          quote = client.pool.getQuoteFromInputAmount({
            config: quoteConfigOf(config.poolConfig),
            swapBaseForQuote: false,
            amountIn: new BN(input.firstBuyLamports.toString()),
            slippageBps,
            hasReferral: false,
            eligibleForFirstSwapWithMinFee: true,
          });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          throw new LaunchBuildError(
            'first_buy_too_large',
            /liquidity|complete|exceed/i.test(text)
              ? 'The first buy is larger than what the curve sells before graduation.'
              : 'The first buy could not be quoted.',
          );
        }
        expectedOut = toBigInt(quote.outputAmount);
        minimumOut =
          quote.minimumAmountOut !== undefined
            ? toBigInt(quote.minimumAmountOut)
            : (expectedOut * BigInt(10_000 - slippageBps)) / BigInt(10_000);
        if (expectedOut <= BigInt(0) || minimumOut <= BigInt(0) || minimumOut > expectedOut) {
          throw new LaunchBuildError('first_buy_too_large', 'The first buy could not be quoted.');
        }
      }

      const sdkTx = await client.creator.createPoolWithFirstBuy({
        createPoolParam: {
          name: input.name,
          symbol: input.symbol,
          uri: input.metadataUri,
          payer: wallet,
          poolCreator: wallet,
          config: config.address,
          baseMint: mint,
        },
        ...(hasBuy
          ? {
              firstBuyParam: {
                buyer: wallet,
                receiver: wallet,
                buyAmount: new BN(input.firstBuyLamports.toString()),
                minimumAmountOut: new BN(minimumOut.toString()),
                referralTokenAccount: null,
              },
            }
          : {}),
      });

      const instructions: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: LAUNCH_COMPUTE_UNITS }),
      ];
      // The SDK adds the WSOL account only when missing at build time; create it idempotently
      // anyway so that the transaction does not depend on that account staying open.
      const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true, TOKEN_PROGRAM_ID);
      if (hasBuy && !createsAta(sdkTx.instructions, wsolAta)) {
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            wallet,
            wsolAta,
            wallet,
            NATIVE_MINT,
            TOKEN_PROGRAM_ID,
          ),
        );
      }
      instructions.push(...sdkTx.instructions);

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const message = new TransactionMessage({
        payerKey: wallet,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
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

      // Costs, rent read from the cluster.
      const rentFor = async (size: number) =>
        BigInt(await connection.getMinimumBalanceForRentExemption(size, 'confirmed'));
      const [poolRent, mintRent, metadataRent, tokenAccountRent] = await Promise.all([
        rentFor(client.creator.getProgram().account.virtualPool.size),
        rentFor(MINT_SIZE),
        rentFor(METADATA_ACCOUNT_SIZE),
        rentFor(ACCOUNT_SIZE),
      ]);
      // Pool, mint, metadata, two vaults; plus the user's coin account with a first buy. The
      // wrapped SOL account is created and closed in the transaction: its rent comes back.
      const accountRent =
        poolRent +
        mintRent +
        metadataRent +
        BigInt(2) * tokenAccountRent +
        (hasBuy ? tokenAccountRent : BigInt(0));

      return {
        success: true,
        poolTx: Buffer.from(bytes).toString('base64'),
        mint: mint.toBase58(),
        summary: {
          coinName: input.name,
          coinSymbol: input.symbol,
          creatorWallet: wallet.toBase58(),
          poolCreationFeeLamports: config.poolCreationFeeLamports.toString(),
          firstBuyLamports: input.firstBuyLamports.toString(),
          firstBuyExpectedTokensOut: expectedOut.toString(),
          firstBuyMinimumTokensOut: minimumOut.toString(),
          estimatedNetworkFeeLamports: networkFeeLamports(decodeTransaction(tx)).toString(),
          accountRentLamports: accountRent.toString(),
          metadataFeeLamports: METAPLEX_CREATE_METADATA_FEE_LAMPORTS.toString(),
        },
      };
    },
  };
}
