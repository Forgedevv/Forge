import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { palette } from './content';
import { jumpAt } from './motion';

/** An original articulated workshop pilot, built entirely from local geometry. */
export function createCharacter() {
  const root = new T.Group();
  const turntable = new T.Group();
  const rig = new T.Group();
  root.add(turntable);
  turntable.add(rig);
  const shell = new T.MeshPhysicalMaterial({
    color: palette.ivory,
    roughness: 0.4,
    metalness: 0.16,
    clearcoat: 0.5,
    clearcoatRoughness: 0.3,
    thickness: 0.35,
    ior: 1.4,
  });
  const trim = new T.MeshStandardMaterial({
    color: palette.ember,
    roughness: 0.48,
    metalness: 0.3,
  });
  const visor = new T.MeshPhysicalMaterial({
    color: palette.ink,
    roughness: 0.3,
    metalness: 0.4,
    clearcoat: 0.6,
  });
  const eye = new T.MeshStandardMaterial({
    color: palette.acid,
    emissive: palette.acid,
    emissiveIntensity: 0.55,
  });
  const wire = new T.MeshBasicMaterial({
    color: palette.ember,
    wireframe: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const sphere = new T.SphereGeometry(1, 28, 20);
  const outlines: T.Mesh[] = [];
  function part(
    parent: T.Group,
    material: T.Material,
    position: number[],
    scale: number[],
    rounded = false,
  ) {
    const geometry = rounded ? new RoundedBoxGeometry(1, 1, 1, 3, 0.22) : sphere;
    const mesh = new T.Mesh(geometry, material);
    mesh.position.set(position[0]!, position[1]!, position[2]!);
    mesh.scale.set(scale[0]!, scale[1]!, scale[2]!);
    mesh.castShadow = true;
    parent.add(mesh);
    if (material === shell) {
      const outline = new T.Mesh(geometry, wire);
      outline.scale.setScalar(1.006);
      mesh.add(outline);
      outlines.push(outline);
    }
    return mesh;
  }
  part(rig, shell, [0, -0.025, 0], [0.132, 0.164, 0.105]);
  const head = new T.Group();
  head.position.y = 0.139;
  rig.add(head);
  part(head, shell, [0, 0, 0], [0.254, 0.186, 0.206], true);
  part(head, visor, [0, -0.005, 0.094], [0.209, 0.091, 0.045], true);
  for (const side of [-1, 1]) {
    part(head, eye, [side * 0.044, 0, 0.119], [0.015, 0.021, 0.008]);
    part(head, trim, [side * 0.125, -0.017, 0], [0.025, 0.058, 0.058]);
  }
  const antenna = part(head, trim, [0.075, 0.12, 0], [0.01, 0.054, 0.01]);
  antenna.rotation.z = -0.35;
  part(head, eye, [0.093, 0.166, 0], [0.019, 0.019, 0.019]);
  part(rig, trim, [0, -0.047, 0.098], [0.091, 0.096, 0.022], true);
  part(rig, eye, [0, -0.043, 0.112], [0.007, 0.026, 0.007]).rotation.z = -0.55;
  part(rig, visor, [0, -0.047, -0.105], [0.141, 0.165, 0.066], true);
  const arms = [-1, 1].map((side) => {
    const pivot = new T.Group();
    pivot.position.set(side * 0.12, 0.035, 0);
    rig.add(pivot);
    part(pivot, shell, [side * 0.025, -0.066, 0], [0.043, 0.085, 0.043]);
    part(pivot, trim, [side * 0.044, -0.135, 0], [0.048, 0.048, 0.05]);
    return pivot;
  });
  const legs = [-1, 1].map((side) => {
    const pivot = new T.Group();
    pivot.position.set(side * 0.065, -0.146, 0);
    rig.add(pivot);
    part(pivot, shell, [0, -0.043, 0], [0.046, 0.071, 0.049]);
    part(pivot, trim, [0, -0.096, 0.014], [0.11, 0.06, 0.135], true);
    return pivot;
  });
  const hammer = new T.Group();
  arms[0]!.add(hammer);
  hammer.position.set(-0.05, -0.13, 0.018);
  part(hammer, visor, [0, 0.013, 0], [0.016, 0.103, 0.016]);
  part(hammer, trim, [0, 0.107, 0], [0.15, 0.063, 0.06], true);
  const color = new T.Color();
  const darkColor = new T.Color('#29324a');
  let yaw = 0,
    bank = 0;
  function update(
    time: number,
    chapter: number,
    pointer: T.Vector2,
    chapterTime: number,
    delta = 0,
  ) {
    const glass = Math.max(0, 1 - Math.abs(chapter - 1));
    const outline = Math.max(0, 1 - Math.abs(chapter - 3));
    const dark = Math.max(0, 1 - Math.abs(chapter - 4));
    const flight = Math.max(0, 1 - Math.abs(chapter - 5));
    const jump = jumpAt(chapterTime);
    // Newly authored poses use the inspected clip cadences and playback speeds.
    const cycles = [100 / 30, 100 / 30 / 0.4, 5.033333333, 100 / 30, 100 / 30 / 0.7, 4];
    const lower = Math.min(4, Math.floor(chapter));
    const mix = chapter - lower;
    const wave = (offset = 0) =>
      T.MathUtils.lerp(
        Math.sin((time * Math.PI * 2) / cycles[lower]! + offset),
        Math.sin((time * Math.PI * 2) / cycles[lower + 1]! + offset),
        mix,
      );
    shell.color.copy(color.set(palette.ivory).lerp(darkColor, dark));
    shell.transmission = glass * 0.93;
    shell.roughness = 0.4 - glass * 0.3;
    shell.metalness = 0.16 + dark * 0.4 - glass * 0.16;
    wire.opacity = outline * 0.48;
    outlines.forEach((mesh) => {
      mesh.visible = outline > 0.01;
    });
    // Integrate chapter rotation instead of multiplying an ever-growing clock by a fade.
    const dt = Math.min(0.1, Math.max(0, delta));
    yaw += (glass * -0.09 + dark * 0.18) * dt;
    bank -= dark * 0.1 * dt;
    yaw =
      Math.atan2(Math.sin(yaw), Math.cos(yaw)) * Math.exp(-dt * 2 * (1 - Math.max(glass, dark)));
    bank = Math.atan2(Math.sin(bank), Math.cos(bank)) * Math.exp(-dt * 2 * (1 - dark));
    turntable.rotation.z = bank;
    rig.position.y = wave() * 0.015 + outline * jump.height;
    rig.rotation.set(wave(0.4) * 0.06 + flight * 0.7, yaw, wave(1.2) * 0.07 + flight * -0.2);
    head.rotation.set(pointer.y * -0.09, pointer.x * 0.15, wave(0.7) * 0.06);
    arms.forEach((arm, i) => {
      const side = i === 0 ? -1 : 1;
      arm.rotation.set(
        wave(i * Math.PI) * 0.16 - flight,
        0,
        side * (0.22 + wave() * 0.13 + flight * 0.7 + outline * jump.height * 2),
      );
    });
    legs.forEach((leg, i) => {
      leg.rotation.x = wave(i * Math.PI) * 0.12 + flight * 0.7 - outline * jump.height;
    });
    hammer.rotation.z = wave(0.2) * 0.2;
    eye.emissiveIntensity = 0.55 + dark * 0.2;
  }
  return { root, update };
}
