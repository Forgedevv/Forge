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
import { readFileSync } from 'node:fs';
import {
  DBC_POOL_CONFIG_OFFSET as CORE_CONFIG_OFFSET,
  DBC_POOL_CREATOR_OFFSET as CORE_CREATOR_OFFSET,
  LAUNCH_CHECK_DBC_PROGRAM_ID,
  MAX_PRIORITY_FEE_ACCOUNTS as CORE_MAX_PRIORITY_FEE_ACCOUNTS,
  estimatePriorityFee,
  listCoinsOfCreator,
  listPoolStatesOfConfig,
} from '@forge/core';
import { describe, expect, it } from 'vitest';
import { checkCall } from '../jsonrpc';
import {
  ALLOWED_METHODS,
  CONFIG_POOLS_WEIGHT,
  CREATOR_POOLS_WEIGHT,
  DBC_POOL_CONFIG_OFFSET,
  DBC_POOL_CREATOR_OFFSET,
  DBC_POOL_DISCRIMINATORS,
  DBC_PROGRAM_ID,
  decodeBase58,
  isConfigPoolsScan,
  MAX_MULTIPLE_ACCOUNTS,
  MAX_PRIORITY_FEE_ACCOUNTS,
  MAX_SIGNATURE_STATUSES,
  METHODS,
  PACKET_DATA_SIZE,
  PRIORITY_FEES_WEIGHT,
  SLEEPING_SITE_METHODS,
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
        'getProgramAccounts',
        'getRecentPrioritizationFees',
      ].sort(),
    );
    for (const spec of Object.values(METHODS)) expect(spec.usedBy.length).toBeGreaterThan(10);
  });

  it("serves sleeping sites a subset of it: the creator fee claim's methods", () => {
    for (const method of SLEEPING_SITE_METHODS) expect(ALLOWED_METHODS).toContain(method);
    expect(SLEEPING_SITE_METHODS.has('simulateTransaction')).toBe(false);
    expect(SLEEPING_SITE_METHODS.has('getTokenAccountsByOwner')).toBe(false);
    // The creator fee claim of a sleeping site is priced too.
    expect(SLEEPING_SITE_METHODS.has('getRecentPrioritizationFees')).toBe(true);
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
    expectValid('getRecentPrioritizationFees', []);
    expectValid('getRecentPrioritizationFees', undefined);
    expectValid('getRecentPrioritizationFees', [[PK, PK2]]);
    expectValid('getRecentPrioritizationFees', [Array(MAX_PRIORITY_FEE_ACCOUNTS).fill(PK)]);
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
    ['getRecentPrioritizationFees', [[]], 'empty account list'],
    [
      'getRecentPrioritizationFees',
      [Array(MAX_PRIORITY_FEE_ACCOUNTS + 1).fill(PK)],
      'too many accounts',
    ],
    ['getRecentPrioritizationFees', [PK], 'not a list'],
    ['getRecentPrioritizationFees', [['not-a-key']], 'bad pubkey'],
    ['getRecentPrioritizationFees', [[PK], { commitment: 'confirmed' }], 'too many params'],
    ['getRecentPrioritizationFees', [{ lockedWritableAccounts: [PK] }], 'object param'],
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
    expect(weight('getRecentPrioritizationFees', [[PK]])).toBe(PRIORITY_FEES_WEIGHT);
    expect(PRIORITY_FEES_WEIGHT).toBe(2);
    expect(MAX_PRIORITY_FEE_ACCOUNTS).toBe(CORE_MAX_PRIORITY_FEE_ACCOUNTS);
    expect(METHODS.getRecentPrioritizationFees!.retryable).toBe(true);
    expect(METHODS.sendTransaction!.isSend).toBe(true);
    expect(METHODS.sendTransaction!.retryable).toBe(false);
    expect(Object.values(METHODS).filter((m) => m.isSend)).toHaveLength(1);
  });
});

/** base58 of a short byte string (bs58 encoding, leading zero bytes as '1'). */
function encodeBase58(bytes: readonly number[]): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(0);
  for (const byte of bytes) n = n * BigInt(256) + BigInt(byte);
  let out = '';
  while (n > BigInt(0)) {
    out = alphabet[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

describe('getProgramAccounts: creator or config pools on the DBC program only', () => {
  const VIRTUAL_POOL = encodeBase58(DBC_POOL_DISCRIMINATORS[0]!);
  const TRANSFER_HOOK_POOL = encodeBase58(DBC_POOL_DISCRIMINATORS[1]!);
  /** PoolConfig account discriminator: a DBC account that is not a pool. */
  const POOL_CONFIG = encodeBase58([26, 108, 14, 123, 116, 230, 129, 43]);
  const CREATOR = PK2;
  const disc = (bytes = VIRTUAL_POOL) => ({ memcmp: { offset: 0, bytes, encoding: 'base58' } });
  const creatorAt = (offset: unknown = DBC_POOL_CREATOR_OFFSET, bytes = CREATOR) => ({
    memcmp: { offset, bytes, encoding: 'base58' },
  });
  const query = (config: Record<string, unknown>, program = DBC_PROGRAM_ID) => [program, config];
  const sdkConfig = (filters: unknown[] = [disc(), creatorAt()]) => ({
    encoding: 'base64',
    commitment: 'confirmed',
    filters,
  });

  it('uses the DBC program id and pool layout of @forge/core', () => {
    expect(DBC_PROGRAM_ID).toBe(LAUNCH_CHECK_DBC_PROGRAM_ID.toBase58());
    expect(DBC_POOL_CREATOR_OFFSET).toBe(CORE_CREATOR_OFFSET);
  });

  it('accepts the getPoolsByCreator query for both pool account variants', () => {
    expectValid('getProgramAccounts', query(sdkConfig()));
    expectValid('getProgramAccounts', query(sdkConfig([disc(TRANSFER_HOOK_POOL), creatorAt()])));
    // Without a connection commitment, and without the memcmp encoding (base58 is the default).
    expectValid(
      'getProgramAccounts',
      query({ encoding: 'base64', filters: [disc(), creatorAt()] }),
    );
    expectValid('getProgramAccounts', [
      DBC_PROGRAM_ID,
      {
        encoding: 'base64',
        filters: [
          { memcmp: { offset: 0, bytes: VIRTUAL_POOL } },
          { memcmp: { offset: 104, bytes: CREATOR } },
        ],
      },
    ]);
  });

  it.each<[string, unknown]>([
    ['another program', query(sdkConfig(), PK)],
    ['the token program', query(sdkConfig(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')],
    ['no config', [DBC_PROGRAM_ID]],
    ['null config', [DBC_PROGRAM_ID, null]],
    ['too many params', [DBC_PROGRAM_ID, sdkConfig(), {}]],
    ['no filters', query({ encoding: 'base64' })],
    ['empty filters', query(sdkConfig([]))],
    ['missing discriminator filter', query(sdkConfig([creatorAt()]))],
    ['missing creator filter', query(sdkConfig([disc()]))],
    ['two creator filters', query(sdkConfig([disc(), creatorAt(), creatorAt()]))],
    ['two creator filters, no discriminator', query(sdkConfig([creatorAt(), creatorAt()]))],
    ['the pool authority at offset 40', query(sdkConfig([disc(), creatorAt(40)]))],
    ['the base mint at offset 136', query(sdkConfig([disc(), creatorAt(136)]))],
    ['an offset as a string', query(sdkConfig([disc(), creatorAt('104')]))],
    ['dataSize only', query(sdkConfig([{ dataSize: 424 }]))],
    ['an extra dataSize filter', query(sdkConfig([disc(), creatorAt(), { dataSize: 424 }]))],
    ['an extra memcmp filter', query(sdkConfig([disc(), creatorAt(), disc()]))],
    ['filters in another order', query(sdkConfig([creatorAt(), disc()]))],
    ['a config account discriminator', query(sdkConfig([disc(POOL_CONFIG), creatorAt()]))],
    [
      'a creator of 31 bytes',
      query(sdkConfig([disc(), creatorAt(104, encodeBase58(Array(31).fill(7)))])),
    ],
    [
      'a creator of 33 bytes',
      query(sdkConfig([disc(), creatorAt(104, encodeBase58(Array(33).fill(7)))])),
    ],
    ['a creator that is not base58', query(sdkConfig([disc(), creatorAt(104, '0OIl'.repeat(10))]))],
    [
      'base64 memcmp bytes',
      query(
        sdkConfig([
          disc(),
          {
            memcmp: {
              offset: 104,
              bytes: Buffer.alloc(32, 7).toString('base64'),
              encoding: 'base64',
            },
          },
        ]),
      ),
    ],
    [
      'an extra memcmp key',
      query(sdkConfig([disc(), { memcmp: { offset: 104, bytes: CREATOR, length: 32 } }])),
    ],
    ['jsonParsed', query({ ...sdkConfig(), encoding: 'jsonParsed' })],
    ['base64+zstd', query({ ...sdkConfig(), encoding: 'base64+zstd' })],
    ['base58 data', query({ ...sdkConfig(), encoding: 'base58' })],
    ['no data encoding', query({ commitment: 'confirmed', filters: [disc(), creatorAt()] })],
    ['a dataSlice', query({ ...sdkConfig(), dataSlice: { offset: 0, length: 0 } })],
    ['withContext', query({ ...sdkConfig(), withContext: true })],
    ['minContextSlot', query({ ...sdkConfig(), minContextSlot: 1 })],
    ['changedSinceSlot', query({ ...sdkConfig(), changedSinceSlot: 1 })],
    ['a deprecated commitment', query({ ...sdkConfig(), commitment: 'recent' })],
    ['object params', { 0: DBC_PROGRAM_ID, 1: sdkConfig() }],
  ])('refuses %s with the method-not-allowed error', (_label, params) => {
    const result = check('getProgramAccounts', params);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: -32601,
        message: 'Method not allowed by the FORGE relay',
      });
    }
  });

  it('weighs a creator pool query far above an account read', () => {
    const weight = METHODS.getProgramAccounts!.weight(query(sdkConfig()));
    expect(weight).toBe(CREATOR_POOLS_WEIGHT);
    expect(weight).toBeGreaterThanOrEqual(10 * METHODS.getAccountInfo!.weight([PK]));
    expect(weight).toBeGreaterThan(METHODS.sendTransaction!.weight([TX, { encoding: 'base64' }]));
    expect(METHODS.getProgramAccounts!.isSend).toBeUndefined();
  });

  it('accepts the getPoolsByConfig query (config at offset 72), weighed above a creator query', () => {
    expect(DBC_POOL_CONFIG_OFFSET).toBe(CORE_CONFIG_OFFSET);
    const byConfig = query(sdkConfig([disc(), creatorAt(DBC_POOL_CONFIG_OFFSET)]));
    expectValid('getProgramAccounts', byConfig);
    expectValid(
      'getProgramAccounts',
      query(sdkConfig([disc(TRANSFER_HOOK_POOL), creatorAt(DBC_POOL_CONFIG_OFFSET)])),
    );
    expect(isConfigPoolsScan(byConfig)).toBe(true);
    expect(isConfigPoolsScan(query(sdkConfig()))).toBe(false);
    expect(isConfigPoolsScan([PK])).toBe(false);
    expect(METHODS.getProgramAccounts!.weight(byConfig)).toBe(CONFIG_POOLS_WEIGHT);
    expect(CONFIG_POOLS_WEIGHT).toBeGreaterThan(CREATOR_POOLS_WEIGHT);
    // The same strictness as the creator query: one key, nothing else.
    for (const params of [
      query(sdkConfig([disc(), creatorAt(72), creatorAt(104)])),
      query({ ...sdkConfig([disc(), creatorAt(72)]), dataSlice: { offset: 0, length: 0 } }),
      query(sdkConfig([disc(POOL_CONFIG), creatorAt(72)])),
    ]) {
      expectCode('getProgramAccounts', params, -32601);
    }
  });

  it('decodes base58 like web3.js', () => {
    expect(decodeBase58(CREATOR)).toEqual(new PublicKey(CREATOR).toBytes());
    expect(decodeBase58('11111111111111111111111111111111')).toEqual(new Uint8Array(32));
    expect(decodeBase58(VIRTUAL_POOL)).toEqual(Uint8Array.from(DBC_POOL_DISCRIMINATORS[0]!));
    expect(decodeBase58('')).toBeNull();
    expect(decodeBase58('0')).toBeNull();
    expect(decodeBase58('1'.repeat(65))).toBeNull();
  });
});

describe('compatibility with @solana/web3.js', () => {
  /** Captures the JSON-RPC bodies a real Connection sends, answering with minimal stubs. */
  function capturingConnection(results: Record<string, unknown> = {}) {
    const bodies: { method: string; params: unknown }[] = [];
    const fetchStub = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: string;
        method: string;
        params: unknown;
      };
      bodies.push({ method: body.method, params: body.params });
      const answer =
        body.method in results
          ? { result: results[body.method] }
          : body.method === 'getProgramAccounts'
            ? { result: [] }
            : body.method === 'getLatestBlockhash'
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
      () => connection.getRecentPrioritizationFees(),
      () => connection.getRecentPrioritizationFees({ lockedWritableAccounts: [key] }),
      // What core sends for a transaction: its writable accounts, deduplicated and bounded.
      () =>
        estimatePriorityFee({
          connection,
          writableAccounts: Array.from({ length: 40 }, () => Keypair.generate().publicKey),
          computeUnitLimit: 150_000,
        }),
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

  it('accepts the program scans of core listPoolStatesOfConfig (SDK getPoolsByConfig)', async () => {
    const fixtures = JSON.parse(
      readFileSync(
        new URL(
          '../../../../../../packages/core/src/__fixtures__/dbc-devnet-accounts.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { accounts: Record<string, { address: string; owner: string; data: string }> };
    const config = fixtures.accounts.test1Config!;
    const { connection, bodies } = capturingConnection({
      getAccountInfo: {
        context: { slot: 1 },
        value: {
          data: [config.data, 'base64'],
          owner: config.owner,
          lamports: 1,
          executable: false,
          rentEpoch: 0,
          space: Buffer.from(config.data, 'base64').length,
        },
      },
    });
    await expect(
      listPoolStatesOfConfig(connection, new PublicKey(config.address), { retry: { attempts: 1 } }),
    ).resolves.toEqual([]);
    const scans = bodies.filter((b) => b.method === 'getProgramAccounts');
    expect(scans).toHaveLength(2);
    for (const body of bodies) {
      expect(check(body.method, body.params).ok, JSON.stringify(body.params)).toBe(true);
    }
    for (const scan of scans) expect(isConfigPoolsScan(scan.params)).toBe(true);
  });

  it('accepts the program scans of core listCoinsOfCreator (SDK getPoolsByCreator)', async () => {
    const { connection, bodies } = capturingConnection();
    await expect(
      listCoinsOfCreator(connection, new PublicKey(PK2), [Keypair.generate().publicKey], {
        retry: { attempts: 1 },
      }),
    ).resolves.toEqual([]);
    const scans = bodies.filter((b) => b.method === 'getProgramAccounts');
    // One query per pool account variant (plain and transfer-hook pools).
    expect(scans).toHaveLength(2);
    for (const body of bodies) {
      expect(check(body.method, body.params).ok, JSON.stringify(body.params)).toBe(true);
    }
  });
});
