/**
 * The accounts the routes create with the payer wallet, as `CreationTarget`s (accounts.ts):
 * what core builds, which policy checks it, and how its on-chain existence is proven.
 */
import { NONCE_ACCOUNT_LENGTH, SystemProgram, type PublicKey } from '@solana/web3.js';
import {
  CREATE_CONFIG_COMPUTE_UNITS,
  CREATE_NONCE_ACCOUNT_COMPUTE_UNITS,
  type ConfigKind,
} from '@forge/core';
import type { LaunchpadSpec } from '@forge/shared';
import type { CreationTarget } from './accounts.js';
import type { RouteRuntime } from './context.js';
import { canonicalJson, sha256Hex } from './onchain.js';
import { assertCreateConfigTx, assertCreateNonceTx } from './policy.js';

export const CONFIG_LABELS: Record<ConfigKind, string> = {
  launchpad: 'launchpad_config',
  launchpadCoin: 'launchpad_coin_config',
};

export function configCreationTarget(
  rt: RouteRuntime,
  input: {
    launchpadId: string;
    spec: LaunchpadSpec;
    kind: ConfigKind;
    payer: PublicKey;
    owner: PublicKey;
  },
): CreationTarget {
  const { core } = rt;
  return {
    label: CONFIG_LABELS[input.kind],
    launchpadId: input.launchpadId,
    paramsHash: core.configParamsHash(input.spec, input.kind),
    build: async (address) => {
      // Priced for the two accounts it writes (SIGNER_PRIORITY_FEE_*, jobs/priority.ts).
      const fee = await rt.priorityFees.quote([input.payer, address], CREATE_CONFIG_COMPUTE_UNITS);
      return core.buildCreateConfigTx({
        spec: input.spec,
        kind: input.kind,
        config: address,
        payer: input.payer,
        computeUnitPriceMicroLamports: fee.microLamports,
      });
    },
    check: (tx, address) =>
      assertCreateConfigTx(tx, {
        dbcProgramId: core.dbcProgramId,
        payer: input.payer,
        config: address,
        owner: input.owner,
      }),
    async exists(address, read = { commitment: 'confirmed' }) {
      const account = await core.getAccount(address, read.commitment, read.minContextSlot);
      return !!account && account.owner.equals(core.dbcProgramId) && account.dataLength > 0;
    },
  };
}

/** Hash of the nonce account parameters: its authority (the creator wallet). */
export function nonceParamsHash(authority: PublicKey): string {
  return sha256Hex(canonicalJson({ kind: 'nonce', authority }));
}

export function nonceCreationTarget(
  rt: RouteRuntime,
  input: { launchpadId: string; payer: PublicKey; authority: PublicKey },
): CreationTarget {
  const { core } = rt;
  return {
    label: 'nonce_account',
    launchpadId: input.launchpadId,
    paramsHash: nonceParamsHash(input.authority),
    build: async (address) => {
      const fee = await rt.priorityFees.quote(
        [input.payer, address],
        CREATE_NONCE_ACCOUNT_COMPUTE_UNITS,
      );
      return core.buildCreateNonceAccountTx({
        payer: input.payer,
        nonceAccount: address,
        authority: input.authority,
        computeUnitPriceMicroLamports: fee.microLamports,
      });
    },
    check: (tx, address, rentLamports) =>
      assertCreateNonceTx(tx, {
        payer: input.payer,
        nonceAccount: address,
        authority: input.authority,
        rentLamports,
      }),
    async exists(address, read = { commitment: 'confirmed' }) {
      const account = await core.getAccount(address, read.commitment, read.minContextSlot);
      if (!account) return false;
      if (!account.owner.equals(SystemProgram.programId)) return false;
      if (account.dataLength !== NONCE_ACCOUNT_LENGTH) return false;
      // Initialized, with the expected authority (throws on another authority).
      const nonce = await core.readNonce(
        address,
        input.authority,
        read.commitment,
        read.minContextSlot,
      );
      return nonce !== null;
    },
  };
}
