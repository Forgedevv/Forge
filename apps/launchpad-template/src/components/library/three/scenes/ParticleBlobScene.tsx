import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useReducedMotion } from '../../shared';
import { isDarkColor, useEffectColors, type EffectColors } from '../../backgrounds/lib/color';
import { SIMPLEX_3D } from '../lib/glsl';
import { SceneCanvas, threeColor, useScenePointer, type SceneState } from '../lib/SceneCanvas';
import { glowTexture } from '../lib/textures';

export interface ParticleBlobSceneProps {
  inView: boolean;
  colors?: EffectColors;
  /** Number of particles. */
  count: number;
  speed: number;
}

const STILL_TIME = 7;

const VERTEX = /* glsl */ `
${SIMPLEX_3D}
uniform float uTime;
uniform float uPixelRatio;
uniform float uSize;
uniform vec3 uPointerDir;
uniform float uPush;
attribute float aSeed;
varying float vTone;
varying float vAlpha;

void main() {
  vec3 dir = normalize(position);
  // Each particle swirls around the vertical axis, faster near the poles.
  float angle = uTime * (0.12 + aSeed * 0.1) + dir.y * 1.4;
  float c = cos(angle);
  float s = sin(angle);
  dir = vec3(c * dir.x - s * dir.z, dir.y, s * dir.x + c * dir.z);
  float n = simplex3(dir * 1.3 + vec3(0.0, uTime * 0.16, uTime * 0.1));
  float fine = simplex3(dir * 3.2 - uTime * 0.22);
  float radius = 1.0 + n * 0.24 + fine * 0.05;
  // A few particles drift off the surface and come back.
  radius += pow(aSeed, 8.0) * 0.7 * (0.5 + 0.5 * sin(uTime * 0.6 + aSeed * 40.0));
  // The surface swells towards the pointer.
  radius += uPush * pow(max(dot(dir, uPointerDir), 0.0), 6.0) * 0.28;
  vec3 pos = dir * radius;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * (0.55 + aSeed * 0.9) * (3.6 / -mv.z);
  vTone = n * 0.5 + 0.5;
  vec3 facing = normalize(normalMatrix * dir);
  vAlpha = 0.25 + 0.75 * smoothstep(-0.5, 0.7, facing.z);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uAccent;
uniform float uOpacity;
varying float vTone;
varying float vAlpha;

void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.0, 1.0, r);
  a = a * a * vAlpha * uOpacity;
  vec3 col = mix(uPrimary, uAccent, smoothstep(0.35, 0.8, vTone));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

function fibonacciSphere(count: number): { positions: Float32Array; seeds: Float32Array } {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) / count) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = i * golden;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(a) * r;
    const n = Math.sin(i * 12.9898) * 43758.5453;
    seeds[i] = n - Math.floor(n);
  }
  return { positions, seeds };
}

function Blob({
  theme,
  reduced,
  count,
  speed,
}: Omit<ParticleBlobSceneProps, 'inView' | 'colors'> & SceneState) {
  const pointer = useScenePointer(2);
  const pixelRatio = useThree((state) => state.viewport.dpr);
  const group = useRef<THREE.Group>(null);
  const inverse = useMemo(() => new THREE.Quaternion(), []);
  const dark = isDarkColor(theme.background);

  const geometry = useMemo(() => {
    const { positions, seeds } = fibonacciSphere(
      Math.max(1000, Math.min(20000, Math.round(count))),
    );
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    return g;
  }, [count]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: { value: STILL_TIME },
          uPixelRatio: { value: 1 },
          uSize: { value: 4 },
          uPointerDir: { value: new THREE.Vector3(0, 0, 1) },
          uPush: { value: 0 },
          uPrimary: { value: new THREE.Color() },
          uAccent: { value: new THREE.Color() },
          uOpacity: { value: 1 },
        },
      }),
    [],
  );
  const glow = useMemo(() => glowTexture(), []);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      glow.dispose();
    },
    [geometry, material, glow],
  );

  // Theme and mode: colours, blending (light adds up on dark pages, not on light ones).
  useEffect(() => {
    const u = material.uniforms;
    (u.uPrimary?.value as THREE.Color).copy(threeColor(theme.primary));
    (u.uAccent?.value as THREE.Color).copy(threeColor(theme.accent));
    if (u.uOpacity) u.uOpacity.value = dark ? 0.9 : 1;
    material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    material.needsUpdate = true;
  }, [material, theme, dark]);

  useFrame((state, delta) => {
    pointer.update(reduced ? 0 : delta);
    const u = material.uniforms;
    const t = reduced ? STILL_TIME : STILL_TIME + state.clock.elapsedTime * speed;
    if (u.uTime) u.uTime.value = t;
    if (u.uPixelRatio) u.uPixelRatio.value = pixelRatio;
    const push = Math.min(1, Math.hypot(pointer.x, pointer.y) * 1.5);
    if (u.uPush) u.uPush.value = push;
    const g = group.current;
    if (!g) return;
    g.rotation.y = t * 0.08;
    g.rotation.x = Math.sin(t * 0.11) * 0.2;
    // Pointer direction in the blob's own frame, so the swell stays under the pointer.
    inverse.copy(g.quaternion).invert();
    (u.uPointerDir?.value as THREE.Vector3)
      .set(pointer.x, pointer.y, 0.6)
      .normalize()
      .applyQuaternion(inverse);
  });

  return (
    <>
      <sprite scale={[3.4, 3.4, 1]}>
        <spriteMaterial
          map={glow}
          color={threeColor(theme.primary)}
          transparent
          opacity={dark ? 0.35 : 0.22}
          depthWrite={false}
          blending={dark ? THREE.AdditiveBlending : THREE.NormalBlending}
        />
      </sprite>
      <group ref={group}>
        <points geometry={geometry} material={material} />
      </group>
    </>
  );
}

/** The particle blob scene; loaded on demand by `ParticleBlob`. */
export function ParticleBlobScene({ inView, colors, ...props }: ParticleBlobSceneProps) {
  const theme = useEffectColors(colors);
  const reduced = useReducedMotion();
  return (
    <SceneCanvas inView={inView} camera={{ position: [0, 0, 4.6], fov: 40 }}>
      <Blob theme={theme} reduced={reduced} {...props} />
    </SceneCanvas>
  );
}
