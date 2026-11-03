import { Environment, Lightformer } from '@react-three/drei';
import type { Rgb } from '../../shared';
import { threeColor } from './SceneCanvas';

interface StudioLightsProps {
  primary: Rgb;
  accent: Rgb;
  /** Overall light strength. */
  intensity?: number;
}

/**
 * A small photo studio built in the scene (no HDR file is downloaded): a white softbox above, a ring
 * in the accent colour on one side and a strip in the primary colour on the other, baked once into
 * the environment map that glossy and metal materials reflect, plus a few direct lights.
 */
export function StudioLights({ primary, accent, intensity = 1 }: StudioLightsProps) {
  const p = threeColor(primary);
  const a = threeColor(accent);
  return (
    <>
      <ambientLight intensity={0.35 * intensity} />
      <directionalLight position={[3, 4, 5]} intensity={1.6 * intensity} />
      <pointLight position={[-4, -1, 2]} intensity={6 * intensity} color={a} distance={12} />
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={3 * intensity} position={[0, 5, 2]} scale={[8, 2, 1]} />
        <Lightformer
          form="rect"
          intensity={1.5 * intensity}
          position={[0, -4, 3]}
          scale={[6, 1, 1]}
          color="#d0d0d8"
        />
        <Lightformer
          form="ring"
          intensity={4 * intensity}
          color={a}
          position={[-5, 1, 1]}
          scale={3}
          target={[0, 0, 0]}
        />
        <Lightformer
          form="rect"
          intensity={3 * intensity}
          color={p}
          position={[5, 0, 1]}
          scale={[2, 7, 1]}
          target={[0, 0, 0]}
        />
        <Lightformer form="circle" intensity={2 * intensity} position={[0, 0, 6]} scale={2} />
      </Environment>
    </>
  );
}
