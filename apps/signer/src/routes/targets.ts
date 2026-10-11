/**
 * The accounts the routes create with the payer wallet, as `CreationTarget`s (accounts.ts):
 * what core builds, which policy checks it, and how its on-chain existence is proven.
 */
import { NONCE_ACCOUNT_LENGTH, SystemProgram, type PublicKey } from '@solana/web3.js';
import type { ConfigKind } from '@forge/core';
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
    build: (address) =>
      core.buildCreateConfigTx({
        spec: input.spec,
        kind: input.kind,
        config: address,
        payer: input.payer,
        computeUnitPriceMicroLamports: rt.computeUnitPriceMicroLamports,
      }),
    check: (tx, address) =>
      assertCreateConfigTx(tx, {
        dbcProgramId: core.dbcProgramId,
        payer: input.payer,
        config: address,
        owner: input.owner,
      }),
    async exists(address) {
      const account = await core.getAccount(address, 'confirmed');
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
    build: (address) =>
      core.buildCreateNonceAccountTx({
        payer: input.payer,
        nonceAccount: address,
        authority: input.authority,
        computeUnitPriceMicroLamports: rt.computeUnitPriceMicroLamports,
      }),
    check: (tx, address, rentLamports) =>
      assertCreateNonceTx(tx, {
        payer: input.payer,
        nonceAccount: address,
        authority: input.authority,
        rentLamports,
      }),
    async exists(address) {
      const account = await core.getAccount(address, 'confirmed');
      if (!account) return false;
      if (!account.owner.equals(SystemProgram.programId)) return false;
      if (account.dataLength !== NONCE_ACCOUNT_LENGTH) return false;
      // Initialized, with the expected authority (throws on another authority).
      return (await core.readNonce(address, input.authority, 'confirmed')) !== null;
    },
  };
}
