import * as T from 'three';

const SIDES = 6;

/** A continuous tapered tube reuses its buffers as the pointer history moves. */
export function createPointerTrail(count: number, color: string) {
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(count * SIDES * 3), 3).setUsage(T.DynamicDrawUsage));
  geometry.setAttribute('normal', new T.BufferAttribute(new Float32Array(count * SIDES * 3), 3).setUsage(T.DynamicDrawUsage));
  const indices: number[] = [];
  for (let index = 0; index < count - 1; index++) {
    for (let side = 0; side < SIDES; side++) {
      const a = index * SIDES + side;
      const b = index * SIDES + (side + 1) % SIDES;
      indices.push(a, a + SIDES, b, b, a + SIDES, b + SIDES);
    }
  }
  geometry.setIndex(indices);
  const mesh = new T.Mesh(geometry, new T.MeshStandardMaterial({
    color,
    metalness: .72,
    roughness: .18,
    transparent: true,
    opacity: .58,
    depthWrite: false,
  }));
  mesh.frustumCulled = false;
  const tangent = new T.Vector3(), normal = new T.Vector3(), binormal = new T.Vector3();
  const surface = new T.Vector3(), vertex = new T.Vector3();

  function update(points: readonly T.Vector3[], view: T.Vector3, radius: number) {
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    points.forEach((point, index) => {
      tangent.subVectors(points[Math.max(0, index - 1)]!, points[Math.min(count - 1, index + 1)]!);
      if (tangent.lengthSq() < 1e-10) tangent.set(0, 1, 0);
      tangent.normalize();
      normal.crossVectors(tangent, view);
      if (normal.lengthSq() < 1e-10) {
        vertex.set(Math.abs(tangent.x) > .9 ? 0 : 1, Math.abs(tangent.x) > .9 ? 1 : 0, 0);
        normal.crossVectors(tangent, vertex);
      }
      normal.normalize();
      binormal.crossVectors(tangent, normal).normalize();
      const taper = radius * Math.pow(1 - index / count, 1.3);
      for (let side = 0; side < SIDES; side++) {
        const angle = side * Math.PI * 2 / SIDES;
        surface.copy(normal).multiplyScalar(Math.cos(angle)).addScaledVector(binormal, Math.sin(angle));
        vertex.copy(point).addScaledVector(surface, taper);
        const offset = index * SIDES + side;
        positions.setXYZ(offset, vertex.x, vertex.y, vertex.z);
        normals.setXYZ(offset, surface.x, surface.y, surface.z);
      }
    });
    positions.needsUpdate = normals.needsUpdate = true;
  }
  return { mesh, update };
}
