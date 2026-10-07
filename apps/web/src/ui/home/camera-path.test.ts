import { describe, expect, it } from 'vitest';
import { CAMERA_PATH, chapterTransforms } from './camera-path';
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
      expect(frame.camera.fov).toBeGreaterThan(20);
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

  it('separates the chapter scenery origins', () => {
    const targets = chapterTransforms().map((t) => t.target);
    for (let i = 1; i < targets.length; i++)
      expect(targets[i]!.distanceTo(targets[i - 1]!)).toBeGreaterThan(4);
  });
});
