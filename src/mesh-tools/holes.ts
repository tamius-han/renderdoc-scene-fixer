import { TriangleBVH, clusterPositions } from "./spatial.ts";
import { trianglesPenetrate } from "./intersect.ts";

/** Hole filling for the "Weld geometry" pipeline: finds open edges in a mesh
 * (after welding), groups them into boundary loops, and plugs each loop with
 * new triangles - but only if the plug doesn't pass through any other triangle
 * of the same mesh (or an earlier plug). Loops whose plug would intersect
 * something are left open.
 *
 * Works on flat, per-corner "soup" geometry (3 corners per triangle, plus an
 * owner id per triangle) and decides topology purely from POSITIONS (corners
 * within a tolerance are the same vertex), so UV seams / differing normals
 * never look like holes. Each loop is tried with a centroid fan first (nice
 * radial triangles on round holes) and, if that would intersect something,
 * with ear clipping in the loop's best-fit plane (copes with concave loops). */

export interface SoupMesh {
  positions: number[];
  normals: number[];
  uvs: number[];
  /** Owner id (e.g. which draw call) of each triangle. */
  owner: number[];
}

export interface HoleFillStats {
  /** Boundary loops found. */
  loops: number;
  filled: number;
  /** Loops left open: plug would intersect the mesh, or the loop was malformed. */
  failed: number;
  addedTriangles: number;
  /** True if the mesh was skipped as a flat/thin sheet (whose edges aren't holes). */
  skippedFlat: boolean;
}

/** PCA "is this basically a flat sheet" test (smallest/largest eigenvalue of
 * the position covariance below `threshold`), same idea as fill.ts uses. */
export function isThinOrFlat(points: ArrayLike<number>, threshold = 0.0125): boolean {
  const n = Math.floor(points.length / 3);
  if (n < 3) return true;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += points[i * 3]; cy += points[i * 3 + 1]; cz += points[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i++) {
    const dx = points[i * 3] - cx, dy = points[i * 3 + 1] - cy, dz = points[i * 3 + 2] - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  xx /= n; xy /= n; xz /= n; yy /= n; yz /= n; zz /= n;
  const p1 = xy ** 2 + xz ** 2 + yz ** 2;
  if (p1 === 0) {
    const eig = [xx, yy, zz].sort((a, b) => b - a);
    return eig[0] <= 0 || eig[2] / eig[0] < threshold;
  }
  const q = (xx + yy + zz) / 3;
  const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const b00 = (xx - q) / p, b11 = (yy - q) / p, b22 = (zz - q) / p;
  const b01 = xy / p, b02 = xz / p, b12 = yz / p;
  const r = (b00 * b11 * b22 + 2 * b01 * b02 * b12 - b00 * b12 ** 2 - b11 * b02 ** 2 - b22 * b01 ** 2) / 2;
  const phi = Math.acos(Math.max(-1, Math.min(1, r))) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  const eig = [e1, e2, e3].sort((a, b) => b - a);
  return eig[0] <= 0 || eig[2] / eig[0] < threshold;
}

interface HalfEdge { a: number; b: number; tri: number; corner: number }

/** Ear clipping of a 3D loop (vertex ids in boundary order) in its best-fit
 * plane. Returns triangles (id triples, same direction as the loop) or null. */
function earClip(loop: number[], pos: (id: number) => number[], minArea: number): number[][] | null {
  const n = loop.length;
  if (n < 3) return null;
  // Newell normal
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = pos(loop[i]), b = pos(loop[(i + 1) % n]);
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-18) return null;
  nx /= nl; ny /= nl; nz /= nl;
  const cross = (a: number[], b: number[], c: number[]): number => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
  };
  const inside = (p: number[], a: number[], b: number[], c: number[]): boolean =>
    cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;

  const idx = loop.map((_, i) => i);
  const out: number[][] = [];
  let guard = n * n + 10;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = pos(loop[i0]), b = pos(loop[i1]), c = pos(loop[i2]);
      if (cross(a, b, c) <= minArea * 2) continue; // reflex or degenerate
      let ear = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inside(pos(loop[j]), a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push([loop[i0], loop[i1], loop[i2]]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (idx.length === 3) {
    const a = pos(loop[idx[0]]), b = pos(loop[idx[1]]), c = pos(loop[idx[2]]);
    if (cross(a, b, c) <= minArea * 2) return null;
    out.push([loop[idx[0]], loop[idx[1]], loop[idx[2]]]);
  }
  return out;
}

/** Fills the holes of one mesh. `tol` is the position tolerance (corners within
 * it are the same vertex; also the contact tolerance for the plug check). */
export function fillHoles(mesh: SoupMesh, tol: number): { mesh: SoupMesh; stats: HoleFillStats } {
  const stats: HoleFillStats = { loops: 0, filled: 0, failed: 0, addedTriangles: 0, skippedFlat: false };
  const nTri = Math.floor(mesh.positions.length / 9);
  if (nTri === 0) return { mesh, stats };

  const cl = clusterPositions(mesh.positions, tol);
  const C = cl.clusterCount;
  const cp = cl.clusterPos;
  const ids = (t: number): number[] => [cl.clusterOfCorner[t * 3], cl.clusterOfCorner[t * 3 + 1], cl.clusterOfCorner[t * 3 + 2]];
  const minArea = tol * tol;
  const areaOf = (a: number[], b: number[], c: number[]): number => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  };
  const P = (id: number): number[] => [cp[id * 3], cp[id * 3 + 1], cp[id * 3 + 2]];

  // live (non-degenerate) triangles in cluster space
  const live: number[] = [];
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = ids(t);
    if (a === b || b === c || a === c) continue;
    if (areaOf(P(a), P(b), P(c)) <= minArea) continue;
    live.push(t);
  }
  if (live.length === 0) return { mesh, stats };
  if (isThinOrFlat(cp)) { stats.skippedFlat = true; return { mesh, stats }; }

  // boundary half-edges: directed edges whose undirected edge is used exactly once
  const undirected = new Map<number, number>();
  const uKey = (a: number, b: number): number => (a < b ? a * C + b : b * C + a);
  for (const t of live) {
    const v = ids(t);
    for (let k = 0; k < 3; k++) {
      const key = uKey(v[k], v[(k + 1) % 3]);
      undirected.set(key, (undirected.get(key) ?? 0) + 1);
    }
  }
  const half: HalfEdge[] = [];
  const outgoing = new Map<number, number[]>();
  for (const t of live) {
    const v = ids(t);
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (undirected.get(uKey(a, b)) !== 1) continue;
      const id = half.length;
      half.push({ a, b, tri: t, corner: k });
      const list = outgoing.get(a);
      if (list) list.push(id);
      else outgoing.set(a, [id]);
    }
  }
  if (half.length === 0) return { mesh, stats };

  // loops of half-edges
  const used = new Uint8Array(half.length);
  const loops: number[][] = []; // lists of half-edge ids
  const malformed: number[] = [];
  for (let s = 0; s < half.length; s++) {
    if (used[s]) continue;
    const loop: number[] = [s];
    used[s] = 1;
    let closed = false;
    let cur = s;
    for (let guard = 0; guard <= half.length; guard++) {
      const next = (outgoing.get(half[cur].b) ?? []).find((e) => !used[e] || e === s);
      if (next === undefined) break;
      if (next === s) { closed = true; break; }
      used[next] = 1;
      loop.push(next);
      cur = next;
    }
    if (closed && loop.length >= 3) loops.push(loop);
    else malformed.push(loop.length);
  }
  stats.loops = loops.length + malformed.length;
  stats.failed += malformed.length;

  // validation structures
  const baseTris = new Float64Array(live.length * 9);
  live.forEach((t, i) => {
    const v = ids(t);
    for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) baseTris[i * 9 + k * 3 + a] = cp[v[k] * 3 + a];
  });
  const baseIds = live.map((t) => ids(t));
  const bvh = new TriangleBVH(baseTris);
  const plugs: { coords: number[]; ids: number[] }[] = [];
  let extraId = C; // ids for centroid vertices

  const coordsOf = (tri: number[], positions: (id: number) => number[]): number[] => [...positions(tri[0]), ...positions(tri[1]), ...positions(tri[2])];
  const out: SoupMesh = { positions: mesh.positions.slice(), normals: mesh.normals.slice(), uvs: mesh.uvs.slice(), owner: mesh.owner.slice() };

  for (const loopEdges of loops) {
    const verts = loopEdges.map((e) => half[e].a); // loop order a0, a1, ... (edge i runs a_i -> a_{i+1})
    if (new Set(verts).size !== verts.length) { stats.failed++; continue; } // pinched loop
    const centroidId = extraId;
    const extra = new Map<number, number[]>();
    const posOf = (id: number): number[] => (id >= C ? extra.get(id)! : P(id));

    // candidate triangulations: each as a list of id triples
    const candidates: (() => number[][] | null)[] = [
      () => {
        let cx = 0, cy = 0, cz = 0;
        for (const v of verts) { const p = P(v); cx += p[0]; cy += p[1]; cz += p[2]; }
        extra.set(centroidId, [cx / verts.length, cy / verts.length, cz / verts.length]);
        // each boundary half-edge a->b gets the plug triangle (b, a, centroid) containing b->a
        return loopEdges.map((e) => [half[e].b, half[e].a, centroidId]);
      },
      () => earClip(verts.slice().reverse(), posOf, minArea),
    ];

    let accepted: number[][] | null = null;
    let usedCentroid = false;
    for (let ci = 0; ci < candidates.length && !accepted; ci++) {
      const tris = candidates[ci]();
      if (!tris || tris.length === 0) continue;
      const coords = tris.map((t) => coordsOf(t, posOf));
      // non-degenerate
      if (coords.some((c) => areaOf([c[0], c[1], c[2]], [c[3], c[4], c[5]], [c[6], c[7], c[8]]) <= minArea)) continue;
      let ok = true;
      for (let i = 0; i < tris.length && ok; i++) {
        const c = coords[i];
        // against the mesh
        bvh.queryBox(
          Math.min(c[0], c[3], c[6]) - tol, Math.min(c[1], c[4], c[7]) - tol, Math.min(c[2], c[5], c[8]) - tol,
          Math.max(c[0], c[3], c[6]) + tol, Math.max(c[1], c[4], c[7]) + tol, Math.max(c[2], c[5], c[8]) + tol,
          (u) => {
            if (!ok) return;
            const g = u * 9;
            if (trianglesPenetrate(c, tris[i], baseTris.subarray(g, g + 9), baseIds[u], tol)) ok = false;
          },
        );
        // against earlier plugs and this plug's own other triangles
        for (const other of plugs) if (ok && trianglesPenetrate(c, tris[i], other.coords, other.ids, tol)) ok = false;
        for (let j = 0; j < i && ok; j++) if (trianglesPenetrate(c, tris[i], coords[j], tris[j], tol)) ok = false;
      }
      if (ok) { accepted = tris; usedCentroid = ci === 0; }
    }
    if (!accepted) { stats.failed++; continue; }

    // attributes: UV of a loop vertex = that corner's UV in the triangle owning the half-edge that starts there
    const uvAt = new Map<number, [number, number]>();
    const ownerAt = new Map<number, number>();
    for (const e of loopEdges) {
      const h = half[e];
      const corner = h.tri * 3 + h.corner;
      uvAt.set(h.a, [mesh.uvs[corner * 2] ?? 0, mesh.uvs[corner * 2 + 1] ?? 0]);
      ownerAt.set(h.a, mesh.owner[h.tri]);
    }
    if (usedCentroid) {
      let u = 0, v = 0;
      for (const [uu, vv] of uvAt.values()) { u += uu; v += vv; }
      uvAt.set(centroidId, [u / uvAt.size, v / uvAt.size]);
    }
    for (const tri of accepted) {
      const c = coordsOf(tri, posOf);
      const ux = c[3] - c[0], uy = c[4] - c[1], uz = c[5] - c[2], vx = c[6] - c[0], vy = c[7] - c[1], vz = c[8] - c[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      for (let k = 0; k < 3; k++) {
        out.positions.push(c[k * 3], c[k * 3 + 1], c[k * 3 + 2]);
        out.normals.push(nx, ny, nz);
        const uv = uvAt.get(tri[k]) ?? [0, 0];
        out.uvs.push(uv[0], uv[1]);
      }
      // owner: of the first loop vertex this triangle uses that has one
      const own = tri.map((id) => ownerAt.get(id)).find((o) => o !== undefined) ?? mesh.owner[0] ?? 0;
      out.owner.push(own);
      plugs.push({ coords: c, ids: tri });
      stats.addedTriangles++;
    }
    if (usedCentroid) extraId++;
    stats.filled++;
  }
  return { mesh: out, stats };
}
