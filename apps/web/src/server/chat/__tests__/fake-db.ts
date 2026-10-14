import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/*
 * A small in-memory stand-in for the PostgREST client, enough for the chat store: each statement
 * runs atomically on its own macrotask (so concurrent calls interleave between statements, like
 * separate requests on a real database), unique indexes raise 23505, and filters on an embedded
 * table (`conversations.owner_wallet`, `chat_messages.created_at`) behave like `!inner` joins.
 * Column lists are ignored: whole rows are returned.
 */

export type Row = Record<string, unknown>;

interface UniqueIndex {
  name: string;
  columns: string[];
  where?: (row: Row) => boolean;
}

type Filter = (row: Row, db: FakeDb, table: string) => boolean;

/** The FORGE schema subset used by the chat store (supabase/migrations 0001, 0005 and 0010). */
const UNIQUE: Record<string, UniqueIndex[]> = {
  users: [{ name: 'users_pkey', columns: ['wallet'] }],
  launchpads: [{ name: 'launchpads_slug_key', columns: ['slug'] }],
  jobs: [
    {
      name: 'jobs_one_open_create_per_launchpad_idx',
      columns: ['launchpad_id'],
      where: (row) => row.type === 'create_launchpad' && row.status !== 'refunded',
    },
  ],
  payments: [{ name: 'payments_tx_signature_key', columns: ['tx_signature'] }],
};

const DEFAULTS: Record<string, (db: FakeDb) => Row> = {
  conversations: () => ({ id: randomUUID(), launchpad_id: null, spec: null, cost_usd: 0 }),
  launchpads: () => ({ id: randomUUID(), status: 'draft' }),
  jobs: () => ({ id: randomUUID() }),
  payments: () => ({ id: randomUUID(), tx_signature: null, status: 'quoted' }),
  chat_messages: (db) => ({ id: ++db.serial }),
};

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const numeric = (v: unknown) =>
    typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
  if (numeric(a) && numeric(b)) return Number(a) === Number(b);
  return false;
}

function singular(table: string): string {
  return table.endsWith('s') ? table.slice(0, -1) : table;
}

export class FakeDb {
  tables: Record<string, Row[]> = {
    users: [],
    conversations: [],
    chat_messages: [],
    launchpads: [],
    jobs: [],
    payments: [],
    flags: [],
  };
  serial = 0;
  now: () => number = Date.now;
  /** Every statement, in execution order: `<op> <table>`. */
  log: string[] = [];
  /** Lets a test fail or delay a statement: return an error to make it fail. */
  beforeStatement: ((op: string, table: string) => { code: string } | void) | null = null;

  insert(table: string, row: Row): Row {
    const full = {
      ...DEFAULTS[table]?.(this),
      created_at: new Date(this.now()).toISOString(),
      ...row,
    };
    (this.tables[table] ??= []).push(full);
    return full;
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  /** Value of `ref.column` seen from a row of `table`: a forward or reverse relation. */
  related(table: string, row: Row, ref: string): Row[] {
    const forward = row[`${singular(ref)}_id`];
    if (forward !== undefined) return this.rows(ref).filter((r) => r.id === forward);
    return this.rows(ref).filter((r) => r[`${singular(table)}_id`] === row.id);
  }

  private violation(table: string, candidate: Row, ignore: Row | null): string | null {
    for (const index of UNIQUE[table] ?? []) {
      if (index.where && !index.where(candidate)) continue;
      if (index.columns.some((c) => candidate[c] === null || candidate[c] === undefined)) continue;
      const clash = this.rows(table).some(
        (r) =>
          r !== ignore &&
          (!index.where || index.where(r)) &&
          index.columns.every((c) => r[c] === candidate[c]),
      );
      if (clash) return index.name;
    }
    return null;
  }

  client(): SupabaseClient {
    return { from: (table: string) => new Query(this, table) } as unknown as SupabaseClient;
  }

  /** Runs one statement atomically. */
  execute(q: Query): {
    data: unknown;
    error: { code: string; message: string } | null;
    count: number | null;
  } {
    const err = (code: string, message = code) => ({
      data: null,
      error: { code, message },
      count: null,
    });
    this.log.push(`${q.op} ${q.table}`);
    const injected = this.beforeStatement?.(q.op, q.table);
    if (injected) return err(injected.code);
    const table = (this.tables[q.table] ??= []);
    const matches = () => table.filter((row) => q.filters.every((f) => f(row, this, q.table)));

    let result: Row[] = [];
    if (q.op === 'insert' || q.op === 'upsert') {
      for (const raw of q.payload as Row[]) {
        const row = {
          ...DEFAULTS[q.table]?.(this),
          created_at: new Date(this.now()).toISOString(),
          ...raw,
        };
        const clash = this.violation(q.table, row, null);
        if (clash) {
          if (q.op === 'upsert' && q.ignoreDuplicates) continue;
          return err('23505', `duplicate key value violates unique constraint "${clash}"`);
        }
        table.push(row);
        result.push(row);
      }
    } else if (q.op === 'update') {
      const targets = matches();
      for (const row of targets) {
        const next = { ...row, ...(q.payload as Row) };
        const clash = this.violation(q.table, next, row);
        if (clash) return err('23505', `duplicate key value violates unique constraint "${clash}"`);
      }
      for (const row of targets) Object.assign(row, q.payload as Row);
      result = targets;
    } else if (q.op === 'delete') {
      const targets = new Set(matches());
      this.tables[q.table] = table.filter((r) => !targets.has(r));
      result = [...targets];
    } else {
      result = matches();
      for (const [column, ascending] of q.orders) {
        result.sort((a, b) => {
          const x = a[column] as number | string;
          const y = b[column] as number | string;
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (q.limitRows !== null) result = result.slice(0, q.limitRows);
    }

    const copies = result.map((r) => structuredClone(r));
    if (q.head) return { data: null, error: null, count: copies.length };
    if (q.op !== 'select' && !q.returning) return { data: null, error: null, count: null };
    if (q.isSingle || q.isMaybeSingle) {
      if (copies.length > 1 || (q.isSingle && copies.length === 0)) return err('PGRST116');
      return { data: copies[0] ?? null, error: null, count: null };
    }
    return { data: copies, error: null, count: q.count ? copies.length : null };
  }
}

class Query {
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  payload: unknown = null;
  filters: Filter[] = [];
  orders: [string, boolean][] = [];
  limitRows: number | null = null;
  isSingle = false;
  isMaybeSingle = false;
  head = false;
  count = false;
  returning = false;
  ignoreDuplicates = false;

  constructor(
    private readonly db: FakeDb,
    readonly table: string,
  ) {}

  private column(path: string, test: (value: unknown) => boolean): this {
    const dot = path.indexOf('.');
    if (dot < 0) {
      this.filters.push((row) => test(row[path]));
    } else {
      const ref = path.slice(0, dot);
      const col = path.slice(dot + 1);
      this.filters.push((row, db, table) => db.related(table, row, ref).some((r) => test(r[col])));
    }
    return this;
  }

  select(_columns?: string, opts?: { count?: string; head?: boolean }): this {
    if (this.op === 'select') {
      this.head = opts?.head === true;
      this.count = opts?.count !== undefined;
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(rows: Row | Row[]): this {
    this.op = 'insert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], opts?: { ignoreDuplicates?: boolean }): this {
    this.op = 'upsert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.ignoreDuplicates = opts?.ignoreDuplicates === true;
    return this;
  }
  update(patch: Row): this {
    this.op = 'update';
    this.payload = patch;
    return this;
  }
  delete(): this {
    this.op = 'delete';
    return this;
  }
  eq(column: string, value: unknown): this {
    return this.column(column, (v) => same(v, value));
  }
  is(column: string, value: null): this {
    return this.column(column, (v) => v === value || v === undefined);
  }
  in(column: string, values: unknown[]): this {
    return this.column(column, (v) => values.some((x) => same(v, x)));
  }
  gte(column: string, value: string | number): this {
    return this.column(column, (v) => (v as string | number) >= value);
  }
  order(column: string, opts?: { ascending?: boolean }): this {
    this.orders.push([column, opts?.ascending !== false]);
    return this;
  }
  limit(n: number, opts?: { referencedTable?: string }): this {
    if (!opts?.referencedTable) this.limitRows = n;
    return this;
  }
  single(): this {
    this.isSingle = true;
    return this;
  }
  maybeSingle(): this {
    this.isMaybeSingle = true;
    return this;
  }

  then<T>(
    resolve: (value: ReturnType<FakeDb['execute']>) => T,
    reject?: (reason: unknown) => T,
  ): Promise<T> {
    return new Promise<ReturnType<FakeDb['execute']>>((done) =>
      setImmediate(() => done(this.db.execute(this))),
    ).then(resolve, reject);
  }
}
