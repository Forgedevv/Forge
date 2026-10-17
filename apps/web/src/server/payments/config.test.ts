// @vitest-environment node
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { readCashbox, readCluster, readPaymentsConfig, readPriceGuard, readRpcUrl } from './config';
import { PaymentConfigError } from './errors';
import { MemoryLogger, sanitizeFields } from './log';

const CASHBOX = PublicKey.unique().toBase58();
const SECRET_URL = 'https://devnet.helius-rpc.com/?api-key=SUPERSECRET';
const BASE = {
  RPC_URL: SECRET_URL,
  FORGE_CASHBOX_WALLET: CASHBOX,
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-value',
};

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a PaymentConfigError');
}

describe('payments config', () => {
  it('defaults to devnet and reads everything', () => {
    const config = readPaymentsConfig(BASE);
    expect(config.cluster).toBe('devnet');
    expect(config.cashbox.toBase58()).toBe(CASHBOX);
    expect(config.jupiterApiKey).toBeUndefined();
  });

  it('only accepts devnet or mainnet-beta', () => {
    expect(readCluster({ SOLANA_CLUSTER: 'mainnet-beta' })).toBe('mainnet-beta');
    expect(() => readCluster({ SOLANA_CLUSTER: 'testnet' })).toThrow(PaymentConfigError);
  });

  it('refuses an RPC URL that does not match the cluster, without echoing it', () => {
    const mainnetUrl = 'https://mainnet.helius-rpc.com/?api-key=SUPERSECRET';
    const onDevnet = messageOf(() => readRpcUrl({ RPC_URL: mainnetUrl }, 'devnet'));
    const onMainnet = messageOf(() => readRpcUrl({ RPC_URL: SECRET_URL }, 'mainnet-beta'));
    for (const message of [onDevnet, onMainnet]) {
      expect(message).toContain('RPC_URL');
      expect(message).not.toContain('SUPERSECRET');
    }
  });

  it.each([
    ['missing', undefined],
    ['non-base58', 'not-a-key'],
    ['zero-key', PublicKey.default.toBase58()],
  ])('refuses a %s cashbox', (_label, value) => {
    const message = messageOf(() => readCashbox({ FORGE_CASHBOX_WALLET: value }));
    expect(message).toContain('FORGE_CASHBOX_WALLET');
    if (value) expect(message).not.toContain(value);
  });

  it('names missing variables only', () => {
    const message = messageOf(() => readPaymentsConfig({ ...BASE, SUPABASE_SERVICE_ROLE_KEY: '' }));
    expect(message).toBe('SUPABASE_SERVICE_ROLE_KEY is not set');
  });

  it('reads the SOL/USD price guard, with defaults of 10 to 5000 $/SOL and a 25% move', () => {
    expect(readPaymentsConfig(BASE).priceGuard).toEqual({
      min: 10,
      max: 5_000,
      maxDeviationPct: 25,
    });
    expect(
      readPriceGuard({
        SOL_USD_PRICE_MIN: '50',
        SOL_USD_PRICE_MAX: ' 3000 ',
        SOL_USD_PRICE_MAX_DEVIATION_PCT: '10',
      }),
    ).toEqual({ min: 50, max: 3_000, maxDeviationPct: 10 });
  });

  it.each([
    [{ SOL_USD_PRICE_MIN: 'cheap' }, 'SOL_USD_PRICE_MIN must be a number'],
    [{ SOL_USD_PRICE_MIN: '0.5' }, 'SOL_USD_PRICE_MIN must be between 1 and 100000'],
    [{ SOL_USD_PRICE_MAX: '200000' }, 'SOL_USD_PRICE_MAX must be between 1 and 100000'],
    [{ SOL_USD_PRICE_MIN: '500', SOL_USD_PRICE_MAX: '500' }, 'must be below SOL_USD_PRICE_MAX'],
    [{ SOL_USD_PRICE_MIN: '6000' }, 'SOL_USD_PRICE_MIN must be below SOL_USD_PRICE_MAX'],
    [{ SOL_USD_PRICE_MAX_DEVIATION_PCT: '0' }, 'SOL_USD_PRICE_MAX_DEVIATION_PCT must be above 0'],
    [{ SOL_USD_PRICE_MAX_DEVIATION_PCT: '150' }, 'SOL_USD_PRICE_MAX_DEVIATION_PCT must be above 0'],
  ])('refuses an invalid price guard %o', (env, expected) => {
    expect(messageOf(() => readPriceGuard(env))).toContain(expected);
  });
});

describe('logging', () => {
  it('drops fields whose name looks secret, and undefined values', () => {
    expect(
      sanitizeFields({
        paymentId: 'p',
        apiKey: 'x',
        serviceToken: 'y',
        secretThing: 'z',
        privateKey: 'w',
        gone: undefined,
      }),
    ).toEqual({ paymentId: 'p' });
    const logger = new MemoryLogger();
    logger.log('info', 'e', { RPC_TOKEN: 'x', jobId: 'j' });
    expect(logger.entries[0]!.fields).toEqual({ jobId: 'j' });
  });
});
