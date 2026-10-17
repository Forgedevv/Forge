/**
 * Swap API V2 (`/build`) client and assembly, over answers captured from the public API
 * (__fixtures__/jupiter-v2-build-*.json, read-only calls with the API reference's example taker):
 * - usdc-sol: 5 USDC -> SOL (`route_v2`), the conversion's direction;
 * - sol-usdc: 0.05 SOL -> USDC (`route_v2`), the buyback's direction (USDC stands for $FORGE);
 * - usdc-sol-shared: 1 USDC -> SOL (`shared_accounts_route_v2`).
 * The chain is faked from the same answers: the lookup tables hold what Jupiter listed.
 */
import { readFileSync } from 'node:fs';
import {
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { checkComputeBudgetInstructions } from '@forge/core';
import {
  JUPITER_PROGRAM_ID,
  JupiterError,
  JupiterRefusal,
  WSOL_MINT,
  createRpcSwapSender,
  decodeJupiterRoute,
  parseConvertConfig,
  validateQuote,
  verifySwapTransaction,
  type JupiterQuote,
  type SwapExpectation,
} from './convert.js';
import { MAX_BUYBACK_SLIPPAGE_BPS, validateBuyQuote } from './buyback.js';
import {
  MAX_JUPITER_LOOKUP_TABLES,
  assembleJupiterSwap,
  createJupiterBuildClient,
  createJupiterV2BuybackClient,
  createJupiterV2Client,
  loadVerifiedLookupTables,
  parseJupiterBuild,
  swapComputeUnitLimit,
  type JupiterApiInstruction,
  type JupiterBuild,
} from './jupiter-v2.js';
import { DEFAULT_SIGNER_PRIORITY_FEE, createPriorityFees } from './priority.js';
import { MAX_COMPUTE_UNIT_LIMIT, assertSignerBudgetPair } from './shared.js';

interface BuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  computeBudgetInstructions: JupiterApiInstruction[];
  setupInstructions: JupiterApiInstruction[];
  swapInstruction: JupiterApiInstruction;
  cleanupInstruction: JupiterApiInstruction | null;
  otherInstructions: JupiterApiInstruction[];
  tipInstruction: JupiterApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]>;
  transactionVersion: number;
  [key: string]: unknown;
}

interface Fixture {
  capturedAt: string;
  request: Record<string, string>;
  response: BuildResponse;
}

function load(name: string): Fixture {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as Fixture;
}

const FIXTURES = {
  convert: load('jupiter-v2-build-usdc-sol.json'),
  buyback: load('jupiter-v2-build-sol-usdc.json'),
  shared: load('jupiter-v2-build-usdc-sol-shared.json'),
};
const TAKER = new PublicKey(FIXTURES.convert.request.taker!);
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const LAST_VALID = 436_200_000;
const SIGNER_FEES = createPriorityFees(null, DEFAULT_SIGNER_PRIORITY_FEE);

/** A deep copy of a captured answer, to tamper with. */
const answer = (f: Fixture): BuildResponse => structuredClone(f.response);

function table(address: string, addresses: readonly string[], deactivated = false) {
  return new AddressLookupTableAccount({
    key: new PublicKey(address),
    state: {
      deactivationSlot: deactivated ? 1n : BigInt('18446744073709551615'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: addresses.map((a) => new PublicKey(a)),
    },
  });
}

/** The chain as the answer describes it: every listed table, as listed. */
function chainOf(response: BuildResponse): Map<string, AddressLookupTableAccount | null> {
  return new Map(
    Object.entries(response.addressesByLookupTableAddress).map(([k, v]) => [k, table(k, v)]),
  );
}

interface FakeChainOptions {
  tables?: Map<string, AddressLookupTableAccount | null>;
  unitsConsumed?: number | undefined;
  simulationError?: unknown;
  recentFees?: number[];
}

/** The RPC methods the assembly reads. */
function assemblyConnection(response: BuildResponse, o: FakeChainOptions = {}) {
  const tables = o.tables ?? chainOf(response);
  return {
    getAddressLookupTable: vi.fn(async (key: PublicKey) => ({
      context: { slot: 1 },
      value: tables.get(key.toBase58()) ?? null,
    })),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: LAST_VALID,
    })),
    simulateTransaction: vi.fn(async () => ({
      context: { slot: 1 },
      value: {
        err: o.simulationError ?? null,
        unitsConsumed: 'unitsConsumed' in o ? o.unitsConsumed : 180_000,
        logs: [],
        accounts: null,
        returnData: null,
      },
    })),
    getRecentPrioritizationFees: vi.fn(async () =>
      (o.recentFees ?? [1_000, 2_000, 3_000, 4_000]).map((fee, slot) => ({
        slot,
        prioritizationFee: fee,
      })),
    ),
  };
}

function buildOf(f: Fixture, response = answer(f)): JupiterBuild {
  return parseJupiterBuild(response, f.request.taker!);
}

async function assemble(
  f: Fixture,
  response = answer(f),
  o: FakeChainOptions & { maxPriorityFeeLamports?: bigint; off?: boolean } = {},
) {
  const connection = assemblyConnection(response, o);
  const assembled = await assembleJupiterSwap(buildOf(f, response), {
    connection: connection as never,
    priorityFees: o.off ? { setting: undefined } : SIGNER_FEES,
    maxPriorityFeeLamports: o.maxPriorityFeeLamports ?? 1_000_000n,
  });
  return { ...assembled, connection };
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(JupiterRefusal);
  return (err as JupiterRefusal).reason;
}

/** The expectation the conversion job derives from a validated quote. */
function convertExpectation(r: BuildResponse, maxSlippageBps = 100): SwapExpectation {
  return {
    inputMint: r.inputMint,
    inAmount: BigInt(r.inAmount),
    minOutLamports: BigInt(r.otherAmountThreshold),
    quotedOutAmount: BigInt(r.outAmount),
    maxSlippageBps,
    forbiddenMints: [],
  };
}

function fetchOf(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

// ---------------------------------------------------------------------------------------------
// Transport and parsing

describe('createJupiterBuildClient', () => {
  const client = (fetchMock: ReturnType<typeof vi.fn>, apiKey?: string) =>
    createJupiterBuildClient({
      baseUrl: 'https://jup.example.test/swap/v2/',
      apiKey,
      fetch: fetchMock as unknown as typeof fetch,
      minRequestIntervalMs: 0,
      timeoutMs: 1_000,
    });
  const request = {
    inputMint: USDC.toBase58(),
    outputMint: WSOL_MINT,
    amount: 5_000_000n,
    slippageBps: 50,
    taker: TAKER.toBase58(),
  };

  it('asks GET /build for the taker, ExactIn by construction, with the key header', async () => {
    const fetchMock = fetchOf(FIXTURES.convert.response);
    await client(fetchMock, 'my-key').build(request);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe('/swap/v2/build');
    expect(Object.fromEntries(u.searchParams)).toEqual(FIXTURES.convert.request);
    // Never asked: a platform fee, a tip, another payer, a mode (`/build` has no swapMode and no
    // restrictIntermediateTokens).
    for (const name of ['platformFeeBps', 'feeAccount', 'tipAmount', 'payer', 'swapMode']) {
      expect(u.searchParams.has(name)).toBe(false);
    }
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('my-key');
  });

  it('parses the captured answers: the quote fields only, then the instructions', async () => {
    for (const f of Object.values(FIXTURES)) {
      const build = await client(fetchOf(f.response)).build({
        ...request,
        inputMint: f.request.inputMint!,
        outputMint: f.request.outputMint!,
        amount: BigInt(f.request.amount!),
      });
      const r = f.response;
      expect(build.quote).toEqual({
        inputMint: r.inputMint,
        outputMint: r.outputMint,
        inAmount: r.inAmount,
        outAmount: r.outAmount,
        otherAmountThreshold: r.otherAmountThreshold,
        swapMode: 'ExactIn',
        slippageBps: 50,
        priceImpactPct: r.priceImpactPct,
      });
      expect(build.taker).toBe(TAKER.toBase58());
      expect(build.instructions.swapInstruction.programId).toBe(JUPITER_PROGRAM_ID);
      expect(build.instructions.transactionVersion).toBe(0);
      expect(build.instructions.tipInstruction).toBeNull();
    }
  });

  it('turns HTTP errors, bad shapes and network failures into JupiterError without the key', async () => {
    await expect(
      client(fetchOf({ error: 'No routes found' }, 400), 'secret-key-value').build(request),
    ).rejects.toMatchObject({ name: 'JupiterError', status: 400 });
    const noSwap = answer(FIXTURES.convert) as Record<string, unknown>;
    delete noSwap.swapInstruction;
    await expect(client(fetchOf(noSwap)).build(request)).rejects.toThrow(/unexpected shape/);
    const noQuote = answer(FIXTURES.convert) as Record<string, unknown>;
    delete noQuote.otherAmountThreshold;
    await expect(client(fetchOf(noQuote)).build(request)).rejects.toThrow(/unexpected shape/);
    await expect(
      client(vi.fn(async () => new Response('not json', { status: 200 }))).build(request),
    ).rejects.toThrow(/invalid JSON/);
    const err = await client(
      vi.fn(async () => {
        throw new TypeError('fetch failed secret-key-value');
      }),
      'secret-key-value',
    )
      .build(request)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(JupiterError);
    expect((err as Error).message).not.toContain('secret-key-value');
  });

  it('refuses plain http and spaces its calls', async () => {
    expect(() =>
      createJupiterBuildClient({
        baseUrl: 'http://jup.example.test',
        minRequestIntervalMs: 0,
        timeoutMs: 1_000,
      }),
    ).toThrow(/https/);
    let t = 0;
    const sleeps: number[] = [];
    const c = createJupiterBuildClient({
      baseUrl: 'https://jup.example.test',
      fetch: fetchOf(FIXTURES.convert.response) as unknown as typeof fetch,
      minRequestIntervalMs: 1_000,
      timeoutMs: 1_000,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await c.build(request);
    t += 300;
    await c.build(request);
    expect(sleeps).toEqual([700]);
  });
});

// ---------------------------------------------------------------------------------------------
// Assembly

describe('assembleJupiterSwap', () => {
  it('builds a v0 transaction paid by the taker, with the RPC blockhash and the on-chain tables', async () => {
    const r = answer(FIXTURES.convert);
    const { transaction, lastValidBlockHeight, connection } = await assemble(FIXTURES.convert, r);
    const message = transaction.message;
    expect(message.version).toBe(0);
    expect(message.staticAccountKeys[0]!.equals(TAKER)).toBe(true);
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(message.recentBlockhash).toBe(BLOCKHASH);
    expect(lastValidBlockHeight).toBe(LAST_VALID);
    expect(transaction.serialize().length).toBeLessThanOrEqual(1232);
    // Every table Jupiter named was read from the chain, and the message uses them.
    expect(connection.getAddressLookupTable).toHaveBeenCalledTimes(
      Object.keys(r.addressesByLookupTableAddress).length,
    );
    for (const lookup of message.addressTableLookups) {
      expect(Object.keys(r.addressesByLookupTableAddress)).toContain(lookup.accountKey.toBase58());
    }
    // Jupiter's instructions, in order, after the signer's compute budget pair.
    const tables = [...chainOf(r).values()] as AddressLookupTableAccount[];
    const decompiled = TransactionMessage.decompile(message, {
      addressLookupTableAccounts: tables,
    });
    const expected = [...r.setupInstructions, r.swapInstruction, r.cleanupInstruction!];
    expect(decompiled.instructions.slice(2).map((ix) => ix.programId.toBase58())).toEqual(
      expected.map((ix) => ix.programId),
    );
    expect(decompiled.instructions.slice(2).map((ix) => ix.data.toString('base64'))).toEqual(
      expected.map((ix) => ix.data),
    );
    // The swap's accounts, in order; the message merges the flags (writable or signer anywhere).
    const swapKeys = decompiled.instructions[2 + r.setupInstructions.length]!.keys;
    expect(swapKeys.map((k) => k.pubkey.toBase58())).toEqual(
      r.swapInstruction.accounts.map((a) => a.pubkey),
    );
    r.swapInstruction.accounts.forEach((a, i) => {
      if (a.isWritable) expect(swapKeys[i]!.isWritable).toBe(true);
      if (a.isSigner) expect(swapKeys[i]!.isSigner).toBe(true);
      // Only the taker signs (it appears several times in the swap, once as its signer).
      if (swapKeys[i]!.isSigner) expect(swapKeys[i]!.pubkey.equals(TAKER)).toBe(true);
    });
  });

  it("sets its own compute budget pair: 1.2x the simulated units, the signer price, never Jupiter's", async () => {
    const r = answer(FIXTURES.convert);
    const { transaction, priorityFee, connection } = await assemble(FIXTURES.convert, r);
    const ixs = TransactionMessage.decompile(transaction.message, {
      addressLookupTableAccounts: [...chainOf(r).values()] as AddressLookupTableAccount[],
    }).instructions;
    expect(ixs[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ixs[0]!.data[0]).toBe(2);
    expect(ixs[0]!.data.readUInt32LE(1)).toBe(216_000);
    expect(ixs[1]!.data[0]).toBe(3);
    // 75th percentile of the recent fees of the swap's writable accounts.
    expect(ixs[1]!.data.readBigUInt64LE(1)).toBe(3_000n);
    expect(priorityFee).toMatchObject({ computeUnitLimit: 216_000, microLamports: 3_000 });
    // Jupiter's price (500 micro-lamports) is dropped; no other compute budget instruction.
    expect(Buffer.from(r.computeBudgetInstructions[0]!.data, 'base64').readBigUInt64LE(1)).toBe(
      500n,
    );
    expect(ixs.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId))).toHaveLength(2);
    expect(assertSignerBudgetPair(ixs, 1_000_000n)).toBe(2);
    // The units were measured at the ceiling, the fees read for the accounts the swap writes.
    const probe = (
      connection.simulateTransaction.mock.calls[0] as unknown as [VersionedTransaction]
    )[0];
    expect(
      TransactionMessage.decompile(probe.message, {
        addressLookupTableAccounts: [...chainOf(r).values()] as AddressLookupTableAccount[],
      }).instructions[0]!.data.readUInt32LE(1),
    ).toBe(MAX_COMPUTE_UNIT_LIMIT);
    const fees = connection.getRecentPrioritizationFees.mock.calls[0] as unknown as [
      { lockedWritableAccounts: PublicKey[] },
    ];
    expect(fees[0].lockedWritableAccounts.map((k) => k.toBase58())).toContain(TAKER.toBase58());
  });

  it('bounds the priority fee by the job cap and the unit limit by 1.4M, whatever the cluster says', async () => {
    for (const unitsConsumed of [180_000, 1_300_000, undefined]) {
      const { transaction, priorityFee } = await assemble(FIXTURES.buyback, undefined, {
        recentFees: [10_000_000, 10_000_000],
        unitsConsumed,
        maxPriorityFeeLamports: 100_000n,
      });
      expect(priorityFee.computeUnitLimit).toBeLessThanOrEqual(1_400_000);
      expect(priorityFee.priorityFeeLamports).toBeLessThanOrEqual(100_000n);
      const r = FIXTURES.buyback.response;
      const ixs = TransactionMessage.decompile(transaction.message, {
        addressLookupTableAccounts: [...chainOf(r).values()] as AddressLookupTableAccount[],
      }).instructions;
      // The core policy check with the job's cap agrees.
      expect(
        checkComputeBudgetInstructions(ixs, { maxPriorityFeeLamports: 100_000n })
          .priorityFeeLamports,
      ).toBeLessThanOrEqual(100_000n);
    }
    expect(swapComputeUnitLimit(1_300_000)).toBe(1_400_000);
    expect(swapComputeUnitLimit(undefined)).toBe(1_400_000);
    expect(swapComputeUnitLimit(0)).toBe(1_400_000);
    expect(swapComputeUnitLimit(100_001)).toBe(120_002);
    // The signer's own cap per transaction (0.0005 SOL by default) wins over a larger job cap.
    const { priorityFee } = await assemble(FIXTURES.convert, undefined, {
      recentFees: [10_000_000],
      unitsConsumed: 1_000_000,
      maxPriorityFeeLamports: 5_000_000n,
    });
    expect(priorityFee.priorityFeeLamports).toBeLessThanOrEqual(500_000n);
  });

  it('still sets the unit limit when priority fees are off (a zero price)', async () => {
    const { priorityFee, connection } = await assemble(FIXTURES.convert, undefined, { off: true });
    expect(priorityFee).toMatchObject({ computeUnitLimit: 216_000, microLamports: 0 });
    expect(connection.getRecentPrioritizationFees).not.toHaveBeenCalled();
    const zeroCap = await assemble(FIXTURES.convert, undefined, { maxPriorityFeeLamports: 0n });
    expect(zeroCap.priorityFee.microLamports).toBe(0);
  });

  describe('lookup tables', () => {
    const r = FIXTURES.shared.response;
    const [first, ...others] = Object.entries(r.addressesByLookupTableAddress);
    const [address, listed] = first!;
    const chainWith = (t: AddressLookupTableAccount | null) =>
      new Map<string, AddressLookupTableAccount | null>([
        [address, t],
        ...others.map(([k, v]): [string, AddressLookupTableAccount] => [k, table(k, v)]),
      ]);

    it('refuses a table whose addresses differ from the chain', async () => {
      const swapped = [...listed];
      swapped[5] = Keypair.generate().publicKey.toBase58();
      expect(
        await refusalOf(
          assemble(FIXTURES.shared, undefined, { tables: chainWith(table(address, swapped)) }),
        ),
      ).toBe('lookup_table_mismatch');
      // Jupiter lists more addresses than the chain holds.
      expect(
        await refusalOf(
          assemble(FIXTURES.shared, undefined, {
            tables: chainWith(table(address, listed.slice(0, -1))),
          }),
        ),
      ).toBe('lookup_table_mismatch');
    });

    it('refuses a table missing from the chain or deactivated', async () => {
      expect(
        await refusalOf(assemble(FIXTURES.shared, undefined, { tables: chainWith(null) })),
      ).toBe('lookup_table_missing');
      expect(
        await refusalOf(
          assemble(FIXTURES.shared, undefined, { tables: chainWith(table(address, listed, true)) }),
        ),
      ).toBe('lookup_table_inactive');
    });

    it('accepts a table extended since Jupiter read it, compiled against the chain', async () => {
      const extended = table(address, [...listed, Keypair.generate().publicKey.toBase58()]);
      const { transaction } = await assemble(FIXTURES.shared, undefined, {
        tables: chainWith(extended),
      });
      const onChain = [...chainWith(extended).values()] as AddressLookupTableAccount[];
      expect(() =>
        transaction.message.getAccountKeys({ addressLookupTableAccounts: onChain }),
      ).not.toThrow();
    });

    it('refuses too many tables before reading any', async () => {
      const many: Record<string, string[]> = {};
      for (let i = 0; i <= MAX_JUPITER_LOOKUP_TABLES; i++) {
        many[Keypair.generate().publicKey.toBase58()] = [];
      }
      const getAddressLookupTable = vi.fn();
      expect(
        await refusalOf(loadVerifiedLookupTables({ getAddressLookupTable } as never, many)),
      ).toBe('too_many_lookup_tables');
      expect(getAddressLookupTable).not.toHaveBeenCalled();
    });
  });

  it('refuses another signer, a tip, a v1 build and misplaced compute budget instructions', async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const cases: Array<[string, (r: BuildResponse) => void]> = [
      [
        'build_unexpected_signer',
        (r) => {
          r.setupInstructions[0]!.accounts.push({
            pubkey: other,
            isSigner: true,
            isWritable: false,
          });
        },
      ],
      [
        'build_tip_not_allowed',
        (r) => {
          r.tipInstruction = {
            programId: SystemProgram.programId.toBase58(),
            accounts: [],
            data: 'AgAAAEBCDwAAAAAA',
          };
        },
      ],
      ['build_not_v0', (r) => void (r.transactionVersion = 1)],
      [
        'build_compute_budget_not_allowed',
        (r) => {
          r.computeBudgetInstructions.push(r.cleanupInstruction!);
        },
      ],
      [
        'build_compute_budget_not_allowed',
        (r) => {
          r.otherInstructions.push(r.computeBudgetInstructions[0]!);
        },
      ],
      ['build_invalid_instruction', (r) => void (r.swapInstruction.data = 'not base64!')],
      ['build_invalid_instruction', (r) => void (r.swapInstruction.programId = 'nope')],
    ];
    for (const [reason, tamper] of cases) {
      const r = answer(FIXTURES.convert);
      tamper(r);
      expect(await refusalOf(assemble(FIXTURES.convert, r))).toBe(reason);
    }
  });

  it('refuses a swap that fails in simulation', async () => {
    expect(
      await refusalOf(
        assemble(FIXTURES.convert, undefined, {
          simulationError: { InstructionError: [3, { Custom: 6001 }] },
        }),
      ),
    ).toBe('simulation_failed');
  });
});

// ---------------------------------------------------------------------------------------------
// The assembled transaction under the unchanged policy

describe('V2 transactions under the static allowlist', () => {
  it.each([
    ['usdc-sol (route_v2)', FIXTURES.convert, 'route_v2'],
    ['usdc-sol (shared_accounts_route_v2)', FIXTURES.shared, 'shared_accounts_route_v2'],
  ])('accepts the conversion %s bound to its quote', async (_name, f, route) => {
    const r = f.response;
    expect(decodeJupiterRoute(Buffer.from(r.swapInstruction.data, 'base64'))).toMatchObject({
      ok: true,
      route: { instruction: route, inAmount: BigInt(r.inAmount) },
    });
    const { transaction } = await assemble(f);
    const lookupTables = [...chainOf(r).values()] as AddressLookupTableAccount[];
    const check = verifySwapTransaction(transaction, {
      owner: TAKER.toBase58(),
      lookupTables,
      expected: convertExpectation(r),
      maxPriorityFeeLamports: 1_000_000n,
    });
    expect(check).toMatchObject({ ok: true });
    // The bound the simulation check uses: the base fee plus at most the cap.
    expect((check as { feeBoundLamports: bigint }).feeBoundLamports).toBeLessThanOrEqual(
      5_000n + 500_000n,
    );
  });

  it('accepts the buyback direction (SOL -> token, wSOL wrapped by the swap)', async () => {
    const r = FIXTURES.buyback.response;
    const { transaction } = await assemble(FIXTURES.buyback, undefined, {
      maxPriorityFeeLamports: 100_000n,
    });
    // How createRpcBuybackSwapPreparer calls it: the token side by mint, the lamports sold.
    const check = verifySwapTransaction(transaction, {
      owner: TAKER.toBase58(),
      lookupTables: [...chainOf(r).values()] as AddressLookupTableAccount[],
      expected: {
        inputMint: r.outputMint,
        inAmount: BigInt(r.inAmount),
        minOutLamports: 0n,
        quotedOutAmount: BigInt(r.outAmount),
        maxSlippageBps: MAX_BUYBACK_SLIPPAGE_BPS,
        forbiddenMints: [],
      },
      maxPriorityFeeLamports: 100_000n,
    });
    expect(check).toMatchObject({ ok: true });
    expect(
      validateBuyQuote(
        buildOf(FIXTURES.buyback).quote,
        { forgeMint: r.outputMint, lamports: BigInt(r.inAmount) },
        { maxSlippageBps: 50, maxPriceImpactBps: 100 },
      ),
    ).toBeNull();
  });

  it('enforces the minimum: a quote above the route, a slippage above the cap, a fee above the cap', async () => {
    const r = FIXTURES.convert.response;
    const { transaction } = await assemble(FIXTURES.convert);
    const lookupTables = [...chainOf(r).values()] as AddressLookupTableAccount[];
    const verify = (expected: SwapExpectation, maxPriorityFeeLamports = 1_000_000n) =>
      verifySwapTransaction(transaction, {
        owner: TAKER.toBase58(),
        lookupTables,
        expected,
        maxPriorityFeeLamports,
      });
    // The route instruction announces the quote's output: a quote claiming more is refused.
    expect(verify({ ...convertExpectation(r), quotedOutAmount: BigInt(r.outAmount) + 1n })).toEqual(
      { ok: false, reason: 'jupiter_route_quoted_out_too_low' },
    );
    // The route carries 50 bps: a cap of 40 refuses it.
    expect(verify(convertExpectation(r, 40))).toEqual({
      ok: false,
      reason: 'jupiter_route_slippage_too_high',
    });
    expect(verify({ ...convertExpectation(r), inAmount: BigInt(r.inAmount) - 1n })).toEqual({
      ok: false,
      reason: 'jupiter_route_amount_mismatch',
    });
    // A transaction priced above the verifier's cap is refused.
    expect(verify(convertExpectation(r), 1n)).toEqual({
      ok: false,
      reason: 'priority_fee_too_high',
    });
    // The quote itself passes the conversion's quote checks.
    expect(
      validateQuote(
        buildOf(FIXTURES.convert).quote,
        { inputMint: r.inputMint, amount: BigInt(r.inAmount) },
        parseConvertConfig({}),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Job clients, end to end through the conversion's sender

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

/** The chain for the conversion fixture: the taker holds 5 USDC and 0.1 SOL. */
function convertChain(solGained: bigint) {
  const r = FIXTURES.convert.response;
  const usdcAta = getAssociatedTokenAddressSync(USDC, TAKER, true, TOKEN_PROGRAM_ID);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, TAKER, true, TOKEN_PROGRAM_ID);
  const ownerLamports = 100_000_000;
  const usdc = {
    data: tokenAccountData(USDC, TAKER, BigInt(r.inAmount)),
    executable: false,
    lamports: 2_039_280,
    owner: TOKEN_PROGRAM_ID,
    rentEpoch: 0,
  };
  const assembly = assemblyConnection(r);
  const sent: Uint8Array[] = [];
  const connection = {
    ...assembly,
    simulateTransaction: vi.fn(
      async (tx: VersionedTransaction, config?: { accounts?: { addresses: string[] } }) => {
        if (!config?.accounts) return assembly.simulateTransaction();
        return {
          context: { slot: 10 },
          value: {
            err: null,
            unitsConsumed: 180_000,
            logs: [],
            returnData: null,
            accounts: config.accounts.addresses.map((address) => {
              if (address === TAKER.toBase58()) {
                return {
                  owner: SystemProgram.programId.toBase58(),
                  lamports: ownerLamports + Number(solGained),
                  data: ['', 'base64'],
                  executable: false,
                  rentEpoch: 0,
                };
              }
              if (address === usdcAta.toBase58()) {
                return {
                  owner: TOKEN_PROGRAM_ID.toBase58(),
                  lamports: usdc.lamports,
                  data: [tokenAccountData(USDC, TAKER, 0n).toString('base64'), 'base64'],
                  executable: false,
                  rentEpoch: 0,
                };
              }
              // The temporary wSOL account is closed by the swap; nothing else is held.
              return null;
            }),
          },
        };
      },
    ),
    getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({
      context: { slot: 10 },
      value: keys.map((key) => {
        if (key.equals(TAKER)) {
          return {
            data: Buffer.alloc(0),
            executable: false,
            lamports: ownerLamports,
            owner: SystemProgram.programId,
            rentEpoch: 0,
          };
        }
        return key.equals(usdcAta) ? usdc : null;
      }),
    })),
    getTokenAccountsByOwner: vi.fn(async (_owner: PublicKey, filter: { programId: PublicKey }) => ({
      context: { slot: 10 },
      value: filter.programId.equals(TOKEN_PROGRAM_ID) ? [{ pubkey: usdcAta, account: usdc }] : [],
    })),
    sendRawTransaction: vi.fn(async (raw: Uint8Array) => {
      sent.push(raw);
      return 'SIGNATURE';
    }),
    getSignatureStatuses: vi.fn(async () => ({
      context: { slot: 10 },
      value: [{ err: null, confirmationStatus: 'confirmed', slot: 10, confirmations: 1 }],
    })),
    getBlockHeight: vi.fn(async () => LAST_VALID - 100),
    getSlot: vi.fn(async () => 10),
    getTransaction: vi.fn(async () => null),
  };
  return { connection, sent, wsolAta };
}

describe('createJupiterV2Client (conversion)', () => {
  const transport = {
    baseUrl: 'https://jup.example.test/swap/v2',
    apiKey: 'k',
    minRequestIntervalMs: 0,
    timeoutMs: 1_000,
    priorityFees: SIGNER_FEES,
    maxPriorityFeeLamports: 1_000_000n,
  };
  const r = FIXTURES.convert.response;
  const quoteInput = {
    inputMint: r.inputMint,
    amount: BigInt(r.inAmount),
    slippageBps: 50,
    taker: TAKER.toBase58(),
  };

  it('quotes through /build to wrapped SOL and swaps a transaction the sender confirms', async () => {
    const chain = convertChain(BigInt(r.otherAmountThreshold));
    const fetchMock = fetchOf(r);
    const client = createJupiterV2Client({
      ...transport,
      connection: chain.connection as never,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const quote = await client.quote(quoteInput);
    const u = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(u.searchParams.get('outputMint')).toBe(WSOL_MINT);
    expect(u.searchParams.get('taker')).toBe(TAKER.toBase58());
    const swap = await client.swap({ quote, userPublicKey: TAKER.toBase58() });
    expect(swap.lastValidBlockHeight).toBe(LAST_VALID);
    // Only one Jupiter call: the instructions came with the quote.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const sign = vi.fn(async (_owner: string, tx: VersionedTransaction) => {
      // Stand-in signature: the keystore signs in production.
      tx.signatures[0] = new Uint8Array(64).fill(7);
    });
    const sender = createRpcSwapSender({
      connection: chain.connection as never,
      signTransaction: sign,
      maxPriorityFeeLamports: 1_000_000n,
      confirmTimeoutMs: 10_000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    const result = await sender.send({
      owner: TAKER.toBase58(),
      swapTransaction: swap.swapTransaction,
      lastValidBlockHeight: swap.lastValidBlockHeight,
      expected: convertExpectation(r),
    });
    expect(result).toMatchObject({ status: 'confirmed' });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(chain.sent).toHaveLength(1);
  });

  it('refuses before signing when the simulated output is below the quote minimum', async () => {
    // Less SOL than otherAmountThreshold minus the fee bound.
    const chain = convertChain(BigInt(r.otherAmountThreshold) - 600_000n);
    const client = createJupiterV2Client({
      ...transport,
      connection: chain.connection as never,
      fetch: fetchOf(r) as unknown as typeof fetch,
    });
    const quote = await client.quote(quoteInput);
    const swap = await client.swap({ quote, userPublicKey: TAKER.toBase58() });
    const sign = vi.fn();
    const sender = createRpcSwapSender({
      connection: chain.connection as never,
      signTransaction: sign,
      maxPriorityFeeLamports: 1_000_000n,
    });
    expect(
      await sender.send({
        owner: TAKER.toBase58(),
        swapTransaction: swap.swapTransaction,
        lastValidBlockHeight: swap.lastValidBlockHeight,
        expected: convertExpectation(r),
      }),
    ).toEqual({ status: 'refused', reason: 'output_below_minimum' });
    expect(sign).not.toHaveBeenCalled();
    expect(chain.sent).toHaveLength(0);
  });

  it('swaps only its own quotes, once, for their taker', async () => {
    const chain = convertChain(BigInt(r.otherAmountThreshold));
    const client = createJupiterV2Client({
      ...transport,
      connection: chain.connection as never,
      fetch: fetchOf(r) as unknown as typeof fetch,
    });
    const foreign = { ...buildOf(FIXTURES.convert).quote } as JupiterQuote;
    await expect(client.swap({ quote: foreign, userPublicKey: TAKER.toBase58() })).rejects.toThrow(
      /not built by this Jupiter client/,
    );
    const quote = await client.quote(quoteInput);
    expect(
      await refusalOf(
        client.swap({ quote, userPublicKey: Keypair.generate().publicKey.toBase58() }),
      ),
    ).toBe('build_taker_mismatch');
    // A build is assembled at most once.
    await expect(client.swap({ quote, userPublicKey: TAKER.toBase58() })).rejects.toThrow(
      /not built by this Jupiter client/,
    );
  });
});

describe('createJupiterV2BuybackClient', () => {
  it('quotes wrapped SOL to the token for the taker and assembles the buy', async () => {
    const r = FIXTURES.buyback.response;
    const fetchMock = fetchOf(r);
    const client = createJupiterV2BuybackClient({
      baseUrl: 'https://jup.example.test/swap/v2',
      minRequestIntervalMs: 0,
      timeoutMs: 1_000,
      fetch: fetchMock as unknown as typeof fetch,
      connection: assemblyConnection(r) as never,
      priorityFees: SIGNER_FEES,
      maxPriorityFeeLamports: 100_000n,
    });
    const quote = await client.quote({
      outputMint: r.outputMint,
      lamports: BigInt(r.inAmount),
      slippageBps: 50,
      taker: TAKER.toBase58(),
    });
    const u = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(u.searchParams.get('inputMint')).toBe(WSOL_MINT);
    expect(u.searchParams.get('outputMint')).toBe(r.outputMint);
    expect(u.searchParams.get('amount')).toBe(r.inAmount);
    const swap = await client.swap({ quote, userPublicKey: TAKER.toBase58() });
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    expect(tx.message.staticAccountKeys[0]!.equals(TAKER)).toBe(true);
    expect(swap.lastValidBlockHeight).toBe(LAST_VALID);
  });
});
