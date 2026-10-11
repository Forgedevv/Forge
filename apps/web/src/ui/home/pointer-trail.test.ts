import * as T from 'three';
import { describe, expect, it } from 'vitest';
import { createPointerTrail } from './pointer-trail';

describe('pointer trail geometry', () => {
  it('keeps finite positions and unit normals when the pointer is stationary', () => {
    const trail = createPointerTrail(18, '#9B5CFF');
    trail.update(Array.from({ length: 18 }, () => new T.Vector3(1, 2, 3)), new T.Vector3(0, 1, 0), .02);
    const { geometry, material } = trail.mesh;
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    for (let index = 0; index < positions.count; index++) {
      expect(Number.isFinite(positions.getX(index) + positions.getY(index) + positions.getZ(index))).toBe(true);
      expect(new T.Vector3().fromBufferAttribute(normals, index).length()).toBeCloseTo(1, 5);
    }
    geometry.dispose();
    material.dispose();
  });

  it('updates the existing buffers while following the pointer history and tapering the tail', () => {
    const trail = createPointerTrail(18, '#9B5CFF');
    const positions = trail.mesh.geometry.getAttribute('position');
    const points = Array.from({ length: 18 }, (_, index) => new T.Vector3(index * .1, 0, 0));
    trail.update(points, new T.Vector3(0, 0, -1), .03);
    const at = (index: number) => new T.Vector3().fromBufferAttribute(positions, index * 6);
    expect(at(0).distanceTo(points[0]!)).toBeCloseTo(.03);
    expect(at(17).distanceTo(points[17]!)).toBeLessThan(.002);
    points[0]!.set(2, 2, 0);
    trail.update(points, new T.Vector3(0, 0, -1), .03);
    expect(trail.mesh.geometry.getAttribute('position')).toBe(positions);
    expect(at(0).distanceTo(points[0]!)).toBeCloseTo(.03, 5);
    trail.mesh.geometry.dispose();
    trail.mesh.material.dispose();
  });

  it('keeps the tube open when its tangent is parallel to the viewing direction', () => {
    const trail = createPointerTrail(18, '#9B5CFF');
    const points = Array.from({ length: 18 }, (_, index) => new T.Vector3(index * .1, 0, 0));
    trail.update(points, new T.Vector3(1, 0, 0), .03);
    const normals = trail.mesh.geometry.getAttribute('normal');
    for (let index = 0; index < normals.count; index++) {
      expect(new T.Vector3().fromBufferAttribute(normals, index).length()).toBeCloseTo(1, 5);
    }
    trail.mesh.geometry.dispose();
    trail.mesh.material.dispose();
  });

  it('winds the faces outwards so the front-sided material renders from outside the tube', () => {
    const trail = createPointerTrail(18, '#9B5CFF');
    trail.update(Array.from({ length: 18 }, (_, index) => new T.Vector3(index * .1, 0, 0)), new T.Vector3(0, 0, -1), .03);
    const geometry = trail.mesh.geometry;
    const indices = geometry.getIndex()!;
    const positions = geometry.getAttribute('position');
    const a = new T.Vector3().fromBufferAttribute(positions, indices.getX(0));
    const b = new T.Vector3().fromBufferAttribute(positions, indices.getX(1));
    const c = new T.Vector3().fromBufferAttribute(positions, indices.getX(2));
    const outward = new T.Vector3().fromBufferAttribute(geometry.getAttribute('normal'), indices.getX(0));
    expect(b.sub(a).cross(c.sub(a)).dot(outward)).toBeGreaterThan(0);
    geometry.dispose();
    trail.mesh.material.dispose();
  });
});
