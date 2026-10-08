import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homeContent as copy } from './content';
import { ForgeHome } from './home';

const scene = vi.hoisted(() => ({
  chapter: (chapter: number) => {
    void chapter;
  },
  fail: () => {},
  goTo: vi.fn(),
  dispose: vi.fn(),
  setPaused: vi.fn(),
  setInteractive: vi.fn(),
  skipIntro: vi.fn(),
}));
vi.mock('./engine', () => ({
  createExperience: (
    _element: HTMLElement,
    options: { onChapter(chapter: number): void; onIntroDone(): void; onFailure(): void },
  ) => {
    scene.chapter = options.onChapter;
    scene.fail = options.onFailure;
    scene.goTo.mockImplementation((chapter: number) => options.onChapter(chapter));
    options.onChapter(0);
    options.onIntroDone();
    return scene;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

async function ready() {
  await waitFor(() => expect(screen.queryByText(copy.loading)).not.toBeInTheDocument());
}

describe('FORGE experience controls', () => {
  it('shows the promise and all six accessible chapter targets', async () => {
    render(<ForgeHome />);
    await ready();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Ideas in. Worlds out.');
    for (const name of copy.chapterNames)
      expect(screen.getByRole('button', { name: new RegExp(name, 'i') })).toBeInTheDocument();
  });

  it('navigates the timeline and announces the newly selected chapter', async () => {
    render(<ForgeHome />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /03 — The workshop/ }));
    expect(scene.goTo).toHaveBeenCalledWith(2, 2);
    expect(screen.getByRole('button', { name: /03 — The workshop/ })).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(screen.getByRole('heading', { level: 2, name: /From a spark/ })).toBeInTheDocument();
  });

  it('announces the chapter the continuous scene progress reaches', async () => {
    const { container } = render(<ForgeHome />);
    await ready();
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live).toHaveTextContent(copy.chapterNames[0]!);
    act(() => scene.chapter(3));
    expect(live).toHaveTextContent(copy.chapterNames[3]!);
    expect(screen.getByRole('button', { name: new RegExp(copy.chapterNames[3]!) })).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('uses a one-second transition for the scroll hint button', async () => {
    render(<ForgeHome />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: copy.scroll }));
    expect(scene.goTo).toHaveBeenCalledWith(1, 1);
  });

  it('opens product details and closes with Escape while restoring focus', async () => {
    render(<ForgeHome />);
    await ready();
    const trigger = screen.getByRole('button', { name: /The details/ });
    trigger.focus();
    fireEvent.click(trigger);
    const modal = screen.getByRole('dialog');
    expect(modal).toHaveTextContent(copy.details.priceDescription);
    expect(scene.setInteractive).toHaveBeenLastCalledWith(false);
    fireEvent(modal, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('explains unavailable wallet connection without simulating authentication', async () => {
    render(<ForgeHome />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: copy.create }));
    expect(screen.getByRole('dialog')).toHaveTextContent(copy.connection.description);
    fireEvent.click(screen.getByRole('button', { name: copy.connection.action }));
    expect(screen.getByRole('dialog')).toHaveTextContent(copy.details.intro);
  });

  it('disables creation when the supplied backend flag pauses signups', async () => {
    render(<ForgeHome flags={{ signupsPaused: true }} />);
    await ready();
    expect(screen.getByRole('status')).toHaveTextContent(copy.paused);
    expect(screen.getByRole('button', { name: copy.create })).toBeDisabled();
    act(() => scene.chapter(5));
    expect(screen.getByRole('button', { name: copy.connect })).toBeDisabled();
  });

  it('pauses the scene and resumes it on request', async () => {
    render(<ForgeHome />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: copy.motionOn }));
    expect(scene.setPaused).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: copy.motionOff }));
    expect(scene.setPaused).toHaveBeenLastCalledWith(false);
  });

  it('replaces a failed WebGL scene with readable content and disposes its resources', async () => {
    render(<ForgeHome />);
    await ready();
    act(() => scene.fail());
    expect(screen.getByRole('status')).toHaveTextContent(copy.fallback);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(5);
    expect(scene.dispose).toHaveBeenCalledOnce();
    expect(screen.getByText(copy.details.priceDescription)).toBeInTheDocument();
  });

  it('honors reduced motion at initialization', async () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    render(<ForgeHome />);
    await ready();
    expect(screen.getByRole('button', { name: copy.motionOff })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
