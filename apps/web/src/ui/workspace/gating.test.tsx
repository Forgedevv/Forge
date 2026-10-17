import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockController } from '../mocks/client';
import { gatingCopy as copy } from './content/gating';
import { GATING_PASS_KEY, GatingScreen, gatingWaived } from './gating';
import { WorkspaceProvider } from './provider';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(scenario: string) {
  const controller = createMockController(scenario);
  return render(
    <WorkspaceProvider controller={controller}>
      <GatingScreen>
        <p>Chat unlocked</p>
      </GatingScreen>
    </WorkspaceProvider>,
  );
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('$FORGE access check', () => {
  it('is waived when the check is off or nothing is required', () => {
    expect(gatingWaived({ ok: true, enabled: false, required: '1000000', balance: '0' })).toBe(
      true,
    );
    expect(gatingWaived({ ok: true, enabled: true, required: '0', balance: '0' })).toBe(true);
    expect(gatingWaived({ ok: true, enabled: true, required: '000', balance: '0' })).toBe(true);
    expect(gatingWaived({ ok: true, enabled: true, required: '1', balance: '5' })).toBe(false);
    expect(gatingWaived({ ok: false, enabled: true, required: '1', balance: '0' })).toBe(false);
    expect(gatingWaived(null)).toBe(false);
  });

  it('goes straight to the chat while the check is disabled', async () => {
    mount('gating:disabled');
    await settle();
    expect(screen.getByText('Chat unlocked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.continue })).not.toBeInTheDocument();
  });

  it('asks once, then remembers the pass for the rest of the session', async () => {
    const first = mount('gating:ok');
    await settle();
    expect(screen.queryByText('Chat unlocked')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.continue }));
    expect(screen.getByText('Chat unlocked')).toBeInTheDocument();
    expect(sessionStorage.getItem(GATING_PASS_KEY)).toBeTruthy();
    first.unmount();
    // A later visit to /new in the same tab.
    mount('gating:ok');
    expect(screen.getByText('Chat unlocked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.continue })).not.toBeInTheDocument();
  });

  it('forgets the pass when the balance no longer passes', async () => {
    sessionStorage.setItem(GATING_PASS_KEY, 'stale-wallet');
    mount('gating:insufficient');
    await settle();
    expect(screen.queryByText('Chat unlocked')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(GATING_PASS_KEY)).toBeNull();
  });

  it('does not send anyone to a dead end for $FORGE before it can be obtained', async () => {
    mount('gating:insufficient');
    await settle();
    expect(screen.queryByRole('link', { name: /How to get \$FORGE/ })).not.toBeInTheDocument();
    expect(screen.getByText(copy.acquireSoon)).toBeInTheDocument();
  });
});
