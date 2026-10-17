import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientError } from '@forge/shared';
import { createMockController } from '../mocks/client';
import { ChatScreen, NewScreen } from './chat';
import { chatCopy } from './content/chat';
import { common } from './content/common';
import { dashboardCopy } from './content/dashboard';
import { detailCopy } from './content/detail';
import { jobCopy } from './content/job';
import { DashboardScreen } from './dashboard';
import { DetailScreen } from './detail';
import { JobScreen } from './job';
import { WorkspaceProvider } from './provider';
import { continueHref, draftNext } from './start-again';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
// Full-screen renders: allow for a busy machine when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
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

function mount(
  scenario: string,
  component: React.ReactNode,
  prepare?: (c: ReturnType<typeof createMockController>) => void,
) {
  const controller = createMockController(scenario);
  prepare?.(controller);
  render(<WorkspaceProvider controller={controller}>{component}</WorkspaceProvider>);
  return controller;
}

const startAgain = () => screen.queryByRole('button', { name: common.startAgain });

describe('next step of a draft', () => {
  it('starts a refunded draft again, continues an open job, and offers nothing else', () => {
    const draft = { status: 'draft' as const, activeJobId: null, canStartAgain: true };
    expect(draftNext(draft)).toEqual({ kind: 'start_again' });
    expect(
      draftNext({
        ...draft,
        canStartAgain: false,
        activeJobId: 'j1',
        activeJobStatus: 'spec_ready',
      }),
    ).toEqual({
      kind: 'continue',
      href: '/jobs/j1/pay',
    });
    expect(
      draftNext({
        ...draft,
        canStartAgain: undefined,
        activeJobId: 'j1',
        activeJobStatus: 'failed',
      }),
    ).toEqual({
      kind: 'continue',
      href: '/jobs/j1',
    });
    expect(draftNext({ ...draft, canStartAgain: false })).toEqual({ kind: 'none' });
    expect(draftNext({ ...draft, status: 'live' })).toEqual({ kind: 'none' });
    // An older server says nothing about the job: its tracker decides.
    expect(continueHref('a/b', undefined)).toBe('/jobs/a%2Fb');
  });

  it('says why a refunded draft waits, unless a job is open or it can start again', () => {
    const held = {
      status: 'draft' as const,
      activeJobId: null,
      canStartAgain: false,
      startAgainBlocked: 'refund_pending' as const,
    };
    expect(draftNext(held)).toEqual({ kind: 'on_hold', reason: 'refund_pending' });
    expect(draftNext({ ...held, activeJobId: 'j1', activeJobStatus: 'failed' })).toEqual({
      kind: 'continue',
      href: '/jobs/j1',
    });
    expect(draftNext({ ...held, startAgainBlocked: null })).toEqual({ kind: 'none' });
    expect(draftNext({ ...held, status: 'live' })).toEqual({ kind: 'none' });
  });
});

/** The demo refunded draft, held for `reason` by the server. */
function hold(reason: 'refund_pending' | 'payment_pending' | 'needs_support' | 'invalid_spec') {
  return (c: ReturnType<typeof createMockController>) => {
    Object.assign(c.snapshot().pads[0]!, { canStartAgain: false, startAgainBlocked: reason });
  };
}

describe('dashboard', () => {
  it('offers "start again" on a refunded draft, never a change, and opens the new payment', async () => {
    const controller = mount('dashboard:refunded', <DashboardScreen heroFallback />);
    const retry = vi.spyOn(controller.client, 'retryLaunchpad');
    await advance(0);
    expect(screen.getByText(dashboardCopy.refunded)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: dashboardCopy.modify })).not.toBeInTheDocument();
    fireEvent.click(startAgain()!);
    expect(screen.getByRole('button', { name: common.startingAgain })).toBeDisabled();
    await advance(500);
    expect(retry).toHaveBeenCalledWith('demo-pad');
    expect(navigation.push).toHaveBeenCalledWith('/jobs/demo-restart-job/pay');
    expect(controller.snapshot().jobs['demo-restart-job']).toMatchObject({
      status: 'spec_ready',
      type: 'create_launchpad',
    });
  });

  it('shows why "start again" was refused and lets the owner try later', async () => {
    const controller = mount('dashboard:refunded', <DashboardScreen heroFallback />);
    const message = 'The refund of the last attempt is not complete yet.';
    vi.spyOn(controller.client, 'retryLaunchpad').mockRejectedValue(
      new ClientError('NETWORK', message),
    );
    await advance(0);
    fireEvent.click(startAgain()!);
    await advance(0);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(startAgain()).toBeEnabled();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  // Before: "start again" was offered while the refund was still pending, then refused.
  it('shows why a refunded draft cannot be started again yet, without the button', async () => {
    mount('dashboard:refunded', <DashboardScreen heroFallback />, hold('refund_pending'));
    await advance(0);
    expect(startAgain()).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(common.startAgainBlocked.refund_pending);
    expect(screen.queryByText(dashboardCopy.refunded)).not.toBeInTheDocument();
  });

  it('sends a draft refunded too many times to support', async () => {
    mount('dashboard:refunded', <DashboardScreen heroFallback />, hold('needs_support'));
    await advance(0);
    expect(startAgain()).not.toBeInTheDocument();
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(common.startAgainBlocked.needs_support);
    expect(within(notice).getByRole('link', { name: 'Get help' })).toHaveAttribute(
      'href',
      '/faq#support',
    );
  });

  it('reloads after a refusal, so the reason replaces the button', async () => {
    const controller = mount('dashboard:refunded', <DashboardScreen heroFallback />);
    const message = 'A payment for this launchpad is still being processed.';
    vi.spyOn(controller.client, 'retryLaunchpad').mockImplementation(async () => {
      // The server learned of a payment in the meantime; only a reload shows it.
      const state = controller.snapshot();
      state.pads = state.pads.map((p) => ({
        ...p,
        canStartAgain: false,
        startAgainBlocked: 'payment_pending' as const,
      }));
      throw new ClientError('NETWORK', message);
    });
    await advance(0);
    fireEvent.click(startAgain()!);
    await advance(0);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(startAgain()).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(common.startAgainBlocked.payment_pending);
  });

  it('does not offer it while signups are paused', async () => {
    mount('dashboard:refunded', <DashboardScreen heroFallback />, (c) => {
      c.snapshot().signupsPaused = true;
    });
    await advance(0);
    expect(startAgain()).not.toBeInTheDocument();
    expect(screen.getByText(common.paused)).toBeInTheDocument();
  });

  it('continues a draft awaiting payment to its payment, without a change link', async () => {
    mount('dashboard:draft', <DashboardScreen heroFallback />);
    await advance(0);
    const card = screen.getByRole('heading', { name: 'Orbit', level: 2 }).closest('.fw-card')!;
    expect(within(card as HTMLElement).getByRole('link', { name: /Continue/ })).toHaveAttribute(
      'href',
      '/jobs/demo-job/pay',
    );
    expect(screen.queryByRole('link', { name: dashboardCopy.modify })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View build/ })).not.toBeInTheDocument();
    expect(startAgain()).not.toBeInTheDocument();
  });

  it('keeps the change link of a live launchpad only', async () => {
    mount('dashboard:three', <DashboardScreen heroFallback />);
    await advance(0);
    // Live Orbit: one change link; sleeping Lunar is reactivated first; disabled Comet has none.
    expect(screen.getAllByRole('link', { name: dashboardCopy.modify })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: dashboardCopy.modify })[0]).toHaveAttribute(
      'href',
      '/launchpads/demo-pad/modify',
    );
  });
});

describe('launchpad page', () => {
  it('offers "start again" instead of a change for a refunded draft', async () => {
    mount('detail:refunded', <DetailScreen launchpadId="demo-pad" />);
    await advance(0);
    expect(screen.queryByRole('link', { name: /Request a change/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(detailCopy.refunded);
    fireEvent.click(startAgain()!);
    await advance(500);
    expect(navigation.push).toHaveBeenCalledWith('/jobs/demo-restart-job/pay');
  });

  it('says why a refunded draft waits instead of offering "start again"', async () => {
    mount('detail:refunded', <DetailScreen launchpadId="demo-pad" />, hold('invalid_spec'));
    await advance(0);
    expect(startAgain()).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(common.startAgainBlocked.invalid_spec);
    expect(screen.queryByText(detailCopy.refunded)).not.toBeInTheDocument();
  });

  it('keeps "request a change" for a live launchpad', async () => {
    mount('detail:ready', <DetailScreen launchpadId="demo-pad" />);
    await advance(0);
    expect(screen.getByRole('link', { name: /Request a change/ })).toHaveAttribute(
      'href',
      '/launchpads/demo-pad/modify',
    );
    expect(startAgain()).not.toBeInTheDocument();
  });
});

describe('change chat of a launchpad that is not live', () => {
  it('explains a refunded draft instead of opening the chat, and starts it again', async () => {
    mount('chat:refunded-draft', <NewScreen launchpadId="demo-pad" />);
    await advance(0);
    expect(
      screen.getByRole('heading', { name: chatCopy.unavailable.draftTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText(chatCopy.unavailable.refunded)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm this change/ })).not.toBeInTheDocument();
    expect(document.querySelector('.fw-chat-ready')).toBeNull();
    fireEvent.click(startAgain()!);
    await advance(500);
    expect(navigation.push).toHaveBeenCalledWith('/jobs/demo-restart-job/pay');
  });

  it('sends a sleeping launchpad back to the dashboard to be reactivated', async () => {
    mount('chat:modification', <NewScreen launchpadId="demo-pad" />, (c) => {
      c.snapshot().pads[0]!.status = 'sleeping';
    });
    await advance(0);
    expect(
      screen.getByRole('heading', { name: chatCopy.unavailable.sleepingTitle }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /My dashboard/ })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('never shows the ready box for a change that cannot be confirmed', async () => {
    // The chat itself, rendered for a draft (e.g. from an old link): no confirmation at all.
    mount('chat:modification', <ChatScreen launchpadId="demo-pad" />, (c) => {
      c.snapshot().pads[0]!.status = 'draft';
    });
    await advance(0);
    expect(document.querySelector('.fw-chat-ready')).toBeNull();
    expect(screen.getByText(chatCopy.unavailable.draft)).toBeInTheDocument();
    for (const button of screen.queryAllByRole('button', { name: /Confirm this change/ })) {
      expect(button).toBeDisabled();
    }
  });

  it('keeps the ready box off while another change is in progress', async () => {
    mount('chat:modification', <ChatScreen launchpadId="demo-pad" />, (c) => {
      Object.assign(c.snapshot().pads[0]!, {
        activeJobId: 'demo-job',
        activeJobStatus: 'building',
      });
    });
    await advance(0);
    expect(document.querySelector('.fw-chat-ready')).toBeNull();
    expect(screen.getByText(chatCopy.changeInProgress)).toBeInTheDocument();
  });

  it('offers the confirmation of a change for a live launchpad', async () => {
    mount('chat:modification', <ChatScreen launchpadId="demo-pad" />);
    await advance(0);
    const ready = document.querySelector('.fw-chat-ready') as HTMLElement;
    expect(ready).not.toBeNull();
    expect(within(ready).getByRole('button', { name: /Confirm this change/ })).toBeEnabled();
  });
});

describe('job page', () => {
  it('offers "start again" once a creation is refunded', async () => {
    mount('job:refunded', <JobScreen jobId="demo-job" autoRedirect={false} />);
    await advance(0);
    expect(screen.getByText(jobCopy.refunded)).toBeInTheDocument();
    expect(screen.getByText(jobCopy.startAgain)).toBeInTheDocument();
    fireEvent.click(startAgain()!);
    await advance(500);
    expect(navigation.push).toHaveBeenCalledWith('/jobs/demo-restart-job/pay');
  });

  it('says why a refunded creation cannot be started again yet', async () => {
    mount('job:refunded', <JobScreen jobId="demo-job" autoRedirect={false} />, (c) => {
      // The pad of the demo job, held by the server.
      const pad = c
        .snapshot()
        .pads.find((p) => p.id === c.snapshot().jobs['demo-job']!.launchpadId)!;
      Object.assign(pad, { canStartAgain: false, startAgainBlocked: 'needs_support' });
    });
    await advance(0);
    expect(screen.getByText(jobCopy.refunded)).toBeInTheDocument();
    expect(startAgain()).not.toBeInTheDocument();
    expect(screen.queryByText(jobCopy.startAgain)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(common.startAgainBlocked.needs_support);
  });

  it('does not offer a change on the preview of a creation (the launchpad is a draft)', async () => {
    mount('job:preview_ready', <JobScreen jobId="demo-job" autoRedirect={false} />);
    await advance(0);
    expect(screen.getByRole('button', { name: /Approve the preview/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Request a change/ })).not.toBeInTheDocument();
  });

  it('keeps it on the preview of a change of a live launchpad', async () => {
    mount('job:preview_ready-modification', <JobScreen jobId="demo-job" autoRedirect={false} />);
    await advance(0);
    expect(screen.getByRole('link', { name: /Request a change/ })).toBeInTheDocument();
  });
});
