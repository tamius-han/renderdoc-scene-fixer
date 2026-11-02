/** Manifold guard for the final (indexed) mesh.
 *
 * Every stage of the weld pipeline tries to keep the topology manifold (merges are
 * checked, plugs and bridges are validated), and this is the safety net that makes
 * it a guarantee: it inspects the finished index topology and repairs whatever is
 * still wrong by SPLITTING vertices - never by moving anything or deleting
 * geometry (apart from exact duplicate triangles) - so the shape is untouched:
 *
 *   - exact duplicate triangles (same corners, same winding) are dropped;
 *   - an edge used by more than two triangles, or twice in the same direction,
 *     keeps its best pair (opposite directions, most alike normals) and the
 *     other triangles are detached onto copies of their vertices;
 *   - a vertex whose triangles form several separate fans (a pinch) gets one
 *     copy of itself per extra fan.
 *
 * After it, every edge has at most two triangles running in opposite directions
 * and every vertex has a single fan. */

export interface ManifoldInput {
  positions: number[];
  normals: number[];
  uvs: number[];
  /** Triangle index lists, one per entry (draw call); vertex arrays are shared. */
  indices: number[][];
}

export interface ManifoldStats {
  duplicateTriangles: number;
  detachedTriangles: number;
  splitVertices: number;
}

export function enforceManifold(mesh: ManifoldInput): { mesh: ManifoldInput; stats: ManifoldStats; changed: boolean } {
  const stats: ManifoldStats = { duplicateTriangles: 0, detachedTriangles: 0, splitVertices: 0 };
  // working copy: flat triangle list with slot
  const tris: number[][] = [];
  const slotOf: number[] = [];
  mesh.indices.forEach((list, slot) => {
    for (let t = 0; t + 2 < list.length; t += 3) { tris.push([list[t], list[t + 1], list[t + 2]]); slotOf.push(slot); }
  });
  if (tris.length === 0) return { mesh, stats, changed: false };

  const positions = mesh.positions.slice(), normals = mesh.normals.slice(), uvs = mesh.uvs.slice();
  let vertexCount = positions.length / 3;
  const copyVertex = (v: number): number => {
    positions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    normals.push(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    uvs.push(uvs[v * 2], uvs[v * 2 + 1]);
    return vertexCount++;
  };
  const alive = new Uint8Array(tris.length).fill(1);
  let changed = false;

  // geometric normal of triangle t (for choosing the best pair on an overloaded edge)
  const triNormal = (t: number): number[] => {
    const [a, b, c] = tris[t];
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };

  // ---- 1. exact duplicate triangles (same corners, same winding) ----------------------------
  {
    const seen = new Set<string>();
    for (let t = 0; t < tris.length; t++) {
      const [a, b, c] = tris[t];
      // canonical rotation, keeping winding
      const rots = [[a, b, c], [b, c, a], [c, a, b]];
      rots.sort((x, y) => x[0] - y[0]);
      const key = rots[0].join(",");
      if (seen.has(key)) { alive[t] = 0; stats.duplicateTriangles++; changed = true; } else seen.add(key);
    }
  }

  // ---- 2. overloaded / same-direction edges ---------------------------------------------------
  for (let round = 0; round < 4; round++) {
    const byEdge = new Map<number, number[]>();
    const K = vertexCount + 1;
    for (let t = 0; t < tris.length; t++) {
      if (!alive[t]) continue;
      for (let k = 0; k < 3; k++) {
        const a = tris[t][k], b = tris[t][(k + 1) % 3];
        const key = a < b ? a * K + b : b * K + a;
        const list = byEdge.get(key);
        if (list) list.push(t);
        else byEdge.set(key, [t]);
      }
    }
    let fixed = false;
    for (const [key, list] of byEdge) {
      if (list.length < 2) continue;
      const lo = Math.floor(key / K), hi = key % K;
      const dirOf = (t: number): number => { const v = tris[t]; for (let k = 0; k < 3; k++) if (v[k] === lo && v[(k + 1) % 3] === hi) return 1; return -1; };
      const bad = list.length > 2 || (list.length === 2 && dirOf(list[0]) === dirOf(list[1]));
      if (!bad) continue;
      // keep the best opposite-direction pair; detach the rest
      let bestPair: [number, number] | null = null, bestDot = -Infinity;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        if (dirOf(list[i]) === dirOf(list[j])) continue;
        const ni = triNormal(list[i]), nj = triNormal(list[j]);
        const d = ni[0] * nj[0] + ni[1] * nj[1] + ni[2] * nj[2];
        if (d > bestDot) { bestDot = d; bestPair = [list[i], list[j]]; }
      }
      const keep = new Set<number>(bestPair ?? [list[0]]);
      for (const t of list) {
        if (keep.has(t) || !alive[t]) continue;
        // detach: all three corners onto fresh copies
        tris[t] = tris[t].map((v) => { stats.splitVertices++; return copyVertex(v); });
        stats.detachedTriangles++;
        fixed = true; changed = true;
      }
    }
    if (!fixed) break;
  }

  // ---- 3. pinched vertices ------------------------------------------------------------------------
  {
    const around = new Map<number, number[]>();
    for (let t = 0; t < tris.length; t++) {
      if (!alive[t]) continue;
      for (const v of tris[t]) {
        const list = around.get(v);
        if (list) list.push(t);
        else around.set(v, [t]);
      }
    }
    for (const [v, list] of around) {
      if (list.length < 2) continue;
      const par = list.map((_, i) => i);
      const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      const first = new Map<number, number>();
      list.forEach((t, i) => {
        const k = tris[t].indexOf(v);
        for (const nb of [tris[t][(k + 1) % 3], tris[t][(k + 2) % 3]]) {
          const f = first.get(nb);
          if (f === undefined) first.set(nb, i);
          else par[find(i)] = find(f);
        }
      });
      const fans = new Map<number, number[]>();
      list.forEach((t, i) => { const r = find(i); const l = fans.get(r); if (l) l.push(t); else fans.set(r, [t]); });
      if (fans.size < 2) continue;
      // the biggest fan keeps the vertex; each other fan gets a copy
      const ordered = [...fans.values()].sort((a, b) => b.length - a.length);
      for (const fan of ordered.slice(1)) {
        const copy = copyVertex(v);
        stats.splitVertices++;
        changed = true;
        for (const t of fan) tris[t] = tris[t].map((x) => (x === v ? copy : x));
      }
    }
  }

  if (!changed) return { mesh, stats, changed: false };
  const indices: number[][] = mesh.indices.map(() => []);
  for (let t = 0; t < tris.length; t++) if (alive[t]) indices[slotOf[t]].push(...tris[t]);
  return { mesh: { positions, normals, uvs, indices }, stats, changed: true };
}

/** Diagnostic: how many open (boundary) edges of the finished mesh coincide in
 * space with ANOTHER open edge - i.e. two instances of the same edge that are
 * neither welded nor bridged. Expected to be 0; anything else marks a place where
 * the surface isn't contiguous (opposing layers the weld refused to merge,
 * edges whose merge would have been non-manifold, ...). `tol` is the position
 * tolerance used to decide two edges are at the same place. */
export function countCoincidentOpenEdges(mesh: ManifoldInput, tol: number): number {
  const idx: number[] = [];
  for (const list of mesh.indices) for (const i of list) idx.push(i);
  const uses = new Map<string, number>();
  const und = (a: number, b: number): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k], b = idx[t + (k + 1) % 3];
      if (a === b) continue;
      uses.set(und(a, b), (uses.get(und(a, b)) ?? 0) + 1);
    }
  }
  const q = tol > 0 ? tol : 1e-9;
  const pos = (v: number): string => `${Math.round(mesh.positions[v * 3] / q)},${Math.round(mesh.positions[v * 3 + 1] / q)},${Math.round(mesh.positions[v * 3 + 2] / q)}`;
  const byPlace = new Map<string, number>();
  for (const [key, n] of uses) {
    if (n !== 1) continue;
    const [a, b] = key.split("|").map(Number);
    const pa = pos(a), pb = pos(b);
    if (pa === pb) continue; // zero-length hop around a UV-split vertex
    const k2 = pa < pb ? `${pa}|${pb}` : `${pb}|${pa}`;
    byPlace.set(k2, (byPlace.get(k2) ?? 0) + 1);
  }
  let count = 0;
  for (const n of byPlace.values()) if (n >= 2) count += n;
  return count;
}
