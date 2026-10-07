import * as T from 'three';
import { Body, Box, Vec3, World } from 'cannon-es';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import measurements from '../reference/loanmeme/motion-measurements.json';
import { createCharacter } from './character';
import { palette } from './content';
import { ChapterMotion, boostAt, boostCameraAt, clamp, jumpAt, sigmoid, smooth } from './motion';
import { createScenery } from './scenery';

export interface ExperienceHandle {
  goTo(chapter: number, duration?: number): void;
  skipIntro(): void;
  setPaused(paused: boolean): void;
  setInteractive(interactive: boolean): void;
  dispose(): void;
}

interface ExperienceOptions {
  paused: boolean;
  onChapter(chapter: number): void;
  onProgress(value: number, intro: number): void;
  onIntroDone(): void;
  onFailure(): void;
}

const vignetteShader = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.25 }, aberration: { value: 0.0005 } },
  vertexShader:
    'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float strength; uniform float aberration; varying vec2 vUv;
    void main(){vec2 d=vUv-0.5;vec2 shift=d*aberration;
    vec4 c=texture2D(tDiffuse,vUv);c.r=texture2D(tDiffuse,vUv+shift).r;c.b=texture2D(tDiffuse,vUv-shift).b;
    c.rgb*=1.0-strength*smoothstep(0.08,0.58,dot(d,d));gl_FragColor=c;}`,
};

export function createExperience(
  element: HTMLDivElement,
  options: ExperienceOptions,
): ExperienceHandle {
  const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  try {
    return buildExperience(element, options, renderer);
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    throw error;
  }
}

function buildExperience(
  element: HTMLDivElement,
  options: ExperienceOptions,
  renderer: T.WebGLRenderer,
): ExperienceHandle {
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, element.clientWidth < 800 ? 1.25 : 1.65),
  );
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.transmissionResolutionScale = element.clientWidth < 800 ? 0.5 : 0.75;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  element.append(renderer.domElement);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(38, 1, 0.03, 160);
  scene.add(camera);
  const environment = new RoomEnvironment();
  const pmrem = new T.PMREMGenerator(renderer);
  const environmentTarget = pmrem.fromScene(environment, 0.04);
  scene.environment = environmentTarget.texture;
  scene.environmentIntensity = 0.8;
  environment.dispose();
  pmrem.dispose();
  const ambient = new T.HemisphereLight(palette.ivory, '#697267', 1.5);
  scene.add(ambient);
  const key = new T.DirectionalLight(palette.ivory, 2.1);
  key.castShadow = true;
  key.shadow.mapSize.set(
    element.clientWidth < 800 ? 512 : 1024,
    element.clientWidth < 800 ? 512 : 1024,
  );
  key.shadow.bias = -0.0003;
  key.shadow.camera.left = key.shadow.camera.bottom = -5;
  key.shadow.camera.right = key.shadow.camera.top = 5;
  scene.add(key, key.target);
  const pointerLight = new T.PointLight(palette.ember, 1.5, 12, 2);
  scene.add(pointerLight);

  const backgrounds = palette.backgrounds.map((color) => new T.Color(color));
  const background = new T.Mesh(
    new T.PlaneGeometry(220, 220),
    new T.ShaderMaterial({
      uniforms: {
        color: { value: backgrounds[0]!.clone() },
        accent: { value: new T.Color(palette.ember) },
        time: { value: 0 },
        glow: { value: 0.08 },
      },
      vertexShader:
        'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `uniform vec3 color;uniform vec3 accent;uniform float time;uniform float glow;varying vec2 vUv;
      void main(){vec2 p=(vUv-.5)*4.;float g=exp(-length(p-vec2(sin(time*.17)*.3,cos(time*.11)*.15))*2.5);
      float grain=(fract(sin(dot(vUv*2200.,vec2(12.9898,78.233)))*43758.5453)-.5)*.011;
      gl_FragColor=vec4(mix(color,accent,g*glow)+grain,1.);}`,
      depthTest: false,
      depthWrite: false,
    }),
  );
  background.position.z = -65;
  background.renderOrder = -100;
  camera.add(background);

  const transforms = measurements.chapters.map((chapter) => ({
    camera: new T.Vector3().fromArray(chapter.camera.position),
    target: new T.Vector3().fromArray(chapter.target.position),
    position: new T.Vector3().fromArray(chapter.character.position),
    quaternion: new T.Quaternion().fromArray(chapter.character.rotation),
    scale: chapter.character.scale[0]!,
    fov: chapter.camera.fovDegrees,
    portraitFov: chapter.mobileFovOffsetDegrees,
  }));
  // The reference overrides this chapter's raw GLB transform after loading.
  transforms[2]!.position.y = 0.2807 * transforms[2]!.scale - 12;
  transforms[2]!.quaternion.setFromAxisAngle(new T.Vector3(0, 1, 0), Math.PI);
  const isPortrait = () => element.clientWidth / Math.max(1, element.clientHeight) < 1;
  const scenery = createScenery(
    transforms.map((t) => t.target),
    isPortrait(),
  );
  scenery.forEach((chapter) => scene.add(chapter.group));
  const character = createCharacter();
  scene.add(character.root);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new T.Vector2(1, 1), 0.4, 0.65, 1.1);
  composer.addPass(bloom);
  const vignette = new ShaderPass(vignetteShader);
  composer.addPass(vignette);
  const output = new OutputPass();
  composer.addPass(output);

  const cloudPositions = new Float32Array(450 * 3);
  for (let i = 0; i < cloudPositions.length; i++)
    cloudPositions[i] = Math.sin(i * 127.1 + 31) * (i % 3 === 1 ? 3 : 5);
  const cloudGeometry = new T.BufferGeometry();
  cloudGeometry.setAttribute('position', new T.BufferAttribute(cloudPositions, 3));
  const cloud = new T.Points(
    cloudGeometry,
    new T.PointsMaterial({
      color: palette.ivory,
      size: 0.012,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    }),
  );
  scene.add(cloud);
  const trail = new T.InstancedMesh(
    new T.SphereGeometry(1, 8, 6),
    new T.MeshBasicMaterial({
      color: palette.ember,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    }),
    18,
  );
  trail.frustumCulled = false;
  scene.add(trail);
  const trailPoints = Array.from({ length: 18 }, () => new T.Vector3());
  let trailReady = false;
  const raycaster = new T.Raycaster(),
    pointerPlane = new T.Plane(),
    pointerPoint = new T.Vector3();
  const dummy = new T.Object3D();
  const world = new World({ gravity: new Vec3(0, -2, 0) });
  const shards = new T.Group();
  scene.add(shards);
  const shardGeometry = new T.BoxGeometry(0.42, 0.39, 0.025);
  const shardMaterial = new T.MeshStandardMaterial({ color: palette.ink, roughness: 0.4 });
  const fragments: { mesh: T.Mesh; body: Body }[] = [];
  for (let i = 0; i < 35; i++) {
    const x = ((i % 7) - 3) * 0.43,
      y = (Math.floor(i / 7) - 2) * 0.4;
    const mesh = new T.Mesh(shardGeometry, shardMaterial);
    shards.add(mesh);
    const body = new Body({
      mass: 1,
      shape: new Box(new Vec3(0.21, 0.195, 0.0125)),
      position: new Vec3(x, y + 1.05, 0.4),
    });
    body.velocity.set(x * 1.8, y * 1.8 + 1.4, 0.8 + Math.abs(x));
    body.angularVelocity.set(x * 3, y * 3, ((i % 3) - 1) * 2);
    world.addBody(body);
    fragments.push({ mesh, body });
  }

  const motion = new ChapterMotion();
  let appearance = 0,
    appearanceFrom = 0,
    appearanceStarted = 0;
  const pointer = new T.Vector2(),
    smoothPointer = new T.Vector2();
  const lookAt = new T.Vector3(),
    cameraDirection = new T.Vector3();
  const keyOffset = new T.Vector3(3, 5, 5),
    lightOffset = new T.Vector3();
  const chapterTimes = Array<number>(6).fill(0);
  const atmosphere = {
    pointer: [1.5, 1.5, 4, 1.5, 1.5, 2],
    glow: [0.08, 0.025, 0.025, 0.035, 0.02, 0.04],
    bloom: [0.16, 0.18, 0.38, 0.16, 0.24, 0.28],
    vignette: [0.16, 0.23, 0.16, 0.16, 0.18, 0.18],
  };
  let paused = options.paused,
    interactive = true,
    disposed = false,
    failed = false,
    frameId = 0;
  // The intro timeline is authored over ~6.3 s; play it faster so the logo shows and the wall breaks quickly.
  const INTRO_SPEED = 3.5;
  let time = 0,
    introClock = paused ? 6.4 : 0,
    introDone = paused,
    wallDone = paused;
  let lastTimestamp = performance.now(),
    selected = -1,
    boostStarted = -100;
  let pointerId: number | null = null,
    touchY = 0,
    touchDelta = 0,
    pointerMoved = false,
    lastSimpleWheel = -Infinity;
  const materials = scenery.map(({ group }) => {
    const values = new Map<T.Material, { opacity: number; depthWrite: boolean }>();
    group.traverse((object) => {
      if (object instanceof T.Mesh || object instanceof T.LineSegments) {
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list)
          if (!(material instanceof T.ShaderMaterial) && !values.has(material)) {
            values.set(material, {
              opacity: material.opacity,
              depthWrite: material.depthWrite,
            });
            // Keep the blending shader variant stable throughout chapter fades.
            material.transparent = true;
          }
      }
    });
    return values;
  });

  let viewportWidth = 0,
    viewportHeight = 0;
  function resize() {
    if (disposed) return;
    const width = Math.max(1, element.clientWidth),
      height = Math.max(1, element.clientHeight);
    if (width === viewportWidth && height === viewportHeight) return;
    viewportWidth = width;
    viewportHeight = height;
    renderer.setSize(width, height);
    composer.setSize(width, height);
    camera.aspect = width / height;
    if (paused) draw();
  }
  function finishIntro() {
    if (!introDone) {
      introDone = true;
      options.onIntroDone();
    }
  }
  function draw(dt = 0) {
    if (disposed || failed) return;
    const value = motion.value;
    const index = Math.min(4, Math.floor(value)),
      blend = value - index;
    const from = transforms[index]!,
      to = transforms[index + 1]!;
    const atmosphereMix = smooth(blend);
    const mixAtmosphere = (values: number[]) =>
      T.MathUtils.lerp(values[index]!, values[index + 1]!, atmosphereMix);
    const chapterWeight = (chapter: number) => smooth(1 - Math.abs(value - chapter));
    for (let i = 0; i < chapterTimes.length; i++) {
      if (Math.abs(value - i) < 1) chapterTimes[i]! += dt;
    }
    if (selected !== motion.chapter) {
      appearanceFrom = appearance;
      appearanceStarted = time;
      selected = motion.chapter;
      options.onChapter(selected);
      if (selected === 5) boostStarted = time;
    }
    const boost = paused ? 0 : boostAt(time - boostStarted);
    const boostCamera = boostCameraAt(paused ? -1 : time - boostStarted);
    const portrait = clamp((1 - camera.aspect) / 0.6);
    smoothPointer.lerp(pointer, 1 - Math.exp(-dt * 4));
    camera.position.lerpVectors(from.camera, to.camera, blend);
    lookAt.lerpVectors(from.target, to.target, blend);
    const distance = camera.position.distanceTo(lookAt);
    camera.position.x += smoothPointer.x * distance * 0.016;
    camera.position.y += smoothPointer.y * distance * 0.012;
    camera.position.x += Math.sin(time * 0.3) * 0.015 * chapterWeight(2);
    const shake = paused
      ? 0
      : jumpAt(chapterTimes[3]!).impact * 0.007 * chapterWeight(3) +
        boostCamera.shake * 0.12 * chapterWeight(5);
    camera.position.x += Math.sin(time * 49) * shake;
    camera.position.y += Math.cos(time * 57) * shake;
    camera.fov =
      T.MathUtils.lerp(from.fov, to.fov, blend) +
      T.MathUtils.lerp(from.portraitFov, to.portraitFov, blend) * portrait +
      boostCamera.fov * 0.45 * chapterWeight(5);
    camera.lookAt(lookAt);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    character.root.position.lerpVectors(from.position, to.position, blend);
    character.root.quaternion.slerpQuaternions(from.quaternion, to.quaternion, blend);
    character.root.scale.setScalar(T.MathUtils.lerp(from.scale, to.scale, blend));
    if (introClock < 5.8) character.root.position.z -= (1 - smooth((introClock - 4.8) / 1)) * 1.7;
    appearance = paused
      ? value
      : T.MathUtils.lerp(appearanceFrom, selected, sigmoid(time - appearanceStarted));
    character.update(time, appearance, smoothPointer, chapterTimes[3]!, dt);
    key.position.copy(character.root.position).add(keyOffset);
    key.target.position.copy(character.root.position);
    pointerLight.position
      .copy(character.root.position)
      .add(lightOffset.set(smoothPointer.x * 3, smoothPointer.y * 2 + 1, 2));
    pointerLight.intensity = mixAtmosphere(atmosphere.pointer);
    background.material.uniforms
      .color!.value.copy(backgrounds[index]!)
      .lerp(backgrounds[index + 1]!, atmosphereMix);
    background.material.uniforms.time!.value = time;
    background.material.uniforms.glow!.value = mixAtmosphere(atmosphere.glow);
    bloom.strength = mixAtmosphere(atmosphere.bloom) + boost * 0.1 * chapterWeight(5);
    vignette.uniforms.strength!.value = mixAtmosphere(atmosphere.vignette);
    vignette.uniforms.aberration!.value = boost * 0.00015 * chapterWeight(5);
    scenery.forEach((chapter, i) => {
      const weight = sigmoid(1 - Math.abs(value - i));
      chapter.group.visible = weight > 0.005;
      if (!chapter.group.visible) return;
      materials[i]!.forEach((original, material) => {
        material.opacity = original.opacity * weight;
        material.depthWrite = weight < 0.999 ? false : original.depthWrite;
      });
      chapter.update(time, chapterTimes[i]!, boost, smoothPointer);
    });
    cloud.position.copy(character.root.position);
    cloud.rotation.y = time * 0.025;
    cloud.position.y += Math.sin(time * 0.15) * 0.18;
    trail.visible = !isPortrait() && pointerMoved && !paused && introDone;
    if (trail.visible) {
      camera.getWorldDirection(cameraDirection);
      pointerPlane.setFromNormalAndCoplanarPoint(cameraDirection, character.root.position);
      raycaster.setFromCamera(smoothPointer, camera);
      if (raycaster.ray.intersectPlane(pointerPlane, pointerPoint)) {
        if (!trailReady) trailPoints.forEach((point) => point.copy(pointerPoint));
        trailReady = true;
        trailPoints[0]!.lerp(pointerPoint, 1 - Math.exp(-72 * dt));
        for (let i = 1; i < trailPoints.length; i++)
          trailPoints[i]!.lerp(trailPoints[i - 1]!, 1 - Math.exp(-23 * dt));
        trailPoints.forEach((position, i) => {
          dummy.position.copy(position);
          dummy.scale.setScalar(distance * 0.004 * (1 - i / 18));
          dummy.updateMatrix();
          trail.setMatrixAt(i, dummy.matrix);
        });
        trail.instanceMatrix.needsUpdate = true;
      }
    } else trailReady = false;
    shards.visible = introClock >= 4.8 && introClock < 6.3 && !wallDone;
    if (shards.visible) {
      world.step(1 / 60, Math.min(dt, 0.05), 3);
      fragments.forEach(({ body, mesh }) => {
        mesh.position.set(body.position.x, body.position.y, body.position.z);
        mesh.quaternion.set(
          body.quaternion.x,
          body.quaternion.y,
          body.quaternion.z,
          body.quaternion.w,
        );
      });
    }
    if (!wallDone && introClock >= 6.3) {
      wallDone = true;
      fragments.forEach(({ body }) => world.removeBody(body));
    }
    options.onProgress(value, clamp(introClock / 4.8));
    try {
      composer.render(dt);
    } catch {
      fail();
    }
  }
  function schedule() {
    if (!disposed && !failed && !paused && !document.hidden && !frameId)
      frameId = requestAnimationFrame(frame);
  }
  function frame(now: number) {
    frameId = 0;
    const dt = clamp((now - lastTimestamp) / 1000, 0, 0.1);
    lastTimestamp = now;
    if (!paused && !document.hidden) {
      time += dt;
      introClock += dt * INTRO_SPEED;
      if (introClock >= 4.8) {
        finishIntro();
        motion.tick(dt);
      }
      draw(dt);
    }
    schedule();
  }
  function fail() {
    if (failed || disposed) return;
    failed = true;
    cancelAnimationFrame(frameId);
    frameId = 0;
    options.onFailure();
  }
  function skipIntro() {
    introClock = 6.4;
    wallDone = true;
    finishIntro();
    draw();
  }
  function goTo(chapter: number, duration = 2) {
    if (!introDone) skipIntro();
    if (chapter > 5 && time - boostStarted > 6) boostStarted = time;
    motion.to(chapter, paused ? 0 : duration);
    draw();
    schedule();
  }
  function isControl(target: EventTarget | null) {
    return (
      target instanceof Element &&
      Boolean(target.closest('button,a,input,textarea,select,dialog,[data-gesture-lock]'))
    );
  }
  function onWheel(event: WheelEvent) {
    if (!interactive || event.ctrlKey || isControl(event.target)) return;
    event.preventDefault();
    if (!introDone) {
      skipIntro();
      return;
    }
    const delta =
      event.deltaY *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
    if (delta === 0) return;
    const now = performance.now();
    if (paused) {
      if (now - lastSimpleWheel > 300) {
        goTo(motion.chapter + Math.sign(delta), 0);
        lastSimpleWheel = now;
      }
      return;
    }
    // ChapterMotion owns tail filtering, including immediate direction reversals.
    if (motion.value > 4.95 && delta > 0 && time - boostStarted > 6) boostStarted = time;
    motion.wheel(delta, now);
  }
  function onPointerDown(event: PointerEvent) {
    if (
      !interactive ||
      isControl(event.target) ||
      event.pointerType === 'mouse' ||
      !event.isPrimary
    )
      return;
    if (!introDone) skipIntro();
    pointerId = event.pointerId;
    touchY = event.clientY;
    touchDelta = 0;
    element.setPointerCapture(pointerId);
    motion.grab();
  }
  function onPointerMove(event: PointerEvent) {
    if (!interactive) return;
    const rect = element.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    pointerMoved = true;
    if (pointerId !== event.pointerId) return;
    touchDelta = event.clientY - touchY;
    touchY = event.clientY;
    motion.drag(touchDelta);
    if (paused) draw();
  }
  function onPointerUp(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    const releasedDelta = event.type === 'pointercancel' ? 0 : touchDelta;
    motion.release(releasedDelta);
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    pointerId = null;
    if (paused) {
      motion.to(motion.chapter + (Math.abs(releasedDelta) > 2 ? -Math.sign(releasedDelta) : 0), 0);
      draw();
    }
  }
  function onKey(event: KeyboardEvent) {
    if (!interactive || event.altKey || event.ctrlKey || event.metaKey || isControl(event.target))
      return;
    const directions: Record<string, number> = {
      ArrowDown: 1,
      ArrowRight: 1,
      PageDown: 1,
      ' ': 1,
      ArrowUp: -1,
      ArrowLeft: -1,
      PageUp: -1,
    };
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      goTo(event.key === 'Home' ? 0 : 5);
    } else if (event.key in directions) {
      event.preventDefault();
      goTo(motion.chapter + directions[event.key]!);
    }
  }
  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    } else {
      lastTimestamp = performance.now();
      schedule();
    }
  }
  function onContextLost(event: Event) {
    event.preventDefault();
    fail();
  }
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);
  element.addEventListener('keydown', onKey);
  renderer.domElement.addEventListener('webglcontextlost', onContextLost);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisibility);
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  resizeObserver?.observe(element);
  resize();
  draw();
  if (introDone) options.onIntroDone();
  schedule();

  return {
    goTo,
    skipIntro,
    setPaused(value) {
      paused = value;
      if (paused) {
        cancelAnimationFrame(frameId);
        frameId = 0;
        skipIntro();
      } else {
        lastTimestamp = performance.now();
        schedule();
      }
    },
    setInteractive(value) {
      interactive = value;
      if (!value && pointerId !== null) {
        motion.release(0);
        pointerId = null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frameId);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('keydown', onKey);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      resizeObserver?.disconnect();
      const geometries = new Set<T.BufferGeometry>(),
        materialSet = new Set<T.Material>(),
        textures = new Set<T.Texture>();
      scene.traverse((object) => {
        if (
          object instanceof T.Mesh ||
          object instanceof T.LineSegments ||
          object instanceof T.Points
        ) {
          geometries.add(object.geometry);
          (Array.isArray(object.material) ? object.material : [object.material]).forEach(
            (material) => materialSet.add(material),
          );
        }
      });
      materialSet.forEach((material) => {
        for (const value of Object.values(material))
          if (value instanceof T.Texture) textures.add(value);
        material.dispose();
      });
      textures.forEach((texture) => texture.dispose());
      geometries.forEach((geometry) => geometry.dispose());
      scenery.forEach((chapter) => chapter.dispose?.());
      environmentTarget.dispose();
      key.shadow.dispose();
      bloom.dispose();
      vignette.dispose();
      output.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
