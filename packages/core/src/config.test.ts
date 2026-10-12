import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  bpsToFeeNumerator,
  getFeeSchedulerMinBaseFeeNumerator,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  type AccountInfo,
} from '@solana/web3.js';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import type { LaunchpadSpec, LaunchpadSpecInput } from '@forge/shared';
import {
  ANTI_SNIPER_FEE_SCHEDULE,
  CREATE_CONFIG_COMPUTE_UNITS,
  CreateConfigError,
  FORGE_ACTIVATION_TYPE,
  FORGE_MIGRATION_SETTINGS,
  buildConfigParams,
  buildCreateConfigTx,
  buildLaunchpadCoinConfig,
  buildLaunchpadConfig,
  parseLaunchpadSpec,
  quoteFirstBuyOnConfig,
  type LaunchpadConfigParams,
} from './config.js';
import {
  FEES,
  MAX_ANTI_SNIPER_DURATION_SECONDS,
  MAX_FIRST_BUY_SOL,
  MIGRATION_THRESHOLD_LAMPORTS,
  MIN_LOCKED_LIQUIDITY_BPS,
  SOL_QUOTE_MINT,
  solToLamports,
} from './constants.js';
import {
  ValidationError,
  validateLaunchpadCoinConfigParams,
  validateLaunchpadConfigParams,
  type ViolationCode,
} from './validate.js';

const OWNER = Keypair.generate().publicKey;

function makeSpec(overrides: Partial<LaunchpadSpec> = {}): LaunchpadSpec {
  return {
    version: 1,
    ownerWallet: OWNER.toBase58(),
    name: 'MoonPad',
    slug: 'moonpad',
    quote: 'SOL',
    tradingFeeBps: 100,
    coinCreatorSharePct: 25,
    poolCreationFeeSol: 0.05,
    antiSniper: true,
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
      description: 'The MoonPad coin',
      imageUrl: 'https://example.com/moon.png',
      firstBuySol: 0.5,
    },
    ...overrides,
  };
}

const numerator = (value: BN | number | bigint) => BigInt(value.toString());
const bpsNumerator = (bps: number) => numerator(bpsToFeeNumerator(bps));

function endingFeeNumerator(params: LaunchpadConfigParams): bigint {
  const { baseFee } = params.poolFees;
  if (baseFee.firstFactor === 0) return numerator(baseFee.cliffFeeNumerator);
  return numerator(
    getFeeSchedulerMinBaseFeeNumerator(
      baseFee.cliffFeeNumerator,
      baseFee.firstFactor,
      baseFee.thirdFactor,
      baseFee.baseFeeMode,
    ),
  );
}

function violationCodes(fn: () => unknown): ViolationCode[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return error.violations.map((v) => v.code);
    throw error;
  }
  return [];
}

/** BN / PublicKey aware JSON, to compare whole results. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (BN.isBN(v)) return `bn:${v.toString()}`;
    if (v instanceof PublicKey) return `pk:${v.toBase58()}`;
    return v;
  });
}

const builders = [
  ['launchpad', buildLaunchpadConfig],
  ['launchpadCoin', buildLaunchpadCoinConfig],
] as const;

describe.each(builders)('%s config: spec field mapping', (_kind, build) => {
  it('pays the client: fee claimer = leftover receiver = spec.ownerWallet, quote SOL', () => {
    const params = build(makeSpec());
    expect(params.feeClaimer.equals(OWNER)).toBe(true);
    expect(params.leftoverReceiver.equals(OWNER)).toBe(true);
    expect(params.quoteMint.equals(SOL_QUOTE_MINT)).toBe(true);
  });

  it('never uses another fee claimer than the client wallet (a multisig is refused)', () => {
    const params = build(makeSpec());
    const multisig = Keypair.generate().publicKey;
    const validate =
      _kind === 'launchpadCoin' ? validateLaunchpadCoinConfigParams : validateLaunchpadConfigParams;
    const result = validate({ ...params, feeClaimer: multisig }, makeSpec());
    expect(result.violations.map((v) => v.code)).toEqual(['FEE_CLAIMER_MISMATCH']);
  });

  it.each([50, 100, 137, 200])(
    'ends at exactly spec.tradingFeeBps = %i with anti-sniper',
    (bps) => {
      const params = build(makeSpec({ tradingFeeBps: bps, antiSniper: true }));
      const { baseFee } = params.poolFees;
      expect(baseFee.baseFeeMode).toBe(BaseFeeMode.FeeSchedulerLinear);
      expect(numerator(baseFee.cliffFeeNumerator)).toBe(
        bpsNumerator(ANTI_SNIPER_FEE_SCHEDULE.startingFeeBps),
      );
      expect(baseFee.firstFactor).toBe(ANTI_SNIPER_FEE_SCHEDULE.numberOfPeriod);
      expect(numerator(baseFee.secondFactor)).toBe(
        BigInt(
          ANTI_SNIPER_FEE_SCHEDULE.totalDurationSeconds / ANTI_SNIPER_FEE_SCHEDULE.numberOfPeriod,
        ),
      );
      expect(endingFeeNumerator(params)).toBe(bpsNumerator(bps));
    },
  );

  it.each([50, 100, 200])('uses a flat spec.tradingFeeBps = %i without anti-sniper', (bps) => {
    const params = build(makeSpec({ tradingFeeBps: bps, antiSniper: false }));
    const { baseFee } = params.poolFees;
    expect(numerator(baseFee.cliffFeeNumerator)).toBe(bpsNumerator(bps));
    expect(baseFee.firstFactor).toBe(0);
    expect(numerator(baseFee.secondFactor)).toBe(0n);
    expect(numerator(baseFee.thirdFactor)).toBe(0n);
  });

  it('keeps the anti-sniper phase within the FORGE bound', () => {
    const { baseFee } = build(makeSpec()).poolFees;
    expect(baseFee.firstFactor * Number(baseFee.secondFactor)).toBeLessThanOrEqual(
      MAX_ANTI_SNIPER_DURATION_SECONDS,
    );
    expect(FORGE_ACTIVATION_TYPE).toBe(ActivationType.Timestamp);
  });

  it.each([
    [0, 0n],
    [0.001, 1_000_000n],
    [0.05, 50_000_000n],
    [1, 1_000_000_000n],
  ])(
    'maps poolCreationFeeSol %d to %s lamports (none on the launchpad coin config)',
    (sol, lamports) => {
      expect(numerator(build(makeSpec({ poolCreationFeeSol: sol })).poolCreationFee)).toBe(
        _kind === 'launchpadCoin' ? 0n : lamports,
      );
    },
  );

  it('migrates to DAMM v2 at exactly 10 SOL, immutable metadata, first swap at minimum fee', () => {
    const params = build(makeSpec());
    expect(numerator(params.migrationQuoteThreshold)).toBe(MIGRATION_THRESHOLD_LAMPORTS);
    expect(numerator(params.migrationQuoteThreshold)).toBe(10_000_000_000n);
    expect(params.migrationOption).toBe(MigrationOption.MET_DAMM_V2);
    expect(params.migrationFeeOption).toBe(MigrationFeeOption.FixedBps25);
    expect(params.migrationFee).toEqual(FORGE_MIGRATION_SETTINGS.migrationFee);
    expect(params.tokenUpdateAuthority).toBe(TokenAuthorityOption.Immutable);
    expect(params.enableFirstSwapWithMinFee).toBe(true);
    expect(params.poolFees.dynamicFee).toBeNull();
    expect(params.collectFeeMode).toBe(CollectFeeMode.QuoteToken);
    expect(params.activationType).toBe(ActivationType.Timestamp);
    expect(params.tokenType).toBe(TokenType.SPLToken);
    expect(params.tokenDecimal).toBe(TokenDecimal.SIX);
    expect(numerator(params.tokenSupply!.preMigrationTokenSupply)).toBe(10n ** 15n);
  });

  it('locks all post-graduation liquidity permanently', () => {
    const params = build(makeSpec());
    expect(params.partnerLiquidityPercentage).toBe(0);
    expect(params.creatorLiquidityPercentage).toBe(0);
    expect(
      params.partnerPermanentLockedLiquidityPercentage +
        params.creatorPermanentLockedLiquidityPercentage,
    ).toBe(100);
    expect(100 * 100).toBeGreaterThanOrEqual(MIN_LOCKED_LIQUIDITY_BPS);
  });

  it('is pure and deterministic', () => {
    const spec = makeSpec();
    const before = toJson(spec);
    const a = build(spec);
    const b = build(spec);
    expect(a).not.toBe(b);
    expect(toJson(a)).toBe(toJson(b));
    expect(toJson(spec)).toBe(before);
  });
});

describe('creator share', () => {
  it.each([0, 1, 25, 50])('launchpad config uses spec.coinCreatorSharePct = %i', (pct) => {
    const params = buildLaunchpadConfig(makeSpec({ coinCreatorSharePct: pct }));
    expect(params.creatorTradingFeePercentage).toBe(pct);
    expect(params.creatorPermanentLockedLiquidityPercentage).toBe(pct);
    expect(params.partnerPermanentLockedLiquidityPercentage).toBe(100 - pct);
  });

  it.each([0, 25, 50])('coin config always gives FORGE 25%% (spec share %i ignored)', (pct) => {
    const params = buildLaunchpadCoinConfig(makeSpec({ coinCreatorSharePct: pct }));
    expect(params.creatorTradingFeePercentage).toBe(FEES.forgeCreatorSharePct);
    expect(params.creatorPermanentLockedLiquidityPercentage).toBe(FEES.forgeCreatorSharePct);
    expect(params.partnerPermanentLockedLiquidityPercentage).toBe(100 - FEES.forgeCreatorSharePct);
  });
});

describe.each(builders)('%s config: bounds', (_kind, build) => {
  it.each([49, 201, 0, 9900, 100.5])('rejects tradingFeeBps %d', (bps) => {
    expect(violationCodes(() => build(makeSpec({ tradingFeeBps: bps })))).toContain('SPEC_INVALID');
  });

  it.each([-1, 51, 100, 2.5])('rejects coinCreatorSharePct %d', (pct) => {
    expect(violationCodes(() => build(makeSpec({ coinCreatorSharePct: pct })))).toContain(
      'SPEC_INVALID',
    );
  });

  it.each([0.0005, 0.000999999, 1.000000001, 1.5, 100, -0.001])(
    'rejects poolCreationFeeSol %d',
    (sol) => {
      expect(violationCodes(() => build(makeSpec({ poolCreationFeeSol: sol })))).toContain(
        'SPEC_INVALID',
      );
    },
  );

  it('rejects a pool creation fee with more precision than a lamport', () => {
    // Within the bound (between 0.001 and 1) but not a whole number of lamports: the shared
    // schema refuses it (at most 9 decimals), before core's own lamport check.
    expect(violationCodes(() => build(makeSpec({ poolCreationFeeSol: 0.0010000000001 })))).toEqual([
      'SPEC_INVALID',
    ]);
  });

  it('rejects an owner wallet that is not a public key', () => {
    expect(violationCodes(() => build(makeSpec({ ownerWallet: 'not-a-wallet' })))).toContain(
      'SPEC_INVALID',
    );
    // Base58 of the right length but not 32 bytes, and the all-zero key.
    for (const ownerWallet of ['1'.repeat(44), '11111111111111111111111111111111']) {
      expect(violationCodes(() => build(makeSpec({ ownerWallet })))).toEqual(['INVALID_ADDRESS']);
    }
  });

  it('rejects a quote other than SOL', () => {
    expect(
      violationCodes(() => build({ ...makeSpec(), quote: 'USDC' } as unknown as LaunchpadSpec)),
    ).toContain('SPEC_INVALID');
  });
});

describe('first buy on the launchpad coin config', () => {
  const coinConfig = buildLaunchpadCoinConfig(makeSpec({ tradingFeeBps: 100 }));

  it('quotes exactly what the devnet launch delivered (0.01 SOL)', () => {
    // scripts/devnet-tests/reports/core-config-pool.md
    expect(quoteFirstBuyOnConfig(coinConfig, solToLamports(0.01))).toEqual({
      ok: true,
      tokensOut: 3_158_618_642_371n,
      minimumTokensOut: 3_158_618_642_371n,
      feeLamports: 100_000n,
    });
  });

  it('quotes exactly what devnet test 3 delivered (0.05 SOL, same curve)', () => {
    const quote = quoteFirstBuyOnConfig(coinConfig, solToLamports(0.05), { slippageBps: 100 });
    expect(quote.ok && quote.tokensOut).toBe(15_608_216_690_980n);
    expect(quote.ok && quote.minimumTokensOut).toBe((15_608_216_690_980n * 9900n) / 10_000n);
    expect(quote.ok && quote.feeLamports).toBe(500_000n);
  });

  it('pays the minimum fee even with the anti-sniper schedule on', () => {
    const quote = quoteFirstBuyOnConfig(coinConfig, solToLamports(1));
    expect(quote.ok && quote.feeLamports).toBe(solToLamports(1) / 100n);
  });

  it('refuses a first buy larger than the curve, a zero buy is not quoted', () => {
    const tooBig = quoteFirstBuyOnConfig(coinConfig, solToLamports(10.2));
    expect(tooBig).toMatchObject({ ok: false, reason: 'EXCEEDS_CURVE' });
    expect(quoteFirstBuyOnConfig(coinConfig, solToLamports(10)).ok).toBe(true);
    expect(quoteFirstBuyOnConfig(coinConfig, 0n)).toMatchObject({ ok: false, reason: 'TOO_SMALL' });
  });

  it('refuses a spec whose first buy is above the 10 SOL spec bound', () => {
    const coin = makeSpec().launchpadCoin;
    const spec = makeSpec({ launchpadCoin: { ...coin, firstBuySol: 50 } });
    for (const build of [buildLaunchpadCoinConfig, buildLaunchpadConfig]) {
      let error: unknown;
      try {
        build(spec);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).violations).toEqual([
        expect.objectContaining({ field: 'launchpadCoin.firstBuySol', code: 'SPEC_INVALID' }),
      ]);
    }
    // The largest first buy the spec allows fits in the curve; no first buy is fine too.
    const max = makeSpec({ launchpadCoin: { ...coin, firstBuySol: MAX_FIRST_BUY_SOL } });
    expect(() => buildLaunchpadCoinConfig(max)).not.toThrow();
    const none = makeSpec({ launchpadCoin: { ...coin, firstBuySol: 0 } });
    expect(() => buildLaunchpadCoinConfig(none)).not.toThrow();
  });
});

describe('parseLaunchpadSpec', () => {
  it('applies the defaults (creator share 25, anti-sniper on)', () => {
    const input: LaunchpadSpecInput = { ...makeSpec() };
    delete input.coinCreatorSharePct;
    delete input.antiSniper;
    const parsed = parseLaunchpadSpec(input);
    expect(parsed.coinCreatorSharePct).toBe(25);
    expect(parsed.antiSniper).toBe(true);
    expect(buildLaunchpadConfig(parsed).creatorTradingFeePercentage).toBe(25);
  });

  it('reports every invalid field', () => {
    let error: unknown;
    try {
      parseLaunchpadSpec({ ...makeSpec(), tradingFeeBps: 10, slug: 'X' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    const fields = (error as ValidationError).violations.map((v) => v.field).sort();
    expect(fields).toEqual(['slug', 'tradingFeeBps']);
  });

  it('rejects a non-object', () => {
    expect(() => parseLaunchpadSpec(null)).toThrow(ValidationError);
  });
});

describe('buildConfigParams', () => {
  it('refuses an unknown kind', () => {
    expect(() => buildConfigParams(makeSpec(), 'other' as never)).toThrow(TypeError);
  });

  it('passes the validators for both kinds', () => {
    const spec = makeSpec({ coinCreatorSharePct: 0, poolCreationFeeSol: 0, antiSniper: false });
    expect(validateLaunchpadConfigParams(buildConfigParams(spec, 'launchpad'), spec)).toEqual({
      ok: true,
      violations: [],
    });
    expect(
      validateLaunchpadCoinConfigParams(buildConfigParams(spec, 'launchpadCoin'), spec),
    ).toEqual({ ok: true, violations: [] });
  });

  // The launchpad coin is launched after both configs exist: a coin the launch transaction
  // cannot hold must be refused before any config is built.
  describe('refuses a launchpad coin that cannot be launched, for both kinds', () => {
    const longest = makeSpec({
      launchpadCoin: { ...makeSpec().launchpadCoin, name: 'N'.repeat(32), symbol: 'S'.repeat(10) },
    });
    const uri = (bytes: number) => `https://example.com/${'a'.repeat(bytes - 25)}.json`;

    it.each(['launchpad', 'launchpadCoin'] as const)(
      '%s: name + symbol + URI over budget',
      (kind) => {
        expect(() => buildConfigParams(longest, kind, { metadataUri: uri(106) })).not.toThrow();
        expect(
          violationCodes(() => buildConfigParams(longest, kind, { metadataUri: uri(107) })),
        ).toEqual(['LAUNCH_METADATA_TOO_LONG']);
        // Without the URI, the name and symbol alone always fit.
        expect(() => buildConfigParams(longest, kind)).not.toThrow();
      },
    );

    it.each(['launchpad', 'launchpadCoin'] as const)('%s: a URI the launch refuses', (kind) => {
      for (const metadataUri of ['http://example.com/a.json', 'https://EXAMPLE.com/a.json']) {
        expect(violationCodes(() => buildConfigParams(makeSpec(), kind, { metadataUri }))).toEqual([
          'SPEC_INVALID',
        ]);
      }
    });

    it('buildCreateConfigTx refuses it before any network call', async () => {
      const connection = mockConnection();
      await expect(
        buildCreateConfigTx({
          connection: connection as unknown as Connection,
          spec: longest,
          kind: 'launchpad',
          metadataUri: uri(107),
          config: Keypair.generate().publicKey,
          payer: Keypair.generate().publicKey,
        }),
      ).rejects.toThrow(ValidationError);
      expect(connection.calls).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// buildCreateConfigTx
// ---------------------------------------------------------------------------------------------

const BLOCKHASH = new PublicKey(Buffer.alloc(32, 4)).toBase58();
const rent = (size: number) => (128 + size) * 6960;

function mockConnection(existing: PublicKey[] = []) {
  const accounts = new Map<string, AccountInfo<Buffer>>(
    existing.map((key) => [
      key.toBase58(),
      {
        owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
        data: Buffer.alloc(8),
        lamports: 1,
        executable: false,
        rentEpoch: 0,
      },
    ]),
  );
  const calls: string[] = [];
  return {
    calls,
    getAccountInfo: async (key: PublicKey) => {
      calls.push('getAccountInfo');
      return accounts.get(key.toBase58()) ?? null;
    },
    getAccountInfoAndContext: async (key: PublicKey) => ({
      context: { slot: 1 },
      value: accounts.get(key.toBase58()) ?? null,
    }),
    getMinimumBalanceForRentExemption: async (size: number) => rent(size),
    getLatestBlockhash: async () => {
      calls.push('getLatestBlockhash');
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 500 };
    },
  };
}

const program = DynamicBondingCurveClient.create(
  new Connection('http://127.0.0.1:8899'),
  'confirmed',
).partner.getProgram();

describe('buildCreateConfigTx', () => {
  it.each(['launchpad', 'launchpadCoin'] as const)(
    'builds an unsigned %s createConfig transaction',
    async (kind) => {
      const payer = Keypair.generate().publicKey;
      const configKeypair = Keypair.generate();
      const connection = mockConnection();
      const spec = makeSpec({ coinCreatorSharePct: 10 });
      const result = await buildCreateConfigTx({
        connection: connection as unknown as Connection,
        spec,
        kind,
        config: configKeypair,
        payer,
      });

      expect(result.configAddress.equals(configKeypair.publicKey)).toBe(true);
      expect(result.signers.map(String)).toEqual([payer, configKeypair.publicKey].map(String));
      expect(result.rentLamports).toBe(BigInt(rent(program.account.poolConfig.size)));
      expect(result.lastValidBlockHeight).toBe(500);
      const tx = result.transaction;
      expect(tx.feePayer!.equals(payer)).toBe(true);
      expect(tx.recentBlockhash).toBe(BLOCKHASH);
      expect(tx.signatures.every((s) => s.signature === null)).toBe(true);

      const [limit, createIx, ...rest] = tx.instructions;
      expect(rest).toEqual([]);
      expect(limit!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
      expect(limit!.data.readUInt32LE(1)).toBe(CREATE_CONFIG_COMPUTE_UNITS);
      expect(createIx!.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)).toBe(true);

      // Accounts: config, fee claimer, leftover receiver, quote mint, payer, ...
      const [config, feeClaimer, leftover, quoteMint, payerKey] = createIx!.keys;
      expect(config!.pubkey.equals(configKeypair.publicKey) && config!.isSigner).toBe(true);
      expect(feeClaimer!.pubkey.equals(OWNER)).toBe(true);
      expect(leftover!.pubkey.equals(OWNER)).toBe(true);
      expect(quoteMint!.pubkey.equals(SOL_QUOTE_MINT)).toBe(true);
      expect(payerKey!.pubkey.equals(payer) && payerKey!.isSigner).toBe(true);

      // The encoded instruction carries exactly the validated parameters.
      const instructionCoder = program.coder.instruction as unknown as {
        decode(data: Buffer): { name: string; data: { configParameters: unknown } } | null;
      };
      const decoded = instructionCoder.decode(createIx!.data)!;
      expect(decoded.name).toBe('createConfig');
      const sent = decoded.data.configParameters as unknown as LaunchpadConfigParams;
      expect(sent.creatorTradingFeePercentage).toBe(
        kind === 'launchpadCoin' ? FEES.forgeCreatorSharePct : 10,
      );
      expect(numerator(sent.migrationQuoteThreshold)).toBe(MIGRATION_THRESHOLD_LAMPORTS);
      // The client's fee on its site's coins; none on its own coin (it would pay itself).
      expect(numerator(sent.poolCreationFee)).toBe(kind === 'launchpadCoin' ? 0n : 50_000_000n);
      expect(sent.enableFirstSwapWithMinFee).toBe(true);
      expect(toJson(result.params)).toBe(toJson(buildConfigParams(spec, kind)));
    },
  );

  it('uses the given blockhash and priority fee', async () => {
    const connection = mockConnection();
    const result = await buildCreateConfigTx({
      connection: connection as unknown as Connection,
      spec: makeSpec(),
      kind: 'launchpad',
      config: Keypair.generate().publicKey,
      payer: Keypair.generate().publicKey,
      computeUnitPriceMicroLamports: 777,
      recentBlockhash: { blockhash: BLOCKHASH, lastValidBlockHeight: 9 },
    });
    expect(connection.calls).not.toContain('getLatestBlockhash');
    expect(result.lastValidBlockHeight).toBe(9);
    expect(result.transaction.instructions[1]!.data.readBigUInt64LE(1)).toBe(777n);
  });

  it('refuses an existing config account (idempotency)', async () => {
    const config = Keypair.generate().publicKey;
    const error = await buildCreateConfigTx({
      connection: mockConnection([config]) as unknown as Connection,
      spec: makeSpec(),
      kind: 'launchpad',
      config,
      payer: Keypair.generate().publicKey,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CreateConfigError);
    expect((error as CreateConfigError).code).toBe('CONFIG_EXISTS');
  });

  it('refuses a config address equal to the payer or the fee claimer', async () => {
    const payer = Keypair.generate().publicKey;
    for (const config of [payer, OWNER]) {
      const error = await buildCreateConfigTx({
        connection: mockConnection() as unknown as Connection,
        spec: makeSpec(),
        kind: 'launchpadCoin',
        config,
        payer,
      }).catch((e: unknown) => e);
      expect((error as CreateConfigError).code).toBe('INVALID_ACCOUNTS');
    }
  });

  it('refuses an invalid spec before touching the network', async () => {
    const connection = mockConnection();
    await expect(
      buildCreateConfigTx({
        connection: connection as unknown as Connection,
        spec: makeSpec({ tradingFeeBps: 1000 }),
        kind: 'launchpad',
        config: Keypair.generate().publicKey,
        payer: Keypair.generate().publicKey,
      }),
    ).rejects.toThrow(ValidationError);
    expect(connection.calls).toEqual([]);
  });
});
