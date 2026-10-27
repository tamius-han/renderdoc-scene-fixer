/** Triangle-triangle intersection for the mesh-repair steps.
 *
 * Unlike a plain boolean test this reports WHERE two triangles cross, as a
 * segment whose endpoints remember which vertex or edge of which triangle
 * they lie on, and it is topology-aware: triangles that share vertices (by
 * `ids`) only "intersect" if they genuinely pass through each other, not for
 * merely touching along the shared vertex/edge.
 *
 * Crossing points on an edge are computed from the edge's two endpoints in a
 * canonical (id-sorted) order against a canonically-built plane of the other
 * triangle, so two triangles sharing that edge compute bit-identical points -
 * that's what lets the arrangement step give the point a single identity. */

export type Tri9 = ArrayLike<number>; // 9 numbers: a.xyz b.xyz c.xyz

export interface SegEnd {
  x: number;
  y: number;
  z: number;
  /** Which triangle's vertex/edge it sits on: 0 = A, 1 = B. */
  src: 0 | 1;
  kind: "vertex" | "edge";
  /** Vertex index (0-2), or edge index (edge i runs from vertex i to (i+1)%3). */
  idx: number;
}

export type IntersectionResult = null | "coplanar" | { a: SegEnd; b: SegEnd };

interface Plane {
  nx: number; ny: number; nz: number; // unit normal
  ox: number; oy: number; oz: number; // origin (vertex with the smallest id)
  area2: number; // |cross| (twice the area)
}

function sortedOrder(ids: ArrayLike<number>): number[] {
  const o = [0, 1, 2];
  o.sort((i, j) => ids[i] - ids[j]);
  return o;
}

/** Plane built in id-sorted vertex order, so it's identical wherever the same triangle is seen. */
function canonicalPlane(t: Tri9, ids: ArrayLike<number>): Plane {
  const [i0, i1, i2] = sortedOrder(ids);
  const ax = t[i0 * 3], ay = t[i0 * 3 + 1], az = t[i0 * 3 + 2];
  const ux = t[i1 * 3] - ax, uy = t[i1 * 3 + 1] - ay, uz = t[i1 * 3 + 2] - az;
  const vx = t[i2 * 3] - ax, vy = t[i2 * 3 + 1] - ay, vz = t[i2 * 3 + 2] - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len > 0) { nx /= len; ny /= len; nz /= len; }
  return { nx, ny, nz, ox: ax, oy: ay, oz: az, area2: len };
}

function dist(p: Plane, x: number, y: number, z: number): number {
  return p.nx * (x - p.ox) + p.ny * (y - p.oy) + p.nz * (z - p.oz);
}

interface Pt { x: number; y: number; z: number; kind: "vertex" | "edge"; idx: number; s: number }

/** Points where triangle `t` meets the OTHER triangle's plane. */
function planeCrossings(t: Tri9, ids: ArrayLike<number>, d: number[], dir: [number, number, number]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 3; i++) {
    if (d[i] === 0) {
      const x = t[i * 3], y = t[i * 3 + 1], z = t[i * 3 + 2];
      out.push({ x, y, z, kind: "vertex", idx: i, s: x * dir[0] + y * dir[1] + z * dir[2] });
    }
  }
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    if ((d[i] > 0 && d[j] < 0) || (d[i] < 0 && d[j] > 0)) {
      // canonical vertex order for bit-identical results across neighbours
      const lo = ids[i] <= ids[j] ? i : j, hi = lo === i ? j : i;
      const tt = d[lo] / (d[lo] - d[hi]);
      const x = t[lo * 3] + (t[hi * 3] - t[lo * 3]) * tt;
      const y = t[lo * 3 + 1] + (t[hi * 3 + 1] - t[lo * 3 + 1]) * tt;
      const z = t[lo * 3 + 2] + (t[hi * 3 + 2] - t[lo * 3 + 2]) * tt;
      out.push({ x, y, z, kind: "edge", idx: i, s: x * dir[0] + y * dir[1] + z * dir[2] });
    }
  }
  return out;
}

/** Intersection of triangles A and B. `idsA`/`idsB` are position-cluster ids of
 * the corners (equal ids = the same point). `eps` is the length tolerance for
 * "on the plane" and for the minimum overlap length of a crossing. */
export function intersectTriangles(A: Tri9, idsA: ArrayLike<number>, B: Tri9, idsB: ArrayLike<number>, eps: number): IntersectionResult {
  const pA = canonicalPlane(A, idsA), pB = canonicalPlane(B, idsB);
  if (pA.area2 <= 0 || pB.area2 <= 0) return null;

  const dA = [0, 0, 0], dB = [0, 0, 0]; // A's vertices vs plane B; B's vertices vs plane A
  for (let i = 0; i < 3; i++) {
    dA[i] = dist(pB, A[i * 3], A[i * 3 + 1], A[i * 3 + 2]);
    dB[i] = dist(pA, B[i * 3], B[i * 3 + 1], B[i * 3 + 2]);
    if (Math.abs(dA[i]) <= eps) dA[i] = 0;
    if (Math.abs(dB[i]) <= eps) dB[i] = 0;
  }
  // a vertex shared with the other triangle lies on its plane by definition
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (idsA[i] === idsB[j]) { dA[i] = 0; dB[j] = 0; }
    }
  }
  if (dA[0] === 0 && dA[1] === 0 && dA[2] === 0 && dB[0] === 0 && dB[1] === 0 && dB[2] === 0) return "coplanar";
  if ((dA[0] > 0 && dA[1] > 0 && dA[2] > 0) || (dA[0] < 0 && dA[1] < 0 && dA[2] < 0)) return null;
  if ((dB[0] > 0 && dB[1] > 0 && dB[2] > 0) || (dB[0] < 0 && dB[1] < 0 && dB[2] < 0)) return null;

  // direction of the line where the two planes meet
  let lx = pA.ny * pB.nz - pA.nz * pB.ny, ly = pA.nz * pB.nx - pA.nx * pB.nz, lz = pA.nx * pB.ny - pA.ny * pB.nx;
  const ll = Math.hypot(lx, ly, lz);
  if (ll < 1e-12) return "coplanar"; // parallel planes within tolerance
  lx /= ll; ly /= ll; lz /= ll;
  const dir: [number, number, number] = [lx, ly, lz];

  const cA = planeCrossings(A, idsA, dA, dir);
  const cB = planeCrossings(B, idsB, dB, dir);
  if (cA.length < 2 || cB.length < 2) return null;

  cA.sort((p, q) => p.s - q.s);
  cB.sort((p, q) => p.s - q.s);
  const a0 = cA[0], a1 = cA[cA.length - 1], b0 = cB[0], b1 = cB[cB.length - 1];
  const loFromA = a0.s >= b0.s, hiFromA = a1.s <= b1.s;
  const lo = loFromA ? a0 : b0, hi = hiFromA ? a1 : b1;
  if (hi.s - lo.s <= eps) return null; // only touching

  const end = (p: Pt, fromA: boolean): SegEnd => ({ x: p.x, y: p.y, z: p.z, src: fromA ? 0 : 1, kind: p.kind, idx: p.idx });
  const ea = end(lo, loFromA), eb = end(hi, hiFromA);

  // A segment that is just an edge both triangles share (both ends are shared
  // vertices) is contact, not a crossing.
  const sharedVertex = (e: SegEnd): boolean => {
    if (e.kind !== "vertex") return false;
    const id = e.src === 0 ? idsA[e.idx] : idsB[e.idx];
    const other = e.src === 0 ? idsB : idsA;
    return other[0] === id || other[1] === id || other[2] === id;
  };
  if (sharedVertex(ea) && sharedVertex(eb)) return null;
  return { a: ea, b: eb };
}

/** Do two coplanar triangles overlap with positive area (touching doesn't count)? */
export function coplanarOverlap(A: Tri9, B: Tri9, eps: number): boolean {
  // project to 2D by dropping the dominant normal axis of A
  const ux = A[3] - A[0], uy = A[4] - A[1], uz = A[5] - A[2], vx = A[6] - A[0], vy = A[7] - A[1], vz = A[8] - A[2];
  const nx = Math.abs(uy * vz - uz * vy), ny = Math.abs(uz * vx - ux * vz), nz = Math.abs(ux * vy - uy * vx);
  const drop = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
  const ia = drop === 0 ? 1 : 0, ib = drop === 2 ? 1 : 2;
  const P = (T: Tri9): number[][] => [0, 1, 2].map((i) => [T[i * 3 + ia], T[i * 3 + ib]]);
  const a = P(A), b = P(B);
  const axes: number[][] = [];
  for (const tri of [a, b]) {
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const ex = tri[j][0] - tri[i][0], ey = tri[j][1] - tri[i][1];
      const l = Math.hypot(ex, ey);
      if (l > 0) axes.push([-ey / l, ex / l]);
    }
  }
  for (const [ax, ay] of axes) {
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const p of a) { const s = p[0] * ax + p[1] * ay; if (s < aMin) aMin = s; if (s > aMax) aMax = s; }
    for (const p of b) { const s = p[0] * ax + p[1] * ay; if (s < bMin) bMin = s; if (s > bMax) bMax = s; }
    if (aMax <= bMin + eps || bMax <= aMin + eps) return false; // separated (or just touching)
  }
  return true;
}

/** Do the two triangles pass through each other (or overlap, if coplanar)?
 * Triangles that merely touch - at a shared vertex/edge or otherwise - don't. */
export function trianglesPenetrate(A: Tri9, idsA: ArrayLike<number>, B: Tri9, idsB: ArrayLike<number>, eps: number): boolean {
  const r = intersectTriangles(A, idsA, B, idsB, eps);
  if (r === null) return false;
  if (r === "coplanar") return coplanarOverlap(A, B, eps);
  return true;
}
