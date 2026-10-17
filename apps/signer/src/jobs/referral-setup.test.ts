import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountInfo,
  type Connection,
} from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLUSTER_GENESIS_HASH,
  JUPITER_INITIALIZE_REFERRAL_ACCOUNT_WITH_NAME_DISCRIMINATOR,
  JUPITER_PROJECT_DISCRIMINATOR,
  JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR,
  JUPITER_REFERRAL_ACCOUNT_SIZE,
  JUPITER_REFERRAL_PROGRAM_ID,
  JUPITER_REFERRAL_SETUP_COMPUTE_UNITS,
  JUPITER_ULTRA_REFERRAL_PROJECT,
  METEORA_REFERRAL_ACCOUNT_SEED,
  METEORA_REFERRAL_SETUP_COMPUTE_UNITS,
  buildCreateMeteoraReferralAccountTx,
  buildJupiterReferralSetupTx,
  deriveJupiterReferralAccount,
  deriveJupiterReferralTokenAccountV2,
  deriveMeteoraReferralAccount,
} from '@forge/core';
import { openKeystore, type Keystore } from '../keystore.js';
import { parseSetupRevenueReferralsArgs } from '../runtime/operator.js';
import { USDC_MINT } from './jupiter-claims.js';
import { createPriorityFees } from './priority.js';
import {
  DEFAULT_JUPITER_REFERRAL_NAME,
  ReferralSetupEntry,
  assertJupiterReferralSetupTx,
  assertMeteoraReferralSetupTx,
  runReferralSetup,
  type ReferralSetupDeps,
  type ReferralSetupResult,
} from './referral-setup.js';
import { JobError, createMemoryJournal, isJobError } from './shared.js';
import { FakeChain, FakeClock, RecordingLogger, chainSleep, randomAddress } from './testing.js';

const FAST = { N: 1 << 14, r: 8, p: 1 };
const PASSPHRASE = 'referral setup command test passphrase, long enough for the keystore';
const SOL = 1_000_000_000n;
const MAINNET = CLUSTER_GENESIS_HASH['mainnet-beta'];
const DEVNET = CLUSTER_GENESIS_HASH.devnet;
const ULTRA = JUPITER_ULTRA_REFERRAL_PROJECT;

let dir: string;
let keystore: Keystore;
let payer: PublicKey;
let payerRef: string;
let revenue: PublicKey;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-referral-setup-'));
  keystore = await openKeystore({ dir, passphrase: PASSPHRASE, scrypt: FAST });
  const p = await keystore.createKey('payer');
  payer = p.publicKey;
  payerRef = p.ref;
  revenue = (await keystore.createKey('revenue')).publicKey;
});

afterEach(async () => {
  await keystore.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------
// Account encoders (the layouts core decodes)

function encodeTokenAccount(mint: PublicKey, owner: PublicKey, amount = 0n): Buffer {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: mint.equals(NATIVE_MINT) ? 1 : 0,
      isNative: mint.equals(NATIVE_MINT) ? 2_039_280n : 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

function encodeReferralAccount(
  partner: PublicKey,
  project: PublicKey,
  name: string | null,
): Buffer {
  const share = Buffer.alloc(2);
  share.writeUInt16LE(8_000);
  let nameBytes: Buffer;
  if (name === null) {
    nameBytes = Buffer.from([0]);
  } else {
    const bytes = Buffer.from(name, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    nameBytes = Buffer.concat([Buffer.from([1]), len, bytes]);
  }
  const data = Buffer.concat([
    JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR,
    partner.toBuffer(),
    project.toBuffer(),
    share,
    nameBytes,
  ]);
  return Buffer.concat([data, Buffer.alloc(JUPITER_REFERRAL_ACCOUNT_SIZE - data.length)]);
}

function encodeProject(base: PublicKey, admin: PublicKey): Buffer {
  const name = Buffer.from('jupiter', 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(name.length);
  const share = Buffer.alloc(2);
  share.writeUInt16LE(8_000);
  return Buffer.concat([
    JUPITER_PROJECT_DISCRIMINATOR,
    base.toBuffer(),
    admin.toBuffer(),
    len,
    name,
    share,
  ]);
}

// ---------------------------------------------------------------------------------------
// A chain that holds accounts and applies the setup instructions when a transaction lands

class SetupChain extends FakeChain {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  genesis: string = MAINNET;

  constructor() {
    super({ height: 1_000, finalityLag: 32 });
    this.rentPerByteYear = 3_480n;
    this.onInstruction = (ix, _tx, ledger) => this.apply(ix, ledger);
  }

  set(address: PublicKey, info: AccountInfo<Buffer>): void {
    this.accounts.set(address.toBase58(), info);
  }

  get(address: PublicKey): AccountInfo<Buffer> | null {
    return this.accounts.get(address.toBase58()) ?? null;
  }

  /** The connection the command reads through. */
  get connection(): Connection {
    return {
      getGenesisHash: async () => this.genesis,
      getAccountInfo: async (k: PublicKey) => this.get(k),
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => this.get(k)),
    } as unknown as Connection;
  }

  private apply(
    ix: TransactionInstruction,
    ledger: { debit(a: PublicKey, l: bigint): void; onCommit(fn: () => void): void },
  ): void {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) return;
    if (ix.programId.equals(SystemProgram.programId)) {
      if (SystemInstruction.decodeInstructionType(ix) !== 'CreateWithSeed') {
        throw new Error('unsupported system instruction');
      }
      const p = SystemInstruction.decodeCreateWithSeed(ix);
      if (this.get(p.newAccountPubkey)) throw new Error('account already in use');
      ledger.debit(p.fromPubkey, BigInt(p.lamports));
      ledger.onCommit(() =>
        this.set(p.newAccountPubkey, {
          owner: p.programId,
          data: Buffer.alloc(p.space),
          lamports: p.lamports,
          executable: false,
        }),
      );
      return;
    }
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      const data = Buffer.from(ix.data);
      if (data[0] !== 18) throw new Error('unsupported token instruction');
      const account = ix.keys[0]!.pubkey;
      const mint = ix.keys[1]!.pubkey;
      const owner = new PublicKey(data.subarray(1));
      ledger.onCommit(() => {
        const existing = this.get(account);
        if (!existing) throw new Error('initialize of a missing account');
        this.set(account, { ...existing, data: encodeTokenAccount(mint, owner) });
      });
      return;
    }
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const [funder, ata, owner, mint] = ix.keys.map((k) => k.pubkey);
      if (this.get(ata!)) return; // idempotent
      ledger.debit(funder!, this.rentExempt(ACCOUNT_SIZE));
      ledger.onCommit(() =>
        this.set(ata!, {
          owner: TOKEN_PROGRAM_ID,
          data: encodeTokenAccount(mint!, owner!),
          lamports: Number(this.rentExempt(ACCOUNT_SIZE)),
          executable: false,
        }),
      );
      return;
    }
    if (ix.programId.equals(JUPITER_REFERRAL_PROGRAM_ID)) {
      const data = Buffer.from(ix.data);
      if (
        !data.subarray(0, 8).equals(JUPITER_INITIALIZE_REFERRAL_ACCOUNT_WITH_NAME_DISCRIMINATOR)
      ) {
        throw new Error('unsupported referral instruction');
      }
      const [funder, partner, project, referralAccount] = ix.keys.map((k) => k.pubkey);
      if (!ix.keys[0]!.isSigner) throw new Error('payer must sign');
      if (ix.keys[1]!.isSigner || ix.keys[1]!.isWritable)
        throw new Error('partner is a plain account');
      if (this.get(referralAccount!)) throw new Error('referral account already in use');
      const name = data.subarray(12, 12 + data.readUInt32LE(8)).toString('utf8');
      if (!deriveJupiterReferralAccount(project!, name).equals(referralAccount!)) {
        throw new Error('referral account is not the PDA');
      }
      ledger.debit(funder!, this.rentExempt(JUPITER_REFERRAL_ACCOUNT_SIZE));
      ledger.onCommit(() =>
        this.set(referralAccount!, {
          owner: JUPITER_REFERRAL_PROGRAM_ID,
          data: encodeReferralAccount(partner!, project!, name),
          lamports: Number(this.rentExempt(JUPITER_REFERRAL_ACCOUNT_SIZE)),
          executable: false,
        }),
      );
      return;
    }
    throw new Error(`unexpected program ${ix.programId.toBase58()}`);
  }
}

interface Harness {
  chain: SetupChain;
  clock: FakeClock;
  logger: RecordingLogger;
  lines: string[];
  announced: string[];
  deps: ReferralSetupDeps;
}

function harness(
  options: {
    cluster?: 'devnet' | 'mainnet-beta';
    configured?: Partial<ReferralSetupDeps['configured']>;
    project?: boolean;
    priced?: boolean;
  } = {},
): Harness {
  const chain = new SetupChain();
  const cluster = options.cluster ?? 'mainnet-beta';
  chain.genesis = cluster === 'mainnet-beta' ? MAINNET : DEVNET;
  chain.setBalance(payer, 1n * SOL);
  if (options.project !== false) {
    chain.set(ULTRA, {
      owner: JUPITER_REFERRAL_PROGRAM_ID,
      data: encodeProject(randomAddress(), randomAddress()),
      lamports: 1,
      executable: false,
    });
  }
  for (const mint of [NATIVE_MINT, USDC_MINT]) {
    chain.set(mint, {
      owner: TOKEN_PROGRAM_ID,
      data: Buffer.alloc(82),
      lamports: 1,
      executable: false,
    });
  }
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const lines: string[] = [];
  const announced: string[] = [];
  const deps: ReferralSetupDeps = {
    cluster,
    connection: chain.connection,
    rpc: chain,
    keystore,
    payer: { ref: payerRef, publicKey: payer },
    revenue,
    configured: { meteoraReferral: null, jupiterReferral: null, ...options.configured },
    journal: createMemoryJournal(ReferralSetupEntry),
    onBeforeSend: (signature) => void announced.push(signature),
    logger,
    print: (line) => void lines.push(line),
    priorityFees: options.priced
      ? createPriorityFees(null, {
          floorMicroLamports: 1_000,
          maxMicroLamports: 1_000,
          percentile: 75,
          maxLamports: 500_000n,
        })
      : undefined,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined },
    settle: { timeoutMs: 30_000, pollMs: 2_000, rebroadcastMs: 6_000 },
    sleep: chainSleep(chain, undefined, clock),
    now: () => clock.t,
  };
  return { chain, clock, logger, lines, announced, deps };
}

const meteoraAccount = () => deriveMeteoraReferralAccount(payer, METEORA_REFERRAL_ACCOUNT_SEED);
const jupiterAccount = () => deriveJupiterReferralAccount(ULTRA, DEFAULT_JUPITER_REFERRAL_NAME);
const wsolAta = () =>
  deriveJupiterReferralTokenAccountV2(jupiterAccount(), NATIVE_MINT, TOKEN_PROGRAM_ID);
const usdcAta = () =>
  deriveJupiterReferralTokenAccountV2(jupiterAccount(), USDC_MINT, TOKEN_PROGRAM_ID);

/** Every printed line and log field must be public: no key material, no passphrase, no URL. */
function expectPublicOutput(h: Harness): void {
  const text = [...h.lines, JSON.stringify(h.logger.lines)].join('\n');
  expect(text).not.toMatch(/passphrase|secretKey|PASSPHRASE|https?:\/\//);
  expect(text).not.toContain(PASSPHRASE);
}

async function jobError(promise: Promise<unknown>): Promise<JobError> {
  try {
    await promise;
  } catch (err) {
    if (isJobError(err)) return err;
    throw err;
  }
  throw new Error('expected a JobError');
}

// ---------------------------------------------------------------------------------------

describe('--setup-revenue-referrals: dry run and plan', () => {
  it('plans both accounts on a fresh mainnet without signing or sending, printing the env lines to come', async () => {
    const h = harness();
    const r = await runReferralSetup(h.deps);
    expect(r.dryRun).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.meteora).toMatchObject({ status: 'planned', account: meteoraAccount().toBase58() });
    expect(r.meteora.creates).toEqual([meteoraAccount().toBase58()]);
    expect(r.jupiter).toMatchObject({ status: 'planned', account: jupiterAccount().toBase58() });
    expect(r.jupiter.creates).toEqual(
      [jupiterAccount(), wsolAta(), usdcAta()].map((k) => k.toBase58()),
    );
    expect(r.envLines).toEqual([]);
    expect(h.chain.sendAttempts).toEqual([]);
    expect(h.announced).toEqual([]);
    expect(h.chain.balanceOf(payer)).toBe(1n * SOL);
    expect(
      h.lines.some((l) =>
        l.includes(`FORGE_METEORA_REFERRAL_ACCOUNT=${meteoraAccount().toBase58()}`),
      ),
    ).toBe(true);
    expect(
      h.lines.some((l) =>
        l.includes(`FORGE_JUPITER_REFERRAL_ACCOUNT=${jupiterAccount().toBase58()}`),
      ),
    ).toBe(true);
    expect(h.lines[0]).toContain('dry run');
    // Costs: the rents plus the signature fee (no priority fee here).
    expect(r.meteora.costLamports).toBe(h.chain.rentExempt(ACCOUNT_SIZE) + 5_000n);
    expect(r.jupiter.costLamports).toBe(
      h.chain.rentExempt(JUPITER_REFERRAL_ACCOUNT_SIZE) +
        2n * h.chain.rentExempt(ACCOUNT_SIZE) +
        5_000n,
    );
    expectPublicOutput(h);
  });

  it('refuses a bad name, a bad seed, or a payer equal to the revenue wallet before any read', async () => {
    const h = harness();
    expect((await jobError(runReferralSetup(h.deps, { name: 'a'.repeat(20) }))).code).toBe(
      'CONFIG',
    );
    expect((await jobError(runReferralSetup(h.deps, { name: 'forge app' }))).code).toBe('CONFIG');
    expect((await jobError(runReferralSetup(h.deps, { seed: 'x'.repeat(33) }))).code).toBe(
      'CONFIG',
    );
    expect((await jobError(runReferralSetup({ ...h.deps, revenue: payer }))).code).toBe('CONFIG');
    expect(h.chain.calls).toEqual([]);
  });

  it('parses the command line flags', () => {
    expect(parseSetupRevenueReferralsArgs(['--setup-revenue-referrals'])).toEqual({ send: false });
    expect(parseSetupRevenueReferralsArgs(['--setup-revenue-referrals', '--send'])).toEqual({
      send: true,
    });
    expect(
      parseSetupRevenueReferralsArgs([
        '--setup-revenue-referrals',
        '--name',
        'forge2',
        '--seed',
        'other',
        '--dry-run',
      ]),
    ).toEqual({ send: false, name: 'forge2', seed: 'other' });
    expect(() => parseSetupRevenueReferralsArgs(['--setup-revenue-referrals', '--name'])).toThrow(
      /usage/,
    );
    expect(() =>
      parseSetupRevenueReferralsArgs(['--setup-revenue-referrals', '--name', '--send']),
    ).toThrow(/usage/);
    expect(() => parseSetupRevenueReferralsArgs(['--setup-revenue-referrals', '--bogus'])).toThrow(
      /usage/,
    );
  });
});

describe('--setup-revenue-referrals --send', () => {
  it('creates both accounts with the payer alone, journals and announces before sending, then is idempotent', async () => {
    const h = harness({ priced: true });
    const before = h.chain.balanceOf(payer);
    const r = await runReferralSetup(h.deps, { send: true });
    expect(r.exitCode).toBe(0);
    expect(r.meteora.status).toBe('sent');
    expect(r.jupiter.status).toBe('sent');
    expect(r.envLines).toEqual([
      `FORGE_METEORA_REFERRAL_ACCOUNT=${meteoraAccount().toBase58()}`,
      `FORGE_JUPITER_REFERRAL_ACCOUNT=${jupiterAccount().toBase58()}`,
    ]);
    expect(h.chain.sendAttempts).toHaveLength(2);
    expect(h.announced).toEqual(h.chain.sendAttempts); // announced before each broadcast
    for (const signature of h.chain.sendAttempts) {
      const landed = h.chain.landed.get(signature)!;
      expect(landed.err).toBeNull();
      expect(landed.accounts[0]).toBe(payer.toBase58());
      expect(landed.priorityFeeLamports).toBeGreaterThan(0n);
    }
    // The payer is the only signer of both transactions: the revenue wallet never signs.
    for (const part of ['meteora', 'jupiter'] as const) {
      const raw = Buffer.from((await h.deps.journal.get(part))!.rawTx, 'base64');
      const tx = Transaction.from(raw);
      expect(tx.signatures.map((s) => s.publicKey.toBase58())).toEqual([payer.toBase58()]);
      expect(tx.compileMessage().header.numRequiredSignatures).toBe(1);
    }
    // The revenue wallet is referenced read-only by the Jupiter transaction, not by the Meteora one.
    expect(h.chain.landed.get(h.chain.sendAttempts[0]!)!.accounts).not.toContain(
      revenue.toBase58(),
    );
    expect(h.chain.landed.get(h.chain.sendAttempts[1]!)!.accounts).toContain(revenue.toBase58());
    // The Meteora account: a wrapped-SOL token account owned by the revenue wallet, standalone.
    const meteora = h.chain.get(meteoraAccount())!;
    expect(meteora.owner.equals(TOKEN_PROGRAM_ID)).toBe(true);
    const decoded = AccountLayout.decode(meteora.data);
    expect(new PublicKey(decoded.owner).equals(revenue)).toBe(true);
    expect(new PublicKey(decoded.mint).equals(NATIVE_MINT)).toBe(true);
    expect(meteoraAccount().equals(getAssociatedTokenAddressSync(NATIVE_MINT, revenue))).toBe(
      false,
    );
    // The Jupiter account: named, Ultra project, partner = revenue; both collection accounts.
    expect(h.chain.get(jupiterAccount())!.owner.equals(JUPITER_REFERRAL_PROGRAM_ID)).toBe(true);
    expect(h.chain.get(wsolAta())).not.toBeNull();
    expect(h.chain.get(usdcAta())).not.toBeNull();
    // The payer paid the rents and the fees, nothing else.
    const rents =
      h.chain.rentExempt(ACCOUNT_SIZE) * 3n + h.chain.rentExempt(JUPITER_REFERRAL_ACCOUNT_SIZE);
    const fees = [...h.chain.landed.values()].reduce(
      (a, t) => a + 5_000n + t.priorityFeeLamports,
      0n,
    );
    expect(h.chain.balanceOf(payer)).toBe(before - rents - fees);
    // Journaled as confirmed.
    expect(await h.deps.journal.get('meteora')).toMatchObject({
      status: 'confirmed',
      account: meteoraAccount().toBase58(),
    });
    expect(await h.deps.journal.get('jupiter')).toMatchObject({
      status: 'confirmed',
      account: jupiterAccount().toBase58(),
      creates: [jupiterAccount(), wsolAta(), usdcAta()].map((k) => k.toBase58()),
    });
    expectPublicOutput(h);

    // Second run: everything exists and matches, nothing is sent.
    const again = await runReferralSetup(h.deps, { send: true });
    expect(again.exitCode).toBe(0);
    expect(again.meteora.status).toBe('ready');
    expect(again.jupiter.status).toBe('ready');
    expect(again.envLines).toEqual(r.envLines);
    expect(h.chain.sendAttempts).toHaveLength(2);
  });

  it('creates only what is missing (a collection account) and leaves the rest', async () => {
    const h = harness();
    // The referral account and the WSOL collection account exist; USDC's does not.
    h.chain.set(jupiterAccount(), {
      owner: JUPITER_REFERRAL_PROGRAM_ID,
      data: encodeReferralAccount(revenue, ULTRA, 'forge'),
      lamports: 1,
      executable: false,
    });
    h.chain.set(wsolAta(), {
      owner: TOKEN_PROGRAM_ID,
      data: encodeTokenAccount(NATIVE_MINT, jupiterAccount()),
      lamports: 1,
      executable: false,
    });
    h.chain.set(meteoraAccount(), {
      owner: TOKEN_PROGRAM_ID,
      data: encodeTokenAccount(NATIVE_MINT, revenue),
      lamports: 1,
      executable: false,
    });
    const r = await runReferralSetup(h.deps, { send: true });
    expect(r.meteora.status).toBe('ready');
    expect(r.jupiter).toMatchObject({ status: 'sent', creates: [usdcAta().toBase58()] });
    expect(h.chain.sendAttempts).toHaveLength(1);
    const tx = h.chain.landed.get(h.chain.sendAttempts[0]!)!;
    expect(tx.programs).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()]);
    expect(h.chain.get(usdcAta())).not.toBeNull();
  });

  it('on devnet sets up the Meteora account only; the Jupiter part is refused for the cluster', async () => {
    const h = harness({ cluster: 'devnet', project: false });
    const r = await runReferralSetup(h.deps, { send: true });
    expect(r.exitCode).toBe(0);
    expect(r.meteora.status).toBe('sent');
    expect(r.jupiter).toMatchObject({ status: 'wrong_cluster', account: null, signature: null });
    expect(r.envLines).toEqual([`FORGE_METEORA_REFERRAL_ACCOUNT=${meteoraAccount().toBase58()}`]);
    expect(h.chain.sendAttempts).toHaveLength(1);
    expect(h.lines.some((l) => l.includes('[jupiter]') && l.includes('mainnet-beta'))).toBe(true);
  });

  it('refuses the Jupiter part when the RPC is not on mainnet-beta even if the cluster says so', async () => {
    const h = harness();
    h.chain.genesis = DEVNET;
    await expect(runReferralSetup(h.deps, { send: true })).rejects.toMatchObject({
      code: 'wrong_cluster',
    });
    // The Meteora part went through first (any cluster), the Jupiter part sent nothing.
    expect(h.chain.sendAttempts).toHaveLength(1);
    expect(h.chain.landed.get(h.chain.sendAttempts[0]!)!.programs).toEqual([
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ]);
  });

  it('refuses an unfunded payer before signing anything', async () => {
    const h = harness();
    h.chain.setBalance(payer, 1_000_000n);
    const err = await jobError(runReferralSetup(h.deps, { send: true }));
    expect(err.code).toBe('CONFIG');
    expect(err.message).toMatch(/fund it/);
    expect(h.chain.sendAttempts).toEqual([]);
    expect(await h.deps.journal.get('meteora')).toBeUndefined();
  });

  it('settles a transaction in flight before anything else and never replaces it while it may land', async () => {
    const h = harness();
    // A short wait per run, so the blockhashes are still valid when the second run re-sends.
    h.deps.settle = { timeoutMs: 10_000, pollMs: 2_000, rebroadcastMs: 4_000 };
    h.chain.defaultBehavior = 'drop'; // sent, never lands while the network drops everything
    const first = await runReferralSetup(h.deps, { send: true });
    expect(first.meteora.status).toBe('pending');
    expect(first.jupiter.status).toBe('pending');
    expect(first.exitCode).toBe(3);
    const meteoraEntry = (await h.deps.journal.get('meteora'))!;
    const jupiterEntry = (await h.deps.journal.get('jupiter'))!;
    expect(meteoraEntry.status).toBe('in_flight');
    expect(jupiterEntry.status).toBe('in_flight');
    const signatures = new Set([meteoraEntry.signature, jupiterEntry.signature]);
    expect(h.chain.sendAttempts.length).toBeGreaterThanOrEqual(2); // re-sent, same bytes
    expect(h.chain.sendAttempts.every((s) => signatures.has(s))).toBe(true);
    expect(h.chain.get(meteoraAccount())).toBeNull();
    const attemptsBefore = h.chain.sendAttempts.length;

    // Run again while the network accepts: the SAME signatures are re-sent (same bytes) and
    // land; nothing new is built, and the accounts are then found ready.
    h.chain.defaultBehavior = 'land';
    const second = await runReferralSetup(h.deps, { send: true });
    expect(second.meteora.status).toBe('ready');
    expect(second.jupiter.status).toBe('ready');
    expect(second.exitCode).toBe(0);
    expect(h.chain.sendAttempts.length).toBeGreaterThan(attemptsBefore);
    expect(h.chain.sendAttempts.every((s) => signatures.has(s))).toBe(true);
    expect(h.chain.landed.has(meteoraEntry.signature)).toBe(true);
    expect(h.chain.landed.has(jupiterEntry.signature)).toBe(true);
    expect((await h.deps.journal.get('meteora'))!.status).toBe('confirmed');
    expect((await h.deps.journal.get('jupiter'))!.status).toBe('confirmed');
  });

  it('after an expired attempt, the next run rebuilds once the expiry is proven', async () => {
    const h = harness({ cluster: 'devnet', project: false });
    h.chain.defaultBehavior = 'drop';
    const first = await runReferralSetup(h.deps, { send: true });
    expect(first.meteora.status).toBe('pending');
    const dropped = first.meteora.signature!;
    h.chain.advance(1_000); // past the last valid block height, by a wide margin
    h.chain.defaultBehavior = 'land';
    const second = await runReferralSetup(h.deps, { send: true });
    expect(second.meteora.status).toBe('sent');
    expect(second.meteora.signature).not.toBe(dropped);
    const entry = (await h.deps.journal.get('meteora'))!;
    expect(entry.status).toBe('confirmed');
    expect(entry.history).toEqual([
      expect.objectContaining({ signature: dropped, outcome: 'expired' }),
    ]);
  });

  it('reports an on-chain failure, journals it and sends nothing more for that part', async () => {
    const h = harness({ cluster: 'devnet', project: false });
    h.chain.behaviors.push('fail_onchain');
    const r = await runReferralSetup(h.deps, { send: true });
    expect(r.meteora.status).toBe('failed');
    expect(r.exitCode).toBe(2);
    expect((await h.deps.journal.get('meteora'))!.status).toBe('failed');
    expect(h.chain.get(meteoraAccount())).toBeNull();
  });
});

describe('--setup-revenue-referrals: mismatches (refused, nothing sent)', () => {
  it('refuses a Meteora account held by someone else, the associated account, or a foreign account at the address', async () => {
    const other = randomAddress();
    const h = harness({ cluster: 'devnet', project: false });
    h.chain.set(meteoraAccount(), {
      owner: TOKEN_PROGRAM_ID,
      data: encodeTokenAccount(NATIVE_MINT, other),
      lamports: 1,
      executable: false,
    });
    const r = await runReferralSetup(h.deps, { send: true });
    expect(r.meteora).toMatchObject({ status: 'mismatch' });
    expect(r.meteora.problems[0]).toContain('wrong_owner');
    expect(r.exitCode).toBe(2);
    expect(h.chain.sendAttempts).toEqual([]);

    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, revenue);
    const h2 = harness({ cluster: 'devnet', project: false, configured: { meteoraReferral: ata } });
    h2.chain.set(ata, {
      owner: TOKEN_PROGRAM_ID,
      data: encodeTokenAccount(NATIVE_MINT, revenue),
      lamports: 1,
      executable: false,
    });
    const r2 = await runReferralSetup(h2.deps, { send: true });
    expect(r2.meteora.status).toBe('mismatch');
    expect(r2.meteora.problems[0]).toContain('associated_account');
    expect(h2.chain.sendAttempts).toEqual([]);

    const h3 = harness({ cluster: 'devnet', project: false });
    h3.chain.set(meteoraAccount(), {
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      lamports: 10_000,
      executable: false,
    });
    const r3 = await runReferralSetup(h3.deps, { send: true });
    expect(r3.meteora.problems[0]).toContain('not_a_token_account');
    expect(r3.meteora.problems[1]).toContain('--seed');
    expect(h3.chain.sendAttempts).toEqual([]);
  });

  it('accepts a configured Meteora account created by other means when it matches, and refuses an empty configured address', async () => {
    const standalone = randomAddress();
    const h = harness({
      cluster: 'devnet',
      project: false,
      configured: { meteoraReferral: standalone },
    });
    h.chain.set(standalone, {
      owner: TOKEN_PROGRAM_ID,
      data: encodeTokenAccount(NATIVE_MINT, revenue),
      lamports: 1,
      executable: false,
    });
    const r = await runReferralSetup(h.deps, { send: true });
    expect(r.meteora).toMatchObject({ status: 'ready', account: standalone.toBase58() });
    expect(r.envLines).toEqual([`FORGE_METEORA_REFERRAL_ACCOUNT=${standalone.toBase58()}`]);
    expect(h.chain.sendAttempts).toEqual([]);

    const h2 = harness({
      cluster: 'devnet',
      project: false,
      configured: { meteoraReferral: randomAddress() },
    });
    const r2 = await runReferralSetup(h2.deps, { send: true });
    expect(r2.meteora.status).toBe('mismatch');
    expect(r2.meteora.problems[0]).toMatch(/holds no account/);
    expect(h2.chain.sendAttempts).toEqual([]);
  });

  it('refuses a Jupiter referral account with another partner, another project, no name, or a foreign collection account', async () => {
    const cases: Array<[Buffer, string]> = [
      [encodeReferralAccount(randomAddress(), ULTRA, 'forge'), 'partner_mismatch'],
      [encodeReferralAccount(revenue, randomAddress(), 'forge'), 'project_mismatch'],
      [encodeReferralAccount(revenue, ULTRA, null), 'name_mismatch'],
    ];
    for (const [data, reason] of cases) {
      const h = harness();
      h.chain.set(jupiterAccount(), {
        owner: JUPITER_REFERRAL_PROGRAM_ID,
        data,
        lamports: 1,
        executable: false,
      });
      const r = await runReferralSetup(h.deps, { send: true });
      expect(r.jupiter.status).toBe('mismatch');
      expect(r.jupiter.problems[0]).toContain(reason);
      expect(r.exitCode).toBe(2);
      // The Meteora part is independent and went through.
      expect(h.chain.sendAttempts).toHaveLength(1);
      expect(h.chain.get(jupiterAccount())!.data.equals(data)).toBe(true);
    }
    const h = harness();
    h.chain.set(usdcAta(), {
      owner: TOKEN_PROGRAM_ID,
      data: encodeTokenAccount(USDC_MINT, randomAddress()),
      lamports: 1,
      executable: false,
    });
    const r = await runReferralSetup(h.deps, { send: true });
    expect(r.jupiter.status).toBe('mismatch');
    expect(r.jupiter.problems[0]).toContain('wrong_owner');
    expect(h.chain.get(jupiterAccount())).toBeNull();
  });

  it('refuses a configured Jupiter account that is not the PDA of the name, telling the operator what it is', async () => {
    const otherName = deriveJupiterReferralAccount(ULTRA, 'other');
    const h = harness({ configured: { jupiterReferral: otherName } });
    h.chain.set(otherName, {
      owner: JUPITER_REFERRAL_PROGRAM_ID,
      data: encodeReferralAccount(revenue, ULTRA, 'other'),
      lamports: 1,
      executable: false,
    });
    const r = await runReferralSetup(h.deps, { send: true });
    expect(r.jupiter.status).toBe('mismatch');
    expect(r.jupiter.problems[0]).toContain('name "other"');
    expect(r.jupiter.problems[1]).toContain('--name');
    expect(h.chain.get(jupiterAccount())).toBeNull();
    // With the right name, the configured account is used as it is: only its missing collection
    // accounts are created.
    const ok = await runReferralSetup(h.deps, { send: true, name: 'other' });
    expect(ok.jupiter).toMatchObject({
      status: 'sent',
      account: otherName.toBase58(),
      creates: [
        deriveJupiterReferralTokenAccountV2(otherName, NATIVE_MINT, TOKEN_PROGRAM_ID).toBase58(),
        deriveJupiterReferralTokenAccountV2(otherName, USDC_MINT, TOKEN_PROGRAM_ID).toBase58(),
      ],
    });
    expect(
      h.chain.get(otherName)!.data.equals(encodeReferralAccount(revenue, ULTRA, 'other')),
    ).toBe(true);
    expect(ok.envLines).toContain(`FORGE_JUPITER_REFERRAL_ACCOUNT=${otherName.toBase58()}`);
  });

  it('fails closed when the Ultra project is not on the chain the RPC serves', async () => {
    const h = harness({ project: false });
    await expect(runReferralSetup(h.deps)).rejects.toMatchObject({ code: 'project_not_found' });
  });
});

describe('policies', () => {
  const BLOCKHASH = Keypair.generate().publicKey.toBase58();
  const RENT = 2_039_280n;

  function meteoraTx(priced = false) {
    return buildCreateMeteoraReferralAccountTx({
      payer,
      owner: revenue,
      rentLamports: RENT,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 10,
      priorityFee: priced
        ? { computeUnitLimit: METEORA_REFERRAL_SETUP_COMPUTE_UNITS, microLamports: 100 }
        : undefined,
    }).transaction;
  }
  const meteoraExpectation = () => ({
    payer,
    owner: revenue,
    account: meteoraAccount(),
    seed: METEORA_REFERRAL_ACCOUNT_SEED,
    rentLamports: RENT,
  });
  const rule = (fn: () => void): string => {
    try {
      fn();
    } catch (err) {
      if (isJobError(err, 'TX_POLICY')) return err.detail ?? '';
      throw err;
    }
    return 'accepted';
  };

  it('accepts what core builds for the Meteora account, with or without the compute budget pair', () => {
    expect(rule(() => assertMeteoraReferralSetupTx(meteoraTx(), meteoraExpectation()))).toBe(
      'accepted',
    );
    expect(rule(() => assertMeteoraReferralSetupTx(meteoraTx(true), meteoraExpectation()))).toBe(
      'accepted',
    );
  });

  it('refuses any deviation of the Meteora setup: fee payer, signers, rent, owner, seed, size, program, extra instructions', () => {
    const e = meteoraExpectation();
    expect(
      rule(() => assertMeteoraReferralSetupTx(meteoraTx(), { ...e, rentLamports: RENT + 1n })),
    ).toBe('rent amount mismatch');
    expect(
      rule(() => assertMeteoraReferralSetupTx(meteoraTx(), { ...e, owner: randomAddress() })),
    ).toMatch(/derived|owner/);
    expect(rule(() => assertMeteoraReferralSetupTx(meteoraTx(), { ...e, seed: 'other' }))).toMatch(
      /derived address|seed/,
    );
    expect(rule(() => assertMeteoraReferralSetupTx(meteoraTx(), { ...e, owner: payer }))).toBe(
      'the owner must not be the payer',
    );
    const feePayer = meteoraTx();
    feePayer.feePayer = revenue;
    expect(rule(() => assertMeteoraReferralSetupTx(feePayer, e))).toBe('unexpected fee payer');
    const extraSigner = meteoraTx();
    extraSigner.instructions[1]!.keys.push({ pubkey: revenue, isSigner: true, isWritable: false });
    expect(rule(() => assertMeteoraReferralSetupTx(extraSigner, e))).toBe(
      'the payer must be the only required signer',
    );
    const extra = meteoraTx();
    extra.add(
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: randomAddress(), lamports: 1 }),
    );
    expect(rule(() => assertMeteoraReferralSetupTx(extra, e))).toBe(
      'expected createAccountWithSeed then InitializeAccount3',
    );
    const swapped = meteoraTx();
    swapped.instructions.reverse();
    expect(rule(() => assertMeteoraReferralSetupTx(swapped, e))).toBe(
      'first instruction is not System',
    );
    const wrongOwner = meteoraTx();
    wrongOwner.instructions[1]!.data = Buffer.concat([
      Buffer.from([18]),
      randomAddress().toBuffer(),
    ]);
    expect(rule(() => assertMeteoraReferralSetupTx(wrongOwner, e))).toBe(
      'token account owner mismatch',
    );
    const wrongMint = meteoraTx();
    wrongMint.instructions[1]!.keys[1]!.pubkey = USDC_MINT;
    expect(rule(() => assertMeteoraReferralSetupTx(wrongMint, e))).toBe(
      'token account mint is not wrapped SOL',
    );
    const bigRent = meteoraTx();
    bigRent.instructions[0] = SystemProgram.createAccountWithSeed({
      fromPubkey: payer,
      basePubkey: payer,
      seed: METEORA_REFERRAL_ACCOUNT_SEED,
      newAccountPubkey: meteoraAccount(),
      lamports: Number(RENT) * 10,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    });
    expect(rule(() => assertMeteoraReferralSetupTx(bigRent, e))).toBe('rent amount mismatch');
    const wrongProgram = meteoraTx();
    wrongProgram.instructions[0] = SystemProgram.createAccountWithSeed({
      fromPubkey: payer,
      basePubkey: payer,
      seed: METEORA_REFERRAL_ACCOUNT_SEED,
      newAccountPubkey: meteoraAccount(),
      lamports: Number(RENT),
      space: ACCOUNT_SIZE,
      programId: SystemProgram.programId,
    });
    expect(rule(() => assertMeteoraReferralSetupTx(wrongProgram, e))).toBe(
      'account not owned by the SPL Token program',
    );
    const priceOnly = meteoraTx();
    priceOnly.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
    expect(rule(() => assertMeteoraReferralSetupTx(priceOnly, e))).toMatch(/compute budget/);
    const tooHigh = meteoraTx();
    tooHigh.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: METEORA_REFERRAL_SETUP_COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
    );
    expect(
      rule(() => assertMeteoraReferralSetupTx(tooHigh, { ...e, maxPriorityFeeLamports: 1_000n })),
    ).toMatch(/priority fee/);
  });

  function jupiterTx(
    options: { createReferralAccount?: boolean; mints?: PublicKey[]; priced?: boolean } = {},
  ) {
    const mints = options.mints ?? [NATIVE_MINT, USDC_MINT];
    return buildJupiterReferralSetupTx({
      payer,
      partner: revenue,
      name: 'forge',
      createReferralAccount: options.createReferralAccount ?? true,
      tokenAccounts: mints.map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ID })),
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 10,
      priorityFee: options.priced
        ? { computeUnitLimit: JUPITER_REFERRAL_SETUP_COMPUTE_UNITS, microLamports: 100 }
        : undefined,
    });
  }
  const jupiterExpectation = (
    built: ReturnType<typeof jupiterTx>,
    createReferralAccount = true,
  ) => ({
    payer,
    partner: revenue,
    project: ULTRA,
    name: 'forge',
    referralAccount: built.referralAccount,
    createReferralAccount,
    tokenAccounts: built.tokenAccounts,
  });

  it('accepts what core builds for the Jupiter account, in every shape', () => {
    const full = jupiterTx();
    expect(
      rule(() => assertJupiterReferralSetupTx(full.transaction, jupiterExpectation(full))),
    ).toBe('accepted');
    const priced = jupiterTx({ priced: true });
    expect(
      rule(() => assertJupiterReferralSetupTx(priced.transaction, jupiterExpectation(priced))),
    ).toBe('accepted');
    const atasOnly = jupiterTx({ createReferralAccount: false, mints: [USDC_MINT] });
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(atasOnly.transaction, jupiterExpectation(atasOnly, false)),
      ),
    ).toBe('accepted');
    const accountOnly = jupiterTx({ mints: [] });
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(accountOnly.transaction, jupiterExpectation(accountOnly)),
      ),
    ).toBe('accepted');
  });

  it('refuses any deviation of the Jupiter setup: partner, project, name, signers, extra or missing instructions, foreign programs', () => {
    const built = jupiterTx();
    const e = jupiterExpectation(built);
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(built.transaction, { ...e, partner: randomAddress() }),
      ),
    ).toBe('referral account initialization mismatch');
    expect(
      rule(() => assertJupiterReferralSetupTx(built.transaction, { ...e, name: 'other' })),
    ).toBe('referral account is not the PDA of the name');
    expect(
      rule(() => assertJupiterReferralSetupTx(built.transaction, { ...e, name: 'a'.repeat(40) })),
    ).toBe('referral account name is not a valid seed');
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(built.transaction, { ...e, referralAccount: randomAddress() }),
      ),
    ).toBe('referral account is not the PDA of the name');
    expect(
      rule(() => assertJupiterReferralSetupTx(built.transaction, { ...e, partner: payer })),
    ).toBe('the partner must not be the payer');
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(built.transaction, { ...e, createReferralAccount: false }),
      ),
    ).toBe('unexpected number of instructions');
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(built.transaction, {
          ...e,
          tokenAccounts: [built.tokenAccounts[0]!],
        }),
      ),
    ).toBe('unexpected number of instructions');
    const partnerSigns = jupiterTx();
    partnerSigns.transaction.instructions[0]!.keys[1]!.isSigner = true;
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(partnerSigns.transaction, jupiterExpectation(partnerSigns)),
      ),
    ).toBe('the payer must be the only required signer');
    const partnerWritable = jupiterTx();
    partnerWritable.transaction.instructions[0]!.keys[1]!.isWritable = true;
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(
          partnerWritable.transaction,
          jupiterExpectation(partnerWritable),
        ),
      ),
    ).toBe('the partner must be read-only');
    const otherFunder = jupiterTx();
    otherFunder.transaction.instructions[1]!.keys[0]!.pubkey = revenue;
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(otherFunder.transaction, jupiterExpectation(otherFunder)),
      ),
    ).toBe('the payer must be the only required signer');
    const otherOwner = jupiterTx();
    otherOwner.transaction.instructions[2]!.keys[2]!.pubkey = randomAddress();
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(otherOwner.transaction, jupiterExpectation(otherOwner)),
      ),
    ).toBe('collection account creation mismatch');
    const extra = jupiterTx();
    extra.transaction.add(
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: randomAddress(), lamports: 1 }),
    );
    expect(
      rule(() => assertJupiterReferralSetupTx(extra.transaction, jupiterExpectation(extra))),
    ).toBe('unexpected number of instructions');
    const swapped = jupiterTx();
    swapped.transaction.instructions.reverse();
    expect(
      rule(() => assertJupiterReferralSetupTx(swapped.transaction, jupiterExpectation(swapped))),
    ).toBe('referral account initialization mismatch');
    const otherData = jupiterTx();
    otherData.transaction.instructions[0]!.data = Buffer.concat([
      Buffer.from(JUPITER_INITIALIZE_REFERRAL_ACCOUNT_WITH_NAME_DISCRIMINATOR),
      Buffer.from([5, 0, 0, 0]),
      Buffer.from('other'),
    ]);
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(otherData.transaction, jupiterExpectation(otherData)),
      ),
    ).toBe('referral account initialization mismatch');
    const otherProgram = jupiterTx();
    otherProgram.transaction.instructions[0] = new TransactionInstruction({
      programId: randomAddress(),
      keys: otherProgram.transaction.instructions[0]!.keys,
      data: otherProgram.transaction.instructions[0]!.data,
    });
    expect(
      rule(() =>
        assertJupiterReferralSetupTx(otherProgram.transaction, jupiterExpectation(otherProgram)),
      ),
    ).toBe('referral account initialization mismatch');
    const noBlockhash = new Transaction({
      feePayer: payer,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 10,
    });
    noBlockhash.recentBlockhash = undefined;
    noBlockhash.add(...built.transaction.instructions);
    expect(rule(() => assertJupiterReferralSetupTx(noBlockhash, e))).toBe(
      'missing recent blockhash',
    );
  });
});

describe('result shape', () => {
  it('exposes only public fields', async () => {
    const h = harness();
    const r: ReferralSetupResult = await runReferralSetup(h.deps);
    const json = JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(json).not.toContain(PASSPHRASE);
    expect(r.payer).toBe(payer.toBase58());
    expect(r.revenue).toBe(revenue.toBase58());
  });
});
