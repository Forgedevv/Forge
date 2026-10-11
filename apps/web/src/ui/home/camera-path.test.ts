import { describe, expect, it } from 'vitest';
import { CAMERA_PATH, chapterTransforms } from './camera-path';
import * as T from 'three';
import { createCharacter } from './character';
import { CHAPTER_COUNT } from './motion';

describe('camera path', () => {
  it('defines one finite frame per chapter', () => {
    expect(CAMERA_PATH).toHaveLength(CHAPTER_COUNT);
    for (const frame of CAMERA_PATH) {
      const values = [
        ...frame.camera.position,
        frame.camera.roll,
        frame.camera.fov,
        ...frame.target,
        ...frame.character.position,
        ...frame.character.rotationDegrees,
        frame.character.scale,
        frame.mobileFovOffset,
      ];
      values.forEach((value) => expect(Number.isFinite(value)).toBe(true));
      expect(frame.camera.fov).toBeGreaterThan(5);
      expect(frame.camera.fov + frame.mobileFovOffset).toBeLessThan(90);
      expect(frame.character.scale).toBeGreaterThan(0);
    }
  });

  it('keeps the camera clear of the pilot and the pilot near its scenery', () => {
    for (const t of chapterTransforms()) {
      expect(t.camera.distanceTo(t.position)).toBeGreaterThan(2);
      expect(t.position.distanceTo(t.target)).toBeLessThan(1.5);
      expect(t.quaternion.length()).toBeCloseTo(1, 10);
    }
  });

  it('keeps the opening dolly, dark descent and distant workshop view distinct', () => {
    const transforms = chapterTransforms();
    expect(transforms[0]!.target.distanceTo(transforms[1]!.target)).toBeLessThan(2);
    expect(transforms[1]!.camera.z - transforms[0]!.camera.z).toBeGreaterThan(3);
    expect(transforms[1]!.camera.y - transforms[2]!.camera.y).toBeGreaterThan(10);
    expect(transforms[3]!.camera.distanceTo(transforms[3]!.target)).toBeGreaterThan(25);
    expect(transforms[3]!.fov).toBeLessThan(20);
  });

  it('grounds the local pilot on the workshop grid before its jump animation', () => {
    const { root } = createCharacter();
    const transform = chapterTransforms()[3]!;
    root.position.copy(transform.position);
    root.quaternion.copy(transform.quaternion);
    root.scale.setScalar(transform.scale);
    const bounds = new T.Box3().setFromObject(root);
    expect(bounds.min.y).toBeCloseTo(transform.target.y - 1.18, 2);
  });
});
