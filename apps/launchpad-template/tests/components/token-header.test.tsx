// @vitest-environment jsdom
import '../helpers/dom-setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pool: undefined as unknown,
  isLoading: true,
  description: undefined as string | undefined,
}));

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
vi.mock('@/forge/token-icon', () => ({
  TrenchesTokenIcon: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TrenchesTokenIconImage: () => null,
}));
vi.mock('@/hooks/queries', () => ({
  useTokenAddress: () => 'So11111111111111111111111111111111111111112',
  useTokenInfo: (select?: (pool: unknown) => unknown) => ({
    data: h.pool === undefined ? undefined : select ? select(h.pool) : h.pool,
    isLoading: h.isLoading,
  }),
  useMinimalTokenInfo: () => ({ data: undefined }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({
    data: h.description ? { description: h.description } : undefined,
    status: 'success',
  }),
}));

import { content } from '@/content';
import { TokenHeader } from '@/components/TokenHeader/TokenHeader';
import { TokenDescription } from '@/components/TokenHeader/TokenDescription';

afterEach(() => {
  h.pool = undefined;
  h.isLoading = true;
  h.description = undefined;
});

describe('TokenHeader', () => {
  it('shows a skeleton while the coin loads', () => {
    render(<TokenHeader />);
    expect(screen.getByTestId('token-header-name-loading')).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('shows the coin name and its symbol, with no pointer cursor', () => {
    h.isLoading = false;
    h.pool = { baseAsset: { name: 'Moon Nap', symbol: 'NAP' } };
    render(<TokenHeader />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Moon Nap');
    expect(heading).toHaveTextContent('NAP');
    expect(heading.className).not.toContain('cursor-pointer');
    expect(screen.queryByTestId('token-header-name-loading')).toBeNull();
  });

  it('shows the symbol alone when the name is missing', () => {
    h.isLoading = false;
    h.pool = { baseAsset: { name: '', symbol: 'NAP' } };
    render(<TokenHeader />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('NAP');
  });
});

describe('TokenDescription', () => {
  it('takes the read more label from the copy, cased by CSS', () => {
    h.pool = { baseAsset: { name: 'Moon Nap' } };
    h.description = 'A long story.';
    // jsdom has no layout: report an overflow so the toggle shows.
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100);
    render(<TokenDescription />);
    const toggle = screen.getByRole('button', { name: content.strings.readMore });
    expect(toggle.className).toContain('uppercase');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: content.strings.showLess })).toBeTruthy();
    height.mockRestore();
  });

  it('shows the coin X link next to the description, in a new tab without referrer', () => {
    h.pool = { baseAsset: { name: 'Moon Nap', twitter: 'https://x.com/moon_nap' } };
    h.description = 'A long story.';
    render(<TokenDescription />);
    const link = screen.getByRole('link', { name: content.strings.coinOnX });
    expect(link).toHaveAttribute('href', 'https://x.com/moon_nap');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('@moon_nap');
  });

  it('shows the about block for an X link alone, and nothing for an invalid one', () => {
    h.pool = { baseAsset: { name: 'Moon Nap', twitter: 'https://x.com/moon_nap' } };
    const { unmount } = render(<TokenDescription />);
    expect(screen.getByRole('heading', { name: 'About Moon Nap' })).toBeTruthy();
    expect(screen.getByRole('link', { name: content.strings.coinOnX })).toBeTruthy();
    unmount();

    for (const twitter of [
      'javascript:alert(1)',
      'https://evil.example/moon',
      'https://x.com/a/b',
    ]) {
      h.pool = { baseAsset: { name: 'Moon Nap', twitter } };
      h.description = undefined;
      const view = render(<TokenDescription />);
      expect(view.container).toBeEmptyDOMElement();
      view.unmount();
      h.description = 'A long story.';
      const withText = render(<TokenDescription />);
      expect(screen.queryByRole('link')).toBeNull();
      withText.unmount();
    }
  });
});
