import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockController } from '../mocks/client';
import { LaunchScreen } from './launch';
import { WorkspaceProvider } from './provider';
import { launchCopy as copy } from './content/launch';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
// Full-screen renders: allow for a busy machine when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(scenario: string) {
  const controller = createMockController(scenario);
  const sign = vi.spyOn(controller.client, 'signOwnerTransaction');
  render(
    <WorkspaceProvider controller={controller}>
      <LaunchScreen jobId="demo-job" autoRedirect={false} />
    </WorkspaceProvider>,
  );
  return { controller, sign };
}

describe('launch review', () => {
  it('labels fees and deposits and shows the total taken from the wallet', async () => {
    mount('launch:ready');
    await advance(500);
    expect(screen.getByText(copy.firstBuy)).toBeInTheDocument();
    expect(screen.getByText(copy.network)).toBeInTheDocument();
    expect(screen.getByText(copy.total)).toBeInTheDocument();
    expect(screen.queryByText('Estimated network fee')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign and launch/ })).toBeEnabled();
  });

  it.each([
    ['launch:simulation-failed', copy.simulationFailed],
    ['launch:simulation-unavailable', copy.simulationUnavailable],
  ])('%s: warns and requires an explicit confirmation before signing', async (scenario, title) => {
    const { sign } = mount(scenario);
    await advance(500);
    expect(screen.getByRole('alert')).toHaveTextContent(title);
    const button = screen.getByRole('button', { name: /Sign and launch/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(sign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: copy.acknowledge }));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(sign).toHaveBeenCalledTimes(1);
    await advance(1800);
    expect(screen.getByText(copy.confirmed)).toBeInTheDocument();
  });
});

describe('launch already signed', () => {
  it.each(['launch:already-signed', 'job:owner_signed'])(
    '%s: shows the confirmed launch and never asks to sign',
    async (scenario) => {
      const { sign } = mount(scenario);
      await advance(500);
      expect(screen.getByText(copy.confirmed)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Back to tracking/ })).toHaveAttribute(
        'href',
        '/jobs/demo-job',
      );
      expect(screen.queryByRole('button', { name: /Sign and launch/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it('offers to resend the kept signed launch after a failed submission', async () => {
    const { sign } = mount('launch:ready');
    sign.mockResolvedValueOnce({
      phase: 'error',
      signature: 'demo-launch-signature',
      error: 'Your signed launch was sent and is still confirming.',
    });
    await advance(500);
    fireEvent.click(screen.getByRole('button', { name: /Sign and launch/ }));
    await advance(10);
    expect(screen.getByRole('button', { name: /Retry the same launch transaction/ })).toBeEnabled();
    expect(screen.getByText(copy.retrySigned)).toBeInTheDocument();
  });
});
