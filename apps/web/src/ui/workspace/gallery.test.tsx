import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StateGallery } from './gallery';
import { galleryCopy } from './content/gallery';
import { WorkspaceProvider } from './provider';
import { createMockController } from '../mocks/client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('lists every screen group and loads an isolated payment-expiry scenario', async () => {
  render(<WorkspaceProvider controller={createMockController()}><StateGallery enabled /></WorkspaceProvider>);
  for (const group of galleryCopy.groups) expect(screen.getByText(group.title)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Expires after 10 seconds' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(screen.getByRole('button', { name: /Pay and start building/ })).toBeEnabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(10500); });
  expect(screen.getByText('This quote has expired.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reset scene' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(screen.getByRole('button', { name: /Pay and start building/ })).toBeEnabled();
});

it('does not activate mock scenes when the explicit flag is disabled', () => {
  render(<WorkspaceProvider><StateGallery enabled={false} /></WorkspaceProvider>);
  expect(screen.queryByRole('navigation', { name: 'Screen states' })).not.toBeInTheDocument();
  expect(screen.getByText(/Enable the development mocks/)).toBeInTheDocument();
});
