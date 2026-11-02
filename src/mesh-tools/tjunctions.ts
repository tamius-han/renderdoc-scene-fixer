import { clusterPositions } from "./spatial.ts";

/** T-junction repair for welding.
 *
 * Two meshes (or two UV islands) that meet along a shared boundary but are
 * tessellated differently have a vertex of one side in the MIDDLE of the other
 * side's edge. Their edges don't coincide, so the weld has nothing to merge -
 * and with nothing merged there are no UV variants to bridge either, so the
 * seam stays an open gap.
 *
 * This splits such triangles: every boundary vertex that lies within `tol` of
 * another triangle's BOUNDARY edge (strictly inside it) is inserted into that
 * triangle, which is re-triangulated so its boundary edge is cut into pieces
 * that coincide with the other side's edges. Normals and UVs of inserted
 * vertices are interpolated along the edge, and the inserted vertex sits
 * exactly on the other side's vertex. Only open (boundary) edges and boundary
 * vertices are considered, so closed geometry is never touched.
 *
 * Triangles that get split are replaced: the originals are flagged dead and
 * their replacements appended after the original corners, so indices of
 * untouched triangles are unchanged. */

export interface TJunctionResult {
  positions: number[];
  normals: number[];
  uvs: number[];
  /** Owner per triangle (original + appended), if owners were given. */
  owners: Int32Array | undefined;
  /** 1 for original triangles that were replaced. */
  dead: Uint8Array;
  splitTriangles: number;
  insertedVertices: number;
}

interface Split { v: number; t: number }

export function splitTJunctions(
  positions: number[], normals: number[], uvs: number[], owners: Int32Array | undefined, tol: number,
): TJunctionResult | null {
  const nTri = Math.floor(positions.length / 9);
  if (nTri === 0) return null;
  const cl = clusterPositions(positions, tol);
  const C = cl.clusterCount, cp = cl.clusterPos;
  const ids = (t: number): number[] => [cl.clusterOfCorner[t * 3], cl.clusterOfCorner[t * 3 + 1], cl.clusterOfCorner[t * 3 + 2]];
  const key = (a: number, b: number): number => (a < b ? a * C + b : b * C + a);

  const live: number[] = [];
  const uses = new Map<number, number>();
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = ids(t);
    if (a === b || b === c || a === c) continue;
    live.push(t);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) uses.set(key(p, q), (uses.get(key(p, q)) ?? 0) + 1);
  }
  // boundary edges and their vertices
  const edges: { t: number; k: number; a: number; b: number }[] = [];
  const boundaryVerts = new Set<number>();
  for (const t of live) {
    const v = ids(t);
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (uses.get(key(a, b)) !== 1) continue;
      edges.push({ t, k, a, b });
      boundaryVerts.add(a); boundaryVerts.add(b);
    }
  }
  if (edges.length < 2) return null;

  let meanLen = 0;
  for (const e of edges) meanLen += Math.hypot(cp[e.a * 3] - cp[e.b * 3], cp[e.a * 3 + 1] - cp[e.b * 3 + 1], cp[e.a * 3 + 2] - cp[e.b * 3 + 2]);
  meanLen /= edges.length;
  const cell = Math.max(meanLen, tol * 4);
  const cellKey = (x: number, y: number, z: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const grid = new Map<string, number[]>();
  for (const v of boundaryVerts) {
    const k = cellKey(cp[v * 3], cp[v * 3 + 1], cp[v * 3 + 2]);
    const l = grid.get(k);
    if (l) l.push(v);
    else grid.set(k, [v]);
  }

  // find boundary vertices lying inside boundary edges
  const splits = new Map<number, Map<number, Split[]>>(); // triangle -> edge corner -> points
  let found = 0;
  for (const e of edges) {
    const ax = cp[e.a * 3], ay = cp[e.a * 3 + 1], az = cp[e.a * 3 + 2];
    const dx = cp[e.b * 3] - ax, dy = cp[e.b * 3 + 1] - ay, dz = cp[e.b * 3 + 2] - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 <= 0) continue;
    const len = Math.sqrt(len2);
    const candidates = new Set<number>();
    const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const px = ax + (dx * s) / steps, py = ay + (dy * s) / steps, pz = az + (dz * s) / steps;
      const gx = Math.floor(px / cell), gy = Math.floor(py / cell), gz = Math.floor(pz / cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let l = -1; l <= 1; l++) {
        const list = grid.get(`${gx + i},${gy + j},${gz + l}`);
        if (list) for (const v of list) candidates.add(v);
      }
    }
    for (const v of candidates) {
      if (v === e.a || v === e.b) continue;
      const rx = cp[v * 3] - ax, ry = cp[v * 3 + 1] - ay, rz = cp[v * 3 + 2] - az;
      const t = (rx * dx + ry * dy + rz * dz) / len2;
      if (t * len <= tol || (1 - t) * len <= tol) continue; // at (or beyond) an end
      if (Math.hypot(rx - dx * t, ry - dy * t, rz - dz * t) > tol) continue;
      let perTri = splits.get(e.t);
      if (!perTri) splits.set(e.t, (perTri = new Map()));
      const list = perTri.get(e.k);
      if (list) list.push({ v, t });
      else perTri.set(e.k, [{ v, t }]);
      found++;
    }
  }
  if (found === 0) return null;

  // rebuild the affected triangles
  const outP = positions.slice(), outN = normals.slice(), outU = uvs.slice();
  const outOwners: number[] = owners ? Array.from(owners) : [];
  const dead = new Uint8Array(nTri);
  let splitTriangles = 0, inserted = 0;
  for (const [t, perTri] of splits) {
    interface PV { p: number[]; n: number[]; uv: number[] }
    const poly: PV[] = [];
    for (let k = 0; k < 3; k++) {
      const c = t * 3 + k, c2 = t * 3 + ((k + 1) % 3);
      poly.push({ p: positions.slice(c * 3, c * 3 + 3), n: normals.slice(c * 3, c * 3 + 3), uv: uvs.slice(c * 2, c * 2 + 2) });
      const pts = (perTri.get(k) ?? []).slice().sort((x, y) => x.t - y.t);
      const seen = new Set<number>();
      for (const { v, t: s } of pts) {
        if (seen.has(v)) continue;
        seen.add(v);
        const n = [0, 1, 2].map((a) => normals[c * 3 + a] * (1 - s) + normals[c2 * 3 + a] * s);
        const nl = Math.hypot(n[0], n[1], n[2]) || 1;
        poly.push({
          p: [cp[v * 3], cp[v * 3 + 1], cp[v * 3 + 2]], // exactly on the other side's vertex
          n: [n[0] / nl, n[1] / nl, n[2] / nl],
          uv: [uvs[c * 2] * (1 - s) + uvs[c2 * 2] * s, uvs[c * 2 + 1] * (1 - s) + uvs[c2 * 2 + 1] * s],
        });
        inserted++;
      }
    }
    // normal of the original triangle, for the turn test
    const A = poly[0].p;
    const corner = (k: number): number[] => positions.slice((t * 3 + k) * 3, (t * 3 + k) * 3 + 3);
    const B = corner(1), Cc = corner(2);
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen <= 0) continue;
    nx /= nlen; ny /= nlen; nz /= nlen;

    // ear clipping of the (convex) polygon, always taking the sharpest corner first
    const idx = poly.map((_, i) => i);
    const tris: number[][] = [];
    let ok = true;
    while (idx.length > 3) {
      let best = -1, bestTurn = 1e-6;
      for (let i = 0; i < idx.length; i++) {
        const p0 = poly[idx[(i + idx.length - 1) % idx.length]].p, p1 = poly[idx[i]].p, p2 = poly[idx[(i + 1) % idx.length]].p;
        const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const turn = (cr[0] * nx + cr[1] * ny + cr[2] * nz) / ((Math.hypot(...e1) * Math.hypot(...e2)) || 1);
        if (turn > bestTurn) { bestTurn = turn; best = i; }
      }
      if (best < 0) { ok = false; break; }
      tris.push([idx[(best + idx.length - 1) % idx.length], idx[best], idx[(best + 1) % idx.length]]);
      idx.splice(best, 1);
    }
    if (!ok) continue;
    tris.push([idx[0], idx[1], idx[2]]);

    dead[t] = 1;
    splitTriangles++;
    for (const tri of tris) {
      for (const i of tri) {
        outP.push(...poly[i].p); outN.push(...poly[i].n); outU.push(...poly[i].uv);
      }
      if (owners) outOwners.push(owners[t]);
    }
  }
  if (splitTriangles === 0) return null;
  return { positions: outP, normals: outN, uvs: outU, owners: owners ? Int32Array.from(outOwners) : undefined, dead, splitTriangles, insertedVertices: inserted };
}
