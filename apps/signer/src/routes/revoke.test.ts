import { SystemProgram } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { deserializeTransactionBase64 } from '@forge/core';
import { isJobError } from '../jobs/shared.js';
import { RouteError } from './errors.js';
import { ok, refused, setup, useTestKeystore, type Harness } from './harness.js';
import { assertRevokeNonceTx } from './policy.js';
import { buildRevokeNonceTx, revokeLaunch, type RevokeDeps } from './revoke.js';
import type { SignerLaunchPrepareResult } from './schemas.js';
import { chainSleep, randomKey, uuid } from './testing.js';

// Every FORGE signature decrypts a keystore key (scrypt): slow under a parallel test run.
vi.setConfig({ testTimeout: 60_000 });

const ks = useTestKeystore();

async function prepared(h: Harness): Promise<SignerLaunchPrepareResult> {
  ok(await h.routes.configs({ jobId: h.jobId }));
  return ok(await h.routes.launchCoinPrepare({ jobId: h.jobId }));
}

async function clientSends(h: Harness, base64: string): Promise<string> {
  const tx = deserializeTransactionBase64(base64);
  tx.partialSign(h.owner);
  return h.chain.sendRawTransaction(tx.serialize({ requireAllSignatures: true }));
}

function revokeDeps(h: Harness): RevokeDeps {
  return {
    core: h.chain,
    rpc: h.chain,
    keystore: ks.keystore,
    journals: h.journals,
    alerter: h.alerter,
    logger: h.logger,
    onBeforeSend: (signature) => void h.expected.push(signature),
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined },
    settle: { timeoutMs: 30_000, pollMs: 2_000, rebroadcastMs: 6_000 },
    sleep: chainSleep(h.chain),
  };
}

async function routeError(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RouteError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error('expected a RouteError');
}

describe('launch revocation (--revoke-launch)', () => {
  it('invalidates a handed-out launch, journals it, and lets the next prepare rebuild', async () => {
    const h = await setup(ks.keystore);
    const first = await prepared(h);
    const nonceAccount = first.details!.nonceAccount;
    const oldNonce = h.chain.accounts.get(nonceAccount)!.nonce!.value;
    const payerBefore = h.chain.balanceOf(h.payer);

    const result = await revokeLaunch(revokeDeps(h), h.jobId);
    expect(result).toMatchObject({
      status: 'revoked',
      jobId: h.jobId,
      nonceAccount,
      revokedNonce: oldNonce,
      mint: first.mint,
    });
    if (result.status !== 'revoked') throw new Error('unreachable');
    expect(h.expected).toContain(result.signature); // announced before the broadcast
    expect(h.chain.accounts.get(nonceAccount)!.nonce!.value).not.toBe(oldNonce);
    expect(h.chain.balanceOf(h.payer)).toBe(payerBefore - 10_000n); // two signatures, fee only
    expect(await h.journals.revocations.get(h.jobId)).toMatchObject({
      status: 'confirmed',
      nonceValue: oldNonce,
      mint: first.mint,
      current: { signature: result.signature },
    });
    expect(h.alerter.codes()).toContain('launch_revoked');

    // The handed-out transaction can never land now.
    await expect(clientSends(h, first.partiallySignedTx)).rejects.toThrow(/Blockhash not found/);
    // The next prepare proves (finalized) that nothing launched and builds a new transaction.
    h.chain.advance(100);
    const second = ok(await h.routes.launchCoinPrepare({ jobId: h.jobId }));
    expect(second.mint).not.toBe(first.mint);
    expect(await h.journals.launches.get(h.jobId)).toMatchObject({
      builds: 2,
      replacedMints: [first.mint],
    });
    await clientSends(h, second.partiallySignedTx);
    expect(h.chain.accounts.has(second.mint)).toBe(true);
  });

  it('is idempotent: a second run reports the same revocation and sends nothing', async () => {
    const h = await setup(ks.keystore);
    await prepared(h);
    const first = await revokeLaunch(revokeDeps(h), h.jobId);
    const sends = h.chain.sendAttempts.length;
    expect(await revokeLaunch(revokeDeps(h), h.jobId)).toEqual(first);
    expect(h.chain.sendAttempts).toHaveLength(sends);
  });

  it('sends nothing when the nonce already moved (the launch landed)', async () => {
    const h = await setup(ks.keystore);
    const body = await prepared(h);
    await clientSends(h, body.partiallySignedTx);
    const sends = h.chain.sendAttempts.length;
    expect(await revokeLaunch(revokeDeps(h), h.jobId)).toEqual({
      status: 'already_advanced',
      jobId: h.jobId,
      nonceAccount: body.details!.nonceAccount,
      mint: body.mint,
    });
    expect(h.chain.sendAttempts).toHaveLength(sends);
    expect(await h.journals.revocations.get(h.jobId)).toBeUndefined();
  });

  it('keeps prepare from handing out the revoked transaction while the revocation settles', async () => {
    const h = await setup(ks.keystore);
    const first = await prepared(h);
    h.chain.defaultBehavior = 'drop';
    const pending = await revokeLaunch(revokeDeps(h), h.jobId);
    expect(pending.status).toBe('pending');
    expect(refused(await h.routes.launchCoinPrepare({ jobId: h.jobId }))).toEqual({
      status: 503,
      error: 'launch_revoking',
    });
    expect(h.alerter.codes()).not.toContain('route_launch_revoking');

    // The dropped one expires; the next run sends a new one, which lands.
    h.chain.defaultBehavior = 'land';
    h.chain.advance(500);
    const done = await revokeLaunch(revokeDeps(h), h.jobId);
    expect(done.status).toBe('revoked');
    const entry = (await h.journals.revocations.get(h.jobId))!;
    expect(entry.history).toEqual([expect.objectContaining({ outcome: 'expired' })]);
    await expect(clientSends(h, first.partiallySignedTx)).rejects.toThrow(/Blockhash not found/);
  });

  it('refuses an unknown job, a malformed job id and a job without a prepared launch', async () => {
    const h = await setup(ks.keystore);
    expect(await routeError(revokeLaunch(revokeDeps(h), 'not-a-uuid'))).toEqual({
      status: 400,
      code: 'invalid_job_id',
    });
    expect(await routeError(revokeLaunch(revokeDeps(h), uuid()))).toEqual({
      status: 404,
      code: 'launch_not_prepared',
    });
    ok(await h.routes.configs({ jobId: h.jobId }));
    expect(await routeError(revokeLaunch(revokeDeps(h), h.jobId))).toEqual({
      status: 404,
      code: 'launch_not_prepared',
    });
    expect(h.chain.sendAttempts).toHaveLength(2); // the two configs only
  });

  it('refuses when the payer cannot pay the fee, before signing', async () => {
    const h = await setup(ks.keystore);
    await prepared(h);
    h.chain.setBalance(h.payer, 1_000n);
    const sends = h.chain.sendAttempts.length;
    expect(await routeError(revokeLaunch(revokeDeps(h), h.jobId))).toEqual({
      status: 503,
      code: 'payer_low_balance',
    });
    expect(h.chain.sendAttempts).toHaveLength(sends);
    expect(await h.journals.revocations.get(h.jobId)).toBeUndefined();
  });
});

describe('revoke transaction policy', () => {
  const payer = randomKey();
  const nonceAccount = randomKey();
  const authority = randomKey();
  const base = () =>
    buildRevokeNonceTx({
      payer,
      nonceAccount,
      authority,
      blockhash: randomKey().toBase58(),
      lastValidBlockHeight: 100,
    });
  const expected = { payer, nonceAccount, authority };

  it('accepts the nonce advance alone', () => {
    expect(() => assertRevokeNonceTx(base(), expected)).not.toThrow();
  });

  const tampered: Array<[string, () => ReturnType<typeof base>]> = [
    [
      'a transfer from the payer',
      () =>
        base().add(
          SystemProgram.transfer({ fromPubkey: payer, toPubkey: randomKey(), lamports: 1 }),
        ),
    ],
    [
      'a nonce withdrawal by the creator',
      () =>
        base().add(
          SystemProgram.nonceWithdraw({
            noncePubkey: nonceAccount,
            authorizedPubkey: authority,
            toPubkey: randomKey(),
            lamports: 1,
          }),
        ),
    ],
    [
      'another nonce account',
      () =>
        buildRevokeNonceTx({
          payer,
          nonceAccount: randomKey(),
          authority,
          blockhash: randomKey().toBase58(),
          lastValidBlockHeight: 100,
        }),
    ],
    [
      'a second advance',
      () =>
        base().add(
          SystemProgram.nonceAdvance({ noncePubkey: nonceAccount, authorizedPubkey: authority }),
        ),
    ],
    [
      'another fee payer',
      () => {
        const tx = base();
        tx.feePayer = authority;
        return tx;
      },
    ],
  ];
  for (const [name, build] of tampered) {
    it(`refuses ${name}`, () => {
      let error: unknown;
      try {
        assertRevokeNonceTx(build(), expected);
      } catch (err) {
        error = err;
      }
      expect(isJobError(error, 'TX_POLICY')).toBe(true);
    });
  }
});
