import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import { EffectFrame } from '../../shared';

/** Style of a canvas that fills its effect box. */
export const FILL_CANVAS_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  display: 'block',
};

/** A canvas filling the effect box. */
export const FillCanvas = forwardRef<HTMLCanvasElement>(function FillCanvas(_props, ref) {
  return <canvas ref={ref} style={FILL_CANVAS_STYLE} />;
});

interface EffectLayerProps {
  children: (state: { inView: boolean }) => ReactNode;
  fallback?: ReactNode;
  webgl?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * `EffectFrame` stretched over its positioned parent, click-through: how every background of the
 * library sits behind the content of a section.
 */
export function EffectLayer({ children, fallback, webgl, className, style }: EffectLayerProps) {
  return (
    <EffectFrame
      webgl={webgl}
      fallback={fallback}
      className={className}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', ...style }}
    >
      {children}
    </EffectFrame>
  );
}
