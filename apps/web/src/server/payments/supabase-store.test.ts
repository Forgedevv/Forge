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
