import { describe, expect, it } from 'vitest';
import { mapChainError, mapTradeError, TradeError } from '../../src/forge/trade/errors';

describe('mapTradeError', () => {
  const cases: Array<[string, unknown, string]> = [
    ['wallet rejection', new Error('User rejected the request.'), 'user_rejected'],
    ['wallet rejection code', Object.assign(new Error('x'), { code: 4001 }), 'user_rejected'],
    [
      'unlinked core',
      Object.assign(new Error('x'), { name: 'SwapCoreNotLinkedError' }),
      'core_unavailable',
    ],
    ['graduated pool', new Error('Pool is graduated, use Jupiter'), 'pool_graduated'],
    ['slippage', new Error('custom program error: ExceededSlippage'), 'slippage_exceeded'],
    [
      'rent',
      new Error('Transaction results in an account with insufficient funds for rent'),
      'insufficient_rent',
    ],
    [
      'funds',
      new Error('Attempt to debit an account but found no record; insufficient lamports 5'),
      'insufficient_funds',
    ],
    ['blockhash', new Error('Blockhash not found'), 'blockhash_expired'],
    ['rate limit', new Error('429 Too Many Requests'), 'rate_limited'],
    ['network', new TypeError('Failed to fetch'), 'network'],
    ['relay down', new Error('503 Service Unavailable'), 'network'],
    ['anything else', new Error('weird'), 'unknown'],
  ];
  for (const [name, input, code] of cases) {
    it(`maps ${name} to ${code}`, () => {
      const mapped = mapTradeError(input);
      expect(mapped).toBeInstanceOf(TradeError);
      expect(mapped.code).toBe(code);
      expect(mapped.message.length).toBeGreaterThan(10);
    });
  }

  it('never leaks raw messages to the user-facing text', () => {
    const mapped = mapTradeError(new Error('secret-internal-detail 0xdeadbeef'));
    expect(mapped.message).not.toContain('secret-internal-detail');
  });

  it('passes TradeError through unchanged', () => {
    const original = new TradeError('price_moved');
    expect(mapTradeError(original)).toBe(original);
  });
});

describe('mapChainError', () => {
  it('uses the logs to find the cause', () => {
    const mapped = mapChainError({ InstructionError: [2, { Custom: 6017 }] }, [
      'Program log: AnchorError ... ExceededSlippage',
    ]);
    expect(mapped.code).toBe('slippage_exceeded');
  });
  it('falls back to simulation_failed, or tx_failed once sent', () => {
    expect(mapChainError({ x: 1 }, null).code).toBe('simulation_failed');
    const failed = mapChainError({ x: 1 }, null, 'sig');
    expect(failed.code).toBe('tx_failed');
    expect(failed.signature).toBe('sig');
  });
});
