import * as THREE from "three";
import { trianglesIntersect } from "fast-triangle-triangle-intersection";
import type { GeometryArrays } from "../scene/mesh-builder";

/** TypeScript/THREE.js migration of the old mesh-tools/fill.js. That file
 * operated on OBJ-style 1-based `{ vertices, faces }` objects and leaned on
 * a pile of hand-rolled vector/triangle math (plain-array cross/dot
 * products, a from-scratch 2D/3D triangle-triangle SAT test, manual
 * bounding-box arrays...). This version works directly on this app's own
 * GeometryArrays (see mesh-builder.ts - the same flat, non-indexed,
 * per-face-corner format every draw is already loaded into), and replaces
 * that hand-rolled math with THREE.js equivalents wherever one exists:
 * THREE.Vector3 for point/centroid arithmetic, THREE.Box3 for bounding-box
 * overlap, THREE.BufferGeometry.computeVertexNormals() for the filled
 * result's normals (rather than the original never actually assigning
 * normals to its new centroid-fan triangles), and the already-installed
 * fast-triangle-triangle-intersection package (also THREE.Triangle-based,
 * and already used elsewhere in this app - see app.ts's select-by-volume
 * code) for the actual self-intersection test, instead of the ~90 lines of
 * hand-rolled 2D/3D separating-axis code the original had
 * (trianglesIntersect_old/tri2dIntersect/sub2D/dot2D/projectTri2D - all
 * deleted, not ported).
 *
 * Not ported: collectIntersectingTriangles()/buildIntersectionObject() -
 * these built a standalone "debug mesh" of just the intersecting
 * triangles, but were never actually called by groupFixedMeshes_safe() or
 * anything else in the original file. Nothing in this project's export
 * pipeline needs them; they can be added back if that changes. */

// ---- Indexed intermediate representation --------------------------------

/** Vertex-indexed mesh (0-based, THREE.Vector3 positions) - the shape the
 * topology-aware operations below (loose-part splitting, boundary-edge/
 * hole detection, manifold checking) all need, since GeometryArrays' flat
 * per-corner layout has no shared vertices to reason about at all (every
 * face has its own private copy of each of its corners). Not exported -
 * splitGeometryByLooseParts()/groupFixedMeshes() are the public surface,
 * both taking/returning plain GeometryArrays so callers never need to know
 * this representation exists. */
interface IndexedMesh {
  positions: THREE.Vector3[];
  uvs: [number, number][];
  faces: [number, number, number][];
}

/** Heuristic for "does this geometry actually have a UV map": true unless
 * every single UV coordinate is exactly (0,0), which is what
 * objToGeometryArrays() produces for a corner with no `vt` data at all (see
 * that function). A real UV map could in principle put every vertex at the
 * texture origin, but that's vanishingly unlikely for real capture data, so
 * "all zero" is treated as "no UV map" throughout this file. */
function hasUVMap(uvs: number[]): boolean {
  for (let i = 0; i < uvs.length; i++) {
    if (uvs[i] !== 0) return true;
  }
  return false;
}

function positionKeyOf(p: THREE.Vector3): string {
  return `${p.x},${p.y},${p.z}`;
}

/** When a UV map is present, toIndexedMesh() below deliberately keeps
 * vertices that share a 3D position but disagree on UV (e.g. the two sides
 * of a texture seam) as separate indexed vertices, rather than merging them
 * and silently discarding one side's UV. Left alone, that means every UV
 * seam looks like a genuine mesh boundary to the topology-aware operations
 * in this file (findBoundaryEdges()/splitByLooseParts()): each seam-side
 * triangle no longer shares a vertex index with the triangle across the
 * seam at all, so splitByLooseParts() would cut one continuous surface into
 * separate "loose parts" at every seam, and findBoundaryEdges() would treat
 * every seam as a hole to fill.
 *
 * This bridges that gap without merging anything: for every pair of
 * boundary edges that sit at the exact same two 3D positions (the seam's
 * two mirrored edges, one per side), it adds two zero-width triangles -
 * degenerate triangles with two corners coincident in 3D and differing only
 * in UV - stitching the two sides back together. That turns both original
 * edges from boundary (used by one face) into interior (used by two), and
 * links the two sides' vertices into one connected component, purely to
 * give the adjacency/edge-sharing checks something to walk across. The two
 * new "cross-seam" edges these triangles also introduce are themselves
 * zero-length and only ever touched once each, so buildEdgeLoops() below
 * naturally discards them (they can only ever form a 2-vertex loop, and it
 * requires at least 3 to count as a hole). Groups that don't pair up
 * exactly one-to-one (a T-junction, or a genuine hole that happens to share
 * a position with something else) are left untouched as real boundary
 * edges rather than guessed at. */
function bridgeUVSeams(positions: THREE.Vector3[], faces: [number, number, number][]): void {
  const edgeCount = new Map<string, number>();
  for (const face of faces) {
    for (let i = 0; i < 3; i++) {
      const a = face[i];
      const b = face[(i + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }

  const boundaryEdges: [number, number][] = [];
  for (const [key, count] of edgeCount) {
    if (count === 1) {
      const [a, b] = key.split(",").map(Number);
      boundaryEdges.push([a, b]);
    }
  }
  if (boundaryEdges.length === 0) return;

  const groups = new Map<string, [number, number][]>();
  for (const edge of boundaryEdges) {
    const pa = positionKeyOf(positions[edge[0]]);
    const pb = positionKeyOf(positions[edge[1]]);
    const key = pa < pb ? `${pa}|${pb}` : `${pb}|${pa}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(edge);
  }

  for (const edges of groups.values()) {
    if (edges.length !== 2) continue; // Not a simple two-sided seam - leave as a real boundary.
    const [[a1, b1], edge2] = edges;
    // Orient edge2 so its first vertex sits at a1's position (edges in a
    // matched pair share the same two 3D positions, in one order or the
    // other).
    const [a2, b2] =
      positions[a1].distanceToSquared(positions[edge2[0]]) <= positions[a1].distanceToSquared(positions[edge2[1]])
        ? edge2
        : [edge2[1], edge2[0]];
    faces.push([a1, a2, b2]); // a1 and a2 coincide in 3D -> zero-width.
    faces.push([a1, b2, b1]); // b1 and b2 coincide in 3D -> zero-width.
  }
}

/** Merges vertices to build an IndexedMesh from this app's standard flat/
 * non-indexed GeometryArrays. Without a UV map, this merges purely by
 * coincident position (exact match, like parsers/obj.ts's dedupeVerts()).
 * With one, positions are only merged when their UV also matches - a
 * position-only merge would collapse a texture seam's two different UVs
 * into one, corrupting the UV map - and bridgeUVSeams() (above) separately
 * patches the topology-analysis side effects of keeping those seam
 * vertices apart. */
function toIndexedMesh(data: GeometryArrays): IndexedMesh {
  const uvMapPresent = hasUVMap(data.uvs);
  const positions: THREE.Vector3[] = [];
  const uvs: [number, number][] = [];
  const faces: [number, number, number][] = [];
  const indexByKey = new Map<string, number>();

  const vertexCount = data.positions.length / 3;
  const localIndex: number[] = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const x = data.positions[i * 3];
    const y = data.positions[i * 3 + 1];
    const z = data.positions[i * 3 + 2];
    const u = data.uvs[i * 2] ?? 0;
    const v = data.uvs[i * 2 + 1] ?? 0;
    const key = uvMapPresent ? `${x},${y},${z}|${u},${v}` : `${x},${y},${z}`;
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = positions.length;
      indexByKey.set(key, idx);
      positions.push(new THREE.Vector3(x, y, z));
      uvs.push([u, v]);
    }
    localIndex[i] = idx;
  }

  for (let i = 0; i + 2 < vertexCount; i += 3) {
    faces.push([localIndex[i], localIndex[i + 1], localIndex[i + 2]]);
  }

  if (uvMapPresent) bridgeUVSeams(positions, faces);

  return { positions, uvs, faces };
}

/** Inverse of toIndexedMesh(): expands back into flat per-corner
 * GeometryArrays. Normals are recomputed from scratch via THREE's own
 * BufferGeometry.computeVertexNormals() rather than threaded through from
 * the original mesh - hole-filling adds brand-new triangles (the centroid
 * fan) that never had source normals to carry forward anyway, so
 * recomputing once at the end is both simpler and correct for the new
 * geometry as a whole. */
function toGeometryArrays(mesh: IndexedMesh): GeometryArrays {
  const positions: number[] = [];
  const uvs: number[] = [];

  for (const face of mesh.faces) {
    for (const vi of face) {
      const p = mesh.positions[vi];
      positions.push(p.x, p.y, p.z);
      const uv = mesh.uvs[vi] ?? [0, 0];
      uvs.push(uv[0], uv[1]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const normals = Array.from(geometry.getAttribute("normal").array as Float32Array);

  return { positions, uvs, normals };
}

// ---- Loose-part splitting -------------------------------------------------

/** Connected-components split by shared (deduped) vertex - same algorithm
 * as parsers/obj.ts's groupByLooseParts(), applied to geometry that's
 * already loaded into memory (see toIndexedMesh()) rather than raw OBJ
 * text, since the export pipeline (see handleStartExport() in app.ts)
 * already has the draw's GeometryArrays in hand and has no OBJ text to
 * re-parse. */
function splitByLooseParts(mesh: IndexedMesh): IndexedMesh[] {
  const vertexToFaces = new Map<number, number[]>();
  mesh.faces.forEach((face, fi) => {
    for (const v of face) {
      if (!vertexToFaces.has(v)) vertexToFaces.set(v, []);
      vertexToFaces.get(v)!.push(fi);
    }
  });

  const visited = new Set<number>();
  const parts: IndexedMesh[] = [];

  for (let i = 0; i < mesh.faces.length; i++) {
    if (visited.has(i)) continue;

    const queue = [i];
    const partFaceIndices: number[] = [];
    while (queue.length > 0) {
      const fi = queue.pop()!;
      if (visited.has(fi)) continue;
      visited.add(fi);
      partFaceIndices.push(fi);
      for (const v of mesh.faces[fi]) {
        for (const neighbor of vertexToFaces.get(v) ?? []) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
    }

    const localIndex = new Map<number, number>();
    const positions: THREE.Vector3[] = [];
    const uvs: [number, number][] = [];
    const faces: [number, number, number][] = partFaceIndices.map((fi) => {
      const remapped = mesh.faces[fi].map((v) => {
        let local = localIndex.get(v);
        if (local === undefined) {
          local = positions.length;
          localIndex.set(v, local);
          positions.push(mesh.positions[v]);
          uvs.push(mesh.uvs[v]);
        }
        return local;
      });
      return remapped as [number, number, number];
    });

    parts.push({ positions, uvs, faces });
  }

  return parts;
}

/** Splits this app's standard GeometryArrays into one GeometryArrays per
 * connected ("loose") part - the TypeScript/GeometryArrays counterpart of
 * parsers/obj.ts's splitObj() (which does the same split, but starting
 * from raw OBJ text at import time via groupByLooseParts()). Used by the
 * "split by loose parts" export option - see handleStartExport() in
 * app.ts. */
export function splitGeometryByLooseParts(geometry: GeometryArrays): GeometryArrays[] {
  return splitByLooseParts(toIndexedMesh(geometry)).map(toGeometryArrays);
}

// ---- Hole detection & filling ---------------------------------------------

function findBoundaryEdges(faces: [number, number, number][]): [number, number][] {
  const edgeCount = new Map<string, number>();
  for (const face of faces) {
    for (let i = 0; i < 3; i++) {
      const a = face[i];
      const b = face[(i + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }

  // Edges used by exactly one face are boundary edges - anything shared by
  // two faces is an ordinary interior edge, and (for well-formed input) an
  // edge is never used by more than two.
  const boundary: [number, number][] = [];
  for (const [key, count] of edgeCount) {
    if (count === 1) {
      const [a, b] = key.split(",").map(Number);
      boundary.push([a, b]);
    }
  }
  return boundary;
}

function buildEdgeLoops(boundaryEdges: [number, number][]): number[][] {
  const adjacency = new Map<number, number[]>();
  for (const [a, b] of boundaryEdges) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a)!.push(b);
    adjacency.get(b)!.push(a);
  }

  const loops: number[][] = [];
  const visited = new Set<number>();

  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;

    const loop: number[] = [];
    let current: number | null = start;
    let prev: number | null = null;
    while (current !== null && !visited.has(current)) {
      loop.push(current);
      visited.add(current);
      const neighbors: number[] = adjacency.get(current)!.filter((v: number) => v !== prev);
      if (neighbors.length > 0) {
        prev = current;
        current = neighbors[0];
      } else {
        current = null;
      }
    }
    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

/** PCA "is this basically a flat sheet" check, used to skip hole detection
 * on genuinely flat/thin geometry (e.g. a billboard or decal), where every
 * edge is technically a "boundary edge" but none of them are a hole to
 * fill. Same analytic eigenvalue solve as the original (three.js has no
 * general eigensolver to swap in for that part), but the centroid/
 * deviation arithmetic now goes through THREE.Vector3 instead of manual
 * per-component arrays. */
function isMeshThinOrFlat(positions: THREE.Vector3[], threshold = 0.0125): boolean {
  if (positions.length < 3) return true;

  const centroid = new THREE.Vector3();
  for (const p of positions) centroid.add(p);
  centroid.divideScalar(positions.length);

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  const d = new THREE.Vector3();
  for (const p of positions) {
    d.subVectors(p, centroid);
    xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z;
    yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
  }
  const n = positions.length;
  xx /= n; xy /= n; xz /= n; yy /= n; yz /= n; zz /= n;

  const p1 = xy ** 2 + xz ** 2 + yz ** 2;
  if (p1 === 0) {
    // Diagonal covariance matrix - eigenvalues are just the diagonal.
    const eig = [xx, yy, zz].sort((a, b) => b - a);
    return eig[2] / eig[0] < threshold;
  }

  const q = (xx + yy + zz) / 3;
  const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const b00 = (xx - q) / p, b11 = (yy - q) / p, b22 = (zz - q) / p;
  const b01 = xy / p, b02 = xz / p, b12 = yz / p;
  const r =
    (b00 * b11 * b22 + 2 * b01 * b02 * b12 - b00 * b12 ** 2 - b11 * b02 ** 2 - b22 * b01 ** 2) / 2;
  const phi = Math.acos(Math.max(-1, Math.min(1, r))) / 3;
  const eig1 = q + 2 * p * Math.cos(phi);
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const eig2 = 3 * q - eig1 - eig3;
  const eigenvalues = [eig1, eig2, eig3].sort((a, b) => b - a);
  return eigenvalues[2] / eigenvalues[0] < threshold;
}

function detectEdgeLoops(mesh: IndexedMesh): number[][] {
  if (isMeshThinOrFlat(mesh.positions)) return [];
  const boundary = findBoundaryEdges(mesh.faces);
  if (boundary.length === 0) return [];
  return buildEdgeLoops(boundary);
}

function findNeighborFace(
  faces: [number, number, number][],
  v0: number,
  v1: number,
): [number, number, number] | null {
  for (const face of faces) {
    if (face.includes(v0) && face.includes(v1)) return face;
  }
  return null;
}

function averageUV(mesh: IndexedMesh, loop: number[]): [number, number] {
  let u = 0;
  let v = 0;
  for (const idx of loop) {
    u += mesh.uvs[idx][0];
    v += mesh.uvs[idx][1];
  }
  return [u / loop.length, v / loop.length];
}

/** Triangulates one boundary loop with a centroid fan: adds one new vertex
 * at the loop's average position (reusing an existing vertex there
 * instead, if one already happens to sit exactly at that point), then one
 * triangle per loop edge connecting it back to that centroid, oriented to
 * match whichever existing face that edge already borders (falling back
 * to a fixed winding if the edge somehow borders none, which shouldn't
 * happen for a genuine boundary edge). Cheap and robust for the typically
 * small, roughly planar holes this app's captures produce - not
 * guaranteed non-self-intersecting on a very non-planar loop, which is
 * exactly what groupFixedMeshes()'s own hasSelfIntersections() check
 * below is for. Mutates `mesh` in place (pushing the new vertex/faces). */
function fillEdgeLoopFan(mesh: IndexedMesh, loop: number[]): boolean {
  if (loop.length < 3) return false;

  const centroid = new THREE.Vector3();
  for (const idx of loop) centroid.add(mesh.positions[idx]);
  centroid.divideScalar(loop.length);

  let centroidIndex = mesh.positions.findIndex((p) => p.distanceToSquared(centroid) < 1e-18);
  if (centroidIndex === -1) {
    centroidIndex = mesh.positions.length;
    mesh.positions.push(centroid);
    mesh.uvs.push(averageUV(mesh, loop));
  }

  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const neighbor = findNeighborFace(mesh.faces, a, b);
    if (!neighbor) {
      mesh.faces.push([a, centroidIndex, b]);
      continue;
    }
    const idxA = neighbor.indexOf(a);
    const nextIdx = (idxA + 1) % 3;
    mesh.faces.push(neighbor[nextIdx] === b ? [a, centroidIndex, b] : [b, centroidIndex, a]);
  }

  return true;
}

/** Attempts to fill every boundary loop this (already loose-part-split)
 * mesh has. Returns filled=true only if every loop was closed
 * successfully. Mutates and returns the same mesh object that was passed
 * in (fillEdgeLoopFan() above already mutates in place; this just makes
 * that explicit at the call site). */
function fillMeshHoles(mesh: IndexedMesh): { mesh: IndexedMesh; filled: boolean } {
  const loops = detectEdgeLoops(mesh);
  if (loops.length === 0) return { mesh, filled: false };

  let allFilled = true;
  for (const loop of loops) {
    if (loop.length < 3) continue;
    if (!fillEdgeLoopFan(mesh, loop)) allFilled = false;
  }
  return { mesh, filled: allFilled };
}

// ---- Manifold / self-intersection checks ----------------------------------

function isMeshManifold(mesh: IndexedMesh): boolean {
  const edgeCount = new Map<string, number>();
  for (const f of mesh.faces) {
    for (let i = 0; i < 3; i++) {
      const a = f[i];
      const b = f[(i + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }
  for (const c of edgeCount.values()) if (c > 2) return false;
  return true;
}

/** Real self-intersection check - as opposed to two faces merely sharing a
 * vertex/edge, which is normal mesh topology and gets skipped below, not
 * an intersection. Uses fast-triangle-triangle-intersection's
 * trianglesIntersect() (already a THREE.Triangle-based routine, and
 * already used elsewhere in this app - see app.ts's select-by-volume
 * code) for the actual test, with a cheap THREE.Box3 overlap check first
 * to skip most non-adjacent pairs without running the full test - this
 * replaces the original's ~90 lines of hand-rolled 2D/3D separating-axis
 * code entirely (trianglesIntersect_old/tri2dIntersect/sub2D/dot2D/
 * projectTri2D/bboxOverlap/triBounds - none of it ported). Still O(n^2) in
 * face count, same as the original - fine for the modestly-sized holes
 * this is run on (one already-split loose part, post-fill), not meant for
 * whole-scene use. */
function hasSelfIntersections(mesh: IndexedMesh): boolean {
  const triangles = mesh.faces.map((face) => ({
    face,
    tri: new THREE.Triangle(mesh.positions[face[0]], mesh.positions[face[1]], mesh.positions[face[2]]),
  }));
  const boxes = triangles.map(({ tri }) => new THREE.Box3().setFromPoints([tri.a, tri.b, tri.c]));

  for (let i = 0; i < triangles.length; i++) {
    for (let j = i + 1; j < triangles.length; j++) {
      if (triangles[i].face.some((v) => triangles[j].face.includes(v))) continue;
      if (!boxes[i].intersectsBox(boxes[j])) continue;
      if (trianglesIntersect(triangles[i].tri, triangles[j].tri)) return true;
    }
  }
  return false;
}

// ---- Public grouping entry point -------------------------------------------

export type MeshFixStatus = "unchanged" | "filled" | "fill-failed" | "self-intersecting" | "non-manifold";

export interface NamedMeshPart {
  name: string;
  geometry: GeometryArrays;
}

export interface FixedMeshPart extends NamedMeshPart {
  status: MeshFixStatus;
}

/** TypeScript/THREE.js migration of the old mesh-tools/fill.js's
 * groupFixedMeshes_safe(): given a set of named parts (already split by
 * loose parts - see splitGeometryByLooseParts()), fills any boundary-edge
 * holes each one has and labels each part with what happened to it,
 * mirroring the original's unchanged/filled/fill-failed/self-intersecting/
 * non-manifold categories - see MeshFixStatus. Unlike the original (which
 * hardcoded selfIntersect/nonManifold to `false`, "safe for convex planar
 * fans"), this actually runs hasSelfIntersections()/isMeshManifold() on
 * the fill RESULT, since a centroid fan thrown over a genuinely
 * non-planar loop can produce either - those checks needed to exist for
 * this project's real geometry (RenderDoc captures, not hand-modeled
 * "safe" meshes) to get meaningfully different statuses at all. Used by
 * the "fill holes" export option - see handleStartExport() in app.ts. */
export function groupFixedMeshes(parts: NamedMeshPart[]): FixedMeshPart[] {
  return parts.map(({ name, geometry }) => {
    const mesh = toIndexedMesh(geometry);
    const loops = detectEdgeLoops(mesh);

    if (loops.length === 0) {
      return { name, geometry, status: "unchanged" };
    }

    const { mesh: filledMesh, filled } = fillMeshHoles(mesh);

    let status: MeshFixStatus;
    if (!isMeshManifold(filledMesh)) status = "non-manifold";
    else if (hasSelfIntersections(filledMesh)) status = "self-intersecting";
    else if (filled) status = "filled";
    else status = "fill-failed";

    return { name, geometry: toGeometryArrays(filledMesh), status };
  });
}
