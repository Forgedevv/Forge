import * as T from 'three';
import { createMuseFigure } from '../muse/three/figure';
import { jumpAt } from './motion';

/** Radius of the homepage Muse's head, in model units before the chapter scale. */
export const MUSE_RADIUS = 0.075;

/** The figure model is about 1.72 units tall with a 0.36 head; this fits it to the journey. */
const FIGURE_SCALE = MUSE_RADIUS / 0.36;
/** Keeps the figure centred where the orb used to float, so the camera path still frames it. */
const FIGURE_OFFSET = -0.95 * FIGURE_SCALE + 0.02;

/**
 * The FORGE Muse for the homepage journey: the full-body figure, carried along the camera
 * path. It waves hello at the start, jumps on the drafting table, and raises its arms and
 * flies off at liftoff. Its eyes follow the camera, offset by the pointer.
 */
export function createMuseCharacter(random: () => number = Math.random) {
  const root = new T.Group();
  const turntable = new T.Group();
  const rig = new T.Group();
  root.add(turntable);
  turntable.add(rig);
  const figure = createMuseFigure({ random });
  figure.root.scale.setScalar(FIGURE_SCALE);
  figure.root.position.y = FIGURE_OFFSET;
  rig.add(figure.root);

  const look = new T.Vector3(),
    right = new T.Vector3(),
    up = new T.Vector3(),
    center = new T.Vector3();
  let bank = 0,
    launch = 0,
    wasAirborne = false,
    waved = false,
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
      flight = weight(5);
    if (!waved && time > 0.8) {
      waved = true;
      figure.wave();
    }
    const jump = jumpAt(chapterTime);
    const airborne = table > 0.5 && jump.height > 0.002;
    if (airborne && !wasAirborne) figure.head.kick(0.35);
    if (!airborne && wasAirborne) figure.head.kick(-0.8);
    wasAirborne = airborne;
    if (flight > 0.5 !== flightMood) {
      flightMood = flight > 0.5;
      figure.setAction(flightMood ? 'live' : 'idle');
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
    figure.update(dt, { look: camera ? look : null });
  }
  return { root, update, orb: figure.head, figure, dispose: figure.dispose };
}
