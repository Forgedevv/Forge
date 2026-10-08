import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MuseHero } from './muse-hero';
import { DashboardScreen } from './dashboard';
import { WorkspaceProvider } from './provider';
import { createMockController } from '../mocks/client';
import { dashboardCopy } from './content/dashboard';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('falls back to the 2D Muse with the launchpad Muses when WebGL is unavailable', async () => {
  const { container } = render(
    <MuseHero
      action="live"
      muses={[
        { id: 'a', primary: '#3a6bff', accent: '#3ee6c1' },
        { id: 'b', primary: null, accent: null },
      ]}
    />,
  );
  await act(async () => {});
  expect(container.querySelector('.fw-muse-hero-stage')).toHaveAttribute('data-fallback', 'true');
  expect(container.querySelectorAll('.fw-muse-hero-family .muse')).toHaveLength(2);
  expect(screen.getByRole('heading', { name: dashboardCopy.hero.live.title })).toBeInTheDocument();
});

it.each([
  ['hero:welcome', 'welcome'],
  ['hero:building', 'building'],
  ['hero:live', 'live'],
  ['hero:idle', 'idle'],
] as const)('shows the %s dashboard hero', async (scenario, action) => {
  vi.useFakeTimers();
  try {
    const { container } = render(
      <WorkspaceProvider controller={createMockController(scenario)}>
        <DashboardScreen />
      </WorkspaceProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.querySelector('.fw-muse-hero')).toHaveAttribute('data-action', action);
    expect(screen.getByText(dashboardCopy.hero[action].title)).toBeInTheDocument();
    if (action === 'welcome')
      expect(screen.getByRole('link', { name: /Create a launchpad/ })).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
