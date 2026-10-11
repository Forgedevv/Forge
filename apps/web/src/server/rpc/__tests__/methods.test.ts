// @vitest-environment node
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { checkCall } from '../jsonrpc';
import {
  ALLOWED_METHODS,
  MAX_MULTIPLE_ACCOUNTS,
  MAX_SIGNATURE_STATUSES,
  METHODS,
  PACKET_DATA_SIZE,
} from '../methods';
import {
  base64OfSize,
  call,
  DEVNET_GENESIS,
  PK,
  PK2,
  SIG,
  smallTransactionBase64,
} from './helpers';

function check(method: string, params?: unknown) {
  return checkCall(call(method, params), 0);
}

function expectValid(method: string, params?: unknown) {
  const result = check(method, params);
  expect(result.ok, `${method} ${JSON.stringify(params)}`).toBe(true);
}

function expectCode(method: string, params: unknown, code: number) {
  const result = check(method, params);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

const TX = smallTransactionBase64();

describe('method allowlist', () => {
  it('is exactly the documented list', () => {
    expect([...ALLOWED_METHODS].sort()).toEqual(
      [
        'getAccountInfo',
        'getMultipleAccounts',
        'getBalance',
        'getLatestBlockhash',
        'getMinimumBalanceForRentExemption',
        'getSignatureStatuses',
        'getBlockHeight',
        'getSlot',
        'getBlockTime',
        'getTokenAccountsByOwner',
        'getTokenAccountBalance',
        'simulateTransaction',
        'sendTransaction',
        'getFeeForMessage',
        'getEpochInfo',
      ].sort(),
    );
    for (const spec of Object.values(METHODS)) expect(spec.usedBy.length).toBeGreaterThan(10);
  });

  it.each([
    ['getProgramAccounts', [PK]],
    ['getSignaturesForAddress', [PK]],
    ['getTransaction', [SIG]],
    ['requestAirdrop', [PK, 1_000_000_000]],
    ['getLargestAccounts', []],
    ['getTokenLargestAccounts', [PK]],
    ['getVoteAccounts', []],
    ['accountSubscribe', [PK]],
    ['getGenesisHash', []],
    ['getblockheight', []],
    ['__proto__', []],
    ['constructor', []],
    ['toString', []],
  ])('refuses %s with -32601', (method, params) => {
    expectCode(method, params, -32601);
  });
});

describe('param validation', () => {
  it('accepts the shapes FORGE code sends', () => {
    expectValid('getAccountInfo', [PK]);
    expectValid('getAccountInfo', [PK, { encoding: 'base64', commitment: 'confirmed' }]);
    expectValid('getAccountInfo', [
      PK,
      { encoding: 'jsonParsed', dataSlice: { offset: 0, length: 32 } },
    ]);
    expectValid('getMultipleAccounts', [
      [PK, PK2],
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    expectValid('getBalance', [PK, { commitment: 'confirmed' }]);
    expectValid('getLatestBlockhash', []);
    expectValid('getLatestBlockhash', undefined);
    expectValid('getLatestBlockhash', [{ commitment: 'finalized', minContextSlot: 10 }]);
    expectValid('getMinimumBalanceForRentExemption', [165]);
    expectValid('getMinimumBalanceForRentExemption', [0, { commitment: 'confirmed' }]);
    expectValid('getSignatureStatuses', [[SIG]]);
    expectValid('getSignatureStatuses', [[SIG], { searchTransactionHistory: false }]);
    expectValid('getBlockHeight', [{ commitment: 'confirmed' }]);
    expectValid('getSlot', []);
    expectValid('getBlockTime', [123_456]);
    expectValid('getTokenAccountsByOwner', [PK, { mint: PK2 }, { encoding: 'jsonParsed' }]);
    expectValid('getTokenAccountBalance', [PK, { commitment: 'confirmed' }]);
    expectValid('simulateTransaction', [
      TX,
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: [PK, PK2] },
      },
    ]);
    expectValid('sendTransaction', [
      TX,
      { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);
    expectValid('getFeeForMessage', [base64OfSize(200), { commitment: 'confirmed' }]);
    expectValid('getEpochInfo', []);
  });

  it.each<[string, unknown, string]>([
    ['getAccountInfo', { 0: PK }, 'object params'],
    ['getAccountInfo', [], 'missing pubkey'],
    ['getAccountInfo', ['not-a-key'], 'bad pubkey'],
    ['getAccountInfo', [PK, { encoding: 'base58' }], 'base58 encoding'],
    ['getAccountInfo', [PK, { commitment: 'recent' }], 'deprecated commitment'],
    ['getAccountInfo', [PK, { commitment: 'max' }], 'deprecated commitment'],
    ['getAccountInfo', [PK, { filters: [] }], 'unknown config key'],
    ['getAccountInfo', [PK, {}, 'extra'], 'too many params'],
    ['getAccountInfo', [PK, { dataSlice: { offset: -1, length: 1 } }], 'negative slice'],
    ['getMultipleAccounts', [[]], 'empty list'],
    ['getMultipleAccounts', [Array(MAX_MULTIPLE_ACCOUNTS + 1).fill(PK)], 'too many accounts'],
    ['getMultipleAccounts', [PK], 'not a list'],
    ['getBalance', [PK, { commitment: 'confirmed', encoding: 'base64' }], 'unknown key'],
    ['getMinimumBalanceForRentExemption', [-1], 'negative size'],
    ['getMinimumBalanceForRentExemption', [10 * 1024 * 1024 + 1], 'over 10 MiB'],
    ['getMinimumBalanceForRentExemption', [1.5], 'fractional size'],
    ['getSignatureStatuses', [[]], 'no signature'],
    ['getSignatureStatuses', [Array(MAX_SIGNATURE_STATUSES + 1).fill(SIG)], 'too many signatures'],
    ['getSignatureStatuses', [['short']], 'bad signature'],
    ['getBlockTime', [-5], 'negative slot'],
    ['getBlockTime', ['123'], 'string slot'],
    ['getTokenAccountsByOwner', [PK, { programId: PK2 }], 'programId filter (whole program)'],
    ['getTokenAccountsByOwner', [PK, { mint: PK2, programId: PK }], 'both filters'],
    ['getTokenAccountsByOwner', [PK], 'no filter'],
    ['simulateTransaction', [TX], 'no config (base58 default)'],
    ['simulateTransaction', [TX, { encoding: 'base58' }], 'base58'],
    [
      'simulateTransaction',
      [TX, { encoding: 'base64', sigVerify: true, replaceRecentBlockhash: true }],
      'sigVerify and replaceRecentBlockhash',
    ],
    ['simulateTransaction', [TX, { encoding: 'base64', sigVerify: 'yes' }], 'non-boolean flag'],
    [
      'simulateTransaction',
      [TX, { encoding: 'base64', accounts: { addresses: Array(9).fill(PK) } }],
      'too many simulated accounts',
    ],
    [
      'simulateTransaction',
      [base64OfSize(PACKET_DATA_SIZE + 1), { encoding: 'base64' }],
      'oversized transaction',
    ],
    ['simulateTransaction', ['@@@@', { encoding: 'base64' }], 'not base64'],
    ['sendTransaction', [TX], 'no config'],
    ['sendTransaction', [TX, { encoding: 'base58' }], 'base58'],
    ['sendTransaction', [TX, { encoding: 'base64', maxRetries: 11 }], 'too many retries'],
    ['sendTransaction', [TX, { encoding: 'base64', skipPreflight: 1 }], 'non-boolean flag'],
    ['sendTransaction', [base64OfSize(PACKET_DATA_SIZE + 3), { encoding: 'base64' }], 'oversized'],
    ['getFeeForMessage', [base64OfSize(PACKET_DATA_SIZE + 3)], 'oversized message'],
    ['getEpochInfo', [{ commitment: 'confirmed' }, {}], 'too many params'],
  ])('%s refuses %j (%s) with -32602', (method, params) => {
    expectCode(method, params, -32602);
  });

  it('weighs calls, with sendTransaction the heaviest and in the send bucket', () => {
    const weight = (method: string, params: unknown[]) => METHODS[method]!.weight(params);
    expect(weight('getBalance', [PK])).toBe(1);
    expect(weight('getAccountInfo', [PK, { encoding: 'jsonParsed' }])).toBe(2);
    expect(weight('getMultipleAccounts', [Array(20).fill(PK)])).toBe(5);
    expect(weight('getSignatureStatuses', [[SIG], { searchTransactionHistory: true }])).toBe(3);
    expect(weight('simulateTransaction', [TX, { encoding: 'base64' }])).toBe(5);
    expect(weight('sendTransaction', [TX, { encoding: 'base64' }])).toBe(10);
    expect(METHODS.sendTransaction!.isSend).toBe(true);
    expect(METHODS.sendTransaction!.retryable).toBe(false);
    expect(Object.values(METHODS).filter((m) => m.isSend)).toHaveLength(1);
  });
});

describe('compatibility with @solana/web3.js', () => {
  /** Captures the JSON-RPC bodies a real Connection sends, answering with minimal stubs. */
  function capturingConnection() {
    const bodies: { method: string; params: unknown }[] = [];
    const fetchStub = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: string;
        method: string;
        params: unknown;
      };
      bodies.push({ method: body.method, params: body.params });
      const answer =
        body.method === 'getLatestBlockhash'
          ? {
              result: {
                context: { slot: 1 },
                value: { blockhash: DEVNET_GENESIS, lastValidBlockHeight: 100 },
              },
            }
          : { error: { code: -1, message: 'stub' } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...answer }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const connection = new Connection('http://relay.test/api/rpc', {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      fetch: fetchStub as unknown as typeof fetch,
    });
    return { connection, bodies };
  }

  it('accepts every request a confirmed Connection makes for the allowed methods', async () => {
    const { connection, bodies } = capturingConnection();
    const key = new PublicKey(PK2);
    const payer = Keypair.generate();
    const legacy = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: DEVNET_GENESIS,
    }).add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: key, lamports: 1 }));
    legacy.sign(payer);
    const versioned = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: DEVNET_GENESIS,
        instructions: [
          SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: key, lamports: 1 }),
        ],
      }).compileToV0Message(),
    );

    const calls: (() => Promise<unknown>)[] = [
      () => connection.getAccountInfo(key),
      () => connection.getAccountInfo(key, { dataSlice: { offset: 0, length: 8 } }),
      () => connection.getParsedAccountInfo(key),
      () => connection.getMultipleAccountsInfo([key, payer.publicKey], 'confirmed'),
      () => connection.getBalance(key),
      () => connection.getLatestBlockhash(),
      () => connection.getLatestBlockhash({ commitment: 'finalized', minContextSlot: 1 }),
      () => connection.getMinimumBalanceForRentExemption(165),
      () => connection.getSignatureStatuses([SIG]),
      () => connection.getSignatureStatuses([SIG], { searchTransactionHistory: false }),
      () => connection.getBlockHeight(),
      () => connection.getSlot(),
      () => connection.getBlockTime(100),
      () => connection.getTokenAccountsByOwner(key, { mint: payer.publicKey }),
      () => connection.getParsedTokenAccountsByOwner(key, { mint: payer.publicKey }),
      () => connection.getTokenAccountBalance(key),
      () => connection.getEpochInfo(),
      () => connection.getFeeForMessage(versioned.message),
      () => connection.simulateTransaction(versioned, { sigVerify: false }),
      () =>
        connection.simulateTransaction(versioned, {
          replaceRecentBlockhash: true,
          sigVerify: false,
        }),
      () => connection.sendRawTransaction(legacy.serialize()),
      () =>
        connection.sendRawTransaction(legacy.serialize(), {
          skipPreflight: true,
          maxRetries: 3,
          preflightCommitment: 'confirmed',
          minContextSlot: 5,
        }),
      () => connection.sendRawTransaction(versioned.serialize()),
    ];
    for (const run of calls) await run().catch(() => undefined);

    expect(bodies.length).toBeGreaterThanOrEqual(calls.length);
    for (const body of bodies) {
      const result = check(body.method, body.params);
      expect(result.ok, `${body.method} ${JSON.stringify(body.params)}`).toBe(true);
    }
  });

  it('accepts a legacy simulateTransaction (web3.js fetches the blockhash itself)', async () => {
    const { connection, bodies } = capturingConnection();
    const payer = Keypair.generate();
    const legacy = new Transaction({ feePayer: payer.publicKey }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1,
      }),
    );
    await connection.simulateTransaction(legacy).catch(() => undefined);
    await connection.simulateTransaction(legacy, [payer]).catch(() => undefined);
    await connection
      .simulateTransaction(legacy, undefined, [payer.publicKey])
      .catch(() => undefined);
    expect(bodies.filter((b) => b.method === 'simulateTransaction')).toHaveLength(3);
    for (const body of bodies) {
      expect(check(body.method, body.params).ok, JSON.stringify(body.params)).toBe(true);
    }
  });
});
