import * as T from 'three';
import { FORGE_ACCENT, FORGE_PRIMARY } from '../engine';
import { acquireMuseTextures, createMuseOrb, releaseMuseTextures, type MuseOrb } from './orb';

/**
 * The full-body FORGE Muse for the dashboard hero: the Nebula orb is its head, over a soft
 * luminous teardrop torso with short rounded arms and legs. Every pose is procedural and
 * integrated with elapsed time, so it plays the same at any frame rate.
 */

export type FigureAction = 'welcome' | 'building' | 'live' | 'idle';

export interface FigureFrame {
  /** World point the head looks at (usually the pointer). */
  look: T.Vector3 | null;
}

export interface MuseFigure {
  root: T.Group;
  head: MuseOrb;
  /** World position of the crafted spark, for effects. */
  sparkPoint: T.Vector3;
  /** Height of the feet above the floor, for the contact shadow. */
  lift(): number;
  setAction(action: FigureAction): void;
  /** Plays the hello wave. */
  wave(): void;
  /** A happy hop, for clicks. */
  hop(): void;
  update(dt: number, frame: FigureFrame): void;
  dispose(): void;
}

const bodyVertex = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
varying float vHeight;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vHeight = world.y;
  vec4 mv = viewMatrix * world;
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const bodyFragment = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uAccent;
uniform float uGlow;
varying vec3 vNormal;
varying vec3 vView;
varying float vHeight;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vView);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  float fres = 1.0 - facing;
  vec3 ink = vec3(0.008, 0.004, 0.03);
  vec3 deep = mix(uPrimary, ink, 0.88);
  // A soft inner light makes the body read as luminous and slightly translucent.
  vec3 col = mix(deep, mix(uPrimary, ink, 0.66), pow(facing, 2.0) * 0.85);
  col += mix(uPrimary, uAccent, 0.5) * smoothstep(1.2, 0.2, vHeight) * 0.05 * uGlow;
  // Soft magenta rim light.
  col += mix(uAccent, vec3(1.0), 0.2) * pow(fres, 2.2) * 0.65 * uGlow;
  // Key light from the upper left.
  vec3 l = normalize(vec3(-0.5, 0.7, 0.6));
  col += mix(uPrimary, vec3(1.0), 0.4) * pow(max(dot(n, normalize(l + v)), 0.0), 36.0) * 0.28;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** An egg that narrows towards the neck: the torso. */
function torsoGeometry(low: boolean) {
  const g = new T.SphereGeometry(1, low ? 24 : 32, low ? 18 : 24);
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const taper = 1 - 0.36 * Math.max(0, y) - 0.06 * Math.max(0, -y);
    p.setXYZ(i, p.getX(i) * taper * 0.3, y * 0.37, p.getZ(i) * taper * 0.26);
  }
  g.computeVertexNormals();
  return g;
}

const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function createMuseFigure(
  o: {
    primary?: string;
    accent?: string;
    low?: boolean;
    still?: boolean;
    random?: () => number;
  } = {},
): MuseFigure {
  const random = o.random ?? Math.random;
  const root = new T.Group();
  root.name = 'muse-figure';
  const hips = new T.Group();
  hips.position.y = 0.42;
  root.add(hips);
  const torso = new T.Group();
  hips.add(torso);

  const material = new T.ShaderMaterial({
    uniforms: {
      uPrimary: { value: new T.Color(o.primary ?? FORGE_PRIMARY) },
      uAccent: { value: new T.Color(o.accent ?? FORGE_ACCENT) },
      uGlow: { value: 1 },
    },
    vertexShader: bodyVertex,
    fragmentShader: bodyFragment,
  });
  const geometries: T.BufferGeometry[] = [];
  const mesh = (geometry: T.BufferGeometry, parent: T.Object3D) => {
    geometries.push(geometry);
    const m = new T.Mesh(geometry, material);
    parent.add(m);
    return m;
  };

  const belly = mesh(torsoGeometry(Boolean(o.low)), torso);
  belly.position.y = 0.2;

  const head = createMuseOrb({
    radius: 0.36,
    primary: o.primary,
    accent: o.accent,
    sparks: 5,
    motes: 16,
    low: o.low,
    still: o.still,
    random,
  });
  head.root.position.y = 0.94;
  torso.add(head.root);

  const limb = new T.CapsuleGeometry(0.058, 0.2, 4, 12);
  const hand = new T.SphereGeometry(0.072, 16, 12);
  const leg = new T.CapsuleGeometry(0.075, 0.12, 4, 12);
  const foot = new T.SphereGeometry(1, 16, 12);
  geometries.push(limb, hand, leg, foot);
  const arms = [-1, 1].map((side) => {
    const shoulder = new T.Group();
    shoulder.position.set(side * 0.255, 0.42, 0);
    torso.add(shoulder);
    const arm = new T.Mesh(limb, material);
    arm.position.y = -0.16;
    shoulder.add(arm);
    const palm = new T.Mesh(hand, material);
    palm.position.y = -0.31;
    shoulder.add(palm);
    return { shoulder, side, palm };
  });
  const legs = [-1, 1].map((side) => {
    const pivot = new T.Group();
    pivot.position.set(side * 0.12, 0, 0);
    hips.add(pivot);
    const thigh = new T.Mesh(leg, material);
    thigh.position.y = -0.16;
    pivot.add(thigh);
    const toe = new T.Mesh(foot, material);
    toe.scale.set(0.095, 0.06, 0.13);
    toe.position.set(0, -0.335, 0.03);
    pivot.add(toe);
    return { pivot, side };
  });

  // The spark the Muse crafts between its hands while a job is building.
  const sparkPoint = new T.Vector3();
  const craftedSpark = new T.Group();
  torso.add(craftedSpark);
  craftedSpark.position.set(0, 0.3, 0.5);
  const tex = acquireMuseTextures();
  const craftMaterial = new T.SpriteMaterial({
    map: tex.spark,
    color: new T.Color(o.accent ?? FORGE_ACCENT).lerp(new T.Color(1, 1, 1), 0.5),
    blending: T.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    opacity: 0,
  });
  const craftSprite = new T.Sprite(craftMaterial);
  craftSprite.renderOrder = 6;
  craftedSpark.add(craftSprite);

  let action: FigureAction = 'idle';
  let time = random() * 10;
  let waveClock = -1;
  let hopClock = -1;
  let celebrateTimer = 1.2;
  let craftWeight = 0,
    pointWeight = 0,
    liveWeight = 0;
  let jump = 0;
  const pose = {
    lz: 0,
    rz: 0,
    lx: 0,
    rx: 0,
  };
  const lookPoint = new T.Vector3();
  const pointTarget = new T.Vector3(3, 1.5, 1.4);

  function hop() {
    if (hopClock < 0) {
      hopClock = 0;
      head.kick(0.25);
    }
  }

  function update(dt: number, frame: FigureFrame) {
    dt = Math.min(0.1, Math.max(0, dt));
    time += dt;
    const k = damp(3.2, dt);
    craftWeight += ((action === 'building' ? 1 : 0) - craftWeight) * k;
    pointWeight += ((action === 'welcome' && waveClock < 0 ? 1 : 0) - pointWeight) * k;
    liveWeight += ((action === 'live' ? 1 : 0) - liveWeight) * k;

    // Hello wave: about 2.4 seconds.
    let waveWeight = 0,
      waveSwing = 0;
    if (waveClock >= 0) {
      waveClock += dt;
      const w = waveClock / 2.4;
      waveWeight = w < 0.18 ? ease(w / 0.18) : w > 0.82 ? ease((1 - w) / 0.18) : 1;
      waveSwing = Math.sin(waveClock * 10) * 0.32;
      if (waveClock >= 2.4) waveClock = -1;
    }

    // Live: a little celebratory hop with a spark burst every few seconds.
    if (action === 'live') {
      celebrateTimer -= dt;
      if (celebrateTimer <= 0) {
        celebrateTimer = 3.4;
        hop();
        head.burst(10, 0.9);
      }
    }
    let celebrate = 0;
    if (hopClock >= 0) {
      hopClock += dt;
      const h = hopClock / 0.7;
      jump = h < 1 ? Math.sin(Math.PI * h) * 0.22 : 0;
      celebrate = h < 1 ? Math.sin(Math.PI * Math.min(1, h * 1.15)) : 0;
      if (h >= 1) {
        hopClock = -1;
        head.kick(-0.7);
      }
    } else jump = 0;

    // Idle: breathing, a slow weight shift and a small arm sway.
    const shift = Math.sin(time * 0.9);
    const sway = Math.sin(time * 1.3);
    root.position.y = jump;
    hips.position.x = shift * 0.025 * (1 - craftWeight * 0.6);
    hips.rotation.z = -shift * 0.035;
    torso.rotation.z = shift * 0.02;
    torso.scale.set(1, 1 + Math.sin(time * 1.6) * 0.018, 1);
    root.rotation.y = pointWeight * 0.32;
    legs.forEach(({ pivot, side }) => {
      pivot.rotation.z = -hips.rotation.z + side * 0.04;
      pivot.rotation.x = jump > 0 ? -jump * 1.2 * (side > 0 ? 1 : 0.8) : 0;
    });

    // Arms: rest, then blend in crafting, pointing, waving and celebrating.
    const craftL = Math.sin(time * 3.2),
      craftR = Math.cos(time * 3.2);
    let lz = -0.2 - sway * 0.06,
      rz = 0.2 + sway * 0.06,
      lx = sway * 0.05,
      rx = -sway * 0.05;
    // Crafting: both hands forward and inward, circling the spark.
    lz += (0.62 + craftL * 0.1 - lz) * craftWeight;
    rz += (-0.62 + craftR * 0.1 - rz) * craftWeight;
    lx += (-1.05 + craftR * 0.16 - lx) * craftWeight;
    rx += (-1.05 + craftL * 0.16 - rx) * craftWeight;
    rz += (1.32 + Math.sin(time * 2) * 0.05 - rz) * pointWeight;
    rx += (-0.35 - rx) * pointWeight;
    const up = Math.max(celebrate, liveWeight * 0.15);
    lz += (-2.5 - lz) * up;
    rz += (2.5 - rz) * up;
    rz += (2.55 + waveSwing - rz) * waveWeight;
    rx += (-0.15 - rx) * waveWeight;
    pose.lz += (lz - pose.lz) * damp(12, dt);
    pose.rz += (rz - pose.rz) * damp(12, dt);
    pose.lx += (lx - pose.lx) * damp(12, dt);
    pose.rx += (rx - pose.rx) * damp(12, dt);
    arms[0]!.shoulder.rotation.set(pose.lx, 0, pose.lz);
    arms[1]!.shoulder.rotation.set(pose.rx, 0, pose.rz);

    // The crafted spark pulses between the hands.
    craftedSpark.position.y = 0.3 + Math.sin(time * 2.4) * 0.03;
    craftSprite.scale.setScalar(0.42 * (0.8 + 0.2 * Math.sin(time * 6)) * craftWeight + 0.001);
    craftMaterial.rotation = time * 1.4;
    craftMaterial.opacity = craftWeight;
    craftedSpark.getWorldPosition(sparkPoint);

    // Where the head looks: the crafted spark, the button it points to, or the pointer.
    head.setMood(action === 'building' ? 'building' : action === 'live' ? 'success' : 'idle');
    if (craftWeight > 0.5) lookPoint.copy(sparkPoint).lerp(frame.look ?? sparkPoint, 0.25);
    else if (pointWeight > 0.5 && !frame.look) lookPoint.copy(pointTarget);
    else if (frame.look) lookPoint.copy(frame.look);
    else lookPoint.set(0, 1.2, 4);
    head.update(dt, { look: lookPoint, maxTurn: 0.6 });
  }

  return {
    root,
    head,
    sparkPoint,
    lift: () => jump,
    setAction(next) {
      if (next === action) return;
      action = next;
      if (next === 'live') celebrateTimer = 0.4;
    },
    wave() {
      waveClock = 0;
    },
    hop,
    update,
    dispose() {
      geometries.forEach((g) => g.dispose());
      material.dispose();
      craftMaterial.dispose();
      head.dispose();
      releaseMuseTextures();
    },
  };
}
