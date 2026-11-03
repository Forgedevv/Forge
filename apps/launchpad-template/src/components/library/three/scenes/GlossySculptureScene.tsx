import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { useReducedMotion } from '../../shared';
import {
  isDarkColor,
  mixRgb,
  useEffectColors,
  type EffectColors,
} from '../../backgrounds/lib/color';
import { SceneCanvas, threeColor, useScenePointer, type SceneState } from '../lib/SceneCanvas';
import { StudioLights } from '../lib/StudioLights';

export type SculptureShape = 'knot' | 'torus' | 'gem';

export interface GlossySculptureSceneProps {
  inView: boolean;
  colors?: EffectColors;
  shape: SculptureShape;
  speed: number;
}

const STILL_TIME = 3;

function Geometry({ shape }: { shape: SculptureShape }) {
  if (shape === 'torus') return <torusGeometry args={[0.95, 0.42, 96, 192]} />;
  if (shape === 'gem') return <icosahedronGeometry args={[1.25, 0]} />;
  return <torusKnotGeometry args={[0.82, 0.3, 320, 48, 2, 3]} />;
}

function Sculpture({
  theme,
  reduced,
  shape,
  speed,
}: Omit<GlossySculptureSceneProps, 'inView' | 'colors'> & SceneState) {
  const pointer = useScenePointer(2);
  const group = useRef<THREE.Group>(null);
  const dark = isDarkColor(theme.background);
  const body = threeColor(mixRgb(theme.primary, dark ? [0, 0, 0] : [1, 1, 1], dark ? 0.15 : 0.1));
  const sheen = threeColor(theme.accent);

  useFrame((state, delta) => {
    pointer.update(reduced ? 0 : delta);
    const t = reduced ? STILL_TIME : STILL_TIME + state.clock.elapsedTime * speed;
    const g = group.current;
    if (!g) return;
    g.rotation.x = 0.35 + Math.sin(t * 0.21) * 0.25 - pointer.y * 0.3;
    g.rotation.y = t * 0.22 + pointer.x * 0.45;
    g.rotation.z = Math.sin(t * 0.17) * 0.15;
    g.position.y = Math.sin(t * 0.9) * 0.08;
  });

  return (
    <>
      <StudioLights primary={theme.primary} accent={theme.accent} intensity={1.1} />
      <group ref={group}>
        <mesh key={shape}>
          <Geometry shape={shape} />
          <meshPhysicalMaterial
            color={body}
            metalness={shape === 'gem' ? 0.1 : 0.35}
            roughness={shape === 'gem' ? 0.05 : 0.14}
            clearcoat={1}
            clearcoatRoughness={0.06}
            iridescence={0.85}
            iridescenceIOR={1.35}
            iridescenceThicknessRange={[180, 620]}
            sheen={0.6}
            sheenColor={sheen}
            envMapIntensity={1.3}
            flatShading={shape === 'gem'}
          />
        </mesh>
      </group>
    </>
  );
}

/** The glossy sculpture scene; loaded on demand by `GlossySculpture`. */
export function GlossySculptureScene({ inView, colors, ...props }: GlossySculptureSceneProps) {
  const theme = useEffectColors(colors);
  const reduced = useReducedMotion();
  return (
    <SceneCanvas inView={inView} camera={{ position: [0, 0, 6.6], fov: 35 }}>
      <Sculpture theme={theme} reduced={reduced} {...props} />
    </SceneCanvas>
  );
}
