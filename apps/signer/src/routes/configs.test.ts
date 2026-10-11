import { SystemProgram } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { creatorRole } from '../keystore.js';
import { JobError, type Journal } from '../jobs/shared.js';
import { LaunchCoinError } from '@forge/core';
import { handleCreateConfigs } from './configs.js';
import { createRouteRuntime } from './context.js';
import { classifyError } from './errors.js';
import { dbcAccounts, ok, refused, setup, useTestKeystore } from './harness.js';
import type { ConfigsJournalEntry } from './journal.js';
import { randomKey } from './testing.js';

// Every FORGE signature decrypts a keystore key (scrypt): slow under a parallel test run.
vi.setConfig({ testTimeout: 60_000 });

const ks = useTestKeystore();

// ---------------------------------------------------------------------------------------
// POST /v1/configs

describe('POST /v1/configs', () => {
  it('creates both configs once, with the creator wallet, and records them on the launchpad', async () => {
    const h = await setup(ks.keystore);
    const body = ok(await h.routes.configs({ jobId: h.jobId }));

    expect(dbcAccounts(h).sort()).toEqual([body.launchpadConfig, body.launchpadCoinConfig].sort());
    expect(body.launchpadConfig).not.toBe(body.launchpadCoinConfig);
    const lp = h.store.launchpads.get(h.launchpadId)!;
    const creatorRef = await ks.keystore.findRef(creatorRole(h.launchpadId));
    expect(creatorRef).toBeDefined();
    expect(lp.launchpadConfig).toBe(body.launchpadConfig);
    expect(lp.launchpadCoinConfig).toBe(body.launchpadCoinConfig);
    expect(lp.creatorWalletRef).toBe(creatorRef);
    // Each signature was announced to the watcher before being sent.
    expect(h.expected).toHaveLength(2);
    for (const sig of h.chain.sendAttempts) expect(h.expected).toContain(sig);
    // The payer paid both rents and the fees; nothing else moved.
    expect(h.chain.balanceOf(h.payer)).toBe(1_000_000_000n - 2n * h.chain.configRent - 20_000n);
    // No secret in the logs: only public data.
    const logged = JSON.stringify(h.logger.lines);
    expect(logged).not.toMatch(/secret|passphrase|\[\s*\d+\s*,\s*\d+/i);
  });

  it('is idempotent: a second call returns the same configs and builds or sends nothing', async () => {
    const h = await setup(ks.keystore);
    const first = ok(await h.routes.configs({ jobId: h.jobId }));
    const builds = h.chain.built.config;
    const sends = h.chain.sendAttempts.length;
    const second = ok(await h.routes.configs({ jobId: h.jobId }));
    const afterRestart = ok(await h.restart().configs({ jobId: h.jobId }));
    expect(second).toEqual(first);
    expect(afterRestart).toEqual(first);
    expect(h.chain.built.config).toBe(builds);
    expect(h.chain.sendAttempts).toHaveLength(sends);
    expect(dbcAccounts(h)).toHaveLength(2);
  });

  it('serializes concurrent calls for one launchpad: one pair of configs', async () => {
    const h = await setup(ks.keystore);
    const [a, b] = await Promise.all([
      h.routes.configs({ jobId: h.jobId }),
      h.routes.configs({ jobId: h.jobId }),
    ]);
    expect(ok(a)).toEqual(ok(b));
    expect(h.chain.built.config).toBe(2);
    expect(dbcAccounts(h)).toHaveLength(2);
  });

  it('survives a crash between the send and the confirmation record', async () => {
    const h = await setup(ks.keystore);
    const inner = h.journals.configs;
    let puts = 0;
    const crashing: Journal<ConfigsJournalEntry> = {
      ...inner,
      get: (k) => inner.get(k),
      list: () => inner.list(),
      delete: (k) => inner.delete(k),
      async put(key, value) {
        puts++;
        // 1st put: the signed transaction (before the send); 2nd: its confirmation -> crash.
        if (puts === 2) throw new JobError('JOURNAL_IO', 'disk gone');
        return inner.put(key, value);
      },
    };
    const crashed = h.restart({ journals: { ...h.journals, configs: crashing } });
    expect(refused(await crashed.configs({ jobId: h.jobId }))).toEqual({
      status: 500,
      error: 'journal_error',
    });
    expect(dbcAccounts(h)).toHaveLength(1); // the first config landed

    const body = ok(await h.restart().configs({ jobId: h.jobId }));
    expect(dbcAccounts(h).sort()).toEqual([body.launchpadConfig, body.launchpadCoinConfig].sort());
    expect(h.chain.built.config).toBe(2); // the landed one was recognized, not rebuilt
  });

  it('survives a crash before the first broadcast: the journaled bytes are sent after restart', async () => {
    const h = await setup(ks.keystore);
    const broken = h.restart({
      onBeforeSend: () => {
        throw new Error('watcher unavailable');
      },
    });
    expect(refused(await broken.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'confirmation_pending',
    });
    expect(h.chain.sendAttempts).toHaveLength(0); // never broadcast without the announcement
    const body = ok(await h.restart().configs({ jobId: h.jobId }));
    expect(h.chain.built.config).toBe(2);
    expect(dbcAccounts(h).sort()).toEqual([body.launchpadConfig, body.launchpadCoinConfig].sort());
  });

  it('retries the same bytes on network errors and recognizes an already processed send', async () => {
    const h = await setup(ks.keystore);
    h.chain.behaviors.push('land_then_network_error');
    ok(await h.routes.configs({ jobId: h.jobId }));
    expect(h.chain.built.config).toBe(2);
    expect(new Set(h.chain.sendAttempts).size).toBe(2);
  });

  it('replaces a transaction only once it is proven expired (new key, new address)', async () => {
    const h = await setup(ks.keystore);
    h.chain.defaultBehavior = 'drop';
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'confirmation_pending',
    });
    const dropped = (await h.journals.configs.get(h.launchpadId))!.launchpad!.current!;
    expect(h.chain.built.config).toBe(1);

    h.chain.advance(500);
    h.chain.defaultBehavior = 'land';
    const body = ok(await h.routes.configs({ jobId: h.jobId }));
    const entry = (await h.journals.configs.get(h.launchpadId))!;
    expect(entry.launchpad!.history).toEqual([
      expect.objectContaining({ address: dropped.address, outcome: 'expired' }),
    ]);
    expect(body.launchpadConfig).not.toBe(dropped.address);
    expect(h.chain.accounts.has(dropped.address)).toBe(false);
    expect(dbcAccounts(h)).toHaveLength(2);
  });

  it('reports an on-chain failure, retries with a new key, and stops after the attempt cap', async () => {
    const h = await setup(ks.keystore);
    h.chain.behaviors.push('fail_onchain');
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 502,
      error: 'launchpad_config_tx_failed',
    });
    expect(h.alerter.codes()).toContain('account_creation_failed');
    ok(await h.routes.configs({ jobId: h.jobId })); // second attempt lands
    expect(dbcAccounts(h)).toHaveLength(2);

    const g = await setup(ks.keystore);
    g.chain.defaultBehavior = 'fail_onchain';
    for (let i = 0; i < 3; i++) await g.routes.configs({ jobId: g.jobId });
    expect(refused(await g.routes.configs({ jobId: g.jobId }))).toEqual({
      status: 409,
      error: 'launchpad_config_attempts_exhausted',
    });
    expect(g.chain.built.config).toBe(3);
  });

  it('refuses when the payer cannot pay, before signing anything', async () => {
    const h = await setup(ks.keystore);
    h.chain.setBalance(h.payer, 1_000_000n);
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'payer_low_balance',
    });
    expect(h.chain.sendAttempts).toHaveLength(0);
    expect(await h.journals.configs.get(h.launchpadId)).toBeUndefined();
    expect(h.alerter.codes()).toContain('payer_low_balance');
  });

  it('refuses a transaction from core that breaks the config policy (nothing signed)', async () => {
    const h = await setup(ks.keystore);
    const attacker = randomKey();
    const original = h.chain.buildCreateConfigTx.bind(h.chain);
    vi.spyOn(h.chain, 'buildCreateConfigTx').mockImplementation(async (params) => {
      const built = await original(params);
      built.transaction.add(
        SystemProgram.transfer({ fromPubkey: params.payer, toPubkey: attacker, lamports: 1n }),
      );
      return built;
    });
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 500,
      error: 'tx_policy_violation',
    });
    expect(h.chain.sendAttempts).toHaveLength(0);
    expect(h.alerter.codes()).toContain('route_tx_policy_violation');
  });

  it('respects deploys_paused and fails closed on a missing or unreadable flag', async () => {
    const h = await setup(ks.keystore);
    h.flags.values.deploys_paused = true;
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'deploys_paused',
    });
    delete h.flags.values.deploys_paused;
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'flags_unavailable',
    });
    h.flags.values.deploys_paused = false;
    h.flags.fail = true;
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'flags_unavailable',
    });
    expect(h.chain.built.config).toBe(0);
    expect(await ks.keystore.findRef(creatorRole(h.launchpadId))).toBeUndefined();
  });

  it('re-reads the kill switch right before signing', async () => {
    const h = await setup(ks.keystore);
    const original = h.chain.buildCreateConfigTx.bind(h.chain);
    vi.spyOn(h.chain, 'buildCreateConfigTx').mockImplementation(async (params) => {
      h.flags.values.deploys_paused = true; // flipped while core builds
      return original(params);
    });
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'deploys_paused',
    });
    expect(h.chain.sendAttempts).toHaveLength(0);
  });

  it('refuses requests that do not match the database state', async () => {
    const h = await setup(ks.keystore);
    const cases: Array<[() => void, number, string]> = [
      [() => h.store.jobs.delete(h.jobId), 404, 'job_not_found'],
      [() => (h.store.jobs.get(h.jobId)!.status = 'approved'), 409, 'job_not_in_onchain_setup'],
      [() => (h.store.jobs.get(h.jobId)!.type = 'modify_launchpad'), 409, 'not_a_creation_job'],
      [
        () => (h.store.launchpads.get(h.launchpadId)!.status = 'disabled'),
        409,
        'launchpad_not_draft',
      ],
      [() => (h.store.payments[0]!.status = 'quoted'), 409, 'payment_not_confirmed'],
      [() => (h.store.payments[0]!.status = 'refunded'), 409, 'payment_refunded'],
      [() => (h.store.payments[0]!.payerWallet = randomKey().toBase58()), 409, 'payment_mismatch'],
      [
        () => (h.store.launchpads.get(h.launchpadId)!.ownerWallet = randomKey().toBase58()),
        422,
        'spec_owner_mismatch',
      ],
      [
        () =>
          ((
            h.store.launchpads.get(h.launchpadId)!.spec as { tradingFeeBps: number }
          ).tradingFeeBps = 5_000),
        422,
        'invalid_spec',
      ],
    ];
    for (const [mutate, status, error] of cases) {
      const snapshot = {
        job: { ...h.store.jobs.get(h.jobId)! },
        lp: structuredClone(h.store.launchpads.get(h.launchpadId)!),
        payment: { ...h.store.payments[0]! },
      };
      mutate();
      expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({ status, error });
      h.store.jobs.set(h.jobId, snapshot.job);
      h.store.launchpads.set(h.launchpadId, snapshot.lp);
      h.store.payments[0] = snapshot.payment;
    }
    expect(h.chain.built.config).toBe(0);
    ok(await h.routes.configs({ jobId: h.jobId }));
  });

  it('never creates a second pair when the row has configs the journal does not know', async () => {
    const h = await setup(ks.keystore);
    h.store.launchpads.get(h.launchpadId)!.launchpadConfig = randomKey().toBase58();
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'configs_journal_missing',
    });
    expect(h.chain.built.config).toBe(0);
    expect(h.alerter.codes()).toContain('configs_journal_missing');
  });

  it('refuses a spec that no longer matches the created configs', async () => {
    const h = await setup(ks.keystore);
    ok(await h.routes.configs({ jobId: h.jobId }));
    (h.store.launchpads.get(h.launchpadId)!.spec as { tradingFeeBps: number }).tradingFeeBps = 150;
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'launchpad_config_params_changed',
    });
    expect(h.chain.built.config).toBe(2);
  });

  it('never overwrites another address already on the launchpad row', async () => {
    const h = await setup(ks.keystore);
    const realGet = h.store.getLaunchpad.bind(h.store);
    let reads = 0;
    vi.spyOn(h.store, 'getLaunchpad').mockImplementation(async (id) => {
      const row = await realGet(id);
      // The row gains a foreign coin config after the checks (another writer).
      if (++reads >= 3 && row)
        row.launchpadCoinConfig = 'ForeignConfig1111111111111111111111111111111';
      return row;
    });
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'launchpad_address_conflict',
    });
    expect(h.store.updates).toHaveLength(0);
  });

  it('refuses when the row points at another creator wallet', async () => {
    const h = await setup(ks.keystore);
    h.store.launchpads.get(h.launchpadId)!.creatorWalletRef = 'ks_00000000000000000000000000000000';
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 409,
      error: 'creator_ref_mismatch',
    });
    expect(h.chain.built.config).toBe(0);
  });

  it('refuses a coin name the launch would refuse before creating anything', async () => {
    const h = await setup(ks.keystore);
    const spec = h.store.launchpads.get(h.launchpadId)!.spec as { launchpadCoin: { name: string } };
    spec.launchpadCoin.name = ' Moon';
    expect(refused(await h.routes.configs({ jobId: h.jobId }))).toEqual({
      status: 422,
      error: 'invalid_spec',
    });
    expect(h.chain.built.config).toBe(0);
    expect(await ks.keystore.findRef(creatorRole(h.launchpadId))).toBeUndefined();
  });

  it('checks the real name + symbol + metadata URI against the launch budget first', async () => {
    const h = await setup(ks.keystore);
    const spec = h.store.launchpads.get(h.launchpadId)!.spec as {
      launchpadCoin: { name: string; symbol: string };
    };
    spec.launchpadCoin.name = 'N'.repeat(32);
    spec.launchpadCoin.symbol = 'S'.repeat(10);
    // A template only the startup check stands in front of (106 bytes with the slug "moonpad").
    const rt = createRouteRuntime(h.deps);
    const long = {
      ...rt,
      metadataUriTemplate: `https://meta.forge.test/${'p'.repeat(70)}/{slug}.json`,
    };
    const error = await handleCreateConfigs(long, h.jobId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LaunchCoinError);
    expect((error as LaunchCoinError).code).toBe('TX_TOO_LARGE');
    // The same answer /v1/launch-coin/prepare would give, and nothing was created or recorded.
    expect(classifyError(error)).toMatchObject({ status: 422, code: 'launch_tx_too_large' });
    expect(h.chain.built.config).toBe(0);
    expect(h.chain.sendAttempts).toHaveLength(0);
    expect(await h.journals.configs.get(h.launchpadId)).toBeUndefined();
    expect(await ks.keystore.findRef(creatorRole(h.launchpadId))).toBeUndefined();

    // One byte shorter fits: the configs are created.
    const fits = {
      ...rt,
      metadataUriTemplate: `https://meta.forge.test/${'p'.repeat(69)}/{slug}.json`,
    };
    const body = await handleCreateConfigs(fits, h.jobId);
    expect(body.launchpadConfig).not.toBe(body.launchpadCoinConfig);
  });
});
