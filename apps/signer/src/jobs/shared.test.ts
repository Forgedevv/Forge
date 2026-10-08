import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildSolTransferTx } from '../core-adapter.js';
import { openKeystore } from '../keystore.js';
import {
  JobError,
  MEMO_PROGRAM_ID,
  Mutex,
  assertCreatorClaimTx,
  assertSolTransferTx,
  awaitSettlement,
  base58Encode,
  broadcast,
  checkPaused,
  checkSettlement,
  createFileJournal,
  createPostgrestClient,
  describeError,
  formatSol,
  isTransientError,
  parseAddress,
  parseLamports,
  scrubText,
  signWithKeystore,
  silentJobLogger,
  startIntervalJob,
  withRetry,
  type SignatureState,
  type SolanaRpc,
} from './shared.js';
import {
  FakeChain,
  TransientRpcError,
  buildFakeClaimTx,
  memoryFlags,
  randomAddress,
} from './testing.js';

const noSleep = async () => undefined;
const retryFast = { attempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: noSleep };

describe('encoding and parsing', () => {
  it('base58-encodes like web3 (including leading zeros)', () => {
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(32);
      if (i % 5 === 0) bytes[0] = 0;
      if (i % 10 === 0) bytes[1] = 0;
      expect(base58Encode(bytes)).toBe(new PublicKey(bytes).toBase58());
    }
  });

  it('parses lamports strictly', () => {
    expect(parseLamports('300000000')).toBe(300_000_000n);
    expect(parseLamports(5)).toBe(5n);
    expect(parseLamports(7n)).toBe(7n);
    expect(parseLamports('18446744073709551615')).toBe(18_446_744_073_709_551_615n);
    for (const bad of [
      '-1',
      '1.5',
      '1e9',
      '',
      ' 1',
      '018446744073709551616',
      1.5,
      -1,
      2 ** 60,
      null,
      {},
    ]) {
      expect(() => parseLamports(bad)).toThrow(JobError);
    }
    expect(() => parseLamports('18446744073709551616')).toThrow(JobError);
  });

  it('formats SOL for display only', () => {
    expect(formatSol(1_000_000n)).toBe('0.001 SOL');
    expect(formatSol(2_500_000_000n)).toBe('2.5 SOL');
    expect(formatSol(0n)).toBe('0 SOL');
  });

  it('accepts only canonical, non-default addresses', () => {
    const a = randomAddress();
    expect(parseAddress(a.toBase58())?.equals(a)).toBe(true);
    expect(parseAddress('11111111111111111111111111111111')).toBeNull();
    expect(parseAddress('0OIl')).toBeNull();
    expect(parseAddress(42)).toBeNull();
  });
});

describe('error scrubbing', () => {
  it('removes URLs, query secrets, bearer tokens and key arrays', () => {
    const keyArray = `[${Array.from({ length: 64 }, (_, i) => i).join(',')}]`;
    const text = scrubText(
      `failed https://mainnet.helius-rpc.com/?api-key=abc123 token=xyz Bearer eyJhbGciOi.payload ${keyArray}`,
    );
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('helius');
    expect(text).not.toContain('xyz');
    expect(text).not.toContain('eyJhbGciOi');
    expect(text).not.toContain('63');
    expect(scrubText('x'.repeat(1_000)).length).toBeLessThan(310);
  });

  it('summarizes errors without their raw message', () => {
    const err = Object.assign(new Error('connect to http://10.0.0.1:8899?api-key=k failed'), {
      code: 'ECONNREFUSED',
    });
    expect(describeError(err)).toEqual({
      name: 'Error',
      code: 'ECONNREFUSED',
      message: 'connect to [url] failed',
    });
    expect(describeError('plain')).toEqual({ name: 'unknown', message: 'plain' });
  });
});

describe('withRetry', () => {
  it('retries transient errors with exponential backoff, capped', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw new TransientRpcError();
        return 'ok';
      },
      {
        attempts: 5,
        baseDelayMs: 500,
        maxDelayMs: 1_500,
        sleep: async (ms) => void delays.push(ms),
      },
    );
    expect(result).toBe('ok');
    expect(delays).toEqual([500, 1_000, 1_500]);
  });

  it('throws the last error after the attempts and never retries a program error', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new TransientRpcError();
      }, retryFast),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('Transaction simulation failed: custom program error: 0x1');
      }, retryFast),
    ).rejects.toThrow('custom program error');
    expect(calls).toBe(1);
  });

  it('classifies transient errors', () => {
    expect(isTransientError(new TransientRpcError())).toBe(true);
    expect(isTransientError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isTransientError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(
      isTransientError(
        new Error('fail', { cause: Object.assign(new Error('y'), { code: 'ECONNRESET' }) }),
      ),
    ).toBe(true);
    expect(isTransientError(new Error('insufficient funds'))).toBe(false);
    expect(isTransientError(new JobError('DB', 'x', { transient: true }))).toBe(true);
    expect(isTransientError(new JobError('TX_POLICY', 'x'))).toBe(false);
  });
});

describe('settlement', () => {
  function rpcWith(
    state: SignatureState | null,
    finalizedHeight: number,
    log: string[] = [],
  ): SolanaRpc {
    return {
      getLatestBlockhash: async () => ({ blockhash: 'x', lastValidBlockHeight: 0 }),
      getBlockHeight: async () => {
        log.push('height');
        return finalizedHeight;
      },
      getSignatureState: async () => {
        log.push('status');
        return state;
      },
      sendRawTransaction: async () => 'sig',
      getBalance: async () => 0n,
      getMinimumBalanceForRentExemption: async () => 0n,
    };
  }

  it('reads the finalized height BEFORE the signature status (expiry proof order)', async () => {
    const log: string[] = [];
    await checkSettlement(rpcWith(null, 10, log), 's', 5, retryFast);
    expect(log).toEqual(['height', 'status']);
  });

  it('declares expiry only past the last valid block height with no status', async () => {
    expect((await checkSettlement(rpcWith(null, 100, []), 's', 100, retryFast)).kind).toBe(
      'pending',
    );
    expect((await checkSettlement(rpcWith(null, 101, []), 's', 100, retryFast)).kind).toBe(
      'expired',
    );
    const landed: SignatureState = { slot: 1, confirmationStatus: 'confirmed', err: null };
    expect((await checkSettlement(rpcWith(landed, 500, []), 's', 100, retryFast)).kind).toBe(
      'confirmed',
    );
  });

  it('maps statuses: processed, finalized, failed', async () => {
    const at = (s: SignatureState) => checkSettlement(rpcWith(s, 0, []), 's', 100, retryFast);
    expect((await at({ slot: 1, confirmationStatus: 'processed', err: null })).kind).toBe(
      'processing',
    );
    expect((await at({ slot: 1, confirmationStatus: 'processed', err: { x: 1 } })).kind).toBe(
      'processing',
    );
    expect((await at({ slot: 1, confirmationStatus: 'finalized', err: null })).kind).toBe(
      'finalized',
    );
    const failed = await at({
      slot: 1,
      confirmationStatus: 'confirmed',
      err: { InstructionError: [0, 'X'] },
    });
    expect(failed).toMatchObject({ kind: 'failed' });
  });

  it('waits, re-broadcasting the same bytes, until finalized or timeout', async () => {
    const chain = new FakeChain();
    let t = 0;
    const sleep = async (ms: number) => {
      t += ms;
      chain.advance(5);
    };
    const raw = Uint8Array.from([1, 2, 3]);
    const send = vi.fn(async () => 'sig');
    const rpc: SolanaRpc = { ...chainRpc(chain), sendRawTransaction: send };
    const s = await awaitSettlement(rpc, 'unknown', {
      lastValidBlockHeight: chain.height + 10_000,
      raw,
      until: 'finalized',
      timeoutMs: 20_000,
      pollMs: 2_000,
      rebroadcastMs: 6_000,
      retry: retryFast,
      sleep,
      now: () => t,
    });
    expect(s.kind).toBe('pending');
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(send.mock.calls.every((c) => (c as unknown[])[0] === raw)).toBe(true);
  });

  function chainRpc(chain: FakeChain): SolanaRpc {
    return {
      getLatestBlockhash: () => chain.getLatestBlockhash(),
      getBlockHeight: (c) => chain.getBlockHeight(c),
      getSignatureState: (s) => chain.getSignatureState(s),
      sendRawTransaction: (r) => chain.sendRawTransaction(r),
      getBalance: (a, c) => chain.getBalance(a, c),
      getMinimumBalanceForRentExemption: (n) => chain.getMinimumBalanceForRentExemption(n),
    };
  }

  it('broadcast: already processed, rejected, transient exhausted', async () => {
    const make = (err: Error): SolanaRpc => ({
      ...rpcWith(null, 0),
      sendRawTransaction: async () => Promise.reject(err),
    });
    const raw = Uint8Array.from([1]);
    expect(
      await broadcast(
        make(
          new Error('Transaction simulation failed: This transaction has already been processed'),
        ),
        raw,
        retryFast,
      ),
    ).toEqual({ status: 'already_processed' });
    expect(
      (await broadcast(make(new Error('Transaction simulation failed: 0x1')), raw, retryFast))
        .status,
    ).toBe('rejected');
    await expect(broadcast(make(new TransientRpcError()), raw, retryFast)).rejects.toThrow();
  });
});

describe('file journal', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-journal-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const schema = z.object({ v: z.literal(1), n: z.number() });

  it('writes atomically, lists, deletes, and leaves no temp file', async () => {
    const j = createFileJournal({ dir, namespace: 'refunds', schema });
    await j.put('a-1', { v: 1, n: 1 });
    await j.put('a-1', { v: 1, n: 2 });
    await j.put('b_2', { v: 1, n: 3 });
    expect(await j.get('a-1')).toEqual({ v: 1, n: 2 });
    expect((await j.list()).map((e) => e.key)).toEqual(['a-1', 'b_2']);
    await j.delete('a-1');
    expect(await j.get('a-1')).toBeUndefined();
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // A second journal instance (restart) sees the same data.
    expect(await createFileJournal({ dir, namespace: 'refunds', schema }).get('b_2')).toEqual({
      v: 1,
      n: 3,
    });
    // Namespaces are isolated.
    expect(await createFileJournal({ dir, namespace: 'claims', schema }).list()).toEqual([]);
  });

  it('refuses corrupt entries and unsafe keys', async () => {
    const j = createFileJournal({ dir, namespace: 'refunds', schema });
    await fs.writeFile(path.join(dir, 'refunds.bad.json'), '{not json');
    await expect(j.get('bad')).rejects.toMatchObject({ code: 'JOURNAL_CORRUPT' });
    await fs.writeFile(path.join(dir, 'refunds.wrong.json'), JSON.stringify({ v: 2 }));
    await expect(j.get('wrong')).rejects.toMatchObject({ code: 'JOURNAL_CORRUPT' });
    await expect(j.put('../escape', { v: 1, n: 1 })).rejects.toThrow(JobError);
    await expect(j.put('a', { v: 1, n: 'x' } as never)).rejects.toThrow();
    expect(() => createFileJournal({ dir, namespace: '../x', schema })).toThrow(JobError);
  });
});

describe('transaction policy', () => {
  const from = randomAddress();
  const to = randomAddress();
  const blockhash = new PublicKey(randomBytes(32)).toBase58();
  const transfer = (lamports = 1_000n, memo: string | null = 'm') => {
    const tx = buildSolTransferTx({ from, to, lamports, ...(memo !== null ? { memo } : {}) });
    tx.feePayer = from;
    tx.recentBlockhash = blockhash;
    return tx;
  };

  it('accepts exactly the expected transfer', () => {
    expect(() =>
      assertSolTransferTx(transfer(), { from, to, lamports: 1_000n, memo: 'm' }),
    ).not.toThrow();
    expect(() => assertSolTransferTx(transfer(5n, null), { from, to, lamports: 5n })).not.toThrow();
  });

  it.each([
    ['another amount', () => transfer(1_001n), {}],
    ['another recipient', () => transfer(), { to: randomAddress() }],
    ['another memo', () => transfer(1_000n, 'x'), {}],
    ['a missing memo', () => transfer(1_000n, null), {}],
    [
      'a second transfer',
      () =>
        transfer().add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1n })),
      {},
    ],
    [
      'another fee payer',
      () => {
        const tx = transfer();
        tx.feePayer = to;
        return tx;
      },
      {},
    ],
    [
      'an extra signer',
      () =>
        transfer().add(
          SystemProgram.transfer({ fromPubkey: randomAddress(), toPubkey: from, lamports: 1n }),
        ),
      {},
    ],
    [
      'a huge priority fee',
      () =>
        transfer().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000n })),
      {},
    ],
    [
      'a memo with signer keys',
      () => {
        const tx = transfer();
        tx.instructions[1]!.keys.push({
          pubkey: randomAddress(),
          isSigner: true,
          isWritable: false,
        });
        return tx;
      },
      {},
    ],
    [
      'an unknown program',
      () =>
        transfer().add({ programId: randomAddress(), keys: [], data: Buffer.alloc(0) } as never),
      {},
    ],
  ])('rejects %s', (_name, build, over) => {
    const tx = (build as () => Transaction)();
    expect(() =>
      assertSolTransferTx(tx, { from, to, lamports: 1_000n, memo: 'm', ...over }),
    ).toThrow(JobError);
  });

  it('accepts a bounded compute budget', () => {
    const tx = transfer()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000n }));
    expect(() => assertSolTransferTx(tx, { from, to, lamports: 1_000n, memo: 'm' })).not.toThrow();
    expect(MEMO_PROGRAM_ID.toBase58()).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  });

  it('accepts the SDK creator-claim layout and rejects a different receiver', () => {
    const programId = randomAddress();
    const pool = randomAddress();
    const baseMint = randomAddress();
    const creator = randomAddress();
    const payer = randomAddress();
    const receiver = randomAddress();
    const tx = buildFakeClaimTx(programId, pool, baseMint, creator, receiver, payer);
    tx.feePayer = payer;
    tx.recentBlockhash = blockhash;
    const expected = {
      dbcProgramId: programId,
      pool,
      baseMint,
      creator,
      feePayer: payer,
      receiver,
    };
    expect(() => assertCreatorClaimTx(tx, expected)).not.toThrow();
    expect(() => assertCreatorClaimTx(tx, { ...expected, receiver: randomAddress() })).toThrow(
      JobError,
    );
    expect(() => assertCreatorClaimTx(tx, { ...expected, creator: randomAddress() })).toThrow(
      JobError,
    );
    expect(() => assertCreatorClaimTx(tx, { ...expected, feePayer: creator })).toThrow(JobError);
    expect(() => assertCreatorClaimTx(tx, { ...expected, dbcProgramId: randomAddress() })).toThrow(
      JobError,
    );
  });
});

describe('signing through the keystore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sign-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('signs, verifies, and refuses a ref whose key is not the expected one', async () => {
    const ks = await openKeystore({
      dir,
      passphrase: 'signing helper test passphrase, long enough',
      scrypt: { N: 1 << 14, r: 8, p: 1 },
    });
    const a = await ks.createKey('cashbox');
    const b = await ks.createKey('payer');
    const tx = buildSolTransferTx({ from: a.publicKey, to: b.publicKey, lamports: 1n });
    tx.feePayer = a.publicKey;
    tx.recentBlockhash = new PublicKey(randomBytes(32)).toBase58();
    const { raw, signature } = await signWithKeystore(ks, tx, [
      { ref: a.ref, expected: a.publicKey },
    ]);
    expect(Transaction.from(raw).verifySignatures()).toBe(true);
    expect(signature).toBe(base58Encode(tx.signature!));

    const other = buildSolTransferTx({ from: a.publicKey, to: b.publicKey, lamports: 1n });
    other.feePayer = a.publicKey;
    other.recentBlockhash = tx.recentBlockhash;
    await expect(
      signWithKeystore(ks, other, [{ ref: b.ref, expected: a.publicKey }]),
    ).rejects.toMatchObject({ code: 'SIGNER_MISMATCH' });
    // Missing signature: refused at serialization.
    const unsigned = buildSolTransferTx({ from: a.publicKey, to: b.publicKey, lamports: 1n });
    unsigned.feePayer = a.publicKey;
    unsigned.recentBlockhash = tx.recentBlockhash;
    await expect(signWithKeystore(ks, unsigned, [])).rejects.toMatchObject({ code: 'NOT_SIGNED' });
    await ks.close();
  });
});

describe('kill switches', () => {
  it('pauses on the flag, the env switch, or unreadable flags', async () => {
    const flags = memoryFlags({ refunds_paused: false });
    expect(await checkPaused(flags, 'refunds_paused', false, silentJobLogger)).toEqual({
      paused: false,
    });
    flags.values.refunds_paused = true;
    expect(await checkPaused(flags, 'refunds_paused', false, silentJobLogger)).toEqual({
      paused: true,
      reason: 'flag',
    });
    expect(await checkPaused(memoryFlags(), 'refunds_paused', true, silentJobLogger)).toEqual({
      paused: true,
      reason: 'config',
    });
    const broken = memoryFlags();
    broken.fail = true;
    expect(await checkPaused(broken, 'refunds_paused', false, silentJobLogger)).toEqual({
      paused: true,
      reason: 'flags_unavailable',
    });
  });
});

describe('concurrency and scheduling', () => {
  it('Mutex runs critical sections one at a time, in order', async () => {
    const m = new Mutex();
    const log: string[] = [];
    const task = (name: string, ms: number) =>
      m.runExclusive(async () => {
        log.push(`${name}+`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}-`);
      });
    await Promise.all([task('a', 20), task('b', 1), task('c', 5)]);
    expect(log).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  });

  it('startIntervalJob never overlaps runs, survives errors, and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let maxActive = 0;
      let runs = 0;
      const errors: string[] = [];
      const handle = startIntervalJob({
        name: 'test',
        intervalMs: 1_000,
        logger: { ...silentJobLogger, error: (_f, msg) => void errors.push(msg) },
        run: async () => {
          runs++;
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 2_500));
          active--;
          if (runs === 2) throw new Error('boom');
        },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(maxActive).toBe(1);
      expect(runs).toBeGreaterThanOrEqual(2);
      expect(errors).toContain('job run failed');
      const stopping = handle.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await stopping;
      const after = runs;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runs).toBe(after);
    } finally {
      vi.useRealTimers();
    }
    expect(() =>
      startIntervalJob({
        name: 'x',
        intervalMs: 10,
        logger: silentJobLogger,
        run: async () => undefined,
      }),
    ).toThrow(JobError);
  });
});

describe('PostgREST client', () => {
  const KEY = 'service-role-key-for-tests-0123456789';

  it('requires https (except localhost) and a key', () => {
    expect(() =>
      createPostgrestClient({ url: 'http://db.example.com', serviceRoleKey: KEY }),
    ).toThrow(JobError);
    expect(() =>
      createPostgrestClient({ url: 'http://localhost:54321', serviceRoleKey: KEY }),
    ).not.toThrow();
    expect(() =>
      createPostgrestClient({ url: 'https://x.supabase.co', serviceRoleKey: '' }),
    ).toThrow(JobError);
    expect(() => createPostgrestClient({ url: 'not a url', serviceRoleKey: KEY })).toThrow(
      JobError,
    );
  });

  it('never leaks the URL or the key in a network error, and retries it', async () => {
    let calls = 0;
    const client = createPostgrestClient({
      url: 'https://secret-project.supabase.co',
      serviceRoleKey: KEY,
      fetch: (async () => {
        calls++;
        throw Object.assign(new Error('getaddrinfo ENOTFOUND secret-project.supabase.co'), {
          code: 'ENOTFOUND',
        });
      }) as unknown as typeof fetch,
      retry: retryFast,
    });
    const err = (await client
      .select('flags', { select: 'key,value' })
      .catch((e: unknown) => e)) as Error;
    expect(calls).toBe(3);
    expect(err.message).not.toContain('secret-project');
    expect(err.message).not.toContain(KEY);
  });

  it('does not retry a 4xx and refuses an update without a filter', async () => {
    let calls = 0;
    const client = createPostgrestClient({
      url: 'https://x.supabase.co',
      serviceRoleKey: KEY,
      fetch: (async () => {
        calls++;
        return new Response(JSON.stringify({ code: '42501', message: 'permission denied' }), {
          status: 403,
        });
      }) as unknown as typeof fetch,
      retry: retryFast,
    });
    await expect(client.select('payments', {})).rejects.toThrow('HTTP 403 42501');
    expect(calls).toBe(1);
    await expect(client.update('payments', {}, { status: 'refunded' })).rejects.toThrow(
      /without filter/,
    );
    await expect(client.select('payments; drop', {})).rejects.toThrow(/table/);
  });
});
