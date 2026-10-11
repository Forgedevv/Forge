import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMockController } from '../mocks/client';
import { dashboardCopy as copy } from './content/dashboard';
import { DashboardScreen } from './dashboard';
import { WorkspaceProvider } from './provider';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
// Full-screen renders: allow for a busy machine when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mount(scenario = 'dashboard:three') {
  render(
    <WorkspaceProvider controller={createMockController(scenario)}>
      <DashboardScreen heroFallback />
    </WorkspaceProvider>,
  );
  await act(async () => {});
}

it('combines the status filter and search, then restores the portfolio', async () => {
  await mount();
  expect(screen.getAllByRole('link', { name: /^Open / })).toHaveLength(3);
  fireEvent.change(screen.getByRole('searchbox', { name: copy.searchLabel }), {
    target: { value: 'LUNAR' },
  });
  expect(screen.getByRole('link', { name: 'Open Lunar' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Open Orbit' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: copy.filters.live }));
  expect(screen.getByText(copy.noMatches)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: copy.clearFilters }));
  expect(screen.getAllByRole('link', { name: /^Open / })).toHaveLength(3);
  expect(screen.getByRole('searchbox', { name: copy.searchLabel })).toHaveValue('');
});

it('keeps the site, detail and editing actions distinct on each cover', async () => {
  await mount();
  expect(screen.getByRole('link', { name: 'Open Orbit' })).toHaveAttribute(
    'href',
    '/launchpads/demo-pad',
  );
  fireEvent.click(screen.getByRole('button', { name: copy.filters.disabled }));
  expect(screen.getByRole('link', { name: 'Open Comet' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: copy.modify })).not.toBeInTheDocument();
  expect(screen.getByText(copy.disabled)).toBeInTheDocument();
});

it('says when on-chain figures are unknown instead of showing zero', async () => {
  await mount('dashboard:onchain-unavailable');
  expect(screen.getByText(copy.feesUnavailable)).toBeInTheDocument();
  expect(screen.queryByText('0 SOL')).not.toBeInTheDocument();
});

it('shows a failed load with a retry instead of an empty workshop', async () => {
  await mount('dashboard:load-error');
  expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});
