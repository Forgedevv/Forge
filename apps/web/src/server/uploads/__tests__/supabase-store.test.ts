// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { UploadStoreError, type TicketRecord } from '../store';
import { conflictOf, parseTicketRow, SupabaseUploadStore, ticketToRow } from '../supabase-store';

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
  return { store: new SupabaseUploadStore(db as unknown as SupabaseClient), calls };
}

const TICKET: TicketRecord = {
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  launchpadId: '6f1c2b8e-4d4a-4c7e-9a43-0c2b5d1e7f10',
  wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  nonce: '0123456789abcdef0123456789abcdef',
  requestSha256: 'a'.repeat(64),
  mint: 'So11111111111111111111111111111111111111112',
  host: 'moonpad.forge-sites.app',
  contentType: 'image/png',
  imageSize: 1024,
  imageSha256: 'b'.repeat(64),
  imageKey: 'launchpads/moonpad/images/So11111111111111111111111111111111111111112.png',
  metadataKey: 'launchpads/moonpad/metadata/So11111111111111111111111111111111111111112.json',
  coinName: 'Moon Coin',
  coinSymbol: 'MOON',
  coinDescription: '',
  firstBuyLamports: '0',
  status: 'issued',
  rejection: null,
  metadataSha256: null,
  issuedAt: new Date('2026-10-11T12:00:00.000Z'),
  expiresAt: new Date('2026-10-11T12:10:00.000Z'),
  completedAt: null,
};

/** A row as PostgREST returns it (timestamps with an explicit offset). */
const ROW = {
  ...ticketToRow(TICKET),
  issued_at: '2026-10-11T12:00:00+00:00',
  expires_at: '2026-10-11T12:10:00+00:00',
  created_at: '2026-10-11T12:00:00.123456+00:00',
};

describe('SupabaseUploadStore', () => {
  it('round-trips a ticket row', () => {
    expect(parseTicketRow(ROW)).toEqual(TICKET);
    expect(() => parseTicketRow({ ...ROW, status: 'weird' })).toThrow(UploadStoreError);
  });

  it('inserts and maps unique violations by constraint name', async () => {
    const { store, calls } = fakeDb([
      {},
      {
        error: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "upload_tickets_wallet_nonce_key"',
        },
      },
      {
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "upload_tickets_mint_key"',
        },
      },
      {
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "upload_tickets_pkey"',
        },
      },
    ]);
    await expect(store.insertTicket(TICKET)).resolves.toEqual({ ok: true });
    expect(calls[0]).toEqual({ table: 'upload_tickets', ops: [['insert', [ticketToRow(TICKET)]]] });
    await expect(store.insertTicket(TICKET)).resolves.toEqual({ ok: false, conflict: 'nonce' });
    await expect(store.insertTicket(TICKET)).resolves.toEqual({ ok: false, conflict: 'mint' });
    await expect(store.insertTicket(TICKET)).resolves.toEqual({ ok: false, conflict: 'other' });
    expect(conflictOf({})).toBe('other');
  });

  it('throws a StoreError carrying the database code only', async () => {
    const { store } = fakeDb([
      { error: { code: '42501', message: 'permission denied for table' } },
    ]);
    const error = await store.insertTicket(TICKET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadStoreError);
    expect((error as Error).message).toBe('upload store insert ticket failed (42501)');
  });

  it('looks launchpads up by uuid or slug', async () => {
    const lp = {
      id: TICKET.launchpadId,
      slug: 'moonpad',
      status: 'live',
      launchpad_coin_mint: null,
    };
    const { store, calls } = fakeDb([{ data: lp }, { data: null }]);
    await expect(store.findLaunchpad({ slug: 'moonpad' })).resolves.toEqual({
      id: TICKET.launchpadId,
      slug: 'moonpad',
      status: 'live',
      coinMint: null,
    });
    expect(calls[0]!.ops).toEqual([
      ['select', ['id, slug, status, launchpad_coin_mint']],
      ['eq', ['slug', 'moonpad']],
      ['limit', [1]],
      ['maybeSingle', []],
    ]);
    await expect(store.findLaunchpad({ id: TICKET.launchpadId })).resolves.toBeNull();
    expect(calls[1]!.ops[1]).toEqual(['eq', ['id', TICKET.launchpadId]]);
  });

  it('reads tickets by nonce and recent issue times for the rate limits', async () => {
    const { store, calls } = fakeDb([
      { data: ROW },
      {
        data: [
          { issued_at: '2026-10-11T12:00:00+00:00' },
          { issued_at: '2026-10-11T12:01:00+00:00' },
        ],
      },
    ]);
    await expect(store.findTicketByNonce(TICKET.wallet, TICKET.nonce)).resolves.toEqual(TICKET);
    const since = new Date('2026-10-11T11:50:00.000Z');
    await expect(
      store.recentIssues({ launchpadId: TICKET.launchpadId }, since, 120),
    ).resolves.toEqual([
      new Date('2026-10-11T12:00:00.000Z'),
      new Date('2026-10-11T12:01:00.000Z'),
    ]);
    expect(calls[1]!.ops).toEqual([
      ['select', ['issued_at']],
      ['eq', ['launchpad_id', TICKET.launchpadId]],
      ['gte', ['issued_at', since.toISOString()]],
      ['order', ['issued_at', { ascending: true }]],
      ['limit', [120]],
    ]);
  });

  it('checks mints against tickets then launchpad coins', async () => {
    const { store } = fakeDb([{ data: [] }, { data: [{ id: 'lp' }] }, { data: [{ id: 't' }] }]);
    await expect(store.isMintTaken(TICKET.mint)).resolves.toBe(true);
    await expect(store.isMintTaken(TICKET.mint)).resolves.toBe(true);
  });

  it('completes only an issued ticket', async () => {
    const completed = {
      ...ROW,
      status: 'completed',
      metadata_sha256: 'c'.repeat(64),
      completed_at: '2026-10-11T12:02:00+00:00',
    };
    const { store, calls } = fakeDb([{ data: [completed] }, { data: [] }, { data: completed }]);
    const at = new Date('2026-10-11T12:02:00.000Z');
    await expect(store.markCompleted(TICKET.id, 'c'.repeat(64), at)).resolves.toMatchObject({
      status: 'completed',
      metadataSha256: 'c'.repeat(64),
      completedAt: at,
    });
    expect(calls[0]!.ops).toEqual([
      [
        'update',
        [{ status: 'completed', metadata_sha256: 'c'.repeat(64), completed_at: at.toISOString() }],
      ],
      ['eq', ['id', TICKET.id]],
      ['eq', ['status', 'issued']],
      ['select', ['*']],
    ]);
    // Already completed by a concurrent request: the stored row is returned.
    await expect(store.markCompleted(TICKET.id, 'c'.repeat(64), at)).resolves.toMatchObject({
      status: 'completed',
    });
  });
});
