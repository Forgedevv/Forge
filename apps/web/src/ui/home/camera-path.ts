import * as T from 'three';

/** A point in world units, as [x, y, z]. */
export type Vec3Tuple = readonly [number, number, number];

/**
 * One chapter of the original FORGE camera journey.
 *
 * The path starts low in front of the pilot, slides to the right for the glass chapter,
 * drops down to the launchpad wall, rises over it onto a distant drafting table, climbs
 * into orbit, and finally banks away behind the pilot for liftoff.
 */
export interface ChapterFrame {
  camera: {
    /** Camera position in world units. */
    position: Vec3Tuple;
    /** Roll around the viewing axis in radians, applied after aiming at the target. */
    roll: number;
    /** Vertical field of view in degrees. */
    fov: number;
  };
  /** World point the camera looks at; the chapter scenery is centered here. */
  target: Vec3Tuple;
  character: {
    position: Vec3Tuple;
    /** Euler angles in degrees, [pitch, yaw, roll], applied in YXZ order. */
    rotationDegrees: Vec3Tuple;
    /** Uniform scale of the pilot model. */
    scale: number;
  };
  /** Extra field of view, in degrees, blended in on portrait screens. */
  mobileFovOffset: number;
}

export const CAMERA_PATH: readonly ChapterFrame[] = [
  // Ignition: a low, slightly off-axis hero view of the pilot in front of the title.
  {
    camera: { position: [0.55, -0.25, 3.1], roll: 0, fov: 40 },
    target: [0, 0, 0],
    character: { position: [-0.18, -0.12, 0.55], rotationDegrees: [-5, 24, 3], scale: 1.9 },
    mobileFovOffset: 22,
  },
  // Your world: the camera slides right; the glass pilot sits left of the title.
  {
    camera: { position: [4.8, 1.25, 1.3], roll: -0.025, fov: 42 },
    target: [3.4, 0.9, -3],
    character: { position: [2.65, 0.6, -2.1], rotationDegrees: [8, -32, -6], scale: 3.1 },
    mobileFovOffset: 26,
  },
  // The workshop: a raised view over the pilot's shoulder towards the display wall.
  {
    camera: { position: [-0.5, -5.05, -2.3], roll: 0.02, fov: 40 },
    target: [0.4, -6, -6.5],
    character: { position: [0.65, -6.55, -5.6], rotationDegrees: [-4, 162, 2], scale: 2.2 },
    mobileFovOffset: 16,
  },
  // Built together: a high three-quarter view of the drafting table; the pilot stands on it.
  {
    camera: { position: [0.1, 0.4, -23.6], roll: 0, fov: 34 },
    target: [-3.5, -4.2, -31],
    character: { position: [-3.3, -4.46, -30.4], rotationDegrees: [0, 34, 0], scale: 3.4 },
    mobileFovOffset: 12,
  },
  // Your rules: a slightly low view of the pilot centered in the orbiting manifesto.
  {
    camera: { position: [3.7, 2.9, -32.7], roll: 0.035, fov: 50 },
    target: [4.5, 3.8, -38],
    character: { position: [4.6, 3.7, -37.6], rotationDegrees: [6, -18, 8], scale: 2.9 },
    mobileFovOffset: 22,
  },
  // Liftoff: a banked chase view behind the pilot, looking down the flight path.
  {
    camera: { position: [-6.6, 10.3, -44.8], roll: -0.05, fov: 52 },
    target: [-5, 9, -50],
    character: { position: [-4.6, 8.8, -49.2], rotationDegrees: [-6, 205, -12], scale: 3.2 },
    mobileFovOffset: 24,
  },
];

/** Distance from the camera, along its view, at which the intro wall is assembled. */
export const INTRO_WALL_DISTANCE = 2.2;

export interface ChapterTransform {
  camera: T.Vector3;
  roll: number;
  target: T.Vector3;
  position: T.Vector3;
  quaternion: T.Quaternion;
  scale: number;
  fov: number;
  portraitFov: number;
}

const toRadians = T.MathUtils.degToRad;

/** Converts the authored path into the Three.js values the renderer interpolates. */
export function chapterTransforms(path: readonly ChapterFrame[] = CAMERA_PATH): ChapterTransform[] {
  return path.map((frame) => {
    const [pitch, yaw, roll] = frame.character.rotationDegrees;
    return {
      camera: new T.Vector3(...frame.camera.position),
      roll: frame.camera.roll,
      target: new T.Vector3(...frame.target),
      position: new T.Vector3(...frame.character.position),
      quaternion: new T.Quaternion().setFromEuler(
        new T.Euler(toRadians(pitch), toRadians(yaw), toRadians(roll), 'YXZ'),
      ),
      scale: frame.character.scale,
      fov: frame.camera.fov,
      portraitFov: frame.mobileFovOffset,
    };
  });
}
