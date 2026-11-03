import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useReducedMotion } from '../../shared';
import { mixRgb, useEffectColors, type EffectColors } from '../../backgrounds/lib/color';
import { SceneCanvas, threeColor, useScenePointer, type SceneState } from '../lib/SceneCanvas';
import { StudioLights } from '../lib/StudioLights';
import { coinFaceTexture, headingFont } from '../lib/textures';

export interface CoinRainSceneProps {
  inView: boolean;
  colors?: EffectColors;
  monogram: string;
  count: number;
  speed: number;
}

const CAMERA_Z = 8;
const HALF_FOV = (20 * Math.PI) / 180;
const STILL_TIME = 4;

interface Drop {
  x: number;
  y: number;
  z: number;
  fall: number;
  spinX: number;
  spinY: number;
  phase: number;
  scale: number;
}

function random(i: number, salt: number): number {
  const n = Math.sin(i * 78.233 + salt * 12.9898) * 43758.5453;
  return n - Math.floor(n);
}

function Rain({
  theme,
  reduced,
  monogram,
  count,
  speed,
}: Omit<CoinRainSceneProps, 'inView' | 'colors'> & SceneState) {
  const pointer = useScenePointer(2);
  const element = useThree((state) => state.gl.domElement);
  const size = useThree((state) => state.size);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const group = useRef<THREE.Group>(null);
  const n = Math.max(6, Math.min(120, Math.round(count)));

  const drops = useMemo<Drop[]>(
    () =>
      Array.from({ length: n }, (_, i) => ({
        x: random(i, 1) * 2 - 1,
        y: random(i, 2) * 2 - 1,
        z: -4 + random(i, 3) * 5.5,
        fall: 0.35 + random(i, 4) * 0.5,
        spinX: (random(i, 5) - 0.5) * 2.4,
        spinY: (random(i, 6) - 0.5) * 3,
        phase: random(i, 7) * Math.PI * 2,
        scale: 0.75 + random(i, 8) * 0.5,
      })),
    [n],
  );

  const resources = useMemo(() => {
    const face = coinFaceTexture(monogram, headingFont(element), 512);
    face.center.set(0.5, 0.5);
    face.rotation = Math.PI / 2;
    const geometry = new THREE.CylinderGeometry(0.4, 0.4, 0.06, 48, 1);
    geometry.rotateX(Math.PI / 2);
    const rim = new THREE.MeshStandardMaterial({ metalness: 0.85, roughness: 0.3 });
    const faceMaterial = new THREE.MeshStandardMaterial({
      metalness: 0.7,
      roughness: 0.32,
      map: face,
      bumpMap: face,
      bumpScale: 2,
      envMapIntensity: 1.5,
    });
    return { face, geometry, materials: [rim, faceMaterial, faceMaterial] };
  }, [monogram, element]);
  useEffect(
    () => () => {
      resources.face.dispose();
      resources.geometry.dispose();
      resources.materials[0]?.dispose();
      resources.materials[1]?.dispose();
    },
    [resources],
  );

  // Each coin gets one of three metal tints taken from the theme.
  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const tints = [
      threeColor(mixRgb(theme.accent, [1, 1, 1], 0.1)),
      threeColor(mixRgb(theme.accent, theme.primary, 0.45)),
      threeColor(mixRgb(theme.primary, [1, 1, 1], 0.2)),
    ];
    for (let i = 0; i < n; i++) m.setColorAt(i, tints[i % 3] ?? tints[0]!);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [theme, n, resources]);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  useFrame((state, delta) => {
    pointer.update(reduced ? 0 : delta);
    const m = mesh.current;
    if (!m) return;
    const t = reduced ? STILL_TIME : STILL_TIME + state.clock.elapsedTime * speed;
    const aspect = size.width / Math.max(1, size.height);
    drops.forEach((d, i) => {
      const halfH = (CAMERA_Z - d.z) * Math.tan(HALF_FOV) + 0.5;
      const halfW = halfH * aspect;
      // Fall from the top, wrap at the bottom.
      const span = halfH * 2;
      const y = halfH - ((((halfH - d.y * halfH + t * d.fall) % span) + span) % span);
      dummy.position.set(d.x * halfW + Math.sin(t * 0.6 + d.phase) * 0.15, y, d.z);
      dummy.rotation.set(t * d.spinX + d.phase, t * d.spinY + d.phase * 0.5, 0.3);
      dummy.scale.setScalar(d.scale);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    if (group.current) {
      group.current.rotation.y = pointer.x * 0.12;
      group.current.rotation.x = -pointer.y * 0.08;
    }
  });

  return (
    <>
      <StudioLights primary={theme.primary} accent={theme.accent} intensity={1.5} />
      <group ref={group}>
        <instancedMesh
          ref={mesh}
          args={[resources.geometry, resources.materials, n]}
          frustumCulled={false}
        />
      </group>
    </>
  );
}

/** The coin rain scene; loaded on demand by `CoinRain`. */
export function CoinRainScene({ inView, colors, ...props }: CoinRainSceneProps) {
  const theme = useEffectColors(colors);
  const reduced = useReducedMotion();
  return (
    <SceneCanvas
      inView={inView}
      camera={{ position: [0, 0, CAMERA_Z], fov: 40 }}
      maxPixelRatio={1.75}
    >
      <Rain theme={theme} reduced={reduced} {...props} />
    </SceneCanvas>
  );
}
