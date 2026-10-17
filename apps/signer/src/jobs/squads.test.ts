import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as multisig from '@sqds/multisig';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkComputeBudgetInstructions } from '@forge/core';
import { openKeystore, type Keystore } from '../keystore.js';
import { createPriorityFees, type PriorityFees } from './priority.js';
import {
  FUNDING_MEMO,
  SDK_SPENDING_LIMIT_USE_DISCRIMINATOR,
  SPENDING_LIMIT_USE_COMPUTE_UNITS,
  SPENDING_LIMIT_USE_DISCRIMINATOR,
  SQUADS_PROGRAM_ID,
  SquadsWithdrawalEntry,
  assertSpendingLimitUseTx,
  buildSpendingLimitUseIx,
  checkSpendingLimit,
  createSquadsSpendingLimitWithdrawer,
  decodeSpendingLimit,
  decodeSpendingLimitUse,
  deriveSquadsVault,
  effectiveRemainingLamports,
  squadsConfigFromEnv,
  type SpendingLimitState,
  type SquadsConfig,
} from './squads.js';
import {
  MEMO_PROGRAM_ID,
  base58Encode,
  createMemoryJournal,
  type RecentSignature,
  type SignatureLookup,
  type SolanaRpc,
} from './shared.js';
import { RecordingLogger, randomAddress } from './testing.js';

const SOL = 1_000_000_000n;
const MULTISIG = randomAddress();
const VAULT = deriveSquadsVault(MULTISIG, 0);
const LIMIT = randomAddress();

function config(): SquadsConfig {
  return {
    multisig: MULTISIG,
    spendingLimit: LIMIT,
    vaultIndex: 0,
    vault: VAULT,
    programId: SQUADS_PROGRAM_ID,
  };
}

/** A serialized `SpendingLimit` account (SDK layout). */
function limitAccount(bot: PublicKey, over: Partial<SpendingLimitState> = {}) {
  const s: SpendingLimitState = {
    multisig: MULTISIG.toBase58(),
    createKey: randomAddress().toBase58(),
    vaultIndex: 0,
    mint: PublicKey.default.toBase58(),
    amount: 1n * SOL,
    period: 1,
    remainingAmount: 1n * SOL,
    lastReset: 1_000_000n,
    members: [bot.toBase58()],
    destinations: [bot.toBase58()],
    ...over,
  };
  const [data] = multisig.accounts.SpendingLimit.fromArgs({
    multisig: new PublicKey(s.multisig),
    createKey: new PublicKey(s.createKey),
    vaultIndex: s.vaultIndex,
    mint: new PublicKey(s.mint),
    amount: Number(s.amount),
    period: s.period,
    remainingAmount: Number(s.remainingAmount),
    lastReset: Number(s.lastReset),
    bump: 255,
    members: s.members.map((m) => new PublicKey(m)),
    destinations: s.destinations.map((d) => new PublicKey(d)),
  }).serialize();
  return { owner: SQUADS_PROGRAM_ID, data, state: s };
}

function clock(unix: bigint): Buffer {
  const data = Buffer.alloc(40);
  data.writeBigInt64LE(unix, 32);
  return data;
}

describe('Squads v4 layout', () => {
  it('derives the vault like the SDK and uses the SDK discriminator', () => {
    const [sdkVault] = multisig.getVaultPda({ multisigPda: MULTISIG, index: 0 });
    expect(VAULT.toBase58()).toBe(sdkVault.toBase58());
    expect(SPENDING_LIMIT_USE_DISCRIMINATOR.equals(SDK_SPENDING_LIMIT_USE_DISCRIMINATOR)).toBe(true);
    expect([...SPENDING_LIMIT_USE_DISCRIMINATOR]).toEqual([16, 57, 130, 127, 193, 20, 155, 134]);
  });

  it('decodes a spending limit account', () => {
    const bot = randomAddress();
    const { owner, data, state } = limitAccount(bot, { remainingAmount: 5n });
    expect(decodeSpendingLimit({ owner, data })).toEqual(state);
    expect(() => decodeSpendingLimit({ owner: randomAddress(), data })).toThrow(/not owned/);
  });

  it('builds, decodes and accepts the SDK instruction and refuses any deviation', () => {
    const bot = randomAddress();
    const lamports = 123_456_789n;
    const ix = buildSpendingLimitUseIx({
      multisig: MULTISIG,
      spendingLimit: LIMIT,
      vaultIndex: 0,
      bot,
      lamports,
    });
    expect(decodeSpendingLimitUse(Buffer.from(ix.data))).toEqual({
      amount: lamports,
      decimals: 9,
      memo: FUNDING_MEMO,
    });
    const expected = {
      programId: SQUADS_PROGRAM_ID,
      multisig: MULTISIG,
      spendingLimit: LIMIT,
      vault: VAULT,
      bot,
      lamports,
    };
    const make = (instructions: TransactionInstruction[], feePayer = bot) => {
      const tx = new Transaction().add(...instructions);
      tx.feePayer = feePayer;
      tx.recentBlockhash = randomAddress().toBase58();
      return tx;
    };
    expect(() => assertSpendingLimitUseTx(make([ix]), expected)).not.toThrow();
    expect(() => assertSpendingLimitUseTx(make([ix]), { ...expected, lamports: lamports + 1n })).toThrow(
      /amount mismatch/,
    );
    expect(() =>
      assertSpendingLimitUseTx(make([ix]), { ...expected, vault: randomAddress() }),
    ).toThrow(/vault/);
    expect(() => assertSpendingLimitUseTx(make([ix], randomAddress()), expected)).toThrow(
      /fee payer/,
    );
    const memo = new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from('x'),
    });
    expect(() => assertSpendingLimitUseTx(make([ix, memo]), expected)).toThrow(
      /exactly one instruction/,
    );
    expect(() => assertSpendingLimitUseTx(make([ix, ix]), expected)).toThrow(
      /exactly one instruction/,
    );
    const elsewhere = new TransactionInstruction({
      programId: ix.programId,
      keys: ix.keys.map((k, i) => (i === 4 ? { ...k, pubkey: randomAddress() } : k)),
      data: ix.data,
    });
    expect(() => assertSpendingLimitUseTx(make([elsewhere]), expected)).toThrow(/destination/);
    const other = new TransactionInstruction({
      programId: ix.programId,
      keys: ix.keys.map((k, i) => (i === 2 ? { ...k, pubkey: randomAddress() } : k)),
      data: ix.data,
    });
    expect(() => assertSpendingLimitUseTx(make([other]), expected)).toThrow(/spending limit/);
  });
});

describe('withdrawal policy with a priority fee', () => {
  const bot = randomAddress();
  const lamports = 50_000_000n;
  const ix = buildSpendingLimitUseIx({
    multisig: MULTISIG,
    spendingLimit: LIMIT,
    vaultIndex: 0,
    bot,
    lamports,
  });
  const expected = {
    programId: SQUADS_PROGRAM_ID,
    multisig: MULTISIG,
    spendingLimit: LIMIT,
    vault: VAULT,
    bot,
    lamports,
  };
  const limit = (units = SPENDING_LIMIT_USE_COMPUTE_UNITS) =>
    ComputeBudgetProgram.setComputeUnitLimit({ units });
  const price = (microLamports = 500_000) =>
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  const make = (instructions: TransactionInstruction[]) => {
    const tx = new Transaction().add(...instructions);
    tx.feePayer = bot;
    tx.recentBlockhash = randomAddress().toBase58();
    return tx;
  };

  it('accepts the use alone or after the compute budget pair, within the cap', () => {
    expect(() => assertSpendingLimitUseTx(make([ix]), expected)).not.toThrow();
    expect(() =>
      assertSpendingLimitUseTx(make([ix]), { ...expected, maxPriorityFeeLamports: 0n }),
    ).not.toThrow();
    // 200,000 CU at 500,000 micro-lamports: 100,000 lamports.
    const priced = make([limit(), price(), ix]);
    expect(() => assertSpendingLimitUseTx(priced, expected)).not.toThrow();
    expect(() =>
      assertSpendingLimitUseTx(priced, { ...expected, maxPriorityFeeLamports: 100_000n }),
    ).not.toThrow();
    expect(() =>
      assertSpendingLimitUseTx(priced, { ...expected, maxPriorityFeeLamports: 99_999n }),
    ).toThrow(/priority fee too high/);
  });

  it.each<[string, () => TransactionInstruction[], RegExp]>([
    [
      'a priority fee above the signer ceiling',
      () => [limit(1_400_000), price(1_000_000), ix],
      /priority fee too high/,
    ],
    ['a price above the cap per CU', () => [limit(1_000), price(1_000_001), ix], /price too high/],
    ['a price alone', () => [price(), ix], /pair expected first/],
    ['a limit alone', () => [limit(), ix], /pair expected first/],
    ['the price before the limit', () => [price(), limit(), ix], /limit expected first/],
    ['the pair after the use', () => [ix, limit(), price()], /pair expected first/],
    ['a duplicated price', () => [limit(), price(), price(), ix], /pair expected first/],
    ['a second use after the pair', () => [limit(), price(), ix, ix], /exactly one instruction/],
    [
      'a memo after the pair',
      () => [
        limit(),
        price(),
        ix,
        new TransactionInstruction({
          programId: MEMO_PROGRAM_ID,
          keys: [],
          data: Buffer.from('x'),
        }),
      ],
      /exactly one instruction/,
    ],
    [
      'the use under another program',
      () => [
        limit(),
        price(),
        new TransactionInstruction({ programId: randomAddress(), keys: ix.keys, data: ix.data }),
      ],
      /program not allowed/,
    ],
    [
      'compute budget bytes under another program',
      () => [
        limit(),
        new TransactionInstruction({ programId: randomAddress(), keys: [], data: price().data }),
        ix,
      ],
      /pair expected first/,
    ],
  ])('refuses %s', (_name, instructions, error) => {
    expect(() => assertSpendingLimitUseTx(make(instructions()), expected)).toThrow(error);
  });
});

describe('squadsConfigFromEnv', () => {
  it('is null without the two addresses and refuses half a configuration', () => {
    expect(squadsConfigFromEnv({}, VAULT)).toBeNull();
    expect(() => squadsConfigFromEnv({ FORGE_SQUADS_MULTISIG: MULTISIG.toBase58() }, VAULT)).toThrow(
      /set together/,
    );
    expect(() => squadsConfigFromEnv({ FORGE_SQUADS_VAULT_INDEX: '1' }, VAULT)).toThrow(/needs/);
  });
  it('requires the vault to derive from the multisig and the index', () => {
    const env = {
      FORGE_SQUADS_MULTISIG: MULTISIG.toBase58(),
      FORGE_SQUADS_SPENDING_LIMIT: LIMIT.toBase58(),
    };
    expect(squadsConfigFromEnv(env, VAULT)).toMatchObject({ vaultIndex: 0 });
    expect(() => squadsConfigFromEnv(env, randomAddress())).toThrow(/do not derive/);
    expect(() => squadsConfigFromEnv({ ...env, FORGE_SQUADS_VAULT_INDEX: '1' }, VAULT)).toThrow(
      /do not derive/,
    );
    expect(() => squadsConfigFromEnv({ ...env, FORGE_SQUADS_MULTISIG: 'nope' }, VAULT)).toThrow(
      /not an address/,
    );
    expect(() =>
      squadsConfigFromEnv({ ...env, FORGE_SQUADS_SPENDING_LIMIT: 'nope' }, VAULT),
    ).toThrow(/FORGE_SQUADS_SPENDING_LIMIT is not an address/);
  });
  it('accepts an explicit index that derives the vault and refuses malformed ones', () => {
    const vault1 = deriveSquadsVault(MULTISIG, 1);
    const env = {
      FORGE_SQUADS_MULTISIG: MULTISIG.toBase58(),
      FORGE_SQUADS_SPENDING_LIMIT: LIMIT.toBase58(),
      FORGE_SQUADS_VAULT_INDEX: '1',
    };
    expect(squadsConfigFromEnv(env, vault1)).toMatchObject({ vaultIndex: 1, vault: vault1 });
    for (const bad of ['256', '-1', '01', 'x']) {
      expect(() =>
        squadsConfigFromEnv({ ...env, FORGE_SQUADS_VAULT_INDEX: bad }, vault1),
      ).toThrow(/between 0 and 255/);
    }
  });
  it('refuses a spending limit equal to the multisig or the vault', () => {
    const env = { FORGE_SQUADS_MULTISIG: MULTISIG.toBase58() };
    expect(() =>
      squadsConfigFromEnv({ ...env, FORGE_SQUADS_SPENDING_LIMIT: MULTISIG.toBase58() }, VAULT),
    ).toThrow(/distinct/);
    expect(() =>
      squadsConfigFromEnv({ ...env, FORGE_SQUADS_SPENDING_LIMIT: VAULT.toBase58() }, VAULT),
    ).toThrow(/distinct/);
  });
  it('never puts a value in a configuration error', () => {
    const secret = MULTISIG.toBase58();
    let message = '';
    try {
      squadsConfigFromEnv({ FORGE_SQUADS_MULTISIG: secret }, VAULT);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/set together/);
    expect(message).not.toContain(secret);
  });
});

describe('spending limit policy', () => {
  const bot = randomAddress();
  const expected = { multisig: MULTISIG, vaultIndex: 0, bot };
  it.each<[Partial<SpendingLimitState>, string | null]>([
    [{}, null],
    [{ multisig: randomAddress().toBase58() }, 'wrong_multisig'],
    [{ vaultIndex: 1 }, 'wrong_vault_index'],
    [{ mint: randomAddress().toBase58() }, 'not_sol'],
    [{ period: 2 }, 'not_daily'],
    [{ members: [randomAddress().toBase58()] }, 'bot_not_member'],
    [{ destinations: [] }, 'destination_not_bot_only'],
    [{ destinations: [bot.toBase58(), randomAddress().toBase58()] }, 'destination_not_bot_only'],
    [{ amount: 0n }, 'zero_amount'],
  ])('checks %o -> %s', (over, refusal) => {
    expect(checkSpendingLimit(limitAccount(bot, over).state, expected)).toBe(refusal);
  });

  it('recomputes the remaining amount from the period like the program', () => {
    const s = limitAccount(bot, { remainingAmount: 3n, lastReset: 1_000n }).state;
    expect(effectiveRemainingLamports(s, 1_000n + 86_400n)).toBe(3n);
    expect(effectiveRemainingLamports(s, 1_000n + 86_401n)).toBe(1n * SOL);
    expect(effectiveRemainingLamports({ ...s, period: 0 }, 10_000_000n)).toBe(3n);
  });
});

// ---------------------------------------------------------------------------------------
// Withdrawer with fakes (no network)

function firstSignature(raw: Uint8Array): string {
  return base58Encode(raw.subarray(1, 65));
}

class FakeRpc implements SolanaRpc {
  height = 1_000;
  readonly sent: Uint8Array[] = [];
  readonly landed = new Set<string>();
  reject: string | null = null;
  onSend: ((signature: string) => void) | null = null;
  async getLatestBlockhash() {
    return { blockhash: base58Encode(randomBytes(32)), lastValidBlockHeight: this.height + 150 };
  }
  async sendRawTransaction(raw: Uint8Array) {
    const sig = firstSignature(raw);
    this.onSend?.(sig);
    if (this.reject) throw new Error(`Transaction simulation failed: ${this.reject}`);
    this.sent.push(raw);
    this.landed.add(sig);
    return sig;
  }
  async getBalance() {
    return 0n;
  }
  async getMinimumBalanceForRentExemption() {
    return 890_880n;
  }
  async getRecentSignatures(): Promise<RecentSignature[]> {
    return [];
  }
  async getBlockHeight() {
    return this.height;
  }
  async getSlot() {
    return this.height;
  }
  async getSignatureState(signature: string): Promise<SignatureLookup> {
    return {
      state: this.landed.has(signature)
        ? { slot: this.height, confirmationStatus: 'confirmed', err: null }
        : null,
      contextSlot: this.height,
    };
  }
  async hasFinalizedTransaction() {
    return false;
  }
}

describe('createSquadsSpendingLimitWithdrawer', () => {
  const FAST = { N: 1 << 14, r: 8, p: 1 };
  let dir: string;
  let keystore: Keystore;
  let bot: PublicKey;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-squads-'));
    keystore = await openKeystore({ dir, passphrase: 'squads withdrawer test passphrase, long', scrypt: FAST });
    bot = (await keystore.createKey('buyback')).publicKey;
  });
  afterEach(async () => {
    await keystore.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function harness(
    over: Partial<SpendingLimitState> = {},
    unix = 1_000_000n + 100n,
    priorityFees?: PriorityFees,
  ) {
    const rpc = new FakeRpc();
    const journal = createMemoryJournal(SquadsWithdrawalEntry);
    const accounts = new Map<string, { owner: PublicKey; data: Buffer }>();
    accounts.set(LIMIT.toBase58(), limitAccount(bot, over));
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), { owner: PublicKey.default, data: clock(unix) });
    const connection = {
      getAccountInfo: vi.fn(async (key: PublicKey) => {
        const a = accounts.get(key.toBase58());
        return a ? { ...a, lamports: 1, executable: false } : null;
      }),
    };
    const withdrawer = createSquadsSpendingLimitWithdrawer({
      config: config(),
      connection,
      rpc,
      keystore,
      journal,
      logger: new RecordingLogger(),
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined },
      sleep: async () => {
        rpc.height += 1;
      },
      settle: { timeoutMs: 10_000, pollMs: 1_000, rebroadcastMs: 3_000 },
      ...(priorityFees ? { priorityFees } : {}),
    });
    return { rpc, journal, withdrawer, accounts };
  }

  it('prices the withdrawal from the recent fees of what it writes, budget first', async () => {
    const reader = {
      getRecentPrioritizationFees: vi.fn(async () => [{ slot: 1, prioritizationFee: 400_000 }]),
    };
    const priorityFees = createPriorityFees(reader);
    const h = harness({}, 1_000_000n + 100n, priorityFees);
    // One signature and the cap: 200,000 CU at 1 lamport per CU, at most 0.0005 SOL.
    expect(h.withdrawer.maxFeeLamports()).toBe(5_000n + 200_000n);
    const r = await h.withdrawer.withdraw({
      lamports: 100_000_000n,
      destination: bot,
      idempotencyKey: 'buyback-funding-2026-10-17',
      onBeforeSend: () => undefined,
    });
    expect(r.status).toBe('confirmed');
    const tx = Transaction.from(h.rpc.sent[0]!);
    expect(tx.instructions.map((ix) => ix.programId.toBase58())).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      SQUADS_PROGRAM_ID.toBase58(),
    ]);
    // 200,000 CU at 400,000 micro-lamports: 80,000 lamports.
    expect(checkComputeBudgetInstructions(tx.instructions)).toEqual({
      computeUnitLimit: SPENDING_LIMIT_USE_COMPUTE_UNITS,
      microLamports: 400_000n,
      priorityFeeLamports: 80_000n,
    });
    expect(decodeSpendingLimitUse(Buffer.from(tx.instructions[2]!.data))?.amount).toBe(
      100_000_000n,
    );
    expect(reader.getRecentPrioritizationFees).toHaveBeenCalledWith({
      lockedWritableAccounts: [bot, LIMIT, VAULT],
    });
  });

  it('costs one signature and sends the use alone without priority fees', async () => {
    const h = harness();
    expect(h.withdrawer.maxFeeLamports()).toBe(5_000n);
    const none = createPriorityFees(null, {
      floorMicroLamports: 0,
      maxMicroLamports: 0,
      percentile: 75,
      maxLamports: 0n,
    });
    const off = harness({}, 1_000_000n + 100n, none);
    expect(off.withdrawer.maxFeeLamports()).toBe(5_000n);
    await off.withdrawer.withdraw({
      lamports: 1n,
      destination: bot,
      idempotencyKey: 'k-off',
      onBeforeSend: () => undefined,
    });
    expect(Transaction.from(off.rpc.sent[0]!).instructions).toHaveLength(1);
  });

  it('withdraws once per key: policy, journal before the send, confirmed, never twice', async () => {
    const h = harness({ remainingAmount: 500_000_000n });
    expect(await h.withdrawer.remainingLamports(bot)).toBe(500_000_000n);
    const announced: string[] = [];
    let journaledAtSend: string | undefined;
    h.rpc.onSend = (sig) => {
      journaledAtSend = sig;
    };
    const r = await h.withdrawer.withdraw({
      lamports: 100_000_000n,
      destination: bot,
      idempotencyKey: 'buyback-funding-2026-10-16',
      onBeforeSend: (sig) => announced.push(sig),
    });
    expect(r.status).toBe('confirmed');
    const sig = (r as { signature: string }).signature;
    expect(announced).toEqual([sig]);
    expect(journaledAtSend).toBe(sig);
    const entry = await h.journal.get('buyback-funding-2026-10-16');
    expect(entry).toMatchObject({ status: 'confirmed', lamports: '100000000', signature: sig });
    // What was sent: one SDK instruction, vault -> bot, exactly the amount, signed by the bot only.
    const tx = Transaction.from(h.rpc.sent[0]!);
    expect(tx.instructions).toHaveLength(1);
    const sent = tx.instructions[0]!;
    expect(sent.programId.equals(SQUADS_PROGRAM_ID)).toBe(true);
    expect(sent.keys.slice(0, 5).map((k) => k.pubkey.toBase58())).toEqual(
      [MULTISIG, bot, LIMIT, VAULT, bot].map((k) => k.toBase58()),
    );
    expect(decodeSpendingLimitUse(Buffer.from(sent.data))).toEqual({
      amount: 100_000_000n,
      decimals: 9,
      memo: FUNDING_MEMO,
    });
    expect(tx.signatures.map((s) => s.publicKey.toBase58())).toEqual([bot.toBase58()]);
    // Same key again: the journaled result, nothing new signed or sent.
    const again = await h.withdrawer.withdraw({
      lamports: 100_000_000n,
      destination: bot,
      idempotencyKey: 'buyback-funding-2026-10-16',
      onBeforeSend: () => undefined,
    });
    expect(again).toEqual({ status: 'confirmed', signature: sig });
    expect(h.rpc.sent).toHaveLength(1);
  });

  it('refuses more than the remaining limit, and the full amount is back after the period', async () => {
    const h = harness({ remainingAmount: 10n, lastReset: 1_000_000n }, 1_000_000n + 100n);
    const r = await h.withdrawer.withdraw({
      lamports: 11n,
      destination: bot,
      idempotencyKey: 'k1',
      onBeforeSend: () => undefined,
    });
    expect(r).toEqual({ status: 'refused', reason: 'amount above the remaining spending limit' });
    expect(h.rpc.sent).toHaveLength(0);
    const later = harness({ remainingAmount: 10n, lastReset: 1_000_000n }, 1_000_000n + 90_000n);
    expect(await later.withdrawer.remainingLamports(bot)).toBe(1n * SOL);
  });

  it('refuses a spending limit that is not bot-only, before anything is signed', async () => {
    const h = harness({ destinations: [] });
    await expect(h.withdrawer.remainingLamports(bot)).rejects.toThrow(/destination_not_bot_only/);
    await expect(
      h.withdrawer.withdraw({ lamports: 1n, destination: bot, idempotencyKey: 'k', onBeforeSend: () => undefined }),
    ).rejects.toThrow(/TX_POLICY/);
    expect(h.rpc.sent).toHaveLength(0);
  });

  it('refuses a destination that is not the buyback wallet', async () => {
    const h = harness();
    await expect(h.withdrawer.remainingLamports(Keypair.generate().publicKey)).rejects.toThrow(
      /not the buyback wallet/,
    );
  });

  it('never sends when the watcher cannot be told first, and reports a preflight rejection', async () => {
    const h = harness();
    const r = await h.withdrawer.withdraw({
      lamports: 1n,
      destination: bot,
      idempotencyKey: 'k2',
      onBeforeSend: () => {
        throw new Error('watcher down');
      },
    });
    expect(r.status).toBe('failed');
    expect(h.rpc.sent).toHaveLength(0);
    expect((await h.journal.get('k2'))?.status).toBe('failed');
    h.rpc.reject = 'custom program error: 0x1773';
    const r2 = await h.withdrawer.withdraw({
      lamports: 1n,
      destination: bot,
      idempotencyKey: 'k3',
      onBeforeSend: () => undefined,
    });
    expect(r2).toMatchObject({ status: 'failed', error: expect.stringContaining('0x1773') });
    expect((await h.journal.get('k3'))?.status).toBe('failed');
  });
});
