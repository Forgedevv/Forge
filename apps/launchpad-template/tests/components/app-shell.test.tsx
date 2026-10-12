// @vitest-environment jsdom
import '../helpers/dom-setup';
import { render, screen } from '@testing-library/react';
import type { AppProps } from 'next/app';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/Header', () => ({ default: () => <header>site header</header> }));
vi.mock('@/components/SiteFooter', () => ({ SiteFooter: () => <footer>site footer</footer> }));
vi.mock('@/theme/ThemeStyle', () => ({ ThemeStyle: () => null }));

import { AppShell } from '@/components/AppShell';

const Page = () => <main>page body</main>;

function shellProps(pathname: string): AppProps {
  return { Component: Page, pageProps: {}, router: { pathname } } as unknown as AppProps;
}

describe('AppShell', () => {
  it('frames the locked creator fee page with the site header and footer', () => {
    render(<AppShell {...shellProps('/creator-fees')} />);
    expect(screen.getByText('site header')).toBeInTheDocument();
    expect(screen.getByText('page body')).toBeInTheDocument();
    expect(screen.getByText('site footer')).toBeInTheDocument();
  });

  it('renders other pages as they are (they bring their own layout)', () => {
    render(<AppShell {...shellProps('/')} />);
    expect(screen.getByText('page body')).toBeInTheDocument();
    expect(screen.queryByText('site header')).toBeNull();
  });
});
