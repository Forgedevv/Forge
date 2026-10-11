import * as T from 'three';

/** A point in world units, as [x, y, z]. */
export type Vec3Tuple = readonly [number, number, number];

/**
 * One chapter of the measured reference camera choreography.
 *
 * Technical camera landmarks were inspected from the public scene metadata. The sequence
 * pulls back from the hero, descends to the display wall, pulls far above the workshop,
 * moves into the orbit, and finishes on a diagonal flight view. All scene artwork is local.
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
  // The hero and glass scene share a focus; the first move is a dolly backwards.
  {
    camera: { position: [0, 1.047, 2.525], roll: 0, fov: 37.3 },
    target: [0, 1.05, .189],
    character: { position: [-.057, 1.110, -.143], rotationDegrees: [-12.79, -39.19, -4.36], scale: 2.07 },
    mobileFovOffset: 25,
  },
  // Glass: a larger pilot and a wider view of the moving type field.
  {
    camera: { position: [0, .910, 5.945], roll: 0, fov: 37.3 },
    target: [0, 1.05, 1.377],
    character: { position: [-.293, 1.031, 1.210], rotationDegrees: [-33.13, 60.82, .32], scale: 4.144 },
    mobileFovOffset: 30,
  },
  // Display wall: descend into the dark scene and look past the pilot at the screens.
  {
    camera: { position: [0, -11.603, 5.758], roll: 0, fov: 36.975 },
    target: [0, -10.705, 1.185],
    character: { position: [.06, -11.285, .712], rotationDegrees: [0, 180, 0], scale: 2.548 },
    mobileFovOffset: 18,
  },
  // Workshop: a distant, narrow-lens view opens the drafting table below the camera.
  {
    camera: { position: [3.807, 5.960, 40.957], roll: 0, fov: 11.563 },
    target: [-.904, -10.264, 13.898],
    // Lift the local pilot so its boots rest on the drafting grid at target.y - 1.18.
    character: { position: [-1.149, -10.012, 13.740], rotationDegrees: [0, -54.42, 0], scale: 5.265 },
    mobileFovOffset: 5,
  },
  // Orbit: move close again, with the pilot and text ring seen from the side.
  {
    camera: { position: [-2.633, -6.775, 18.023], roll: 0, fov: 58.715 },
    target: [-.515, -6.709, 15.164],
    character: { position: [-1.130, -6.458, 15.835], rotationDegrees: [-18.43, -131.5, -3.37], scale: 3.149 },
    mobileFovOffset: 30,
  },
  // Flight: a diagonal view along the launch direction.
  {
    camera: { position: [-5.978, -6.090, 13.965], roll: 0, fov: 58.715 },
    target: [-8.328, -3.752, 7.121],
    character: { position: [-8.833, -3.570, 7.270], rotationDegrees: [-20.33, -119.23, -12.63], scale: 5.659 },
    mobileFovOffset: 30,
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

/** Converts the measured landmarks into the Three.js values the renderer interpolates. */
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
