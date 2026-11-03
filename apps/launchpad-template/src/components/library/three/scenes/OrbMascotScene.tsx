import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useReducedMotion } from '../../shared';
import { isDarkColor, useEffectColors, type EffectColors } from '../../backgrounds/lib/color';
import { SceneCanvas, threeColor, useScenePointer, type SceneState } from '../lib/SceneCanvas';
import { glowTexture, sparkTexture } from '../lib/textures';

export interface OrbMascotSceneProps {
  inView: boolean;
  colors?: EffectColors;
  /** Draws a small smile under the eyes. */
  smile: boolean;
  speed: number;
}

const STILL_TIME = 2.2;
const SPARKS = 7;

const VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vLocal;
varying vec3 vView;
void main() {
  vLocal = normal;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

// A glossy orb: deep core, colour shifting towards the rim, slow glowing currents inside, a bounce
// light from below, a bright rim and a soft specular highlight.
const FRAGMENT = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uAccent;
uniform float uTime;
uniform float uDark;
varying vec3 vNormal;
varying vec3 vLocal;
varying vec3 vView;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vView);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  float rim = 1.0 - facing;
  vec3 deep = mix(uPrimary, vec3(0.02, 0.015, 0.05), mix(0.35, 0.6, uDark));
  vec3 col = mix(deep, uPrimary, smoothstep(0.1, 0.85, rim));
  col = mix(col, mix(uPrimary, uAccent, 0.45), smoothstep(0.6, 0.98, rim));
  vec3 o = normalize(vLocal);
  float currents = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float a = uTime * (0.3 + fi * 0.11) + fi * 2.3;
    vec3 c = normalize(vec3(cos(a), sin(a * 0.8 + fi) * 0.6, sin(a)));
    currents += pow(max(dot(o, c), 0.0), 6.0);
  }
  col += mix(uAccent, uPrimary, 0.3) * currents * 0.22;
  col += uAccent * smoothstep(0.0, 0.9, -n.y) * 0.25;
  col += mix(uAccent, vec3(1.0), 0.5) * pow(rim, 3.0) * 0.8;
  vec3 l = normalize(vec3(-0.5, 0.65, 0.6));
  col += vec3(1.0) * pow(max(dot(n, normalize(l + v)), 0.0), 60.0) * 0.6;
  col += vec3(1.0) * smoothstep(0.9, 1.0, dot(n, l)) * 0.12;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

function Mascot({
  theme,
  reduced,
  smile,
  speed,
}: Omit<OrbMascotSceneProps, 'inView' | 'colors'> & SceneState) {
  const pointer = useScenePointer(2.5);
  const dark = isDarkColor(theme.background);
  const body = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const eyes = useRef<THREE.Group>(null);
  const sparks = useRef<THREE.Group>(null);
  const blink = useRef({ next: 2.5, start: -1 });

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          uPrimary: { value: new THREE.Color() },
          uAccent: { value: new THREE.Color() },
          uTime: { value: STILL_TIME },
          uDark: { value: 1 },
        },
      }),
    [],
  );
  const textures = useMemo(() => ({ glow: glowTexture(), spark: sparkTexture() }), []);
  useEffect(
    () => () => {
      material.dispose();
      textures.glow.dispose();
      textures.spark.dispose();
    },
    [material, textures],
  );
  useEffect(() => {
    (material.uniforms.uPrimary?.value as THREE.Color).copy(threeColor(theme.primary));
    (material.uniforms.uAccent?.value as THREE.Color).copy(threeColor(theme.accent));
    if (material.uniforms.uDark) material.uniforms.uDark.value = dark ? 1 : 0;
  }, [material, theme, dark]);

  const eyeColor = useMemo(
    () => new THREE.Color('#ffffff').lerp(threeColor(theme.accent), 0.12),
    [theme],
  );
  const blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;

  useFrame((state, delta) => {
    pointer.update(reduced ? 0 : delta);
    const t = reduced ? STILL_TIME : STILL_TIME + state.clock.elapsedTime * speed;
    if (material.uniforms.uTime) material.uniforms.uTime.value = t;
    if (body.current) {
      body.current.position.y = Math.sin(t * 1.6) * 0.07;
      const squash = Math.sin(t * 3.2) * 0.012;
      body.current.scale.set(1 - squash, 1 + squash, 1 - squash);
    }
    if (head.current) {
      // Looks at the pointer, or glances around when it is away.
      const idleX = Math.sin(t * 0.5) * 0.25;
      const idleY = Math.sin(t * 0.37 + 1) * 0.12;
      const away = Math.max(0, 1 - Math.hypot(pointer.x, pointer.y) * 3);
      head.current.rotation.y = pointer.x * 0.5 + idleX * away;
      head.current.rotation.x = -pointer.y * 0.35 + idleY * away;
    }
    if (eyes.current) {
      const b = blink.current;
      if (!reduced && t > b.next) {
        b.start = t;
        b.next = t + 2.5 + ((t * 7.31) % 3);
      }
      const k = b.start < 0 ? 1 : Math.min(1, Math.abs(t - b.start - 0.08) / 0.08);
      eyes.current.scale.y = reduced ? 1 : Math.max(0.12, k);
    }
    if (sparks.current) {
      sparks.current.rotation.y = t * 0.35;
      sparks.current.children.forEach((child, i) => {
        child.position.y = Math.sin(t * 1.3 + i * 1.7) * 0.18;
        const s = 0.16 + 0.06 * Math.sin(t * 2.4 + i * 2.1);
        child.scale.set(s, s, 1);
      });
    }
  });

  const eyePositions: [number, number, number][] = [
    [-0.3, 0.14, 0.94],
    [0.3, 0.14, 0.94],
  ];

  return (
    <>
      <directionalLight position={[2, 3, 4]} intensity={1.5} />
      <ambientLight intensity={0.6} />
      <sprite scale={[3.6, 3.6, 1]} position={[0, 0, -0.6]}>
        <spriteMaterial
          map={textures.glow}
          color={threeColor(theme.primary)}
          transparent
          opacity={dark ? 0.45 : 0.25}
          depthWrite={false}
          blending={blending}
        />
      </sprite>
      <group ref={body}>
        <group ref={head}>
          <mesh material={material}>
            <sphereGeometry args={[1, 96, 64]} />
          </mesh>
          <group ref={eyes} position={[0, 0.14, 0]}>
            {eyePositions.map(([x, , z]) => (
              <mesh
                key={x}
                position={[x, 0, z]}
                rotation={[0, x * 0.35, 0]}
                scale={[0.75, 1.3, 0.5]}
              >
                <sphereGeometry args={[0.12, 32, 16]} />
                <meshBasicMaterial color={eyeColor} toneMapped={false} />
              </mesh>
            ))}
          </group>
          {smile && (
            <mesh position={[0, -0.2, 0.975]} rotation={[0, 0, Math.PI + Math.PI * 0.15]}>
              <torusGeometry args={[0.12, 0.018, 8, 32, Math.PI * 0.7]} />
              <meshBasicMaterial color={eyeColor} toneMapped={false} />
            </mesh>
          )}
        </group>
      </group>
      <group ref={sparks} rotation={[0.35, 0, 0.2]}>
        {Array.from({ length: SPARKS }, (_, i) => {
          const a = (i / SPARKS) * Math.PI * 2;
          return (
            <sprite key={i} position={[Math.cos(a) * 1.65, 0, Math.sin(a) * 1.65]}>
              <spriteMaterial
                map={textures.spark}
                color={threeColor(i % 2 ? theme.accent : theme.primary)}
                transparent
                depthWrite={false}
                blending={blending}
              />
            </sprite>
          );
        })}
      </group>
      <mesh position={[0, -1.45, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[2.6, 2.6]} />
        <meshBasicMaterial
          map={textures.glow}
          color={dark ? threeColor(theme.primary) : new THREE.Color('#000000')}
          transparent
          opacity={dark ? 0.35 : 0.15}
          depthWrite={false}
          blending={blending}
        />
      </mesh>
    </>
  );
}

/** The orb mascot scene; loaded on demand by `OrbMascot`. */
export function OrbMascotScene({ inView, colors, ...props }: OrbMascotSceneProps) {
  const theme = useEffectColors(colors);
  const reduced = useReducedMotion();
  return (
    <SceneCanvas inView={inView} camera={{ position: [0, 0.25, 5.6], fov: 35 }}>
      <Mascot theme={theme} reduced={reduced} {...props} />
    </SceneCanvas>
  );
}
