// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { StoreError } from './errors';
import { parsePaymentRow } from './store';
import { SupabasePaymentsStore } from './supabase-store';

interface Result {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

/** Chainable PostgREST builder double recording every call. */
function fakeDb(results: Result[]) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  let next = 0;
  const db = {
    from(table: string) {
      const entry = { table, ops: [] as [string, unknown[]][] };
      calls.push(entry);
      const result = results[next++] ?? {};
      const builder: unknown = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(
                  resolve,
                  reject,
                );
            }
            return (...args: unknown[]) => {
              entry.ops.push([String(prop), args]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return { store: new SupabasePaymentsStore(db as unknown as SupabaseClient), calls };
}

const ROW = {
  id: 'p1',
  job_id: 'j1',
  payer_wallet: 'w',
  kind: 'creation',
  usd_amount: '33',
  lamports: '9007199254740993',
  quote_expires_at: '2026-10-09T12:02:00+00:00',
  tx_signature: null,
  status: 'quoted',
};

describe('SupabasePaymentsStore', () => {
  it('records a signature only on an unsigned quoted or expired payment', async () => {
    const { store, calls } = fakeDb([{ data: [{ id: 'p1' }] }]);
    await expect(store.confirmPayment('p1', 'sig')).resolves.toBe('confirmed');
    expect(calls[0]).toEqual({
      table: 'payments',
      ops: [
        ['update', [{ status: 'confirmed', tx_signature: 'sig' }]],
        ['eq', ['id', 'p1']],
        ['in', ['status', ['quoted', 'expired']]],
        ['is', ['tx_signature', null]],
        ['select', ['id']],
      ],
    });
  });

  it('maps no row to not_updated and a unique violation to signature_taken', async () => {
    const { store } = fakeDb([{ data: [] }, { error: { code: '23505', message: 'dup' } }]);
    await expect(store.confirmPayment('p1', 'sig')).resolves.toBe('not_updated');
    await expect(store.confirmPayment('p2', 'sig')).resolves.toBe('signature_taken');
  });

  it('throws a StoreError carrying the code only', async () => {
    const { store } = fakeDb([{ error: { code: '57014', message: 'value secret-ish' } }]);
    const error = await store.confirmPayment('p1', 'sig').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).dbCode).toBe('57014');
    expect((error as Error).message).not.toContain('secret');
  });

  it('moves a job only from the expected status', async () => {
    const { store, calls } = fakeDb([{ data: [{ id: 'j1' }] }, { data: [] }]);
    await expect(store.transitionJob('j1', 'spec_ready', 'paid')).resolves.toBe(true);
    await expect(store.transitionJob('j1', 'spec_ready', 'paid')).resolves.toBe(false);
    expect(calls[0]!.ops).toEqual([
      ['update', [{ status: 'paid' }]],
      ['eq', ['id', 'j1']],
      ['eq', ['status', 'spec_ready']],
      ['select', ['id']],
    ]);
  });

  it('compare-and-sets the included modifications counter', async () => {
    const { store, calls } = fakeDb([{ data: [{ id: 'l1' }] }]);
    await expect(store.setIncludedModificationsLeft('l1', 2, 1)).resolves.toBe(true);
    expect(calls[0]!.ops).toContainEqual(['eq', ['included_modifications_left', 2]]);
    await expect(store.setIncludedModificationsLeft('l1', 0, -1)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('inserts quotes with lamports as an exact decimal string', async () => {
    const { store, calls } = fakeDb([{ data: ROW }]);
    const created = await store.insertQuote({
      jobId: 'j1',
      payerWallet: 'w',
      kind: 'creation',
      usdAmount: 33,
      lamports: 9_007_199_254_740_993n,
      quoteExpiresAt: new Date('2026-10-09T12:02:00Z'),
    });
    const insert = calls[0]!.ops[0]!;
    expect(insert[0]).toBe('insert');
    expect(insert[1][0]).toMatchObject({ lamports: '9007199254740993', status: 'quoted' });
    expect(created.lamports).toBe(9_007_199_254_740_993n);
  });

  it('records a payment anomaly once per signature, lamports as a decimal string', async () => {
    const { store, calls } = fakeDb([{ data: null }, { error: { code: '23505', message: 'dup' } }]);
    const anomaly = {
      jobId: 'j1',
      paymentId: 'p1',
      wallet: 'w',
      signature: 'sig',
      lamports: 9_007_199_254_740_993n,
      reason: 'late' as const,
      note: null,
    };
    await expect(store.recordPaymentAnomaly(anomaly)).resolves.toBe('recorded');
    await expect(store.recordPaymentAnomaly(anomaly)).resolves.toBe('exists');
    expect(calls[0]).toEqual({
      table: 'payment_anomalies',
      ops: [
        [
          'insert',
          [
            {
              job_id: 'j1',
              payment_id: 'p1',
              wallet: 'w',
              signature: 'sig',
              lamports: '9007199254740993',
              reason: 'late',
              note: null,
            },
          ],
        ],
      ],
    });
    const unknown = fakeDb([{}]);
    await unknown.store.recordPaymentAnomaly({ ...anomaly, lamports: null });
    expect(unknown.calls[0]!.ops[0]![1][0]).toMatchObject({ lamports: null });
    const broken = fakeDb([{ error: { code: '42501', message: 'denied' } }]);
    await expect(broken.store.recordPaymentAnomaly(anomaly)).rejects.toBeInstanceOf(StoreError);
  });

  it('resolves the open anomaly of a signature recorded for another payment, keeping its note', async () => {
    const open = { id: 'a1', payment_id: 'pA', note: 'confirmation rejected (memo_mismatch)' };
    const { store, calls } = fakeDb([{ data: open }, { data: [{ id: 'a1' }] }]);
    await expect(store.resolvePaidAnomaly('sig', 'pB', 'paid pB')).resolves.toBe(1);
    expect(calls[0]!.ops).toEqual([
      ['select', ['id, payment_id, note']],
      ['eq', ['signature', 'sig']],
      ['is', ['resolved_at', null]],
      ['maybeSingle', []],
    ]);
    const [update, ...filters] = calls[1]!.ops;
    expect(update![0]).toBe('update');
    expect(update![1][0]).toMatchObject({ note: 'confirmation rejected (memo_mismatch); paid pB' });
    expect(Date.parse((update![1][0] as { resolved_at: string }).resolved_at)).not.toBeNaN();
    expect(filters).toEqual([
      ['eq', ['id', 'a1']],
      ['is', ['resolved_at', null]],
      ['select', ['id']],
    ]);
    // Nothing open, or the anomaly of that same payment (a duplicate): nothing written.
    for (const data of [null, { ...open, payment_id: 'pB' }]) {
      const none = fakeDb([{ data }]);
      await expect(none.store.resolvePaidAnomaly('sig', 'pB', 'paid pB')).resolves.toBe(0);
      expect(none.calls).toHaveLength(1);
    }
    // The note stays within the column limit.
    const long = fakeDb([{ data: { ...open, note: 'x'.repeat(995) } }, { data: [] }]);
    await expect(long.store.resolvePaidAnomaly('sig', 'pB', 'paid pB')).resolves.toBe(0);
    expect((long.calls[1]!.ops[0]![1][0] as { note: string }).note).toHaveLength(1000);
    const broken = fakeDb([{ error: { code: '42501', message: 'denied' } }]);
    await expect(broken.store.resolvePaidAnomaly('sig', 'pB', 'x')).rejects.toBeInstanceOf(
      StoreError,
    );
  });

  it('finds the oldest open paid quote of a job and payer', async () => {
    const { store, calls } = fakeDb([{ data: [ROW] }]);
    const found = await store.findOpenQuote({
      jobId: 'j1',
      payerWallet: 'w',
      kind: 'creation',
      expiresAfter: new Date('2026-10-09T12:01:00Z'),
    });
    expect(found?.id).toBe('p1');
    expect(calls[0]!.ops).toEqual([
      ['select', ['*']],
      ['eq', ['job_id', 'j1']],
      ['eq', ['payer_wallet', 'w']],
      ['eq', ['kind', 'creation']],
      ['eq', ['status', 'quoted']],
      ['is', ['tx_signature', null]],
      ['gt', ['lamports', 0]],
      ['gt', ['quote_expires_at', '2026-10-09T12:01:00.000Z']],
      ['order', ['created_at', { ascending: true }]],
      ['order', ['id', { ascending: true }]],
      ['limit', [1]],
    ]);
  });

  it('lists the confirmed payments of a job in creation order', async () => {
    const { store, calls } = fakeDb([
      { data: [ROW, { ...ROW, id: 'p2', status: 'confirmed', tx_signature: 's' }] },
    ]);
    const rows = await store.listConfirmedPaymentsForJob('j1');
    expect(rows.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(calls[0]!.ops).toContainEqual(['eq', ['status', 'confirmed']]);
    expect(calls[0]!.ops).toContainEqual(['order', ['created_at', { ascending: true }]]);
  });

  it('expires and confirms included payments with conditional updates', async () => {
    const { store, calls } = fakeDb([{ data: [{ id: 'p1' }] }, { data: [] }]);
    await expect(store.markPaymentExpired('p1')).resolves.toBe(true);
    await expect(store.confirmIncludedPayment('p1')).resolves.toBe(false);
    expect(calls[0]!.ops).toContainEqual(['is', ['tx_signature', null]]);
    expect(calls[1]!.ops).toContainEqual(['eq', ['lamports', 0]]);
  });
});

describe('parsePaymentRow', () => {
  it('parses PostgREST numerics exactly and rejects malformed rows', () => {
    const row = parsePaymentRow(ROW);
    expect(row).toMatchObject({ usdAmount: 33, lamports: 9_007_199_254_740_993n });
    expect(row.quoteExpiresAt).toBe(Date.parse('2026-10-09T12:02:00Z'));
    expect(() => parsePaymentRow({ ...ROW, lamports: '1.5' })).toThrow(StoreError);
    expect(() => parsePaymentRow({ ...ROW, status: 'paid' })).toThrow(StoreError);
  });
});
