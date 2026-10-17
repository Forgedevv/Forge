import { describe, expect, it, vi } from 'vitest';
import { ClaimError } from '@forge/core';
import { createRpcChainClient, describeChainError, RpcError } from '@/forge/create/chain';
import {
  CHAIN_FAILURE_TEXT,
  chainFailureReason,
  describeSendFailure,
  isUserRejection,
} from '@/forge/create/errors';
import { TxError, messageForUser } from '@/forge/create/flow';
import { describeClaimBuildError } from '@/forge/claims/flow';

describe('chainFailureReason (stable reasons, same rules as the trade flow)', () => {
  it('classifies program and runtime errors', () => {
    expect(chainFailureReason({ InsufficientFundsForRent: { account_index: 0 } })).toBe(
      'insufficient_rent',
    );
    expect(
      chainFailureReason({ InstructionError: [2, { Custom: 1 }] }, [
        'Program log: Error: insufficient lamports 10, need 20',
      ]),
    ).toBe('insufficient_funds');
    expect(chainFailureReason('ExceededSlippage')).toBe('slippage');
    expect(chainFailureReason('BlockhashNotFound')).toBe('expired');
    expect(
      chainFailureReason({ InstructionError: [0, { Custom: 0 }] }, [
        'Allocate: account Address { address: X } already in use',
      ]),
    ).toBe('already_exists');
    expect(chainFailureReason({ InstructionError: [0, { Custom: 6001 }] })).toBe('unknown');
  });

  it('describes an on-chain error in one sentence, never the raw JSON', () => {
    const text = describeChainError({ InstructionError: [0, { Custom: 6001 }] });
    expect(text).toBe(CHAIN_FAILURE_TEXT.unknown);
    expect(text).not.toMatch(/[{}[\]]/);
  });
});

describe('describeSendFailure', () => {
  it('names the reason of a preflight refusal without the RPC text', () => {
    const error = new RpcError('Transaction simulation failed: Blockhash not found', -32002, {
      err: 'BlockhashNotFound',
      logs: [],
    });
    const text = describeSendFailure(error);
    expect(text).toMatch(/^The transaction was not sent\. The transaction expired/);
    expect(text).not.toMatch(/simulation|-32002/i);
  });

  it('stays calm on an unknown failure', () => {
    expect(describeSendFailure(new Error('RPC relay answered 503'))).toMatch(
      /Solana network could not be reached/,
    );
    expect(describeSendFailure(new Error('weird'))).toBe(
      'The transaction was not sent. Nothing was charged. Try again.',
    );
  });
});

describe('wallet errors', () => {
  it('recognizes a declined request in the usual adapter wordings', () => {
    for (const error of [
      new Error('User rejected the request.'),
      Object.assign(new Error('x'), { code: 4001 }),
      new Error('Transaction cancelled'),
      { name: 'WalletSignMessageError', message: 'User denied message signature' },
    ]) {
      expect(isUserRejection(error)).toBe(true);
    }
    expect(isUserRejection(new Error('Internal JSON-RPC error'))).toBe(false);
  });

  it('shows a TxError as is and anything else as the calm fallback', () => {
    expect(messageForUser(new TxError('timeout', 'confirm', 'Human text.'), 'Fallback.')).toBe(
      'Human text.',
    );
    expect(messageForUser(new Error('ECONNRESET 10.0.0.1'), 'Fallback.')).toBe('Fallback.');
  });
});

describe('describeClaimBuildError', () => {
  it('maps core claim refusals to human messages', () => {
    const wrap = (error: Error) => new Error(error.message, { cause: error });
    expect(describeClaimBuildError(wrap(new ClaimError('not_pool_creator', 'raw')))).toMatch(
      /not the creator/,
    );
    expect(describeClaimBuildError(wrap(new ClaimError('receiver_not_rent_exempt', 'raw')))).toMatch(
      /little SOL/,
    );
    expect(describeClaimBuildError(new Error('There is nothing to claim for this coin.'))).toMatch(
      /nothing to claim/,
    );
    expect(describeClaimBuildError(new Error('fetch failed: 10.0.0.1'))).toBe(
      'Could not prepare the claim right now. Try again in a moment.',
    );
  });
});

describe('getBlockHeight (RPC relay)', () => {
  it('reads the confirmed block height', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: 42 }) });
    const chain = createRpcChainClient({ url: 'https://relay.test', fetch });
    expect(await chain.getBlockHeight?.()).toBe(42);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ method: 'getBlockHeight', params: [{ commitment: 'confirmed' }] });
  });

  it('refuses a malformed answer', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: 'x' }) });
    const chain = createRpcChainClient({ url: 'https://relay.test', fetch });
    await expect(chain.getBlockHeight?.()).rejects.toBeInstanceOf(RpcError);
  });
});
