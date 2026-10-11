// @vitest-environment node
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimPartnerFees } from '../actions';
import { setSession } from '../session-store';
import {
  SIG,
  encode,
  fakeConnection,
  id,
  json,
  mockFetch,
  partnerClaimTx,
  phases,
  setWallet,
  signIn,
} from './helpers';

const POOL = Keypair.generate().publicKey.toBase58();
const summary = (over: Record<string, unknown> = {}) => ({
  pool: POOL,
  tradingFeesLamports: '900000000',
  poolCreationFeeLamports: '10000000',
  ownerCostLamports: '2049280',
  remainingPools: 2,
  ...over,
});

beforeEach(() => {
  signIn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

describe('claimPartnerFees', () => {
  it('hands the claim summary to review before signing, then sends and returns it', async () => {
    const lp = id();
    const connection = fakeConnection();
    signIn(connection);
    const fetchFn = mockFetch(() =>
      json({ transaction: encode(partnerClaimTx()), summary: summary() }),
    );
    const order: string[] = [];
    const p = phases();
    const result = await claimPartnerFees(
      lp,
      (phase) => {
        order.push(phase);
        p.on(phase);
      },
      {
        review: async (s) => {
          order.push(`review:${s?.tradingFeesLamports}:${s?.remainingPools}`);
          return true;
        },
      },
    );
    expect(result).toEqual({ phase: 'confirmed', signature: SIG, summary: summary() });
    expect(order).toEqual(['review:900000000:2', 'awaiting_signature', 'sending', 'confirmed']);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(`/api/launchpads/${lp}/claim-transaction`);
    expect(connection!.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('signs nothing when the review is declined', async () => {
    const sign = vi.fn();
    setWallet(sign);
    mockFetch(() => json({ transaction: encode(partnerClaimTx()), summary: summary() }));
    const p = phases();
    const result = await claimPartnerFees(id(), p.on, { review: async () => false });
    expect(result).toEqual({ phase: 'idle', summary: summary() });
    expect(sign).not.toHaveBeenCalled();
    expect(p.list).toEqual([]);
  });

  it('reviews with null when the server sends no summary', async () => {
    mockFetch(() => json({ transaction: encode(partnerClaimTx()) }));
    const review = vi.fn().mockResolvedValue(true);
    const result = await claimPartnerFees(id(), () => undefined, { review });
    expect(review).toHaveBeenCalledWith(null);
    expect(result).toMatchObject({ phase: 'confirmed', summary: null });
  });

  it('reports rejected on user rejection', async () => {
    setWallet(async () => {
      throw Object.assign(new Error('x'), { code: 4001 });
    });
    mockFetch(() => json({ transaction: encode(partnerClaimTx()), summary: summary() }));
    const p = phases();
    await expect(claimPartnerFees(id(), p.on)).resolves.toMatchObject({ phase: 'rejected' });
    expect(p.list).toEqual(['awaiting_signature', 'rejected']);
  });

  it('keeps the signature when the claim fails on-chain', async () => {
    signIn(
      fakeConnection({
        getSignatureStatuses: vi
          .fn()
          .mockResolvedValue({ value: [{ err: { InstructionError: [3, 'x'] } }] }),
      }),
    );
    mockFetch(() => json({ transaction: encode(partnerClaimTx()), summary: summary() }));
    const result = await claimPartnerFees(id(), () => undefined);
    expect(result).toMatchObject({ phase: 'error', signature: SIG });
  });

  it('maps server refusals (nothing to claim, 401)', async () => {
    mockFetch(() =>
      json({ code: 'NOTHING_TO_CLAIM', message: 'There are no fees to claim right now.' }, 409),
    );
    await expect(claimPartnerFees(id(), () => undefined)).rejects.toMatchObject({
      message: 'There are no fees to claim right now.',
    });
    mockFetch(() => json({}, 401));
    await expect(claimPartnerFees(id(), () => undefined)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
