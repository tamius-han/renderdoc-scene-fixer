/** "Weld geometry" export option: makes triangles that touch each other
 * actually share vertices (and therefore edges), so a DCC tool like Blender
 * sees one connected surface instead of a soup of loose triangles.
 *
 * Input is this app's flat, per-corner geometry (positions/normals/uvs, 3
 * corners per triangle - see GeometryArrays in scene/mesh-builder.ts). Output
 * is INDEXED (one entry per vertex + a triangle index list): the .glb exporter
 * takes it as-is and skips its own duplicate-vertex merging for such entries,
 * because that merge only looks at position/normal/uv and would happily
 * re-fuse vertices this module deliberately kept apart.
 *
 * The rules, in order:
 *
 *  1. POSITION CLUSTERS. Corners within `positionTolerance` of each other are
 *     "at the same place". That alone never merges anything - it only says
 *     which corners MAY be merged. Triangles that collapse onto fewer than
 *     three distinct places are dropped; this includes zero-width seam
 *     triangles a previous step (fill.ts) may have emitted. Step 5 rebuilds
 *     whatever UV bridging is still needed, so bridge geometry is never
 *     itself a merge candidate.
 *
 *  2. EDGE-DRIVEN, MANIFOLD-SAFE MERGING. Vertices are merged one shared edge
 *     at a time (merging an edge means merging both of its endpoints). Two
 *     triangle edges are only merge candidates when
 *       - they sit at the same two places,
 *       - they run in opposite directions (consistent winding), and
 *       - their triangles do NOT have opposing normals (angle between them
 *         above `opposingAngleDegrees`, judged on the vertex normals AND on
 *         the winding-derived normals, so either one disagreeing blocks it).
 *     At places where overlapping layers are evident (three or more triangles
 *     coincide on one edge - impossible on a legitimate surface - or some
 *     coincident pair already opposes) a lone edge pair is judged STRICTLY:
 *     its triangles must face broadly the same way (under 90 degrees apart,
 *     whatever the angle setting). That catches the rim of a curved
 *     double-sided mesh whose two sides are triangulated differently, where
 *     the front and back rim triangles' normals differ by less than the
 *     angle setting and would otherwise weld.
 *     When several triangles coincide on one edge, a pair only merges if each
 *     is the other's best match, so a refused merge never falls back to a
 *     triangle from the other layer.
 *     Every candidate merge is applied tentatively and then checked: every
 *     merged vertex must still be manifold (no edge used by more than two
 *     triangles or twice in the same direction, and its triangles must form
 *     ONE connected fan - no pinch/bow-tie). If not, the merge is rolled
 *     back and those triangles stay unwelded. Vertices that merely touch at
 *     a point, with no shared edge, are never merged.
 *
 *  3. OPPOSING NORMALS ARE PUSHED APART. Where the same place ends up holding
 *     several separate vertices, and one of them belongs to triangles
 *     opposing another's (or to a triangle whose edge partner was refused for
 *     opposing normals), that vertex is moved `separationDistance` along its
 *     own average normal. All triangles sharing the vertex move together, so
 *     each side of a double-sided sheet stays internally connected while the
 *     two sides face away from each other and never share a vertex or edge.
 *
 *  4. UV VARIANTS. Merged vertices whose corner UVs differ by more than
 *     `uvTolerance` become separate output vertices at the same position (a
 *     UV seam), so no UV is ever altered. All variants of one vertex share
 *     one normal so a seam is not also a shading seam. A welded vertex can
 *     only carry one normal, so merged corners' normals are summed and
 *     renormalized (hard edges come out smoothed).
 *
 *  5. UV-SEAM BRIDGING. For every shared edge whose two triangles ended up on
 *     different UV variants at either end, a pair of zero-width triangles
 *     (quad A1,B1,B2,A2 with A1/A2 and B1/B2 coincident in 3D) joins the two
 *     sides, so any smeared texture lookup only happens in zero-area
 *     geometry. They use the seam's own separate vertices and are added after
 *     all merging is done, so they can't be welded away.
 *
 *  6. GAP BRIDGING. Open edges (one triangle only) that sit at the same two
 *     places but were pushed apart in step 3 - typically the rim of a
 *     double-sided sheet - are joined by a strip of two triangles that re-uses
 *     their vertices, so the thin shell comes out closed rather than slit
 *     open. Skipped for any strip that would make an edge non-manifold.
 *
 * weldEntries() below runs all of this over SEVERAL meshes (draw calls) at
 * once, so meshes that share an edge are welded to each other too. */

import { TriangleBVH, crossingParity, pointTriangleDistSq } from "./spatial.ts";

export interface WeldInput {
  positions: number[];
  normals: number[];
  uvs: number[];
}

export interface WeldOptions {
  /** Absolute distance under which two corners count as "at the same place"
   * (same units as the positions). Default: 1e-6 x bounding-box diagonal. */
  positionTolerance?: number;
  /** Max per-axis UV difference still considered "the same UV". */
  uvTolerance?: number;
  /** Triangles whose normals are more than this many degrees apart are
   * "opposing" - never merged, and pushed apart. */
  opposingAngleDegrees?: number;
  /** How far opposing-normal vertices are pushed along their normal (same
   * units as the positions). */
  separationDistance?: number;
  /** Close the gap between pushed-apart open edges with a strip of triangles
   * (default true). See the header comment, rule 6. */
  bridgePushedGaps?: boolean;
  /** -1..1, default 0. Splits the push between the two sides of an opposing
   * pair: 0 pushes both by `separationDistance`; -1 pushes only the layer
   * facing the model's inside (by twice the distance), +1 only the layer
   * facing the outside; values between interpolate. Needs a closed-enough
   * model to tell inside from outside - where that can't be told (e.g. a
   * lone double-sided sheet) the push stays symmetric. */
  pushBias?: number;
  /** Per-owner flags (see `triangleOwners`): every vertex of a flagged
   * owner is pushed along its normal, even with no coincident partner vertex
   * (used for whole draw calls detected as the opposing layer of another). */
  ownerPush?: Uint8Array;
}

export interface WeldStats {
  inputTriangles: number;
  /** Dropped because positions within the tolerance collapsed them. */
  collapsedTriangles: number;
  outputTriangles: number;
  outputVertices: number;
  /** Shared edges successfully welded. */
  mergedEdges: number;
  /** Edge pairs left unwelded because merging would be non-manifold. */
  rejectedNonManifold: number;
  /** Edge pairs left unwelded because their triangles have opposing normals. */
  rejectedOpposing: number;
  /** Edge pairs left unwelded because their winding is inconsistent. */
  rejectedWinding: number;
  /** Vertices pushed along their normal to separate opposing sides. */
  pushedVertices: number;
  /** Places where overlapping (double-sided) layers were detected. */
  layeredPlaces: number;
  /** Zero-width triangles added to keep UV seams connected. */
  seamBridgeTriangles: number;
  /** Triangles added to close the gap between pushed-apart open edges. */
  gapBridgeTriangles: number;
}

export interface WeldResult {
  /** Per-VERTEX attributes (not per-corner). */
  positions: number[];
  normals: number[];
  uvs: number[];
  /** Triangle list into the vertex arrays above. */
  indices: number[];
  /** For each INPUT corner, the output vertex it ended up as (-1 if its
   * triangle was dropped as collapsed). Handy for diagnostics and tests. */
  vertexOfCorner: Int32Array;
  /** Owner (the value from `triangleOwners`, else 0) of every output triangle.
   * Added bridge triangles belong to the owner of the triangle they bridge from. */
  triangleOwner: number[];
  /** Flat (ownerA, ownerB) pairs: owners that ended up sharing an edge. */
  ownerLinks: number[];
  stats: WeldStats;
}

export const DEFAULT_WELD_UV_TOLERANCE = 1e-4;
export const DEFAULT_WELD_OPPOSING_ANGLE = 162;
export const DEFAULT_WELD_SEPARATION = 0.1;

const MAX_EDGE_GROUP = 12; // coincident edge instances considered per place-pair

function hasUVMap(uvs: number[]): boolean {
  for (let i = 0; i < uvs.length; i++) if (uvs[i] !== 0) return true;
  return false;
}

export function weldGeometry(data: WeldInput, options: WeldOptions = {}, triangleOwners?: Int32Array): WeldResult {
  const { positions, normals, uvs } = data;
  const cornerCount = Math.floor(positions.length / 3);
  const triCount = Math.floor(cornerCount / 3);

  const stats: WeldStats = {
    inputTriangles: triCount,
    collapsedTriangles: 0,
    outputTriangles: 0,
    outputVertices: 0,
    mergedEdges: 0,
    rejectedNonManifold: 0,
    rejectedOpposing: 0,
    rejectedWinding: 0,
    pushedVertices: 0,
    layeredPlaces: 0,
    seamBridgeTriangles: 0,
    gapBridgeTriangles: 0,
  };
  if (triCount === 0) return { positions: [], normals: [], uvs: [], indices: [], vertexOfCorner: new Int32Array(cornerCount).fill(-1), triangleOwner: [], ownerLinks: [], stats };

  const uvTol = options.uvTolerance ?? DEFAULT_WELD_UV_TOLERANCE;
  const opposingAngle = Math.min(180, Math.max(0, options.opposingAngleDegrees ?? DEFAULT_WELD_OPPOSING_ANGLE));
  const opposingDot = Math.cos((opposingAngle * Math.PI) / 180);
  const uvMapPresent = hasUVMap(uvs);

  // ---- bounds -> tolerances ------------------------------------------------
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < cornerCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const tol = Math.max(options.positionTolerance ?? diag * 1e-6, 1e-12);
  // Never closer than 8x the tolerance, or pushed-apart copies could be
  // mistaken for "the same place" by a later pass.
  const separation = Math.max(options.separationDistance ?? DEFAULT_WELD_SEPARATION, tol * 8);

  // ---- 1. position clusters ---------------------------------------------------
  // Spatial hash, cell size 2*tol: a match within `tol` lives in the point's
  // own cell or, per axis, the one neighbour on the side it's closer to - at
  // most 8 buckets. Hash collisions are harmless: candidates are distance-checked.
  const cell = tol * 2;
  const tol2 = tol * tol;
  const hash = (gx: number, gy: number, gz: number): number =>
    (Math.imul(gx | 0, 73856093) ^ Math.imul(gy | 0, 19349663) ^ Math.imul(gz | 0, 83492791)) | 0;
  const grid = new Map<number, number[]>();
  const clusterPos: number[] = [];
  const clusterOfCorner = new Int32Array(cornerCount);

  for (let c = 0; c < cornerCount; c++) {
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
            const dx = clusterPos[id * 3] - x, dy = clusterPos[id * 3 + 1] - y, dz = clusterPos[id * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= tol2) {
              found = id;
              break search;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = clusterPos.length / 3;
      clusterPos.push(x, y, z);
      const key = hash(gx, gy, gz);
      const bucket = grid.get(key);
      if (bucket) bucket.push(found);
      else grid.set(key, [found]);
    }
    clusterOfCorner[c] = found;
  }
  const clusterCount = clusterPos.length / 3;

  const liveTris: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const a = clusterOfCorner[t * 3], b = clusterOfCorner[t * 3 + 1], c = clusterOfCorner[t * 3 + 2];
    if (a !== b && b !== c && a !== c) liveTris.push(t);
  }
  stats.collapsedTriangles = triCount - liveTris.length;
  if (liveTris.length === 0) return { positions: [], normals: [], uvs: [], indices: [], vertexOfCorner: new Int32Array(cornerCount).fill(-1), triangleOwner: [], ownerLinks: [], stats };

  // ---- face directions -----------------------------------------------------------
  // faceNormal: what the triangle "faces" per its supplied vertex normals
  // (winding-derived only as a fallback). geoNormal: purely winding-derived.
  // Two triangles oppose if EITHER measure says so.
  const faceNormal = new Float64Array(triCount * 3);
  const geoNormal = new Float64Array(triCount * 3);
  for (const t of liveTris) {
    const ax = positions[t * 9], ay = positions[t * 9 + 1], az = positions[t * 9 + 2];
    const ux = positions[t * 9 + 3] - ax, uy = positions[t * 9 + 4] - ay, uz = positions[t * 9 + 5] - az;
    const vx = positions[t * 9 + 6] - ax, vy = positions[t * 9 + 7] - ay, vz = positions[t * 9 + 8] - az;
    let gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const glen = Math.hypot(gx, gy, gz);
    const geoValid = glen > 1e-12;
    if (geoValid) {
      gx /= glen; gy /= glen; gz /= glen;
      geoNormal[t * 3] = gx; geoNormal[t * 3 + 1] = gy; geoNormal[t * 3 + 2] = gz;
    }

    let sx = 0, sy = 0, sz = 0;
    for (let k = 0; k < 3; k++) {
      const c = t * 3 + k;
      sx += normals[c * 3] ?? 0;
      sy += normals[c * 3 + 1] ?? 0;
      sz += normals[c * 3 + 2] ?? 0;
    }
    const slen = Math.hypot(sx, sy, sz);
    if (slen > 1e-6) {
      faceNormal[t * 3] = sx / slen; faceNormal[t * 3 + 1] = sy / slen; faceNormal[t * 3 + 2] = sz / slen;
    } else if (geoValid) {
      faceNormal[t * 3] = gx; faceNormal[t * 3 + 1] = gy; faceNormal[t * 3 + 2] = gz;
    } // else (0,0,0): no direction, never counts as opposing
  }
  const dotOf = (arr: Float64Array, a: number, b: number): number =>
    arr[a * 3] * arr[b * 3] + arr[a * 3 + 1] * arr[b * 3 + 1] + arr[a * 3 + 2] * arr[b * 3 + 2];
  // Unit supplied normal per corner (zero if unusable).
  const cornerN = new Float64Array(cornerCount * 3);
  for (const t of liveTris) {
    for (let k = 0; k < 3; k++) {
      const c = t * 3 + k;
      const x = normals[c * 3] ?? 0, y = normals[c * 3 + 1] ?? 0, z = normals[c * 3 + 2] ?? 0;
      const len = Math.hypot(x, y, z);
      if (len > 1e-9) {
        cornerN[c * 3] = x / len;
        cornerN[c * 3 + 1] = y / len;
        cornerN[c * 3 + 2] = z / len;
      }
    }
  }
  const cornerDot = (a: number, b: number): number =>
    cornerN[a * 3] * cornerN[b * 3] + cornerN[a * 3 + 1] * cornerN[b * 3 + 1] + cornerN[a * 3 + 2] * cornerN[b * 3 + 2];

  // ---- 2. edge-driven, manifold-safe merging ---------------------------------------
  // Edge instance = t*3+k: the directed edge from corner k to corner (k+1)%3.
  const endCorner = (inst: number): number => ((inst / 3) | 0) * 3 + ((inst % 3) + 1) % 3;
  const placeEdgeKey = (ca: number, cb: number): number => (ca < cb ? ca * clusterCount + cb : cb * clusterCount + ca);

  // Do the two triangles on edge instances x and y oppose each other? Judged on
  // the vertex-normal average, the winding-derived normal AND the per-corner
  // normals at both shared endpoints (the last is independent of how the two
  // triangles happen to be triangulated); any one of them is enough.
  const pairOpposed = (x: number, y: number, thr: number): boolean => {
    const tx = (x / 3) | 0, ty = (y / 3) | 0;
    if (dotOf(faceNormal, tx, ty) < thr || dotOf(geoNormal, tx, ty) < thr) return true;
    const xe = endCorner(x), ye = endCorner(y);
    const reversed = clusterOfCorner[y] === clusterOfCorner[xe]; // y runs the other way
    const d1 = reversed ? cornerDot(x, ye) : cornerDot(x, y);
    const d2 = reversed ? cornerDot(xe, y) : cornerDot(xe, ye);
    return d1 < thr || d2 < thr;
  };

  const edgeHead = new Map<number, number>();
  const edgeNext = new Int32Array(triCount * 3).fill(-1);
  for (const t of liveTris) {
    for (let k = 0; k < 3; k++) {
      const inst = t * 3 + k;
      const key = placeEdgeKey(clusterOfCorner[inst], clusterOfCorner[endCorner(inst)]);
      const head = edgeHead.get(key);
      if (head !== undefined) edgeNext[inst] = head;
      edgeHead.set(key, inst);
    }
  }

  // Union-find over corners (= vertices-to-be) WITHOUT path compression, so a
  // tentative merge can be rolled back; each root keeps a linked list of its
  // member corners for the manifold check.
  const parent = new Int32Array(cornerCount);
  const size = new Int32Array(cornerCount).fill(1);
  const memHead = new Int32Array(cornerCount);
  const memTail = new Int32Array(cornerCount);
  const nextMember = new Int32Array(cornerCount).fill(-1);
  for (let i = 0; i < cornerCount; i++) {
    parent[i] = i;
    memHead[i] = i;
    memTail[i] = i;
  }
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i];
    return i;
  };
  const undoStack: number[] = []; // (child, root, oldTail) triples
  const unite = (ra: number, rb: number): number => {
    let root = ra, child = rb;
    if (size[ra] < size[rb]) { root = rb; child = ra; }
    const oldTail = memTail[root];
    parent[child] = root;
    size[root] += size[child];
    nextMember[oldTail] = memHead[child];
    memTail[root] = memTail[child];
    undoStack.push(child, root, oldTail);
    return root;
  };
  const rollbackTo = (mark: number): void => {
    while (undoStack.length > mark) {
      const oldTail = undoStack.pop()!, root = undoStack.pop()!, child = undoStack.pop()!;
      nextMember[oldTail] = -1;
      memTail[root] = oldTail;
      parent[child] = child;
      size[root] -= size[child];
    }
  };

  // Is the vertex `root` manifold? Its triangles' edges at the vertex must each
  // be used at most once per direction (so <=2 triangles, consistently wound),
  // and the triangles must form a single connected fan.
  const nbMask = new Map<number, number>(); // neighbour root -> 1 (has an outgoing edge) | 2 (incoming)
  const nbFirstTri = new Map<number, number>();
  const triParent: number[] = [];
  const triFind = (i: number): number => {
    while (triParent[i] !== i) {
      triParent[i] = triParent[triParent[i]];
      i = triParent[i];
    }
    return i;
  };
  const vertexIsManifold = (root: number): boolean => {
    nbMask.clear();
    nbFirstTri.clear();
    triParent.length = 0;
    let n = 0;
    for (let c = memHead[root]; c !== -1; c = nextMember[c]) {
      const t = (c / 3) | 0, k = c % 3;
      const out = find(t * 3 + ((k + 1) % 3));
      const inn = find(t * 3 + ((k + 2) % 3));
      if (out === root || inn === root || out === inn) return false; // degenerate
      const idx = n++;
      triParent.push(idx);
      for (const [nb, bit] of [[out, 1], [inn, 2]] as const) {
        const mask = nbMask.get(nb) ?? 0;
        if (mask & bit) return false; // edge used twice in the same direction
        nbMask.set(nb, mask | bit);
        const first = nbFirstTri.get(nb);
        if (first === undefined) nbFirstTri.set(nb, idx);
        else triParent[triFind(idx)] = triFind(first);
      }
    }
    const top = triFind(0);
    for (let i = 1; i < n; i++) if (triFind(i) !== top) return false; // pinched: more than one fan
    return true;
  };

  const ownerLinks: number[] = [];

  // The corner flags mark triangles that had an edge partner refused for
  // opposing normals - they get pushed apart in step 3 if they share a place
  // with other vertices.
  const cutFlag = new Uint8Array(cornerCount);

  const tryMergeEdges = (x: number, y: number): boolean => {
    // x runs P->Q, y runs Q->P (callers guarantee opposite directions).
    const xs = x, xe = endCorner(x), ys = y, ye = endCorner(y);
    const r1a = find(xs), r1b = find(ye), r2a = find(xe), r2b = find(ys);
    if (r1a === r1b && r2a === r2b) return true; // already one shared edge
    const mark = undoStack.length;
    const m1 = r1a === r1b ? r1a : unite(r1a, r1b);
    const m2 = r2a === r2b ? r2a : unite(r2a, r2b);
    const ok = (r1a === r1b || vertexIsManifold(m1)) && (r2a === r2b || vertexIsManifold(m2));
    if (!ok) rollbackTo(mark);
    return ok;
  };

  // Pre-pass: find places where overlapping layers are evident, BEFORE any
  // merging so the result doesn't depend on processing order.
  const layered = new Uint8Array(clusterCount);
  const group: number[] = [];
  for (const head of edgeHead.values()) {
    group.length = 0;
    for (let inst = head; inst !== -1 && group.length < MAX_EDGE_GROUP; inst = edgeNext[inst]) group.push(inst);
    if (group.length < 2) continue;
    let evident = group.length >= 3; // 3+ triangles coincide on one edge: stacked layers
    for (let i = 0; i < group.length && !evident; i++) {
      for (let j = i + 1; j < group.length && !evident; j++) evident = pairOpposed(group[i], group[j], opposingDot);
    }
    if (evident) {
      layered[clusterOfCorner[group[0]]] = 1;
      layered[clusterOfCorner[endCorner(group[0])]] = 1;
    }
  }
  for (let i = 0; i < clusterCount; i++) stats.layeredPlaces += layered[i];

  const pairs: { x: number; y: number; score: number }[] = [];
  for (const head of edgeHead.values()) {
    group.length = 0;
    for (let inst = head; inst !== -1 && group.length < MAX_EDGE_GROUP; inst = edgeNext[inst]) group.push(inst);
    if (group.length < 2) continue;

    // A lone pair on an edge at a layered place has no better-matching partner
    // to prefer, so it is held to the strict (< 90 degrees) standard.
    const strict = group.length === 2 && (layered[clusterOfCorner[group[0]]] === 1 || layered[clusterOfCorner[endCorner(group[0])]] === 1);
    const thr = strict ? Math.max(opposingDot, 0) : opposingDot;

    pairs.length = 0;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const x = group[i], y = group[j];
        const tx = (x / 3) | 0, ty = (y / 3) | 0;
        if (pairOpposed(x, y, thr)) {
          stats.rejectedOpposing++;
          cutFlag[x] = cutFlag[endCorner(x)] = cutFlag[y] = cutFlag[endCorner(y)] = 1;
          continue;
        }
        if (clusterOfCorner[y] !== clusterOfCorner[endCorner(x)]) {
          stats.rejectedWinding++; // same direction: inconsistently wound
          continue;
        }
        // Preference among several candidate partners: the pair that agrees
        // LEAST well on either measure is the weaker match (a back face that
        // reuses the front's normals agrees perfectly on supplied normals and
        // would otherwise outscore its genuine neighbour).
        pairs.push({ x, y, score: Math.min(dotOf(faceNormal, tx, ty), dotOf(geoNormal, tx, ty)) });
      }
    }
    if (pairs.length === 0) continue;
    if (pairs.length > 1) {
      // Several candidates (stacked layers on one edge): only merge a pair
      // when each triangle is the OTHER's best partner. If that merge is later
      // refused as non-manifold, the triangles stay unwelded rather than
      // settling for a worse partner - which would be a triangle from the
      // other layer.
      const best = new Map<number, { partner: number; score: number }>();
      const consider = (a: number, b: number, score: number): void => {
        const cur = best.get(a);
        if (!cur || score > cur.score) best.set(a, { partner: b, score });
      };
      for (const { x, y, score } of pairs) {
        consider(x, y, score);
        consider(y, x, score);
      }
      let kept = 0;
      for (const pair of pairs) if (best.get(pair.x)!.partner === pair.y && best.get(pair.y)!.partner === pair.x) pairs[kept++] = pair;
      pairs.length = kept;
      pairs.sort((a, b) => b.score - a.score);
    }

    const used = new Set<number>();
    for (const { x, y } of pairs) {
      if (used.has(x) || used.has(y)) continue;
      if (tryMergeEdges(x, y)) {
        used.add(x);
        used.add(y);
        stats.mergedEdges++;
        if (triangleOwners) {
          const ox = triangleOwners[(x / 3) | 0], oy = triangleOwners[(y / 3) | 0];
          if (ox !== oy) ownerLinks.push(ox, oy);
        }
      } else {
        stats.rejectedNonManifold++;
      }
    }
  }

  // ---- final vertices ("base vertices" = union-find roots) -----------------------------
  const bvOfRoot = new Int32Array(cornerCount).fill(-1);
  const bvOfCorner = new Int32Array(cornerCount).fill(-1);
  const bvCluster: number[] = [];
  for (const t of liveTris) {
    for (let k = 0; k < 3; k++) {
      const c = t * 3 + k;
      const root = find(c);
      let bv = bvOfRoot[root];
      if (bv < 0) {
        bv = bvCluster.length;
        bvOfRoot[root] = bv;
        bvCluster.push(clusterOfCorner[c]);
      }
      bvOfCorner[c] = bv;
    }
  }
  const bvCount = bvCluster.length;

  // ---- 3. push opposing-normal vertices apart -------------------------------------------
  // Two vertices at one place are on opposing sides if their supplied-normal
  // sums OR their winding-derived normal sums oppose (the latter still works
  // when a double-sided mesh reuses the front normals on the back faces). At a
  // layered place the standard is strict (> 90 degrees apart). The push
  // follows the winding-derived direction - "facing" as a renderer sees it -
  // falling back to the supplied normals for sliver triangles.
  const bvNormalSum = new Float64Array(bvCount * 3);
  const bvGeoSum = new Float64Array(bvCount * 3);
  const bvFaceSum = new Float64Array(bvCount * 3);
  const bvFlag = new Uint8Array(bvCount);
  for (const t of liveTris) {
    for (let k = 0; k < 3; k++) {
      const c = t * 3 + k;
      const bv = bvOfCorner[c];
      for (let a = 0; a < 3; a++) {
        bvNormalSum[bv * 3 + a] += normals[c * 3 + a] ?? 0;
        bvGeoSum[bv * 3 + a] += geoNormal[t * 3 + a];
        bvFaceSum[bv * 3 + a] += faceNormal[t * 3 + a];
      }
      if (cutFlag[c]) bvFlag[bv] = 1;
    }
  }
  const unit = (sum: Float64Array, bv: number): number[] => {
    const x = sum[bv * 3], y = sum[bv * 3 + 1], z = sum[bv * 3 + 2];
    const len = Math.hypot(x, y, z);
    return len > 1e-9 ? [x / len, y / len, z / len] : [0, 0, 0];
  };
  const bvsOfCluster = new Map<number, number[]>();
  for (let bv = 0; bv < bvCount; bv++) {
    const list = bvsOfCluster.get(bvCluster[bv]);
    if (list) list.push(bv);
    else bvsOfCluster.set(bvCluster[bv], [bv]);
  }
  // Which vertices get pushed: opposed vertices sharing a place, plus every
  // vertex of an owner flagged as an opposing draw-call layer.
  const pushed = new Uint8Array(bvCount);
  for (const [cl, list] of bvsOfCluster) {
    if (list.length < 2) continue;
    const thr = layered[cl] ? Math.max(opposingDot, 0) : opposingDot;
    const nDir = list.map((bv) => unit(bvNormalSum, bv));
    const gDir = list.map((bv) => unit(bvGeoSum, bv));
    const dot3 = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (let i = 0; i < list.length; i++) {
      if (bvFlag[list[i]]) pushed[list[i]] = 1;
      for (let j = i + 1; j < list.length; j++) {
        if (dot3(nDir[i], nDir[j]) < thr || dot3(gDir[i], gDir[j]) < thr) pushed[list[i]] = pushed[list[j]] = 1;
      }
    }
  }
  if (options.ownerPush && triangleOwners) {
    for (const t of liveTris) {
      if (!options.ownerPush[triangleOwners[t]]) continue;
      for (let k = 0; k < 3; k++) pushed[bvOfCorner[t * 3 + k]] = 1;
    }
  }

  // Push bias: which side of the model does each pushed vertex face?
  const bias = Math.min(1, Math.max(-1, options.pushBias ?? 0));
  const bvFactor = new Float64Array(bvCount).fill(1);
  if (bias !== 0) {
    const soup = new Float64Array(liveTris.length * 9);
    liveTris.forEach((t, i) => {
      for (let k = 0; k < 9; k++) soup[i * 9 + k] = positions[t * 9 + k];
    });
    const bvh = new TriangleBVH(soup);
    const off = Math.max(tol * 4, separation * 0.02);
    const near = Math.max(tol * 4, separation * 1.01); // a partner layer this close doesn't count as part of the model
    for (let bv = 0; bv < bvCount; bv++) {
      if (!pushed[bv]) continue;
      let d = unit(bvGeoSum, bv);
      if (d[0] === 0 && d[1] === 0 && d[2] === 0) d = unit(bvFaceSum, bv);
      if (d[0] === 0 && d[1] === 0 && d[2] === 0) continue;
      const cl = bvCluster[bv];
      const px = clusterPos[cl * 3], py = clusterPos[cl * 3 + 1], pz = clusterPos[cl * 3 + 2];
      const front = crossingParity(bvh, px + d[0] * off, py + d[1] * off, pz + d[2] * off, d[0], d[1], d[2], near, near);
      const back = crossingParity(bvh, px - d[0] * off, py - d[1] * off, pz - d[2] * off, -d[0], -d[1], -d[2], near, near);
      // outside = even crossings, inside = odd; undecidable (both alike) stays symmetric
      if (front === 0 && back === 1) bvFactor[bv] = 1 + bias; // faces the outside
      else if (front === 1 && back === 0) bvFactor[bv] = 1 - bias; // faces the inside
    }
  }

  const bvOffset = new Float64Array(bvCount * 3);
  for (let bv = 0; bv < bvCount; bv++) {
    if (!pushed[bv]) continue;
    let d = unit(bvGeoSum, bv);
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) d = unit(bvFaceSum, bv);
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) continue;
    const amount = separation * bvFactor[bv];
    bvOffset[bv * 3] = d[0] * amount;
    bvOffset[bv * 3 + 1] = d[1] * amount;
    bvOffset[bv * 3 + 2] = d[2] * amount;
    stats.pushedVertices++;
  }

  // ---- 4. UV variants -> output vertices ------------------------------------------------
  // Corners of one merged vertex share an OUTPUT vertex only if their UVs match
  // AND they're linked through a shared edge whose UVs match at that end - a
  // run of triangles around the vertex with no UV seam in between. Matching
  // UVs alone isn't enough: in a fan with UV patches A-B-A, merging the two
  // A patches would pinch the output vertex, since they only connect via B.
  const uvParent = new Int32Array(cornerCount);
  for (let i = 0; i < cornerCount; i++) uvParent[i] = i;
  const uvFind = (i: number): number => {
    while (uvParent[i] !== i) {
      uvParent[i] = uvParent[uvParent[i]];
      i = uvParent[i];
    }
    return i;
  };
  const uvOf = (c: number, axis: number): number => (uvMapPresent ? uvs[c * 2 + axis] ?? 0 : 0);
  const uvMatch = (c1: number, c2: number): boolean =>
    Math.abs(uvOf(c1, 0) - uvOf(c2, 0)) <= uvTol && Math.abs(uvOf(c1, 1) - uvOf(c2, 1)) <= uvTol;
  {
    // Every welded (bv-level) edge has at most two triangles, running in
    // opposite directions - guaranteed by the manifold checks above.
    const firstOnEdge = new Map<number, number>();
    for (const t of liveTris) {
      for (let k = 0; k < 3; k++) {
        const inst = t * 3 + k;
        const a = bvOfCorner[inst], b = bvOfCorner[endCorner(inst)];
        const key = a < b ? a * bvCount + b : b * bvCount + a;
        const other = firstOnEdge.get(key);
        if (other === undefined) {
          firstOnEdge.set(key, inst);
          continue;
        }
        // other: P->Q, inst: Q->P
        if (uvMatch(other, endCorner(inst))) uvParent[uvFind(other)] = uvFind(endCorner(inst));
        if (uvMatch(endCorner(other), inst)) uvParent[uvFind(endCorner(other))] = uvFind(inst);
      }
    }
  }
  const ovU: number[] = [];
  const ovV: number[] = [];
  const ovBv: number[] = [];
  const ovOfUvRoot = new Int32Array(cornerCount).fill(-1);
  const ovOfCorner = new Int32Array(cornerCount).fill(-1);
  for (const t of liveTris) {
    for (let k = 0; k < 3; k++) {
      const c = t * 3 + k;
      const root = uvFind(c);
      let ov = ovOfUvRoot[root];
      if (ov < 0) {
        ov = ovU.length;
        ovOfUvRoot[root] = ov;
        ovU.push(uvOf(c, 0));
        ovV.push(uvOf(c, 1));
        ovBv.push(bvOfCorner[c]);
      }
      ovOfCorner[c] = ov;
    }
  }
  const ovCount = ovU.length;

  // ---- output vertex attributes -----------------------------------------------------------------
  const outPositions = new Array<number>(ovCount * 3);
  const outNormals = new Array<number>(ovCount * 3);
  const outUvs = new Array<number>(ovCount * 2);
  for (let ov = 0; ov < ovCount; ov++) {
    const bv = ovBv[ov];
    const cl = bvCluster[bv];
    outPositions[ov * 3] = clusterPos[cl * 3] + bvOffset[bv * 3];
    outPositions[ov * 3 + 1] = clusterPos[cl * 3 + 1] + bvOffset[bv * 3 + 1];
    outPositions[ov * 3 + 2] = clusterPos[cl * 3 + 2] + bvOffset[bv * 3 + 2];

    const nx = bvNormalSum[bv * 3], ny = bvNormalSum[bv * 3 + 1], nz = bvNormalSum[bv * 3 + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-9) {
      outNormals[ov * 3] = nx / len;
      outNormals[ov * 3 + 1] = ny / len;
      outNormals[ov * 3 + 2] = nz / len;
    } else {
      // Summed to nothing (only possible for near-opposing normals the angle
      // setting let through) - any unit vector beats NaN.
      outNormals[ov * 3] = 0;
      outNormals[ov * 3 + 1] = 0;
      outNormals[ov * 3 + 2] = 1;
    }
    outUvs[ov * 2] = ovU[ov];
    outUvs[ov * 2 + 1] = ovV[ov];
  }

  // ---- triangles + 5. UV-seam bridging ----------------------------------------------------
  const ownerOfTri = (t: number): number => (triangleOwners ? triangleOwners[t] : 0);
  const indices: number[] = [];
  const triangleOwner: number[] = [];
  for (const t of liveTris) {
    indices.push(ovOfCorner[t * 3], ovOfCorner[t * 3 + 1], ovOfCorner[t * 3 + 2]);
    triangleOwner.push(ownerOfTri(t));
  }

  const pushBridge = (a: number, b: number, c: number, owner: number): void => {
    if (a === b || b === c || a === c) return; // a coincident pair is the same vertex - nothing to add
    indices.push(a, b, c);
    triangleOwner.push(owner);
    stats.seamBridgeTriangles++;
  };

  // Edges at the welded-vertex ("bv") level, used by both bridging passes.
  const bvEdgeHead = new Map<number, number>();
  const bvEdgeNext = new Int32Array(triCount * 3).fill(-1);
  for (const t of liveTris) {
    for (let k = 0; k < 3; k++) {
      const inst = t * 3 + k;
      const a = bvOfCorner[inst], b = bvOfCorner[endCorner(inst)];
      const key = a < b ? a * bvCount + b : b * bvCount + a;
      const head = bvEdgeHead.get(key);
      if (head !== undefined) bvEdgeNext[inst] = head;
      bvEdgeHead.set(key, inst);
    }
  }

  if (ovCount > bvCount) {
    for (const head of bvEdgeHead.values()) {
      if (bvEdgeNext[head] === -1) continue;
      // One representative per distinct (uv variant at A, uv variant at B).
      const reps: { ovA: number; ovB: number; forward: boolean; owner: number }[] = [];
      for (let inst = head; inst !== -1; inst = bvEdgeNext[inst]) {
        const forward = bvOfCorner[inst] < bvOfCorner[endCorner(inst)]; // "A" = lower vertex id
        const startOv = ovOfCorner[inst], endOv = ovOfCorner[endCorner(inst)];
        const ovA = forward ? startOv : endOv;
        const ovB = forward ? endOv : startOv;
        if (!reps.some((r) => r.ovA === ovA && r.ovB === ovB)) reps.push({ ovA, ovB, forward, owner: ownerOfTri((inst / 3) | 0) });
      }
      for (let i = 0; i + 1 < reps.length; i++) {
        const X = reps[i], Y = reps[i + 1];
        // Wound to cancel X's own edge (and Y's, for consistent winding).
        if (X.forward) {
          pushBridge(X.ovB, X.ovA, Y.ovA, X.owner);
          pushBridge(Y.ovA, Y.ovB, X.ovB, X.owner);
        } else {
          pushBridge(X.ovA, X.ovB, Y.ovB, X.owner);
          pushBridge(Y.ovB, Y.ovA, X.ovA, X.owner);
        }
      }
    }
  }

  // ---- 6. close the gaps pushing opened up ------------------------------------------------------
  // Two OPEN edges (each used by one triangle only) that sit at the same two
  // places - the rim where the front and back of a double-sided sheet would
  // have met - and that pushing has now moved apart get a strip of two
  // triangles across the gap, wound to continue both surfaces, re-using the
  // edges' own vertices (so the mesh stays welded: the shell comes out closed
  // instead of with a slit all around its rim). Each strip is only added if it
  // keeps every edge used at most once per direction and twice in total.
  if (options.bridgePushedGaps !== false && stats.pushedVertices > 0) {
    const isOpen = new Uint8Array(triCount * 3);
    for (const head of bvEdgeHead.values()) if (bvEdgeNext[head] === -1) isOpen[head] = 1;

    const dirUsed = new Set<number>();
    const undUses = new Map<number, number>();
    const undKey = (a: number, b: number): number => (a < b ? a * ovCount + b : b * ovCount + a);
    const noteEdge = (a: number, b: number): void => {
      dirUsed.add(a * ovCount + b);
      const k = undKey(a, b);
      undUses.set(k, (undUses.get(k) ?? 0) + 1);
    };
    const edgeFree = (a: number, b: number): boolean => !dirUsed.has(a * ovCount + b) && (undUses.get(undKey(a, b)) ?? 0) < 2;
    for (let i = 0; i < indices.length; i += 3) {
      noteEdge(indices[i], indices[i + 1]);
      noteEdge(indices[i + 1], indices[i + 2]);
      noteEdge(indices[i + 2], indices[i]);
    }
    const area2 = (a: number, b: number, c: number): number => {
      const ux = outPositions[b * 3] - outPositions[a * 3], uy = outPositions[b * 3 + 1] - outPositions[a * 3 + 1], uz = outPositions[b * 3 + 2] - outPositions[a * 3 + 2];
      const vx = outPositions[c * 3] - outPositions[a * 3], vy = outPositions[c * 3 + 1] - outPositions[a * 3 + 1], vz = outPositions[c * 3 + 2] - outPositions[a * 3 + 2];
      return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    };
    const apart = (a: number, b: number): boolean =>
      Math.hypot(outPositions[a * 3] - outPositions[b * 3], outPositions[a * 3 + 1] - outPositions[b * 3 + 1], outPositions[a * 3 + 2] - outPositions[b * 3 + 2]) > tol * 4;
    const minArea = tol * tol;

    const open: number[] = [];
    const candidates: { x: number; y: number; dot: number }[] = [];
    for (const head of edgeHead.values()) {
      open.length = 0;
      for (let inst = head; inst !== -1 && open.length < MAX_EDGE_GROUP; inst = edgeNext[inst]) if (isOpen[inst]) open.push(inst);
      if (open.length < 2) continue;
      candidates.length = 0;
      for (let i = 0; i < open.length; i++) {
        for (let j = i + 1; j < open.length; j++) {
          const x = open[i], y = open[j];
          if (clusterOfCorner[y] !== clusterOfCorner[endCorner(x)]) continue; // must run the opposite way
          if (!apart(ovOfCorner[x], ovOfCorner[endCorner(y)]) || !apart(ovOfCorner[endCorner(x)], ovOfCorner[y])) continue; // not pushed apart
          candidates.push({ x, y, dot: dotOf(faceNormal, (x / 3) | 0, (y / 3) | 0) });
        }
      }
      candidates.sort((p, q) => p.dot - q.dot); // most opposed first
      const taken = new Set<number>();
      for (const { x, y } of candidates) {
        if (taken.has(x) || taken.has(y)) continue;
        // x runs A->B and y runs B->A (A, B = the two places the edge joins).
        const aX = ovOfCorner[x], bX = ovOfCorner[endCorner(x)];
        const bY = ovOfCorner[y], aY = ovOfCorner[endCorner(y)];
        const strip: number[][] = [];
        if (area2(bX, aX, aY) > minArea) strip.push([bX, aX, aY]);
        if (area2(aY, bY, bX) > minArea) strip.push([aY, bY, bX]);
        if (strip.length === 0) continue;
        if (!strip.every(([a, b, c]) => edgeFree(a, b) && edgeFree(b, c) && edgeFree(c, a))) continue;
        // (the strip's own shared diagonal is used once per direction by its two triangles - fine)
        taken.add(x);
        taken.add(y);
        const owner = ownerOfTri((x / 3) | 0);
        for (const [a, b, c] of strip) {
          indices.push(a, b, c);
          triangleOwner.push(owner);
          noteEdge(a, b);
          noteEdge(b, c);
          noteEdge(c, a);
          stats.gapBridgeTriangles++;
        }
        if (triangleOwners) {
          const oy = ownerOfTri((y / 3) | 0);
          if (oy !== owner) ownerLinks.push(owner, oy);
        }
      }
    }
  }

  stats.outputTriangles = indices.length / 3;
  stats.outputVertices = ovCount;
  return { positions: outPositions, normals: outNormals, uvs: outUvs, indices, vertexOfCorner: ovOfCorner, triangleOwner, ownerLinks, stats };
}


// ---------------------------------------------------------------------------------------
// Welding several meshes (draw calls) together
// ---------------------------------------------------------------------------------------

export interface WeldedGroup {
  /** Indices (into the `entries` passed to weldEntries) welded into this group, ascending. */
  entryIndices: number[];
  /** Per-vertex arrays SHARED by every entry in the group. */
  positions: number[];
  normals: number[];
  uvs: number[];
  /** Triangle indices into the shared vertex arrays, one list per entry (aligned with entryIndices). */
  indices: number[][];
}

export interface WeldEntriesResult {
  groups: WeldedGroup[];
  stats: WeldStats;
  /** Groups holding more than one entry - i.e. draw calls actually welded together. */
  crossEntryGroups: number;
  /** Entries detected as an opposing layer of another entry (pushed apart as a whole). */
  opposingEntries: number[];
}


/** Finds entries (draw calls) that are the opposing layer of another entry:
 * pairs where MOST of each one's triangle area lies within `dist` of a
 * triangle of the other that faces the opposite way (normals more than 120
 * degrees apart) - e.g. a double-sided material drawn as a front-face pass and
 * a back-face pass, whose vertices needn't coincide at all. Returns a flag per
 * entry. */
function detectOpposingEntries(entries: WeldInput[], dist: number): Uint8Array {
  const flags = new Uint8Array(entries.length);
  if (entries.length < 2) return flags;
  interface Info { tris: Float64Array; area: Float64Array; nrm: Float64Array; total: number; min: number[]; max: number[]; bvh: TriangleBVH }
  const infos: (Info | null)[] = entries.map((e) => {
    const n = Math.floor(e.positions.length / 9);
    if (n === 0) return null;
    const tris = new Float64Array(n * 9);
    for (let i = 0; i < n * 9; i++) tris[i] = e.positions[i];
    const area = new Float64Array(n), nrm = new Float64Array(n * 3);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let total = 0;
    for (let t = 0; t < n; t++) {
      const b = t * 9;
      for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) {
        const v = tris[b + k * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
      const ux = tris[b + 3] - tris[b], uy = tris[b + 4] - tris[b + 1], uz = tris[b + 5] - tris[b + 2];
      const vx = tris[b + 6] - tris[b], vy = tris[b + 7] - tris[b + 1], vz = tris[b + 8] - tris[b + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const len = Math.hypot(cx, cy, cz);
      area[t] = len / 2;
      total += area[t];
      if (len > 1e-12) { nrm[t * 3] = cx / len; nrm[t * 3 + 1] = cy / len; nrm[t * 3 + 2] = cz / len; }
    }
    return total > 0 ? { tris, area, nrm, total, min, max, bvh: new TriangleBVH(tris) } : null;
  });

  const dist2 = dist * dist;
  // share of A's area that sits on an opposite-facing triangle of B
  const coverage = (A: Info, B: Info): number => {
    let covered = 0;
    const n = A.area.length;
    for (let t = 0; t < n; t++) {
      if (A.area[t] <= 0) continue;
      const b = t * 9;
      const cx = (A.tris[b] + A.tris[b + 3] + A.tris[b + 6]) / 3, cy = (A.tris[b + 1] + A.tris[b + 4] + A.tris[b + 7]) / 3, cz = (A.tris[b + 2] + A.tris[b + 5] + A.tris[b + 8]) / 3;
      let hit = false;
      B.bvh.queryBox(cx - dist, cy - dist, cz - dist, cx + dist, cy + dist, cz + dist, (u) => {
        if (hit) return;
        if (A.nrm[t * 3] * B.nrm[u * 3] + A.nrm[t * 3 + 1] * B.nrm[u * 3 + 1] + A.nrm[t * 3 + 2] * B.nrm[u * 3 + 2] >= -0.5) return;
        const q = u * 9, T = B.tris;
        if (pointTriangleDistSq(cx, cy, cz, T[q], T[q + 1], T[q + 2], T[q + 3], T[q + 4], T[q + 5], T[q + 6], T[q + 7], T[q + 8]) <= dist2) hit = true;
      });
      if (hit) covered += A.area[t];
    }
    return covered / A.total;
  };

  for (let i = 0; i < entries.length; i++) {
    const A = infos[i];
    if (!A) continue;
    for (let j = i + 1; j < entries.length; j++) {
      const B = infos[j];
      if (!B) continue;
      if (flags[i] && flags[j]) continue;
      let apart = false;
      for (let a = 0; a < 3 && !apart; a++) apart = A.min[a] > B.max[a] + dist || B.min[a] > A.max[a] + dist;
      if (apart) continue;
      if (coverage(A, B) >= 0.5 && coverage(B, A) >= 0.5) flags[i] = flags[j] = 1;
    }
  }
  return flags;
}

/** Welds a list of meshes (flat per-corner arrays, all in the same space).
 * With `acrossEntries` meshes that end up sharing at least one welded edge
 * (or a bridged gap) come out as ONE group with a shared vertex buffer - the
 * caller keeps each mesh's own material/identity and just points them at the
 * shared vertices. Without it, every mesh is welded on its own. */
export function weldEntries(entries: WeldInput[], options: WeldOptions & { acrossEntries?: boolean; detectOpposingDraws?: boolean } = {}): WeldEntriesResult {
  const sum = (a: WeldStats, b: WeldStats): WeldStats => ({
    inputTriangles: a.inputTriangles + b.inputTriangles,
    collapsedTriangles: a.collapsedTriangles + b.collapsedTriangles,
    outputTriangles: a.outputTriangles + b.outputTriangles,
    outputVertices: a.outputVertices + b.outputVertices,
    mergedEdges: a.mergedEdges + b.mergedEdges,
    rejectedNonManifold: a.rejectedNonManifold + b.rejectedNonManifold,
    rejectedOpposing: a.rejectedOpposing + b.rejectedOpposing,
    rejectedWinding: a.rejectedWinding + b.rejectedWinding,
    pushedVertices: a.pushedVertices + b.pushedVertices,
    layeredPlaces: a.layeredPlaces + b.layeredPlaces,
    seamBridgeTriangles: a.seamBridgeTriangles + b.seamBridgeTriangles,
    gapBridgeTriangles: a.gapBridgeTriangles + b.gapBridgeTriangles,
  });

  // Whole draw calls that are the opposing layer of another draw call get pushed
  // apart as a whole (see detectOpposingEntries()).
  const layerDist = Math.max(options.separationDistance ?? DEFAULT_WELD_SEPARATION, (options.positionTolerance ?? 0) * 8);
  const opposing = options.detectOpposingDraws === false ? new Uint8Array(entries.length) : detectOpposingEntries(entries, layerDist);
  const opposingEntries: number[] = [];
  opposing.forEach((f, i) => { if (f) opposingEntries.push(i); });

  if (!options.acrossEntries || entries.length < 2) {
    const groups: WeldedGroup[] = [];
    let total: WeldStats | undefined;
    entries.forEach((entry, i) => {
      const owners = new Int32Array(Math.floor(entry.positions.length / 9));
      const r = weldGeometry(entry, { ...options, ownerPush: Uint8Array.of(opposing[i]) }, owners);
      groups.push({ entryIndices: [i], positions: r.positions, normals: r.normals, uvs: r.uvs, indices: [r.indices] });
      total = total ? sum(total, r.stats) : r.stats;
    });
    return { groups, stats: total ?? weldGeometry({ positions: [], normals: [], uvs: [] }).stats, crossEntryGroups: 0, opposingEntries };
  }

  // Concatenate everything into one soup, remembering which entry owns each triangle.
  let cornerTotal = 0;
  for (const e of entries) cornerTotal += Math.floor(e.positions.length / 9) * 3;
  const positions = new Array<number>(cornerTotal * 3);
  const normals = new Array<number>(cornerTotal * 3);
  const uvs = new Array<number>(cornerTotal * 2);
  const owners = new Int32Array(cornerTotal / 3);
  let corner = 0;
  entries.forEach((e, ei) => {
    const corners = Math.floor(e.positions.length / 9) * 3;
    for (let i = 0; i < corners; i++) {
      positions[(corner + i) * 3] = e.positions[i * 3];
      positions[(corner + i) * 3 + 1] = e.positions[i * 3 + 1];
      positions[(corner + i) * 3 + 2] = e.positions[i * 3 + 2];
      normals[(corner + i) * 3] = e.normals[i * 3] ?? 0;
      normals[(corner + i) * 3 + 1] = e.normals[i * 3 + 1] ?? 0;
      normals[(corner + i) * 3 + 2] = e.normals[i * 3 + 2] ?? 0;
      uvs[(corner + i) * 2] = e.uvs[i * 2] ?? 0;
      uvs[(corner + i) * 2 + 1] = e.uvs[i * 2 + 1] ?? 0;
    }
    owners.fill(ei, corner / 3, (corner + corners) / 3);
    corner += corners;
  });

  const r = weldGeometry({ positions, normals, uvs }, { ...options, ownerPush: opposing }, owners);

  // Entries linked by a shared edge form one group.
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < r.ownerLinks.length; i += 2) parent[find(r.ownerLinks[i])] = find(r.ownerLinks[i + 1]);

  const groupOfRoot = new Map<number, WeldedGroup>();
  const groupOfEntry: WeldedGroup[] = [];
  const slotOfEntry: number[] = []; // position of the entry inside its group's lists
  entries.forEach((_, ei) => {
    const root = find(ei);
    let g = groupOfRoot.get(root);
    if (!g) groupOfRoot.set(root, (g = { entryIndices: [], positions: [], normals: [], uvs: [], indices: [] }));
    slotOfEntry[ei] = g.entryIndices.length;
    g.entryIndices.push(ei);
    g.indices.push([]);
    groupOfEntry[ei] = g;
  });

  // Every output vertex belongs to exactly one group (shared vertices only come
  // from linked entries), so one remap table serves them all.
  const localIndex = new Int32Array(r.positions.length / 3).fill(-1);
  for (let i = 0; i < r.indices.length; i++) {
    const owner = r.triangleOwner[(i / 3) | 0];
    const g = groupOfEntry[owner];
    const v = r.indices[i];
    let local = localIndex[v];
    if (local < 0) {
      local = g.positions.length / 3;
      localIndex[v] = local;
      g.positions.push(r.positions[v * 3], r.positions[v * 3 + 1], r.positions[v * 3 + 2]);
      g.normals.push(r.normals[v * 3], r.normals[v * 3 + 1], r.normals[v * 3 + 2]);
      g.uvs.push(r.uvs[v * 2], r.uvs[v * 2 + 1]);
    }
    g.indices[slotOfEntry[owner]].push(local);
  }

  const groups = [...groupOfRoot.values()];
  return { groups, stats: r.stats, crossEntryGroups: groups.filter((g) => g.entryIndices.length > 1).length, opposingEntries };
}
