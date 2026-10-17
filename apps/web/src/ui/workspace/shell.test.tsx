import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockController } from '../mocks/client';
import { ActionLink, isExternalHref } from './components';
import { common } from './content/common';
import { THEME_KEY, WorkspaceProvider } from './provider';
import { AccountMenu, WorkspaceFrame } from './shell';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function frame() {
  return render(
    <WorkspaceProvider controller={createMockController('dashboard:one')}>
      <WorkspaceFrame requireSession={false}>
        <p>Page</p>
      </WorkspaceFrame>
    </WorkspaceProvider>,
  );
}

describe('workshop theme', () => {
  it('keeps the chosen theme for the next visit', async () => {
    const first = frame();
    const workshop = () => document.querySelector('.fw')!;
    expect(workshop()).toHaveAttribute('data-theme', 'dark');
    fireEvent.click(screen.getByRole('button', { name: common.light }));
    expect(workshop()).toHaveAttribute('data-theme', 'light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    first.unmount();
    frame();
    await act(async () => undefined);
    expect(workshop()).toHaveAttribute('data-theme', 'light');
  });

  it('still switches theme when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    frame();
    fireEvent.click(screen.getByRole('button', { name: common.light }));
    expect(document.querySelector('.fw')).toHaveAttribute('data-theme', 'light');
  });
});

describe('account menu', () => {
  function menu() {
    const disconnect = vi.fn();
    render(
      <div>
        <p>Outside</p>
        <AccountMenu label="4Nd1...k9Qz" onDisconnect={disconnect} />
      </div>,
    );
    const details = document.querySelector('details')!;
    const toggle = screen.getByText('4Nd1...k9Qz').closest('summary')!;
    return { details, toggle, disconnect };
  }

  it('closes on a click outside', () => {
    const { details, toggle } = menu();
    fireEvent.click(toggle);
    expect(details).toHaveAttribute('open');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(screen.getByText('Outside'));
    expect(details).not.toHaveAttribute('open');
  });

  it('closes on Escape and gives the focus back to its toggle', () => {
    const { details, toggle } = menu();
    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(details).not.toHaveAttribute('open');
    expect(toggle).toHaveFocus();
  });

  it('closes once a choice is made', () => {
    const { details, toggle, disconnect } = menu();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('link', { name: common.dashboard }));
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: common.disconnect }));
    expect(details).not.toHaveAttribute('open');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('stays open while the user works inside it', () => {
    const { details, toggle } = menu();
    fireEvent.click(toggle);
    fireEvent.pointerDown(screen.getByRole('link', { name: common.dashboard }));
    expect(details).toHaveAttribute('open');
  });
});

describe('link arrows', () => {
  it('marks only links to another site with ↗, opened in a new tab', () => {
    expect(isExternalHref('https://orbit.forge-sites.app')).toBe(true);
    expect(isExternalHref('//orbit.forge-sites.app')).toBe(true);
    expect(isExternalHref('/jobs/1/pay')).toBe(false);
    render(
      <>
        <ActionLink href="/jobs/1/pay">Pay</ActionLink>
        <ActionLink href="https://orbit.forge-sites.app/">Visit</ActionLink>
      </>,
    );
    const internal = screen.getByRole('link', { name: /Pay/ });
    expect(internal).not.toHaveTextContent('↗');
    expect(internal).not.toHaveAttribute('target');
    const external = screen.getByRole('link', { name: /Visit/ });
    expect(external).toHaveTextContent('↗');
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
