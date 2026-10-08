import { describe, expect, it } from 'vitest';
import { BufferGeometry, Material, Mesh, Vector2 } from 'three';
import { createCharacter } from './character';

function dispose(character: ReturnType<typeof createCharacter>) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  character.root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : [object.material];
    list.forEach((material: Material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

describe('character transitions', () => {
  it.each([1, 4])('does not accelerate chapter %i rotation after a long idle period', (chapter) => {
    const early = createCharacter(),
      late = createCharacter();
    const pointer = new Vector2();
    try {
      for (let i = 0; i <= 120; i++) {
        const appearance = chapter - 1 + Math.min(1, i / 60);
        early.update(i / 60, appearance, pointer, 0, 1 / 60);
        late.update(600 + i / 60, appearance, pointer, 0, 1 / 60);
        const earlyTurntable = early.root.children[0]!;
        const lateTurntable = late.root.children[0]!;
        expect(lateTurntable.rotation.z).toBeCloseTo(earlyTurntable.rotation.z, 10);
        expect(lateTurntable.children[0]!.rotation.y).toBeCloseTo(
          earlyTurntable.children[0]!.rotation.y,
          10,
        );
        expect(Math.abs(lateTurntable.children[0]!.rotation.y)).toBeLessThan(0.4);
      }
    } finally {
      dispose(early);
      dispose(late);
    }
  });
});
