// @vitest-environment jsdom
import '../helpers/dom-setup';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ audit: undefined as unknown }));

vi.mock('@/forge/config', () => ({
  siteConfig: {
    name: 'Moon Pad',
    slug: 'moon-pad',
    theme: { primaryColor: '#7C3AED', accentColor: '#F59E0B', darkMode: true },
    content: { tagline: 'To the moon', about: 'About the moon.' },
    mode: 'live',
  },
  onchainConfig: undefined,
  cluster: 'devnet',
}));
vi.mock('@/hooks/queries', () => ({
  useTokenInfo: (select?: (pool: unknown) => unknown) => {
    const pool = { baseAsset: { symbol: 'MOON', audit: h.audit } };
    return { data: select ? select(pool) : pool, isError: false };
  },
}));

import { content } from '@/content';
import { getAuditScore } from '@/components/Explore/pool-utils';
import { Checklist } from '@/components/TokenHeader/TokenChecklist';

afterEach(() => {
  h.audit = undefined;
});

const known = {
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  topHoldersPercentage: 10,
  lpBurnedPercentage: undefined,
};

describe('getAuditScore', () => {
  it('scores only a fully known audit', () => {
    expect(getAuditScore(known)).toBe(3);
    expect(getAuditScore({ ...known, freezeAuthorityDisabled: false })).toBe(2);
    expect(getAuditScore({ ...known, topHoldersPercentage: 40 })).toBe(2);
  });

  it('treats an unknown check as unknown, not as a failure', () => {
    expect(getAuditScore(undefined)).toBeUndefined();
    // What the on-chain fallback gives: authorities known, no holder data.
    expect(getAuditScore({ ...known, topHoldersPercentage: undefined })).toBeUndefined();
    expect(getAuditScore({ ...known, mintAuthorityDisabled: undefined })).toBeUndefined();
  });
});

describe('Checklist mint and freeze authorities', () => {
  it('shows a muted dash, never "Enabled" in red, when the audit is unknown', () => {
    render(<Checklist />);
    expect(screen.queryByText(content.strings.auditEnabled)).toBeNull();
    const unknown = screen.getAllByTitle(content.strings.auditUnknown);
    expect(unknown).toHaveLength(2);
    for (const el of unknown) {
      expect(el).toHaveTextContent('–');
      expect(el.className).toContain('text-neutral-500');
      expect(el.className).not.toContain('text-rose');
    }
  });

  it('shows revoked authorities as disabled, in green', () => {
    h.audit = { ...known, topHoldersPercentage: undefined };
    render(<Checklist />);
    const disabled = screen.getAllByText(content.strings.auditDisabled);
    expect(disabled).toHaveLength(2);
    for (const el of disabled) expect(el.className).toContain('text-emerald');
    expect(screen.queryByTitle(content.strings.auditUnknown)).toBeNull();
  });

  it('shows a set authority as enabled, in red', () => {
    h.audit = { ...known, mintAuthorityDisabled: false };
    render(<Checklist />);
    const enabled = screen.getByText(content.strings.auditEnabled);
    expect(enabled.className).toContain('text-rose');
    expect(screen.getByText(content.strings.auditDisabled).className).toContain('text-emerald');
  });
});
