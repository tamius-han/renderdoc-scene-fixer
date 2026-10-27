/** Spatial helpers shared by the mesh-repair steps (draw-call layer detection,
 * push-bias inside/outside tests, hole-plug validation and self-intersection
 * resolution): a triangle BVH, ray casting, point-triangle distance and an
 * "improper intersection" test for triangle pairs. No THREE dependency, so it
 * runs (and is tested) standalone.
 *
 * Triangles are given as one flat Float64Array, 9 numbers (3 corners x xyz)
 * per triangle. */

// ---------------------------------------------------------------------------------------
// Position clustering (same scheme weld.ts uses)
// ---------------------------------------------------------------------------------------

export interface PositionClusters {
  clusterOfCorner: Int32Array;
  /** xyz per cluster (the first corner that created it). */
  clusterPos: Float64Array;
  clusterCount: number;
}

/** Groups corner positions that lie within `tol` of each other. Spatial hash
 * with cell size 2*tol: a match is always in the point's own cell or the one
 * neighbour per axis on the side it's closer to (<= 8 buckets). */
export function clusterPositions(positions: ArrayLike<number>, tol: number): PositionClusters {
  const corners = Math.floor(positions.length / 3);
  const cell = tol * 2;
  const tol2 = tol * tol;
  const hash = (gx: number, gy: number, gz: number): number =>
    (Math.imul(gx | 0, 73856093) ^ Math.imul(gy | 0, 19349663) ^ Math.imul(gz | 0, 83492791)) | 0;
  const grid = new Map<number, number[]>();
  const pos: number[] = [];
  const clusterOfCorner = new Int32Array(corners);
  for (let c = 0; c < corners; c++) {
    const x = positions[c * 3], y = positions[c * 3 + 1], z = positions[c * 3 + 2];
    const fx = x / cell, fy = y / cell, fz = z / cell;
    const gx = Math.floor(fx), gy = Math.floor(fy), gz = Math.floor(fz);
    const nx = fx - gx < 0.5 ? gx - 1 : gx + 1;
    const ny = fy - gy < 0.5 ? gy - 1 : gy + 1;
    const nz = fz - gz < 0.5 ? gz - 1 : gz + 1;
    let found = -1;
    search: for (const cx of [gx, nx]) {
      for (const cy of [gy, ny]) {
        for (const cz of [gz, nz]) {
          const bucket = grid.get(hash(cx, cy, cz));
          if (!bucket) continue;
          for (const id of bucket) {
            const dx = pos[id * 3] - x, dy = pos[id * 3 + 1] - y, dz = pos[id * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= tol2) {
              found = id;
              break search;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = pos.length / 3;
      pos.push(x, y, z);
      const key = hash(gx, gy, gz);
      const bucket = grid.get(key);
      if (bucket) bucket.push(found);
      else grid.set(key, [found]);
    }
    clusterOfCorner[c] = found;
  }
  return { clusterOfCorner, clusterPos: Float64Array.from(pos), clusterCount: pos.length / 3 };
}

/** Growable point set that merges points closer than `tol` (used to give
 * intersection points a single shared identity). Ids below `initialCount`
 * are reserved for pre-existing points supplied in `initial`. */
export class PointStore {
  private readonly cell: number;
  private readonly tol2: number;
  private readonly grid = new Map<number, number[]>();
  readonly coords: number[] = [];

  constructor(tol: number, initial?: ArrayLike<number>) {
    this.cell = tol * 2;
    this.tol2 = tol * tol;
    if (initial) {
      for (let i = 0; i < initial.length; i += 3) this.insert(initial[i], initial[i + 1], initial[i + 2]);
    }
  }

  get count(): number {
    return this.coords.length / 3;
  }

  private static hash(gx: number, gy: number, gz: number): number {
    return (Math.imul(gx | 0, 73856093) ^ Math.imul(gy | 0, 19349663) ^ Math.imul(gz | 0, 83492791)) | 0;
  }

  private insert(x: number, y: number, z: number): number {
    const id = this.coords.length / 3;
    this.coords.push(x, y, z);
    const key = PointStore.hash(Math.floor(x / this.cell), Math.floor(y / this.cell), Math.floor(z / this.cell));
    const bucket = this.grid.get(key);
    if (bucket) bucket.push(id);
    else this.grid.set(key, [id]);
    return id;
  }

  /** Returns the id of an existing point within tolerance, else adds one. */
  add(x: number, y: number, z: number): number {
    const fx = x / this.cell, fy = y / this.cell, fz = z / this.cell;
    const gx = Math.floor(fx), gy = Math.floor(fy), gz = Math.floor(fz);
    const nx = fx - gx < 0.5 ? gx - 1 : gx + 1;
    const ny = fy - gy < 0.5 ? gy - 1 : gy + 1;
    const nz = fz - gz < 0.5 ? gz - 1 : gz + 1;
    for (const cx of [gx, nx]) {
      for (const cy of [gy, ny]) {
        for (const cz of [gz, nz]) {
          const bucket = this.grid.get(PointStore.hash(cx, cy, cz));
          if (!bucket) continue;
          for (const id of bucket) {
            const dx = this.coords[id * 3] - x, dy = this.coords[id * 3 + 1] - y, dz = this.coords[id * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= this.tol2) return id;
          }
        }
      }
    }
    return this.insert(x, y, z);
  }
}

// ---------------------------------------------------------------------------------------
// Triangle BVH
// ---------------------------------------------------------------------------------------

const LEAF_SIZE = 4;

export class TriangleBVH {
  readonly triCount: number;
  private readonly order: Int32Array;
  private readonly nodeMin: Float64Array;
  private readonly nodeMax: Float64Array;
  /** Inner node: left child index. Leaf: -1. */
  private readonly nodeLeft: Int32Array;
  /** Inner node: right child index. Leaf: first slot in `order`. */
  private readonly nodeRight: Int32Array;
  /** Leaf: triangle count. Inner: 0. */
  private readonly nodeCount: Int32Array;
  private nodes = 0;

  readonly tri: Float64Array;

  constructor(tri: Float64Array) {
    this.tri = tri;
    const n = Math.floor(tri.length / 9);
    this.triCount = n;
    this.order = new Int32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    const maxNodes = Math.max(1, 2 * n);
    this.nodeMin = new Float64Array(maxNodes * 3);
    this.nodeMax = new Float64Array(maxNodes * 3);
    this.nodeLeft = new Int32Array(maxNodes).fill(-1);
    this.nodeRight = new Int32Array(maxNodes);
    this.nodeCount = new Int32Array(maxNodes);
    if (n === 0) return;

    // per-triangle centroid for splitting
    const cen = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) cen[i * 3 + a] = (tri[i * 9 + a] + tri[i * 9 + 3 + a] + tri[i * 9 + 6 + a]) / 3;
    }
    const stack: number[] = [];
    const root = this.nodes++;
    stack.push(root, 0, n);
    while (stack.length) {
      const end = stack.pop()!, start = stack.pop()!, node = stack.pop()!;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity, cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
      for (let s = start; s < end; s++) {
        const t = this.order[s];
        for (let k = 0; k < 3; k++) {
          const x = tri[t * 9 + k * 3], y = tri[t * 9 + k * 3 + 1], z = tri[t * 9 + k * 3 + 2];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const cx = cen[t * 3], cy = cen[t * 3 + 1], cz = cen[t * 3 + 2];
        if (cx < cMinX) cMinX = cx; if (cx > cMaxX) cMaxX = cx;
        if (cy < cMinY) cMinY = cy; if (cy > cMaxY) cMaxY = cy;
        if (cz < cMinZ) cMinZ = cz; if (cz > cMaxZ) cMaxZ = cz;
      }
      this.nodeMin[node * 3] = minX; this.nodeMin[node * 3 + 1] = minY; this.nodeMin[node * 3 + 2] = minZ;
      this.nodeMax[node * 3] = maxX; this.nodeMax[node * 3 + 1] = maxY; this.nodeMax[node * 3 + 2] = maxZ;
      const count = end - start;
      const ex = cMaxX - cMinX, ey = cMaxY - cMinY, ez = cMaxZ - cMinZ;
      if (count <= LEAF_SIZE || Math.max(ex, ey, ez) <= 0) {
        this.nodeLeft[node] = -1;
        this.nodeRight[node] = start;
        this.nodeCount[node] = count;
        continue;
      }
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const mid = (start + end) >> 1;
      this.select(start, end - 1, mid, axis, cen);
      const left = this.nodes++, right = this.nodes++;
      this.nodeLeft[node] = left;
      this.nodeRight[node] = right;
      this.nodeCount[node] = 0;
      stack.push(left, start, mid, right, mid, end);
    }
  }

  /** Quickselect on `order` by centroid coordinate on `axis`. */
  private select(lo: number, hi: number, k: number, axis: number, cen: Float64Array): void {
    const ord = this.order;
    while (lo < hi) {
      const pivot = cen[ord[(lo + hi) >> 1] * 3 + axis];
      let i = lo, j = hi;
      while (i <= j) {
        while (cen[ord[i] * 3 + axis] < pivot) i++;
        while (cen[ord[j] * 3 + axis] > pivot) j--;
        if (i <= j) {
          const t = ord[i]; ord[i] = ord[j]; ord[j] = t;
          i++; j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  private boxesOverlap(a: number, b: number, other: TriangleBVH, pad: number): boolean {
    for (let ax = 0; ax < 3; ax++) {
      if (this.nodeMin[a * 3 + ax] > other.nodeMax[b * 3 + ax] + pad) return false;
      if (this.nodeMax[a * 3 + ax] < other.nodeMin[b * 3 + ax] - pad) return false;
    }
    return true;
  }

  /** Calls visit(triangleIndex) for every triangle whose bounding box overlaps the box. */
  queryBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, visit: (tri: number) => void): void {
    if (this.triCount === 0) return;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      if (
        this.nodeMin[node * 3] > maxX || this.nodeMax[node * 3] < minX ||
        this.nodeMin[node * 3 + 1] > maxY || this.nodeMax[node * 3 + 1] < minY ||
        this.nodeMin[node * 3 + 2] > maxZ || this.nodeMax[node * 3 + 2] < minZ
      ) continue;
      if (this.nodeLeft[node] === -1) {
        const s = this.nodeRight[node], e = s + this.nodeCount[node];
        for (let i = s; i < e; i++) {
          const t = this.order[i];
          const b = t * 9;
          const tx0 = Math.min(this.tri[b], this.tri[b + 3], this.tri[b + 6]), tx1 = Math.max(this.tri[b], this.tri[b + 3], this.tri[b + 6]);
          const ty0 = Math.min(this.tri[b + 1], this.tri[b + 4], this.tri[b + 7]), ty1 = Math.max(this.tri[b + 1], this.tri[b + 4], this.tri[b + 7]);
          const tz0 = Math.min(this.tri[b + 2], this.tri[b + 5], this.tri[b + 8]), tz1 = Math.max(this.tri[b + 2], this.tri[b + 5], this.tri[b + 8]);
          if (tx0 > maxX || tx1 < minX || ty0 > maxY || ty1 < minY || tz0 > maxZ || tz1 < minZ) continue;
          visit(t);
        }
      } else {
        stack.push(this.nodeLeft[node], this.nodeRight[node]);
      }
    }
  }

  /** Calls visit(i, j) once for every pair of distinct triangles (i < j) whose
   * bounding boxes overlap (within `pad`). */
  selfPairs(visit: (i: number, j: number) => void, pad = 0): void {
    if (this.triCount < 2) return;
    const triBoxOverlap = (i: number, j: number): boolean => {
      const a = i * 9, b = j * 9, t = this.tri;
      for (let ax = 0; ax < 3; ax++) {
        const aMin = Math.min(t[a + ax], t[a + 3 + ax], t[a + 6 + ax]), aMax = Math.max(t[a + ax], t[a + 3 + ax], t[a + 6 + ax]);
        const bMin = Math.min(t[b + ax], t[b + 3 + ax], t[b + 6 + ax]), bMax = Math.max(t[b + ax], t[b + 3 + ax], t[b + 6 + ax]);
        if (aMin > bMax + pad || aMax < bMin - pad) return false;
      }
      return true;
    };
    const rec = (a: number, b: number): void => {
      if (!this.boxesOverlap(a, b, this, pad)) return;
      const aLeaf = this.nodeLeft[a] === -1, bLeaf = this.nodeLeft[b] === -1;
      if (aLeaf && bLeaf) {
        const as = this.nodeRight[a], ae = as + this.nodeCount[a], bs = this.nodeRight[b], be = bs + this.nodeCount[b];
        for (let i = as; i < ae; i++) {
          for (let j = a === b ? i + 1 : bs; j < be; j++) {
            const ti = this.order[i], tj = this.order[j];
            if (!triBoxOverlap(ti, tj)) continue;
            if (ti < tj) visit(ti, tj);
            else visit(tj, ti);
          }
        }
        return;
      }
      if (a === b) {
        rec(this.nodeLeft[a], this.nodeLeft[a]);
        rec(this.nodeRight[a], this.nodeRight[a]);
        rec(this.nodeLeft[a], this.nodeRight[a]);
        return;
      }
      // descend into whichever is an inner node (the larger one if both are)
      const size = (n: number): number =>
        (this.nodeMax[n * 3] - this.nodeMin[n * 3]) + (this.nodeMax[n * 3 + 1] - this.nodeMin[n * 3 + 1]) + (this.nodeMax[n * 3 + 2] - this.nodeMin[n * 3 + 2]);
      if (bLeaf || (!aLeaf && size(a) >= size(b))) {
        rec(this.nodeLeft[a], b);
        rec(this.nodeRight[a], b);
      } else {
        rec(a, this.nodeLeft[b]);
        rec(a, this.nodeRight[b]);
      }
    };
    rec(0, 0);
  }

  /** Calls visit(triangleIndex, t, sign) for every triangle the ray crosses at
   * t >= tMin; `sign` is +1 where the ray leaves through the triangle's front
   * (dot(normal, dir) > 0) and -1 where it enters. */
  raycastAll(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, visit: (tri: number, t: number, sign: number) => void, tMin = 0): void {
    if (this.triCount === 0) return;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const stack = [0];
    const T = this.tri;
    while (stack.length) {
      const node = stack.pop()!;
      let t0 = tMin, t1 = Infinity;
      {
        let a = (this.nodeMin[node * 3] - ox) * ix, b = (this.nodeMax[node * 3] - ox) * ix;
        if (a > b) { const s = a; a = b; b = s; }
        if (a > t0) t0 = a; if (b < t1) t1 = b;
        a = (this.nodeMin[node * 3 + 1] - oy) * iy; b = (this.nodeMax[node * 3 + 1] - oy) * iy;
        if (a > b) { const s = a; a = b; b = s; }
        if (a > t0) t0 = a; if (b < t1) t1 = b;
        a = (this.nodeMin[node * 3 + 2] - oz) * iz; b = (this.nodeMax[node * 3 + 2] - oz) * iz;
        if (a > b) { const s = a; a = b; b = s; }
        if (a > t0) t0 = a; if (b < t1) t1 = b;
      }
      if (t0 > t1) continue;
      if (this.nodeLeft[node] === -1) {
        const s = this.nodeRight[node], e = s + this.nodeCount[node];
        for (let i = s; i < e; i++) {
          const tri = this.order[i], b = tri * 9;
          // Moller-Trumbore
          const e1x = T[b + 3] - T[b], e1y = T[b + 4] - T[b + 1], e1z = T[b + 5] - T[b + 2];
          const e2x = T[b + 6] - T[b], e2y = T[b + 7] - T[b + 1], e2z = T[b + 8] - T[b + 2];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-18) continue;
          const inv = 1 / det;
          const tx = ox - T[b], ty = oy - T[b + 1], tz = oz - T[b + 2];
          const u = (tx * px + ty * py + tz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t < tMin) continue;
          // normal = e1 x e2; dot with dir has the sign of -det... (dir . (e1 x e2)) = -det? derive: det = e1 . (d x e2) = d . (e2 x e1) = -d . n
          visit(tri, t, det < 0 ? 1 : -1);
        }
      } else {
        stack.push(this.nodeLeft[node], this.nodeRight[node]);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Rays: winding / crossing parity
// ---------------------------------------------------------------------------------------

/** A small fixed set of tangent-plane jitters so test rays are never exactly
 * along an edge or through a vertex of an axis-aligned model. */
const JITTER: [number, number][] = [[0.31, 0.17], [-0.43, 0.29], [0.11, -0.52], [-0.27, -0.38], [0.57, -0.09]];

function tangentBasis(nx: number, ny: number, nz: number): [number[], number[]] {
  const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = ny * ax[2] - nz * ax[1], uy = nz * ax[0] - nx * ax[2], uz = nx * ax[1] - ny * ax[0];
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  return [[ux, uy, uz], [vx, vy, vz]];
}

/** Test-ray directions in a cone around (nx,ny,nz) (all within ~35 degrees). */
export function coneDirections(nx: number, ny: number, nz: number): number[][] {
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  const [u, v] = tangentBasis(nx, ny, nz);
  return JITTER.map(([a, b]) => {
    const x = nx + u[0] * a + v[0] * b, y = ny + u[1] * a + v[1] * b, z = nz + u[2] * a + v[2] * b;
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  });
}

function mostCommon(values: number[]): number {
  const counts = new Map<number, number>();
  let best = values[0], bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
}

/** Generalized winding number at a point (positive inside a closed,
 * outward-oriented surface): the signed number of surface crossings of a ray
 * leaving the point, taken as the consensus of several jittered rays heading
 * roughly along `(nx,ny,nz)`. */
export function windingNumber(bvh: TriangleBVH, px: number, py: number, pz: number, nx: number, ny: number, nz: number): number {
  const results: number[] = [];
  for (const d of coneDirections(nx, ny, nz)) {
    let w = 0;
    bvh.raycastAll(px, py, pz, d[0], d[1], d[2], (_t, _tt, sign) => { w += sign; });
    results.push(w);
  }
  return mostCommon(results);
}

/** Parity of the number of DISTINCT surface crossings along rays leaving the
 * point (hits closer together than `mergeDist` count once - so a pair of
 * coincident opposite-facing layers is a single crossing, i.e. one zero-
 * thickness wall). 1 = inside the model, 0 = outside. Consensus of several
 * jittered rays heading roughly along `(nx,ny,nz)`. Crossings closer than
 * `skipNear` to the start are ignored (the neighbourhood of the layer being
 * classified). */
export function crossingParity(bvh: TriangleBVH, px: number, py: number, pz: number, nx: number, ny: number, nz: number, mergeDist: number, skipNear = 0): number {
  const results: number[] = [];
  for (const d of coneDirections(nx, ny, nz)) {
    const ts: number[] = [];
    bvh.raycastAll(px, py, pz, d[0], d[1], d[2], (_t, t) => { if (t >= skipNear) ts.push(t); });
    ts.sort((a, b) => a - b);
    let events = 0, last = -Infinity;
    for (const t of ts) {
      if (t - last > mergeDist) events++;
      last = t;
    }
    results.push(events & 1);
  }
  return mostCommon(results);
}

// ---------------------------------------------------------------------------------------
// Point / triangle geometry
// ---------------------------------------------------------------------------------------

/** Squared distance from point p to triangle (a, b, c) (Ericson, Real-Time Collision Detection). */
export function pointTriangleDistSq(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w;
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}
