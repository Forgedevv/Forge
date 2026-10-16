import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimError } from '@forge/core';
import { creatorRole, openKeystore, type Keystore } from '../keystore.js';
import {
  ClaimJournalEntry,
  claimsConfigFromEnv,
  createClaimsJob,
  createPostgrestClaimsStore,
  type ClaimsConfig,
  type ClaimsDeps,
} from './claims.js';
import { PayerReservations } from './reservations.js';
import {
  Mutex,
  createMemoryJournal,
  createPostgrestClient,
  silentJobLogger,
  type RetryOptions,
} from './shared.js';
import {
  FakeChain,
  FakeClock,
  FakeDbc,
  MemoryClaimsStore,
  RecordingAlerter,
  TransientRpcError,
  chainSleep,
  memoryFlags,
  randomAddress,
  uuid,
} from './testing.js';

const FAST = { N: 1 << 14, r: 8, p: 1 };
const PASSPHRASE = 'claims job test passphrase, long enough for the keystore';
const SOL = 1_000_000_000n;
const MIN = 10_000_000n;

let dir: string;
let keystore: Keystore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-claims-'));
  keystore = await openKeystore({ dir, passphrase: PASSPHRASE, scrypt: FAST });
});

afterEach(async () => {
  await keystore.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function setup(
  options: { claimable?: bigint; config?: Partial<ClaimsConfig>; deps?: Partial<ClaimsDeps> } = {},
) {
  const chain = new FakeChain();
  const dbc = new FakeDbc(chain);
  const core = dbc.core();
  const store = new MemoryClaimsStore();
  const journal = createMemoryJournal(ClaimJournalEntry);
  const alerter = new RecordingAlerter();
  const flags = memoryFlags();
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const sleep = chainSleep(chain, sleeps, clock);
  const retry: RetryOptions = { attempts: 4, baseDelayMs: 500, maxDelayMs: 8_000, sleep };
  const vault = randomAddress();
  const payer = await keystore.createKey('payer');
  chain.setBalance(payer.publicKey, SOL);
  chain.setBalance(vault, SOL);

  const launchpadId = uuid();
  const creator = await keystore.createKey(creatorRole(launchpadId));
  chain.setBalance(creator.publicKey, 10_000_000n);
  const coinConfig = randomAddress();
  const coinMint = randomAddress();
  const pool = dbc.addPool({
    config: coinConfig,
    baseMint: coinMint,
    creator: creator.publicKey,
    claimableQuote: options.claimable ?? 50_000_000n,
    graduated: false,
  });
  store.launchpads.push({
    id: launchpadId,
    status: 'live',
    coinConfig: coinConfig.toBase58(),
    coinMint: coinMint.toBase58(),
    creatorWalletRef: creator.ref,
  });

  const job = (extra: Partial<ClaimsDeps> = {}) =>
    createClaimsJob({
      store,
      core,
      rpc: chain,
      keystore,
      journal,
      flags,
      alerter,
      logger: silentJobLogger,
      config: {
        vault,
        minClaimLamports: MIN,
        minPositionClaimLamports: MIN,
        feePayer: 'payer',
        ...options.config,
      },
      retry,
      onBeforeSend: () => undefined,
      sleep,
      now: clock.now,
      ...options.deps,
      ...extra,
    });
  const poolState = () => dbc.pools.get(pool.toBase58())!;
  return {
    chain,
    dbc,
    core,
    store,
    journal,
    alerter,
    flags,
    clock,
    sleeps,
    vault,
    payer,
    creator,
    launchpadId,
    pool,
    poolState,
    job,
  };
}

describe('claims: creator share to the multisig vault', () => {
  it('claims the creator share to the vault, signed by the creator and the payer wallet', async () => {
    const t = await setup();
    const signSpy = vi.spyOn(keystore, 'withSigner');
    const report = await t.job().runOnce();

    expect(report.status).toBe('ran');
    expect(report.outcomes).toEqual([
      expect.objectContaining({
        result: 'claimed',
        lamports: 50_000_000n,
        pool: t.pool.toBase58(),
      }),
    ]);
    expect(t.chain.balanceOf(t.vault)).toBe(SOL + 50_000_000n);
    expect(t.poolState().claimableQuote).toBe(0n);
    expect(signSpy.mock.calls.map((c) => c[0]).sort()).toEqual([t.creator.ref, t.payer.ref].sort());
    // Two signatures: the payer wallet paid 10 000 lamports of fees.
    expect(t.chain.balanceOf(t.payer.publicKey)).toBe(SOL - 10_000n);
    const entry = await t.journal.get(t.pool.toBase58());
    expect(entry?.inFlight).toBeNull();
    expect(entry?.lastClaim?.quote).toBe('50000000');
    expect(t.alerter.alerts).toHaveLength(0);

    // Nothing left: the next run does not build or send anything.
    const sends = t.chain.sendAttempts.length;
    const next = await t.job().runOnce();
    expect(next.outcomes[0]).toMatchObject({ result: 'below_threshold', claimable: 0n });
    expect(t.chain.sendAttempts.length).toBe(sends);
  });

  it('respects the threshold exactly', async () => {
    const below = await setup({ claimable: MIN - 1n });
    expect((await below.job().runOnce()).outcomes[0]).toMatchObject({ result: 'below_threshold' });
    expect(below.chain.calls).not.toContain('sendRawTransaction');
    const at = await setup({ claimable: MIN });
    expect((await at.job().runOnce()).outcomes[0]).toMatchObject({
      result: 'claimed',
      lamports: MIN,
    });
  });

  it('lets the creator wallet pay when configured', async () => {
    const t = await setup({ config: { feePayer: 'creator' } });
    const signSpy = vi.spyOn(keystore, 'withSigner');
    await t.job().runOnce();
    expect(signSpy.mock.calls.map((c) => c[0])).toEqual([t.creator.ref]);
    expect(t.chain.balanceOf(t.creator.publicKey)).toBe(10_000_000n - 5_000n);
    expect(t.chain.balanceOf(t.payer.publicKey)).toBe(SOL);
  });

  it('calls onBeforeSend with the claim signature before the broadcast', async () => {
    const t = await setup();
    const seen: Array<[string, number]> = [];
    await t.job({ onBeforeSend: (s) => seen.push([s, t.chain.sendAttempts.length]) }).runOnce();
    expect(seen).toEqual([[t.chain.sendAttempts[0], 0]]);
  });
});

describe('claims: refusals and alerts', () => {
  it('raises an immediate alert and claims nothing when the pool creator changed', async () => {
    const t = await setup();
    t.poolState().creator = randomAddress();
    const signSpy = vi.spyOn(keystore, 'withSigner');
    const report = await t.job().runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'manual', reason: 'pool_creator_changed' });
    const alert = t.alerter.alerts.find((a) => a.code === 'pool_creator_changed');
    expect(alert?.level).toBe('immediate');
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('skips silently when the pool does not exist yet', async () => {
    const t = await setup();
    t.dbc.pools.clear();
    const report = await t.job().runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'no_pool' });
    expect(t.alerter.alerts).toHaveLength(0);
  });

  it('refuses a creator_wallet_ref that is not the keystore key of this launchpad', async () => {
    const t = await setup();
    t.store.launchpads[0]!.creatorWalletRef = t.payer.ref; // e.g. a tampered row
    const signSpy = vi.spyOn(keystore, 'withSigner');
    const report = await t.job().runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'manual', reason: 'creator_ref_mismatch' });
    expect(signSpy).not.toHaveBeenCalled();
    expect(t.alerter.codes()).toContain('creator_claim_manual');
  });

  it('refuses invalid launchpad rows', async () => {
    const t = await setup();
    t.store.launchpads.push({
      id: 'not-a-uuid',
      status: 'live',
      coinConfig: randomAddress().toBase58(),
      coinMint: randomAddress().toBase58(),
      creatorWalletRef: 'ks_00000000000000000000000000000000',
    });
    t.store.launchpads.push({ ...t.store.launchpads[0]!, id: uuid(), coinMint: 'nope' });
    const report = await t.job().runOnce();
    expect(report.outcomes.map((o) => (o.result === 'manual' ? o.reason : o.result))).toEqual([
      'claimed',
      'invalid_launchpad_id',
      'invalid_addresses',
    ]);
  });

  it('skips with an alert when the fee payer cannot fund the temporary accounts', async () => {
    const t = await setup();
    t.chain.setBalance(t.payer.publicKey, 1_000_000n);
    const report = await t.job().runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'skipped', reason: 'payer_low_balance' });
    expect(t.alerter.codes()).toContain('claim_payer_low_balance');
    expect(t.chain.calls).not.toContain('sendRawTransaction');
  });

  it('checks, signs and sends a payer-paid claim only under the payer lock', async () => {
    const t = await setup();
    const payerLock = new Mutex();
    let release!: () => void;
    const held = payerLock.runExclusive(() => new Promise<void>((r) => (release = r)));
    const run = t.job({ payerLock }).runOnce();
    await new Promise((r) => setTimeout(r, 200));
    // Blocked before the balance check: nothing built, signed or sent while a route holds it.
    expect(t.chain.calls).not.toContain('sendRawTransaction');
    expect(t.chain.calls).not.toContain('getBalance');
    release();
    await held;
    const report = await run;
    expect(report.outcomes[0]).toMatchObject({ result: 'claimed' });
    expect(payerLock.held).toBe(false); // released before the confirmation wait ended
  });

  it('does not take the payer lock when the creator wallet pays', async () => {
    const t = await setup({ config: { feePayer: 'creator' } });
    const payerLock = new Mutex();
    let release!: () => void;
    const held = payerLock.runExclusive(() => new Promise<void>((r) => (release = r)));
    const report = await t.job({ payerLock }).runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'claimed' });
    release();
    await held;
  });

  it('does not count the payer lamports reserved by creations in flight', async () => {
    const t = await setup();
    const payerReservations = new PayerReservations();
    const lastValidBlockHeight = (await t.chain.getBlockHeight('confirmed')) + 1_000;
    payerReservations.reserve('in-flight-creation', SOL - 1_000_000n, lastValidBlockHeight);
    const report = await t.job({ payerReservations }).runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'skipped', reason: 'payer_low_balance' });
    expect(t.alerter.codes()).toContain('claim_payer_low_balance');
    expect(t.chain.calls).not.toContain('sendRawTransaction');
    // Once its blockhash is past the finalized height, the reservation no longer counts.
    t.chain.advance(5_000);
    expect(
      await payerReservations.outstanding(t.chain, { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 }),
    ).toBe(0n);
    const next = await t.job({ payerReservations }).runOnce();
    expect(next.outcomes[0]).toMatchObject({ result: 'claimed' });
  });

  it('sends a one-time notice for graduated pools and still claims the DBC share', async () => {
    const t = await setup();
    t.poolState().graduated = true;
    await t.job().runOnce();
    t.poolState().claimableQuote = 20_000_000n;
    const second = await t.job().runOnce();
    expect(second.outcomes[0]).toMatchObject({ result: 'claimed', kind: 'dbc' });
    expect(t.alerter.codes().filter((c) => c === 'pool_graduated')).toHaveLength(1);
    // Curve complete but not migrated yet: no position to look at.
    expect(second.outcomes).toHaveLength(1);
  });

  it('does nothing when paused (flag, env, or unreadable flags)', async () => {
    const t = await setup();
    t.flags.values.claims_paused = true;
    expect((await t.job().runOnce()).status).toBe('paused');
    t.flags.values.claims_paused = false;
    t.flags.fail = true;
    expect((await t.job().runOnce()).reason).toBe('flags_unavailable');
    t.flags.fail = false;
    expect(
      (
        await t
          .job({
            config: {
              vault: t.vault,
              minClaimLamports: MIN,
              minPositionClaimLamports: MIN,
              feePayer: 'payer',
              paused: true,
            },
          })
          .runOnce()
      ).reason,
    ).toBe('config');
    expect(t.chain.calls).toHaveLength(0);
  });

  it('reports a database failure with an alert', async () => {
    const t = await setup();
    t.store.failNext = new Error('db down');
    const report = await t.job().runOnce();
    expect(report.status).toBe('error');
    expect(t.alerter.codes()).toContain('claims_run_failed');
  });
});

describe('claims: transaction policy (core output is checked before signing)', () => {
  const cases: Array<
    [string, (tx: import('@solana/web3.js').Transaction, vault: PublicKey) => void]
  > = [
    [
      'an extra SOL transfer',
      (tx) =>
        tx.add(
          SystemProgram.transfer({
            fromPubkey: tx.instructions[0]!.keys[0]!.pubkey,
            toPubkey: randomAddress(),
            lamports: 1n,
          }),
        ),
    ],
    [
      'the WSOL account closed to another wallet',
      (tx) => {
        const close = tx.instructions[3]!;
        tx.instructions[3] = createCloseAccountInstruction(
          close.keys[0]!.pubkey,
          randomAddress(),
          close.keys[2]!.pubkey,
        );
      },
    ],
    [
      'a DBC instruction other than the creator claim (e.g. transfer_pool_creator)',
      (tx) => {
        const ix = tx.instructions[2]!;
        tx.instructions[2] = new TransactionInstruction({
          programId: ix.programId,
          keys: ix.keys,
          data: Buffer.from([20, 7, 169, 33, 58, 147, 166, 33, 0, 0, 0, 0, 0, 0, 0, 0]),
        });
      },
    ],
    [
      'base fees sent to another token account',
      (tx) => {
        const ix = tx.instructions[2]!;
        ix.keys[2] = {
          ...ix.keys[2]!,
          pubkey: getAssociatedTokenAddressSync(ix.keys[6]!.pubkey, randomAddress(), true),
        };
      },
    ],
    [
      'quote fees sent to a token account that is not closed to the vault',
      (tx) => {
        tx.instructions.pop();
      },
    ],
    [
      'an unknown program',
      (tx) =>
        tx.add(
          new TransactionInstruction({
            programId: randomAddress(),
            keys: [],
            data: Buffer.alloc(0),
          }),
        ),
    ],
    [
      'a claim on another pool',
      (tx) => {
        const ix = tx.instructions[2]!;
        ix.keys[1] = { ...ix.keys[1]!, pubkey: randomAddress() };
      },
    ],
    [
      'a token account created for a stranger',
      (tx, vault) => {
        const ix = tx.instructions[0]!;
        void vault;
        ix.keys[2] = { ...ix.keys[2]!, pubkey: randomAddress() };
      },
    ],
  ];

  for (const [name, tamper] of cases) {
    it(`refuses ${name}`, async () => {
      const t = await setup();
      t.dbc.tamper = (tx) => tamper(tx, t.vault);
      const signSpy = vi.spyOn(keystore, 'withSigner');
      const report = await t.job().runOnce();
      expect(report.outcomes[0]).toMatchObject({ result: 'error' });
      expect(t.alerter.codes()).toContain('claim_policy_violation');
      expect(signSpy).not.toHaveBeenCalled();
      expect(t.chain.calls).not.toContain('sendRawTransaction');
      expect(t.poolState().claimableQuote).toBe(50_000_000n);
    });
  }

  it('accepts the untampered claim layout (control)', async () => {
    const t = await setup();
    t.dbc.tamper = () => undefined;
    expect((await t.job().runOnce()).outcomes[0]).toMatchObject({ result: 'claimed' });
    expect(getAssociatedTokenAddressSync(NATIVE_MINT, t.creator.publicKey, true)).toBeInstanceOf(
      PublicKey,
    );
  });

  it("claims through core's exact layout: self-transfer, close to the payer wallet, forward from it", async () => {
    // What core builds when the receiver (the vault) is not the fee payer: on devnet the signer's
    // payer wallet pays and the creator wallets hold no SOL. Refused before this layout was known.
    const t = await setup();
    t.dbc.claimShape = 'exact';
    const vaultBefore = t.chain.balanceOf(t.vault);
    const report = await t.job().runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'claimed' });
    expect(t.alerter.codes()).not.toContain('claim_policy_violation');
    expect(t.chain.balanceOf(t.vault)).toBe(vaultBefore + 50_000_000n);
    expect(t.poolState().claimableQuote).toBe(0n);
    expect(t.chain.transfers[0]).toMatchObject({
      from: t.payer.publicKey.toBase58(),
      to: t.vault.toBase58(),
      lamports: 50_000_000n,
    });
  });

  it("claims through core's exact layout when the creator wallet pays", async () => {
    const t = await setup({ config: { feePayer: 'creator' } });
    t.dbc.claimShape = 'exact';
    const vaultBefore = t.chain.balanceOf(t.vault);
    expect((await t.job().runOnce()).outcomes[0]).toMatchObject({ result: 'claimed' });
    expect(t.chain.balanceOf(t.vault)).toBe(vaultBefore + 50_000_000n);
    expect(t.chain.transfers[0]).toMatchObject({ from: t.creator.publicKey.toBase58() });
  });
});

describe('claims: in-flight idempotency, failures and retries', () => {
  it('never has two claims of a pool in flight; replaces one only after proven expiry', async () => {
    const t = await setup({ config: { settle: { timeoutMs: 10_000 } } });
    t.chain.defaultBehavior = 'drop';
    const first = await t.job().runOnce();
    expect(first.outcomes[0]).toMatchObject({ result: 'in_flight' });
    const firstSig = (first.outcomes[0] as { signature: string }).signature;

    const second = await t.job().runOnce();
    expect(second.outcomes[0]).toMatchObject({ result: 'in_flight', signature: firstSig });
    expect(new Set(t.chain.sendAttempts)).toEqual(new Set([firstSig]));

    t.chain.advance(400);
    t.chain.defaultBehavior = 'land';
    const third = await t.job().runOnce();
    expect(third.outcomes[0]).toMatchObject({ result: 'claimed' });
    expect((third.outcomes[0] as { signature: string }).signature).not.toBe(firstSig);
    expect(t.chain.balanceOf(t.vault)).toBe(SOL + 50_000_000n);
  });

  it('detects a claim whose send response was lost as landed, and never claims twice', async () => {
    const t = await setup();
    t.chain.behaviors.push('land_then_network_error');
    const first = await t.job().runOnce();
    expect(first.outcomes[0]).toMatchObject({ result: 'claimed' });
    expect(new Set(t.chain.sendAttempts).size).toBe(1);
    expect(t.chain.balanceOf(t.vault)).toBe(SOL + 50_000_000n);
  });

  it('records on restart a claim that landed after the process stopped waiting', async () => {
    const t = await setup({ config: { settle: { timeoutMs: 2_000 } } });
    t.chain.behaviors.push('drop');
    const first = await t.job().runOnce();
    expect(first.outcomes[0]).toMatchObject({ result: 'in_flight' });
    // The RPC's own retry lands the transaction while the signer is down.
    const entry = await t.journal.get(t.pool.toBase58());
    await t.chain.sendRawTransaction(Buffer.from(entry!.inFlight!.rawTx, 'base64'));
    const second = await t.job().runOnce();
    expect(second.outcomes[0]).toMatchObject({
      result: 'claimed',
      signature: entry!.inFlight!.signature,
    });
    expect(new Set(t.chain.sendAttempts).size).toBe(1);
    expect(t.chain.balanceOf(t.vault)).toBe(SOL + 50_000_000n);
    expect((await t.journal.get(t.pool.toBase58()))?.inFlight).toBeNull();
  });

  it('alerts on an on-chain failure and retries on the next run', async () => {
    const t = await setup();
    t.chain.behaviors.push('fail_onchain');
    const first = await t.job().runOnce();
    expect(first.outcomes[0]).toMatchObject({ result: 'failed' });
    expect(t.alerter.codes()).toContain('creator_claim_failed');
    expect((await t.journal.get(t.pool.toBase58()))?.consecutiveFailures).toBe(1);
    const second = await t.job().runOnce();
    expect(second.outcomes[0]).toMatchObject({ result: 'claimed' });
    expect((await t.journal.get(t.pool.toBase58()))?.consecutiveFailures).toBe(0);
  });

  it('alerts when fees above the threshold stay unclaimed for more than 48 h', async () => {
    const t = await setup({ config: { settle: { timeoutMs: 1_000 } } });
    t.chain.defaultBehavior = 'reject';
    const first = await t.job().runOnce();
    expect(first.outcomes[0]).toMatchObject({ result: 'failed' });
    expect(t.alerter.codes()).toContain('creator_claim_rejected');
    expect(t.alerter.codes()).not.toContain('creator_fees_unclaimed');
    t.clock.advance(49 * 60 * 60_000);
    await t.job().runOnce();
    expect(t.alerter.codes()).toContain('creator_fees_unclaimed');
  });

  it('retries transient RPC errors with backoff', async () => {
    const t = await setup();
    t.chain.failNext('getBalance', new TransientRpcError(), 2);
    const report = await t.job().runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'claimed' });
    expect(t.sleeps.slice(0, 2)).toEqual([500, 1_000]);
  });

  it('turns exhausted RPC retries into an error outcome with an alert', async () => {
    const t = await setup();
    t.chain.failNext('getMinimumBalanceForRentExemption', new TransientRpcError(), 4);
    const report = await t.job().runOnce();
    expect(report.outcomes[0]).toMatchObject({ result: 'error' });
    expect(t.alerter.codes()).toContain('creator_claim_error');
    expect(t.chain.calls).not.toContain('sendRawTransaction');
  });
});

describe('position fee claims: migrated pools', () => {
  async function migrated(
    options: {
      positionQuote?: bigint;
      dbcClaimable?: bigint;
      config?: Partial<ClaimsConfig>;
      noPosition?: boolean;
    } = {},
  ) {
    const t = await setup({ claimable: options.dbcClaimable ?? 0n, config: options.config });
    t.poolState().graduated = true;
    t.poolState().migrated = true;
    const position = options.noPosition
      ? null
      : t.dbc.addPosition(t.pool, { pendingQuote: options.positionQuote ?? 50_000_000n });
    return { ...t, position };
  }

  it('claims the position fees of a migrated pool to the vault, signed by the creator and the payer', async () => {
    const t = await migrated();
    const signSpy = vi.spyOn(keystore, 'withSigner');
    const report = await t.job().runOnce();
    expect(report.status).toBe('ran');
    expect(report.outcomes).toEqual([
      expect.objectContaining({ kind: 'dbc', result: 'below_threshold', claimable: 0n }),
      expect.objectContaining({
        kind: 'position',
        result: 'claimed',
        lamports: 50_000_000n,
        pool: t.pool.toBase58(),
      }),
    ]);
    expect(t.chain.balanceOf(t.vault)).toBe(SOL + 50_000_000n);
    expect(t.position!.pendingQuote).toBe(0n);
    expect(signSpy.mock.calls.map((c) => c[0]).sort()).toEqual([t.creator.ref, t.payer.ref].sort());
    expect(t.chain.balanceOf(t.payer.publicKey)).toBe(SOL - 10_000n);
    const entry = await t.journal.get(t.pool.toBase58());
    expect(entry?.inFlight).toBeNull();
    expect(entry?.lastClaim).toBeNull();
    expect(entry?.lastPositionClaim).toMatchObject({
      quote: '50000000',
      positions: [t.position!.position.toBase58()],
    });
    expect(entry?.positionPendingSince).toBeNull();
    expect(t.alerter.codes()).toEqual(['pool_graduated']);

    // Nothing left: the next run reads and sends nothing.
    const sends = t.chain.sendAttempts.length;
    const next = await t.job().runOnce();
    expect(next.outcomes[1]).toMatchObject({
      kind: 'position',
      result: 'below_threshold',
      claimable: 0n,
    });
    expect(t.chain.sendAttempts.length).toBe(sends);
  });

  it('claims the DBC share first and the position fees on the next run', async () => {
    const t = await migrated({ dbcClaimable: 30_000_000n, positionQuote: 40_000_000n });
    const first = await t.job().runOnce();
    expect(first.outcomes).toEqual([
      expect.objectContaining({ kind: 'dbc', result: 'claimed', lamports: 30_000_000n }),
    ]);
    const second = await t.job().runOnce();
    expect(second.outcomes).toEqual([
      expect.objectContaining({ kind: 'dbc', result: 'below_threshold' }),
      expect.objectContaining({ kind: 'position', result: 'claimed', lamports: 40_000_000n }),
    ]);
    expect(t.chain.balanceOf(t.vault)).toBe(SOL + 70_000_000n);
  });

  it('respects the threshold exactly for position fees', async () => {
    const below = await migrated({ positionQuote: MIN - 1n });
    expect((await below.job().runOnce()).outcomes[1]).toMatchObject({
      kind: 'position',
      result: 'below_threshold',
      claimable: MIN - 1n,
    });
    expect(below.chain.calls).not.toContain('sendRawTransaction');
    const at = await migrated({ positionQuote: MIN });
    expect((await at.job().runOnce()).outcomes[1]).toMatchObject({
      kind: 'position',
      result: 'claimed',
      lamports: MIN,
    });
  });

  it('uses its own, higher threshold for position fees, separate from the DBC one', async () => {
    // Above the DBC threshold, below the position one: the position fees wait.
    const waits = await migrated({
      positionQuote: 3n * MIN,
      config: { minPositionClaimLamports: 5n * MIN },
    });
    expect((await waits.job().runOnce()).outcomes[1]).toMatchObject({
      kind: 'position',
      result: 'below_threshold',
      claimable: 3n * MIN,
    });
    expect(waits.chain.calls).not.toContain('sendRawTransaction');
    const due = await migrated({
      positionQuote: 5n * MIN,
      config: { minPositionClaimLamports: 5n * MIN },
    });
    expect((await due.job().runOnce()).outcomes[1]).toMatchObject({
      kind: 'position',
      result: 'claimed',
      lamports: 5n * MIN,
    });
    // The DBC share keeps its own threshold whatever the position one.
    const dbc = await setup({ claimable: MIN, config: { minPositionClaimLamports: 100n * MIN } });
    expect((await dbc.job().runOnce()).outcomes[0]).toMatchObject({ kind: 'dbc', result: 'claimed' });
  });

  it('alerts once, not every run, when WSOL in the creator account blocks a payer-paid claim', async () => {
    const t = await setup();
    const blocked = {
      ...t.core,
      buildCreatorClaimTx: async () => {
        throw new ClaimError('claimer_wsol_not_empty', 'the creator WSOL account holds 1 lamport');
      },
    };
    const alerts = () => t.alerter.alerts.filter((a) => a.code === 'creator_wsol_blocked');
    const first = await t.job({ core: blocked }).runOnce();
    expect(first.outcomes[0]).toMatchObject({
      kind: 'dbc',
      result: 'manual',
      reason: 'claimer_wsol_not_empty',
    });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.level).toBe('high');
    expect(alerts()[0]!.details).toMatchObject({ launchpadId: t.launchpadId, kind: 'dbc' });
    expect(t.alerter.alerts.map((a) => a.code)).not.toContain('creator_claim_error');
    // The next runs (the same condition, hour after hour) stay silent.
    t.clock.advance(60 * 60_000);
    expect((await t.job({ core: blocked }).runOnce()).outcomes[0]).toMatchObject({
      result: 'manual',
      reason: 'claimer_wsol_not_empty',
    });
    t.clock.advance(60 * 60_000);
    await t.job({ core: blocked }).runOnce();
    expect(alerts()).toHaveLength(1);
    expect((await t.journal.get(t.pool.toBase58()))?.wsolBlockedAlertedAt).not.toBeNull();
    // Once the account is unwrapped the claim builds, and a new blockage alerts again.
    expect((await t.job().runOnce()).outcomes[0]).toMatchObject({ kind: 'dbc', result: 'claimed' });
    expect((await t.journal.get(t.pool.toBase58()))?.wsolBlockedAlertedAt).toBeNull();
    t.poolState().claimableQuote = 50_000_000n;
    await t.job({ core: blocked }).runOnce();
    expect(alerts()).toHaveLength(2);
  });

  it('lets the creator wallet pay a position claim when configured', async () => {
    const t = await migrated({ config: { feePayer: 'creator' } });
    const signSpy = vi.spyOn(keystore, 'withSigner');
    expect((await t.job().runOnce()).outcomes[1]).toMatchObject({ result: 'claimed' });
    expect(signSpy.mock.calls.map((c) => c[0])).toEqual([t.creator.ref]);
    expect(t.chain.balanceOf(t.creator.publicKey)).toBe(10_000_000n - 5_000n);
  });

  it('never has two claims of a pool in flight, whatever their kind', async () => {
    const t = await migrated({ config: { settle: { timeoutMs: 10_000 } } });
    t.chain.defaultBehavior = 'drop';
    const first = await t.job().runOnce();
    expect(first.outcomes[1]).toMatchObject({ kind: 'position', result: 'in_flight' });
    const signature = (first.outcomes[1] as { signature: string }).signature;
    expect((await t.journal.get(t.pool.toBase58()))?.inFlight).toMatchObject({
      kind: 'position',
      signature,
    });

    // The DBC share grows meanwhile: still nothing else is sent while the claim is in flight.
    t.poolState().claimableQuote = 30_000_000n;
    const second = await t.job().runOnce();
    expect(second.outcomes).toEqual([
      expect.objectContaining({ kind: 'position', result: 'in_flight', signature }),
    ]);
    expect(new Set(t.chain.sendAttempts)).toEqual(new Set([signature]));

    t.chain.advance(400);
    t.chain.defaultBehavior = 'land';
    const third = await t.job().runOnce();
    // The expired position claim is replaced by a new one only after the DBC claim of this run.
    expect(third.outcomes).toEqual([
      expect.objectContaining({ kind: 'dbc', result: 'claimed', lamports: 30_000_000n }),
    ]);
    const fourth = await t.job().runOnce();
    expect(fourth.outcomes[1]).toMatchObject({ kind: 'position', result: 'claimed' });
    expect((fourth.outcomes[1] as { signature: string }).signature).not.toBe(signature);
    expect(t.chain.balanceOf(t.vault)).toBe(SOL + 80_000_000n);
  });

  it('records on restart a position claim that landed after the process stopped waiting', async () => {
    const t = await migrated({ config: { settle: { timeoutMs: 2_000 } } });
    t.chain.behaviors.push('drop');
    expect((await t.job().runOnce()).outcomes[1]).toMatchObject({ result: 'in_flight' });
    const entry = await t.journal.get(t.pool.toBase58());
    await t.chain.sendRawTransaction(Buffer.from(entry!.inFlight!.rawTx, 'base64'));
    const second = await t.job().runOnce();
    expect(second.outcomes).toEqual([
      expect.objectContaining({
        kind: 'position',
        result: 'claimed',
        signature: entry!.inFlight!.signature,
      }),
    ]);
    expect(new Set(t.chain.sendAttempts).size).toBe(1);
    expect(t.chain.balanceOf(t.vault)).toBe(SOL + 50_000_000n);
  });

  it('alerts when a migrated pool has no position held by the creator', async () => {
    const t = await migrated({ noPosition: true });
    const report = await t.job().runOnce();
    expect(report.outcomes[1]).toMatchObject({
      kind: 'position',
      result: 'manual',
      reason: 'creator_position_missing',
    });
    const alert = t.alerter.alerts.find((a) => a.code === 'creator_position_missing');
    expect(alert?.level).toBe('high');
    expect(t.chain.calls).not.toContain('sendRawTransaction');
    // A position held by another wallet does not count.
    t.dbc.addPosition(t.pool, { pendingQuote: 50_000_000n, owner: randomAddress() });
    expect((await t.job().runOnce()).outcomes[1]).toMatchObject({
      reason: 'creator_position_missing',
    });
  });

  it('alerts on an on-chain failure of a position claim and retries on the next run', async () => {
    const t = await migrated();
    t.chain.behaviors.push('fail_onchain');
    expect((await t.job().runOnce()).outcomes[1]).toMatchObject({
      kind: 'position',
      result: 'failed',
    });
    expect(t.alerter.codes()).toContain('position_claim_failed');
    expect((await t.journal.get(t.pool.toBase58()))?.consecutiveFailures).toBe(1);
    expect((await t.job().runOnce()).outcomes[1]).toMatchObject({ result: 'claimed' });
  });

  it('alerts when position fees above the threshold stay unclaimed for more than 48 h', async () => {
    const t = await migrated({ config: { settle: { timeoutMs: 1_000 } } });
    t.chain.defaultBehavior = 'reject';
    expect((await t.job().runOnce()).outcomes[1]).toMatchObject({ result: 'failed' });
    expect(t.alerter.codes()).toContain('position_claim_rejected');
    expect(t.alerter.codes()).not.toContain('position_fees_unclaimed');
    t.clock.advance(49 * 60 * 60_000);
    await t.job().runOnce();
    expect(t.alerter.codes()).toContain('position_fees_unclaimed');
    expect(t.alerter.codes()).not.toContain('creator_fees_unclaimed');
  });

  it('re-reads the kill switch before signing a position claim', async () => {
    const t = await migrated();
    let reads = 0;
    const flags = {
      async read() {
        reads++;
        if (reads > 1) t.flags.values.claims_paused = true;
        return t.flags.read();
      },
    };
    const signSpy = vi.spyOn(keystore, 'withSigner');
    const report = await t.job({ flags }).runOnce();
    expect(report.status).toBe('paused');
    expect(report.outcomes[1]).toMatchObject({ kind: 'position', result: 'skipped', reason: 'paused' });
    expect(signSpy).not.toHaveBeenCalled();
    expect(t.chain.calls).not.toContain('sendRawTransaction');
  });

  it('skips with an alert when the fee payer cannot fund the accounts of a position claim', async () => {
    const t = await migrated();
    t.chain.setBalance(t.payer.publicKey, 1_000_000n);
    expect((await t.job().runOnce()).outcomes[1]).toMatchObject({
      kind: 'position',
      result: 'skipped',
      reason: 'payer_low_balance',
    });
    expect(t.alerter.codes()).toContain('claim_payer_low_balance');
  });

  it('still parses journal entries written before position claims existed', () => {
    const old = {
      v: 1,
      pool: randomAddress().toBase58(),
      launchpadId: uuid(),
      inFlight: {
        signature: 'sig',
        rawTx: 'AA==',
        lastValidBlockHeight: 10,
        claimableQuote: '5',
        startedAt: '2026-10-09T00:00:00.000Z',
      },
      lastClaim: null,
      pendingSince: null,
      graduationNoticeAt: null,
      consecutiveFailures: 0,
      lastError: null,
    };
    const parsed = ClaimJournalEntry.parse(old);
    expect(parsed.inFlight).toMatchObject({ kind: 'dbc', positions: [] });
    expect(parsed.lastPositionClaim).toBeNull();
    expect(parsed.positionPendingSince).toBeNull();
  });
});

describe('position fee claims: transaction policy (core output is checked before signing)', () => {
  const CLAIM = 2;
  const cases: Array<[string, (tx: import('@solana/web3.js').Transaction, t: { dbc: FakeDbc }) => void]> = [
    [
      'an extra SOL transfer',
      (tx) =>
        tx.add(
          SystemProgram.transfer({
            fromPubkey: tx.instructions[0]!.keys[0]!.pubkey,
            toPubkey: randomAddress(),
            lamports: 1n,
          }),
        ),
    ],
    [
      'the WSOL account closed to another wallet',
      (tx) => {
        const close = tx.instructions.pop()!;
        tx.add(createCloseAccountInstruction(close.keys[0]!.pubkey, randomAddress(), close.keys[2]!.pubkey));
      },
    ],
    [
      'the WSOL account left open (fees stranded in the creator wallet)',
      (tx) => {
        tx.instructions.pop();
      },
    ],
    [
      'a DAMM v2 instruction other than the position fee claim (e.g. remove_liquidity)',
      (tx) => {
        const ix = tx.instructions[CLAIM]!;
        tx.instructions[CLAIM] = new TransactionInstruction({
          programId: ix.programId,
          keys: ix.keys,
          data: Buffer.from([80, 85, 209, 72, 24, 206, 177, 169, 0, 0, 0, 0, 0, 0, 0, 0]),
        });
      },
    ],
    [
      'coin fees sent to another token account',
      (tx) => {
        const ix = tx.instructions[CLAIM]!;
        ix.keys[3] = { ...ix.keys[3]!, pubkey: getAssociatedTokenAddressSync(ix.keys[7]!.pubkey, randomAddress(), true) };
      },
    ],
    [
      'SOL fees sent to another token account',
      (tx) => {
        const ix = tx.instructions[CLAIM]!;
        ix.keys[4] = { ...ix.keys[4]!, pubkey: getAssociatedTokenAddressSync(NATIVE_MINT, randomAddress(), true) };
      },
    ],
    [
      'a claim on another pool',
      (tx) => {
        const ix = tx.instructions[CLAIM]!;
        ix.keys[1] = { ...ix.keys[1]!, pubkey: randomAddress() };
      },
    ],
    [
      'a claim on a position that is not the creator\'s',
      (tx) => {
        const ix = tx.instructions[CLAIM]!;
        ix.keys[2] = { ...ix.keys[2]!, pubkey: randomAddress() };
      },
    ],
    [
      'the position claimed twice',
      (tx) => {
        const ix = tx.instructions[CLAIM]!;
        tx.instructions.splice(CLAIM, 0, new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: ix.data }));
      },
    ],
    [
      'another owner signing for the position',
      (tx) => {
        const ix = tx.instructions[CLAIM]!;
        ix.keys[10] = { ...ix.keys[10]!, pubkey: randomAddress() };
      },
    ],
    [
      'a Token-2022 transfer of the position NFT',
      (tx) =>
        tx.add(
          new TransactionInstruction({
            programId: TOKEN_2022_PROGRAM_ID,
            keys: [{ pubkey: tx.instructions[CLAIM]!.keys[9]!.pubkey, isSigner: false, isWritable: true }],
            data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]),
          }),
        ),
    ],
    [
      'a DBC instruction next to the claim',
      (tx, t) =>
        tx.add(new TransactionInstruction({ programId: t.dbc.programId, keys: [], data: Buffer.alloc(8) })),
    ],
    [
      'a token account created for a stranger',
      (tx) => {
        const ix = tx.instructions[0]!;
        ix.keys[2] = { ...ix.keys[2]!, pubkey: randomAddress() };
      },
    ],
    [
      'an unknown program',
      (tx) => tx.add(new TransactionInstruction({ programId: randomAddress(), keys: [], data: Buffer.alloc(0) })),
    ],
  ];

  for (const [name, tamper] of cases) {
    it(`refuses ${name}`, async () => {
      const t = await setup({ claimable: 0n });
      t.poolState().graduated = true;
      t.poolState().migrated = true;
      const position = t.dbc.addPosition(t.pool, { pendingQuote: 50_000_000n });
      t.dbc.tamperPosition = (tx) => tamper(tx, t);
      const signSpy = vi.spyOn(keystore, 'withSigner');
      const report = await t.job().runOnce();
      expect(report.outcomes[0]).toMatchObject({ result: 'error' });
      expect(t.alerter.codes()).toContain('claim_policy_violation');
      expect(signSpy).not.toHaveBeenCalled();
      expect(t.chain.calls).not.toContain('sendRawTransaction');
      expect(position.pendingQuote).toBe(50_000_000n);
      expect(t.chain.balanceOf(t.vault)).toBe(SOL);
    });
  }

  it('accepts the untampered position claim layout (control)', async () => {
    const t = await setup({ claimable: 0n });
    t.poolState().graduated = true;
    t.poolState().migrated = true;
    t.dbc.addPosition(t.pool, { pendingQuote: 50_000_000n });
    t.dbc.tamperPosition = () => undefined;
    expect((await t.job().runOnce()).outcomes[1]).toMatchObject({ kind: 'position', result: 'claimed' });
  });
});

describe('claimsConfigFromEnv', () => {
  it('defaults to a 1 h interval, 0.01 SOL threshold and the payer wallet', () => {
    const vault = randomAddress();
    const c = claimsConfigFromEnv({}, vault);
    expect(c.intervalMs).toBe(60 * 60_000);
    expect(claimsConfigFromEnv({ SIGNER_CLAIMS_INTERVAL_HOURS: '24' }, vault).intervalMs).toBe(
      24 * 60 * 60_000,
    );
    expect(c.config).toMatchObject({
      vault,
      minClaimLamports: 10_000_000n,
      // Position claims pay about 0.002 SOL of WSOL rent each time: a higher default.
      minPositionClaimLamports: 50_000_000n,
      feePayer: 'payer',
      paused: false,
    });
    expect(
      claimsConfigFromEnv({ SIGNER_CLAIMS_MIN_POSITION_LAMPORTS: '7' }, vault).config
        .minPositionClaimLamports,
    ).toBe(7n);
    expect(claimsConfigFromEnv({ SIGNER_CLAIMS_FEE_PAYER: 'creator' }, vault).config.feePayer).toBe(
      'creator',
    );
    expect(() => claimsConfigFromEnv({ SIGNER_CLAIMS_FEE_PAYER: 'vault' }, vault)).toThrow();
    expect(() => claimsConfigFromEnv({ SIGNER_CLAIMS_MIN_LAMPORTS: '-1' }, vault)).toThrow();
    expect(() =>
      claimsConfigFromEnv({ SIGNER_CLAIMS_MIN_POSITION_LAMPORTS: '1.5' }, vault),
    ).toThrow();
  });
});

describe('PostgREST claims store', () => {
  it('pages through launchpads that have a coin pool and a creator ref', async () => {
    const urls: string[] = [];
    const row = (i: number) => ({
      id: uuid(),
      status: 'live',
      launchpad_coin_config: randomAddress().toBase58(),
      launchpad_coin_mint: randomAddress().toBase58(),
      creator_wallet_ref: `ks_${i.toString(16).padStart(32, '0')}`,
    });
    const pages = [[row(1), row(2)], [row(3)]];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(pages.shift() ?? []), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createPostgrestClient({
      url: 'https://project.supabase.co',
      serviceRoleKey: 'service-role-key-for-tests-0123456789',
      fetch: fetchImpl,
    });
    const list = await createPostgrestClaimsStore(client, 2).listCreatorLaunchpads();
    expect(list).toHaveLength(3);
    const first = new URL(urls[0]!);
    expect(first.searchParams.get('creator_wallet_ref')).toBe('not.is.null');
    expect(first.searchParams.get('launchpad_coin_mint')).toBe('not.is.null');
    expect(new URL(urls[1]!).searchParams.get('offset')).toBe('2');
  });
});
