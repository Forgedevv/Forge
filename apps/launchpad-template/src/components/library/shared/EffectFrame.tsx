import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useInView } from './useInView';
import { canRunWebGL } from './webgl';

interface EffectFrameProps {
  /** Renders the live effect. Receives whether it is on screen, to pause its loop when not. */
  children: (state: { inView: boolean }) => ReactNode;
  /** Shown on the server, before hydration and when WebGL is not usable. */
  fallback?: ReactNode;
  /** Set for WebGL effects: the live effect only mounts when `canRunWebGL()` is true. */
  webgl?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * Box that hosts a canvas effect: it fills its parent, mounts the effect only after hydration (and
 * only when WebGL works, for WebGL effects) and tells it when it is off screen. Purely decorative:
 * hidden from assistive technology and never catches pointer events unless the effect asks for it.
 */
export function EffectFrame({
  children,
  fallback,
  webgl = false,
  className,
  style,
}: EffectFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(webgl ? canRunWebGL() : true);
  }, [webgl]);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn('relative h-full w-full overflow-hidden', className)}
      style={style}
    >
      {ready ? children({ inView }) : fallback}
    </div>
  );
}
