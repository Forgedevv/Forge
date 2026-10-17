import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockController } from '../mocks/client';
import { jobCopy } from './content/job';
import { JobScreen } from './job';
import { PreviewCard, previewFeatures } from './preview-card';
import { WorkspaceProvider } from './provider';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.setConfig({ testTimeout: 30_000 });

const URL = 'https://orbit-abc123-forge.vercel.app/';
const copy = jobCopy.previewCard;

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('build preview', () => {
  it('opens the preview in a new tab that cannot reach FORGE', () => {
    render(<PreviewCard url={URL} />);
    const link = screen.getByRole('link', { name: new RegExp(copy.open) });
    expect(link).toHaveAttribute('href', URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('orbit-abc123-forge.vercel.app')).toBeInTheDocument();
  });

  it('opens a desktop or a phone sized window, without an opener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<PreviewCard url={URL} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.mobile) }));
    expect(open).toHaveBeenCalledWith(URL, 'forge-preview-mobile', previewFeatures('mobile'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.desktop) }));
    expect(open).toHaveBeenLastCalledWith(URL, 'forge-preview-desktop', previewFeatures('desktop'));
    expect(previewFeatures('mobile')).toBe('popup=yes,width=390,height=844,noopener,noreferrer');
  });

  it('never embeds the client site in the job page', async () => {
    vi.useFakeTimers();
    const { container } = render(
      <WorkspaceProvider controller={createMockController('job:preview_ready')}>
        <JobScreen jobId="demo-job" autoRedirect={false} />
      </WorkspaceProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(jobCopy.preview)).toBeInTheDocument();
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('link', { name: new RegExp(copy.open) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve the preview/ })).toBeEnabled();
  });
});
