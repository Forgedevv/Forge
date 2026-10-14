import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockController } from '../mocks/client';
import { PaymentScreen, QUOTE_TX_FRESH_MS } from './payment';
import { WorkspaceProvider } from './provider';
import { paymentCopy as copy } from './content/payment';

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
  const getQuote = vi.spyOn(controller.client, 'getQuote');
  const payQuote = vi.spyOn(controller.client, 'payQuote');
  render(
    <WorkspaceProvider controller={controller}>
      <PaymentScreen jobId="demo-job" autoRedirect={false} />
    </WorkspaceProvider>,
  );
  return { controller, getQuote, payQuote };
}

describe('payment already sent', () => {
  it('re-confirms the same payment, never offers a new quote, and lets the owner check again', async () => {
    const { getQuote, payQuote } = mount('payment:confirming');
    expect(screen.getByText(copy.confirming)).toBeInTheDocument();
    await advance(1000);
    expect(screen.getByText(copy.stillConfirming)).toBeInTheDocument();
    expect(screen.getByText('Transaction signature')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.fresh })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay and start/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.checkAgain }));
    await advance(1000);
    expect(screen.getByText(copy.paid)).toBeInTheDocument();
    expect(getQuote).not.toHaveBeenCalled();
    expect(payQuote).not.toHaveBeenCalled();
  });

  it('explains a manual refund for a payment received after expiry, with no second payment', async () => {
    const { getQuote } = mount('payment:late');
    await advance(500);
    expect(screen.getByText(copy.needsSupport)).toBeInTheDocument();
    expect(screen.getByText(/refunded manually/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Contact support/ })).toHaveAttribute('href', '/faq');
    expect(screen.queryByRole('button', { name: copy.checkAgain })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.fresh })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay and start/ })).not.toBeInTheDocument();
    expect(getQuote).not.toHaveBeenCalled();
  });

  it('switches to the confirming state when payQuote reports a sent, unconfirmed payment', async () => {
    const { controller, payQuote } = mount('payment:ready');
    payQuote.mockResolvedValue({
      phase: 'error',
      signature: 'demo-payment-confirmation',
      outcome: 'confirming',
      error: 'Your payment was sent and is still being confirmed.',
    });
    await advance(500);
    fireEvent.click(screen.getByRole('button', { name: /Pay and start/ }));
    await advance(10);
    expect(screen.getByText(copy.stillConfirming)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay and start/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.fresh })).not.toBeInTheDocument();
    expect(controller.snapshot().jobs['demo-job']?.status).toBe('spec_ready');
  });
});

describe('stale quoted transaction', () => {
  it('pays the quote as is when the page was opened a moment ago', async () => {
    const { getQuote, payQuote } = mount('payment:ready');
    await advance(500);
    fireEvent.click(screen.getByRole('button', { name: /Pay and start/ }));
    await advance(1000);
    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(payQuote).toHaveBeenCalledTimes(1);
  });

  it('asks for a fresh transaction before signing once its blockhash may have expired', async () => {
    const { getQuote, payQuote } = mount('payment:ready');
    await advance(500);
    await advance(QUOTE_TX_FRESH_MS + 1000);
    fireEvent.click(screen.getByRole('button', { name: /Pay and start/ }));
    await advance(1000);
    expect(getQuote).toHaveBeenCalledTimes(2);
    expect(payQuote).toHaveBeenCalledTimes(1);
    expect(payQuote.mock.calls[0]?.[0]).toEqual(await getQuote.mock.results[1]?.value);
  });

  it('does not pay an amount the owner has not seen', async () => {
    const { getQuote, payQuote } = mount('payment:ready');
    await advance(500);
    const first = await getQuote.mock.results[0]?.value;
    getQuote.mockResolvedValueOnce({ ...first, lamports: String(BigInt(first.lamports) + 1n) });
    await advance(QUOTE_TX_FRESH_MS + 1000);
    fireEvent.click(screen.getByRole('button', { name: /Pay and start/ }));
    await advance(1000);
    expect(getQuote).toHaveBeenCalledTimes(2);
    expect(payQuote).not.toHaveBeenCalled();
  });
});
