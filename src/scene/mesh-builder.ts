import * as THREE from "three";
import type { ParsedOBJ } from "../types";

export interface GeometryArrays {
  positions: number[];
  uvs: number[];
  normals: number[];
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
 * Accumulates many draws' worth of geometry that share the same material
 * into one combined buffer, so it can be built into a single merged
 * THREE.Mesh instead of one Mesh per draw.
 *
 * This is the other half of the large-capture crash fix: rendering
 * thousands of individual Mesh objects means thousands of separate WebGL
 * draw calls and JS-side scene-graph overhead every frame. Merging by
 * material collapses a capture with e.g. 2500 draws sharing 40 textures
 * down to ~40 draw calls total.
 */
export class MaterialMergeGroup {
  private positions: number[] = [];
  private uvs: number[] = [];
  private normals: number[] = [];

  constructor(public readonly material: THREE.Material) {}

  add(data: GeometryArrays): void {
    // Plain loops rather than `arr.push(...data.positions)`: spreading a
    // large array as call arguments can hit the JS engine's argument-count
    // limit and throw on big meshes, so this avoids that entirely.
    for (let i = 0; i < data.positions.length; i++) this.positions.push(data.positions[i]);
    for (let i = 0; i < data.uvs.length; i++) this.uvs.push(data.uvs[i]);
    for (let i = 0; i < data.normals.length; i++) this.normals.push(data.normals[i]);
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  build(): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    return new THREE.Mesh(geometry, this.material);
  }
}

export class SceneMeshBuilder {
  private groups = new Map<string, MaterialMergeGroup>();

  addDraw(materialKey: string, material: THREE.Material, data: GeometryArrays): void {
    let group = this.groups.get(materialKey);
    if (!group) {
      group = new MaterialMergeGroup(material);
      this.groups.set(materialKey, group);
    }
    group.add(data);
  }

  get groupCount(): number {
    return this.groups.size;
  }

  get totalVertexCount(): number {
    let total = 0;
    for (const group of this.groups.values()) total += group.vertexCount;
    return total;
  }

  buildAll(): THREE.Mesh[] {
    return Array.from(this.groups.values()).map((group) => group.build());
  }
}
