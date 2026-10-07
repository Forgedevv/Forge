import { ClientError } from '@forge/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUserRejection, mapHttpError } from '../errors';
import { request } from '../http';
import { z } from 'zod';
import { getSessionSnapshot, setSession } from '../session-store';

describe('mapHttpError', () => {
  it.each([
    [401, undefined, 'UNAUTHORIZED'],
    [429, undefined, 'RATE_LIMITED'],
    [403, undefined, 'GATING_REQUIRED'],
    [410, undefined, 'QUOTE_EXPIRED'],
    [500, undefined, 'NETWORK'],
    [400, { code: 'WRONG_WALLET', message: 'Wrong wallet' }, 'WRONG_WALLET'],
    [503, { code: 'SIGNUPS_PAUSED' }, 'SIGNUPS_PAUSED'],
    [403, { code: 'FORBIDDEN_ORIGIN', message: 'Cross-site request rejected.' }, 'NETWORK'],
    [400, { code: 'BAD_REQUEST', message: 'Invalid wallet address.' }, 'NETWORK'],
    [500, { code: 'SERVER_ERROR', message: 'Unavailable.' }, 'NETWORK'],
    [401, { code: 'UNAUTHORIZED', message: 'Not signed in.' }, 'UNAUTHORIZED'],
  ])('maps %s %o to %s', (status, body, code) => {
    const err = mapHttpError(status, body);
    expect(err).toBeInstanceOf(ClientError);
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('keeps the server message', () => {
    expect(mapHttpError(429, { error: 'Chat limit reached' }).message).toBe('Chat limit reached');
  });

  it('ignores unknown body codes and falls back to the status', () => {
    expect(mapHttpError(429, { code: 'WHATEVER' }).code).toBe('RATE_LIMITED');
  });
});

describe('isUserRejection', () => {
  it('recognizes wallet rejections', () => {
    expect(isUserRejection(new Error('User rejected the request.'))).toBe(true);
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ name: 'WalletSignTransactionError', error: { code: 4001 } })).toBe(
      true,
    );
    expect(isUserRejection(new Error('blockhash not found'))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });
});

describe('request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps HTTP errors, network failures and malformed bodies', async () => {
    const schema = z.object({ ok: z.boolean() });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'no' }), { status: 429 })),
    );
    await expect(request('/x', schema)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'no',
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(request('/x', schema)).rejects.toMatchObject({ code: 'NETWORK' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"ok":"yes"}', { status: 200 })),
    );
    await expect(request('/x', schema)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('clears the stored session on 401', async () => {
    setSession({ wallet: 'W' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(request('/x', z.unknown())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(getSessionSnapshot()).toBeNull();
  });
});
