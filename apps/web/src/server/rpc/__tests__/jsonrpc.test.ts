// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  checkCall,
  errorForAll,
  MAX_BATCH_SIZE,
  parseBody,
  restrictCalls,
  RPC_ERRORS,
} from '../jsonrpc';
import { call, PK } from './helpers';

describe('parseBody', () => {
  it('parses a single call', () => {
    const parsed = parseBody(JSON.stringify(call('getBalance', [PK], 'a')));
    expect(parsed).toMatchObject({ ok: true, batch: false });
    if (parsed.ok)
      expect(parsed.calls[0]).toMatchObject({ ok: true, id: 'a', method: 'getBalance' });
  });

  it('answers -32700 on invalid JSON', () => {
    expect(parseBody('{"jsonrpc":')).toEqual({ ok: false, status: 400, error: RPC_ERRORS.parse });
  });

  it('refuses an empty batch and a batch over the cap', () => {
    expect(parseBody('[]')).toMatchObject({ ok: false, status: 400, error: { code: -32600 } });
    const big = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => call('getSlot', [], i));
    expect(parseBody(JSON.stringify(big))).toMatchObject({
      ok: false,
      status: 400,
      error: { code: -32600 },
    });
    const max = Array.from({ length: MAX_BATCH_SIZE }, (_, i) => call('getSlot', [], i));
    const parsed = parseBody(JSON.stringify(max));
    expect(parsed.ok && parsed.calls.every((c) => c.ok)).toBe(true);
  });

  it('checks each call of a batch on its own', () => {
    const parsed = parseBody(
      JSON.stringify([call('getSlot', [], 1), call('getProgramAccounts', [PK], 2), 42]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.calls.map((c) => (c.ok ? 'ok' : c.error.code))).toEqual(['ok', -32601, -32600]);
    expect(parsed.calls.map((c) => c.id)).toEqual([1, 2, null]);
  });
});

describe('checkCall envelope', () => {
  it.each<[unknown, string]>([
    [{ jsonrpc: '1.0', id: 1, method: 'getSlot' }, 'wrong version'],
    [{ id: 1, method: 'getSlot' }, 'no version'],
    [{ jsonrpc: '2.0', method: 'getSlot' }, 'notification (no id)'],
    [{ jsonrpc: '2.0', id: { a: 1 }, method: 'getSlot' }, 'object id'],
    [{ jsonrpc: '2.0', id: 1.5, method: 'getSlot' }, 'fractional id'],
    [{ jsonrpc: '2.0', id: 'x'.repeat(129), method: 'getSlot' }, 'long id'],
    [{ jsonrpc: '2.0', id: 1, method: 7 }, 'non-string method'],
    [{ jsonrpc: '2.0', id: 1, method: 'getSlot', extra: true }, 'unknown key'],
    [null, 'null'],
    [[call('getSlot')], 'nested array'],
  ])('refuses %j (%s) with -32600', (raw) => {
    const result = checkCall(raw, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(-32600);
  });

  it('accepts string, integer and null ids', () => {
    for (const id of ['abc', 7, null]) expect(checkCall(call('getSlot', [], id), 0).ok).toBe(true);
  });

  it('keeps a valid id on a refused call', () => {
    const result = checkCall(call('getProgramAccounts', [PK], 'keep-me'), 3);
    expect(result).toMatchObject({
      ok: false,
      id: 'keep-me',
      index: 3,
      method: 'getProgramAccounts',
    });
  });
});

describe('errorForAll', () => {
  it('mirrors the request shape', () => {
    const parsed = parseBody(JSON.stringify([call('getSlot', [], 1), call('getSlot', [], 2)]));
    if (!parsed.ok) throw new Error('unexpected');
    expect(errorForAll(parsed.calls, true, RPC_ERRORS.rateLimited)).toEqual([
      { jsonrpc: '2.0', id: 1, error: RPC_ERRORS.rateLimited },
      { jsonrpc: '2.0', id: 2, error: RPC_ERRORS.rateLimited },
    ]);
    expect(errorForAll(parsed.calls.slice(0, 1), false, RPC_ERRORS.internal)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: RPC_ERRORS.internal,
    });
    expect(errorForAll(null, false, RPC_ERRORS.internal)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: RPC_ERRORS.internal,
    });
  });
});

describe('restrictCalls', () => {
  it('refuses valid calls outside the allowed methods, keeps the others', () => {
    const parsed = parseBody(
      JSON.stringify([
        call('getBalance', [PK], 1),
        call('getSlot', [], 2),
        call('getBalance', ['bad key'], 3),
      ]),
    );
    if (!parsed.ok) throw new Error('unexpected');
    const [balance, slot, invalid] = restrictCalls(parsed.calls, new Set(['getBalance']));
    expect(balance).toMatchObject({ ok: true, id: 1, method: 'getBalance' });
    expect(slot).toEqual({
      ok: false,
      index: 1,
      id: 2,
      method: 'getSlot',
      error: RPC_ERRORS.methodNotAllowed,
    });
    // Already refused: its own error is kept.
    expect(invalid).toMatchObject({ ok: false, id: 3, error: { code: -32602 } });
  });
});
