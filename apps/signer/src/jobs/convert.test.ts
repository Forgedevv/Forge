/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest';
import {
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Alerter } from '../alerts.js';
import {
  JUPITER_PROGRAM_ID,
  WSOL_MINT,
  createJupiterClient,
  createMemoryLedger,
  createRpcBalanceSource,
  createRpcSwapSender,
  ledgerKey,
  ledgerOf,
  parseConvertConfig,
  resolveConvertMode,
  runConvertOnce,
  runWindowKey,
  startConvert,
  validateQuote,
  verifySwapTransaction,
  type BalanceSource,
  type ConvertConfig,
  type ConvertDeps,
  type JupiterClient,
  type JupiterQuote,
  type SendResult,
  type SwapSender,
  type TokenBalance,
} from './convert.js';

const OWNER = Keypair.generate().publicKey.toBase58();
const MINT_A = Keypair.generate().publicKey.toBase58();
const MINT_B = Keypair.generate().publicKey.toBase58();
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const EXPECTATION = {
  inputMint: MINT_A,
  inAmount: 1000n,
  minOutLamports: 1n,
  forbiddenMints: [],
};

const config: ConvertConfig = parseConvertConfig({});

function quoteFor(
  mint: string,
  amount: bigint,
  over: Partial<Record<keyof JupiterQuote, unknown>> = {},
): JupiterQuote {
  return {
    inputMint: mint,
    outputMint: WSOL_MINT,
    inAmount: amount.toString(),
    outAmount: '500000000',
    otherAmountThreshold: '497500000',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0.0005',
    routePlan: [],
    ...over,
  } as JupiterQuote;
}

describe('resolveConvertMode', () => {
  it('is live only on mainnet-beta with the flag set to true', () => {
    expect(resolveConvertMode({ cluster: 'mainnet-beta', liveFlag: 'true' }).mode).toBe('live');
  });

  it.each([
    ['devnet', 'true'],
    ['devnet', undefined],
    ['mainnet-beta', undefined],
    ['mainnet-beta', 'false'],
    ['mainnet-beta', '1'],
    ['mainnet-beta', 'TRUE'],
    [undefined, 'true'],
    ['mainnet', 'true'],
  ])('is dry-run for cluster=%s flag=%s', (cluster, liveFlag) => {
    expect(resolveConvertMode({ cluster, liveFlag }).mode).toBe('dry-run');
  });
});

describe('parseConvertConfig', () => {
  it('has safe defaults', () => {
    expect(config.slippageBps).toBe(50);
    expect(config.maxSlippageBps).toBe(100);
    expect(config.jupiterUrl).toBe('https://api.jup.ag/swap/v1');
    expect(config.apiKey).toBeUndefined();
    expect(config.minRequestIntervalMs).toBeGreaterThanOrEqual(1000);
  });

  it('reads the API key and excludes the FORGE mint', () => {
    const c = parseConvertConfig({
      JUPITER_API_KEY: 'k',
      FORGE_MINT: MINT_A,
      CONVERT_EXCLUDED_MINTS: `${MINT_B}, `,
    });
    expect(c.apiKey).toBe('k');
    expect([...c.excludedMints].sort()).toEqual([MINT_A, MINT_B].sort());
  });

  it('refuses a slippage above the cap', () => {
    expect(() =>
      parseConvertConfig({ CONVERT_SLIPPAGE_BPS: '200', CONVERT_MAX_SLIPPAGE_BPS: '100' }),
    ).toThrow(/SLIPPAGE/);
    expect(() => parseConvertConfig({ CONVERT_SLIPPAGE_BPS: '9999' })).toThrow();
  });
});

describe('validateQuote', () => {
  const req = { inputMint: MINT_A, amount: 1000n };
  it('accepts a good quote', () => {
    expect(validateQuote(quoteFor(MINT_A, 1000n), req, config)).toBeNull();
  });

  it.each([
    ['input_mint_mismatch', { inputMint: MINT_B }],
    ['output_not_sol', { outputMint: MINT_B }],
    ['amount_mismatch', { inAmount: '999' }],
    ['not_exact_in', { swapMode: 'ExactOut' }],
    ['slippage_too_high', { slippageBps: 101 }],
    ['price_impact_too_high', { priceImpactPct: '0.02' }],
    ['invalid_price_impact', { priceImpactPct: 'abc' }],
    ['invalid_price_impact', { priceImpactPct: '-1' }],
    ['dust', { outAmount: '1000', otherAmountThreshold: '900' }],
    ['threshold_inconsistent', { otherAmountThreshold: '600000000' }],
  ])('rejects: %s', (reason, over) => {
    expect(validateQuote(quoteFor(MINT_A, 1000n, over), req, config)).toBe(reason);
  });
});

describe('runWindowKey', () => {
  it('is stable within a day and changes across days', () => {
    expect(runWindowKey(NOW)).toBe(runWindowKey(NOW + 3_600_000));
    expect(runWindowKey(NOW)).not.toBe(runWindowKey(NOW + 24 * 3_600_000));
  });
});

describe('Jupiter client', () => {
  function client(fetchMock: ReturnType<typeof vi.fn>, apiKey?: string) {
    return createJupiterClient({
      baseUrl: 'https://jup.example.test/swap/v1',
      apiKey,
      fetch: fetchMock as unknown as typeof fetch,
      minRequestIntervalMs: 0,
      timeoutMs: 1000,
    });
  }

  it('requests an ExactIn quote to wrapped SOL with the key header', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(quoteFor(MINT_A, 1000n)), { status: 200 }),
    );
    const q = await client(fetchMock, 'my-key').quote({
      inputMint: MINT_A,
      amount: 1000n,
      slippageBps: 50,
    });
    expect(q.outAmount).toBe('500000000');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe('/swap/v1/quote');
    expect(u.searchParams.get('inputMint')).toBe(MINT_A);
    expect(u.searchParams.get('outputMint')).toBe(WSOL_MINT);
    expect(u.searchParams.get('amount')).toBe('1000');
    expect(u.searchParams.get('slippageBps')).toBe('50');
    expect(u.searchParams.get('swapMode')).toBe('ExactIn');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('my-key');
  });

  it('omits the key header when no key is configured', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(quoteFor(MINT_A, 1000n)), { status: 200 }),
    );
    await client(fetchMock).quote({ inputMint: MINT_A, amount: 1000n, slippageBps: 50 });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('posts the quote to /swap with native SOL unwrapping', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ swapTransaction: 'AAAA', lastValidBlockHeight: 10 }), {
          status: 200,
        }),
    );
    const s = await client(fetchMock).swap({
      quote: quoteFor(MINT_A, 1000n),
      userPublicKey: OWNER,
    });
    expect(s.swapTransaction).toBe('AAAA');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://jup.example.test/swap/v1/swap');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.userPublicKey).toBe(OWNER);
    expect(body.wrapAndUnwrapSol).toBe(true);
    expect((body.quoteResponse as JupiterQuote).inAmount).toBe('1000');
  });

  it('turns HTTP errors, bad shapes and network failures into JupiterError without leaking the key', async () => {
    const q = { inputMint: MINT_A, amount: 1n, slippageBps: 50 };
    await expect(
      client(
        vi.fn(async () => new Response('x', { status: 429 })),
        'secret-key-value',
      ).quote(q),
    ).rejects.toMatchObject({ name: 'JupiterError', status: 429 });
    await expect(
      client(vi.fn(async () => new Response('{"a":1}', { status: 200 }))).quote(q),
    ).rejects.toThrow(/unexpected shape/);
    await expect(
      client(vi.fn(async () => new Response('not json', { status: 200 }))).quote(q),
    ).rejects.toThrow(/invalid JSON/);
    const boom = vi.fn(async () => {
      throw new TypeError('fetch failed secret-key-value');
    });
    const err = await client(boom, 'secret-key-value')
      .quote(q)
      .catch((e: Error) => e);
    expect((err as Error).message).not.toContain('secret-key-value');
  });

  it('spaces requests by the minimum interval', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(quoteFor(MINT_A, 1n)), { status: 200 }),
    );
    const c = createJupiterClient({
      baseUrl: 'https://x.test',
      fetch: fetchMock as unknown as typeof fetch,
      minRequestIntervalMs: 1000,
      timeoutMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await c.quote({ inputMint: MINT_A, amount: 1n, slippageBps: 50 });
    t += 200;
    await c.quote({ inputMint: MINT_A, amount: 1n, slippageBps: 50 });
    expect(sleeps).toEqual([800]);
  });
});

// ---------------------------------------------------------------------------------------------
// Job

function makeHarness(
  balances: TokenBalance[],
  overrides: Partial<ConvertDeps> & {
    quote?: JupiterClient['quote'];
    sendResult?: SendResult;
  } = {},
) {
  const alerts = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
  const alerter: Alerter = { alert: alerts as unknown as Alerter['alert'] };
  const quote = vi.fn(
    overrides.quote ?? (async ({ inputMint, amount }) => quoteFor(inputMint, amount)),
  );
  const swap = vi.fn(async () => ({ swapTransaction: 'dHg=', lastValidBlockHeight: 100 }));
  const send = vi.fn(
    async () => overrides.sendResult ?? ({ status: 'confirmed', signature: 'SIG1' } as SendResult),
  );
  const sender: SwapSender = { send };
  const balanceSource: BalanceSource = { list: async () => balances };
  const deps: ConvertDeps = {
    jupiter: { quote, swap } as JupiterClient,
    balances: balanceSource,
    sender,
    ledger: createMemoryLedger(),
    alerter,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config,
    cluster: 'mainnet-beta',
    liveFlag: 'true',
    now: () => NOW,
    ...overrides,
  };
  return { deps, quote, swap, send, alerts };
}

describe('runConvertOnce: dry-run', () => {
  it('quotes on devnet but never swaps, signs or sends', async () => {
    const { deps, quote, swap, send } = makeHarness(
      [{ owner: OWNER, mint: MINT_A, amount: 1000n }],
      {
        cluster: 'devnet',
        liveFlag: 'true',
      },
    );
    const r = await runConvertOnce(deps);
    expect(r.mode).toBe('dry-run');
    expect(r.items[0]?.outcome).toEqual({
      status: 'quoted',
      outAmount: 500_000_000n,
      slippageBps: 50,
    });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(swap).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('is dry-run on mainnet without the flag', async () => {
    const { deps, swap, send } = makeHarness([{ owner: OWNER, mint: MINT_A, amount: 1000n }], {
      liveFlag: undefined,
    });
    const r = await runConvertOnce(deps);
    expect(r.mode).toBe('dry-run');
    expect(swap).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not alert on quote failures (devnet has no Jupiter route)', async () => {
    const { deps, alerts } = makeHarness([{ owner: OWNER, mint: MINT_A, amount: 1000n }], {
      cluster: 'devnet',
      quote: async () => {
        throw new Error('no route');
      },
    });
    const r = await runConvertOnce(deps);
    expect(r.items[0]?.outcome).toMatchObject({ status: 'failed' });
    expect(alerts).not.toHaveBeenCalled();
  });

  it('does not write the ledger', async () => {
    const { deps } = makeHarness([{ owner: OWNER, mint: MINT_A, amount: 1000n }], {
      cluster: 'devnet',
    });
    await runConvertOnce(deps);
    expect(await ledgerOf(deps).get(ledgerKey(OWNER, MINT_A, runWindowKey(NOW)))).toBeUndefined();
  });
});

describe('runConvertOnce: live', () => {
  const balances: TokenBalance[] = [{ owner: OWNER, mint: MINT_A, amount: 1000n }];

  it('quotes, swaps, sends and records the confirmation', async () => {
    const { deps, quote, swap, send, alerts } = makeHarness(balances);
    const r = await runConvertOnce(deps);
    expect(r.mode).toBe('live');
    expect(r.items[0]?.outcome).toEqual({
      status: 'confirmed',
      signature: 'SIG1',
      outAmount: 500_000_000n,
    });
    expect(quote).toHaveBeenCalledWith({ inputMint: MINT_A, amount: 1000n, slippageBps: 50 });
    expect(swap).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      owner: OWNER,
      swapTransaction: 'dHg=',
      lastValidBlockHeight: 100,
      expected: expect.objectContaining({ inputMint: MINT_A, inAmount: 1000n }),
    });
    expect((await ledgerOf(deps).get(ledgerKey(OWNER, MINT_A, runWindowKey(NOW))))?.status).toBe(
      'confirmed',
    );
    expect(alerts.mock.calls.map((c) => c[1])).toEqual(['CONVERT_DONE']);
  });

  it('is idempotent within a window: a second run swaps nothing', async () => {
    const { deps, swap, send } = makeHarness(balances);
    await runConvertOnce(deps);
    const second = await runConvertOnce(deps);
    expect(second.items[0]?.outcome).toEqual({ status: 'skipped', reason: 'already_confirmed' });
    expect(swap).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('converts again in the next window', async () => {
    const h = makeHarness(balances);
    await runConvertOnce(h.deps);
    h.deps.now = () => NOW + 25 * 3_600_000;
    await runConvertOnce(h.deps);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('never retries an unknown outcome in the same window', async () => {
    const h = makeHarness(balances, { sendResult: { status: 'unknown', signature: 'SIGX' } });
    const first = await runConvertOnce(h.deps);
    expect(first.items[0]?.outcome).toEqual({ status: 'unknown', signature: 'SIGX' });
    expect(h.alerts.mock.calls.map((c) => c[1])).toContain('CONVERT_UNKNOWN');
    const second = await runConvertOnce(h.deps);
    expect(second.items[0]?.outcome).toEqual({ status: 'skipped', reason: 'already_submitted' });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the entry as submitted when sending throws', async () => {
    const h = makeHarness(balances);
    h.send.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await runConvertOnce(h.deps);
    expect(r.items[0]?.outcome).toMatchObject({ status: 'failed' });
    expect((await ledgerOf(h.deps).get(ledgerKey(OWNER, MINT_A, runWindowKey(NOW))))?.status).toBe(
      'submitted',
    );
    const again = await runConvertOnce(h.deps);
    expect(again.items[0]?.outcome).toEqual({ status: 'skipped', reason: 'already_submitted' });
  });

  it('records an on-chain failure and alerts', async () => {
    const h = makeHarness(balances, {
      sendResult: {
        status: 'failed',
        signature: 'SIGF',
        error: '{"InstructionError":[2,"Custom"]}',
      },
    });
    const r = await runConvertOnce(h.deps);
    expect(r.items[0]?.outcome).toMatchObject({ status: 'failed', signature: 'SIGF' });
    expect((await ledgerOf(h.deps).get(ledgerKey(OWNER, MINT_A, runWindowKey(NOW))))?.status).toBe(
      'failed',
    );
    expect(h.alerts.mock.calls.map((c) => c[1])).toEqual(['CONVERT_FAILED']);
  });

  it('refuses and alerts on a quote above the slippage cap, without swapping', async () => {
    const h = makeHarness(balances, {
      quote: async ({ inputMint, amount }) => quoteFor(inputMint, amount, { slippageBps: 300 }),
    });
    const r = await runConvertOnce(h.deps);
    expect(r.items[0]?.outcome).toEqual({ status: 'rejected', reason: 'slippage_too_high' });
    expect(h.swap).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.alerts.mock.calls.map((c) => c[1])).toEqual(['CONVERT_QUOTE_REFUSED']);
  });

  it('skips dust quietly', async () => {
    const h = makeHarness(balances, {
      quote: async ({ inputMint, amount }) =>
        quoteFor(inputMint, amount, { outAmount: '100', otherAmountThreshold: '99' }),
    });
    const r = await runConvertOnce(h.deps);
    expect(r.items[0]?.outcome).toEqual({ status: 'skipped', reason: 'dust' });
    expect(h.swap).not.toHaveBeenCalled();
    expect(h.alerts).not.toHaveBeenCalled();
  });

  it('skips SOL, excluded mints and empty balances without calling Jupiter', async () => {
    const h = makeHarness(
      [
        { owner: OWNER, mint: WSOL_MINT, amount: 5n },
        { owner: OWNER, mint: MINT_B, amount: 5n },
        { owner: OWNER, mint: MINT_A, amount: 0n },
      ],
      { config: { ...config, excludedMints: [MINT_B] } },
    );
    const r = await runConvertOnce(h.deps);
    expect(r.items.map((i) => i.outcome)).toEqual([
      { status: 'skipped', reason: 'already_sol' },
      { status: 'skipped', reason: 'excluded_mint' },
      { status: 'skipped', reason: 'empty' },
    ]);
    expect(h.quote).not.toHaveBeenCalled();
  });

  it('caps the input amount', async () => {
    const h = makeHarness([{ owner: OWNER, mint: MINT_A, amount: 5000n }], {
      config: { ...config, maxInputAmount: 1000n },
    });
    await runConvertOnce(h.deps);
    expect(h.quote).toHaveBeenCalledWith({ inputMint: MINT_A, amount: 1000n, slippageBps: 50 });
  });

  it('isolates a failing balance from the others', async () => {
    const h = makeHarness(
      [
        { owner: OWNER, mint: MINT_A, amount: 1000n },
        { owner: OWNER, mint: MINT_B, amount: 1000n },
      ],
      {
        quote: async ({ inputMint, amount }) => {
          if (inputMint === MINT_A) throw new Error('boom');
          return quoteFor(inputMint, amount);
        },
      },
    );
    const r = await runConvertOnce(h.deps);
    expect(r.items.map((i) => i.outcome.status)).toEqual(['failed', 'confirmed']);
  });

  it('refuses the swap when the mode no longer allows it at signing time', async () => {
    const h = makeHarness(balances);
    // flag flipped between the start of the run and the signing step
    let calls = 0;
    Object.defineProperty(h.deps, 'liveFlag', {
      get: () => (calls++ < 1 ? 'true' : 'false'),
    });
    const r = await runConvertOnce(h.deps);
    expect(r.items[0]?.outcome).toMatchObject({ status: 'failed' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('refuses a live swap without a sender', async () => {
    const h = makeHarness(balances, { sender: undefined as unknown as SwapSender });
    const r = await runConvertOnce(h.deps);
    expect(r.items[0]?.outcome).toMatchObject({ status: 'failed' });
    expect(h.swap).not.toHaveBeenCalled();
  });

  it('alerts when the balances cannot be read', async () => {
    const h = makeHarness([], {
      balances: {
        list: async () => {
          throw new TypeError('rpc');
        },
      },
    });
    const r = await runConvertOnce(h.deps);
    expect(r.items).toEqual([]);
    expect(h.alerts.mock.calls.map((c) => c[1])).toEqual(['CONVERT_BALANCES_FAILED']);
  });

  it('never puts a secret in an alert', async () => {
    const h = makeHarness(balances, {
      sendResult: { status: 'failed', signature: 'SIGF', error: 'x' },
    });
    await runConvertOnce(h.deps);
    expect(
      JSON.stringify(h.alerts.mock.calls, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toMatch(/apikey|secret|passphrase|private/i);
  });
});

describe('startConvert', () => {
  it('runs once per interval and stops', async () => {
    const h = makeHarness([], { cluster: 'devnet' });
    const list = vi.spyOn(h.deps.balances, 'list');
    const delays: number[] = [];
    const handle = startConvert(h.deps, 1234, async (ms) => {
      delays.push(ms);
      if (delays.length === 2) handle.stop();
    });
    await handle.done;
    expect(list).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1234, 1234]);
  });
});

// ---------------------------------------------------------------------------------------------
// Transaction checks and adapters

function buildTx(
  feePayer: Keypair,
  programId: string,
  extraSigner?: Keypair,
): VersionedTransaction {
  const keys = [{ pubkey: feePayer.publicKey, isSigner: true, isWritable: true }];
  if (extraSigner) keys.push({ pubkey: extraSigner.publicKey, isSigner: true, isWritable: false });
  const ix = new TransactionInstruction({
    programId: new PublicKey(programId),
    keys,
    data: Buffer.alloc(0),
  });
  const message = MessageV0.compile({
    payerKey: feePayer.publicKey,
    instructions: [ix],
    recentBlockhash: PublicKey.default.toBase58(),
  });
  return new VersionedTransaction(message);
}

describe('verifySwapTransaction', () => {
  const owner = Keypair.generate();
  it('accepts a Jupiter transaction paid and signed by the owner only', () => {
    expect(
      verifySwapTransaction(buildTx(owner, JUPITER_PROGRAM_ID), {
        owner: owner.publicKey.toBase58(), lookupTables: [], expected: EXPECTATION, maxPriorityFeeLamports: 1_000_000n,
      }),
    ).toEqual({ ok: true, feeBoundLamports: 5000n });
  });

  it('rejects another fee payer, extra signers and a missing Jupiter program', () => {
    const other = Keypair.generate();
    expect(
      verifySwapTransaction(buildTx(other, JUPITER_PROGRAM_ID), {
        owner: owner.publicKey.toBase58(), lookupTables: [], expected: EXPECTATION, maxPriorityFeeLamports: 1_000_000n,
      }),
    ).toEqual({ ok: false, reason: 'fee_payer_mismatch' });
    expect(
      verifySwapTransaction(buildTx(owner, JUPITER_PROGRAM_ID, other), {
        owner: owner.publicKey.toBase58(), lookupTables: [], expected: EXPECTATION, maxPriorityFeeLamports: 1_000_000n,
      }),
    ).toEqual({ ok: false, reason: 'extra_signers' });
    expect(
      verifySwapTransaction(
        buildTx(owner, SystemProgram.programId.toBase58()),
        { owner: owner.publicKey.toBase58(), lookupTables: [], expected: EXPECTATION, maxPriorityFeeLamports: 1_000_000n },
      ),
    ).toEqual({ ok: false, reason: 'system_instruction_not_allowed' });
  });
});

describe('createRpcSwapSender', () => {
  const owner = Keypair.generate();
  const base64 = Buffer.from(buildTx(owner, JUPITER_PROGRAM_ID).serialize()).toString('base64');

  function sender(
    statuses: ({ err: unknown; confirmationStatus: string } | null)[],
    extra: { blockHeight?: number } = {},
  ) {
    let t = 0;
    const sign = vi.fn(async (_owner: string, tx: VersionedTransaction) => {
      tx.sign([owner]);
    });
    const ownerKey = owner.publicKey;
    const ownerAccount = {
      data: Buffer.alloc(0),
      executable: false,
      lamports: 100_000_000,
      owner: SystemProgram.programId,
      rentEpoch: 0,
    };
    const connection = {
      sendRawTransaction: vi.fn(async () => 'SIGNATURE'),
      getSignatureStatuses: vi.fn(async () => ({ context: { slot: 10 }, value: [statuses.shift() ?? null] })),
      getBlockHeight: vi.fn(async () => extra.blockHeight ?? 0),
      getSlot: vi.fn(async () => 10),
      getTransaction: vi.fn(async () => null),
      getAddressLookupTable: vi.fn(async () => ({ context: { slot: 10 }, value: null })),
      getTokenAccountsByOwner: vi.fn(async () => ({ context: { slot: 10 }, value: [] })),
      getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({
        context: { slot: 10 },
        value: keys.map((key) => key.equals(ownerKey) ? ownerAccount : null),
      })),
      simulateTransaction: vi.fn(async (_tx: VersionedTransaction, config: { accounts: { addresses: string[] } }) => ({
        context: { slot: 10 },
        value: {
          err: null,
          accounts: config.accounts.addresses.map((address) => address === ownerKey.toBase58()
            ? { owner: SystemProgram.programId.toBase58(), lamports: ownerAccount.lamports, data: ['', 'base64'] }
            : null),
          logs: [],
          unitsConsumed: 1,
          returnData: null,
        },
      })),
    };
    const s = createRpcSwapSender({
      connection: connection as never,
      signTransaction: sign,
      confirmTimeoutMs: 10_000,
      pollIntervalMs: 1000,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    });
    return { s, sign, connection };
  }

  it('signs, sends and polls until confirmed', async () => {
    const { s, sign, connection } = sender([
      null,
      { err: null, confirmationStatus: 'processed' },
      { err: null, confirmationStatus: 'confirmed' },
    ]);
    const r = await s.send({ owner: owner.publicKey.toBase58(), swapTransaction: base64, expected: EXPECTATION });
    expect(r).toMatchObject({ status: 'confirmed' });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('reports an on-chain error', async () => {
    const { s } = sender([
      { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' },
    ]);
    const r = await s.send({ owner: owner.publicKey.toBase58(), swapTransaction: base64, expected: EXPECTATION });
    expect(r.status).toBe('failed');
  });

  it('reports unknown after the deadline', async () => {
    const { s } = sender([]);
    const r = await s.send({ owner: owner.publicKey.toBase58(), swapTransaction: base64, expected: EXPECTATION });
    expect(r).toMatchObject({ status: 'unknown' });
  });

  it('reports failed once the blockhash window has passed', async () => {
    const { s } = sender([], { blockHeight: 300 });
    const r = await s.send({
      owner: owner.publicKey.toBase58(),
      swapTransaction: base64,
      lastValidBlockHeight: 100,
      expected: EXPECTATION,
    });
    expect(r).toMatchObject({ status: 'failed', error: 'blockhash expired' });
  });

  it('refuses to sign a transaction that fails verification', async () => {
    const { s, sign, connection } = sender([]);
    expect(await s.send({ owner: Keypair.generate().publicKey.toBase58(), swapTransaction: base64, expected: EXPECTATION }))
      .toEqual({ status: 'refused', reason: 'fee_payer_mismatch' });
    expect(sign).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe('createRpcBalanceSource', () => {
  it('sums token accounts per mint across both token programs and skips frozen ones', async () => {
    const acct = (mint: string, amount: string, state = 'initialized') => ({
      account: { data: { parsed: { info: { mint, state, tokenAmount: { amount } } } } },
    });
    const getParsed = vi
      .fn()
      .mockResolvedValueOnce({
        value: [acct(MINT_A, '10'), acct(MINT_A, '5'), acct(MINT_B, '9', 'frozen')],
      })
      .mockResolvedValueOnce({ value: [acct(MINT_B, '7')] });
    const src = createRpcBalanceSource({ getParsedTokenAccountsByOwner: getParsed } as never, [
      OWNER,
    ]);
    expect(await src.list()).toEqual([
      { owner: OWNER, mint: MINT_A, amount: 15n },
      { owner: OWNER, mint: MINT_B, amount: 7n },
    ]);
  });
});
