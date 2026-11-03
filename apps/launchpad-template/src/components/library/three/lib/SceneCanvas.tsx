import { Canvas, useThree, type CameraProps } from '@react-three/fiber';
import { useEffect, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { useReducedMotion, type Rgb, type ThemeColors } from '../../shared';
import { easeFactor, trackPointer } from '../../backgrounds/lib/pointer';

/**
 * Theme and motion preference, resolved outside the fiber canvas and passed down as props: the
 * scene re-renders from them instead of reading DOM hooks inside the canvas tree.
 */
export interface SceneState {
  theme: ThemeColors;
  reduced: boolean;
}

interface SceneCanvasProps {
  /** From `EffectFrame`: the render loop runs only while the scene is on screen. */
  inView: boolean;
  camera?: CameraProps;
  /** Highest device pixel ratio. */
  maxPixelRatio?: number;
  children: ReactNode;
}

/**
 * The react-three-fiber canvas used by the 3D scenes: transparent, click-through, capped pixel ratio,
 * rendering continuously only while on screen and not under reduced motion (one frame otherwise, and
 * again whenever the scene's props change). Fiber disposes the scene and the renderer on unmount.
 */
export function SceneCanvas({ inView, camera, maxPixelRatio = 2, children }: SceneCanvasProps) {
  const reduced = useReducedMotion();
  return (
    <Canvas
      dpr={[1, maxPixelRatio]}
      frameloop={inView && !reduced ? 'always' : 'demand'}
      gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
      camera={camera ?? { position: [0, 0, 5], fov: 35 }}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    >
      {children}
    </Canvas>
  );
}

/** A Three colour (linear) from a theme colour (sRGB channels between 0 and 1). */
export function threeColor(rgb: Rgb): THREE.Color {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

export interface ScenePointer {
  /** Eased pointer position over the canvas, -1 to 1 (right and up positive); 0 when away. */
  x: number;
  y: number;
  /** Advances the easing; call once per frame with the frame delta. */
  update(dt: number): void;
}

/**
 * The visitor's pointer over the canvas, read from the window because the canvas does not catch
 * pointer events. Must be used inside `SceneCanvas`.
 */
export function useScenePointer(rate = 3): ScenePointer {
  const element = useThree((state) => state.gl.domElement);
  const ref = useRef<
    ScenePointer & { stop?: () => void; source?: ReturnType<typeof trackPointer> }
  >({
    x: 0,
    y: 0,
    update(dt: number) {
      const source = ref.current.source;
      if (!source) return;
      const rect = element.getBoundingClientRect();
      const inside = source.state.inside && rect.width > 0 && rect.height > 0;
      const tx = inside ? (source.state.x / rect.width) * 2 - 1 : 0;
      const ty = inside ? 1 - (source.state.y / rect.height) * 2 : 0;
      const k = dt <= 0 ? 1 : easeFactor(rate, dt);
      ref.current.x += (tx - ref.current.x) * k;
      ref.current.y += (ty - ref.current.y) * k;
    },
  });
  useEffect(() => {
    const source = trackPointer(element, 40);
    ref.current.source = source;
    return () => {
      source.stop();
      ref.current.source = undefined;
    };
  }, [element]);
  return ref.current;
}
