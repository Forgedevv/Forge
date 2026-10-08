import { describe, expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, Vector2 } from 'three';
import { createMuseCharacter } from './muse-character';

function seeded(seed = 11) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe('homepage Muse', () => {
  it.each([4, 5])('does not drift in chapter %i after a long idle period', (chapter) => {
    const early = createMuseCharacter(seeded()),
      late = createMuseCharacter(seeded());
    const pointer = new Vector2();
    try {
      for (let i = 0; i <= 240; i++) {
        const appearance = chapter - 1 + Math.min(1, i / 60);
        early.update(i / 60, appearance, pointer, 0, 1 / 60);
        late.update(600 + i / 60, appearance, pointer, 0, 1 / 60);
        const a = early.root.children[0]!,
          b = late.root.children[0]!;
        expect(b.rotation.z).toBeCloseTo(a.rotation.z, 10);
        expect(b.children[0]!.position.z).toBeCloseTo(a.children[0]!.position.z, 10);
        expect(Math.abs(b.rotation.z)).toBeLessThan(0.25);
      }
    } finally {
      early.dispose();
      late.dispose();
    }
  });

  it('turns its face towards the camera and the pointer', () => {
    const muse = createMuseCharacter(seeded());
    const camera = new PerspectiveCamera();
    camera.position.set(2, 0, 3);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    try {
      for (let i = 0; i < 180; i++) muse.update(i / 60, 0, new Vector2(0.5, 0), 0, 1 / 60, camera);
      const face = muse.orb.body.children.find((child) => !(child instanceof Mesh))!;
      expect(face.rotation.y).toBeGreaterThan(0.4);
    } finally {
      muse.dispose();
    }
  });
});
