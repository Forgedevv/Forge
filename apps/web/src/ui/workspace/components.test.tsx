import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimButton, JobStepTracker, QuoteCountdown } from './components';
import { SpecSummary } from './spec-summary';
import { WorkspaceProvider } from './provider';
import { createMockController } from '../mocks/client';
import { fixtureJob, fullSpec } from '../mocks/fixtures';
import { PaymentScreen } from './payment';
import { LaunchScreen } from './launch';
import { ChatScreen } from './chat';
import { LoginPanel } from './session';
import { GatingScreen } from './gating';
import { safeUrl } from './safe-url';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
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
function mount(scenario: string, component: React.ReactNode) {
  const controller = createMockController(scenario);
  const view = render(<WorkspaceProvider controller={controller}>{component}</WorkspaceProvider>);
  return { controller, ...view };
}

describe('required frontend components', () => {
  it('keeps on-chain steps out of a modification tracker', () => {
    const { rerender } = render(
      <JobStepTracker job={{ ...fixtureJob, status: 'onchain_setup' }} />,
    );
    expect(screen.getByText('Connecting to Meteora').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
    rerender(
      <JobStepTracker job={{ ...fixtureJob, type: 'modify_launchpad', status: 'deploying' }} />,
    );
    expect(screen.queryByText('Connecting to Meteora')).not.toBeInTheDocument();
    expect(screen.queryByText('Signing the launch')).not.toBeInTheDocument();
    expect(screen.getByText('Going live').closest('li')).toHaveAttribute('aria-current', 'step');
  });
  it('marks a failed stage without presenting the job as complete', () => {
    render(
      <JobStepTracker
        job={{ ...fixtureJob, status: 'failed', failedStage: 'build', attempts: 2 }}
      />,
    );
    expect(screen.getByText('Building').closest('li')).toHaveAttribute('data-failed', 'true');
    expect(screen.getByText('Live').closest('li')).toHaveAttribute('data-complete', 'false');
  });
  it('expires a quote once, clamps at zero, and resets for a replacement quote', async () => {
    const expired = vi.fn();
    const { rerender } = render(
      <QuoteCountdown expiresAt="2026-10-07T10:00:02Z" onExpire={expired} />,
    );
    expect(screen.getByText('00:02')).toBeInTheDocument();
    await advance(2500);
    expect(screen.getByText('00:00')).toBeInTheDocument();
    expect(expired).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(expired).toHaveBeenCalledTimes(1);
    rerender(<QuoteCountdown expiresAt="2026-10-07T10:02:00Z" onExpire={expired} />);
    expect(screen.queryByText('00:00')).not.toBeInTheDocument();
  });
  it('shows every specification field and attaches validation to the affected field', () => {
    render(
      <SpecSummary
        spec={fullSpec}
        validation={{ complete: false, errors: { 'launchpadCoin.symbol': 'Choose a symbol.' } }}
      />,
    );
    expect(screen.getByText('orbit.forgepads.xyz')).toBeInTheDocument();
    expect(screen.getByText('1%')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();
    expect(screen.getByText('0.01 SOL')).toBeInTheDocument();
    expect(screen.getByText('0.2 SOL')).toBeInTheDocument();
    expect(screen.getByText('Choose a symbol.').closest('dd')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByText('Coin image')).toBeInTheDocument();
    expect(screen.getByText('Fee recipient')).toBeInTheDocument();
  });
  it('prevents duplicate claims and refreshes only after confirmation', async () => {
    const done = vi.fn();
    const { controller } = mount(
      'dashboard:one',
      <ClaimButton launchpadId="demo-pad" lamports="1285000000" onSuccess={done} />,
    );
    const claim = vi.spyOn(controller.client, 'claimPartnerFees');
    const button = screen.getByRole('button', { name: 'Claim my fees' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    await advance(1800);
    expect(done).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().pads[0]!.claimablePartnerFeesLamports).toBe('0');
  });
  it('disables claiming when there is nothing to claim', () => {
    mount('dashboard:no-fees', <ClaimButton launchpadId="demo-pad" lamports="0" />);
    expect(screen.getByRole('button', { name: 'Nothing to claim' })).toBeDisabled();
  });
});

describe('screen interactions', () => {
  it('blocks expired payment and requests a fresh quote', async () => {
    const { controller } = mount('payment:expired', <PaymentScreen jobId="demo-job" />);
    const pay = vi.spyOn(controller.client, 'payQuote');
    await advance(500);
    expect(screen.getByText('This quote has expired.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay and start/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New quote' }));
    await advance(500);
    expect(screen.getByRole('button', { name: /Pay and start/ })).toBeEnabled();
    expect(pay).not.toHaveBeenCalled();
  });
  it('continues an included change without requesting a signature', async () => {
    mount('payment:included', <PaymentScreen jobId="demo-job" />);
    await advance(500);
    expect(screen.getByText(/No payment or wallet signature/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Continue to the build/ }));
    await advance(10);
    expect(navigation.replace).toHaveBeenCalledWith('/jobs/demo-job');
    expect(screen.queryByRole('button', { name: /Sign in your wallet/ })).not.toBeInTheDocument();
  });
  it('does not permit a launch from the wrong wallet', async () => {
    const { controller } = mount('launch:wrong-wallet', <LaunchScreen jobId="demo-job" />);
    const sign = vi.spyOn(controller.client, 'signOwnerTransaction');
    await advance(500);
    expect(screen.getByText('Connect the owner wallet to launch this coin.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign and launch/ })).not.toBeInTheDocument();
    expect(sign).not.toHaveBeenCalled();
  });
  it('keeps an incomplete blueprint from being confirmed', () => {
    mount('chat:incomplete', <ChatScreen />);
    expect(screen.getByRole('button', { name: /Confirm and go to payment/ })).toBeDisabled();
    expect(screen.getByText('Add the coin symbol before confirming.')).toBeInTheDocument();
  });
  it('presents a rejected login neutrally and allows another attempt', async () => {
    mount('session:rejected', <LoginPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Phantom/ }));
    await advance(850);
    expect(screen.getByRole('status')).toHaveTextContent('Signature declined');
    expect(screen.getByRole('button', { name: /Phantom/ })).toBeEnabled();
  });
  it('blocks access until the balance recheck succeeds', async () => {
    mount(
      'gating:insufficient',
      <GatingScreen>
        <p>Chat unlocked</p>
      </GatingScreen>,
    );
    expect(screen.queryByText('Chat unlocked')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recheck balance' }));
    await advance(500);
    fireEvent.click(screen.getByRole('button', { name: /Continue to the chat/ }));
    expect(screen.getByText('Chat unlocked')).toBeInTheDocument();
  });
  it('rejects unsafe preview and image links', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('//unexpected.example')).toBeNull();
    expect(safeUrl('/dev/preview')).toBe('/dev/preview');
    expect(safeUrl('https://orbit.forgepads.xyz')).toBe('https://orbit.forgepads.xyz/');
  });
});
