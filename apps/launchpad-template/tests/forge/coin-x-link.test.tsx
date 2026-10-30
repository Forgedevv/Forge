// @vitest-environment jsdom
import '../helpers/dom-setup';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CoinXLink, hasCoinXLink } from '@/forge/CoinXLink';

afterEach(cleanup);

describe('CoinXLink', () => {
  it('renders a canonical X link in a new tab, without opener or referrer', () => {
    render(
      <CoinXLink url="https://x.com/moon_coin" title="Coin on X">
        {(handle) => `@${handle}`}
      </CoinXLink>,
    );
    const link = screen.getByRole('link', { name: 'Coin on X' });
    expect(link).toHaveAttribute('href', 'https://x.com/moon_coin');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('@moon_coin');
    expect(hasCoinXLink('https://x.com/moon_coin')).toBe(true);
  });

  it('renders nothing for any other value', () => {
    for (const url of [
      undefined,
      null,
      '',
      'javascript:alert(1)',
      'https://twitter.com/moon_coin',
      'https://x.com/moon_coin/status/1',
      'https://evil.example/moon_coin',
      'http://x.com/moon_coin',
      { toString: () => 'https://x.com/moon_coin' },
    ]) {
      const { container, unmount } = render(<CoinXLink url={url}>X</CoinXLink>);
      expect(container).toBeEmptyDOMElement();
      expect(hasCoinXLink(url)).toBe(false);
      unmount();
    }
  });
});
