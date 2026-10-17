import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  MintLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountInfo,
} from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLUSTER_GENESIS_HASH,
  JUPITER_CLAIM_DISCRIMINATOR,
  JUPITER_CLAIM_V2_DISCRIMINATOR,
  JUPITER_PROJECT_DISCRIMINATOR,
  JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR,
  JUPITER_REFERRAL_PROGRAM_ID,
  JUPITER_ULTRA_REFERRAL_PROJECT,
  buildJupiterCreateAdminTokenAccountIx,
  buildJupiterReferralClaimIx,
  buildJupiterReferralClaimTx,
  deriveJupiterProjectAuthority,
  deriveJupiterReferralAccount,
  deriveJupiterReferralTokenAccount,
  deriveJupiterReferralTokenAccountV2,
  type JupiterClaimAccounts,
  type JupiterReferralClaimVersion,
} from '@forge/core';
import { openKeystore, type Keystore } from '../keystore.js';
import { jupiterClaimsModule, type SignerJobContext } from '../runtime/modules.js';
import {
  DEFAULT_JUPITER_CLAIM_MINTS,
  JUPITER_CLAIM_FEE_BUFFER_LAMPORTS,
  JupiterClaimJournalEntry,
  USDC_MINT,
  assertJupiterReferralClaimTx,
  createJupiterClaimsJob,
  jupiterClaimsConfigFromEnv,
  parseJupiterClaimMints,
  type JupiterClaimBuilder,
  type JupiterClaimConnection,
  type JupiterClaimExpectation,
  type JupiterClaimsConfig,
  type JupiterClaimsDeps,
} from './jupiter-claims.js';
import { PayerReservations } from './reservations.js';
import {
  JobError,
  MEMO_PROGRAM_ID,
  Mutex,
  createMemoryJournal,
  type RetryOptions,
  type SolanaRpc,
} from './shared.js';
import {
  FakeChain,
  FakeClock,
  RecordingAlerter,
  RecordingLogger,
  chainSleep,
  memoryFlags,
  randomAddress,
} from './testing.js';

const FAST = { N: 1 << 14, r: 8, p: 1 };
const PASSPHRASE = 'jupiter claims job test passphrase, long enough for the keystore';
const SOL = 1_000_000_000n;
const MAINNET = CLUSTER_GENESIS_HASH['mainnet-beta'];
const DAY_MS = 24 * 60 * 60_000;

let dir: string;
let keystore: Keystore;
let payer: PublicKey;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-jupiter-claims-'));
  keystore = await openKeystore({ dir, passphrase: PASSPHRASE, scrypt: FAST });
  payer = (await keystore.createKey('payer')).publicKey;
});

afterEach(async () => {
  await keystore.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------
// Account encoders (the referral program's IDL layouts, as the core tests pin them)

/** A named referral account (`Some(name)`), as core requires for a v2 claim. */
function encodeReferralAccount(partner: PublicKey, project: PublicKey, name: string): Buffer {
  const share = Buffer.alloc(2);
  share.writeUInt16LE(8_000);
  const nameBytes = Buffer.from(name, 'utf8');
  const nameLength = Buffer.alloc(4);
  nameLength.writeUInt32LE(nameBytes.length);
  return Buffer.concat([
    JUPITER_REFERRAL_ACCOUNT_DISCRIMINATOR,
    partner.toBuffer(),
    project.toBuffer(),
    share,
    Buffer.from([1]),
    nameLength,
    nameBytes,
  ]);
}

function encodeProject(base: PublicKey, admin: PublicKey): Buffer {
  const name = Buffer.from('jupiter', 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(name.length);
  const share = Buffer.alloc(2);
  share.writeUInt16LE(80);
  return Buffer.concat([JUPITER_PROJECT_DISCRIMINATOR, base.toBuffer(), admin.toBuffer(), len, name, share]);
}

function encodeTokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

function encodeMint(): Buffer {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals: 9,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

// ---------------------------------------------------------------------------------------
// A fake referral program state over the fake chain

interface Scenario {
  v1Amount?: bigint;
  v2Amount?: bigint;
  partnerAtaExists?: boolean;
  adminAtaExists?: boolean;
  /** The referral account's partner (default: the vault). */
  partner?: PublicKey;
  tokenProgram?: PublicKey;
  genesis?: string;
  /** Leave the mint account out (core: `mint_not_found`). */
  noMint?: boolean;
}

interface Fixture {
  chain: FakeChain;
  clock: FakeClock;
  rpc: SolanaRpc;
  /** Every raw transaction the job handed to `sendRawTransaction`, decoded. */
  sent: Transaction[];
  connection: JupiterClaimConnection;
  alerter: RecordingAlerter;
  flags: ReturnType<typeof memoryFlags>;
  journal: ReturnType<typeof createMemoryJournal<JupiterClaimJournalEntry>>;
  logger: RecordingLogger;
  announced: string[];
  lock: Mutex;
  reservations: PayerReservations;
  vault: PublicKey;
  referral: PublicKey;
  mint: PublicKey;
  project: PublicKey;
  admin: PublicKey;
  base: PublicKey;
  tokenProgram: PublicKey;
  state: { v1Amount: bigint; v2Amount: bigint; partnerAta: bigint | null; adminAta: bigint | null };
  config: JupiterClaimsConfig;
  retry: RetryOptions;
  job(extra?: Partial<JupiterClaimsDeps>, config?: Partial<JupiterClaimsConfig>): ReturnType<typeof createJupiterClaimsJob>;
}

function setup(scenario: Scenario = {}, mints?: JupiterClaimsConfig['mints']): Fixture {
  const chain = new FakeChain();
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const sleep = chainSleep(chain, sleeps, clock);
  const retry: RetryOptions = { attempts: 3, baseDelayMs: 10, maxDelayMs: 20, sleep };
  const vault = randomAddress();
  // Core only claims for a referral account of Jupiter's Ultra project, named, at its PDA.
  const project = JUPITER_ULTRA_REFERRAL_PROJECT;
  const referral = deriveJupiterReferralAccount(project, 'forge');
  const mint = scenario.noMint ? randomAddress() : NATIVE_MINT;
  const admin = randomAddress();
  const base = randomAddress();
  const partner = scenario.partner ?? vault;
  const tokenProgram = scenario.tokenProgram ?? TOKEN_PROGRAM_ID;
  const state = {
    v1Amount: scenario.v1Amount ?? 0n,
    v2Amount: scenario.v2Amount ?? 0n,
    partnerAta: scenario.partnerAtaExists ? 0n : null,
    adminAta: scenario.adminAtaExists ? 0n : null,
  };
  const v1 = deriveJupiterReferralTokenAccount(referral, mint);
  const v2 = deriveJupiterReferralTokenAccountV2(referral, mint, tokenProgram);
  const partnerAta = getAssociatedTokenAddressSync(mint, partner, true, tokenProgram);
  const adminAta = getAssociatedTokenAddressSync(mint, admin, true, tokenProgram);
  const owned = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({
    owner,
    data,
    lamports: 1,
    executable: false,
  });
  const info = (k: PublicKey): AccountInfo<Buffer> | null => {
    if (k.equals(referral)) {
      return owned(JUPITER_REFERRAL_PROGRAM_ID, encodeReferralAccount(partner, project, 'forge'));
    }
    if (k.equals(project)) return owned(JUPITER_REFERRAL_PROGRAM_ID, encodeProject(base, admin));
    if (k.equals(mint)) return scenario.noMint ? null : owned(tokenProgram, encodeMint());
    if (k.equals(v1)) {
      return state.v1Amount > 0n ? owned(tokenProgram, encodeTokenAccount(mint, referral, state.v1Amount)) : null;
    }
    if (k.equals(v2)) {
      return state.v2Amount > 0n ? owned(tokenProgram, encodeTokenAccount(mint, referral, state.v2Amount)) : null;
    }
    if (k.equals(partnerAta)) {
      return state.partnerAta === null ? null : owned(tokenProgram, encodeTokenAccount(mint, partner, state.partnerAta));
    }
    if (k.equals(adminAta)) {
      return state.adminAta === null ? null : owned(tokenProgram, encodeTokenAccount(mint, admin, state.adminAta));
    }
    return null;
  };
  const connection = {
    getGenesisHash: async () => scenario.genesis ?? MAINNET,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(info),
    getAccountInfo: async (k: PublicKey) => info(k),
    getLatestBlockhash: async () => chain.getLatestBlockhash(),
  } as unknown as JupiterClaimConnection;
  // What landing does: a claim empties its collection account into the partner's account, a
  // token account creation makes the account exist.
  chain.onInstruction = (ix, _tx, ledger) => {
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const ata = ix.keys[1]!.pubkey;
      ledger.onCommit(() => {
        if (ata.equals(partnerAta)) state.partnerAta ??= 0n;
        if (ata.equals(adminAta)) state.adminAta ??= 0n;
      });
      return;
    }
    if (!ix.programId.equals(JUPITER_REFERRAL_PROGRAM_ID)) return;
    const data = Buffer.from(ix.data);
    if (data.equals(JUPITER_CLAIM_DISCRIMINATOR) || data.equals(JUPITER_CLAIM_V2_DISCRIMINATOR)) {
      const source = ix.keys[5]!.pubkey;
      ledger.onCommit(() => {
        const amount = source.equals(v1) ? state.v1Amount : state.v2Amount;
        if (source.equals(v1)) state.v1Amount = 0n;
        else state.v2Amount = 0n;
        state.partnerAta = (state.partnerAta ?? 0n) + amount;
      });
    } else {
      ledger.onCommit(() => {
        state.adminAta ??= 0n;
      });
    }
  };
  chain.setBalance(payer, SOL);
  const sent: Transaction[] = [];
  const rpc = new Proxy(chain, {
    get(target, prop) {
      if (prop === 'sendRawTransaction') {
        return async (raw: Uint8Array) => {
          sent.push(Transaction.from(Buffer.from(raw)));
          return target.sendRawTransaction(raw);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as SolanaRpc;
  const alerter = new RecordingAlerter();
  const flags = memoryFlags();
  const journal = createMemoryJournal(JupiterClaimJournalEntry);
  const logger = new RecordingLogger();
  const announced: string[] = [];
  const lock = new Mutex();
  const reservations = new PayerReservations();
  const config: JupiterClaimsConfig = {
    referralAccount: referral,
    partner: vault,
    mints: mints ?? [{ mint, minAmount: 1_000_000n }],
    settle: { timeoutMs: 10_000, pollMs: 1_000, rebroadcastMs: 2_000 },
  };
  const job = (extra: Partial<JupiterClaimsDeps> = {}, over: Partial<JupiterClaimsConfig> = {}) =>
    createJupiterClaimsJob({
      connection,
      rpc,
      keystore,
      journal,
      flags,
      alerter,
      logger,
      config: { ...config, ...over },
      retry,
      sleep,
      now: clock.now,
      onBeforeSend: (signature) => void announced.push(signature),
      payerLock: lock,
      payerReservations: reservations,
      ...extra,
    });
  return {
    chain,
    clock,
    rpc,
    sent,
    connection,
    alerter,
    flags,
    journal,
    logger,
    announced,
    lock,
    reservations,
    vault,
    referral,
    mint,
    project,
    admin,
    base,
    tokenProgram,
    state,
    config,
    retry,
    job,
  };
}

const programs = (tx: Transaction) => tx.instructions.map((ix) => ix.programId.toBase58());
const REFERRAL = JUPITER_REFERRAL_PROGRAM_ID.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();

// ---------------------------------------------------------------------------------------
// The job, end to end over the fake chain

describe('createJupiterClaimsJob', () => {
  it('claims both collection accounts of a mint to the vault, journaled before the send', async () => {
    const t = setup({ v1Amount: 5_000_000n, v2Amount: 6_000_000n });
    const report = await t.job().runOnce();
    expect(report.status).toBe('ran');
    expect(report.outcomes).toEqual([
      { mint: t.mint.toBase58(), result: 'claimed', signature: expect.any(String), amount: 11_000_000n },
    ]);
    const signature = (report.outcomes[0] as { signature: string }).signature;
    expect(t.chain.landed.get(signature)?.err).toBeNull();
    expect(t.announced).toEqual([signature]);
    // The payer only paid the network fee; the fees went from the collection accounts to the vault.
    expect(t.chain.balanceOf(payer)).toBe(SOL - 5_000n);
    expect(t.state).toEqual({ v1Amount: 0n, v2Amount: 0n, partnerAta: 11_000_000n, adminAta: 0n });
    // Partner token account creation, admin token account creation, claim, claim_v2: nothing else.
    expect(t.sent).toHaveLength(1);
    expect(programs(t.sent[0]!)).toEqual([ATA, REFERRAL, REFERRAL, REFERRAL]);
    expect(t.sent[0]!.feePayer?.equals(payer)).toBe(true);
    const entry = await t.journal.get(t.mint.toBase58());
    expect(entry).toMatchObject({ inFlight: null, lastError: null, lastClaim: { signature, amount: '11000000' } });
    expect(t.alerter.alerts).toEqual([]);
    // Nothing left: the next run claims nothing and sends nothing.
    const again = await t.job().runOnce();
    expect(again.outcomes).toEqual([{ mint: t.mint.toBase58(), result: 'nothing_to_claim' }]);
    expect(t.sent).toHaveLength(1);
  });

  it('claims one funded collection account with Token-2022 and existing token accounts', async () => {
    const t = setup({
      v2Amount: 2_000_000n,
      partnerAtaExists: true,
      adminAtaExists: true,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    const report = await t.job().runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'claimed', amount: 2_000_000n });
    expect(programs(t.sent[0]!)).toEqual([REFERRAL]);
    expect(Buffer.from(t.sent[0]!.instructions[0]!.data).equals(JUPITER_CLAIM_V2_DISCRIMINATOR)).toBe(true);
    expect(t.state.partnerAta).toBe(2_000_000n);
  });

  it('leaves a total below the mint threshold alone', async () => {
    const t = setup({ v1Amount: 400_000n, v2Amount: 500_000n });
    const report = await t.job().runOnce();
    expect(report.outcomes).toEqual([
      { mint: t.mint.toBase58(), result: 'below_threshold', amount: 900_000n, minAmount: 1_000_000n },
    ]);
    expect(t.sent).toEqual([]);
    expect(await t.journal.get(t.mint.toBase58())).toBeUndefined();
  });

  it('stops when the kill switch is on, missing or unreadable (fail closed), or set locally', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    t.flags.values.jupiter_claims_paused = true;
    expect(await t.job().runOnce()).toEqual({ status: 'paused', reason: 'flag', outcomes: [] });
    delete t.flags.values.jupiter_claims_paused;
    expect(await t.job().runOnce()).toMatchObject({ status: 'paused', reason: 'flag_missing' });
    t.flags.fail = true;
    expect(await t.job().runOnce()).toMatchObject({ status: 'paused', reason: 'flags_unavailable' });
    t.flags.fail = false;
    t.flags.values.jupiter_claims_paused = false;
    expect(await t.job({}, { paused: true }).runOnce()).toMatchObject({ status: 'paused', reason: 'config' });
    expect(t.alerter.codes()).toEqual([
      'jupiter_claims_paused_flag_missing',
      'jupiter_claims_paused_flags_unavailable',
    ]);
    expect(t.sent).toEqual([]);
  });

  it('re-reads the kill switch inside the payer lock and right before signing', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    let reads = 0;
    const read = t.flags.read.bind(t.flags);
    t.flags.read = async () => {
      reads++;
      // Run start, inside the lock, before signing: the switch turns on at the last read.
      if (reads === 3) t.flags.values.jupiter_claims_paused = true;
      return read();
    };
    const report = await t.job().runOnce();
    expect(reads).toBe(3);
    expect(report.outcomes).toEqual([{ mint: t.mint.toBase58(), result: 'skipped', reason: 'paused' }]);
    expect(t.sent).toEqual([]);
    expect(await t.journal.get(t.mint.toBase58())).toBeUndefined();
  });

  it('never builds a second claim while one is in flight, and settles it on a later run', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    const job = t.job();
    t.chain.defaultBehavior = 'drop';
    const first = await job.runOnce();
    expect(first.outcomes[0]).toMatchObject({ result: 'in_flight', state: 'pending' });
    const signature = (first.outcomes[0] as { signature: string }).signature;
    expect((await t.journal.get(t.mint.toBase58()))?.inFlight).toMatchObject({ signature, amount: '5000000' });
    // The journal was written before the first broadcast.
    expect(t.chain.sendAttempts.length).toBeGreaterThan(0);
    expect(new Set(t.chain.sendAttempts)).toEqual(new Set([signature]));

    // The network recovers: the next run rebroadcasts the SAME bytes, never a new transaction.
    t.chain.defaultBehavior = 'land';
    const second = await job.runOnce();
    expect(second.outcomes[0]).toMatchObject({ result: 'in_flight', signature });
    expect(t.chain.landed.has(signature)).toBe(true);
    const third = await job.runOnce();
    expect(third.outcomes[0]).toMatchObject({ result: 'claimed', signature, amount: 5_000_000n });
    expect(new Set(t.chain.sendAttempts)).toEqual(new Set([signature]));
    // Announced once per process, before the first broadcast.
    expect(t.announced).toEqual([signature]);
  });

  it('keeps a rejected claim in flight until it is proven expired, then claims again', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    t.chain.defaultBehavior = 'reject';
    const first = await t.job().runOnce();
    expect(first.status).toBe('ran');
    expect(first.outcomes[0]).toMatchObject({ result: 'failed', error: expect.stringContaining('custom program error') });
    const signature = (first.outcomes[0] as { signature: string }).signature;
    expect(t.alerter.codes()).toEqual(['jupiter_claim_rejected']);
    expect(await t.journal.get(t.mint.toBase58())).toMatchObject({
      inFlight: { signature },
      lastError: expect.stringContaining('custom program error'),
    });
    // Not expired yet: no new transaction is built.
    const second = await t.job().runOnce();
    expect(second.outcomes[0]).toMatchObject({ result: 'in_flight', signature });
    expect(new Set(t.chain.sendAttempts)).toEqual(new Set([signature]));
    // Proven expired: the entry is cleared and a fresh claim is built (and rejected again here).
    t.chain.advance(400);
    const third = await t.job().runOnce();
    expect(third.outcomes[0]).toMatchObject({ result: 'failed' });
    const fresh = (third.outcomes[0] as { signature: string }).signature;
    expect(fresh).not.toBe(signature);
    // First send, the rebroadcast of the same bytes on the second run, the fresh claim.
    expect(t.sent).toHaveLength(3);
    expect(new Set(t.chain.sendAttempts)).toEqual(new Set([signature, fresh]));
    expect((await t.journal.get(t.mint.toBase58()))?.inFlight).toMatchObject({ signature: fresh });
  });

  it('alerts and moves nothing when a claim fails on-chain', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    t.chain.behaviors.push('fail_onchain');
    const report = await t.job().runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'failed', error: expect.stringContaining('InstructionError') });
    expect(t.alerter.codes()).toEqual(['jupiter_claim_failed']);
    expect(t.state.v1Amount).toBe(5_000_000n);
    expect((await t.journal.get(t.mint.toBase58()))?.inFlight).toBeNull();
  });

  it('skips and alerts when the payer cannot pay, counting the routes reservations', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    t.chain.setBalance(payer, JUPITER_CLAIM_FEE_BUFFER_LAMPORTS);
    const low = await t.job().runOnce();
    expect(low.outcomes).toEqual([{ mint: t.mint.toBase58(), result: 'skipped', reason: 'payer_low_balance' }]);
    expect(t.alerter.codes()).toEqual(['jupiter_claim_payer_low_balance']);
    expect(t.sent).toEqual([]);
    // Enough on-chain, but a creation in flight has most of it.
    t.chain.setBalance(payer, SOL);
    t.reservations.reserve('creation', SOL - 10_000n, t.chain.height + 1_000);
    const reserved = await t.job().runOnce();
    expect(reserved.outcomes[0]).toMatchObject({ result: 'skipped', reason: 'payer_low_balance' });
    t.reservations.release('creation');
    expect((await t.job().runOnce()).outcomes[0]).toMatchObject({ result: 'claimed' });
  });

  it('refuses a referral account whose partner is not the vault: immediate alert, nothing signed', async () => {
    const t = setup({ v1Amount: 5_000_000n, partner: randomAddress() });
    const report = await t.job().runOnce();
    expect(report.status).toBe('ran');
    expect(report.outcomes).toEqual([{ mint: t.mint.toBase58(), result: 'failed', error: 'partner_mismatch' }]);
    expect(t.alerter.alerts).toMatchObject([{ level: 'immediate', code: 'jupiter_claim_build_refused' }]);
    expect(t.sent).toEqual([]);
    expect(await t.journal.get(t.mint.toBase58())).toBeUndefined();
  });

  it('refuses to sign a transaction that fails the policy', async () => {
    const t = setup({ v1Amount: 5_000_000n, partnerAtaExists: true, adminAtaExists: true });
    const attacker = randomAddress();
    const builder: JupiterClaimBuilder = async (params) => {
      const built = await buildJupiterReferralClaimTx(params);
      // The claim's partner token account is swapped for the attacker's.
      const claim = built.transaction!.instructions[0]!;
      claim.keys[7]!.pubkey = getAssociatedTokenAddressSync(t.mint, attacker, true);
      return built;
    };
    const report = await t.job({ builder }).runOnce();
    expect(report.status).toBe('error');
    expect(report.outcomes[0]).toMatchObject({ result: 'failed', error: expect.stringContaining('TX_POLICY') });
    expect(t.alerter.codes()).toEqual(['jupiter_claim_policy_violation']);
    expect(t.sent).toEqual([]);
    expect(t.announced).toEqual([]);
    expect(await t.journal.get(t.mint.toBase58())).toBeUndefined();
    expect(t.lock.held).toBe(false);
  });

  it('refuses a summary that does not match the request', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    const builder: JupiterClaimBuilder = async (params) => {
      const built = await buildJupiterReferralClaimTx(params);
      return { ...built, summary: { ...built.summary, partner: randomAddress() } };
    };
    const report = await t.job({ builder }).runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'failed', error: expect.stringContaining('summary') });
    expect(t.alerter.codes()).toEqual(['jupiter_claim_policy_violation']);
    expect(t.sent).toEqual([]);
  });

  it('builds and signs under the payer lock, settles outside it', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    const held: boolean[] = [];
    const builder: JupiterClaimBuilder = async (params) => {
      held.push(t.lock.held);
      return buildJupiterReferralClaimTx(params);
    };
    const report = await t.job({ builder }).runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'claimed' });
    expect(held).toEqual([true]);
    expect(t.lock.held).toBe(false);
  });

  it('handles every configured mint in order and isolates a failure', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    const missing = randomAddress();
    const report = await t.job({}, { mints: [{ mint: missing, minAmount: 1n }, ...t.config.mints] }).runOnce();
    expect(report.status).toBe('ran');
    expect(report.outcomes).toEqual([
      { mint: missing.toBase58(), result: 'failed', error: 'mint_not_found' },
      { mint: t.mint.toBase58(), result: 'claimed', signature: expect.any(String), amount: 5_000_000n },
    ]);
    expect(t.alerter.alerts).toMatchObject([{ level: 'high', code: 'jupiter_claim_build_refused' }]);
  });

  it('reports an RPC failure as an error run with an alert, nothing signed', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    const builder: JupiterClaimBuilder = async () => {
      throw new Error('fetch failed');
    };
    const report = await t.job({ builder }).runOnce();
    expect(report.status).toBe('error');
    expect(t.alerter.codes()).toEqual(['jupiter_claim_run_failed']);
    expect(t.sent).toEqual([]);
  });

  it('does not run without the payer key, and never overlaps itself', async () => {
    const t = setup({ v1Amount: 5_000_000n });
    const empty = await openKeystore({
      dir: await fs.mkdtemp(path.join(os.tmpdir(), 'forge-jupiter-empty-')),
      passphrase: PASSPHRASE,
      scrypt: FAST,
    });
    try {
      const report = await t.job({ keystore: empty }).runOnce();
      expect(report).toEqual({ status: 'error', reason: 'payer_key', outcomes: [] });
      expect(t.alerter.codes()).toEqual(['jupiter_claim_payer_key']);
    } finally {
      await empty.close();
    }
    const job = t.job();
    const [a, b] = await Promise.all([job.runOnce(), job.runOnce()]);
    expect([a.status, b.status].sort()).toEqual(['busy', 'ran']);
  });

  it('requires the payer lock and the announce hook, and distinct accounts', () => {
    const t = setup();
    expect(() => t.job({ payerLock: undefined as unknown as Mutex })).toThrow(/payerLock/);
    expect(() => t.job({ onBeforeSend: undefined as unknown as () => void })).toThrow(/onBeforeSend/);
    expect(() => t.job({}, { partner: t.referral })).toThrow(/must differ/);
    expect(() => t.job({}, { mints: [{ mint: t.vault, minAmount: 1n }] })).toThrow(/referral account or the partner/);
    expect(() => t.job({}, { mints: [] })).toThrow(/no mint/);
    expect(() => t.job({}, { mints: [{ mint: t.mint, minAmount: 0n }] })).toThrow(/positive/);
  });
});

// ---------------------------------------------------------------------------------------
// Wiring (runtime/modules.ts)

describe('jupiterClaimsModule', () => {
  function context(over: Partial<SignerJobContext> = {}): SignerJobContext {
    const t = setup({ v1Amount: 5_000_000n });
    const logger = new RecordingLogger();
    const untouchable = new Proxy(
      {},
      {
        get(_target, name: string) {
          return () => {
            throw new Error(`unexpected RPC call ${name}`);
          };
        },
      },
    );
    return {
      env: {},
      cluster: 'devnet',
      addresses: {
        vault: t.vault,
        cashbox: randomAddress(),
        platformFee: randomAddress(),
        meteoraReferral: randomAddress(),
        jupiterReferral: t.referral,
        revenue: t.vault,
        forgeMint: null,
      },
      connection: untouchable,
      rpc: untouchable,
      keystore,
      flags: t.flags,
      alerter: t.alerter,
      jobLogger: () => logger,
      payerLock: t.lock,
      payerReservations: t.reservations,
      onBeforeSend: () => undefined,
      journalDir: dir,
      ...over,
    } as unknown as SignerJobContext;
  }

  it('is wired off on devnet: one log line, a job that does nothing, no chain access', async () => {
    const ctx = context();
    const job = await jupiterClaimsModule.create(ctx);
    expect(await job.runOnce()).toEqual({ status: 'off' });
    expect(job.delayMs()).toBe(DAY_MS);
    const logger = ctx.jobLogger('jupiter-claims') as RecordingLogger;
    expect(logger.lines).toMatchObject([
      { level: 'info', fields: { cluster: 'devnet' }, msg: expect.stringContaining('off') },
    ]);
  });

  it('is wired on mainnet-beta with the shared payer lock and the kill switch', async () => {
    const ctx = context({
      cluster: 'mainnet-beta',
      env: { SIGNER_JUPITER_CLAIMS_INTERVAL_HOURS: '12' },
    });
    const job = await jupiterClaimsModule.create(ctx);
    expect(job.delayMs()).toBe(12 * 60 * 60_000);
    // Paused by the flag: the run stops before any read (the context's RPC would throw).
    (ctx.flags as ReturnType<typeof memoryFlags>).values.jupiter_claims_paused = true;
    expect(await job.runOnce()).toMatchObject({ status: 'paused', reason: 'flag' });
    const logger = ctx.jobLogger('jupiter-claims') as RecordingLogger;
    expect(logger.lines[0]).toMatchObject({ fields: { mints: 2 }, msg: expect.stringContaining('wired') });
  });

  it('refuses a bad configuration on every cluster', () => {
    for (const cluster of ['devnet', 'mainnet-beta'] as const) {
      expect(() =>
        jupiterClaimsModule.create(context({ cluster, env: { SIGNER_JUPITER_CLAIMS_MINTS: 'nope' } })),
      ).toThrow(/mint address/);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Configuration

describe('parseJupiterClaimMints', () => {
  it('defaults to wrapped SOL and USDC with their thresholds', () => {
    for (const value of [undefined, '', '  ']) {
      const mints = parseJupiterClaimMints(value);
      expect(mints.map((m) => [m.mint.toBase58(), m.minAmount])).toEqual([
        [NATIVE_MINT.toBase58(), 10_000_000n],
        [USDC_MINT.toBase58(), 1_000_000n],
      ]);
    }
    expect(DEFAULT_JUPITER_CLAIM_MINTS[1]!.mint.toBase58()).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
  });

  it('reads a custom list with and without thresholds', () => {
    const other = randomAddress();
    const mints = parseJupiterClaimMints(
      ` ${USDC_MINT.toBase58()}:5000000 , ${other.toBase58()}:1,${NATIVE_MINT.toBase58()} `,
    );
    expect(mints.map((m) => [m.mint.toBase58(), m.minAmount])).toEqual([
      [USDC_MINT.toBase58(), 5_000_000n],
      [other.toBase58(), 1n],
      [NATIVE_MINT.toBase58(), 10_000_000n],
    ]);
  });

  it.each([
    ['a value that is not an address', 'nope', /mint address/],
    ['a non-canonical address', `${NATIVE_MINT.toBase58()}0`, /mint address/],
    ['the all-zero key', PublicKey.default.toBase58(), /mint address/],
    ['a mint listed twice', `${NATIVE_MINT.toBase58()},${NATIVE_MINT.toBase58()}:5`, /twice/],
    ['a custom mint without a threshold', randomAddress().toBase58(), /needs a threshold/],
    ['a zero threshold', `${NATIVE_MINT.toBase58()}:0`, /positive integers/],
    ['a negative threshold', `${NATIVE_MINT.toBase58()}:-5`, /positive integers/],
    ['a decimal threshold', `${NATIVE_MINT.toBase58()}:1.5`, /positive integers/],
    ['too many parts', `${NATIVE_MINT.toBase58()}:1:2`, /entries are/],
    ['only separators', ',,', /lists no mint/],
    [
      'more than 20 mints',
      Array.from({ length: 21 }, () => `${randomAddress().toBase58()}:1`).join(','),
      /more than 20/,
    ],
  ])('refuses %s without echoing the value', (_label, value, rule) => {
    let error: unknown;
    try {
      parseJupiterClaimMints(value);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('CONFIG');
    expect((error as JobError).message).toMatch(rule);
    const first = value.split(',')[0]!.trim();
    if (first !== '') expect((error as JobError).message).not.toContain(first);
  });
});

describe('jupiterClaimsConfigFromEnv', () => {
  const addresses = { partner: randomAddress(), jupiterReferral: randomAddress() };

  it('applies the defaults', () => {
    const { config, intervalMs } = jupiterClaimsConfigFromEnv({}, addresses);
    expect(config.referralAccount.equals(addresses.jupiterReferral)).toBe(true);
    expect(config.partner.equals(addresses.partner)).toBe(true);
    expect(config.mints).toHaveLength(2);
    expect(config.paused).toBe(false);
    expect(intervalMs).toBe(DAY_MS);
  });

  it('reads the interval, the pause and the mints', () => {
    const { config, intervalMs } = jupiterClaimsConfigFromEnv(
      {
        SIGNER_JUPITER_CLAIMS_INTERVAL_HOURS: '6',
        SIGNER_JUPITER_CLAIMS_PAUSED: 'true',
        SIGNER_JUPITER_CLAIMS_MINTS: `${NATIVE_MINT.toBase58()}:1`,
      },
      addresses,
    );
    expect(intervalMs).toBe(6 * 60 * 60_000);
    expect(config.paused).toBe(true);
    expect(config.mints).toEqual([{ mint: NATIVE_MINT, minAmount: 1n }]);
  });

  it('refuses malformed values and colliding addresses', () => {
    expect(() =>
      jupiterClaimsConfigFromEnv({ SIGNER_JUPITER_CLAIMS_INTERVAL_HOURS: '0' }, addresses),
    ).toThrow(/SIGNER_JUPITER_CLAIMS_INTERVAL_HOURS/);
    expect(() =>
      jupiterClaimsConfigFromEnv({ SIGNER_JUPITER_CLAIMS_PAUSED: 'yes' }, addresses),
    ).toThrow(/SIGNER_JUPITER_CLAIMS_PAUSED/);
    expect(() =>
      jupiterClaimsConfigFromEnv({}, { partner: addresses.partner, jupiterReferral: addresses.partner }),
    ).toThrow(/must differ/);
    expect(() =>
      jupiterClaimsConfigFromEnv(
        { SIGNER_JUPITER_CLAIMS_MINTS: `${addresses.partner.toBase58()}:1` },
        addresses,
      ),
    ).toThrow(/referral account or the partner/);
  });
});

// ---------------------------------------------------------------------------------------
// Policy

describe('assertJupiterReferralClaimTx', () => {
  const P = {
    payer: randomAddress(),
    referral: randomAddress(),
    vault: randomAddress(),
    project: randomAddress(),
    admin: randomAddress(),
    base: randomAddress(),
    mint: randomAddress(),
  };
  const attacker = randomAddress();
  const ata = (mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM_ID) =>
    getAssociatedTokenAddressSync(mint, owner, true, program);

  function expectation(over: Partial<JupiterClaimExpectation> = {}): JupiterClaimExpectation {
    return {
      payer: P.payer,
      referralAccount: P.referral,
      partner: P.vault,
      project: P.project,
      admin: P.admin,
      projectAuthority: deriveJupiterProjectAuthority(P.base),
      mint: P.mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      claims: ['v1', 'v2'],
      ...over,
    };
  }
  function accounts(e: JupiterClaimExpectation, version: JupiterReferralClaimVersion): JupiterClaimAccounts {
    return {
      payer: e.payer,
      project: e.project,
      admin: e.admin,
      projectAdminTokenAccount: ata(e.mint, e.admin, e.tokenProgram),
      referralAccount: e.referralAccount,
      referralTokenAccount:
        version === 'v1'
          ? deriveJupiterReferralTokenAccount(e.referralAccount, e.mint)
          : deriveJupiterReferralTokenAccountV2(e.referralAccount, e.mint, e.tokenProgram),
      partner: e.partner,
      partnerTokenAccount: ata(e.mint, e.partner, e.tokenProgram),
      mint: e.mint,
      tokenProgram: e.tokenProgram,
    };
  }
  const claimIx = (e: JupiterClaimExpectation, version: JupiterReferralClaimVersion) =>
    buildJupiterReferralClaimIx(accounts(e, version), version);
  const partnerAtaIx = (e: JupiterClaimExpectation) =>
    createAssociatedTokenAccountIdempotentInstruction(
      e.payer,
      ata(e.mint, e.partner, e.tokenProgram),
      e.partner,
      e.mint,
      e.tokenProgram,
    );
  const adminAtaIx = (e: JupiterClaimExpectation) =>
    createAssociatedTokenAccountIdempotentInstruction(
      e.payer,
      ata(e.mint, e.admin, e.tokenProgram),
      e.admin,
      e.mint,
      e.tokenProgram,
    );
  const adminCreateIx = (e: JupiterClaimExpectation, authority = e.projectAuthority) =>
    buildJupiterCreateAdminTokenAccountIx({
      project: e.project,
      projectAuthority: authority,
      admin: e.admin,
      projectAdminTokenAccount: ata(e.mint, e.admin, e.tokenProgram),
      mint: e.mint,
      tokenProgram: e.tokenProgram,
    });
  function tx(e: JupiterClaimExpectation, ixs: TransactionInstruction[]): Transaction {
    const t = new Transaction();
    if (ixs.length > 0) t.add(...ixs);
    t.feePayer = e.payer;
    t.recentBlockhash = randomAddress().toBase58();
    return t;
  }
  const full = (e: JupiterClaimExpectation) =>
    tx(e, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      partnerAtaIx(e),
      adminCreateIx(e),
      claimIx(e, 'v1'),
      claimIx(e, 'v2'),
    ]);
  function refused(t: Transaction, e: JupiterClaimExpectation): string {
    try {
      assertJupiterReferralClaimTx(t, e);
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).code).toBe('TX_POLICY');
      return (err as JobError).message;
    }
    throw new Error('expected a TX_POLICY refusal');
  }

  it('accepts the shapes core builds', () => {
    const e = expectation();
    expect(() => assertJupiterReferralClaimTx(full(e), e)).not.toThrow();
    // The first claim of a mint: partner and admin token accounts created, both versions.
    expect(() =>
      assertJupiterReferralClaimTx(
        tx(e, [partnerAtaIx(e), adminCreateIx(e), claimIx(e, 'v1'), claimIx(e, 'v2')]),
        e,
      ),
    ).not.toThrow();
    // Later claims: the accounts exist, one funded collection account.
    const v1 = expectation({ claims: ['v1'] });
    expect(() => assertJupiterReferralClaimTx(tx(v1, [claimIx(v1, 'v1')]), v1)).not.toThrow();
    // Token-2022, v2 only, the admin's account created idempotently by the payer.
    const t22 = expectation({ tokenProgram: TOKEN_2022_PROGRAM_ID, claims: ['v2'] });
    expect(() =>
      assertJupiterReferralClaimTx(tx(t22, [adminAtaIx(t22), claimIx(t22, 'v2')]), t22),
    ).not.toThrow();
  });

  it('bounds the priority fee by the cap the claim was priced with', () => {
    // `full`: 200,000 CU at 1,000 micro-lamports = 200 lamports.
    const e = expectation();
    expect(() =>
      assertJupiterReferralClaimTx(full(e), { ...e, maxPriorityFeeLamports: 200n }),
    ).not.toThrow();
    expect(refused(full(e), { ...e, maxPriorityFeeLamports: 199n })).toMatch(
      /priority fee too high/,
    );
    // Priority fees off: an unpriced claim passes, a priced one does not.
    const unpriced = tx(e, [partnerAtaIx(e), adminCreateIx(e), claimIx(e, 'v1'), claimIx(e, 'v2')]);
    expect(() =>
      assertJupiterReferralClaimTx(unpriced, { ...e, maxPriorityFeeLamports: 0n }),
    ).not.toThrow();
    expect(refused(full(e), { ...e, maxPriorityFeeLamports: 0n })).toMatch(/priority fee too high/);
  });

  it('accepts exactly what core builds end to end', async () => {
    const t = setup({ v1Amount: 5_000_000n, v2Amount: 1n });
    const built = await buildJupiterReferralClaimTx({
      connection: t.connection as never,
      referralAccount: t.referral,
      mint: t.mint,
      payer,
      expectedPartner: t.vault,
    });
    const e: JupiterClaimExpectation = {
      payer,
      referralAccount: t.referral,
      partner: t.vault,
      project: t.project,
      admin: t.admin,
      projectAuthority: deriveJupiterProjectAuthority(t.base),
      mint: t.mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      claims: ['v1', 'v2'],
    };
    expect(() => assertJupiterReferralClaimTx(built.transaction!, e)).not.toThrow();
    expect(built.summary.admin.equals(t.admin)).toBe(true);
    expect(built.summary.projectAuthority.equals(e.projectAuthority)).toBe(true);
  });

  const other = randomAddress();
  const otherMint = randomAddress();
  const cases: Array<[string, (e: JupiterClaimExpectation) => Transaction, RegExp]> = [
    [
      'another fee payer',
      (e) => {
        const t = full(e);
        t.feePayer = other;
        return t;
      },
      /unexpected fee payer/,
    ],
    [
      'a missing blockhash',
      (e) => {
        const t = full(e);
        t.recentBlockhash = undefined;
        return t;
      },
      /missing recent blockhash/,
    ],
    [
      'an extra required signer',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.keys[1]!.isSigner = true;
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /unexpected required signer/,
    ],
    ['an empty transaction', (e) => tx(e, []), /empty transaction/],
    [
      'a System transfer',
      (e) =>
        tx(e, [
          claimIx(e, 'v1'),
          claimIx(e, 'v2'),
          SystemProgram.transfer({ fromPubkey: e.payer, toPubkey: attacker, lamports: 1 }),
        ]),
      /program not allowed/,
    ],
    [
      'a memo',
      (e) =>
        tx(e, [
          claimIx(e, 'v1'),
          claimIx(e, 'v2'),
          new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from('x') }),
        ]),
      /program not allowed/,
    ],
    [
      'a compute unit price above the cap',
      (e) =>
        tx(e, [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000_000 }),
          claimIx(e, 'v1'),
          claimIx(e, 'v2'),
        ]),
      /price too high/,
    ],
    [
      'a compute unit limit above the cap',
      (e) =>
        tx(e, [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_500_000 }),
          claimIx(e, 'v1'),
          claimIx(e, 'v2'),
        ]),
      /limit too high/,
    ],
    [
      'a heap frame request',
      (e) =>
        tx(e, [
          ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 }),
          claimIx(e, 'v1'),
          claimIx(e, 'v2'),
        ]),
      /compute budget instruction not allowed/,
    ],
    [
      'three compute budget instructions',
      (e) =>
        tx(e, [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          claimIx(e, 'v1'),
          claimIx(e, 'v2'),
        ]),
      /too many compute budget/,
    ],
    [
      'a token account creation for another owner',
      (e) =>
        tx(e, [
          createAssociatedTokenAccountIdempotentInstruction(e.payer, ata(e.mint, attacker), attacker, e.mint),
          claimIx(e, 'v1'),
          claimIx(e, 'v2'),
        ]),
      /associated token instruction other than/,
    ],
    [
      'a token account creation for another mint',
      (e) =>
        tx(e, [
          createAssociatedTokenAccountIdempotentInstruction(e.payer, ata(otherMint, e.partner), e.partner, otherMint),
          claimIx(e, 'v1'),
          claimIx(e, 'v2'),
        ]),
      /associated token instruction other than/,
    ],
    [
      'a non-idempotent token account creation',
      (e) =>
        tx(e, [
          createAssociatedTokenAccountInstruction(e.payer, ata(e.mint, e.partner), e.partner, e.mint),
          claimIx(e, 'v1'),
          claimIx(e, 'v2'),
        ]),
      /associated token instruction other than/,
    ],
    [
      'a token account creation funded by someone else',
      (e) =>
        tx(e, [
          createAssociatedTokenAccountIdempotentInstruction(other, ata(e.mint, e.partner), e.partner, e.mint),
          claimIx(e, 'v1'),
          claimIx(e, 'v2'),
        ]),
      /unexpected required signer/,
    ],
    [
      'a duplicate partner token account creation',
      (e) => tx(e, [partnerAtaIx(e), partnerAtaIx(e), claimIx(e, 'v1'), claimIx(e, 'v2')]),
      /duplicate partner token account creation/,
    ],
    [
      'a claim to another partner',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.keys[6]!.pubkey = attacker;
        ix.keys[7]!.pubkey = ata(e.mint, attacker);
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /unexpected v1 claim accounts/,
    ],
    [
      'a claim whose partner token account is not the vault associated account',
      (e) => {
        const ix = claimIx(e, 'v2');
        ix.keys[7]!.pubkey = ata(e.mint, attacker);
        return tx(e, [claimIx(e, 'v1'), ix]);
      },
      /unexpected v2 claim accounts/,
    ],
    [
      'a claim of another referral account',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.keys[4]!.pubkey = other;
        ix.keys[5]!.pubkey = deriveJupiterReferralTokenAccount(other, e.mint);
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /unexpected v1 claim accounts/,
    ],
    [
      'a claim of another collection account',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.keys[5]!.pubkey = other;
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /unexpected v1 claim accounts/,
    ],
    [
      'a claim of another mint',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.keys[8]!.pubkey = otherMint;
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /unexpected v1 claim accounts/,
    ],
    [
      'a claim with another admin token account',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.keys[3]!.pubkey = ata(e.mint, attacker);
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /unexpected v1 claim accounts/,
    ],
    [
      'a claim with another admin',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.keys[2]!.pubkey = attacker;
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /unexpected v1 claim accounts/,
    ],
    [
      'a claim with another project',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.keys[1]!.pubkey = other;
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /unexpected v1 claim accounts/,
    ],
    [
      'a claim whose payer is not writable',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.keys[0]!.isWritable = false;
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /unexpected v1 claim accounts/,
    ],
    [
      'a claim whose partner token account is read-only',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.keys[7]!.isWritable = false;
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /unexpected v1 claim accounts/,
    ],
    [
      'claim data with the claim_v2 account order',
      (e) => {
        const ix = claimIx(e, 'v2');
        ix.data = Buffer.from(JUPITER_CLAIM_DISCRIMINATOR);
        return tx(e, [claimIx(e, 'v1'), ix]);
      },
      /duplicate v1 claim|unexpected v1 claim accounts/,
    ],
    [
      'claim data with extra bytes',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.data = Buffer.concat([JUPITER_CLAIM_DISCRIMINATOR, Buffer.from([0])]);
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /referral program instruction other than a claim/,
    ],
    [
      'an unknown referral program instruction',
      (e) => {
        const ix = claimIx(e, 'v1');
        ix.data = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
        return tx(e, [ix, claimIx(e, 'v2')]);
      },
      /referral program instruction other than a claim/,
    ],
    [
      'a claim through another program',
      (e) => {
        const ix = claimIx(e, 'v1');
        return tx(e, [
          new TransactionInstruction({ programId: other, keys: ix.keys, data: ix.data }),
          claimIx(e, 'v2'),
        ]);
      },
      /program not allowed/,
    ],
    [
      'a missing expected claim',
      (e) => tx(e, [claimIx(e, 'v1')]),
      /v2 claim missing/,
    ],
    [
      'an admin token account creation with another authority',
      (e) => tx(e, [adminCreateIx(e, other), claimIx(e, 'v1'), claimIx(e, 'v2')]),
      /unexpected admin token account creation accounts/,
    ],
    [
      'an admin token account created twice',
      (e) => tx(e, [adminCreateIx(e), adminAtaIx(e), claimIx(e, 'v1'), claimIx(e, 'v2')]),
      /duplicate admin token account creation/,
    ],
  ];

  it.each(cases)('refuses %s', (_label, build, rule) => {
    const e = expectation();
    expect(refused(build(e), e)).toMatch(rule);
  });

  it('refuses a duplicate or unexpected claim version', () => {
    const v1 = expectation({ claims: ['v1'] });
    expect(refused(tx(v1, [claimIx(v1, 'v1'), claimIx(v1, 'v1')]), v1)).toMatch(/duplicate v1 claim/);
    expect(refused(tx(v1, [claimIx(v1, 'v1'), claimIx(v1, 'v2')]), v1)).toMatch(/unexpected v2 claim/);
  });

  it('refuses an expectation that cannot be right', () => {
    const e = expectation();
    expect(refused(full(e), expectation({ claims: [] }))).toMatch(/nothing to claim/);
    expect(refused(full(e), expectation({ claims: ['v1', 'v1'] }))).toMatch(/duplicate expected claim/);
    expect(refused(full(e), expectation({ partner: P.payer }))).toMatch(/payer must differ/);
    expect(refused(full(e), expectation({ referralAccount: P.payer }))).toMatch(/payer must differ/);
    expect(refused(full(e), expectation({ partner: P.referral }))).toMatch(/partner equals/);
    expect(refused(full(e), expectation({ tokenProgram: SystemProgram.programId }))).toMatch(
      /not a token program/,
    );
  });

  it('never accepts a transaction built for other inputs', () => {
    const e = expectation();
    const t = full(e);
    expect(refused(t, expectation({ partner: other }))).toMatch(/associated token instruction other than/);
    expect(refused(t, expectation({ mint: otherMint }))).toMatch(/associated token instruction other than/);
    expect(refused(t, expectation({ referralAccount: other }))).toMatch(/unexpected v1 claim accounts/);
    expect(refused(t, expectation({ payer: other }))).toMatch(/unexpected fee payer/);
    expect(refused(t, expectation({ admin: other }))).toMatch(/unexpected admin token account creation/);
    expect(refused(t, expectation({ projectAuthority: other }))).toMatch(/unexpected admin token account creation/);
    expect(refused(t, expectation({ project: other }))).toMatch(/unexpected admin token account creation/);
    expect(refused(t, expectation({ programId: other }))).toMatch(/program not allowed/);
  });
});
