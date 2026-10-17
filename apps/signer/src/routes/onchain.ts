/**
 * The slice of `@forge/core` the signing routes use (PLANEXECUTE.md rule 6: core builds every
 * transaction; the routes only check, sign, record and send what core returns).
 *
 * The routes see the `RouteCore` interface, injected at startup; tests inject fakes.
 * `createForgeRouteCore` binds one connection and forwards to core:
 *   - `configParamsHash`         -> `buildConfigParams` (pure, validated), hashed;
 *   - `buildCreateConfigTx`      -> `buildCreateConfigTx` (unsigned, blockhash set);
 *   - `buildCreateNonceAccountTx`-> `buildCreateNonceAccountTx` (unsigned, rent from the cluster);
 *   - `readNonce`                -> `readNonce` (authority checked) on one `getAccountInfoAndContext`
 *                                  read, so the value comes with the slot it was read at;
 *   - `buildLaunchCoinTx`        -> `buildLaunchCoinTx` with the durable nonce (unsigned).
 * The pool address derivation and the DBC program id come from the pinned DBC SDK, as in
 * core-adapter.ts (core does not export them).
 */
import { createHash } from 'node:crypto';
import {
  buildConfigParams,
  buildCreateConfigTx as coreBuildCreateConfigTx,
  buildCreateNonceAccountTx as coreBuildCreateNonceAccountTx,
  buildLaunchCoinTx as coreBuildLaunchCoinTx,
  readNonce as coreReadNonce,
  type ConfigKind,
  type LaunchCoinTx,
  type PriorityFeeSetting,
} from '@forge/core';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import { PublicKey, type Connection, type Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import type { LaunchpadSpec } from '@forge/shared';

export type ReadCommitment = 'confirmed' | 'finalized';

export interface BuiltCreationTx {
  /** Unsigned; fee payer and recent blockhash set. */
  transaction: Transaction;
  lastValidBlockHeight: number;
  /** Rent deposit of the created account, read from the cluster. */
  rentLamports: bigint;
}

export interface AccountSummary {
  owner: PublicKey;
  lamports: bigint;
  dataLength: number;
}

export interface NonceState {
  /** Current nonce value (the recent blockhash of a transaction using it). */
  nonce: string;
  /** `context.slot` of the answer. */
  slot: number;
}

export interface LaunchBuildParams {
  config: PublicKey;
  creator: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  metadataUri: string;
  firstBuyLamports: bigint;
  nonceAccount: PublicKey;
}

export interface RouteCore {
  readonly dbcProgramId: PublicKey;
  /**
   * Referral token account passed to the first buy: always null (core refuses a referral on the
   * first buy, REFERRAL_UNSUPPORTED). Kept in the launch inputs hash.
   */
  readonly firstBuyReferral: PublicKey | null;
  /** sha256 (hex) of the exact config parameters core would send for this spec (pure). */
  configParamsHash(spec: LaunchpadSpec, kind: ConfigKind): string;
  buildCreateConfigTx(params: {
    spec: LaunchpadSpec;
    kind: ConfigKind;
    config: PublicKey;
    payer: PublicKey;
    computeUnitPriceMicroLamports: number;
  }): Promise<BuiltCreationTx>;
  buildCreateNonceAccountTx(params: {
    payer: PublicKey;
    nonceAccount: PublicKey;
    authority: PublicKey;
    computeUnitPriceMicroLamports: number;
  }): Promise<BuiltCreationTx>;
  /**
   * Current nonce value and the slot of the answer, or null when the account does not exist.
   * Throws DurableNonceError when it is not an initialized nonce account of `authority`.
   */
  readNonce(
    nonceAccount: PublicKey,
    authority: PublicKey,
    commitment: ReadCommitment,
    /** When set, the RPC refuses to answer from a state older than this slot. */
    minContextSlot?: number,
  ): Promise<NonceState | null>;
  /** Unsigned launch transaction with the durable nonce (nonce authority = creator, rent paid by
   * the owner, no first-buy referral). */
  buildLaunchCoinTx(params: LaunchBuildParams): Promise<LaunchCoinTx>;
  /** The account, or null; with `minContextSlot`, read from a node at least at that slot. */
  getAccount(
    address: PublicKey,
    commitment: ReadCommitment,
    minContextSlot?: number,
  ): Promise<AccountSummary | null>;
  /**
   * Which of `addresses` exist, read from a node whose state is at least `minContextSlot` (the
   * RPC refuses to answer from an older state).
   */
  accountsExist(
    addresses: readonly PublicKey[],
    commitment: ReadCommitment,
    minContextSlot: number,
  ): Promise<boolean[]>;
  /** True when a successful transaction references the address (recent confirmed history). */
  hasSuccessfulTransaction(address: PublicKey): Promise<boolean>;
  /** Address of the SOL-quoted DBC pool of `mint` on `config`. */
  poolAddress(config: PublicKey, mint: PublicKey): PublicKey;
}

/** JSON with deterministic key order; BN, bigint and PublicKey as strings. */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return v.toString();
    if (BN.isBN(v)) return (v as BN).toString(10);
    if (v instanceof PublicKey) return v.toBase58();
    if (Array.isArray(v)) return v.map(normalize);
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const item = (v as Record<string, unknown>)[key];
        if (item !== undefined && typeof item !== 'function') out[key] = normalize(item);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface ForgeRouteCoreOptions {
  connection: Connection;
  /**
   * Priority fee of the launch transactions (jobs/priority.ts `PriorityFees.setting`), priced by
   * core and placed where it fits (`priorityFeePlacement`). Without it, no price.
   */
  priority?: PriorityFeeSetting;
}

/**
 * No referral on the client's first buy, ever: on devnet (2026-10-11,
 * scripts/devnet-tests/reports/signer-routes.md) a first buy carrying a referral account does NOT
 * get the first-swap minimum fee (it pays the anti-sniper fee and fails on slippage, even at 10%),
 * and core now refuses one (REFERRAL_UNSUPPORTED). It is passed explicitly as null.
 */
const FIRST_BUY_REFERRAL = null;

export function createForgeRouteCore(options: ForgeRouteCoreOptions): RouteCore {
  const { connection } = options;
  const firstBuyReferral = FIRST_BUY_REFERRAL;

  return {
    dbcProgramId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    firstBuyReferral,

    configParamsHash(spec, kind) {
      return sha256Hex(canonicalJson({ kind, params: buildConfigParams(spec, kind) }));
    },

    async buildCreateConfigTx(params) {
      const built = await coreBuildCreateConfigTx({
        connection,
        spec: params.spec,
        kind: params.kind,
        config: params.config,
        payer: params.payer,
        computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
      });
      return {
        transaction: built.transaction,
        lastValidBlockHeight: built.lastValidBlockHeight,
        rentLamports: built.rentLamports,
      };
    },

    async buildCreateNonceAccountTx(params) {
      const built = await coreBuildCreateNonceAccountTx({
        connection,
        payer: params.payer,
        nonceAccount: params.nonceAccount,
        authority: params.authority,
        ...(params.computeUnitPriceMicroLamports > 0
          ? { computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports }
          : {}),
      });
      return {
        transaction: built.transaction,
        lastValidBlockHeight: built.lastValidBlockHeight,
        rentLamports: built.rentLamports,
      };
    },

    async readNonce(nonceAccount, authority, commitment, minContextSlot) {
      // One read gives both the account and the slot of the answer; core decodes and checks it.
      const { context, value } = await connection.getAccountInfoAndContext(nonceAccount, {
        commitment,
        ...(minContextSlot !== undefined ? { minContextSlot } : {}),
      });
      if (!value) return null;
      const info = await coreReadNonce({ getAccountInfo: async () => value }, nonceAccount, {
        expectedAuthority: authority,
        commitment,
      });
      return { nonce: info.nonce, slot: context.slot };
    },

    buildLaunchCoinTx(params) {
      return coreBuildLaunchCoinTx({
        connection,
        config: params.config,
        creator: params.creator,
        owner: params.owner,
        mint: params.mint,
        name: params.name,
        symbol: params.symbol,
        metadataUri: params.metadataUri,
        firstBuyLamports: params.firstBuyLamports,
        durableNonce: { nonceAccount: params.nonceAccount, authority: params.creator },
        rentPayer: 'owner',
        referralTokenAccount: firstBuyReferral,
        env: {},
        ...(options.priority ? { priority: options.priority } : {}),
      });
    },

    async getAccount(address, commitment, minContextSlot) {
      const info = await connection.getAccountInfo(address, {
        commitment,
        ...(minContextSlot !== undefined ? { minContextSlot } : {}),
      });
      if (!info) return null;
      return { owner: info.owner, lamports: BigInt(info.lamports), dataLength: info.data.length };
    },

    async accountsExist(addresses, commitment, minContextSlot) {
      const { value } = await connection.getMultipleAccountsInfoAndContext([...addresses], {
        commitment,
        minContextSlot,
      });
      return value.map((info) => info !== null);
    },

    async hasSuccessfulTransaction(address) {
      const sigs = await connection.getSignaturesForAddress(address, { limit: 50 }, 'confirmed');
      return sigs.some((s) => s.err === null);
    },

    poolAddress(config, mint) {
      return deriveDbcPoolAddress(NATIVE_MINT, mint, config);
    },
  };
}
