import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as api from './api.js';
import { WEB_ENV, BUILDER_ENV, SIGNER_ENV, TEMPLATE_ENV } from './env.js';
import { ClientError, isClientError } from './web-client.js';

const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const SIG =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const UUID = '7d444840-9dc0-41a7-9a4e-4d0f2b8f6a3c';
const UUID2 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const TX = 'AQIDBAU=';

const spec = {
  version: 1,
  ownerWallet: WALLET,
  name: 'MoonPad',
  slug: 'moonpad',
  quote: 'SOL',
  tradingFeeBps: 100,
  poolCreationFeeSol: 0,
  theme: {
    primaryColor: '#7C3AED',
    accentColor: '#F59E0B',
    darkMode: true,
    tagline: 'To the moon',
    designNotes: '',
  },
  launchpadCoin: {
    name: 'Moon',
    symbol: 'MOON',
    description: '',
    imageUrl: 'https://example.com/moon.png',
    firstBuySol: 0.5,
  },
};

const samples: [string, z.ZodType, unknown][] = [
  ['AuthNonceRequest', api.AuthNonceRequest, { wallet: WALLET }],
  ['AuthNonceResponse', api.AuthNonceResponse, { nonce: 'abc123' }],
  ['AuthVerifyRequest', api.AuthVerifyRequest, { wallet: WALLET, signature: SIG }],
  ['AuthVerifyResponse', api.AuthVerifyResponse, { wallet: WALLET }],
  ['GatingResponse', api.GatingResponse, { ok: true, required: '0', balance: '0', enabled: false }],
  ['ChatRequest', api.ChatRequest, { message: 'I want a launchpad' }],
  [
    'ChatRequest (modification)',
    api.ChatRequest,
    { conversationId: UUID, launchpadId: UUID2, message: 'Darker' },
  ],
  ['ChatResponse', api.ChatResponse, { conversationId: UUID }],
  ['SpecConfirmRequest', api.SpecConfirmRequest, { conversationId: UUID, spec }],
  ['SpecConfirmResponse', api.SpecConfirmResponse, { launchpadId: UUID, jobId: UUID2 }],
  [
    'LaunchpadModificationRequest',
    api.LaunchpadModificationRequest,
    { conversationId: UUID, request: 'New logo' },
  ],
  ['LaunchpadModificationResponse', api.LaunchpadModificationResponse, { jobId: UUID }],
  ['PaymentsQuoteRequest', api.PaymentsQuoteRequest, { jobId: UUID, kind: 'creation' }],
  [
    'PaymentsQuoteResponse',
    api.PaymentsQuoteResponse,
    {
      paymentId: UUID,
      kind: 'creation',
      lamports: '300000000',
      usdAmount: 33,
      expiresAt: '2026-10-06T12:00:00Z',
      transaction: TX,
    },
  ],
  [
    'PaymentsQuoteResponse (included modification)',
    api.PaymentsQuoteResponse,
    {
      paymentId: UUID,
      kind: 'modification',
      lamports: '0',
      usdAmount: 0,
      expiresAt: '2026-10-06T12:00:00.000+02:00',
      transaction: null,
    },
  ],
  ['PaymentsConfirmRequest', api.PaymentsConfirmRequest, { paymentId: UUID, signature: SIG }],
  ['PaymentsConfirmResponse', api.PaymentsConfirmResponse, { status: 'confirmed' }],
  ['JobApproveResponse', api.JobApproveResponse, { status: 'approved' }],
  [
    'OwnerTransactionGetResponse',
    api.OwnerTransactionGetResponse,
    {
      transaction: TX,
      summary: {
        coinName: 'Moon',
        coinSymbol: 'MOON',
        firstBuyLamports: '500000000',
        estimatedNetworkFeeLamports: '5000',
        ownerWallet: WALLET,
      },
    },
  ],
  ['FlagsResponse', api.FlagsResponse, { signupsPaused: false }],
  ['OwnerTransactionSubmitRequest', api.OwnerTransactionSubmitRequest, { signedTransaction: TX }],
  ['OwnerTransactionSubmitResponse', api.OwnerTransactionSubmitResponse, { signature: SIG }],
  ['ClaimTransactionResponse', api.ClaimTransactionResponse, { transaction: TX }],
  ['RpcRequest', api.RpcRequest, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [WALLET] }],
  ['RpcResponse', api.RpcResponse, { jsonrpc: '2.0', id: 1, result: { value: 0 } }],
  ['RouteIdParams', api.RouteIdParams, { id: UUID }],
  ['SignerConfigsRequest', api.SignerConfigsRequest, { jobId: UUID }],
  [
    'SignerConfigsResponse',
    api.SignerConfigsResponse,
    { launchpadConfig: WALLET, launchpadCoinConfig: WALLET },
  ],
  ['SignerLaunchPrepareRequest', api.SignerLaunchPrepareRequest, { jobId: UUID }],
  [
    'SignerLaunchPrepareResponse',
    api.SignerLaunchPrepareResponse,
    { partiallySignedTx: TX, mint: WALLET },
  ],
  ['SignerHealthResponse', api.SignerHealthResponse, { ok: true }],
];

describe('API schemas', () => {
  it.each(samples)('%s parses a valid sample', (_name, schema, sample) => {
    expect(schema.safeParse(sample).success).toBe(true);
  });

  it('applies spec defaults inside SpecConfirmRequest', () => {
    const parsed = api.SpecConfirmRequest.parse({ conversationId: UUID, spec });
    expect(parsed.spec.coinCreatorSharePct).toBe(25);
    expect(parsed.spec.antiSniper).toBe(true);
  });

  it('signer requests reject extra keys (no address or amount from the caller)', () => {
    expect(api.SignerConfigsRequest.safeParse({ jobId: UUID, ownerWallet: WALLET }).success).toBe(
      false,
    );
    expect(api.SignerLaunchPrepareRequest.safeParse({ jobId: UUID, lamports: '1' }).success).toBe(
      false,
    );
  });

  it('rejects malformed values', () => {
    expect(
      api.PaymentsQuoteRequest.safeParse({ jobId: 'not-a-uuid', kind: 'creation' }).success,
    ).toBe(false);
    expect(api.PaymentsQuoteRequest.safeParse({ jobId: UUID, kind: 'gift' }).success).toBe(false);
    expect(api.Lamports.safeParse('1.5').success).toBe(false);
    expect(api.Lamports.safeParse('-1').success).toBe(false);
    expect(api.ChatRequest.safeParse({ message: '' }).success).toBe(false);
  });

  it('exposes the signer HMAC constants', () => {
    expect(api.SIGNER_SIGNATURE_HEADER).toBe('X-Forge-Signature');
    expect(api.SIGNER_TIMESTAMP_HEADER).toBe('X-Forge-Timestamp');
    expect(api.SIGNER_MAX_CLOCK_SKEW_SECONDS).toBe(60);
    expect(api.signerSignedPayload('1700000000', '{"jobId":"x"}')).toBe('1700000000.{"jobId":"x"}');
  });
});

describe('ClientError', () => {
  it('carries a code and a user-readable message', () => {
    const err = new ClientError('QUOTE_EXPIRED', 'The quote expired, please get a new one.');
    expect(err).toBeInstanceOf(Error);
    expect(isClientError(err)).toBe(true);
    expect(err.code).toBe('QUOTE_EXPIRED');
    expect(err.name).toBe('ClientError');
    expect(isClientError(new Error('x'))).toBe(false);
  });
});

describe('env names', () => {
  it('has no duplicates per app', () => {
    for (const list of [WEB_ENV, TEMPLATE_ENV, BUILDER_ENV, SIGNER_ENV]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('keeps signer secrets out of the web and template apps', () => {
    const exposed: readonly string[] = [...WEB_ENV, ...TEMPLATE_ENV];
    for (const name of [
      'SIGNER_HMAC_SECRET',
      'SIGNER_KEYSTORE_PASSPHRASE',
      'GITHUB_APP_PRIVATE_KEY',
    ]) {
      expect(exposed).not.toContain(name);
    }
  });
});
