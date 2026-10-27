import { TriangleBVH, PointStore, clusterPositions, windingNumber } from "./spatial.ts";
import { intersectTriangles, type SegEnd } from "./intersect.ts";
import type { SoupMesh } from "./holes.ts";

/** Self-intersection resolution: makes a mesh whose parts pass through each
 * other into one whose outer shape is the same but whose interior geometry is
 * gone - the surface of the UNION of all the solids it contains.
 *
 *  1. Every pair of triangles that pass through each other is found (BVH) and
 *     the segment where they cross is computed.
 *  2. Each affected triangle is re-triangulated so those segments become edges
 *     (a small constrained triangulation per triangle, with crossing points on
 *     shared edges given one identity so neighbours split consistently).
 *  3. The resulting pieces are grouped into "patches": pieces connected through
 *     ordinary edges, separated only by the intersection curves.
 *  4. Each patch is classified with the winding number of the ORIGINAL mesh on
 *     both of its sides. A patch with solid on both sides is interior and is
 *     removed; a patch with solid on exactly one side is on the outer surface
 *     and kept; one with none (an open sheet) is kept.
 *
 * Operates on flat per-corner soup geometry; output pieces carry attributes
 * (normal, UV) interpolated from the triangle they were cut from, so a final
 * weld can rebuild shared vertices. Skips everything (changed = false) when the
 * mesh has no crossing triangles. Coplanar overlaps are not resolved. */

export interface ResolveStats {
  /** Pairs of triangles found passing through each other. */
  intersectingPairs: number;
  /** Triangles re-triangulated along intersection curves. */
  splitTriangles: number;
  /** Triangles whose re-triangulation failed and were left whole. */
  failedTriangles: number;
  patches: number;
  removedPatches: number;
  removedTriangles: number;
  /** Coplanar triangle pairs (not resolved). */
  skippedCoplanar: number;
}

type V2 = [number, number];

// ---------------------------------------------------------------------------------------
// Constrained triangulation of one triangle (2D)
// ---------------------------------------------------------------------------------------

function orient(a: V2, b: V2, c: V2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Triangulates the triangle pts[0..2] (CCW) with extra points pts[3..] inserted
 * and each constraint (index pair) made an edge. Constraints must not cross each
 * other or pass through other points. */
function triangulate(pts: V2[], constraints: [number, number][], eps: number): number[][] | null {
  let tris: number[][] = [[0, 1, 2]];
  const dist = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

  const insert = (pi: number): boolean => {
    const p = pts[pi];
    let best = -1, bestMin = -Infinity;
    for (let t = 0; t < tris.length; t++) {
      const [a, b, c] = tris[t];
      const A = pts[a], B = pts[b], C = pts[c];
      const d1 = orient(A, B, p) / (dist(A, B) || 1), d2 = orient(B, C, p) / (dist(B, C) || 1), d3 = orient(C, A, p) / (dist(C, A) || 1);
      const m = Math.min(d1, d2, d3);
      if (m > bestMin) { bestMin = m; best = t; }
    }
    if (best < 0 || bestMin < -eps) return false;
    const tri = tris[best];
    // near an existing vertex: nothing to insert
    for (const v of tri) if (dist(pts[v], p) <= eps) return true;
    // on an edge?
    let edge = -1, edgeD = Infinity;
    for (let k = 0; k < 3; k++) {
      const A = pts[tri[k]], B = pts[tri[(k + 1) % 3]];
      const d = Math.abs(orient(A, B, p)) / (dist(A, B) || 1);
      if (d <= eps && d < edgeD) { edgeD = d; edge = k; }
    }
    if (edge >= 0) {
      const v0 = tri[edge], v1 = tri[(edge + 1) % 3], v2 = tri[(edge + 2) % 3];
      const next: number[][] = [];
      let neighbor = -1;
      for (let t = 0; t < tris.length; t++) {
        if (t === best) continue;
        const n = tris[t];
        for (let k = 0; k < 3; k++) if (n[k] === v1 && n[(k + 1) % 3] === v0) neighbor = t;
      }
      for (let t = 0; t < tris.length; t++) {
        if (t === best) { next.push([v0, pi, v2], [pi, v1, v2]); continue; }
        if (t === neighbor) {
          const n = tris[t];
          let k = 0;
          while (!(n[k] === v1 && n[(k + 1) % 3] === v0)) k++;
          const w = n[(k + 2) % 3];
          next.push([v1, pi, w], [pi, v0, w]);
          continue;
        }
        next.push(tris[t]);
      }
      tris = next;
    } else {
      const [a, b, c] = tri;
      tris.splice(best, 1, [a, b, pi], [b, c, pi], [c, a, pi]);
    }
    return true;
  };

  for (let i = 3; i < pts.length; i++) if (!insert(i)) return null;

  const constrained = new Set<number>();
  const K = pts.length + 1;
  const ek = (a: number, b: number): number => (a < b ? a * K + b : b * K + a);

  // Collinear points can leave a zero-area sliver whose middle vertex lies ON the
  // long edge of the triangle across from it (a vertex sitting in an edge's
  // interior = a hidden T-junction). Flip that long edge to its neighbour: the
  // result is two proper triangles that both use the middle vertex.
  const fixSlivers = (): void => {
    let guard = tris.length * 4 + 20;
    for (let again = true; again && guard-- > 0; ) {
      again = false;
      for (let t = 0; t < tris.length; t++) {
        const tri = tris[t];
        // longest edge
        let k = 0, longest = -1;
        for (let e = 0; e < 3; e++) {
          const l = dist(pts[tri[e]], pts[tri[(e + 1) % 3]]);
          if (l > longest) { longest = l; k = e; }
        }
        const u = tri[k], v = tri[(k + 1) % 3], w = tri[(k + 2) % 3];
        if (longest <= 0 || Math.abs(orient(pts[u], pts[v], pts[w])) / longest > eps) continue; // not a sliver
        if (constrained.has(ek(u, v))) continue; // never flip an enforced constraint
        let n = -1;
        for (let m = 0; m < tris.length && n < 0; m++) {
          for (let e = 0; e < 3; e++) if (tris[m][e] === v && tris[m][(e + 1) % 3] === u) { n = m; break; }
        }
        if (n < 0) continue; // boundary edge: nothing to flip across
        const nt = tris[n];
        let e2 = 0; while (!(nt[e2] === v && nt[(e2 + 1) % 3] === u)) e2++;
        const x = nt[(e2 + 2) % 3];
        const a1 = orient(pts[u], pts[x], pts[w]), a2 = orient(pts[x], pts[v], pts[w]);
        if (a1 <= 0 || a2 <= 0) continue;
        const lo = Math.min(t, n), hi = Math.max(t, n);
        tris.splice(hi, 1);
        tris.splice(lo, 1);
        tris.push([u, x, w], [x, v, w]);
        again = true;
        break;
      }
    }
  };
  fixSlivers();

  const edgeExists = (a: number, b: number): boolean => tris.some((t) => (t.includes(a) && t.includes(b)));

  for (const [a, b] of constraints) {
    if (a === b) continue;
    fixSlivers(); // earlier flips may have left a vertex sitting on an edge
    if (edgeExists(a, b)) { constrained.add(ek(a, b)); continue; }
    const A = pts[a], B = pts[b];
    const ab = dist(A, B) || 1;
    const crosses = (u: number, v: number): boolean => {
      if (u === a || u === b || v === a || v === b) return false;
      const U = pts[u], W = pts[v];
      const o1 = orient(A, B, U) / ab, o2 = orient(A, B, W) / ab;
      if (!((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps))) return false;
      const uw = dist(U, W) || 1;
      const o3 = orient(U, W, A) / uw, o4 = orient(U, W, B) / uw;
      return (o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0);
    };
    const collect = (): [number, number][] => {
      const seen = new Set<number>();
      const list: [number, number][] = [];
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          const u = t[k], v = t[(k + 1) % 3];
          const key = ek(u, v);
          if (seen.has(key)) continue;
          seen.add(key);
          if (!constrained.has(key) && crosses(u, v)) list.push([u, v]);
        }
      }
      return list;
    };
    let queue = collect();
    let guard = 50 + tris.length * 20;
    while (queue.length && guard-- > 0) {
      const [u, v] = queue.shift()!;
      // locate the two triangles on edge u-v
      let i1 = -1, i2 = -1;
      for (let t = 0; t < tris.length; t++) {
        const n = tris[t];
        for (let k = 0; k < 3; k++) {
          if (n[k] === u && n[(k + 1) % 3] === v) i1 = t;
          if (n[k] === v && n[(k + 1) % 3] === u) i2 = t;
        }
      }
      if (i1 < 0 || i2 < 0) continue; // already flipped away (or boundary)
      const t1 = tris[i1], t2 = tris[i2];
      let k1 = 0; while (!(t1[k1] === u && t1[(k1 + 1) % 3] === v)) k1++;
      let k2 = 0; while (!(t2[k2] === v && t2[(k2 + 1) % 3] === u)) k2++;
      const w1 = t1[(k1 + 2) % 3], w2 = t2[(k2 + 2) % 3];
      // quad CCW: u, w2, v, w1 -> new triangles (u,w2,w1) and (w2,v,w1)
      const o1 = orient(pts[u], pts[w2], pts[w1]), o2 = orient(pts[w2], pts[v], pts[w1]);
      if (o1 > 1e-18 && o2 > 1e-18) {
        const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
        tris.splice(hi, 1);
        tris.splice(lo, 1);
        tris.push([u, w2, w1], [w2, v, w1]);
        if (crosses(w1, w2)) queue.push([w1, w2]);
      } else {
        queue.push([u, v]); // not flippable yet
      }
      if (queue.length === 0) queue = collect();
    }
    if (!edgeExists(a, b)) {
      fixSlivers();
      if (!edgeExists(a, b)) return null;
    }
    constrained.add(ek(a, b));
  }
  fixSlivers();
  return tris;
}

// ---------------------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------------------

export function resolveSelfIntersections(mesh: SoupMesh, tol: number): { mesh: SoupMesh; stats: ResolveStats; changed: boolean } {
  const stats: ResolveStats = { intersectingPairs: 0, splitTriangles: 0, failedTriangles: 0, patches: 0, removedPatches: 0, removedTriangles: 0, skippedCoplanar: 0 };
  const nTri = Math.floor(mesh.positions.length / 9);
  if (nTri < 2) return { mesh, stats, changed: false };

  const cl = clusterPositions(mesh.positions, tol);
  const C = cl.clusterCount;
  const cp = cl.clusterPos;
  const P = (id: number, store?: PointStore): number[] => (store && id >= C ? [store.coords[id * 3], store.coords[id * 3 + 1], store.coords[id * 3 + 2]] : [cp[id * 3], cp[id * 3 + 1], cp[id * 3 + 2]]);

  // live triangles in snapped (cluster) coordinates
  const live: number[] = []; // original triangle index
  const ids: number[][] = [];
  const minArea2 = tol * tol * 2;
  for (let t = 0; t < nTri; t++) {
    const a = cl.clusterOfCorner[t * 3], b = cl.clusterOfCorner[t * 3 + 1], c = cl.clusterOfCorner[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    const A = P(a), B = P(b), Cc = P(c);
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) <= minArea2) continue;
    live.push(t);
    ids.push([a, b, c]);
  }
  const L = live.length;
  if (L < 2) return { mesh, stats, changed: false };
  const coords = new Float64Array(L * 9);
  for (let i = 0; i < L; i++) for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) coords[i * 9 + k * 3 + a] = cp[ids[i][k] * 3 + a];
  const bvh = new TriangleBVH(coords);

  // ---- 1. crossing pairs -> segments ------------------------------------------------------
  const store = new PointStore(tol, cp);
  const edgeKey = (a: number, b: number): number => (a < b ? a * C + b : b * C + a); // original edges only (ids < C)
  const edgePoints = new Map<number, Set<number>>();
  const segs: [number, number][][] = Array.from({ length: L }, () => []);
  const segRecords: { p: number; q: number; i: number; j: number }[] = [];

  const resolveEnd = (e: SegEnd, i: number, j: number): number => {
    const tri = e.src === 0 ? i : j;
    if (e.kind === "vertex") return ids[tri][e.idx];
    const id = store.add(e.x, e.y, e.z);
    const a = ids[tri][e.idx], b = ids[tri][(e.idx + 1) % 3];
    if (id !== a && id !== b) {
      const key = edgeKey(a, b);
      const set = edgePoints.get(key);
      if (set) set.add(id);
      else edgePoints.set(key, new Set([id]));
    }
    return id;
  };

  bvh.selfPairs((i, j) => {
    const r = intersectTriangles(coords.subarray(i * 9, i * 9 + 9), ids[i], coords.subarray(j * 9, j * 9 + 9), ids[j], tol);
    if (r === null) return;
    if (r === "coplanar") { stats.skippedCoplanar++; return; }
    const p = resolveEnd(r.a, i, j), q = resolveEnd(r.b, i, j);
    if (p === q) return;
    stats.intersectingPairs++;
    segs[i].push([p, q]);
    segs[j].push([p, q]);
    segRecords.push({ p, q, i, j });
  }, tol);

  if (stats.intersectingPairs === 0) return { mesh, stats, changed: false };

  // A point that lies on a segment two triangles share must be a vertex of BOTH
  // (e.g. where a third surface crosses their intersection line, which only one
  // of them may have detected), or one side keeps a T-junction. Propagate such
  // points to both triangles until nothing changes.
  const extraPts: Set<number>[] = Array.from({ length: L }, () => new Set<number>());
  {
    const known = (t: number): number[] => {
      const out: number[] = [...ids[t]];
      for (const [a, b] of segs[t]) out.push(a, b);
      for (let k = 0; k < 3; k++) {
        const set = edgePoints.get(edgeKey(ids[t][k], ids[t][(k + 1) % 3]));
        if (set) for (const id of set) out.push(id);
      }
      for (const id of extraPts[t]) out.push(id);
      return out;
    };
    const onSegment = (r: number, p: number, q: number): boolean => {
      const R = P(r, store), A = P(p, store), B = P(q, store);
      const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
      const len2 = dx * dx + dy * dy + dz * dz;
      if (len2 <= 0) return false;
      const len = Math.sqrt(len2);
      const par = ((R[0] - A[0]) * dx + (R[1] - A[1]) * dy + (R[2] - A[2]) * dz) / len2;
      if (par * len <= tol || (1 - par) * len <= tol) return false; // at/near an end
      const cx = A[0] + dx * par - R[0], cy = A[1] + dy * par - R[1], cz = A[2] + dz * par - R[2];
      return Math.hypot(cx, cy, cz) <= tol;
    };
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const rec of segRecords) {
        for (const r of new Set([...known(rec.i), ...known(rec.j)])) {
          if (r === rec.p || r === rec.q || !onSegment(r, rec.p, rec.q)) continue;
          if (!extraPts[rec.i].has(r)) { extraPts[rec.i].add(r); changed = true; }
          if (!extraPts[rec.j].has(r)) { extraPts[rec.j].add(r); changed = true; }
        }
      }
      if (!changed) break;
    }
  }

  // ---- 2. re-triangulate affected triangles ------------------------------------------------
  interface TriResult { subs: number[][]; barrier: number[]; failed: boolean; split: boolean; points: number[] }
  const subTri: number[] = []; // flat ids, 3 per piece
  const subParent: number[] = []; // live index
  const barrierPairs: number[] = []; // constraint edges (global id pairs)
  const segsOf: number[][] = Array.from({ length: L }, () => []); // indices into segRecords
  segRecords.forEach((rec, ri) => { segsOf[rec.i].push(ri); segsOf[rec.j].push(ri); });

  const processTriangle = (t: number): TriResult => {
    const [ia, ib, ic] = ids[t];
    const triEdgePts: number[] = [];
    for (let k = 0; k < 3; k++) {
      const set = edgePoints.get(edgeKey(ids[t][k], ids[t][(k + 1) % 3]));
      if (set) for (const id of set) triEdgePts.push(id);
    }
    if (segs[t].length === 0 && triEdgePts.length === 0 && extraPts[t].size === 0) {
      return { subs: [[ia, ib, ic]], barrier: [], failed: false, split: false, points: [] };
    }

    // local frame on the triangle's plane
    const A = P(ia, store), B = P(ib, store), Cc = P(ic, store);
    const ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2];
    const el = Math.hypot(ex, ey, ez);
    const e1 = [ex / el, ey / el, ez / el];
    let nx = ey * (Cc[2] - A[2]) - ez * (Cc[1] - A[1]), ny = ez * (Cc[0] - A[0]) - ex * (Cc[2] - A[2]), nz = ex * (Cc[1] - A[1]) - ey * (Cc[0] - A[0]);
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl; ny /= nl; nz /= nl;
    const e2 = [ny * e1[2] - nz * e1[1], nz * e1[0] - nx * e1[2], nx * e1[1] - ny * e1[0]];
    const to2D = (p: number[]): V2 => {
      const dx = p[0] - A[0], dy = p[1] - A[1], dz = p[2] - A[2];
      return [dx * e1[0] + dy * e1[1] + dz * e1[2], dx * e2[0] + dy * e2[1] + dz * e2[2]];
    };
    const to3D = (q: V2): number[] => [A[0] + e1[0] * q[0] + e2[0] * q[1], A[1] + e1[1] * q[0] + e2[1] * q[1], A[2] + e1[2] * q[0] + e2[2] * q[1]];

    const localIds: number[] = [];
    const xy: V2[] = [];
    const localOf = new Map<number, number>();
    const addLocal = (gid: number): number => {
      const have = localOf.get(gid);
      if (have !== undefined) return have;
      const q = to2D(P(gid, store));
      for (let i = 0; i < xy.length; i++) {
        if (Math.hypot(xy[i][0] - q[0], xy[i][1] - q[1]) <= tol) { localOf.set(gid, i); return i; }
      }
      localIds.push(gid);
      xy.push(q);
      localOf.set(gid, xy.length - 1);
      return xy.length - 1;
    };
    addLocal(ia); addLocal(ib); addLocal(ic);
    for (const id of triEdgePts) addLocal(id);
    for (const id of extraPts[t]) addLocal(id);
    let segments: [number, number][] = [];
    const segSeen = new Set<number>();
    const addSeg = (a: number, b: number): void => {
      if (a === b) return;
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      if (segSeen.has(key)) return;
      segSeen.add(key);
      segments.push([a, b]);
    };
    for (const [p, q] of segs[t]) addSeg(addLocal(p), addLocal(q));

    // split segments at crossings and at points lying on them
    for (let pass = 0; pass < 60; pass++) {
      let changed = false;
      outer: for (let s = 0; s < segments.length; s++) {
        const [a, b] = segments[s];
        const Aa = xy[a], Bb = xy[b];
        const len = Math.hypot(Bb[0] - Aa[0], Bb[1] - Aa[1]) || 1;
        // points on the segment interior
        for (let pI = 0; pI < xy.length; pI++) {
          if (pI === a || pI === b) continue;
          const o = orient(Aa, Bb, xy[pI]) / len;
          if (Math.abs(o) > tol) continue;
          const par = ((xy[pI][0] - Aa[0]) * (Bb[0] - Aa[0]) + (xy[pI][1] - Aa[1]) * (Bb[1] - Aa[1])) / (len * len);
          if (par * len <= tol || (1 - par) * len <= tol || par < 0 || par > 1) continue;
          segments.splice(s, 1);
          segSeen.clear(); segments.forEach(([x, y]) => segSeen.add(x < y ? x * 1e6 + y : y * 1e6 + x));
          addSeg(a, pI); addSeg(pI, b);
          changed = true;
          break outer;
        }
        // crossings with other segments
        for (let u = s + 1; u < segments.length; u++) {
          const [c, d] = segments[u];
          if (c === a || c === b || d === a || d === b) continue;
          const Cc2 = xy[c], Dd = xy[d];
          const o1 = orient(Aa, Bb, Cc2), o2 = orient(Aa, Bb, Dd);
          if (!((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))) continue;
          const o3 = orient(Cc2, Dd, Aa), o4 = orient(Cc2, Dd, Bb);
          if (!((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) continue;
          const tt = o1 / (o1 - o2);
          const hit: V2 = [Cc2[0] + (Dd[0] - Cc2[0]) * tt, Cc2[1] + (Dd[1] - Cc2[1]) * tt];
          const gid = store.add(...(to3D(hit) as [number, number, number]));
          const m = addLocal(gid);
          segments = segments.filter((_, idx) => idx !== s && idx !== u);
          segSeen.clear(); segments.forEach(([x, y]) => segSeen.add(x < y ? x * 1e6 + y : y * 1e6 + x));
          addSeg(a, m); addSeg(m, b); addSeg(c, m); addSeg(m, d);
          changed = true;
          break outer;
        }
      }
      if (!changed) break;
    }

    const local = triangulate(xy, segments, tol);
    if (!local) return { subs: [[ia, ib, ic]], barrier: [], failed: true, split: false, points: localIds.slice() };
    const subs: number[][] = [];
    for (const [a, b, c] of local) {
      const ga = localIds[a], gb = localIds[b], gc = localIds[c];
      if (ga === gb || gb === gc || ga === gc) continue;
      subs.push([ga, gb, gc]);
    }
    const barrier: number[] = [];
    for (const [a, b] of segments) barrier.push(localIds[a], localIds[b]);
    return { subs, barrier, failed: false, split: true, points: localIds.slice() };
  };

  const results: TriResult[] = new Array(L);
  const dirty = new Set<number>();
  for (let t = 0; t < L; t++) dirty.add(t);
  // Process every triangle; whenever one creates a point (a crossing of two of its
  // segments) that lies on a segment it shares with another triangle, hand the
  // point to that triangle and re-process it, until nothing changes.
  for (let round = 0; round < 8 && dirty.size > 0; round++) {
    const batch = [...dirty];
    dirty.clear();
    for (const t of batch) {
      const res = processTriangle(t);
      results[t] = res;
      if (res.points.length === 0) continue;
      for (const ri of segsOf[t]) {
        const rec = segRecords[ri];
        const partner = rec.i === t ? rec.j : rec.i;
        const A = P(rec.p, store), B = P(rec.q, store);
        const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
        const len2 = dx * dx + dy * dy + dz * dz;
        if (len2 <= 0) continue;
        const len = Math.sqrt(len2);
        for (const r of res.points) {
          if (r === rec.p || r === rec.q || extraPts[partner].has(r) || ids[partner].includes(r)) continue;
          const R = P(r, store);
          const par = ((R[0] - A[0]) * dx + (R[1] - A[1]) * dy + (R[2] - A[2]) * dz) / len2;
          if (par * len <= tol || (1 - par) * len <= tol) continue;
          if (Math.hypot(A[0] + dx * par - R[0], A[1] + dy * par - R[1], A[2] + dz * par - R[2]) > tol) continue;
          extraPts[partner].add(r);
          dirty.add(partner);
        }
      }
    }
  }

  for (let t = 0; t < L; t++) {
    const res = results[t];
    if (res.failed) stats.failedTriangles++;
    else if (res.split) stats.splitTriangles++;
    for (const [a, b, c] of res.subs) {
      subTri.push(a, b, c);
      subParent.push(t);
    }
    for (let i = 0; i < res.barrier.length; i++) barrierPairs.push(res.barrier[i]);
  }

  // ---- 3. patches --------------------------------------------------------------------------
  const S = subParent.length;
  const K = store.count + 1;
  const ek = (a: number, b: number): number => (a < b ? a * K + b : b * K + a);
  const barrier = new Set<number>();
  for (let i = 0; i < barrierPairs.length; i += 2) barrier.add(ek(barrierPairs[i], barrierPairs[i + 1]));
  const edgeTris = new Map<number, number[]>();
  for (let s = 0; s < S; s++) {
    for (let k = 0; k < 3; k++) {
      const key = ek(subTri[s * 3 + k], subTri[s * 3 + (k + 1) % 3]);
      const list = edgeTris.get(key);
      if (list) list.push(s);
      else edgeTris.set(key, [s]);
    }
  }
  const parent = new Int32Array(S);
  for (let i = 0; i < S; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (const [key, list] of edgeTris) {
    if (list.length === 2 && !barrier.has(key)) parent[find(list[0])] = find(list[1]);
  }

  // ---- 4. classify patches ------------------------------------------------------------------
  const subArea = (s: number): number => {
    const a = P(subTri[s * 3], store), b = P(subTri[s * 3 + 1], store), c = P(subTri[s * 3 + 2], store);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  const rep = new Map<number, { s: number; area: number }>();
  for (let s = 0; s < S; s++) {
    const r = find(s), area = subArea(s);
    const cur = rep.get(r);
    if (!cur || area > cur.area) rep.set(r, { s, area });
  }
  stats.patches = rep.size;
  const off = Math.max(tol * 8, 1e-9);
  const keepPatch = new Map<number, boolean>();
  for (const [r, { s }] of rep) {
    const a = P(subTri[s * 3], store), b = P(subTri[s * 3 + 1], store), c = P(subTri[s * 3 + 2], store);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-18) { keepPatch.set(r, true); continue; }
    nx /= nl; ny /= nl; nz /= nl;
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    const wFront = windingNumber(bvh, cx + nx * off, cy + ny * off, cz + nz * off, nx, ny, nz);
    const wBack = windingNumber(bvh, cx - nx * off, cy - ny * off, cz - nz * off, -nx, -ny, -nz);
    const frontInside = wFront !== 0, backInside = wBack !== 0;
    keepPatch.set(r, !(frontInside && backInside)); // interior on both sides -> remove
  }

  // ---- output ----------------------------------------------------------------------------------
  const out: SoupMesh = { positions: [], normals: [], uvs: [], owner: [] };
  for (let s = 0; s < S; s++) {
    if (!keepPatch.get(find(s))) { stats.removedTriangles++; continue; }
    const pt = live[subParent[s]];
    const p0 = P(ids[subParent[s]][0]), p1 = P(ids[subParent[s]][1]), p2 = P(ids[subParent[s]][2]);
    const v0x = p1[0] - p0[0], v0y = p1[1] - p0[1], v0z = p1[2] - p0[2], v1x = p2[0] - p0[0], v1y = p2[1] - p0[1], v1z = p2[2] - p0[2];
    const d00 = v0x * v0x + v0y * v0y + v0z * v0z, d01 = v0x * v1x + v0y * v1y + v0z * v1z, d11 = v1x * v1x + v1y * v1y + v1z * v1z;
    const denom = d00 * d11 - d01 * d01 || 1;
    for (let k = 0; k < 3; k++) {
      const q = P(subTri[s * 3 + k], store);
      const v2x = q[0] - p0[0], v2y = q[1] - p0[1], v2z = q[2] - p0[2];
      const d20 = v2x * v0x + v2y * v0y + v2z * v0z, d21 = v2x * v1x + v2y * v1y + v2z * v1z;
      let bv = (d11 * d20 - d01 * d21) / denom, bw = (d00 * d21 - d01 * d20) / denom;
      bv = Math.min(1, Math.max(0, bv)); bw = Math.min(1, Math.max(0, bw));
      if (bv + bw > 1) { const sum = bv + bw; bv /= sum; bw /= sum; }
      const bu = 1 - bv - bw;
      const c0 = pt * 3, c1 = pt * 3 + 1, c2 = pt * 3 + 2;
      let nx = bu * (mesh.normals[c0 * 3] ?? 0) + bv * (mesh.normals[c1 * 3] ?? 0) + bw * (mesh.normals[c2 * 3] ?? 0);
      let ny = bu * (mesh.normals[c0 * 3 + 1] ?? 0) + bv * (mesh.normals[c1 * 3 + 1] ?? 0) + bw * (mesh.normals[c2 * 3 + 1] ?? 0);
      let nz = bu * (mesh.normals[c0 * 3 + 2] ?? 0) + bv * (mesh.normals[c1 * 3 + 2] ?? 0) + bw * (mesh.normals[c2 * 3 + 2] ?? 0);
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      out.positions.push(q[0], q[1], q[2]);
      out.normals.push(nx, ny, nz);
      out.uvs.push(
        bu * (mesh.uvs[c0 * 2] ?? 0) + bv * (mesh.uvs[c1 * 2] ?? 0) + bw * (mesh.uvs[c2 * 2] ?? 0),
        bu * (mesh.uvs[c0 * 2 + 1] ?? 0) + bv * (mesh.uvs[c1 * 2 + 1] ?? 0) + bw * (mesh.uvs[c2 * 2 + 1] ?? 0),
      );
    }
    out.owner.push(mesh.owner[pt]);
  }
  stats.removedPatches = [...keepPatch.values()].filter((k) => !k).length;
  return { mesh: out, stats, changed: true };
}
