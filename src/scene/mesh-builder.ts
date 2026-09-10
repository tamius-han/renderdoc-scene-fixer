import * as THREE from "three";
import type { ParsedOBJ } from "../types";

export interface GeometryArrays {
  positions: number[];
  uvs: number[];
  normals: number[];
}

export interface Bounds {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/** Computes a bounding box directly from a flat position array (no Three.js
 * geometry/mesh needed) - used per-draw for the size filter, where creating
 * a throwaway THREE.Mesh just to measure it would be wasteful across
 * thousands of draws. */
export function computeBounds(positions: number[]): Bounds {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  return { min, max };
}

export function boundsDiagonal(b: Bounds): number {
  return b.max.clone().sub(b.min).length();
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: new THREE.Vector3(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z)),
    max: new THREE.Vector3(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z)),
  };
}

export function boundsCenter(b: Bounds): THREE.Vector3 {
  return new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
}

/** Expands an OBJ's face list into flat per-corner attribute arrays (one
 * vertex per face corner, all attributes aligned to the same index) - what a
 * non-indexed THREE.BufferGeometry needs, rather than OBJ's independent
 * per-attribute indexing. */
export function objToGeometryArrays(obj: ParsedOBJ): GeometryArrays {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];

  for (const tri of obj.faces) {
    for (const { v, t, n } of tri) {
      const p = obj.positions[v - 1] ?? [0, 0, 0];
      positions.push(p[0], p[1], p[2]);

      const uv = t !== undefined ? obj.uvs[t - 1] : undefined;
      uvs.push(uv ? uv[0] : 0, uv ? uv[1] : 0);

      const normal = n !== undefined ? obj.normals[n - 1] : undefined;
      normals.push(normal ? normal[0] : 0, normal ? normal[1] : 0, normal ? normal[2] : 1);
    }
  }

  return { positions, uvs, normals };
}

/**
 * Builds one real THREE.Mesh per draw so raycasting and object picking map
 * correctly back to the underlying draw index. Merged material groups were
 * convenient for draw-call counts, but they broke selection because a click on
 * one object could resolve to the wrong draw when multiple objects shared a
 * material. */
export class MaterialMergeGroup {
  constructor(public readonly material: THREE.Material) {}

  add(_drawIndex: number, _data: GeometryArrays): void {
    // Kept for compatibility with older call sites; not used by the current
    // per-draw mesh selection behavior.
  }

  get vertexCount(): number {
    return 0;
  }

  build(): THREE.Mesh {
    return new THREE.Mesh(new THREE.BufferGeometry(), this.material);
  }
}

export class SceneMeshBuilder {
  private draws: Array<{ material: THREE.Material; data: GeometryArrays; drawIndex: number }> = [];

  addDraw(materialKey: string, material: THREE.Material, data: GeometryArrays, drawIndex: number): void {
    void materialKey;
    this.draws.push({ material, data, drawIndex });
  }

  get groupCount(): number {
    return this.draws.length;
  }

  get totalVertexCount(): number {
    let total = 0;
    for (const entry of this.draws) total += entry.data.positions.length / 3;
    return total;
  }

  buildAll(): THREE.Mesh[] {
    return this.draws.map(({ material, data, drawIndex }) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.positions, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(data.uvs, 2));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(data.normals, 3));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.drawIndices = [drawIndex];
      return mesh;
    });
  }
}
