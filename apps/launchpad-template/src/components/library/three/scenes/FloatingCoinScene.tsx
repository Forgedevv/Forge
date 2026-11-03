import { Sparkles } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
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
import { coinFaceTexture, glowTexture, headingFont, reedingTexture } from '../lib/textures';

export interface FloatingCoinSceneProps {
  inView: boolean;
  monogram: string;
  colors?: EffectColors;
  /** Spin speed multiplier. */
  speed: number;
  sparkles: boolean;
}

const RADIUS = 1.15;
const THICKNESS = 0.16;
const STILL_TIME = 1.1;

function Coin({
  theme,
  reduced,
  monogram,
  speed,
  sparkles,
}: Omit<FloatingCoinSceneProps, 'inView' | 'colors'> & SceneState) {
  const element = useThree((state) => state.gl.domElement);
  const pointer = useScenePointer();
  const group = useRef<THREE.Group>(null);
  const dark = isDarkColor(theme.background);

  const textures = useMemo(() => {
    // The cylinder caps are mapped sideways: turn the art upright (the same rotation suits both caps).
    const face = coinFaceTexture(monogram, headingFont(element));
    face.center.set(0.5, 0.5);
    face.rotation = Math.PI / 2;
    return { face, reeding: reedingTexture(), glow: glowTexture() };
  }, [monogram, element]);
  useEffect(
    () => () => {
      for (const texture of Object.values(textures)) texture.dispose();
    },
    [textures],
  );

  const faceColor = threeColor(mixRgb(theme.accent, [1, 1, 1], 0.12));
  const rimColor = threeColor(mixRgb(theme.accent, theme.primary, 0.35));

  useFrame((state, delta) => {
    const g = group.current;
    if (!g) return;
    pointer.update(reduced ? 0 : delta);
    const t = reduced ? STILL_TIME : state.clock.elapsedTime * speed;
    // A slow spin that lingers on the faces.
    g.rotation.y = t * 0.55 + Math.sin(t * 0.55) * 0.45 + pointer.x * 0.35;
    g.rotation.x = Math.sin(t * 0.7) * 0.12 - pointer.y * 0.25;
    g.position.y = Math.sin(t * 1.1) * 0.07;
  });

  return (
    <>
      <StudioLights primary={theme.primary} accent={theme.accent} />
      <group ref={group}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[RADIUS, RADIUS, THICKNESS, 128, 1]} />
          <meshStandardMaterial
            attach="material-0"
            color={rimColor}
            metalness={1}
            roughness={0.32}
            bumpMap={textures.reeding}
            bumpScale={2}
          />
          <meshStandardMaterial
            attach="material-1"
            color={faceColor}
            metalness={0.92}
            roughness={0.24}
            envMapIntensity={1.6}
            map={textures.face}
            bumpMap={textures.face}
            bumpScale={4}
          />
          <meshStandardMaterial
            attach="material-2"
            color={faceColor}
            metalness={0.92}
            roughness={0.24}
            envMapIntensity={1.6}
            map={textures.face}
            bumpMap={textures.face}
            bumpScale={4}
          />
        </mesh>
        {[1, -1].map((side) => (
          <mesh key={side} position={[0, 0, (side * THICKNESS) / 2]}>
            <torusGeometry args={[RADIUS - 0.035, 0.04, 16, 128]} />
            <meshStandardMaterial color={rimColor} metalness={1} roughness={0.22} />
          </mesh>
        ))}
      </group>
      <mesh position={[0, -1.55, -0.4]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[3.2, 1.2]} />
        <meshBasicMaterial
          map={textures.glow}
          color={dark ? threeColor(theme.primary) : new THREE.Color('#000000')}
          transparent
          opacity={dark ? 0.45 : 0.18}
          depthWrite={false}
          blending={dark ? THREE.AdditiveBlending : THREE.NormalBlending}
        />
      </mesh>
      {sparkles && !reduced && (
        <Sparkles
          count={36}
          scale={[4.5, 3.2, 2]}
          size={2.2}
          speed={0.35}
          opacity={dark ? 0.9 : 0.6}
          color={threeColor(theme.accent)}
        />
      )}
    </>
  );
}

/** The floating coin scene; loaded on demand by `FloatingCoin`. */
export function FloatingCoinScene({ inView, colors, ...props }: FloatingCoinSceneProps) {
  const theme = useEffectColors(colors);
  const reduced = useReducedMotion();
  return (
    <SceneCanvas inView={inView} camera={{ position: [0, 0, 5.4], fov: 35 }}>
      <Coin theme={theme} reduced={reduced} {...props} />
    </SceneCanvas>
  );
}
