// @vitest-environment node
import { PaymentsConfirmResponse, PaymentsQuoteResponse, type Session } from '@forge/shared';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ClusterMismatchError,
  PaymentConfigError,
  PriceUnavailableError,
  RpcUnavailableError,
  StoreError,
} from './errors';
import { createPaymentsHandlers, errorToResponse } from './handlers';
import { MemoryLogger } from './log';
import { MemoryPaymentsStore } from './memory-store';
import { FixedPriceSource } from './price-source';
import { MemoryRateLimiter, PAYMENT_RATE_LIMITS } from './rate-limit';
import { createPaymentsService, QUOTE_TIMING } from './service';
import { FakeChainGateway, landedPayment, randomSignature, TestClock } from './test-helpers';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const OWNER = PublicKey.unique();
const CASHBOX = PublicKey.unique();
const APP = 'http://localhost:3000';

/** Test session: the wallet is taken from a header (the real cookie session is tested in auth). */
function headerSession(request: Request): Session | Response {
  const wallet = request.headers.get('x-test-wallet');
  if (!wallet) return Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
  return { wallet };
}

function setup(options: { useRealSession?: boolean } = {}) {
  const clock = new TestClock(T0);
  const store = new MemoryPaymentsStore();
  const gateway = new FakeChainGateway(CASHBOX);
  const logger = new MemoryLogger();
  const service = createPaymentsService({
    store,
    gateway,
    prices: new FixedPriceSource(150),
    logger,
    now: clock.now,
    sleep: clock.sleep,
  });
  const handlers = createPaymentsHandlers({
    service,
    rateLimiter: new MemoryRateLimiter(clock.now),
    logger,
    ...(options.useRealSession ? {} : { requireSession: headerSession }),
  });
  const launchpad = store.addLaunchpad({ ownerWallet: OWNER.toBase58() });
  const job = store.addJob({ launchpadId: launchpad.id, type: 'create_launchpad' });
  return { clock, store, gateway, logger, handlers, job };
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = { 'x-test-wallet': OWNER.toBase58() },
): Request {
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const QUOTE = '/api/payments/quote';
const CONFIRM = '/api/payments/confirm';

describe('POST /api/payments/quote', () => {
  it('returns a quote matching the shared response schema, not cacheable', async () => {
    const ctx = setup();
    const res = await ctx.handlers.quote(post(QUOTE, { jobId: ctx.job.id, kind: 'creation' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = PaymentsQuoteResponse.parse(await res.json());
    expect(body).toMatchObject({ kind: 'creation', lamports: '220000000', usdAmount: 33 });
  });

  it('requires a session (real cookie session: none -> 401)', async () => {
    const ctx = setup({ useRealSession: true });
    const res = await ctx.handlers.quote(post(QUOTE, { jobId: ctx.job.id, kind: 'creation' }, {}));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects cross-site requests', async () => {
    const ctx = setup();
    const res = await ctx.handlers.quote(
      post(
        QUOTE,
        { jobId: ctx.job.id, kind: 'creation' },
        {
          'x-test-wallet': OWNER.toBase58(),
          'sec-fetch-site': 'cross-site',
        },
      ),
    );
    expect(res.status).toBe(403);
  });

  it.each([
    ['a client-chosen amount (strict body)', { lamports: '1' }],
    ['a client-chosen wallet (strict body)', { wallet: PublicKey.unique().toBase58() }],
    ['a bad kind', { kind: 'free' }],
    ['a bad job id', { jobId: 'job-1' }],
  ])('rejects %s', async (_label, patch) => {
    const ctx = setup();
    const res = await ctx.handlers.quote(
      post(QUOTE, { jobId: ctx.job.id, kind: 'creation', ...patch }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    expect(ctx.store.payments.size).toBe(0);
  });

  it('rejects a non-JSON or oversized body', async () => {
    const ctx = setup();
    expect((await ctx.handlers.quote(post(QUOTE, '{not json'))).status).toBe(400);
    const big = JSON.stringify({ jobId: ctx.job.id, kind: 'creation', pad: 'x'.repeat(5000) });
    expect((await ctx.handlers.quote(post(QUOTE, big))).status).toBe(400);
  });

  it('rate limits per wallet, with Retry-After', async () => {
    const ctx = setup();
    const body = { jobId: '00000000-0000-4000-8000-000000000000', kind: 'creation' };
    for (let i = 0; i < PAYMENT_RATE_LIMITS.quoteWallet.limit; i++) {
      expect((await ctx.handlers.quote(post(QUOTE, body))).status).toBe(404);
    }
    const limited = await ctx.handlers.quote(post(QUOTE, body));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    const other = await ctx.handlers.quote(
      post(QUOTE, body, { 'x-test-wallet': PublicKey.unique().toBase58() }),
    );
    expect(other.status).toBe(404);
    ctx.clock.advance(PAYMENT_RATE_LIMITS.quoteWallet.windowMs);
    expect((await ctx.handlers.quote(post(QUOTE, body))).status).toBe(404);
  });

  it('rate limits per IP before reading the session', async () => {
    const ctx = setup();
    const body = { jobId: ctx.job.id, kind: 'creation' };
    const statuses: number[] = [];
    for (let i = 0; i <= PAYMENT_RATE_LIMITS.quoteIp.limit; i++) {
      const res = await ctx.handlers.quote(post(QUOTE, body, { 'x-forwarded-for': '203.0.113.9' }));
      statuses.push(res.status);
    }
    expect(statuses.slice(0, -1).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('maps service errors to their status and code', async () => {
    const ctx = setup();
    ctx.store.flags.set('signups_paused', true);
    const res = await ctx.handlers.quote(post(QUOTE, { jobId: ctx.job.id, kind: 'creation' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      code: 'SIGNUPS_PAUSED',
      message: 'New signups are temporarily paused.',
    });
  });
});

describe('POST /api/payments/confirm', () => {
  async function quoted(ctx: ReturnType<typeof setup>) {
    const res = await ctx.handlers.quote(post(QUOTE, { jobId: ctx.job.id, kind: 'creation' }));
    return PaymentsQuoteResponse.parse(await res.json());
  }

  it('confirms a payment (200) and is idempotent', async () => {
    const ctx = setup();
    const quote = await quoted(ctx);
    const signature = randomSignature();
    ctx.gateway.land(
      signature,
      landedPayment({
        payer: OWNER,
        cashbox: CASHBOX,
        lamports: BigInt(quote.lamports),
        jobId: ctx.job.id,
        blockTime: ctx.clock.seconds(),
      }),
    );
    for (let i = 0; i < 2; i++) {
      const res = await ctx.handlers.confirm(
        post(CONFIRM, { paymentId: quote.paymentId, signature }),
      );
      expect(res.status).toBe(200);
      expect(PaymentsConfirmResponse.parse(await res.json())).toEqual({ status: 'confirmed' });
    }
    expect(ctx.store.jobs.get(ctx.job.id)!.status).toBe('paid');
  });

  it('answers 202 { status: "quoted" } with Retry-After while pending', async () => {
    const ctx = setup();
    const quote = await quoted(ctx);
    const res = await ctx.handlers.confirm(
      post(CONFIRM, { paymentId: quote.paymentId, signature: randomSignature() }),
    );
    expect(res.status).toBe(202);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await res.json()).toEqual({ status: 'quoted' });
  });

  it('answers 410 QUOTE_EXPIRED with the payment status', async () => {
    const ctx = setup();
    const quote = await quoted(ctx);
    ctx.clock.advance(QUOTE_TIMING.validityMs + QUOTE_TIMING.notFoundGraceMs + 1);
    const res = await ctx.handlers.confirm(
      post(CONFIRM, { paymentId: quote.paymentId, signature: randomSignature() }),
    );
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'QUOTE_EXPIRED', status: 'expired' });
  });

  it('rejects a malformed signature or extra keys', async () => {
    const ctx = setup();
    const quote = await quoted(ctx);
    for (const body of [
      { paymentId: quote.paymentId, signature: '0OIl' },
      { paymentId: quote.paymentId, signature: randomSignature(), lamports: '1' },
    ]) {
      const res = await ctx.handlers.confirm(post(CONFIRM, body));
      expect(res.status).toBe(400);
    }
    expect(ctx.gateway.verifyCalls).toHaveLength(0);
  });

  it('answers 503 when the RPC or the cluster is wrong, without recording anything', async () => {
    const ctx = setup();
    const quote = await quoted(ctx);
    for (const [failure, code] of [
      [new RpcUnavailableError(), 'RPC_UNAVAILABLE'],
      [new ClusterMismatchError(), 'WRONG_CLUSTER'],
    ] as const) {
      ctx.gateway.failure = failure;
      const res = await ctx.handlers.confirm(
        post(CONFIRM, { paymentId: quote.paymentId, signature: randomSignature() }),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code });
    }
    expect(ctx.store.payments.get(quote.paymentId)!.status).toBe('quoted');
  });
});

describe('errorToResponse', () => {
  it('hides internal details and never logs raw error messages', async () => {
    const logger = new MemoryLogger();
    const leaky = new Error('fetch https://devnet.helius-rpc.com/?api-key=SECRET failed');
    for (const error of [leaky, new StoreError('confirm payment', '57014')]) {
      const res = errorToResponse(error, logger, 'confirm');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        code: 'SERVER_ERROR',
        message: 'Payments are temporarily unavailable.',
      });
    }
    expect(JSON.stringify(logger.entries)).not.toContain('SECRET');
    expect(logger.entries.map((e) => e.fields)).toEqual([
      { route: 'confirm', error: 'Error' },
      { route: 'confirm', dbCode: '57014' },
    ]);
  });

  it('maps price and configuration failures', async () => {
    const logger = new MemoryLogger();
    const price = errorToResponse(new PriceUnavailableError(), logger, 'quote');
    expect(price.status).toBe(503);
    // Retryable: the price guard or the price source refused, nothing was quoted.
    expect(price.headers.get('retry-after')).toBe('30');
    expect(await price.json()).toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    const config = errorToResponse(new PaymentConfigError('RPC_URL is not set'), logger, 'quote');
    expect(config.status).toBe(500);
    expect(logger.entries.at(-1)).toMatchObject({
      level: 'error',
      event: 'config.invalid',
      fields: { detail: 'RPC_URL is not set' },
    });
  });
});
