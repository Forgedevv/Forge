/// <reference types="node" />
import { createHash } from 'node:crypto';
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
  DEFAULT_CONVERT_MAX_INPUT_AMOUNT,
  JUPITER_EXACT_OUT_INSTRUCTIONS,
  JUPITER_PROGRAM_ID,
  JUPITER_ROUTE_INSTRUCTIONS,
  JUPITER_SWAP_VARIANTS,
  WSOL_MINT,
  checkJupiterRoute,
  createJupiterClient,
  createMemoryLedger,
  createRpcBalanceSource,
  createRpcSwapSender,
  decodeJupiterRoute,
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
  type JupiterRouteName,
  type SendResult,
  type SwapExpectation,
  type SwapSender,
  type TokenBalance,
} from './convert.js';

const OWNER = Keypair.generate().publicKey.toBase58();
const MINT_A = Keypair.generate().publicKey.toBase58();
const MINT_B = Keypair.generate().publicKey.toBase58();
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const EXPECTATION: SwapExpectation = {
  inputMint: MINT_A,
  inAmount: 1000n,
  minOutLamports: 1n,
  quotedOutAmount: 500n,
  maxSlippageBps: 100,
  forbiddenMints: [],
};

// ---------------------------------------------------------------------------------------------
// Hand-built Jupiter v6 instruction data (Borsh, layouts of the published IDL)

const anchorDiscriminator = (name: string) =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u8 = (v: number) => Buffer.from([v]);
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
/** Borsh tag of a `Swap` variant, by name. */
const swapTag = (name: string) => {
  const index = JUPITER_SWAP_VARIANTS.findIndex(([n]) => n === name);
  if (index < 0) throw new Error(`no Swap variant ${name}`);
  return index;
};
/** A `Swap` value: tag then payload. */
const swap = (name: string, ...payload: Buffer[]) => Buffer.concat([u8(swapTag(name)), ...payload]);
/** v1 RoutePlanStep: swap, percent, input_index, output_index. */
const step = (s: Buffer, percent = 100) => Buffer.concat([s, u8(percent), u8(0), u8(1)]);
/** v2 RoutePlanStepV2: swap, bps (u16), input_index, output_index. */
const stepV2 = (s: Buffer, bps = 10_000) => Buffer.concat([s, u16(bps), u8(0), u8(1)]);
const plan = (...steps: Buffer[]) => Buffer.concat([u32(steps.length), ...steps]);

interface RouteArgs {
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps?: number;
}

const GOOD_ARGS: RouteArgs = { inAmount: 1000n, quotedOutAmount: 500n, slippageBps: 50 };
const WHIRLPOOL_PLAN = plan(step(swap('Whirlpool', u8(1))));
const WHIRLPOOL_PLAN_V2 = plan(stepV2(swap('Whirlpool', u8(1))));

function routeData(
  name: JupiterRouteName,
  args: RouteArgs = GOOD_ARGS,
  routePlan?: Buffer,
): Buffer {
  const id = name.startsWith('shared_accounts') ? [u8(7)] : [];
  const fee = args.platformFeeBps ?? 0;
  if (name.endsWith('_v2')) {
    return Buffer.concat([
      anchorDiscriminator(name),
      ...id,
      u64(args.inAmount),
      u64(args.quotedOutAmount),
      u16(args.slippageBps),
      u16(fee),
      u16(0), // positive_slippage_bps
      routePlan ?? WHIRLPOOL_PLAN_V2,
    ]);
  }
  return Buffer.concat([
    anchorDiscriminator(name),
    ...id,
    routePlan ?? WHIRLPOOL_PLAN,
    u64(args.inAmount),
    u64(args.quotedOutAmount),
    u16(args.slippageBps),
    u8(fee),
  ]);
}

const ROUTE_NAMES: JupiterRouteName[] = [
  'route',
  'shared_accounts_route',
  'route_v2',
  'shared_accounts_route_v2',
];

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

  it('caps one swap by default (1 000 USDC in raw units), still configurable', () => {
    expect(DEFAULT_CONVERT_MAX_INPUT_AMOUNT).toBe(1_000_000_000n);
    expect(config.maxInputAmount).toBe(DEFAULT_CONVERT_MAX_INPUT_AMOUNT);
    expect(parseConvertConfig({ CONVERT_MAX_INPUT_AMOUNT: '5000' }).maxInputAmount).toBe(5000n);
    expect(parseConvertConfig({ CONVERT_MAX_INPUT_AMOUNT: '0' }).maxInputAmount).toBe(0n);
    expect(() => parseConvertConfig({ CONVERT_MAX_INPUT_AMOUNT: '-1' })).toThrow();
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

  it('requires the API key when the conversion runs live, never in dry-run', () => {
    const live = { FORGE_CONVERT_LIVE: 'true' };
    for (const key of [undefined, '', '  ']) {
      expect(() =>
        parseConvertConfig({ ...live, JUPITER_API_KEY: key }, { cluster: 'mainnet-beta' }),
      ).toThrow(/JUPITER_API_KEY is required/);
    }
    // Without the runtime's cluster, SOLANA_CLUSTER decides (devnet by default).
    expect(() => parseConvertConfig({ ...live, SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(
      /JUPITER_API_KEY/,
    );
    expect(
      parseConvertConfig({ ...live, JUPITER_API_KEY: 'k' }, { cluster: 'mainnet-beta' }).apiKey,
    ).toBe('k');
    // Dry-run: devnet (whatever the flag), or mainnet-beta without the flag.
    expect(parseConvertConfig(live).apiKey).toBeUndefined();
    expect(parseConvertConfig(live, { cluster: 'devnet' }).apiKey).toBeUndefined();
    expect(
      parseConvertConfig({ SOLANA_CLUSTER: 'mainnet-beta' }, { cluster: 'mainnet-beta' }).apiKey,
    ).toBeUndefined();
    // The runtime's cluster wins over the raw variable.
    expect(() =>
      parseConvertConfig({ ...live, SOLANA_CLUSTER: 'mainnet-beta' }, { cluster: 'devnet' }),
    ).not.toThrow();
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
      // The route instruction is bound to the validated quote and the configured slippage cap.
      expected: expect.objectContaining({
        inputMint: MINT_A,
        inAmount: 1000n,
        minOutLamports: 497_500_000n,
        quotedOutAmount: 500_000_000n,
        maxSlippageBps: 100,
      }),
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

  it('caps the input amount by default', async () => {
    const h = makeHarness([{ owner: OWNER, mint: MINT_A, amount: 5n * 1_000_000_000n }]);
    await runConvertOnce(h.deps);
    expect(h.quote).toHaveBeenCalledWith({
      inputMint: MINT_A,
      amount: DEFAULT_CONVERT_MAX_INPUT_AMOUNT,
      slippageBps: 50,
    });
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

/** One instruction of `programId` per entry of `datas` (default: one valid `route`). */
function buildTx(
  feePayer: Keypair,
  programId: string,
  extraSigner?: Keypair,
  datas: Buffer[] = [routeData('route')],
): VersionedTransaction {
  const keys = [{ pubkey: feePayer.publicKey, isSigner: true, isWritable: true }];
  if (extraSigner) keys.push({ pubkey: extraSigner.publicKey, isSigner: true, isWritable: false });
  const instructions = datas.map(
    (data) => new TransactionInstruction({ programId: new PublicKey(programId), keys, data }),
  );
  const message = MessageV0.compile({
    payerKey: feePayer.publicKey,
    instructions,
    recentBlockhash: PublicKey.default.toBase58(),
  });
  return new VersionedTransaction(message);
}

describe('decodeJupiterRoute', () => {
  it('uses the Anchor discriminators of the IDL instruction names', () => {
    for (const [name, spec] of Object.entries(JUPITER_ROUTE_INSTRUCTIONS)) {
      expect(Buffer.from(spec.discriminator)).toEqual(anchorDiscriminator(name));
    }
    for (const [name, discriminator] of Object.entries(JUPITER_EXACT_OUT_INSTRUCTIONS)) {
      expect(Buffer.from(discriminator)).toEqual(anchorDiscriminator(name));
    }
  });

  it('keeps the Swap variants in the order of the published IDL', () => {
    expect(JUPITER_SWAP_VARIANTS).toHaveLength(152);
    expect(JUPITER_SWAP_VARIANTS[0]).toEqual(['Saber', []]);
    expect(JUPITER_SWAP_VARIANTS[8]).toEqual(['Crema', ['bool']]);
    expect(JUPITER_SWAP_VARIANTS[12]).toEqual(['Serum', ['side']]);
    expect(JUPITER_SWAP_VARIANTS[17]).toEqual(['Whirlpool', ['bool']]);
    expect(JUPITER_SWAP_VARIANTS[29]).toEqual(['Symmetry', ['u64', 'u64']]);
    expect(JUPITER_SWAP_VARIANTS[33]).toEqual(['StakeDexSwapViaStake', ['u32']]);
    expect(JUPITER_SWAP_VARIANTS[38]).toEqual(['MeteoraDlmm', []]);
    expect(JUPITER_SWAP_VARIANTS[43]).toEqual(['SanctumS', ['u8', 'u8', 'u32', 'u32']]);
    expect(JUPITER_SWAP_VARIANTS[47]).toEqual([
      'WhirlpoolSwapV2',
      ['bool', 'optionRemainingAccountsInfo'],
    ]);
    expect(JUPITER_SWAP_VARIANTS[61]).toEqual(['SolFi', ['bool']]);
  });

  it.each(ROUTE_NAMES)('decodes %s', (name) => {
    expect(
      decodeJupiterRoute(
        routeData(name, {
          inAmount: 12n,
          quotedOutAmount: 34n,
          slippageBps: 56,
          platformFeeBps: 7,
        }),
      ),
    ).toEqual({
      ok: true,
      route: {
        instruction: name,
        inAmount: 12n,
        quotedOutAmount: 34n,
        slippageBps: 56,
        platformFeeBps: 7,
      },
    });
  });

  it('walks a v1 route plan through variants with payloads to reach the amounts', () => {
    const remainingAccounts = Buffer.concat([u32(2), u8(0), u8(2), u8(6), u8(1)]);
    const routePlan = plan(
      step(swap('Symmetry', u64(1n), u64(2n)), 20),
      step(swap('WhirlpoolSwapV2', u8(1), u8(1), remainingAccounts), 20),
      step(swap('WhirlpoolSwapV2', u8(0), u8(0)), 10),
      step(swap('MeteoraDlmmSwapV2', remainingAccounts), 10),
      step(swap('JupiterRfqV2', u8(1), u32(3), Buffer.from([9, 9, 9])), 10),
      step(swap('VaultLiquidUnstake', Buffer.alloc(40, 1), u64(5n)), 10),
      step(swap('Scorch', Buffer.alloc(16, 2)), 5),
      step(swap('Hylo', u8(7)), 5),
      // DynamicV1 { candidate_swaps: [HumidiFi { swap_id, is_base_to_quote }, Whirlpool], best_position: Some(1) }
      step(swap('DynamicV1', u32(2), u8(0), u64(9n), u8(1), u8(5), u8(0), u8(1), u8(1)), 5),
      // DynamicV2 { candidate_swaps: [WhirlpoolV2 { a_to_b, None } with bps], 3, 4 }
      step(swap('DynamicV2', u32(1), u8(10), u8(1), u8(0), u32(10_000), u8(3), u8(4)), 5),
    );
    expect(decodeJupiterRoute(routeData('route', GOOD_ARGS, routePlan))).toEqual({
      ok: true,
      route: { instruction: 'route', ...GOOD_ARGS, platformFeeBps: 0 },
    });
  });

  it('reads the v2 amounts without depending on the route plan', () => {
    // Unknown variant in the plan: the program reads the amounts first anyway.
    const decoded = decodeJupiterRoute(routeData('route_v2', GOOD_ARGS, plan(Buffer.from([255]))));
    expect(decoded).toMatchObject({ ok: true, route: { inAmount: 1000n, slippageBps: 50 } });
  });

  it('refuses trailing bytes after a v1 route (they could carry fake amounts)', () => {
    // What the program reads: 100% slippage, nothing quoted. Then appended "good" amounts that a
    // decoder reading from the end would take.
    const spoof = Buffer.concat([
      routeData('route', { inAmount: 1000n, quotedOutAmount: 1n, slippageBps: 10_000 }),
      u64(1000n),
      u64(500n),
      u16(50),
      u8(0),
    ]);
    expect(decodeJupiterRoute(spoof)).toEqual({ ok: false, reason: 'jupiter_route_undecodable' });
  });

  it.each([
    ['an unknown Swap variant', plan(step(Buffer.from([JUPITER_SWAP_VARIANTS.length])))],
    ['an invalid bool', plan(step(swap('Whirlpool', u8(2))))],
    ['an invalid Side', plan(step(swap('Serum', u8(2))))],
    ['an invalid Option tag', plan(step(swap('WhirlpoolSwapV2', u8(1), u8(2))))],
    ['a plan length larger than the data', Buffer.concat([u32(1_000_000), u8(0)])],
  ])('refuses a v1 route with %s', (_label, routePlan) => {
    expect(decodeJupiterRoute(routeData('route', GOOD_ARGS, routePlan))).toEqual({
      ok: false,
      reason: 'jupiter_route_undecodable',
    });
  });

  it('refuses truncated data', () => {
    for (const name of ROUTE_NAMES) {
      const data = routeData(name);
      // v1: everything is read; v2: the amounts and the route plan length prefix.
      const end = name.endsWith('_v2') ? data.length - WHIRLPOOL_PLAN_V2.length + 4 : data.length;
      for (const cut of [9, end - 1]) {
        expect(decodeJupiterRoute(data.subarray(0, cut))).toEqual({
          ok: false,
          reason: 'jupiter_route_undecodable',
        });
      }
    }
  });

  it('refuses the exact-out routes', () => {
    for (const name of Object.keys(JUPITER_EXACT_OUT_INSTRUCTIONS)) {
      expect(
        decodeJupiterRoute(Buffer.concat([anchorDiscriminator(name), Buffer.alloc(40)])),
      ).toEqual({ ok: false, reason: 'jupiter_route_not_exact_in' });
    }
  });

  it.each([
    'route_with_token_ledger',
    'shared_accounts_route_with_token_ledger',
    'set_token_ledger',
    'create_token_account',
    'close_token',
    'claim',
    'claim_token',
  ])('refuses any other Jupiter instruction: %s', (name) => {
    expect(
      decodeJupiterRoute(Buffer.concat([anchorDiscriminator(name), Buffer.alloc(40)])),
    ).toEqual({ ok: false, reason: 'jupiter_instruction_not_allowed' });
  });

  it('refuses data shorter than a discriminator', () => {
    expect(decodeJupiterRoute(Buffer.alloc(0))).toEqual({
      ok: false,
      reason: 'jupiter_instruction_not_allowed',
    });
    expect(decodeJupiterRoute(anchorDiscriminator('route').subarray(0, 7))).toEqual({
      ok: false,
      reason: 'jupiter_instruction_not_allowed',
    });
  });
});

describe('checkJupiterRoute', () => {
  const route = { instruction: 'route' as const, ...GOOD_ARGS, platformFeeBps: 0 };
  it('accepts the quoted input, no fee, a slippage at the cap and at least the quoted output', () => {
    expect(checkJupiterRoute(route, EXPECTATION)).toBeNull();
    expect(
      checkJupiterRoute({ ...route, slippageBps: 100, quotedOutAmount: 501n }, EXPECTATION),
    ).toBeNull();
  });

  it.each([
    ['jupiter_route_amount_mismatch', { inAmount: 999n }],
    ['jupiter_route_amount_mismatch', { inAmount: 1001n }],
    ['jupiter_route_platform_fee', { platformFeeBps: 1 }],
    ['jupiter_route_slippage_too_high', { slippageBps: 101 }],
    ['jupiter_route_quoted_out_too_low', { quotedOutAmount: 499n }],
  ])('refuses: %s', (reason, over) => {
    expect(checkJupiterRoute({ ...route, ...over }, EXPECTATION)).toBe(reason);
  });
});

describe('verifySwapTransaction', () => {
  const owner = Keypair.generate();
  const params = (expected: SwapExpectation = EXPECTATION) => ({
    owner: owner.publicKey.toBase58(),
    lookupTables: [],
    expected,
    maxPriorityFeeLamports: 1_000_000n,
  });
  const verifyRoute = (...datas: Buffer[]) =>
    verifySwapTransaction(buildTx(owner, JUPITER_PROGRAM_ID, undefined, datas), params());

  it('accepts a Jupiter transaction paid and signed by the owner only', () => {
    expect(verifySwapTransaction(buildTx(owner, JUPITER_PROGRAM_ID), params())).toEqual({
      ok: true,
      feeBoundLamports: 5000n,
    });
  });

  it.each(ROUTE_NAMES)('accepts a %s instruction that matches the quote', (name) => {
    expect(verifyRoute(routeData(name))).toEqual({ ok: true, feeBoundLamports: 5000n });
  });

  it.each(ROUTE_NAMES)('refuses a %s instruction above the slippage cap', (name) => {
    expect(verifyRoute(routeData(name, { ...GOOD_ARGS, slippageBps: 101 }))).toEqual({
      ok: false,
      reason: 'jupiter_route_slippage_too_high',
    });
    // 100% slippage: the on-chain minimum would be zero.
    expect(verifyRoute(routeData(name, { ...GOOD_ARGS, slippageBps: 10_000 }))).toEqual({
      ok: false,
      reason: 'jupiter_route_slippage_too_high',
    });
  });

  it.each(ROUTE_NAMES)('refuses a %s instruction quoting less than the quote', (name) => {
    expect(verifyRoute(routeData(name, { ...GOOD_ARGS, quotedOutAmount: 499n }))).toEqual({
      ok: false,
      reason: 'jupiter_route_quoted_out_too_low',
    });
  });

  it('refuses a route selling another amount or taking a platform fee', () => {
    expect(verifyRoute(routeData('route', { ...GOOD_ARGS, inAmount: 2000n }))).toEqual({
      ok: false,
      reason: 'jupiter_route_amount_mismatch',
    });
    expect(verifyRoute(routeData('route_v2', { ...GOOD_ARGS, platformFeeBps: 30 }))).toEqual({
      ok: false,
      reason: 'jupiter_route_platform_fee',
    });
  });

  it('refuses any other Jupiter instruction, including empty data', () => {
    expect(verifyRoute(Buffer.alloc(0))).toEqual({
      ok: false,
      reason: 'jupiter_instruction_not_allowed',
    });
    expect(
      verifyRoute(
        Buffer.concat([anchorDiscriminator('route_with_token_ledger'), Buffer.alloc(32)]),
      ),
    ).toEqual({ ok: false, reason: 'jupiter_instruction_not_allowed' });
    expect(
      verifyRoute(Buffer.concat([anchorDiscriminator('exact_out_route'), Buffer.alloc(32)])),
    ).toEqual({ ok: false, reason: 'jupiter_route_not_exact_in' });
  });

  it('refuses a second route instruction', () => {
    expect(verifyRoute(routeData('route'), routeData('route_v2'))).toEqual({
      ok: false,
      reason: 'jupiter_multiple_routes',
    });
  });

  it('refuses an expectation that would bound nothing', () => {
    const tx = buildTx(owner, JUPITER_PROGRAM_ID);
    for (const over of [
      { quotedOutAmount: 0n },
      { maxSlippageBps: 10_001 },
      { maxSlippageBps: 1.5 },
    ]) {
      expect(verifySwapTransaction(tx, params({ ...EXPECTATION, ...over }))).toEqual({
        ok: false,
        reason: 'expectation_invalid',
      });
    }
  });

  it('rejects another fee payer, extra signers and a missing Jupiter program', () => {
    const other = Keypair.generate();
    expect(
      verifySwapTransaction(buildTx(other, JUPITER_PROGRAM_ID), {
        owner: owner.publicKey.toBase58(),
        lookupTables: [],
        expected: EXPECTATION,
        maxPriorityFeeLamports: 1_000_000n,
      }),
    ).toEqual({ ok: false, reason: 'fee_payer_mismatch' });
    expect(
      verifySwapTransaction(buildTx(owner, JUPITER_PROGRAM_ID, other), {
        owner: owner.publicKey.toBase58(),
        lookupTables: [],
        expected: EXPECTATION,
        maxPriorityFeeLamports: 1_000_000n,
      }),
    ).toEqual({ ok: false, reason: 'extra_signers' });
    expect(
      verifySwapTransaction(buildTx(owner, SystemProgram.programId.toBase58()), {
        owner: owner.publicKey.toBase58(),
        lookupTables: [],
        expected: EXPECTATION,
        maxPriorityFeeLamports: 1_000_000n,
      }),
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
      getSignatureStatuses: vi.fn(async () => ({
        context: { slot: 10 },
        value: [statuses.shift() ?? null],
      })),
      getBlockHeight: vi.fn(async () => extra.blockHeight ?? 0),
      getSlot: vi.fn(async () => 10),
      getTransaction: vi.fn(async () => null),
      getAddressLookupTable: vi.fn(async () => ({ context: { slot: 10 }, value: null })),
      getTokenAccountsByOwner: vi.fn(async () => ({ context: { slot: 10 }, value: [] })),
      getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({
        context: { slot: 10 },
        value: keys.map((key) => (key.equals(ownerKey) ? ownerAccount : null)),
      })),
      simulateTransaction: vi.fn(
        async (_tx: VersionedTransaction, config: { accounts: { addresses: string[] } }) => ({
          context: { slot: 10 },
          value: {
            err: null,
            accounts: config.accounts.addresses.map((address) =>
              address === ownerKey.toBase58()
                ? {
                    owner: SystemProgram.programId.toBase58(),
                    lamports: ownerAccount.lamports,
                    data: ['', 'base64'],
                  }
                : null,
            ),
            logs: [],
            unitsConsumed: 1,
            returnData: null,
          },
        }),
      ),
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
    const r = await s.send({
      owner: owner.publicKey.toBase58(),
      swapTransaction: base64,
      expected: EXPECTATION,
    });
    expect(r).toMatchObject({ status: 'confirmed' });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('reports an on-chain error', async () => {
    const { s } = sender([
      { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' },
    ]);
    const r = await s.send({
      owner: owner.publicKey.toBase58(),
      swapTransaction: base64,
      expected: EXPECTATION,
    });
    expect(r.status).toBe('failed');
  });

  it('reports unknown after the deadline', async () => {
    const { s } = sender([]);
    const r = await s.send({
      owner: owner.publicKey.toBase58(),
      swapTransaction: base64,
      expected: EXPECTATION,
    });
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
    expect(
      await s.send({
        owner: Keypair.generate().publicKey.toBase58(),
        swapTransaction: base64,
        expected: EXPECTATION,
      }),
    ).toEqual({ status: 'refused', reason: 'fee_payer_mismatch' });
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
