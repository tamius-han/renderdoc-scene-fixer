import { TriangleBVH, clusterPositions } from "./spatial.ts";
import { trianglesPenetrate } from "./intersect.ts";
import type { SoupMesh } from "./holes.ts";

/** Narrow-gap bridging for open meshes.
 *
 * Open edges (used by one triangle only) that face each other across a narrow
 * gap - a seam between two panels, a crack, the rim of a thin slit - are joined
 * by a strip of new triangles, closing the gap. Two kinds of pairs are bridged:
 *
 *  - NARROW GAPS: the two surfaces continue into each other (normals within
 *    ~100 degrees) and the edges are closer than `narrowGap`;
 *  - SHELL RIMS: the surfaces face away from each other (a double-sided sheet
 *    whose two layers were pushed apart) and the edges are closer than
 *    `shellGap`; bridging them closes the shell.
 *
 * Edges are paired (mutually nearest, anti-parallel, overlapping along their
 * length), consecutive pairs are grouped into runs, and each run's two vertex
 * chains are stitched with a shortest-diagonal "ladder". A run is committed
 * only if its strip is valid - no triangle passes through any other, every
 * edge stays manifold, no vertex ends up pinched; otherwise the run is left
 * exactly as it was. Operates on flat per-corner geometry (3 corners per
 * triangle + an owner id per triangle) using positions only. */

export interface GapOptions {
  /** Position tolerance (corners within it are the same vertex). */
  tol: number;
  /** Largest gap to close between surfaces that continue into each other (0 = off). */
  narrowGap: number;
  /** Largest gap to close between back-to-back layers (0 = off). */
  shellGap: number;
}

export interface GapStats {
  boundaryEdges: number;
  chains: number;
  strips: number;
  bridgedEdges: number;
  rejectedStrips: number;
  addedTriangles: number;
}

interface HalfEdge {
  a: number; b: number; tri: number; corner: number;
  mid: number[]; dir: number[]; len: number; n: number[]; inward: number[];
}

const sub = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]): number[] => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const cross = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Distance between segments p0-p1 and q0-q1 (Ericson). */
function segmentDistance(p0: number[], p1: number[], q0: number[], q1: number[]): number {
  const d1 = sub(p1, p0), d2 = sub(q1, q0), r = sub(p0, q0);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-30 && e <= 1e-30) return Math.hypot(...r);
  if (a <= 1e-30) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-30) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), denom = a * e - b * b;
      s = denom > 1e-30 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const cp = [p0[0] + d1[0] * s, p0[1] + d1[1] * s, p0[2] + d1[2] * s], cq = [q0[0] + d2[0] * t, q0[1] + d2[1] * t, q0[2] + d2[2] * t];
  return Math.hypot(cp[0] - cq[0], cp[1] - cq[1], cp[2] - cq[2]);
}

export function bridgeGaps(mesh: SoupMesh, options: GapOptions): { mesh: SoupMesh; stats: GapStats; links: number[] } {
  const stats: GapStats = { boundaryEdges: 0, chains: 0, strips: 0, bridgedEdges: 0, rejectedStrips: 0, addedTriangles: 0 };
  const links: number[] = [];
  const { tol } = options;
  const maxGap = Math.max(options.narrowGap, options.shellGap);
  const nTri = Math.floor(mesh.positions.length / 9);
  if (nTri === 0 || maxGap <= 0) return { mesh, stats, links };

  const cl = clusterPositions(mesh.positions, tol);
  const C = cl.clusterCount;
  const P = (id: number): number[] => [cl.clusterPos[id * 3], cl.clusterPos[id * 3 + 1], cl.clusterPos[id * 3 + 2]];
  const ids = (t: number): number[] => [cl.clusterOfCorner[t * 3], cl.clusterOfCorner[t * 3 + 1], cl.clusterOfCorner[t * 3 + 2]];
  const minArea = tol * tol;

  const live: number[] = [];
  for (let t = 0; t < nTri; t++) {
    const [a, b, c] = ids(t);
    if (a === b || b === c || a === c) continue;
    const A = P(a), B = P(b), Cc = P(c);
    if (Math.hypot(...cross(sub(B, A), sub(Cc, A))) / 2 <= minArea) continue;
    live.push(t);
  }
  if (live.length === 0) return { mesh, stats, links };

  const uKey = (a: number, b: number): number => (a < b ? a * C + b : b * C + a);
  const edgeUse = new Map<number, number>();
  const trisOfVertex = new Map<number, number[]>(); // live triangle slots (index in `tris`) per vertex
  const tris: number[][] = []; // id triples of every triangle (live + added)
  const addTri = (t: number[]): void => {
    const slot = tris.length;
    tris.push(t);
    for (let k = 0; k < 3; k++) {
      const key = uKey(t[k], t[(k + 1) % 3]);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
      const list = trisOfVertex.get(t[k]);
      if (list) list.push(slot);
      else trisOfVertex.set(t[k], [slot]);
    }
  };
  const slotOfLive: number[] = [];
  for (const t of live) { slotOfLive.push(tris.length); addTri(ids(t)); }

  // ---- boundary half-edges -----------------------------------------------------------------
  const half: HalfEdge[] = [];
  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number>();
  live.forEach((t, li) => {
    const v = tris[slotOfLive[li]];
    const A = P(v[0]), B = P(v[1]), Cc = P(v[2]);
    const n = norm(cross(sub(B, A), sub(Cc, A)));
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (edgeUse.get(uKey(a, b)) !== 1) continue;
      const pa = P(a), pb = P(b), pc = P(v[(k + 2) % 3]);
      const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      const edge = sub(pb, pa), len = Math.hypot(...edge);
      const dir = norm(edge);
      // in-plane direction from the edge into its own triangle
      const toApex = sub(pc, mid);
      const inward = norm(sub(toApex, dir.map((x) => x * dot(toApex, dir))));
      const id = half.length;
      half.push({ a, b, tri: t, corner: k, mid, dir, len, n, inward });
      const o = outgoing.get(a);
      if (o) o.push(id);
      else outgoing.set(a, [id]);
      incoming.set(b, (incoming.get(b) ?? 0) + 1);
    }
  });
  stats.boundaryEdges = half.length;
  if (half.length < 2) return { mesh, stats, links };

  // ---- chains (maximal simple boundary paths) -----------------------------------------------
  const chainOf = new Int32Array(half.length).fill(-1);
  const posIn = new Int32Array(half.length).fill(-1);
  interface Chain { edges: number[]; verts: number[]; closed: boolean }
  const chains: Chain[] = [];
  const walk = (start: number): void => {
    const ch: Chain = { edges: [start], verts: [half[start].a, half[start].b], closed: false };
    chainOf[start] = chains.length; posIn[start] = 0;
    for (let cur = start; ;) {
      const nexts = (outgoing.get(half[cur].b) ?? []).filter((e) => chainOf[e] < 0);
      if (nexts.length !== 1 || (incoming.get(half[cur].b) ?? 0) !== 1) {
        if (nexts.length === 1 && half[nexts[0]].b === half[start].a) { /* closes below */ }
        else break;
      }
      const nx = nexts[0];
      if (nx === undefined) break;
      chainOf[nx] = chains.length; posIn[nx] = ch.edges.length;
      ch.edges.push(nx); ch.verts.push(half[nx].b);
      cur = nx;
    }
    if (ch.verts[ch.verts.length - 1] === ch.verts[0]) ch.closed = true;
    chains.push(ch);
  };
  for (let e = 0; e < half.length; e++) if (chainOf[e] < 0 && (incoming.get(half[e].a) ?? 0) !== 1) walk(e);
  for (let e = 0; e < half.length; e++) if (chainOf[e] < 0) walk(e);
  stats.chains = chains.length;

  // ---- candidate partners ---------------------------------------------------------------------
  const cell = maxGap;
  const gridKey = (x: number, y: number, z: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const grid = new Map<string, number[]>();
  half.forEach((h, i) => {
    const k = gridKey(h.mid[0], h.mid[1], h.mid[2]);
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
  });
  const best = new Int32Array(half.length).fill(-1);
  const bestScore = new Float64Array(half.length).fill(Infinity);
  const sharesVertex = (x: HalfEdge, y: HalfEdge): boolean => x.a === y.a || x.a === y.b || x.b === y.a || x.b === y.b;
  for (let i = 0; i < half.length; i++) {
    const h = half[i];
    const gx = Math.floor(h.mid[0] / cell), gy = Math.floor(h.mid[1] / cell), gz = Math.floor(h.mid[2] / cell);
    // the other edge's midpoint can be up to (len/2 + gap) away: widen the search by the edge length
    const reach = Math.ceil((h.len / 2 + maxGap) / cell) + 1;
    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) for (let dz = -reach; dz <= reach; dz++) {
      const list = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
      if (!list) continue;
      for (const j of list) {
        if (j === i) continue;
        const g = half[j];
        if (g.tri === h.tri || sharesVertex(h, g)) continue;
        if (dot(h.dir, g.dir) > -0.7) continue; // must run the opposite way
        const nd = dot(h.n, g.n);
        const shell = nd <= -0.9;
        const narrow = nd >= -0.2;
        if (!shell && !narrow) continue;
        const limit = shell ? options.shellGap : options.narrowGap;
        if (limit <= 0) continue;
        const A0 = P(h.a), A1 = P(h.b), B0 = P(g.a), B1 = P(g.b);
        const d = segmentDistance(A0, A1, B0, B1);
        if (d > limit) continue;
        // overlap along h's axis
        const t0 = dot(sub(B0, A0), h.dir), t1 = dot(sub(B1, A0), h.dir);
        const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(h.len, Math.max(t0, t1));
        const overlap = hi - lo;
        if (overlap < 0.25 * Math.min(h.len, g.len)) continue;
        if (!shell) {
          // the partner must lie OUTSIDE this edge's own triangle (in the gap), and vice versa
          if (dot(sub(g.mid, h.mid), h.inward) > 0.1 * d || dot(sub(h.mid, g.mid), g.inward) > 0.1 * d) continue;
        }
        const score = d + 0.1 * (1 - overlap / Math.min(h.len, g.len));
        if (score < bestScore[i]) { bestScore[i] = score; best[i] = j; }
      }
    }
  }

  // ---- mutual pairs -> runs ------------------------------------------------------------------------
  const pairs: { e1: number; e2: number }[] = [];
  for (let i = 0; i < half.length; i++) if (best[i] >= 0 && best[best[i]] === i && i < best[i]) pairs.push({ e1: i, e2: best[i] });
  // orient each pair so that chain order of the first is increasing
  interface Run { cA: number; cB: number; aFrom: number; aTo: number; bFrom: number; bTo: number }
  const runs: Run[] = [];
  const oriented = pairs.map((p) => (chainOf[p.e1] < chainOf[p.e2] || (chainOf[p.e1] === chainOf[p.e2] && posIn[p.e1] < posIn[p.e2]) ? p : { e1: p.e2, e2: p.e1 }));
  oriented.sort((p, q) => chainOf[p.e1] - chainOf[q.e1] || chainOf[p.e2] - chainOf[q.e2] || posIn[p.e1] - posIn[q.e1]);
  let cur: Run | null = null;
  for (const p of oriented) {
    const cA = chainOf[p.e1], cB = chainOf[p.e2], pa = posIn[p.e1], pb = posIn[p.e2];
    if (cur && cur.cA === cA && cur.cB === cB && pa - cur.aTo >= 1 && pa - cur.aTo <= 2 && cur.bFrom - pb >= 1 && cur.bFrom - pb <= 2) {
      cur.aTo = pa; cur.bFrom = pb;
    } else {
      if (cur) runs.push(cur);
      cur = { cA, cB, aFrom: pa, aTo: pa, bFrom: pb, bTo: pb };
    }
  }
  if (cur) runs.push(cur);

  // ---- strips ------------------------------------------------------------------------------------------
  const live9 = new Float64Array(live.length * 9);
  live.forEach((_, li) => {
    const v = tris[slotOfLive[li]];
    for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) live9[li * 9 + k * 3 + a] = cl.clusterPos[v[k] * 3 + a];
  });
  const bvh = new TriangleBVH(live9);
  const uvAt = new Map<number, [number, number]>();
  for (const h of half) {
    const c0 = h.tri * 3 + h.corner, c1 = h.tri * 3 + ((h.corner + 1) % 3);
    if (!uvAt.has(h.a)) uvAt.set(h.a, [mesh.uvs[c0 * 2] ?? 0, mesh.uvs[c0 * 2 + 1] ?? 0]);
    if (!uvAt.has(h.b)) uvAt.set(h.b, [mesh.uvs[c1 * 2] ?? 0, mesh.uvs[c1 * 2 + 1] ?? 0]);
  }

  const out: SoupMesh = { positions: mesh.positions.slice(), normals: mesh.normals.slice(), uvs: mesh.uvs.slice(), owner: mesh.owner.slice() };
  const added: { coords: number[]; ids: number[] }[] = [];

  /** Is the fan of triangles around vertex v still a single manifold fan once `extra` are added? */
  const fanOk = (v: number, extra: number[][]): boolean => {
    const around: number[][] = [];
    for (const slot of trisOfVertex.get(v) ?? []) around.push(tris[slot]);
    for (const t of extra) if (t.includes(v)) around.push(t);
    const maskOut = new Map<number, number>(), first = new Map<number, number>();
    const par = around.map((_, i) => i);
    const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let i = 0; i < around.length; i++) {
      const t = around[i], k = t.indexOf(v);
      const out2 = t[(k + 1) % 3], in2 = t[(k + 2) % 3];
      for (const [nb, bit] of [[out2, 1], [in2, 2]] as const) {
        const m = maskOut.get(nb) ?? 0;
        if (m & bit) return false; // edge used twice in the same direction
        maskOut.set(nb, m | bit);
        const f = first.get(nb);
        if (f === undefined) first.set(nb, i);
        else par[find(i)] = find(f);
      }
    }
    const root = around.length ? find(0) : 0;
    for (let i = 1; i < around.length; i++) if (find(i) !== root) return false;
    return true;
  };

  for (const run of runs) {
    const A = chains[run.cA], B = chains[run.cB];
    if (run.cA === run.cB && !(run.aTo < run.bFrom)) continue; // ranges of one chain must not overlap
    // vertex chains, both in the same spatial direction
    const p: number[] = A.verts.slice(run.aFrom, run.aTo + 2);
    const q: number[] = B.verts.slice(run.bFrom, run.bTo + 2).reverse();
    if (p.length < 2 || q.length < 2) continue;
    // shortest-diagonal ladder
    const strip: number[][] = [];
    const ownerP = mesh.owner[half[A.edges[run.aFrom]].tri], ownerQ = mesh.owner[half[B.edges[run.bFrom]].tri];
    const owners: number[] = [];
    let i = 0, j = 0;
    while (i < p.length - 1 || j < q.length - 1) {
      const advP = i < p.length - 1, advQ = j < q.length - 1;
      let takeP: boolean;
      if (advP && advQ) {
        const dP = Math.hypot(...sub(P(p[i + 1]), P(q[j]))), dQ = Math.hypot(...sub(P(p[i]), P(q[j + 1])));
        takeP = dP <= dQ;
      } else takeP = advP;
      if (takeP) { strip.push([p[i + 1], p[i], q[j]]); owners.push(ownerP); i++; }
      else { strip.push([q[j], q[j + 1], p[i]]); owners.push(ownerQ); j++; }
    }
    // ---- validate ----
    let ok = strip.length > 0;
    const coords = strip.map((t) => [...P(t[0]), ...P(t[1]), ...P(t[2])]);
    for (let s = 0; s < strip.length && ok; s++) {
      const t = strip[s];
      if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) { ok = false; break; }
      const c = coords[s];
      if (Math.hypot(...cross([c[3] - c[0], c[4] - c[1], c[5] - c[2]], [c[6] - c[0], c[7] - c[1], c[8] - c[2]])) / 2 <= minArea) { ok = false; break; }
      // every edge: either cancels an open edge (used once) or is brand new
      for (let k = 0; k < 3 && ok; k++) {
        const use = edgeUse.get(uKey(t[k], t[(k + 1) % 3])) ?? 0;
        if (use > 1) ok = false;
      }
    }
    if (ok) {
      // diagonals shared by two strip triangles are fine; anything else new must be unique within the strip
      const seen = new Map<number, number>();
      for (const t of strip) for (let k = 0; k < 3; k++) { const key = uKey(t[k], t[(k + 1) % 3]); seen.set(key, (seen.get(key) ?? 0) + 1); }
      for (const [key, count] of seen) if (count + (edgeUse.get(key) ?? 0) > 2) ok = false;
    }
    if (ok) {
      // no penetration of the mesh, earlier strips, or itself
      for (let s = 0; s < strip.length && ok; s++) {
        const c = coords[s];
        bvh.queryBox(Math.min(c[0], c[3], c[6]) - tol, Math.min(c[1], c[4], c[7]) - tol, Math.min(c[2], c[5], c[8]) - tol, Math.max(c[0], c[3], c[6]) + tol, Math.max(c[1], c[4], c[7]) + tol, Math.max(c[2], c[5], c[8]) + tol, (u) => {
          if (!ok) return;
          const g = u * 9;
          if (trianglesPenetrate(c, strip[s], live9.subarray(g, g + 9), tris[slotOfLive[u]], tol)) ok = false;
        });
        for (const o of added) if (ok && trianglesPenetrate(c, strip[s], o.coords, o.ids, tol)) ok = false;
        for (let r = 0; r < s && ok; r++) if (trianglesPenetrate(c, strip[s], coords[r], strip[r], tol)) ok = false;
      }
    }
    if (ok) {
      const verts = new Set<number>([...p, ...q]);
      for (const v of verts) if (!fanOk(v, strip)) { ok = false; break; }
    }
    if (!ok) { stats.rejectedStrips++; continue; }

    // ---- commit ----
    strip.forEach((t, s) => {
      addTri(t);
      added.push({ coords: coords[s], ids: t });
      const c = coords[s];
      const nn = norm(cross([c[3] - c[0], c[4] - c[1], c[5] - c[2]], [c[6] - c[0], c[7] - c[1], c[8] - c[2]]));
      for (let k = 0; k < 3; k++) {
        out.positions.push(c[k * 3], c[k * 3 + 1], c[k * 3 + 2]);
        out.normals.push(nn[0], nn[1], nn[2]);
        const uv = uvAt.get(t[k]) ?? [0, 0];
        out.uvs.push(uv[0], uv[1]);
      }
      out.owner.push(owners[s]);
      stats.addedTriangles++;
    });
    if (ownerP !== ownerQ) links.push(ownerP, ownerQ);
    stats.strips++;
    stats.bridgedEdges += run.aTo - run.aFrom + 1;
  }
  return { mesh: stats.addedTriangles > 0 ? out : mesh, stats, links };
}
