import { describe, expect, it, vi } from 'vitest';
import { PayerReservations } from '../jobs/reservations.js';
import { ok, refused, setup, useTestKeystore } from './harness.js';

// Every FORGE signature decrypts a keystore key (scrypt): slow under a parallel test run.
vi.setConfig({ testTimeout: 60_000 });

const ks = useTestKeystore();
const FAST_RETRY = { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 };

describe('payer reservations', () => {
  it('drops a reservation once its blockhash is past the finalized height', async () => {
    const r = new PayerReservations();
    const rpc = { getBlockHeight: async () => 100 };
    expect(await r.outstanding(rpc, FAST_RETRY)).toBe(0n);
    r.reserve('a', 5n, 150);
    r.reserve('b', 7n, 99);
    expect(await r.outstanding(rpc, FAST_RETRY)).toBe(5n);
    expect(r.has('b')).toBe(false);
    r.release('a');
    expect(r.size).toBe(0);
    expect(() => r.reserve('c', -1n, 1)).toThrow();
  });

  it('subtracts the rent of creations in flight from the payer balance', async () => {
    const h = await setup(ks.keystore);
    const reservations = new PayerReservations();
    const routes = h.restart({ payerReservations: reservations });
    const second = h.addJob();
    const third = h.addJob();
    // Enough for exactly two config creations (rent + fee buffer each) and a little more.
    const perCreation = h.chain.configRent + 1_000_000n;
    h.chain.setBalance(h.payer, 2n * perCreation + 100_000n);
    h.chain.defaultBehavior = 'drop'; // sent, never landed: the balance does not move

    expect(refused(await routes.configs({ jobId: h.jobId })).error).toBe('confirmation_pending');
    expect(refused(await routes.configs({ jobId: second.jobId })).error).toBe(
      'confirmation_pending',
    );
    expect(reservations.size).toBe(2);
    // The balance still shows both rents, but they are promised: the third creation is refused.
    expect(refused(await routes.configs({ jobId: third.jobId }))).toEqual({
      status: 503,
      error: 'payer_low_balance',
    });
    expect(h.chain.built.config).toBe(3); // built, refused before any signature
    expect(h.alerter.codes()).toContain('payer_low_balance');

    // Once they land and settle, the reservations end and the next creation goes through.
    h.chain.defaultBehavior = 'land';
    h.chain.setBalance(h.payer, 1_000_000_000n);
    h.chain.advance(500); // the dropped ones expire, new attempts land
    ok(await routes.configs({ jobId: h.jobId }));
    expect(reservations.size).toBeLessThanOrEqual(1);
  });

  it('restores the reservation of a journaled creation after a restart', async () => {
    const h = await setup(ks.keystore);
    h.chain.defaultBehavior = 'drop';
    expect(refused(await h.routes.configs({ jobId: h.jobId })).error).toBe('confirmation_pending');
    const attempt = (await h.journals.configs.get(h.launchpadId))!.launchpad!.current!;
    expect(attempt.reservedLamports).toBe((h.chain.configRent + 1_000_000n).toString());

    const fresh = new PayerReservations();
    const restarted = h.restart({ payerReservations: fresh });
    expect(refused(await restarted.configs({ jobId: h.jobId })).error).toBe('confirmation_pending');
    expect(fresh.has(attempt.signature)).toBe(true);
  });
});
