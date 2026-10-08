import * as T from 'three';
import { acquireMuseTextures, createMuseOrb, releaseMuseTextures, type MuseOrb } from './orb';
import { createMuseFigure, type FigureAction } from './figure';

/**
 * The dashboard hero: the full-body FORGE Muse on a dark violet floor, with a light pool, a
 * contact shadow, a few floating sparks, and the user's own launchpad Muses hovering around
 * it in their theme colors. One canvas; it pauses offscreen and in hidden tabs, and draws a
 * single static pose under reduced motion.
 */

export interface HeroMuse {
  id: string;
  primary: string | null;
  accent: string | null;
}

export interface HeroOptions {
  action: FigureAction;
  muses: HeroMuse[];
  reduced: boolean;
}

export interface HeroHandle {
  setAction(action: FigureAction): void;
  setMuses(muses: HeroMuse[]): void;
  /** A click on the scene: the Muse hops. */
  poke(): void;
  dispose(): void;
}

/** Most launchpad Muses shown around the FORGE Muse. */
export const HERO_MAX_MUSES = 6;
const SATELLITE_HEIGHTS = [0.55, 1.15, 0.8, 1.4, 0.65, 1.0];

const floorVertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const floorFragment = /* glsl */ `
uniform vec3 uFloor;
uniform vec3 uPool;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float pool = exp(-d * d * 7.0);
  vec3 col = mix(uFloor, uPool, pool * 0.75);
  float alpha = smoothstep(1.0, 0.55, d);
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}`;

interface Satellite {
  id: string;
  orb: MuseOrb;
  angle: number;
  radius: number;
  height: number;
  bob: number;
}

export function createHeroScene(container: HTMLElement, options: HeroOptions): HeroHandle {
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  try {
    return build(container, options, renderer);
  } catch (error) {
    renderer.dispose();
    renderer.domElement.remove();
    throw error;
  }
}

function build(container: HTMLElement, options: HeroOptions, renderer: T.WebGLRenderer) {
  const reduced = options.reduced;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  renderer.domElement.className = 'muse-hero-canvas';
  container.append(renderer.domElement);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(30, 1, 0.1, 40);
  const cameraTarget = new T.Vector3(0, 0.82, 0);
  camera.position.set(0, 1.12, 5.6);
  camera.lookAt(cameraTarget);
  const tex = acquireMuseTextures();

  const floorMaterial = new T.ShaderMaterial({
    uniforms: {
      uFloor: { value: new T.Color('#140f2a') },
      uPool: { value: new T.Color('#3b2378') },
    },
    vertexShader: floorVertex,
    fragmentShader: floorFragment,
    transparent: true,
    depthWrite: false,
  });
  const floor = new T.Mesh(new T.PlaneGeometry(7, 7), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.renderOrder = -2;
  scene.add(floor);

  const shadowMaterial = new T.MeshBasicMaterial({
    map: tex.glow,
    color: new T.Color('#05030d'),
    transparent: true,
    depthWrite: false,
    opacity: 0.8,
  });
  const shadow = new T.Mesh(new T.PlaneGeometry(1, 1), shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.004;
  shadow.renderOrder = -1;
  scene.add(shadow);

  const figure = createMuseFigure({ still: reduced });
  figure.setAction(options.action);
  scene.add(figure.root);

  // A few floating four-point sparks.
  const floaters = Array.from({ length: 7 }, (_, i) => {
    const material = new T.SpriteMaterial({
      map: tex.spark,
      color: new T.Color(i % 2 ? '#ff8be6' : '#c4a6ff'),
      blending: T.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new T.Sprite(material);
    const a = (i / 7) * Math.PI * 2 + 0.4;
    const base = new T.Vector3(
      Math.cos(a) * (1.9 + (i % 3) * 0.35),
      0.4 + ((i * 0.37) % 1.6),
      Math.sin(a) * 1.4 - 0.6,
    );
    scene.add(sprite);
    return { sprite, material, base, phase: i * 1.7, size: 0.1 + (i % 3) * 0.04 };
  });

  // The user's own Muses, hovering around the FORGE Muse.
  let satellites: Satellite[] = [];
  function setMuses(muses: HeroMuse[]) {
    const list = muses.slice(0, HERO_MAX_MUSES);
    const keep = new Map(satellites.map((s) => [s.id, s]));
    const next: Satellite[] = [];
    list.forEach((muse, i) => {
      let s = keep.get(muse.id);
      if (s) {
        keep.delete(muse.id);
        s.orb.setColors(muse.primary, muse.accent);
      } else {
        const orb = createMuseOrb({
          radius: 0.13,
          primary: muse.primary,
          accent: muse.accent,
          sparks: 3,
          motes: 0,
          low: true,
          still: reduced,
        });
        scene.add(orb.root);
        s = { id: muse.id, orb, angle: 0, radius: 0, height: 0, bob: i * 1.3 };
      }
      s.angle = (i / Math.max(1, list.length)) * Math.PI * 2 + 0.9;
      s.radius = 1.45 + (i % 2) * 0.25;
      s.height = SATELLITE_HEIGHTS[i % SATELLITE_HEIGHTS.length]!;
      next.push(s);
    });
    keep.forEach((s) => {
      scene.remove(s.orb.root);
      s.orb.dispose();
    });
    satellites = next;
    requestDraw();
  }

  // Pointer, in world space on a plane in front of the Muse.
  const pointer = { x: 0, y: 0, active: false };
  const look = new T.Vector3();
  function onPointer(event: PointerEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointer.x = Math.max(-1.5, Math.min(1.5, ((event.clientX - rect.left) / rect.width) * 2 - 1));
    pointer.y = Math.max(-1.5, Math.min(1.5, -((event.clientY - rect.top) / rect.height) * 2 + 1));
    pointer.active = true;
  }
  function onLeave(event: MouseEvent) {
    if (!event.relatedTarget) pointer.active = false;
  }

  let width = 0,
    height = 0;
  function resize() {
    const w = Math.max(1, container.clientWidth),
      h = Math.max(1, container.clientHeight);
    if (w === width && h === height) return;
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the whole group in frame on narrow cards.
    camera.fov = w / h < 1.1 ? 36 : 30;
    camera.updateProjectionMatrix();
    requestDraw();
  }

  let time = 0;
  function step(dt: number) {
    time += dt;
    look.set(pointer.x * 1.6, 1.2 + pointer.y * 0.9, 3.2);
    figure.update(dt, { look: pointer.active ? look : null });
    const lift = figure.lift();
    shadow.scale.setScalar(1.25 * (1 - lift * 1.2));
    shadowMaterial.opacity = 0.8 * (1 - lift * 1.6);
    camera.getWorldPosition(look);
    look.x += pointer.x * 1.2;
    look.y += pointer.y * 0.8;
    satellites.forEach((s) => {
      const a = s.angle + time * 0.16;
      s.orb.root.position.set(
        Math.cos(a) * s.radius,
        s.height + Math.sin(time * 1.1 + s.bob) * 0.06,
        Math.sin(a) * s.radius * 0.55 - 0.1,
      );
      s.orb.update(dt, { look, maxTurn: 1.2 });
    });
    floaters.forEach((f) => {
      f.sprite.position.set(
        f.base.x + Math.sin(time * 0.3 + f.phase) * 0.12,
        f.base.y + Math.sin(time * 0.5 + f.phase) * 0.1,
        f.base.z,
      );
      f.sprite.scale.setScalar(f.size * (0.75 + 0.25 * Math.sin(time * 2.1 + f.phase)));
      f.material.rotation = Math.sin(time * 0.4 + f.phase) * 0.3;
      f.material.opacity = 0.55 + 0.35 * Math.sin(time * 1.3 + f.phase);
    });
  }

  let frame = 0,
    last = 0,
    visible = true,
    disposed = false,
    pendingStatic = true;
  function draw() {
    renderer.render(scene, camera);
  }
  function loop(now: number) {
    frame = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    step(dt);
    draw();
    schedule();
  }
  function schedule() {
    if (disposed || frame || reduced || !visible || document.hidden) return;
    frame = requestAnimationFrame(loop);
  }
  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  }
  /** Reduced motion: settle into the pose for the current state, then draw once. */
  function requestDraw() {
    if (!reduced) return;
    pendingStatic = true;
    if (!frame && visible)
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pendingStatic || disposed) return;
        pendingStatic = false;
        for (let i = 0; i < 90; i++) step(1 / 30);
        draw();
      });
  }

  const observer =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(([entry]) => {
          visible = Boolean(entry?.isIntersecting);
          if (visible) {
            schedule();
            requestDraw();
          } else stop();
        });
  observer?.observe(container);
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  resizeObserver?.observe(container);
  function onVisibility() {
    if (document.hidden) stop();
    else schedule();
  }
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('mouseout', onLeave);
  document.addEventListener('visibilitychange', onVisibility);

  resize();
  setMuses(options.muses);
  if (!reduced) figure.wave();
  schedule();
  requestDraw();

  return {
    setAction(action: FigureAction) {
      figure.setAction(action);
      requestDraw();
    },
    setMuses,
    poke() {
      if (reduced) return;
      figure.hop();
      figure.head.burst(8, 0.8);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      observer?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('mouseout', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      satellites.forEach((s) => s.orb.dispose());
      figure.dispose();
      floaters.forEach((f) => f.material.dispose());
      floor.geometry.dispose();
      floorMaterial.dispose();
      shadow.geometry.dispose();
      shadowMaterial.dispose();
      releaseMuseTextures();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
