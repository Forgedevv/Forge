import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { capabilitiesFor, modeNotice, rejectIfNotLive } from '@/forge/mode-guard';

function fakeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('capabilities', () => {
  it('allows everything when live', () => {
    expect(capabilitiesFor('live')).toEqual({
      browse: true,
      trade: true,
      create: true,
      claim: true,
    });
  });

  it('allows only the creator fee claim when sleeping (D29)', () => {
    expect(capabilitiesFor('sleeping')).toEqual({
      browse: false,
      trade: false,
      create: false,
      claim: true,
    });
  });

  it('allows nothing when disabled', () => {
    expect(capabilitiesFor('disabled')).toEqual({
      browse: false,
      trade: false,
      create: false,
      claim: false,
    });
  });
});

describe('modeNotice', () => {
  it('has no notice when live and a distinct one otherwise', () => {
    expect(modeNotice('live')).toBeNull();
    const sleeping = modeNotice('sleeping');
    const disabled = modeNotice('disabled');
    expect(sleeping?.title).toMatch(/sleeping/i);
    expect(sleeping?.body).toMatch(/trading and coin creation are paused/i);
    expect(sleeping?.body).toMatch(/can still claim/i);
    expect(disabled?.title).toMatch(/maintenance/i);
  });
});

describe('rejectIfNotLive', () => {
  const req = {} as NextApiRequest;

  it('lets live requests through', () => {
    const res = fakeRes();
    expect(rejectIfNotLive(req, res as unknown as NextApiResponse, 'live')).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(['sleeping', 'disabled'] as const)('answers 503 when %s', (mode) => {
    const res = fakeRes();
    expect(rejectIfNotLive(req, res as unknown as NextApiResponse, mode)).toBe(true);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'This site is not available.' });
  });

  it('defaults to the mode of the bundled forge.config.json (live in the sample)', () => {
    const res = fakeRes();
    expect(rejectIfNotLive(req, res as unknown as NextApiResponse)).toBe(false);
  });
});
