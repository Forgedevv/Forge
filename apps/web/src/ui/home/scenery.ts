import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CABLE_GLOW } from './appearance';
import { homeContent as copy, palette } from './content';
import { INTRO_SECONDS, jumpAt, smooth } from './motion';

export type ChapterScenery = {
  group: T.Group;
  update(time: number, localTime: number, boost: number, pointer: T.Vector2, offset: number): void;
  dispose?: () => void;
};

function random(seed: number) {
  const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return n - Math.floor(n);
}
function material(color: string, metalness = 0.25) {
  return new T.MeshStandardMaterial({ color, roughness: 0.42, metalness });
}

export function textPlane(
  text: string,
  width: number,
  color = palette.ink,
  font = '900 170px Arial, sans-serif',
  square = false,
) {
  const canvas = document.createElement('canvas');
  canvas.width = square ? 512 : 2048;
  canvas.height = square ? 512 : 384;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height * .534, canvas.width - 48);
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new T.Mesh(
    new T.PlaneGeometry(width, (width * canvas.height) / canvas.width),
    new T.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
    }),
  );
  return mesh;
}

function curve(points: T.Vector3[], color: string, radius = 0.01, emissive = false) {
  const geometry = new T.TubeGeometry(new T.CatmullRomCurve3(points), 64, radius, 6, false);
  return new T.Mesh(
    geometry,
    emissive
      ? new T.MeshStandardMaterial({
          color,
          emissive: new T.Color(color).multiplyScalar(CABLE_GLOW.emissiveTint),
          emissiveIntensity: CABLE_GLOW.emissiveIntensity,
        })
      : material(color),
  );
}

function screenTexture(index: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const accents = [palette.accent, palette.wire, palette.lilac, palette.magenta];
  const accent = accents[index % accents.length]!;
  const paper = index % 3 === 1;
  const ink = paper ? palette.ink : palette.light;
  const bg = paper ? palette.light : palette.ink;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 768, 512);
  ctx.fillStyle = ink;
  ctx.font = '12px monospace';
  ctx.fillText(copy.scenery.screenLabel, 32, 36);
  ctx.textAlign = 'right';
  ctx.fillText(copy.scenery.screenAction, 736, 36);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 0.2;
  ctx.fillRect(32, 57, 704, 1);
  ctx.globalAlpha = 1;
  // Different editorial layouts make the wall read as real design studies.
  ctx.font = index % 3 === 0 ? 'bold 82px Arial' : '90px Georgia';
  ctx.fillText(copy.scenery.screenNames[index]!, 32, 162, 660);
  ctx.font = '12px monospace';
  ctx.fillText(copy.scenery.screenTabs, 35, 200);
  ctx.save();
  ctx.translate(index % 3 === 2 ? 505 : 605, 254);
  ctx.rotate(-0.4 + index * 0.16);
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.ellipse(0, 0, 111 - i * 9, 72 - i * 5, i * 0.14, 0, Math.PI * 2);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = accent;
  ctx.fillRect(32, 253, 186, 45);
  ctx.fillStyle = palette.ink;
  ctx.font = 'bold 12px Arial';
  ctx.fillText(copy.scenery.screenAction, 48, 280);
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.16;
  ctx.fillRect(32, 354, 704, 1);
  ctx.globalAlpha = 1;
  for (let i = 0; i < 3; i++) {
    const x = 32 + i * 244;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(x + 21, 407, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.font = '14px monospace';
    ctx.fillText(copy.scenery.screenCoins[i]!, x + 54, 411);
    ctx.globalAlpha = 0.25;
    ctx.fillRect(x, 441, 180, 4);
    ctx.fillRect(x, 458, 126, 4);
    ctx.globalAlpha = 1;
  }
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

export function createScenery(origins: T.Vector3[], portrait: boolean): ChapterScenery[] {
  const chapters: ChapterScenery[] = [];
  const make = (index: number) => {
    const group = new T.Group();
    group.position.copy(origins[index]!);
    return group;
  };

  // The spark: floating type, crosses, slashes and dotted fields around the pilot.
  {
    const group = make(0);
    const letters = Array.from(copy.scenery.hero).map((letter, index) => {
      const mesh = textPlane(letter, .66, palette.light, '900 400px Arial Black, Arial, sans-serif', true);
      const base = new T.Vector3((index - 2) * .57, .62, -1.1);
      const position = base.clone();
      const velocity = new T.Vector3();
      mesh.position.copy(base);
      group.add(mesh);
      return { mesh, base, position, velocity };
    });
    const crosses = [[-1.48, .94, -.9], [1.35, -.5, -.6], [1.85, .4, -1.8]].map((point, index) => {
      const cross = new T.Group();
      const crossMaterial = material(index === 1 ? palette.accent : palette.lilac, .5);
      cross.add(new T.Mesh(new T.BoxGeometry(.16, .025, .025), crossMaterial));
      cross.add(new T.Mesh(new T.BoxGeometry(.025, .16, .025), crossMaterial));
      cross.position.set(point[0]!, point[1]!, point[2]!);
      group.add(cross);
      return cross;
    });
    const slashMaterial = material(palette.wire, .5);
    const slashes = new T.Group();
    slashes.position.set(-1.65, -.72, -1.05);
    slashes.rotation.z = -.4;
    for (let index = 0; index < 5; index++) {
      const slash = new T.Mesh(new T.BoxGeometry(.02, .18, .012), slashMaterial);
      slash.position.x = index * .075;
      slashes.add(slash);
    }
    group.add(slashes);
    const dots = new T.InstancedMesh(new T.SphereGeometry(.007, 4, 4), material(palette.lilac), 72);
    const dummy = new T.Object3D();
    for (let index = 0; index < 72; index++) {
      const bank = index < 36 ? -1 : 1;
      dummy.position.set(bank * 1.7 + (index % 6) * .055, .83 - Math.floor(index % 36 / 6) * .055, -1.7);
      dummy.updateMatrix();
      dots.setMatrixAt(index, dummy.matrix);
    }
    group.add(dots);
    const pointerBefore = new T.Vector2();
    const restoring = new T.Vector3();
    let previousTime = 0;
    chapters.push({
      group,
      update(time, localTime, __, pointer) {
        const delta = Math.min(.05, Math.max(0, time - previousTime));
        previousTime = time;
        letters.forEach(({ mesh, base, position, velocity }, index) => {
          const reach = Math.max(0, 1 - Math.hypot(pointer.x * 1.7 - base.x, pointer.y - base.y));
          velocity.x += (pointer.x - pointerBefore.x) * reach * .25;
          velocity.y += (pointer.y - pointerBefore.y) * reach * .25;
          velocity.addScaledVector(restoring.subVectors(base, position), delta * 12);
          velocity.multiplyScalar(Math.exp(-delta * 7));
          position.addScaledVector(velocity, delta * 8);
          mesh.position.copy(position);
          mesh.position.y += Math.sin(time + index * 1.1) * .009;
          const reveal = smooth((localTime - INTRO_SECONDS - index * .07) / .7);
          mesh.scale.set(1, Math.max(.001, reveal), 1);
          mesh.rotation.z = (1 - reveal) * -.45;
        });
        pointerBefore.copy(pointer);
        crosses.forEach((cross, index) => { cross.rotation.z = Math.sin(time * .25 + index) * .15; });
      },
    });
  }

  // Your world: refractive objects against a diagonal typographic field.
  {
    const group = make(1);
    const field = new T.Group();
    field.rotation.z = -0.3;
    group.add(field);
    const linePrototype = textPlane(copy.scenery.repetition, 11, palette.faint, '900 155px Arial');
    const marquee = linePrototype.material.map!;
    marquee.wrapS = T.RepeatWrapping;
    marquee.repeat.x = 2;
    for (let i = -6; i <= 6; i++) {
      const line = linePrototype.clone();
      line.position.set((i % 2) * .6, i * .6, -1.8);
      line.scale.setScalar(.65 + random(i + 30) * .5);
      field.add(line);
    }
    const title = textPlane(copy.scenery.glass, 5, palette.light, '900 150px Arial');
    title.position.set(0, 0.9, -0.55);
    group.add(title);
    const glass = new T.MeshPhysicalMaterial({
      color: palette.light,
      transmission: 0.98,
      thickness: 1.2,
      roughness: 0.04,
      ior: 1.45,
      metalness: 0,
      clearcoat: 1,
    });
    const geometries = [
      new RoundedBoxGeometry(0.7, 0.7, 0.7, 3, 0.08),
      new T.TorusGeometry(0.37, 0.14, 20, 48),
      new T.CylinderGeometry(0.27, 0.27, 0.75, 40),
    ];
    const props = geometries.map((geometry, i) => {
      const mesh = new T.Mesh(geometry, glass);
      mesh.position.set((i - 1) * 1.6, i === 1 ? -0.95 : 0.12, 0.2);
      group.add(mesh);
      return mesh;
    });
    chapters.push({
      group,
      update(time, _, __, pointer, offset) {
        title.rotation.y = pointer.x * 0.025;
        title.rotation.x = Math.max(-1, Math.min(1, offset)) * Math.PI / 2;
        marquee.offset.x = (time * .05 + offset * .2) % 1;
        props.forEach((mesh, i) => {
          mesh.rotation.set(time * 0.12 + i, time * 0.2 + pointer.x * 0.16, time * 0.1 + i);
        });
      },
    });
  }

  // The workshop: eight independent design studies, grounded on a matte drafting table.
  {
    const group = make(2);
    const screens: T.Group[] = [];
    for (let i = 0; i < 8; i++) {
      const screen = new T.Group();
      const row = i < 4 ? 0 : 1;
      const col = i % 4;
      screen.position.set(
        (col - 1.5) * 1.35,
        row === 0 ? 0.72 : -0.15,
        -0.9 - Math.abs(col - 1.5) * 0.2,
      );
      screen.rotation.set(-0.05, (1.5 - col) * 0.14, (random(i) - 0.5) * 0.13);
      const caseMesh = new T.Mesh(
        new RoundedBoxGeometry(1.24, 0.84, 0.11, 3, 0.05),
        material(palette.plum, 0.5),
      );
      screen.add(caseMesh);
      const display = new T.Mesh(
        new T.PlaneGeometry(1.14, 0.75),
        new T.MeshBasicMaterial({ map: screenTexture(i), toneMapped: false }),
      );
      display.position.z = 0.061;
      screen.add(display);
      group.add(screen);
      screens.push(screen);
      group.add(
        curve(
          [
            screen.position.clone().add(new T.Vector3(0, -0.4, 0)),
            new T.Vector3(screen.position.x + 0.2, -1.2, -0.9),
            new T.Vector3(screen.position.x * 0.5, -1.4, 0.4),
          ],
          i % 2 ? palette.lilac : palette.accent,
          0.009,
          true,
        ),
      );
    }
    // A matte floor avoids rendering the entire scene twice for every animation frame.
    const floor = new T.Mesh(new T.PlaneGeometry(12, 12), new T.MeshStandardMaterial({ color: palette.ink, roughness: 0.88, metalness: 0.15 }));
    floor.receiveShadow = true;
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -1.42, 0);
    group.add(floor);
    chapters.push({
      group,
      update(time, _, __, pointer) {
        screens.forEach((screen, i) => {
          screen.position.y = (i < 4 ? 0.72 : -0.15) + Math.sin(time * 0.7 + i) * 0.06;
          screen.rotation.y = (1.5 - (i % 4)) * 0.14 + pointer.x * 0.03;
        });
      },
    });
  }

  // Built together: a drafting grid, changing type, and 26 small makers.
  {
    const group = make(3);
    const grid = new T.GridHelper(34, 68, palette.wire, palette.faint);
    grid.position.y = -1.18;
    group.add(grid);
    const words = copy.scenery.buildWords.map((word) => {
      const mesh = textPlane(word, 8, palette.accent, '900 300px Arial Black, Arial');
      mesh.position.set(0, -1.15, -0.9);
      mesh.rotation.x = -Math.PI / 2;
      group.add(mesh);
      return mesh;
    });
    const heads = new T.InstancedMesh(
      new T.SphereGeometry(0.13, 10, 8),
      material(palette.light),
      26,
    );
    const bodies = new T.InstancedMesh(
      new T.CapsuleGeometry(0.1, 0.2, 3, 8),
      material(palette.plum),
      26,
    );
    const boots = new T.InstancedMesh(
      new T.SphereGeometry(0.06, 8, 6),
      material(palette.accent),
      52,
    );
    group.add(heads, bodies, boots);
    const dummy = new T.Object3D();
    chapters.push({
      group,
      update(time, localTime) {
        const word = jumpAt(localTime).word;
        words.forEach((mesh, i) => {
          mesh.visible = i === word;
        });
        for (let i = 0; i < 26; i++) {
          const angle = (i / 26) * Math.PI * 2 + time * (i % 2 ? 0.035 : -0.025);
          const r = 2.4 + random(i + 8) * 3.5;
          const x = Math.cos(angle) * r,
            z = Math.sin(angle) * r;
          dummy.position.set(x, -0.72 + Math.sin(time * 3 + i) * 0.025, z);
          dummy.scale.set(1, 1, 1);
          dummy.rotation.set(0, -angle, 0);
          dummy.updateMatrix();
          heads.setMatrixAt(i, dummy.matrix);
          dummy.position.y -= 0.23;
          dummy.updateMatrix();
          bodies.setMatrixAt(i, dummy.matrix);
          for (let side = 0; side < 2; side++) {
            dummy.position.set(
              x + (side ? 0.09 : -0.09),
              -1.14,
              z + Math.sin(time * 3 + i + side * Math.PI) * 0.07,
            );
            dummy.scale.set(1, 0.7, 1.5);
            dummy.updateMatrix();
            boots.setMatrixAt(i * 2 + side, dummy.matrix);
          }
        }
        heads.instanceMatrix.needsUpdate =
          bodies.instanceMatrix.needsUpdate =
          boots.instanceMatrix.needsUpdate =
            true;
      },
    });
  }

  // Your rules: a slow orbital manifesto and a rotating wire globe.
  {
    const group = make(4);
    const orbit = new T.Group();
    group.add(orbit);
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const text = textPlane(copy.scenery.orbit, 1.8, palette.lilac, 'bold 130px monospace');
      text.position.set(Math.cos(angle) * 2.3, Math.sin(angle) * 2.3, -0.8);
      text.rotation.z = angle + Math.PI / 2;
      orbit.add(text);
    }
    const sphere = new T.Mesh(
      new T.SphereGeometry(2.9, 32, 16),
      new T.MeshBasicMaterial({
        color: palette.wire,
        wireframe: true,
        transparent: true,
        opacity: 0.2,
      }),
    );
    group.add(sphere);
    chapters.push({
      group,
      update(time) {
        orbit.rotation.z = -time * 0.1;
        sphere.rotation.y = time * 0.06;
      },
    });
  }

  // Liftoff: a sequence of distant gates. The foreground stays clear for the launch action.
  {
    const group = make(5);
    const gates: T.Mesh[] = [];
    const gateGeometry = new T.TorusGeometry(3.1, 0.019, 6, 80);
    for (let i = 0; i < 9; i++) {
      const gate = new T.Mesh(gateGeometry, material(i % 3 === 0 ? palette.accent : palette.wire, 0.5));
      gate.position.set(Math.sin(i * 0.45) * 1.4, -2.1, -9 - i * 4);
      gate.rotation.z = i * 0.18;
      gate.scale.setScalar(1 + i * 0.08);
      group.add(gate);
      gates.push(gate);
    }
    const streakCount = portrait ? 64 : 130;
    const streaks = new T.InstancedMesh(
      new T.CylinderGeometry(0.008, 0.008, 1, 3),
      new T.MeshBasicMaterial({ color: palette.light, transparent: true, opacity: 0.26 }),
      streakCount,
    );
    group.add(streaks);
    const dummy = new T.Object3D();
    let travel = 0;
    let previousTime = 0;
    chapters.push({
      group,
      update(time, _, boost) {
        travel += Math.min(0.1, Math.max(0, time - previousTime)) * (1 + boost * 4) * 3;
        previousTime = time;
        gates.forEach((gate, i) => { gate.rotation.y = Math.sin(time * 0.18 + i * 0.4) * 0.1; });
        for (let i = 0; i < streakCount; i++) {
          const angle = random(i + 90) * Math.PI * 2,
            r = 2 + random(i + 11) * 13;
          dummy.position.set(
            Math.cos(angle) * r,
            Math.sin(angle) * r,
            ((random(i) * 50 + travel) % 50) - 40,
          );
          dummy.rotation.x = Math.PI / 2;
          dummy.scale.set(1, 0.25 + boost * 1.4 + random(i + 5), 1);
          dummy.updateMatrix();
          streaks.setMatrixAt(i, dummy.matrix);
        }
        streaks.instanceMatrix.needsUpdate = true;
      },
    });
  }
  return chapters;
}
