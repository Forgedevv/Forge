// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSwapCore } from '../../src/forge/trade/core-adapter';
import { createMockSwapCore, type MockSwapCore } from '../../src/forge/trade/core-adapter.mock';
import { clearPendingTrade } from '../../src/forge/trade/send';
import {
  accountsByAddress,
  connectionRef,
  createFakeConnection,
  keys,
  mintAccount,
  okSigner,
  poolAccount,
  SIGNED_SIGNATURE,
  site,
  wallet,
  type FakeConnection,
} from './harness';
import { TradePanel } from '../../src/forge/TradePanel';

vi.mock('@jup-ag/wallet-adapter', async () => {
  const h = await import('./harness');
  return {
    useWallet: () => ({
      publicKey: h.wallet.publicKey,
      signTransaction: h.wallet.signTransaction,
    }),
    useUnifiedWalletContext: () => ({ setShowModal: h.wallet.setShowModal }),
  };
});

// jsdom's Uint8Array realm breaks PDA derivation; the derivation itself is not under test here.
vi.mock('@solana/spl-token', async (importOriginal) => {
  const h = await import('./harness');
  // Keep the other exports: `@forge/core` (imported by the swap adapter) needs them at load time.
  return {
    ...(await importOriginal<typeof import('@solana/spl-token')>()),
    getAssociatedTokenAddressSync: () => h.keys.user,
  };
});

vi.mock('../../src/forge/config', async () => {
  const h = await import('./harness');
  return {
    siteConfig: h.site,
    onchainConfig: {
      cluster: 'devnet',
      launchpadConfig: h.keys.config,
      launchpadCoinConfig: h.keys.coinConfig,
      launchpadCoinMint: h.keys.ownMint,
    },
    forgeConfig: {},
  };
});

// PDA derivation is covered in node by pool-address.test.ts and launchpad-pool.test.ts.
vi.mock('../../src/forge/trade/pool-address', async () => {
  const h = await import('./harness');
  return { launchpadPoolForMint: h.derivedPool };
});

vi.mock('../../src/forge/trade/connection', async () => {
  const h = await import('./harness');
  return { getRelayConnection: () => h.connectionRef.current };
});

vi.mock('../../src/forge/JupiterTrade', async () => {
  const { isLaunchpadPool } = await import('../../src/forge/trade/launchpad-pool');
  const Mock = ({ launchpadPool }: { launchpadPool: { mint: string } }) => (
    <div
      data-testid="jupiter-mock"
      data-mint={launchpadPool.mint}
      data-issued={String(isLaunchpadPool(launchpadPool))}
    />
  );
  return { default: Mock, JupiterTrade: Mock };
});

const CONFIRM = { intervalMs: 1, timeoutMs: 2000 };

let connection: FakeConnection;
let core: MockSwapCore;
let restore: () => void;

beforeEach(() => {
  site.mode = 'live';
  wallet.publicKey = keys.user;
  clearPendingTrade(keys.user.toBase58());
  wallet.signTransaction = okSigner();
  wallet.setShowModal.mockReset();
  connection = createFakeConnection();
  connectionRef.current = connection;
  core = createMockSwapCore();
  restore = setSwapCore(core);
});

afterEach(() => {
  cleanup();
  restore();
});

function renderPanel(extra: Partial<React.ComponentProps<typeof TradePanel>> = {}) {
  return render(
    <TradePanel
      mint={keys.mint}
      symbol="MOON"
      quoteDebounceMs={0}
      quoteRefreshMs={0}
      confirmOptions={CONFIRM}
      {...extra}
    />,
  );
}

const amountInput = () => screen.getByLabelText(/amount to/i);
const submit = () => screen.getByTestId('trade-submit') as HTMLButtonElement;

async function typeAmount(value: string) {
  await screen.findByTestId('trade-form');
  fireEvent.change(amountInput(), { target: { value } });
}

async function readyToTrade(value: string, label: RegExp) {
  await typeAmount(value);
  await screen.findByTestId('quote-summary');
  await waitFor(() => expect(submit().textContent).toMatch(label));
  expect(submit().disabled).toBe(false);
}

describe('fee shown before signing', () => {
  it('displays the quote, the explicit 0.3% FORGE fee, the network fee and the total, without any signature', async () => {
    renderPanel();
    await typeAmount('0.5');
    const summary = await screen.findByTestId('quote-summary');

    expect(within(summary).getByTestId('quote-row-platform-fee').textContent).toContain(
      'FORGE platform fee (0.3%)',
    );
    expect(within(summary).getByTestId('quote-row-platform-fee').textContent).toContain(
      '0.0015 SOL',
    );
    expect(within(summary).getByTestId('quote-row-out').textContent).toContain('500 MOON');
    expect(within(summary).getByTestId('quote-row-impact').textContent).toContain('0.42%');
    expect(within(summary).getByTestId('quote-row-trading-fee')).toBeTruthy();
    expect(within(summary).getByTestId('quote-row-network-fee').textContent).toContain('0.000005');
    // 0.5 + 0.0015 + 0.000005 network + 0.00203928 token account deposit
    expect(within(summary).getByTestId('quote-row-account-rent')).toBeTruthy();
    expect(within(summary).getByTestId('quote-row-total').textContent).toContain('0.50354428 SOL');

    expect(screen.getByTestId('fee-note').textContent).toContain('0.3%');
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('shows the quote even when no wallet is connected, then asks to connect', async () => {
    wallet.publicKey = null;
    wallet.signTransaction = null;
    renderPanel();
    await typeAmount('0.1');
    await screen.findByTestId('quote-summary');
    await waitFor(() => expect(submit().textContent).toBe('Connect wallet'));
    fireEvent.click(submit());
    expect(wallet.setShowModal).toHaveBeenCalledWith(true);
  });
});

describe('mode guard', () => {
  for (const mode of ['sleeping', 'disabled'] as const) {
    it(`renders a disabled notice and makes no call when the site is ${mode}`, () => {
      site.mode = mode;
      renderPanel();
      const notice = screen.getByTestId('trade-disabled') as HTMLButtonElement;
      expect(notice.disabled).toBe(true);
      expect(screen.queryByTestId('trade-form')).toBeNull();
      expect(screen.queryByTestId('jupiter-mock')).toBeNull();
      expect(core.calls).toEqual({ quote: 0, buy: 0, sell: 0, graduated: 0 });
      expect(connection.getBalance).not.toHaveBeenCalled();
    });
  }

  it('keeps the action disabled while loading and quoting', async () => {
    renderPanel();
    await typeAmount('0.2');
    // Immediately after typing, the quote is not there yet.
    expect(submit().disabled).toBe(true);
    await screen.findByTestId('quote-summary');
  });
});

describe('routing', () => {
  it('shows the buy/sell form while the coin is on the curve', async () => {
    renderPanel();
    expect(await screen.findByTestId('trade-form')).toBeTruthy();
    expect(screen.queryByTestId('jupiter-mock')).toBeNull();
    expect(core.calls.graduated).toBe(1);
  });

  it('routes a graduated coin to Jupiter and never quotes on the curve', async () => {
    core.options.graduated = true;
    renderPanel();
    const jupiter = await screen.findByTestId('jupiter-mock');
    expect(jupiter.getAttribute('data-mint')).toBe(keys.mint);
    // Jupiter gets the pool handle found on this launchpad, never a raw mint.
    expect(jupiter.getAttribute('data-issued')).toBe('true');
    expect(screen.queryByTestId('trade-form')).toBeNull();
    expect(core.calls.quote).toBe(0);
    expect(screen.getByTestId('trade-jupiter').textContent).toContain('0.3%');
  });

  it('does not guess a route when the graduation check fails, and can retry', async () => {
    const failing = vi
      .spyOn(core, 'isGraduated')
      .mockRejectedValueOnce(new Error('Failed to fetch'));
    renderPanel();
    const alert = await screen.findByTestId('trade-route-error');
    expect(alert.textContent).toContain('Network error');
    expect(screen.queryByTestId('trade-form')).toBeNull();
    fireEvent.click(within(alert).getByText('Retry'));
    expect(await screen.findByTestId('trade-form')).toBeTruthy();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('switches to Jupiter when a swap reveals the pool graduated meanwhile', async () => {
    vi.spyOn(core, 'buildBuyTx').mockRejectedValueOnce(new Error('Pool is graduated'));
    renderPanel();
    await readyToTrade('0.1', /Buy MOON/);
    fireEvent.click(submit());
    expect(await screen.findByTestId('jupiter-mock')).toBeTruthy();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('rejects malformed, zero and over-precise amounts', async () => {
    renderPanel();
    await typeAmount('abc');
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain('Enter a number');
    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toBe('Enter an amount');

    fireEvent.change(amountInput(), { target: { value: '0' } });
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain('greater than zero');

    fireEvent.change(amountInput(), { target: { value: '0.0000000001' } });
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toContain('At most 9 decimals');
    expect(core.calls.quote).toBe(0);
  });

  it('bounds the slippage setting', async () => {
    renderPanel();
    await typeAmount('0.1');
    await screen.findByTestId('quote-summary');
    const slippage = screen.getByLabelText(/custom slippage/i);

    fireEvent.change(slippage, { target: { value: '50' } });
    await waitFor(() => expect(submit().textContent).toBe('Fix slippage'));
    expect(screen.getByText(/at most 25%/i)).toBeTruthy();
    expect(submit().disabled).toBe(true);

    fireEvent.change(slippage, { target: { value: '0.01' } });
    expect(screen.getByText(/at least 0.1%/i)).toBeTruthy();

    fireEvent.change(slippage, { target: { value: '10' } });
    expect(screen.getByText(/High slippage/i)).toBeTruthy();
    await waitFor(() => expect(submit().textContent).toMatch(/Buy MOON/));
  });

  it('blocks a buy the wallet cannot pay (amount + fees)', async () => {
    connection.getBalance.mockResolvedValue(100_000_000);
    renderPanel();
    await typeAmount('0.1');
    await screen.findByTestId('quote-summary');
    await waitFor(() => expect(submit().textContent).toBe('Insufficient balance'));
    expect(submit().disabled).toBe(true);
  });
});

describe('quote refresh', () => {
  it('refreshes the quote on an interval', async () => {
    renderPanel({ quoteRefreshMs: 25 });
    await typeAmount('0.1');
    await screen.findByTestId('quote-summary');
    await waitFor(() => expect(core.calls.quote).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    // The quote stays on screen across refreshes.
    expect(screen.getByTestId('quote-summary')).toBeTruthy();
  });

  it('drops the quote when the amount changes', async () => {
    renderPanel();
    await typeAmount('0.1');
    await screen.findByTestId('quote-summary');
    fireEvent.change(amountInput(), { target: { value: '0.2' } });
    await waitFor(() =>
      expect(screen.getByTestId('quote-row-pay').textContent).toContain('0.2 SOL'),
    );
  });

  it('refuses a quote whose platform fee is not 0.3%', async () => {
    core.options.platformFeeOverride = BigInt(1);
    renderPanel();
    await typeAmount('0.1');
    const alert = await screen.findByTestId('trade-error');
    expect(alert.getAttribute('data-code')).toBe('quote_invalid');
    expect(screen.queryByTestId('quote-summary')).toBeNull();
    expect(submit().disabled).toBe(true);
  });
});

describe('buy and sell execution', () => {
  it('buys: simulates before signing, enforces the displayed minimum, confirms by polling and links the explorer', async () => {
    const build = vi.spyOn(core, 'buildBuyTx');
    const onTradeConfirmed = vi.fn();
    renderPanel({ onTradeConfirmed });
    await readyToTrade('0.1', /Buy MOON/);
    const minShown = screen.getByTestId('quote-row-min').textContent;
    expect(minShown).toContain('99 MOON');

    fireEvent.click(submit());
    const success = await screen.findByTestId('trade-success');

    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]?.[0]).toMatchObject({
      amountIn: BigInt(100_000_000),
      minAmountOut: BigInt(99_000_000),
    });
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(connection.getSignatureStatuses).toHaveBeenCalled();
    const simulateOrder = connection.simulateTransaction.mock.invocationCallOrder[0] ?? Infinity;
    const signOrder =
      (wallet.signTransaction as ReturnType<typeof okSigner>).mock.invocationCallOrder[0] ?? 0;
    expect(simulateOrder).toBeLessThan(signOrder);

    const link = within(success).getByRole('link') as HTMLAnchorElement;
    expect(link.href).toBe(`https://explorer.solana.com/tx/${SIGNED_SIGNATURE}?cluster=devnet`);
    expect(link.rel).toContain('noopener');
    expect(onTradeConfirmed).toHaveBeenCalledWith(SIGNED_SIGNATURE);
  });

  it('sells: uses the token balance and the sell builder', async () => {
    const data = new Uint8Array(165);
    new DataView(data.buffer).setBigUint64(64, BigInt(5_000_000), true);
    connection.getAccountInfo.mockImplementation(
      accountsByAddress(() => ({ data, lamports: 2_039_280 })),
    );
    const build = vi.spyOn(core, 'buildSellTx');
    renderPanel();
    await screen.findByTestId('trade-form');
    fireEvent.click(screen.getByRole('tab', { name: 'sell' }));
    await screen.findByTestId('balance');
    fireEvent.change(amountInput(), { target: { value: '1' } });
    await screen.findByTestId('quote-summary');
    await waitFor(() => expect(submit().textContent).toBe('Sell MOON'));
    expect(screen.getByTestId('quote-row-platform-fee').textContent).toContain(
      'FORGE platform fee (0.3%)',
    );

    fireEvent.click(submit());
    await screen.findByTestId('trade-success');
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]?.[0]).toMatchObject({ amountIn: BigInt(1_000_000) });
  });

  it('sells with the decimals of the on-chain mint, not the data API value', async () => {
    const data = new Uint8Array(165);
    new DataView(data.buffer).setBigUint64(64, BigInt(5_000_000_000), true);
    // The mint has 9 decimals; the data API claims 6.
    connection.getAccountInfo.mockImplementation(
      accountsByAddress(() => ({ data, lamports: 2_039_280 }), mintAccount(9)),
    );
    const build = vi.spyOn(core, 'buildSellTx');
    renderPanel({ displayDecimals: 6 });
    await screen.findByTestId('trade-form');
    fireEvent.click(screen.getByRole('tab', { name: 'sell' }));
    await waitFor(() => expect(screen.getByTestId('balance').textContent).toContain('5 MOON'));
    fireEvent.change(amountInput(), { target: { value: '1' } });
    await screen.findByTestId('quote-summary');
    await waitFor(() => expect(submit().textContent).toBe('Sell MOON'));
    fireEvent.click(submit());
    await screen.findByTestId('trade-success');
    expect(build.mock.calls[0]?.[0]).toMatchObject({ amountIn: BigInt(1_000_000_000) });
  });

  it('does not sell while the mint cannot be read, and retries', async () => {
    let fail = true;
    connection.getAccountInfo.mockImplementation(async (address: { toBase58(): string }) => {
      if (address.toBase58() === keys.pool) return poolAccount();
      if (address.toBase58() === keys.mint && fail) return null;
      return address.toBase58() === keys.mint ? mintAccount(6) : null;
    });
    const quote = vi.spyOn(core, 'quoteSwap');
    renderPanel({ displayDecimals: 6 });
    await screen.findByTestId('trade-form');
    fireEvent.click(screen.getByRole('tab', { name: 'sell' }));
    const alert = await screen.findByTestId('mint-error');
    expect(alert.textContent).toContain('does not exist');
    fireEvent.change(amountInput(), { target: { value: '1' } });
    expect(submit().textContent).toBe('Coin unavailable');
    expect(submit().disabled).toBe(true);
    expect(quote).not.toHaveBeenCalled();

    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('mint-error')).toBeNull());
    await screen.findByTestId('quote-summary');
    expect(quote).toHaveBeenCalled();
  });

  it('blocks a sell above the token balance', async () => {
    renderPanel();
    await screen.findByTestId('trade-form');
    fireEvent.click(screen.getByRole('tab', { name: 'sell' }));
    fireEvent.change(amountInput(), { target: { value: '1' } });
    await screen.findByTestId('quote-summary');
    await waitFor(() => expect(submit().textContent).toBe('Insufficient balance'));
  });

  it('does not build or sign when the price moved below the accepted minimum', async () => {
    const build = vi.spyOn(core, 'buildBuyTx');
    renderPanel();
    await readyToTrade('0.1', /Buy MOON/);
    core.options.tokensPerSol = BigInt(500_000_000);
    fireEvent.click(submit());
    const alert = await screen.findByTestId('trade-error');
    expect(alert.getAttribute('data-code')).toBe('price_moved');
    expect(build).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
});

describe('error mapping', () => {
  it('maps a wallet rejection and sends nothing', async () => {
    wallet.signTransaction = vi.fn(async () => {
      throw new Error('User rejected the request.');
    });
    renderPanel();
    await readyToTrade('0.1', /Buy MOON/);
    fireEvent.click(submit());
    const alert = await screen.findByTestId('trade-error');
    expect(alert.getAttribute('data-code')).toBe('user_rejected');
    expect(alert.textContent).toContain('Nothing was sent');
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(screen.queryByTestId('trade-success')).toBeNull();
  });

  it('maps a failing simulation without asking the wallet to sign', async () => {
    connection.simulateTransaction.mockResolvedValue({
      context: { slot: 1 },
      value: { err: { InstructionError: [1, 'InsufficientFundsForRent'] }, logs: [] },
    });
    renderPanel();
    await readyToTrade('0.1', /Buy MOON/);
    fireEvent.click(submit());
    const alert = await screen.findByTestId('trade-error');
    expect(alert.getAttribute('data-code')).toBe('insufficient_rent');
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('maps an on-chain failure after sending and keeps the explorer link', async () => {
    connection.getSignatureStatuses.mockResolvedValue({
      context: { slot: 1 },
      value: [{ err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: 'confirmed' }],
    });
    renderPanel();
    await readyToTrade('0.1', /Buy MOON/);
    fireEvent.click(submit());
    const alert = await screen.findByTestId('trade-error');
    expect(alert.getAttribute('data-code')).toBe('tx_failed');
    expect(within(alert).getByRole('link').getAttribute('href')).toContain(SIGNED_SIGNATURE);
  });

  it('reports a confirmation timeout with the signature', async () => {
    connection.getSignatureStatuses.mockResolvedValue({ context: { slot: 1 }, value: [null] });
    renderPanel({ confirmOptions: { intervalMs: 1, timeoutMs: 30 } });
    await readyToTrade('0.1', /Buy MOON/);
    fireEvent.click(submit());
    const alert = await screen.findByTestId('trade-error');
    expect(alert.getAttribute('data-code')).toBe('confirm_timeout');
    expect(within(alert).getByRole('link').getAttribute('href')).toContain(SIGNED_SIGNATURE);
  });

  it('takes the signature from the signed bytes and finds a trade whose send call failed', async () => {
    connection.sendRawTransaction.mockRejectedValue(new TypeError('Failed to fetch'));
    const onTradeConfirmed = vi.fn();
    renderPanel({ onTradeConfirmed });
    await readyToTrade('0.1', /Buy MOON/);
    fireEvent.click(submit());
    await screen.findByTestId('trade-success');
    expect(onTradeConfirmed).toHaveBeenCalledWith(SIGNED_SIGNATURE);
    expect(connection.getSignatureStatuses).toHaveBeenCalledWith([SIGNED_SIGNATURE], {
      searchTransactionHistory: true,
    });
  });

  it('never builds a second trade while the first one may still land', async () => {
    connection.sendRawTransaction.mockRejectedValue(new TypeError('Failed to fetch'));
    connection.getSignatureStatuses.mockResolvedValue({ context: { slot: 1 }, value: [null] });
    const build = vi.spyOn(core, 'buildBuyTx');
    renderPanel({ confirmOptions: { intervalMs: 1, timeoutMs: 30 } });
    await readyToTrade('0.1', /Buy MOON/);
    fireEvent.click(submit());
    const first = await screen.findByTestId('trade-error');
    expect(first.getAttribute('data-code')).toBe('confirm_timeout');
    expect(within(first).getByRole('link').getAttribute('href')).toContain(SIGNED_SIGNATURE);
    const sends = connection.sendRawTransaction.mock.calls.length;
    // Every attempt re-sent the same signed bytes.
    for (const call of connection.sendRawTransaction.mock.calls) {
      expect(call[0]).toEqual(new Uint8Array([1, 2, 3]));
    }

    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() =>
      expect(screen.getByTestId('trade-error').getAttribute('data-code')).toBe(
        'previous_trade_pending',
      ),
    );
    expect(build).toHaveBeenCalledTimes(1);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction.mock.calls.length).toBe(sends);

    // Once its blockhash expired without the signature landing, a new trade may be built.
    connection.getBlockHeight.mockResolvedValue(101);
    connection.sendRawTransaction.mockResolvedValue('IGNORED');
    connection.getSignatureStatuses.mockImplementation(
      async (_sigs: string[], config?: unknown) => ({
        context: { slot: 1 },
        value: [config ? null : { err: null, confirmationStatus: 'confirmed' }],
      }),
    );
    fireEvent.click(submit());
    await screen.findByTestId('trade-success');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('allows a new trade at once when the node rejected the first in preflight', async () => {
    connection.sendRawTransaction.mockRejectedValueOnce(
      new Error('failed to send transaction: Transaction simulation failed: Blockhash not found'),
    );
    const build = vi.spyOn(core, 'buildBuyTx');
    renderPanel();
    await readyToTrade('0.1', /Buy MOON/);
    fireEvent.click(submit());
    const alert = await screen.findByTestId('trade-error');
    expect(alert.getAttribute('data-code')).toBe('blockhash_expired');
    expect(within(alert).queryByRole('link')).toBeNull();
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await screen.findByTestId('trade-success');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('maps a relay outage while quoting', async () => {
    vi.spyOn(core, 'quoteSwap').mockRejectedValue(new TypeError('Failed to fetch'));
    renderPanel();
    await typeAmount('0.1');
    const alert = await screen.findByTestId('trade-error');
    expect(alert.getAttribute('data-code')).toBe('network');
    expect(submit().textContent).toBe('Quote unavailable');
  });

  it('refuses to trade when the relay is not configured', () => {
    connectionRef.current = null;
    renderPanel();
    expect(screen.getByTestId('trade-not-configured')).toBeTruthy();
    expect(core.calls.graduated).toBe(0);
  });

  it('prevents a second submission while one is in flight', async () => {
    let release: (() => void) | undefined;
    const signer = okSigner();
    wallet.signTransaction = vi.fn(async (tx) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return signer(tx);
    });
    const build = vi.spyOn(core, 'buildBuyTx');
    renderPanel();
    await readyToTrade('0.1', /Buy MOON/);
    fireEvent.click(submit());
    await waitFor(() => expect(submit().disabled).toBe(true));
    fireEvent.click(submit());
    release?.();
    await screen.findByTestId('trade-success');
    expect(build).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('pools of this launchpad only', () => {
  it('trades the pool derived from the mint and the launchpad config, never a prop', async () => {
    const quote = vi.spyOn(core, 'quoteSwap');
    const foreignPool = Keypair.generate().publicKey.toBase58();
    // `pool` is no longer a prop: even passed anyway it is ignored.
    renderPanel({ ...({ pool: foreignPool } as object) });
    await readyToTrade('0.1', /Buy MOON/);
    expect(quote.mock.calls[0]?.[0].pool.toBase58()).toBe(keys.pool);
    expect(quote.mock.calls.some((call) => call[0].pool.toBase58() === foreignPool)).toBe(false);
  });

  it("trades the launchpad's own coin, found on its coin config", async () => {
    const quote = vi.spyOn(core, 'quoteSwap');
    render(
      <TradePanel
        mint={keys.ownMint}
        symbol="PAD"
        quoteDebounceMs={0}
        quoteRefreshMs={0}
        confirmOptions={CONFIRM}
      />,
    );
    await typeAmount('0.1');
    await screen.findByTestId('quote-summary');
    expect(quote.mock.calls[0]?.[0].pool.toBase58()).toBe(keys.ownPool);
  });

  it('refuses a look-alike pool on the launchpad coin config, without any quote', async () => {
    render(<TradePanel mint={keys.lookAlikeMint} symbol="PAD" />);
    expect((await screen.findByTestId('trade-not-on-launchpad')).textContent).toMatch(
      /not on this launchpad/,
    );
    expect(core.calls).toEqual({ quote: 0, buy: 0, sell: 0, graduated: 0 });
  });

  it('refuses a coin with no pool on this launchpad, without any quote', async () => {
    render(<TradePanel mint={Keypair.generate().publicKey.toBase58()} symbol="X" />);
    expect((await screen.findByTestId('trade-not-on-launchpad')).textContent).toMatch(
      /not on this launchpad/,
    );
    expect(core.calls).toEqual({ quote: 0, buy: 0, sell: 0, graduated: 0 });
  });

  it('refuses a derived pool address that is not a DBC account', async () => {
    connection.getAccountInfo.mockImplementation(
      async (address: { toBase58(): string }) =>
        address.toBase58() === keys.pool
          ? { ...poolAccount(), owner: Keypair.generate().publicKey }
          : null,
    );
    renderPanel();
    expect(await screen.findByTestId('trade-not-on-launchpad')).toBeTruthy();
    expect(core.calls.graduated).toBe(0);
  });

  it('reports a relay failure during the pool lookup, and retries', async () => {
    const lookup = accountsByAddress();
    let fail = true;
    connection.getAccountInfo.mockImplementation(async (address: PublicKey) => {
      if (fail && address.toBase58() === keys.pool) throw new TypeError('Failed to fetch');
      return lookup(address);
    });
    renderPanel();
    const alert = await screen.findByTestId('trade-route-error');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('trade-form')).toBeTruthy();
  });
});
