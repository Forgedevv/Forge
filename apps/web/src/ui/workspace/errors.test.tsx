import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientError, SpecConfirmRequest } from '@forge/shared';
import { ApiError, mapHttpError, networkError } from '@/client/errors';
import { validateBody } from '@/client/http';
import { createMockController } from '../mocks/client';
import { ErrorNotice, ScreenBoundary } from './components';
import { describeError, readableError } from './errors';
import { errorCopy } from './content/errors';
import { JobScreen } from './job';
import { WorkspaceProvider } from './provider';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanup);

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('nothing was thrown');
}

describe('error messages', () => {
  it('turns a fetch failure into a connection message, the browser text in the details', () => {
    const failure = describeError(networkError(new TypeError('Failed to fetch')));
    expect(failure.message).toBe(errorCopy.offline);
    expect(failure.detail).toContain('Failed to fetch');
    expect(readableError(new TypeError('Failed to fetch'))).toBe(errorCopy.offline);
    expect(readableError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(
      errorCopy.offline,
    );
    expect(readableError(new TypeError('Load failed'))).toBe(errorCopy.offline);
  });

  it('never shows a schema message for a refused request body', () => {
    const error = thrown(() => validateBody(SpecConfirmRequest, { conversationId: 'nope' }));
    const failure = describeError(error);
    expect(failure.message).toBe(errorCopy.invalid);
    expect(failure.message).not.toMatch(/Invalid request|zod|expected/i);
    expect(failure.detail).toMatch(/^invalid request: /);
  });

  it('keeps the readable messages of the server, hides its failures', () => {
    const conflict = mapHttpError(409, {
      code: 'CONFLICT',
      message: 'A change is already in progress for this launchpad.',
    });
    expect(describeError(conflict)).toEqual({
      message: 'A change is already in progress for this launchpad.',
      detail: 'HTTP 409 CONFLICT: A change is already in progress for this launchpad.',
    });
    const crash = mapHttpError(500, {
      code: 'SERVER_ERROR',
      message: 'connect ECONNREFUSED 127.0.0.1:5432',
    });
    expect(describeError(crash).message).toBe(errorCopy.server);
    expect(describeError(crash).detail).toContain('ECONNREFUSED');
    // A proxy error page: no JSON body, so no server message.
    expect(describeError(mapHttpError(502, undefined)).message).toBe(errorCopy.server);
    expect(
      describeError(mapHttpError(503, { message: 'The design chat is busy. Please try again.' }))
        .message,
    ).toBe('The design chat is busy. Please try again.');
    const technical = new ApiError('NETWORK', 'Expected string, received undefined', {
      status: 400,
      serverCode: 'BAD_REQUEST',
      details: {},
      retryAfterMs: null,
    });
    expect(describeError(technical).message).toBe(errorCopy.generic);
  });

  it('keeps the messages written for people and hides runtime errors', () => {
    expect(describeError(new Error('The transaction failed on-chain.'))).toEqual({
      message: 'The transaction failed on-chain.',
      detail: null,
    });
    expect(
      readableError(new TypeError("Cannot read properties of undefined (reading 'wallet')")),
    ).toBe(errorCopy.generic);
    expect(readableError(new Error('Unexpected token < in JSON at position 0'))).toBe(
      errorCopy.generic,
    );
    expect(
      readableError(new Error('Transaction simulation failed: custom program error: 0x1771')),
    ).toBe(errorCopy.transaction);
    expect(readableError(new ClientError('QUOTE_EXPIRED', 'This quote has expired.'))).toBe(
      'This quote has expired.',
    );
    expect(readableError('boom')).toBe(errorCopy.generic);
    expect(readableError(undefined)).toBe(errorCopy.generic);
  });

  it('collapses the technical detail and the reference under "Details for support"', () => {
    render(<ErrorNotice message="We could not reach FORGE." detail="HTTP 502" reference="job-1" />);
    const summary = screen.getByText(errorCopy.details);
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('HTTP 502');
    expect(details).toHaveTextContent('job-1');
  });
});

describe('crash and failed job screens', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows a stable message for a crashed screen, the crash only in the details', () => {
    function Broken(): never {
      throw new TypeError("Cannot read properties of undefined (reading 'status')");
    }
    render(
      <ScreenBoundary onRetry={() => undefined}>
        <Broken />
      </ScreenBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(errorCopy.crash);
    const message = alert.querySelector(':scope > p')!;
    expect(message).not.toHaveTextContent(/Cannot read/);
    expect(alert.querySelector('details')).toHaveTextContent(/Cannot read properties/);
  });

  it('keeps the builder error of a failed job out of the page text', async () => {
    vi.useFakeTimers();
    render(
      <WorkspaceProvider controller={createMockController('job:deploy-failed')}>
        <JobScreen jobId="demo-job" autoRedirect={false} />
      </WorkspaceProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const raw = screen.getByText('Deployment could not be completed.');
    expect(raw.closest('details')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Contact us' })).toBeInTheDocument();
  });
});
