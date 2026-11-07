import { useReducedMotion as useMotionReducedMotion } from 'motion/react';

/**
 * True when the visitor asked for reduced motion. False during server rendering, so the first paint
 * is the same on the server and the client; effects must still render a calm, complete frame.
 */
export function useReducedMotion(): boolean {
  return useMotionReducedMotion() ?? false;
}
