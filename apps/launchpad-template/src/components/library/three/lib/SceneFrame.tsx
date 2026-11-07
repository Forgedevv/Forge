import { Component, createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { EffectLayer } from '../../backgrounds/lib/CanvasLayer';

/** The static look of the scene being loaded, read by `SceneLoading`. */
const SceneFallbackContext = createContext<ReactNode>(null);

/** `loading` component for `next/dynamic`: shows the scene's fallback while three.js downloads. */
export function SceneLoading() {
  return <>{useContext(SceneFallbackContext)}</>;
}

class SceneBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[visual-library] 3D scene failed, showing its fallback:', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface SceneFrameProps {
  fallback: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: (state: { inView: boolean }) => ReactNode;
}

/**
 * Hosts a lazily loaded 3D scene: the fallback shows on the server, without WebGL, while the scene
 * downloads, and if it fails at runtime (lost context, driver error) instead of breaking the page.
 */
export function SceneFrame({ fallback, className, style, children }: SceneFrameProps) {
  return (
    <EffectLayer
      webgl
      fallback={fallback}
      className={className}
      style={{ containerType: 'size', ...style }}
    >
      {(state) => (
        <SceneFallbackContext.Provider value={fallback}>
          <SceneBoundary fallback={fallback}>{children(state)}</SceneBoundary>
        </SceneFallbackContext.Provider>
      )}
    </EffectLayer>
  );
}
