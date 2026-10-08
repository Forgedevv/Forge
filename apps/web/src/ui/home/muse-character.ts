import * as T from 'three';
import { createMuseOrb } from '../muse/three/orb';
import { MUSE_EMISSION } from './appearance';
import { jumpAt } from './motion';

/** Radius of the homepage Muse, in model units before the chapter scale. */
export const MUSE_RADIUS = 0.13;

/**
 * The FORGE Muse for the homepage journey: the 3D Nebula orb, carried along the camera
 * path. Chapter weights add a jump on the drafting table, extra glow in the dark manifesto
 * and a faster orbit at liftoff. Its eyes follow the camera, offset by the pointer.
 */
export function createMuseCharacter(random: () => number = Math.random) {
  const root = new T.Group();
  const turntable = new T.Group();
  const rig = new T.Group();
  root.add(turntable);
  turntable.add(rig);
  const orb = createMuseOrb({
    radius: MUSE_RADIUS,
    sparks: 5,
    motes: 22,
    emission: MUSE_EMISSION,
    random,
  });
  orb.root.position.y = 0.02;
  rig.add(orb.root);

  const look = new T.Vector3(),
    right = new T.Vector3(),
    up = new T.Vector3(),
    center = new T.Vector3();
  let bank = 0,
    launch = 0,
    wasAirborne = false,
    flightMood = false;

  function update(
    time: number,
    chapter: number,
    pointer: T.Vector2,
    chapterTime: number,
    delta = 0,
    camera?: T.Camera,
  ) {
    const dt = Math.min(0.1, Math.max(0, delta));
    const weight = (c: number) => Math.max(0, 1 - Math.abs(chapter - c));
    const table = weight(3),
      dark = weight(4),
      flight = weight(5);
    const jump = jumpAt(chapterTime);
    const airborne = table > 0.5 && jump.height > 0.002;
    if (airborne && !wasAirborne) orb.kick(0.35);
    if (!airborne && wasAirborne) orb.kick(-0.8);
    wasAirborne = airborne;
    if (flight > 0.5 !== flightMood) {
      flightMood = flight > 0.5;
      orb.setMood(flightMood ? 'building' : 'idle');
    }
    // Bank gently into the liftoff path; integrated so long sessions do not accumulate.
    bank += (-flight * 0.18 - bank) * (1 - Math.exp(-dt * 2));
    turntable.rotation.z = bank;
    // Liftoff: the Muse rises and flies off down the path, clearing the final copy.
    launch += ((flight > 0.5 ? 1 : 0) - launch) * (1 - Math.exp(-dt * 0.9));
    const away = launch * launch * (3 - 2 * launch);
    rig.position.y = Math.sin(time * 1.25) * 0.012 + table * jump.height + away * 0.2;
    rig.position.z = away * 0.95;
    rig.rotation.set(flight * 0.25, 0, Math.sin(time * 0.7) * 0.03);

    // Eyes on the camera, nudged by the pointer so the Muse watches the cursor.
    if (camera) {
      camera.getWorldPosition(look);
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      const distance = look.distanceTo(root.getWorldPosition(center));
      look.addScaledVector(right, pointer.x * distance * 0.45);
      look.addScaledVector(up, pointer.y * distance * 0.3);
    }
    orb.update(dt, {
      look: camera ? look : null,
      maxTurn: 0.85,
      boost: dark,
    });
  }
  return { root, update, orb, dispose: orb.dispose };
}
