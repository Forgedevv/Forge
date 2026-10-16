import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      config: { vault, minClaimLamports: MIN, feePayer: 'payer', ...options.config },
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
    expect(second.outcomes[0]).toMatchObject({ result: 'claimed' });
    expect(t.alerter.codes().filter((c) => c === 'post_graduation_lp_fees')).toHaveLength(1);
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
            config: { vault: t.vault, minClaimLamports: MIN, feePayer: 'payer', paused: true },
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

describe('claimsConfigFromEnv', () => {
  it('defaults to a 24 h interval, 0.01 SOL threshold and the payer wallet', () => {
    const vault = randomAddress();
    const c = claimsConfigFromEnv({}, vault);
    expect(c.intervalMs).toBe(24 * 60 * 60_000);
    expect(c.config).toMatchObject({
      vault,
      minClaimLamports: 10_000_000n,
      feePayer: 'payer',
      paused: false,
    });
    expect(claimsConfigFromEnv({ SIGNER_CLAIMS_FEE_PAYER: 'creator' }, vault).config.feePayer).toBe(
      'creator',
    );
    expect(() => claimsConfigFromEnv({ SIGNER_CLAIMS_FEE_PAYER: 'vault' }, vault)).toThrow();
    expect(() => claimsConfigFromEnv({ SIGNER_CLAIMS_MIN_LAMPORTS: '-1' }, vault)).toThrow();
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
