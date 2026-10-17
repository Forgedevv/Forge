import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockController } from '../mocks/client';
import { WorkspaceProvider } from './provider';
import { LoginPanel, SessionGate } from './session';
import { sessionCopy as copy } from './content/session';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
// Full-screen renders: allow for a busy machine when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('private beta notice', () => {
  it('replaces the protected screen for a wallet that is not invited', async () => {
    render(
      <WorkspaceProvider controller={createMockController('global:beta')}>
        <SessionGate>
          <p>Protected workshop</p>
        </SessionGate>
      </WorkspaceProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(copy.betaTitle);
    expect(screen.getByText(copy.betaBody)).toBeInTheDocument();
    expect(screen.queryByText('Protected workshop')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /How to get an invite/ })).toHaveAttribute(
      'href',
      '/faq#invite',
    );
  });

  it('is shown when sign-in is refused, and "Use another wallet" returns to the login', async () => {
    render(
      <WorkspaceProvider controller={createMockController('session:beta-sign-in')}>
        <LoginPanel />
      </WorkspaceProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Phantom/ }));
    await advance(850);
    expect(screen.getByRole('alert')).toHaveTextContent(copy.betaTitle);
    expect(screen.queryByRole('button', { name: /Phantom/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.betaSwitch }));
    await advance(10);
    expect(screen.queryByText(copy.betaTitle)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Phantom/ })).toBeEnabled();
  });
});
