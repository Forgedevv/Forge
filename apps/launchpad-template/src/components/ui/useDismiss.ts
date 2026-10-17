import { useEffect, type RefObject } from 'react';

/**
 * Closes a disclosure (menu, popover) while it is open: on Escape (focus goes back to its button),
 * on a press outside both the button and the panel, and when focus leaves them.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  button: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (button.current?.contains(target) === true || panel.current?.contains(target) === true);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      button.current?.focus();
    };
    const onPress = (event: Event) => {
      if (!inside(event.target)) close();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!inside(event.target)) close();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPress);
    document.addEventListener('touchstart', onPress);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPress);
      document.removeEventListener('touchstart', onPress);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, close, button, panel]);
}
