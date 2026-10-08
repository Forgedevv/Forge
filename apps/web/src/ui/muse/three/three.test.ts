import { describe, expect, it } from 'vitest';
import { Mesh, Object3D, Vector3 } from 'three';
import { createMuseOrb } from './orb';
import { createMuseFigure } from './figure';
import { createSparkTexture } from './textures';

function seeded(seed = 3) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
function finite(object: Object3D) {
  let ok = true;
  object.traverse((child) => {
    for (const v of [child.position, child.scale])
      if (![v.x, v.y, v.z].every(Number.isFinite)) ok = false;
    if (![child.rotation.x, child.rotation.y, child.rotation.z].every(Number.isFinite)) ok = false;
  });
  return ok;
}
/** The face group: the orb body's only group child, which carries the eyes. */
const faceOf = (orb: ReturnType<typeof createMuseOrb>) =>
  orb.body.children.find((child) => !(child instanceof Mesh))!;

describe('3D Muse orb', () => {
  it('turns its eyes towards the look target, within its range', () => {
    const orb = createMuseOrb({ radius: 1, random: seeded() });
    try {
      for (let i = 0; i < 120; i++) orb.update(1 / 60, { look: new Vector3(5, 0, 5) });
      const face = faceOf(orb);
      expect(face.rotation.y).toBeGreaterThan(0.6);
      expect(face.rotation.y).toBeLessThanOrEqual(0.75 + 1e-6);
      for (let i = 0; i < 120; i++)
        orb.update(1 / 60, { look: new Vector3(-50, 0, -1), maxTurn: 0.5 });
      expect(face.rotation.y).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(finite(orb.root)).toBe(true);
    } finally {
      orb.dispose();
    }
  });

  it('switches to spark eyes when a launch succeeds', () => {
    const orb = createMuseOrb({ random: seeded() });
    try {
      orb.setMood('success');
      for (let i = 0; i < 90; i++) orb.update(1 / 60, { look: null });
      const sparks = faceOf(orb).children.flatMap((socket) => socket.children);
      expect(
        sparks.some((child) => child instanceof Mesh && child.visible && child.scale.x > 0.5),
      ).toBe(true);
    } finally {
      orb.dispose();
    }
  });

  it('draws the four-point spark with a solid core and transparent corners', () => {
    const texture = createSparkTexture(64);
    const data = texture.image.data as Uint8Array;
    const alphaAt = (x: number, y: number) => data[(y * 64 + x) * 4 + 3]!;
    expect(alphaAt(32, 32)).toBe(255);
    expect(alphaAt(32, 24)).toBe(255);
    expect(alphaAt(22, 22)).toBeLessThan(alphaAt(32, 22));
    expect(alphaAt(2, 2)).toBe(0);
    texture.dispose();
  });
});

describe('3D Muse figure', () => {
  it('plays the same pose at 30 and 120 frames per second', () => {
    const slow = createMuseFigure({ random: seeded() }),
      fast = createMuseFigure({ random: seeded() });
    try {
      for (const figure of [slow, fast]) figure.setAction('building');
      for (let i = 0; i < 60; i++) slow.update(1 / 30, { look: null });
      for (let i = 0; i < 240; i++) fast.update(1 / 120, { look: null });
      const shoulders = (figure: typeof slow) => {
        const values: number[] = [];
        figure.root.traverse((child) => {
          if (child.children.length === 2 && child.position.y > 0.4)
            values.push(child.rotation.x, child.rotation.z);
        });
        return values;
      };
      const a = shoulders(slow),
        b = shoulders(fast);
      expect(a.length).toBeGreaterThan(0);
      a.forEach((value, i) => expect(Math.abs(value - b[i]!)).toBeLessThan(0.05));
    } finally {
      slow.dispose();
      fast.dispose();
    }
  });

  it('waves, hops and stays finite through every action', () => {
    const figure = createMuseFigure({ random: seeded() });
    try {
      figure.wave();
      let highest = 0;
      for (const action of ['welcome', 'building', 'live', 'idle'] as const) {
        figure.setAction(action);
        for (let i = 0; i < 240; i++) {
          figure.update(1 / 60, { look: new Vector3(1, 1, 3) });
          highest = Math.max(highest, figure.lift());
        }
        expect(finite(figure.root)).toBe(true);
      }
      expect(highest).toBeGreaterThan(0.1);
      expect(figure.lift()).toBeLessThan(0.25);
    } finally {
      figure.dispose();
    }
  });
});
