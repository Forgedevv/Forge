import type { SupabaseClient } from '@supabase/supabase-js';
import { StoreError } from './errors';
import type { PriceReference, PriceReferenceStore } from './price-source';

/*
 * The last SOL/USD rate accepted by the quote guard (GuardedPriceSource), kept in
 * `price_references` (migration 0014) so that a fresh server instance starts from it. Server only,
 * with the service role key: RLS is on with no policy, so clients can neither read nor write it.
 */

export const SOL_USD_PAIR = 'SOL/USD';

export class SupabasePriceReferenceStore implements PriceReferenceStore {
  constructor(private readonly db: SupabaseClient) {}

  async load(): Promise<PriceReference | null> {
    const res = await this.db
      .from('price_references')
      .select('price, accepted_at')
      .eq('pair', SOL_USD_PAIR)
      .maybeSingle();
    if (res.error) throw new StoreError('read price reference', res.error.code);
    const row = res.data as { price?: unknown; accepted_at?: unknown } | null;
    if (!row) return null;
    const price = typeof row.price === 'string' ? Number(row.price) : row.price;
    const at = typeof row.accepted_at === 'string' ? Date.parse(row.accepted_at) : Number.NaN;
    if (typeof price !== 'number' || !Number.isFinite(price) || !Number.isFinite(at)) return null;
    return { price, at };
  }

  async save(reference: PriceReference): Promise<void> {
    const res = await this.db.from('price_references').upsert(
      {
        pair: SOL_USD_PAIR,
        price: reference.price,
        accepted_at: new Date(reference.at).toISOString(),
      },
      { onConflict: 'pair' },
    );
    if (res.error) throw new StoreError('write price reference', res.error.code);
  }
}
