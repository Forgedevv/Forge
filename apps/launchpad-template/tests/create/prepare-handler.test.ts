import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { PrepareLaunchResponse } from '@/forge/create/api';
import { buildLaunchAuthMessage } from '@/forge/create/auth';
import type { LaunchBuilder } from '@/forge/create/launch-builder';
import { LaunchBuildError } from '@/forge/create/launch-builder';
import { createPrepareHandler, type PrepareDeps } from '@/forge/create/prepare-handler';
import {
  FIXTURE_LAUNCHPAD_CONFIG,
  FIXTURE_PLATFORM_FEE_WALLET,
  buildFixtureLaunch,
} from '@/forge/create/test-fixtures';
import { UploadError, type UploadClient } from '@/forge/create/upload-client';
import { HTML, JPEG, PNG, SVG, dataUrl } from './images';
import { signWithKeypair } from './sign';

const NOW = Date.parse('2026-10-11T10:00:00.000Z');
const HOST = 'moon.example';
const FEE = BigInt(10_000_000);
const user = Keypair.generate();
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface BodyOptions {
  image?: Uint8Array;
  type?: string;
  name?: string;
  symbol?: string;
  description?: string;
  firstBuy?: string;
  nonce?: string;
  issuedAt?: string;
  signedHost?: string;
  signer?: Keypair;
  extra?: Record<string, unknown>;
}

function signedBody(o: BodyOptions = {}) {
  const image = o.image ?? PNG;
  const name = o.name ?? 'Moon Coin';
  const symbol = o.symbol ?? 'MOON';
  const description = o.description ?? 'To the moon';
  const firstBuy = o.firstBuy ?? '500000000';
  const nonce = o.nonce ?? '0123456789abcdef0123456789abcdef';
  const issuedAt = o.issuedAt ?? new Date(NOW).toISOString();
  const message = buildLaunchAuthMessage({
    host: o.signedHost ?? HOST,
    wallet: user.publicKey.toBase58(),
    name,
    symbol,
    firstBuyLamports: firstBuy,
    imageSha256: sha256(image),
    descriptionSha256: sha256(new TextEncoder().encode(description)),
    nonce,
    issuedAt,
  });
  const signature = signWithKeypair(o.signer ?? user, new TextEncoder().encode(message));
  return {
    tokenName: name,
    tokenSymbol: symbol,
    description,
    tokenLogo: dataUrl(o.type ?? 'image/png', image),
    userWallet: user.publicKey.toBase58(),
    firstBuyLamports: firstBuy,
    auth: { nonce, issuedAt, signature: Buffer.from(signature).toString('base64') },
    ...o.extra,
  };
}

function request(
  body: unknown,
  options: { method?: string; headers?: Record<string, string>; raw?: string } = {},
) {
  const text = options.raw ?? JSON.stringify(body);
  return Object.assign(Readable.from([Buffer.from(text)]), {
    method: options.method ?? 'POST',
    headers: {
      host: HOST,
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
      ...options.headers,
    },
    socket: { remoteAddress: '10.0.0.1' },
  });
}

function response() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

function setup(overrides: Partial<PrepareDeps> = {}, firstBuy = BigInt(500_000_000)) {
  const fixture = buildFixtureLaunch({
    wallet: user.publicKey,
    name: 'Moon Coin',
    symbol: 'MOON',
    firstBuyLamports: firstBuy,
    launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
    poolCreationFeeLamports: FEE,
  });
  const launchBuilder = {
    loadConfig: vi.fn(async () => ({
      address: FIXTURE_LAUNCHPAD_CONFIG,
      poolConfig: {} as never,
      poolCreationFeeLamports: FEE,
    })),
    build: vi.fn(async () => ({ success: true as const, ...fixture.response })),
  } satisfies LaunchBuilder;
  const uploadClient = {
    uploadCoin: vi.fn(async (req: { mint: string }) => ({
      imageUrl: `https://cdn.forge.example/launchpads/moon/images/${req.mint}.png`,
      metadataUrl: `https://cdn.forge.example/launchpads/moon/metadata/${req.mint}.json`,
    })),
  } satisfies UploadClient;
  const log = vi.fn();
  const handle = createPrepareHandler({
    mode: 'live',
    slug: 'moon',
    launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG.toBase58(),
    poolCreationFeeLamports: FEE,
    platformFeeWallet: FIXTURE_PLATFORM_FEE_WALLET.toBase58(),
    launchBuilder,
    uploadClient,
    now: () => NOW,
    newMint: () => fixture.mint,
    log,
    ...overrides,
  });
  return { handle, launchBuilder, uploadClient, fixture, log };
}

async function call(
  handle: ReturnType<typeof createPrepareHandler>,
  body: unknown,
  options?: Parameters<typeof request>[1],
) {
  const res = response();
  await handle(request(body, options), res);
  return res;
}

describe('POST /api/upload handler', () => {
  it('prepares a coin: server mint, FORGE upload, verified transaction, contract response', async () => {
    const { handle, launchBuilder, uploadClient, fixture } = setup();
    const res = await call(handle, signedBody());

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    const parsed = PrepareLaunchResponse.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect((res.body as { success: boolean }).success).toBe(true);
    expect((res.body as { mint: string }).mint).toBe(fixture.mint.publicKey.toBase58());

    const upload = uploadClient.uploadCoin.mock.calls[0]?.[0] as any;
    expect(upload).toMatchObject({
      version: 1,
      mint: fixture.mint.publicKey.toBase58(),
      wallet: user.publicKey.toBase58(),
      coin: { name: 'Moon Coin', symbol: 'MOON', description: 'To the moon' },
      firstBuyLamports: '500000000',
      image: { contentType: 'image/png', size: PNG.length, sha256: sha256(PNG) },
      auth: { host: HOST, nonce: '0123456789abcdef0123456789abcdef' },
    });
    expect(Array.from(uploadClient.uploadCoin.mock.calls[0]?.[1] as Uint8Array)).toEqual(
      Array.from(PNG),
    );
    const build = launchBuilder.build.mock.calls[0]?.[1] as any;
    expect(build.metadataUri).toBe(
      `https://cdn.forge.example/launchpads/moon/metadata/${fixture.mint.publicKey.toBase58()}.json`,
    );
    expect(build.firstBuyLamports).toBe(BigInt(500_000_000));
    expect(build.wallet).toBe(user.publicKey.toBase58());
  });

  it('never takes the mint from the request', async () => {
    const { handle, uploadClient } = setup();
    const res = await call(
      handle,
      signedBody({ extra: { mint: Keypair.generate().publicKey.toBase58() } }),
    );
    expect(res.statusCode).toBe(400);
    expect(uploadClient.uploadCoin).not.toHaveBeenCalled();
  });

  it('answers 503 and does nothing when the site is not live', async () => {
    const { handle, uploadClient } = setup({ mode: 'sleeping' });
    const res = await call(handle, signedBody());
    expect(res.statusCode).toBe(503);
    expect(uploadClient.uploadCoin).not.toHaveBeenCalled();
  });

  it('fails closed (503) without the relay, the FORGE upload endpoint or the on-chain config', async () => {
    for (const overrides of [
      { launchBuilder: null },
      { uploadClient: null },
      { launchpadConfig: undefined },
      { poolCreationFeeLamports: undefined },
    ] as Partial<PrepareDeps>[]) {
      const { handle, uploadClient } = setup(overrides);
      const res = await call(handle, signedBody());
      expect(res.statusCode).toBe(503);
      expect((res.body as { error: string }).error).toMatch(/not configured/);
      expect(uploadClient.uploadCoin).not.toHaveBeenCalled();
    }
  });

  it('only accepts POST with a JSON body', async () => {
    const { handle } = setup();
    const get = await call(handle, null, { method: 'GET' });
    expect(get.statusCode).toBe(405);
    expect(get.headers.Allow).toBe('POST');
    const form = await call(handle, signedBody(), {
      headers: { 'content-type': 'multipart/form-data' },
    });
    expect(form.statusCode).toBe(415);
    const broken = await call(handle, null, { raw: '{"tokenName":' });
    expect(broken.statusCode).toBe(400);
  });

  it('rate-limits coin creations per IP (429 with Retry-After)', async () => {
    const { handle } = setup();
    const nonce = (i: number) => `${'0'.repeat(31)}${i}`;
    for (let i = 0; i < 5; i++) {
      const res = await call(handle, signedBody({ nonce: nonce(i) }));
      expect(res.statusCode, `request ${i}`).toBe(200);
    }
    const limited = await call(handle, signedBody({ nonce: nonce(5) }));
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited' });
    expect(Number(limited.headers['Retry-After'])).toBeGreaterThan(0);
    const other = await call(handle, signedBody({ nonce: nonce(6) }), {
      headers: { 'x-forwarded-for': '198.51.100.1' },
    });
    expect(other.statusCode).toBe(200);
  });

  it('refuses invalid requests before they use a creation slot', async () => {
    const { handle, uploadClient } = setup();
    // A visitor fixing mistakes: invalid JSON, a bad name, a wrong signature...
    for (let i = 0; i < 6; i++) {
      expect((await call(handle, null, { raw: '{' })).statusCode).toBe(400);
      const badName = signedBody({ name: 'ab', nonce: `${'1'.repeat(31)}${i}` });
      expect((await call(handle, badName)).statusCode).toBe(400);
      const badSigner = signedBody({ signer: Keypair.generate(), nonce: `${'2'.repeat(31)}${i}` });
      expect((await call(handle, badSigner)).statusCode).toBe(401);
    }
    expect(uploadClient.uploadCoin).not.toHaveBeenCalled();
    // ...still gets the coin prepared afterwards.
    expect((await call(handle, signedBody())).statusCode).toBe(200);
  });

  it('bounds any flood of requests per IP before reading the body', async () => {
    const { handle } = setup();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await call(handle, null, { raw: '{' })).statusCode);
    expect(statuses.slice(0, 30).every((status) => status === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('refuses a body above the cap before parsing it (413)', async () => {
    const { handle } = setup();
    const res = await call(handle, null, {
      raw: JSON.stringify({ tokenLogo: 'A'.repeat(3 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    const declared = await call(handle, signedBody(), {
      headers: { 'content-length': String(10 * 1024 * 1024) },
    });
    expect(declared.statusCode).toBe(413);
  });

  it('only stores PNG, JPEG, WebP or GIF verified by magic bytes', async () => {
    const { handle, uploadClient } = setup();
    for (const body of [
      signedBody({ image: HTML, type: 'text/html' }),
      signedBody({ image: SVG, type: 'image/svg+xml' }),
      signedBody({ image: HTML, type: 'image/png' }),
      signedBody({ image: JPEG, type: 'image/png' }),
    ]) {
      const res = await call(handle, body, {
        headers: { 'x-forwarded-for': `192.0.2.${Math.floor(Math.random() * 250)}` },
      });
      expect(res.statusCode).toBe(415);
    }
    expect(uploadClient.uploadCoin).not.toHaveBeenCalled();
  });

  it('refuses images above 2 MB (413)', async () => {
    const { handle, uploadClient } = setup();
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    const res = await call(handle, signedBody({ image: big }));
    expect(res.statusCode).toBe(413);
    expect(uploadClient.uploadCoin).not.toHaveBeenCalled();
  });

  it('requires the wallet signature over this exact request (401)', async () => {
    const cases = [
      signedBody({ signer: Keypair.generate() }),
      { ...signedBody(), tokenName: 'Other Coin' },
      { ...signedBody(), firstBuyLamports: '900000000' },
      { ...signedBody(), description: 'Something else' },
      { ...signedBody(), tokenLogo: dataUrl('image/png', Uint8Array.from([...PNG, 1])) },
      signedBody({ signedHost: 'phishing.example' }),
      signedBody({ issuedAt: new Date(NOW - 10 * 60 * 1000).toISOString() }),
      signedBody({ nonce: 'not-a-nonce' }),
    ];
    for (const [i, body] of cases.entries()) {
      const { handle, uploadClient } = setup();
      const res = await call(handle, body, { headers: { 'x-forwarded-for': `192.0.2.${i}` } });
      expect(res.statusCode, `case ${i}`).toBe(401);
      expect(uploadClient.uploadCoin).not.toHaveBeenCalled();
    }
  });

  it('refuses a replayed signed request (409)', async () => {
    const { handle, uploadClient } = setup();
    const body = signedBody();
    expect((await call(handle, body)).statusCode).toBe(200);
    const replay = await call(handle, body);
    expect(replay.statusCode).toBe(409);
    expect(uploadClient.uploadCoin).toHaveBeenCalledTimes(1);
  });

  it('re-checks the coin rules and canonical form (400)', async () => {
    for (const [i, body] of [
      signedBody({ name: 'ab' }),
      signedBody({ symbol: 'moon' }),
      signedBody({ name: ' Moon Coin' }),
      signedBody({ firstBuy: '10000000001' }),
      { ...signedBody(), userWallet: 'not-a-wallet' },
    ].entries()) {
      const { handle } = setup();
      const res = await call(handle, body, { headers: { 'x-forwarded-for': `192.0.2.${i}` } });
      expect(res.statusCode, `case ${i}`).toBe(400);
    }
  });

  it('refuses a first buy without a FORGE platform fee wallet, before any upload or build', async () => {
    for (const platformFeeWallet of [null, undefined]) {
      const { handle, launchBuilder, uploadClient } = setup({ platformFeeWallet });
      const res = await call(handle, signedBody());
      expect(res.statusCode).toBe(503);
      expect((res.body as { error: string }).error).toMatch(/first buy/);
      expect(uploadClient.uploadCoin).not.toHaveBeenCalled();
      expect(launchBuilder.loadConfig).not.toHaveBeenCalled();
    }
    // Without a first buy there is no platform fee to pay.
    const { handle } = setup({ platformFeeWallet: null }, BigInt(0));
    const res = await call(handle, signedBody({ firstBuy: '0' }));
    expect(res.statusCode).toBe(200);
  });

  it('self-verifies the platform fee against its own fee wallet (500 on another one)', async () => {
    const { handle } = setup({ platformFeeWallet: Keypair.generate().publicKey.toBase58() });
    const res = await call(handle, signedBody());
    expect(res.statusCode).toBe(500);
  });

  it('uploads nothing when the launchpad config cannot create coins', async () => {
    const { handle, launchBuilder, uploadClient } = setup();
    launchBuilder.loadConfig.mockRejectedValueOnce(
      new LaunchBuildError('creation_fee_mismatch', 'mismatch'),
    );
    const res = await call(handle, signedBody());
    expect(res.statusCode).toBe(503);
    expect(uploadClient.uploadCoin).not.toHaveBeenCalled();
  });

  it('builds nothing when the FORGE upload fails (502 / 429)', async () => {
    const { handle, launchBuilder, uploadClient } = setup();
    uploadClient.uploadCoin.mockRejectedValueOnce(new UploadError('refused', 'no', 403));
    const res = await call(handle, signedBody());
    expect(res.statusCode).toBe(502);
    expect(launchBuilder.build).not.toHaveBeenCalled();

    const limited = setup();
    limited.uploadClient.uploadCoin.mockRejectedValueOnce(
      new UploadError('rate_limited', 'slow', 429, 90),
    );
    const res2 = await call(limited.handle, signedBody());
    expect(res2.statusCode).toBe(429);
    expect(res2.headers['Retry-After']).toBe('90');
  });

  it('maps a first buy above the curve to 400 and chain failures to 502', async () => {
    const { handle, launchBuilder } = setup();
    launchBuilder.build.mockRejectedValueOnce(
      new LaunchBuildError('first_buy_too_large', 'The first buy is larger than the curve.'),
    );
    const res = await call(handle, signedBody());
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/larger than/);

    const down = setup();
    down.launchBuilder.loadConfig.mockRejectedValueOnce(new Error('fetch failed'));
    expect((await call(down.handle, signedBody())).statusCode).toBe(502);
  });

  it('never returns a transaction that fails the browser verification (500)', async () => {
    const other = buildFixtureLaunch({
      wallet: user.publicKey,
      name: 'Moon Coin',
      symbol: 'MOON',
      firstBuyLamports: BigInt(500_000_000),
      launchpadConfig: Keypair.generate().publicKey,
      poolCreationFeeLamports: FEE,
    });
    const { handle, launchBuilder, log } = setup({ newMint: () => other.mint });
    launchBuilder.build.mockResolvedValueOnce({ success: true, ...other.response });
    const res = await call(handle, signedBody());
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Could not prepare the coin. Try again later.' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/self-verification/));
  });

  it('maps core INVALID_INPUT (name too long in bytes) to 400 invalid_input, not 502', async () => {
    const { handle, launchBuilder } = setup();
    launchBuilder.build.mockRejectedValueOnce(
      new LaunchBuildError('invalid_input', 'The coin name is too long: it holds at most 32 bytes.'),
    );
    const res = await call(handle, signedBody());
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'The coin name is too long: it holds at most 32 bytes.',
      code: 'invalid_input',
    });
  });

  it('refuses a name beyond 32 UTF-8 bytes before anything is uploaded', async () => {
    const { handle, uploadClient } = setup();
    const res = await call(handle, signedBody({ name: '\u00e9'.repeat(17) }));
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/bytes/);
    expect(uploadClient.uploadCoin).not.toHaveBeenCalled();
  });
});

type Prepared = Awaited<ReturnType<typeof prepared>>;

async function prepared(overrides: Partial<PrepareDeps> = {}) {
  const s = setup(overrides);
  const res = await call(s.handle, signedBody());
  expect(res.statusCode).toBe(200);
  const token = (res.body as { rebuildToken: string }).rebuildToken;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const mint = (res.body as { mint: string }).mint;
  const body = (
    o: { token?: string; firstBuy?: string; wallet?: string; mint?: string } = {},
  ) => ({
    rebuild: {
      mint: o.mint ?? mint,
      token: o.token ?? token,
      firstBuyLamports: o.firstBuy ?? '500000000',
    },
    userWallet: o.wallet ?? user.publicKey.toBase58(),
  });
  return { ...s, token, mint, body };
}

describe('POST /api/upload rebuild (same launch, no new upload)', () => {
  it('rebuilds with the same mint and metadata, without uploading again', async () => {
    const s = await prepared();
    const res = await call(s.handle, s.body());
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ mint: s.mint, rebuildToken: s.token });
    expect(s.uploadClient.uploadCoin).toHaveBeenCalledTimes(1);
    expect(s.launchBuilder.build).toHaveBeenCalledTimes(2);
    const first = s.launchBuilder.build.mock.calls[0]?.[1] as any;
    const again = s.launchBuilder.build.mock.calls[1]?.[1] as any;
    expect(again.mint).toBe(first.mint);
    expect(again.metadataUri).toBe(first.metadataUri);
    expect(again.wallet).toBe(user.publicKey.toBase58());
    expect(again.name).toBe('Moon Coin');
  });

  it('rebuilds with another first buy (self-verified against it)', async () => {
    const s = await prepared();
    const lower = buildFixtureLaunch({
      wallet: user.publicKey,
      name: 'Moon Coin',
      symbol: 'MOON',
      firstBuyLamports: BigInt(100_000_000),
      launchpadConfig: FIXTURE_LAUNCHPAD_CONFIG,
      poolCreationFeeLamports: FEE,
      mint: s.fixture.mint,
    });
    s.launchBuilder.build.mockResolvedValueOnce({ success: true, ...lower.response });
    const res = await call(s.handle, s.body({ firstBuy: '100000000' }));
    expect(res.statusCode).toBe(200);
    expect((s.launchBuilder.build.mock.calls[1]?.[1] as any).firstBuyLamports).toBe(
      BigInt(100_000_000),
    );
  });

  it('answers 410 prepare_again for an unknown token, another wallet or another mint', async () => {
    const cases: ((s: Prepared) => unknown)[] = [
      (s) => s.body({ token: 'A'.repeat(43) }),
      (s) => s.body({ wallet: Keypair.generate().publicKey.toBase58() }),
      (s) => s.body({ mint: Keypair.generate().publicKey.toBase58() }),
    ];
    for (const make of cases) {
      const s = await prepared();
      const res = await call(s.handle, make(s));
      expect(res.statusCode).toBe(410);
      expect(res.body).toMatchObject({ code: 'prepare_again' });
      expect(s.launchBuilder.build).toHaveBeenCalledTimes(1);
    }
  });

  it('forgets a prepared launch after its lifetime', async () => {
    let clock = NOW;
    const s = await prepared({ now: () => clock });
    clock += 10 * 60 * 1000 + 1;
    const res = await call(s.handle, s.body());
    expect(res.statusCode).toBe(410);
  });

  it('caps the rebuilds of one launch and refuses a malformed rebuild', async () => {
    const s = await prepared();
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await call(s.handle, s.body())).statusCode);
    expect(statuses.slice(0, 8).every((status) => status === 200)).toBe(true);
    expect(statuses[8]).toBe(410);
    const malformed = await call(s.handle, { rebuild: { mint: s.mint }, userWallet: 'x' });
    expect(malformed.statusCode).toBe(400);
  });

  it('keeps the first-buy bound on a rebuild', async () => {
    const s = await prepared();
    const res = await call(s.handle, s.body({ firstBuy: '10000000001' }));
    expect(res.statusCode).toBe(400);
    expect(s.launchBuilder.build).toHaveBeenCalledTimes(1);
  });

  it('reports an already created coin (409 already_launched) when the mint exists', async () => {
    const s = await prepared();
    s.launchBuilder.build.mockRejectedValueOnce(new LaunchBuildError('mint_exists', 'in use'));
    const res = await call(s.handle, s.body());
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'already_launched' });
  });
});
