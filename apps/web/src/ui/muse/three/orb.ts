import * as T from 'three';
import { FORGE_ACCENT, FORGE_PRIMARY } from '../engine';
import { isHexColor } from '../paint';
import { createGlowTexture, createSparkTexture } from './textures';

/**
 * The Muse head in 3D: a Nebula orb with a deep violet core, a fresnel rim, a soft inner
 * swirl, an additive glow, two emissive eyes placed on the sphere, an orbit of four-point
 * sparks and drifting motes. Shared by the homepage scene and the dashboard hero.
 */

export type OrbMood = 'idle' | 'building' | 'waiting_approval' | 'success';

export interface MuseOrbOptions {
  radius?: number;
  primary?: string | null;
  accent?: string | null;
  sparks?: number;
  motes?: number;
  /** Lower tessellation for small background Muses. */
  low?: boolean;
  /** Strength of the eye and rim emission; raise it under bloom. */
  emission?: number;
  random?: () => number;
  /** Reduced motion: no blinks or bursts. */
  still?: boolean;
}

export interface OrbFrame {
  /** World point to look at; `null` keeps looking ahead. */
  look: T.Vector3 | null;
  /** Largest head turn towards the look target, in radians. */
  maxTurn?: number;
  /** 0 to 1: extra glow, for example in a dark chapter. */
  boost?: number;
}

export interface MuseOrb {
  /** Add this to the scene; its origin is the orb center. */
  root: T.Group;
  /** The squash-and-stretch body (core, eyes). */
  body: T.Group;
  setMood(mood: OrbMood): void;
  setColors(primary?: string | null, accent?: string | null): void;
  /** Squash impulse; negative values squash, positive values stretch. */
  kick(amount: number): void;
  burst(count?: number, power?: number): void;
  update(dt: number, frame: OrbFrame): void;
  dispose(): void;
}

const MOOD: Record<
  OrbMood,
  { glow: number; orbit: number; tint: string | null; tintAmt: number; star: number }
> = {
  idle: { glow: 1, orbit: 0.55, tint: null, tintAmt: 0, star: 0 },
  building: { glow: 1.08, orbit: 3.2, tint: '#C99B7E', tintAmt: 0.14, star: 0 },
  waiting_approval: { glow: 1.05, orbit: 0.8, tint: '#D0CDBD', tintAmt: 0.12, star: 0 },
  success: { glow: 1.16, orbit: 1.8, tint: '#EAE6DC', tintAmt: 0.18, star: 1 },
};

const coreVertex = /* glsl */ `
varying vec3 vNormal;
varying vec3 vObjectNormal;
varying vec3 vView;
void main() {
  vObjectNormal = normal;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const coreFragment = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uAccent;
uniform float uTime;
uniform float uGlow;
uniform float uEmission;
varying vec3 vNormal;
varying vec3 vObjectNormal;
varying vec3 vView;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vView);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  float fres = 1.0 - facing;
  vec3 ink = vec3(0.012, 0.017, 0.021);
  vec3 core = mix(uPrimary, ink, 0.66);
  vec3 col = mix(core, mix(uPrimary, ink, 0.3), smoothstep(0.15, 0.8, fres));
  col = mix(col, mix(uPrimary, uAccent, 0.3), smoothstep(0.55, 0.95, fres));
  // Soft inner swirl: three slow blobs moving on the sphere, kept towards the rim.
  vec3 o = normalize(vObjectNormal);
  float swirl = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float a = uTime * (0.35 + fi * 0.12) + fi * 2.1;
    vec3 b = normalize(vec3(cos(a), sin(a * 0.7 + fi) * 0.55, sin(a)));
    swirl += pow(max(dot(o, b), 0.0), 5.0) * (fi == 1.0 ? 0.6 : 1.0);
  }
  float ripple = sin(o.x * 7.0 + uTime * 0.8) * sin(o.y * 6.0 - uTime * 1.1) * sin(o.z * 5.0 + uTime * 0.6);
  col += mix(uAccent, uPrimary, 0.35) * (swirl * 0.16 + max(ripple, 0.0) * 0.05) * uGlow * (0.25 + fres);
  // Bounce light from below.
  col += uAccent * smoothstep(0.1, -0.95, n.y) * 0.22 * uGlow;
  // Fresnel rim.
  col += mix(uAccent, vec3(1.0), 0.4) * pow(fres, 2.6) * 0.95 * uGlow * uEmission;
  // Specular highlight, upper left.
  vec3 l = normalize(vec3(-0.45, 0.6, 0.65));
  float spec = pow(max(dot(n, normalize(l + v)), 0.0), 48.0);
  col += vec3(1.0) * spec * 0.55;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Converts a hex color to a linear Three color, falling back to `fallback`. */
function color(value: string | null | undefined, fallback: string) {
  return new T.Color(isHexColor(value) ? value : fallback);
}

let sharedTextures: { glow: T.Texture; spark: T.Texture; users: number } | null = null;
/** The shared glow and spark textures; pair every call with `releaseMuseTextures`. */
export function acquireMuseTextures() {
  sharedTextures ??= { glow: createGlowTexture(), spark: createSparkTexture(), users: 0 };
  sharedTextures.users++;
  return sharedTextures;
}
export function releaseMuseTextures() {
  if (!sharedTextures) return;
  sharedTextures.users--;
  if (sharedTextures.users <= 0) {
    sharedTextures.glow.dispose();
    sharedTextures.spark.dispose();
    sharedTextures = null;
  }
}

const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export function createMuseOrb(o: MuseOrbOptions = {}): MuseOrb {
  const r = o.radius ?? 1;
  const random = o.random ?? Math.random;
  const emission = o.emission ?? 1;
  const tex = acquireMuseTextures();
  const base1 = color(o.primary, FORGE_PRIMARY),
    base2 = color(o.accent, FORGE_ACCENT);
  const c1 = base1.clone(),
    c2 = base2.clone();
  const white = new T.Color(1, 1, 1);

  const root = new T.Group();
  root.name = 'muse-orb';
  const body = new T.Group();
  root.add(body);
  const face = new T.Group();
  body.add(face);

  const coreMaterial = new T.ShaderMaterial({
    uniforms: {
      uPrimary: { value: c1 },
      uAccent: { value: c2 },
      uTime: { value: random() * 50 },
      uGlow: { value: 1 },
      uEmission: { value: emission },
    },
    vertexShader: coreVertex,
    fragmentShader: coreFragment,
  });
  const core = new T.Mesh(new T.SphereGeometry(r, o.low ? 28 : 48, o.low ? 20 : 32), coreMaterial);
  core.castShadow = true;
  body.add(core);

  // Additive glow around the silhouette; the sphere hides its center through the depth test.
  const glowMaterial = new T.SpriteMaterial({
    map: tex.glow,
    color: c1.clone().lerp(c2, 0.45),
    blending: T.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    opacity: 0.55,
  });
  const glow = new T.Sprite(glowMaterial);
  glow.scale.setScalar(r * 5);
  glow.renderOrder = 2;
  root.add(glow);

  // Eyes: flattened ellipsoids that sit on the sphere; turning the face moves them over it.
  const eyeMaterial = new T.MeshBasicMaterial({ color: new T.Color(1, 1, 1) });
  const eyeGeometry = new T.SphereGeometry(1, 20, 14);
  const starMaterial = new T.MeshBasicMaterial({
    map: tex.spark,
    color: new T.Color(1, 1, 1),
    transparent: true,
    depthWrite: false,
    opacity: 0,
  });
  const starGeometry = new T.PlaneGeometry(1, 1);
  const eyeGlowMaterial = new T.SpriteMaterial({
    map: tex.glow,
    color: white.clone().lerp(c2, 0.35),
    blending: T.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    opacity: 0.35,
  });
  const eyes = [-1, 1].map((side) => {
    const socket = new T.Group();
    socket.rotation.set(-0.04, side * 0.35, 0, 'YXZ');
    face.add(socket);
    const eye = new T.Mesh(eyeGeometry, eyeMaterial);
    eye.position.z = r * 0.975;
    eye.scale.set(r * 0.1, r * 0.155, r * 0.04);
    socket.add(eye);
    const star = new T.Mesh(starGeometry, starMaterial);
    star.position.z = r * 1.012;
    star.scale.setScalar(r * 0.5);
    socket.add(star);
    const halo = new T.Sprite(eyeGlowMaterial);
    halo.position.z = r * 1.04;
    halo.scale.setScalar(r * 0.55);
    halo.renderOrder = 3;
    socket.add(halo);
    return { eye, star, side };
  });

  // Orbiting four-point sparks on a tilted ring.
  const ring = new T.Group();
  ring.rotation.set(0.32, 0, -0.3);
  root.add(ring);
  const sparkCount = o.sparks ?? 5;
  const sparks = Array.from({ length: sparkCount }, () => {
    const material = new T.SpriteMaterial({
      map: tex.spark,
      color: c2.clone().lerp(white, 0.45),
      blending: T.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new T.Sprite(material);
    sprite.renderOrder = 4;
    ring.add(sprite);
    return { sprite, material };
  });

  // Drifting motes.
  const moteCount = o.motes ?? 18;
  const motes = Array.from({ length: moteCount }, () => ({
    a: random() * Math.PI * 2,
    r: r * (1.2 + random() * 0.75),
    y: (random() - 0.5) * r * 1.6,
    s: (0.12 + random() * 0.3) * (random() < 0.5 ? -1 : 1),
    ph: random() * Math.PI * 2,
  }));
  const motePositions = new Float32Array(Math.max(1, moteCount) * 3);
  const moteGeometry = new T.BufferGeometry();
  moteGeometry.setAttribute('position', new T.BufferAttribute(motePositions, 3));
  const moteMaterial = new T.PointsMaterial({
    map: tex.glow,
    color: c2.clone().lerp(white, 0.35),
    size: r * 0.09,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: T.AdditiveBlending,
  });
  const moteCloud = new T.Points(moteGeometry, moteMaterial);
  moteCloud.visible = moteCount > 0;
  moteCloud.frustumCulled = false;
  root.add(moteCloud);

  // A small pool of burst sparks for celebrations and pokes.
  const burstPool = Array.from({ length: 14 }, () => {
    const material = new T.SpriteMaterial({
      map: tex.spark,
      color: c2.clone().lerp(white, 0.5),
      blending: T.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    const sprite = new T.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 5;
    root.add(sprite);
    return { sprite, material, v: new T.Vector3(), age: 0, life: 0 };
  });

  let mood: OrbMood = 'idle';
  const state = { glow: 1, orbit: 0.55, star: 0 };
  let time = coreMaterial.uniforms.uTime!.value as number;
  let phase = random() * Math.PI * 2;
  let yaw = 0,
    pitch = 0;
  let q = 0,
    qv = 0;
  let blink = 1,
    blinkClock = 0,
    nextBlink = 1 + random() * 2,
    doubleBlink = 0;
  const tint = new T.Color();
  const target1 = new T.Color(),
    target2 = new T.Color();
  const local = new T.Vector3();

  function targets() {
    const m = MOOD[mood];
    target1.copy(base1);
    target2.copy(base2);
    if (m.tint) {
      tint.set(m.tint);
      target1.lerp(tint, m.tintAmt);
      target2.lerp(tint, m.tintAmt * 0.75);
    }
  }
  targets();

  function burst(count = 10, power = 1) {
    if (o.still) return;
    let started = 0;
    for (const p of burstPool) {
      if (started >= count) break;
      if (p.sprite.visible) continue;
      const a = random() * Math.PI * 2,
        b = (random() - 0.5) * Math.PI * 0.8;
      p.v.set(Math.cos(a) * Math.cos(b), Math.sin(b) + 0.3, Math.sin(a) * Math.cos(b));
      p.v.multiplyScalar(r * (1.6 + random() * 2) * power);
      p.sprite.position.copy(p.v).setLength(r * 0.9);
      p.age = 0;
      p.life = 0.7 + random() * 0.5;
      p.sprite.visible = true;
      started++;
    }
  }

  function update(dt: number, frame: OrbFrame) {
    dt = Math.min(0.1, Math.max(0, dt));
    time += dt;
    const m = MOOD[mood];
    const k = damp(4, dt);
    state.glow += (m.glow * (1 + (frame.boost ?? 0) * 0.35) - state.glow) * k;
    state.orbit += (m.orbit - state.orbit) * k;
    state.star += (m.star - state.star) * damp(7, dt);
    const kc = damp(3.5, dt);
    c1.lerp(target1, kc);
    c2.lerp(target2, kc);
    const u = coreMaterial.uniforms;
    u.uTime!.value = time;
    u.uGlow!.value = state.glow;
    glowMaterial.color.copy(c1).lerp(c2, 0.45);
    glowMaterial.opacity = 0.42 * Math.min(1.6, state.glow);
    eyeGlowMaterial.color.copy(white).lerp(c2, 0.35);

    // Look: turn the face towards the target, within the allowed range.
    let tYaw = 0,
      tPitch = 0;
    if (frame.look) {
      local.copy(frame.look);
      body.updateWorldMatrix(true, false);
      body.worldToLocal(local);
      const max = frame.maxTurn ?? 0.75;
      tYaw = Math.max(-max, Math.min(max, Math.atan2(local.x, local.z)));
      tPitch = Math.max(-0.5, Math.min(0.5, -Math.atan2(local.y, Math.hypot(local.x, local.z))));
    }
    const kl = damp(6, dt);
    yaw += (tYaw - yaw) * kl;
    pitch += (tPitch - pitch) * kl;
    face.rotation.set(pitch, yaw, 0, 'YXZ');

    // Jelly squash and stretch, sub-stepped.
    let rem = dt;
    while (rem > 1e-6) {
      const h = Math.min(rem, 1 / 240);
      qv += (-180 * q - 10 * qv) * h;
      q += qv * h;
      rem -= h;
    }
    q = Math.max(-0.35, Math.min(0.35, q));
    const breathe = 1 + Math.sin(time * 1.6) * 0.022;
    body.scale.set(breathe * (1 - q * 0.7), breathe * (1 + q), breathe * (1 - q * 0.7));

    // Blinks every 3 to 6 seconds, sometimes twice.
    if (!o.still) nextBlink -= dt;
    if (nextBlink <= 0) {
      blinkClock = 0.22;
      if (random() < 0.22) doubleBlink = 0.32;
      nextBlink = 3 + random() * 3;
    }
    if (doubleBlink > 0) {
      doubleBlink -= dt;
      if (doubleBlink <= 0) blinkClock = 0.22;
    }
    if (blinkClock > 0) {
      blinkClock = Math.max(0, blinkClock - dt);
      const p = 1 - blinkClock / 0.22;
      blink = p < 0.32 ? 1 - p / 0.32 : (p - 0.32) / 0.68;
      blink = Math.max(0.06, blink);
    } else blink = 1;
    const star = state.star;
    for (const e of eyes) {
      e.eye.scale.set(r * 0.1, r * 0.155 * blink * (1 - star * 0.85) + r * 0.004, r * 0.04);
      e.eye.visible = star < 0.97;
      e.star.scale.setScalar(r * 1.15 * star * (1 + 0.07 * Math.sin(time * 5 + e.side)));
      e.star.rotation.z = Math.sin(time * 1.5 + e.side) * 0.12;
      e.star.visible = star > 0.02;
    }
    starMaterial.opacity = star;
    eyeMaterial.color.setRGB(emission * 1.1, emission * 1.08, emission * 1.15);

    // Orbit.
    phase += dt * state.orbit;
    sparks.forEach(({ sprite, material }, i) => {
      const th = phase + (i * Math.PI * 2) / sparkCount;
      const a = r * 1.62;
      sprite.position.set(
        Math.cos(th) * a,
        Math.sin(time * 2 + i * 1.7) * r * 0.05,
        Math.sin(th) * a,
      );
      const twinkle = 0.86 + 0.14 * Math.sin(time * 4 + i * 2.1);
      sprite.scale.setScalar(r * 0.42 * twinkle);
      material.rotation = Math.sin(time * 0.8 + i) * 0.25;
      material.color.copy(c2).lerp(white, 0.45);
      material.opacity = Math.min(1, 0.75 * Math.min(1.3, state.glow));
    });
    motes.forEach((mote, i) => {
      mote.a += mote.s * dt * (0.35 + state.orbit * 0.22);
      motePositions[i * 3] = Math.cos(mote.a) * mote.r;
      motePositions[i * 3 + 1] = mote.y + Math.sin(time * 0.9 + mote.ph) * r * 0.08;
      motePositions[i * 3 + 2] = Math.sin(mote.a) * mote.r;
    });
    if (moteCount) moteGeometry.attributes.position!.needsUpdate = true;
    moteMaterial.color.copy(c2).lerp(white, 0.35);

    for (const p of burstPool) {
      if (!p.sprite.visible) continue;
      p.age += dt;
      const kk = p.age / p.life;
      if (kk >= 1) {
        p.sprite.visible = false;
        continue;
      }
      const drag = Math.exp(-2.6 * dt);
      p.v.multiplyScalar(drag);
      p.v.y -= r * 0.6 * dt;
      p.sprite.position.addScaledVector(p.v, dt);
      p.sprite.scale.setScalar(r * 0.32 * (1 - kk * 0.4));
      p.material.opacity = kk < 0.15 ? kk / 0.15 : 1 - (kk - 0.15) / 0.85;
      p.material.color.copy(c2).lerp(white, 0.5);
    }
  }

  return {
    root,
    body,
    setMood(next) {
      if (next === mood) return;
      mood = next;
      targets();
      qv += next === 'success' ? -4 : -2.6;
      if (next === 'success') burst(14, 1.1);
    },
    setColors(primary, accent) {
      base1.copy(color(primary, FORGE_PRIMARY));
      base2.copy(color(accent, FORGE_ACCENT));
      targets();
    },
    kick(amount) {
      qv += amount * 6;
    },
    burst,
    update,
    dispose() {
      core.geometry.dispose();
      coreMaterial.dispose();
      glowMaterial.dispose();
      eyeMaterial.dispose();
      eyeGeometry.dispose();
      starMaterial.dispose();
      starGeometry.dispose();
      eyeGlowMaterial.dispose();
      sparks.forEach(({ material }) => material.dispose());
      burstPool.forEach(({ material }) => material.dispose());
      moteGeometry.dispose();
      moteMaterial.dispose();
      releaseMuseTextures();
    },
  };
}
