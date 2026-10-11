/**
 * Transaction policies of the signing routes: checked on what core built, BEFORE any FORGE key
 * signs it (defense in depth against a wrong or tampered transaction).
 *
 * - Config creation: fee payer = payer wallet; signers = {payer, config key}; only bounded
 *   compute budget instructions and ONE DBC `create_config` on that config, with the client as
 *   fee claimer and leftover receiver and SOL as quote.
 * - Nonce account creation: fee payer = payer wallet; signers = {payer, nonce key}; only bounded
 *   compute budget, System `CreateAccount` (payer -> nonce account, rent, 80 bytes, System owned)
 *   then System `InitializeNonceAccount` with the launchpad's creator wallet as authority.
 * - Launch (pool + first buy): fee payer = the client; signers = {client, creator, mint}; the
 *   durable nonce advance first (authority = creator); the creator wallet read-only and present
 *   ONLY in the nonce advance and the pool initialization (so its signature cannot authorize
 *   anything else, e.g. a creator transfer or a nonce withdrawal); DBC instructions limited to
 *   one `initialize_virtual_pool_with_spl_token` on the expected config / pool / mint and, with a
 *   first buy, one `swap` paid by the client; System only for the nonce advance and transfers
 *   FROM the client; SPL Token only SyncNative / CloseAccount by the client; Associated Token
 *   only (idempotent) creations funded by and for the client.
 * - Launch revocation (operator command, revoke.ts): fee payer = payer wallet; signers = {payer,
 *   creator}; only bounded compute budget and ONE System `AdvanceNonceAccount` of the launchpad's
 *   nonce account by the creator wallet (read-only): the creator signature can do nothing else.
 * Account indexes follow the pinned DBC SDK IDL (1.5.13).
 */
import { createHash } from 'node:crypto';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  type Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { JobError, MAX_COMPUTE_UNIT_LIMIT, MAX_COMPUTE_UNIT_PRICE } from '../jobs/shared.js';

function policy(rule: string): never {
  throw new JobError('TX_POLICY', rule);
}

/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
export function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`, 'utf8').digest().subarray(0, 8);
}

export const DBC_DISCRIMINATORS = {
  createConfig: anchorDiscriminator('create_config'),
  initializePool: anchorDiscriminator('initialize_virtual_pool_with_spl_token'),
  swap: anchorDiscriminator('swap'),
} as const;

/** Account indexes of the DBC instructions (SDK 1.5.13 IDL). */
const CREATE_CONFIG_IX = {
  config: 0,
  feeClaimer: 1,
  leftoverReceiver: 2,
  quoteMint: 3,
  payer: 4,
} as const;
const INIT_POOL_IX = { config: 0, creator: 2, baseMint: 3, quoteMint: 4, pool: 5 } as const;
const SWAP_IX = { config: 1, pool: 2, baseMint: 7, quoteMint: 8, payer: 9 } as const;

function compiled(tx: Transaction) {
  const message = tx.compileMessage();
  const signers = message.accountKeys.slice(0, message.header.numRequiredSignatures);
  const writable = (key: PublicKey): boolean => {
    const index = message.accountKeys.findIndex((k) => k.equals(key));
    return index >= 0 && message.isAccountWritable(index);
  };
  return { signers, writable };
}

/** Fee payer, blockhash and the exact set of required signers. */
function assertSignerSet(tx: Transaction, feePayer: PublicKey, expected: PublicKey[]): void {
  if (!tx.feePayer || !tx.feePayer.equals(feePayer)) policy('unexpected fee payer');
  if (!tx.recentBlockhash) policy('missing recent blockhash');
  const { signers } = compiled(tx);
  if (!signers[0] || !signers[0].equals(feePayer)) policy('fee payer must sign first');
  if (signers.length !== expected.length) policy('unexpected number of signers');
  for (const s of signers) {
    if (!expected.some((e) => e.equals(s))) policy('unexpected required signer');
  }
}

function key(ix: TransactionInstruction, index: number): PublicKey {
  const meta = ix.keys[index];
  if (!meta) policy('instruction is missing accounts');
  return meta.pubkey;
}

function assertComputeBudget(ix: TransactionInstruction): void {
  const data = Buffer.from(ix.data);
  if (ix.keys.length !== 0) policy('compute budget instruction with accounts');
  if (data[0] === 2 && data.length === 5) {
    if (data.readUInt32LE(1) > MAX_COMPUTE_UNIT_LIMIT) policy('compute unit limit too high');
    return;
  }
  if (data[0] === 3 && data.length === 9) {
    if (data.readBigUInt64LE(1) > MAX_COMPUTE_UNIT_PRICE) policy('compute unit price too high');
    return;
  }
  policy('compute budget instruction not allowed');
}

function systemType(ix: TransactionInstruction): string {
  try {
    return SystemInstruction.decodeInstructionType(ix);
  } catch {
    policy('undecodable system instruction');
  }
}

// ---------------------------------------------------------------------------------------
// Config creation

export interface CreateConfigExpectation {
  dbcProgramId: PublicKey;
  payer: PublicKey;
  config: PublicKey;
  /** The client wallet: fee claimer and leftover receiver of every FORGE config. */
  owner: PublicKey;
}

export function assertCreateConfigTx(tx: Transaction, expected: CreateConfigExpectation): void {
  assertSignerSet(tx, expected.payer, [expected.payer, expected.config]);
  let creates = 0;
  for (const ix of tx.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      assertComputeBudget(ix);
    } else if (ix.programId.equals(expected.dbcProgramId)) {
      const data = Buffer.from(ix.data);
      if (!data.subarray(0, 8).equals(DBC_DISCRIMINATORS.createConfig)) {
        policy('DBC instruction other than create_config');
      }
      if (!key(ix, CREATE_CONFIG_IX.config).equals(expected.config)) policy('unexpected config');
      if (!key(ix, CREATE_CONFIG_IX.feeClaimer).equals(expected.owner)) {
        policy('fee claimer is not the client wallet');
      }
      if (!key(ix, CREATE_CONFIG_IX.leftoverReceiver).equals(expected.owner)) {
        policy('leftover receiver is not the client wallet');
      }
      if (!key(ix, CREATE_CONFIG_IX.quoteMint).equals(NATIVE_MINT)) policy('quote is not SOL');
      if (!key(ix, CREATE_CONFIG_IX.payer).equals(expected.payer)) policy('unexpected payer');
      creates++;
    } else {
      policy('program not allowed in a config creation');
    }
  }
  if (creates !== 1) policy('exactly one create_config expected');
}

// ---------------------------------------------------------------------------------------
// Nonce account creation

export interface CreateNonceExpectation {
  payer: PublicKey;
  nonceAccount: PublicKey;
  authority: PublicKey;
  rentLamports: bigint;
}

export function assertCreateNonceTx(tx: Transaction, expected: CreateNonceExpectation): void {
  assertSignerSet(tx, expected.payer, [expected.payer, expected.nonceAccount]);
  const steps: string[] = [];
  for (const ix of tx.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      assertComputeBudget(ix);
      continue;
    }
    if (!ix.programId.equals(SystemProgram.programId)) {
      policy('program not allowed in a nonce account creation');
    }
    const type = systemType(ix);
    if (type === 'Create') {
      const p = SystemInstruction.decodeCreateAccount(ix);
      if (!p.fromPubkey.equals(expected.payer)) policy('nonce rent not paid by the payer');
      if (!p.newAccountPubkey.equals(expected.nonceAccount)) policy('unexpected new account');
      if (BigInt(p.lamports) !== expected.rentLamports) policy('nonce rent amount mismatch');
      if (p.space !== NONCE_ACCOUNT_LENGTH) policy('unexpected nonce account size');
      if (!p.programId.equals(SystemProgram.programId)) policy('nonce account not System owned');
      steps.push('create');
    } else if (type === 'InitializeNonceAccount') {
      const p = SystemInstruction.decodeNonceInitialize(ix);
      if (!p.noncePubkey.equals(expected.nonceAccount)) policy('unexpected nonce account');
      if (!p.authorizedPubkey.equals(expected.authority)) policy('unexpected nonce authority');
      steps.push('initialize');
    } else {
      policy('system instruction not allowed in a nonce account creation');
    }
  }
  if (steps.join(',') !== 'create,initialize') policy('expected create then initialize');
}

// ---------------------------------------------------------------------------------------
// Launch transaction (pool creation + the client's first buy)

export interface LaunchExpectation {
  dbcProgramId: PublicKey;
  owner: PublicKey;
  creator: PublicKey;
  mint: PublicKey;
  config: PublicKey;
  pool: PublicKey;
  nonceAccount: PublicKey;
  nonceValue: string;
  /** True when the spec asks for a first buy (then exactly one swap is expected). */
  firstBuy: boolean;
}

function isTokenProgram(id: PublicKey): boolean {
  return id.equals(TOKEN_PROGRAM_ID) || id.equals(TOKEN_2022_PROGRAM_ID);
}

export function assertLaunchCoinTx(tx: Transaction, expected: LaunchExpectation): void {
  const { owner, creator, mint } = expected;
  assertSignerSet(tx, owner, [owner, creator, mint]);
  if (tx.recentBlockhash !== expected.nonceValue) policy('blockhash is not the nonce value');
  const { writable } = compiled(tx);
  if (writable(creator)) policy('the creator wallet must be read-only');

  let inits = 0;
  let swaps = 0;
  tx.instructions.forEach((ix, index) => {
    const data = Buffer.from(ix.data);
    const touchesCreator = ix.keys.some((k) => k.pubkey.equals(creator));
    if (ix.programId.equals(SystemProgram.programId)) {
      const type = systemType(ix);
      if (index === 0) {
        if (type !== 'AdvanceNonceAccount') policy('the nonce advance must come first');
        const p = SystemInstruction.decodeNonceAdvance(ix);
        if (!p.noncePubkey.equals(expected.nonceAccount)) policy('unexpected nonce account');
        if (!p.authorizedPubkey.equals(creator)) policy('nonce authority is not the creator');
        return;
      }
      if (type !== 'Transfer') policy('system instruction not allowed in a launch');
      const t = SystemInstruction.decodeTransfer(ix);
      if (!t.fromPubkey.equals(owner)) policy('transfer not paid by the client');
      if (touchesCreator) policy('transfer touches the creator wallet');
      return;
    }
    if (index === 0) policy('the nonce advance must come first');
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      assertComputeBudget(ix);
      return;
    }
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (!(data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)))) {
        policy('associated token instruction not allowed');
      }
      if (!key(ix, 0).equals(owner)) policy('token account not funded by the client');
      if (!key(ix, 2).equals(owner)) policy('token account not owned by the client');
      if (touchesCreator) policy('token account touches the creator wallet');
      return;
    }
    if (isTokenProgram(ix.programId)) {
      if (touchesCreator) policy('token instruction touches the creator wallet');
      if (data.length === 1 && data[0] === 17) return; // SyncNative
      if (data.length === 1 && data[0] === 9) {
        // CloseAccount(account, destination, authority): only the client's own accounts.
        if (!key(ix, 1).equals(owner) || !key(ix, 2).equals(owner)) {
          policy('token account closed to or by someone else than the client');
        }
        return;
      }
      policy('token instruction not allowed in a launch');
    }
    if (ix.programId.equals(expected.dbcProgramId)) {
      const disc = data.subarray(0, 8);
      if (disc.equals(DBC_DISCRIMINATORS.initializePool)) {
        if (!key(ix, INIT_POOL_IX.config).equals(expected.config)) policy('unexpected config');
        if (!key(ix, INIT_POOL_IX.creator).equals(creator)) policy('unexpected pool creator');
        if (!key(ix, INIT_POOL_IX.baseMint).equals(mint)) policy('unexpected base mint');
        if (!key(ix, INIT_POOL_IX.quoteMint).equals(NATIVE_MINT)) policy('quote is not SOL');
        if (!key(ix, INIT_POOL_IX.pool).equals(expected.pool)) policy('unexpected pool');
        inits++;
        return;
      }
      if (disc.equals(DBC_DISCRIMINATORS.swap)) {
        if (touchesCreator) policy('swap touches the creator wallet');
        if (!key(ix, SWAP_IX.config).equals(expected.config)) policy('swap on another config');
        if (!key(ix, SWAP_IX.pool).equals(expected.pool)) policy('swap on another pool');
        if (!key(ix, SWAP_IX.baseMint).equals(mint)) policy('swap of another mint');
        if (!key(ix, SWAP_IX.quoteMint).equals(NATIVE_MINT)) policy('swap quote is not SOL');
        if (!key(ix, SWAP_IX.payer).equals(owner)) policy('first buy not paid by the client');
        if (inits !== 1) policy('first buy before the pool creation');
        swaps++;
        return;
      }
      policy('DBC instruction not allowed in a launch');
    }
    policy('program not allowed in a launch');
  });
  if (inits !== 1) policy('exactly one pool initialization expected');
  if (swaps !== (expected.firstBuy ? 1 : 0)) policy('unexpected number of first buy swaps');
}

// ---------------------------------------------------------------------------------------
// Launch revocation (advance the launchpad's nonce: a handed-out launch can no longer land)

export interface RevokeNonceExpectation {
  payer: PublicKey;
  nonceAccount: PublicKey;
  /** Nonce authority = the launchpad's creator wallet. */
  authority: PublicKey;
}

export function assertRevokeNonceTx(tx: Transaction, expected: RevokeNonceExpectation): void {
  assertSignerSet(tx, expected.payer, [expected.payer, expected.authority]);
  const { writable } = compiled(tx);
  if (writable(expected.authority)) policy('the creator wallet must be read-only');
  let advances = 0;
  for (const ix of tx.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      assertComputeBudget(ix);
      continue;
    }
    if (!ix.programId.equals(SystemProgram.programId)) {
      policy('program not allowed in a launch revocation');
    }
    if (systemType(ix) !== 'AdvanceNonceAccount') {
      policy('system instruction not allowed in a launch revocation');
    }
    const p = SystemInstruction.decodeNonceAdvance(ix);
    if (!p.noncePubkey.equals(expected.nonceAccount)) policy('unexpected nonce account');
    if (!p.authorizedPubkey.equals(expected.authority)) policy('unexpected nonce authority');
    advances++;
  }
  if (advances !== 1) policy('exactly one nonce advance expected');
}
