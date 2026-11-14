import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homeContent } from '../home/content';
import { ForgeHome } from '../home/home';
import { createMockController } from '../mocks/client';
import { common } from './content/common';
import { useWorkspace, WorkspaceProvider } from './provider';
import { WorkspaceFrame } from './shell';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('../home/engine', () => ({
  createExperience: (
    _element: HTMLElement,
    options: { onChapter(chapter: number): void; onIntroDone(): void },
  ) => {
    options.onChapter(0);
    options.onIntroDone();
    return {
      goTo: vi.fn(),
      dispose: vi.fn(),
      setPaused: vi.fn(),
      setInteractive: vi.fn(),
      skipIntro: vi.fn(),
    };
  },
}));
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function withProvider(children: ReactNode, prelaunch: boolean) {
  return render(
    <WorkspaceProvider controller={createMockController('dashboard:one')} prelaunch={prelaunch}>
      {children}
    </WorkspaceProvider>,
  );
}

describe('pre-launch mode', () => {
  it('replaces the workshop pages with "Coming soon" and hides the wallet button', () => {
    withProvider(
      <WorkspaceFrame>
        <p>Workshop page</p>
      </WorkspaceFrame>,
      true,
    );
    expect(screen.getByRole('heading', { name: common.comingSoon })).toBeInTheDocument();
    expect(screen.queryByText('Workshop page')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: common.connect })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: common.dashboard })).not.toBeInTheDocument();
    expect(screen.getByText(common.comingSoonBadge)).toBeInTheDocument();
  });

  it('keeps the FAQ and the terms readable', () => {
    withProvider(
      <WorkspaceFrame requireSession={false}>
        <p>FAQ page</p>
      </WorkspaceFrame>,
      true,
    );
    expect(screen.getByText('FAQ page')).toBeInTheDocument();
  });

  it('answers every wallet connection request with "Coming soon"', () => {
    function Connect() {
      const { openLogin } = useWorkspace();
      return <button onClick={openLogin}>Connect</button>;
    }
    withProvider(<Connect />, true);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('status')).toHaveTextContent(common.comingSoonToast);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the "Coming soon" panel from the homepage buttons', async () => {
    withProvider(<ForgeHome />, true);
    await waitFor(() => expect(screen.queryByText(homeContent.loading)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: homeContent.create }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(homeContent.connection.eyebrow);
    expect(dialog).toHaveTextContent(homeContent.connection.title);
  });

  it('changes nothing when off', () => {
    withProvider(
      <WorkspaceFrame requireSession={false}>
        <p>Page</p>
      </WorkspaceFrame>,
      false,
    );
    expect(screen.getAllByRole('link', { name: common.dashboard }).length).toBeGreaterThan(0);
    expect(screen.queryByText(common.comingSoonBadge)).not.toBeInTheDocument();
  });
});
