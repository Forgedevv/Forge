import type { CSSProperties, ReactNode } from 'react';
import { EffectLayer } from './CanvasLayer';
import { useEffectColors, type EffectColors } from './color';
import { ShaderSurface, type ShaderSurfaceProps } from './ShaderSurface';

/** Props shared by every background of the library. */
export interface BackgroundProps {
  /** Colour overrides; by default the effect follows the site theme. */
  colors?: EffectColors;
  className?: string;
  style?: CSSProperties;
}

/** Fills the effect box with a CSS background (the static fallback of an effect). */
export function FallbackFill({
  background,
  children,
}: {
  background: string;
  children?: ReactNode;
}) {
  return <div style={{ position: 'absolute', inset: 0, background }}>{children}</div>;
}

type SurfaceProps = Omit<ShaderSurfaceProps, 'inView' | 'colors' | 'fallback'>;

interface ShaderBackgroundProps extends BackgroundProps, SurfaceProps {
  /** Static CSS look, used on the server, without WebGL and when the shader cannot run. */
  fallback: ReactNode;
}

function LiveSurface({
  colors,
  ...props
}: SurfaceProps & { colors?: EffectColors; inView: boolean; fallback: ReactNode }) {
  const resolved = useEffectColors(colors);
  return <ShaderSurface colors={resolved} {...props} />;
}

/** A full-screen shader background inside an `EffectFrame`, with its CSS fallback. */
export function ShaderBackground({
  colors,
  className,
  style,
  fallback,
  ...surface
}: ShaderBackgroundProps) {
  return (
    <EffectLayer webgl fallback={fallback} className={className} style={style}>
      {({ inView }) => (
        <LiveSurface colors={colors} inView={inView} fallback={fallback} {...surface} />
      )}
    </EffectLayer>
  );
}
