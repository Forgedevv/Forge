import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { CABLE_GLOW } from './appearance';
import { homeContent as copy, palette } from './content';
import { jumpAt } from './motion';

export type ChapterScenery = {
  group: T.Group;
  update(time: number, localTime: number, boost: number, pointer: T.Vector2): void;
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
) {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 384;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 1024, 205, 2000);
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new T.Mesh(
    new T.PlaneGeometry(width, (width * 384) / 2048),
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
  const accents = [palette.accent, palette.lilac, palette.magenta, palette.wire];
  const accent = accents[index % accents.length]!;
  ctx.fillStyle = index % 2 ? palette.light : palette.night;
  ctx.fillRect(0, 0, 768, 512);
  ctx.fillStyle = index % 2 ? palette.ink : palette.light;
  ctx.font = 'bold 14px monospace';
  ctx.fillText(copy.scenery.screenLabel, 32, 36);
  ctx.font = 'bold 62px Arial';
  ctx.fillText(copy.scenery.screenNames[index]!, 30, 130, 700);
  ctx.font = '13px monospace';
  ctx.fillText(copy.scenery.screenTabs, 32, 175);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(32, 200, 704, 140, 10);
  ctx.fill();
  ctx.fillStyle = palette.ink;
  ctx.font = 'bold 20px Arial';
  ctx.fillText(copy.scenery.screenAction, 56, 280);
  for (let i = 0; i < 3; i++) {
    const x = 32 + i * 244;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(x + 26, 394, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = index % 2 ? palette.ink : palette.light;
    ctx.font = 'bold 17px monospace';
    ctx.fillText(copy.scenery.screenCoins[i]!, x + 60, 399);
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

  // The spark: oversized typography, suspended hardware, curled wire, and embers.
  {
    const group = make(0);
    const title = textPlane(
      copy.scenery.hero,
      3.15,
      palette.accent,
      '900 350px Arial Black, Arial, sans-serif',
    );
    title.position.set(0, 0.2, -0.62);
    group.add(title);
    const props: T.Mesh[] = [];
    for (let i = 0; i < 15; i++) {
      const geometry =
        i % 3 === 0
          ? new T.TorusGeometry(0.09, 0.024, 10, 30)
          : i % 3 === 1
            ? new RoundedBoxGeometry(0.1, 0.28, 0.08, 2, 0.025)
            : new T.OctahedronGeometry(0.075);
      const mesh = new T.Mesh(
        geometry,
        material(i % 5 === 0 ? palette.magenta : i % 2 ? palette.accent : palette.lilac, 0.45),
      );
      const angle = (i / 15) * Math.PI * 2;
      mesh.position.set(
        Math.cos(angle) * (0.85 + random(i) * 0.55),
        Math.sin(angle) * 0.6,
        random(i + 23) * 0.7 - 0.2,
      );
      mesh.rotation.set(i, i * 0.5, i * 0.8);
      group.add(mesh);
      props.push(mesh);
    }
    const ribbon = curve(
      Array.from({ length: 30 }, (_, i) => {
        const t = i / 29;
        return new T.Vector3(
          -1.7 + t * 3.4,
          Math.sin(t * 9) * 0.3 - 0.27,
          Math.cos(t * 7) * 0.3 - 0.6,
        );
      }),
      palette.accent,
      0.013,
    );
    group.add(ribbon);
    const propHeights = props.map((mesh) => mesh.position.y);
    chapters.push({
      group,
      update(time, _, __, pointer) {
        props.forEach((mesh, i) => {
          mesh.rotation.x = i + time * 0.16;
          mesh.rotation.y = i * 0.5 + time * 0.2;
          mesh.position.y = propHeights[i]! + Math.sin(time * 1.2 + i) * 0.035;
        });
        title.rotation.z = Math.sin(time * 0.2) * 0.018;
        ribbon.rotation.y = pointer.x * 0.08;
      },
    });
  }

  // Your world: refractive objects against a diagonal typographic field.
  {
    const group = make(1);
    const field = new T.Group();
    field.rotation.z = -0.3;
    group.add(field);
    for (let i = -4; i <= 4; i++) {
      const line = textPlane(copy.scenery.repetition, 11, palette.faint, '900 155px Arial');
      line.position.set((i % 2) * 0.6, i * 0.6, -1.8);
      field.add(line);
    }
    const title = textPlane(copy.scenery.glass, 5, palette.accent, '900 150px Arial');
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
      update(time, _, __, pointer) {
        title.rotation.x = time * 0.3;
        field.position.x = Math.sin(time * 0.1) * 0.45;
        props.forEach((mesh, i) => {
          mesh.rotation.set(time * 0.12 + i, time * 0.2 + pointer.x * 0.16, time * 0.1 + i);
        });
      },
    });
  }

  // The workshop: eight glowing launchpad displays above a real reflection.
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
        material(palette.plum, 0.85),
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
    const floor = new Reflector(new T.PlaneGeometry(12, 12), {
      color: palette.floor,
      textureWidth: portrait ? 256 : 512,
      textureHeight: portrait ? 256 : 512,
      clipBias: 0.003,
    });
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
      dispose() {
        floor.getRenderTarget().dispose();
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

  // Liftoff: a luminous road and streaks rushing along the flight direction.
  {
    const group = make(5);
    const roadPoints = Array.from({ length: 50 }, (_, i) => {
      const t = i / 49;
      return new T.Vector3(
        Math.sin(t * 7) * (2 + t * 4),
        -3.5 + Math.sin(t * 5) * 0.5,
        -5 - t * 45,
      );
    });
    const road = curve(roadPoints, palette.accent, 0.022, true);
    group.add(road);
    const inner = curve(
      roadPoints.map((p) => p.clone().add(new T.Vector3(0, 0.18, 0))),
      palette.magenta,
      0.009,
      true,
    );
    group.add(inner);
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
