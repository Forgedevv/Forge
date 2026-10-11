// @vitest-environment node
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signOwnerTransaction } from '../actions';
import { base64ToBytes } from '../base58';
import { setSession } from '../session-store';
import {
  SIG,
  encode,
  id,
  json,
  launchTx,
  mockFetch,
  owner,
  phases,
  rejection,
  setWallet,
  signIn,
} from './helpers';

const summary = (wallet = owner.toBase58()) => ({
  coinName: 'Acme',
  coinSymbol: 'ACME',
  firstBuyLamports: '1',
  estimatedNetworkFeeLamports: '5000',
  ownerWallet: wallet,
});

beforeEach(() => {
  signIn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null);
});

describe('signOwnerTransaction', () => {
  it('signs the prepared launch and submits exactly that message', async () => {
    const jobId = id();
    const prepared = launchTx();
    const fetchFn = mockFetch((_url, init) =>
      init?.method === 'POST'
        ? json({ signature: SIG })
        : json({ transaction: encode(prepared), summary: summary(), simulation: 'ok' }),
    );
    const p = phases();
    const result = await signOwnerTransaction(jobId, p.on);
    expect(result).toEqual({ phase: 'confirmed', signature: SIG });
    expect(p.list).toEqual(['awaiting_signature', 'sending', 'confirmed']);
    const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/jobs/${jobId}/owner-transaction`);
    const body = JSON.parse(init.body as string) as { signedTransaction: string };
    expect(Object.keys(body)).toEqual(['signedTransaction']);
    const sent = VersionedTransaction.deserialize(base64ToBytes(body.signedTransaction));
    expect(sent.message.serialize()).toEqual(prepared.message.serialize());
  });

  it('throws WRONG_WALLET when the connected wallet is not the owner', async () => {
    const sign = vi.fn();
    setWallet(sign);
    mockFetch(() =>
      json({
        transaction: encode(launchTx()),
        summary: summary(Keypair.generate().publicKey.toBase58()),
      }),
    );
    const p = phases();
    await expect(signOwnerTransaction(id(), p.on)).rejects.toMatchObject({ code: 'WRONG_WALLET' });
    expect(sign).not.toHaveBeenCalled();
    expect(p.list).toEqual(['error']);
  });

  it('reports rejected when the user declines', async () => {
    setWallet(async () => {
      throw rejection();
    });
    const fetchFn = mockFetch(() => json({ transaction: encode(launchTx()), summary: summary() }));
    const p = phases();
    await expect(signOwnerTransaction(id(), p.on)).resolves.toEqual({ phase: 'rejected' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid transaction from the server', async () => {
    mockFetch(() => json({ transaction: 'AAAA', summary: summary() }));
    await expect(signOwnerTransaction(id(), () => undefined)).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  it.each([
    ['another fee payer', () => launchTx({ payer: Keypair.generate().publicKey }), /fee payer/],
    ['a missing FORGE signature', () => launchTx({ presign: false }), /missing a FORGE signature/],
  ])('refuses %s before the wallet is asked to sign', async (_label, build, message) => {
    const sign = vi.fn();
    setWallet(sign);
    const fetchFn = mockFetch(() => json({ transaction: encode(build()), summary: summary() }));
    const result = await signOwnerTransaction(id(), () => undefined);
    expect(result.phase).toBe('error');
    expect(result.error).toMatch(message);
    expect(sign).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not submit when the wallet changed the launch message', async () => {
    setWallet(async () => {
      const changed = launchTx();
      changed.signatures[0] = new Uint8Array(64).fill(7);
      return changed;
    });
    const fetchFn = mockFetch(() => json({ transaction: encode(launchTx()), summary: summary() }));
    const result = await signOwnerTransaction(id(), () => undefined);
    expect(result.phase).toBe('error');
    expect(result.error).toMatch(/changed the transaction/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
