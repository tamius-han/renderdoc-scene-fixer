import { weldEntries, weldGeometry, type WeldEntriesResult, type WeldInput, type WeldOptions, type WeldStats, type WeldedGroup } from "./weld.ts";
import { fillHoles, type HoleFillStats, type SoupMesh } from "./holes.ts";
import { resolveSelfIntersections, type ResolveStats } from "./selfintersect.ts";
import { bridgeGaps, type GapStats } from "./gaps.ts";
import { countCoincidentOpenEdges, enforceManifold, type ManifoldStats } from "./manifold.ts";

/** The full "Weld geometry" export pipeline:
 *
 *   1. weld (weldEntries): merge touching triangles / draw calls, bridge UV
 *      seams, push opposing layers apart (shape-preserving), bridge their rims;
 *   2. bridge narrow gaps (if enabled) between open edges - across ALL meshes, so
 *      draw calls separated by a crack get joined into one;
 *   3. fill holes (if enabled): plug open edges that can be plugged without
 *      intersecting anything else in the same mesh;
 *   4. fix self-intersections (if enabled): cut the mesh along its own
 *      intersection curves and drop the pieces that end up inside it;
 *   5. fill holes again (if enabled) - removing interior pieces can open new ones;
 *   6. re-weld the repaired geometry so shared vertices, UV seams and normals
 *      are rebuilt for the new triangles;
 *   7. manifold guard on every resulting mesh (manifold.ts).
 *
 * Steps 3-6 run per welded group (the unit that shares one vertex buffer, i.e.
 * "the same mesh") and only touch groups that actually changed. */

export interface RepairOptions {
  weld: WeldOptions & { acrossEntries?: boolean; detectOpposingDraws?: boolean };
  fillHoles: boolean;
  fixSelfIntersections: boolean;
  /** Close gaps up to this wide between open edges of surfaces that continue into each other (0 = off). */
  narrowGap?: number;
  /** Close gaps up to this wide between the rims of back-to-back (pushed apart) layers (0 = off). */
  shellGap?: number;
}

export interface RepairStats {
  groupsRepaired: number;
  holes: HoleFillStats;
  intersections: ResolveStats;
  gaps: GapStats;
  manifold: ManifoldStats;
  /** Open edges of the result that coincide with another open edge without being welded
   * or bridged (should be 0; see countCoincidentOpenEdges). */
  coincidentOpenEdges: number;
  /** Summed stats of the re-welds that rebuild repaired groups (merged/rejected edges etc.). */
  reweld: WeldStats;
}

export interface RepairResult extends WeldEntriesResult {
  repair: RepairStats;
}

const zeroHoles = (): HoleFillStats => ({ loops: 0, filled: 0, failed: 0, addedTriangles: 0, skippedFlat: false });
const zeroResolve = (): ResolveStats => ({ intersectingPairs: 0, splitTriangles: 0, failedTriangles: 0, patches: 0, removedPatches: 0, removedTriangles: 0, skippedCoplanar: 0 });
const zeroGaps = (): GapStats => ({ boundaryEdges: 0, chains: 0, strips: 0, bridgedEdges: 0, rejectedStrips: 0, addedTriangles: 0 });
const zeroManifold = (): ManifoldStats => ({ duplicateTriangles: 0, detachedTriangles: 0, splitVertices: 0 });
const zeroWeld = (): WeldStats => ({ inputTriangles: 0, collapsedTriangles: 0, outputTriangles: 0, outputVertices: 0, mergedEdges: 0, rejectedNonManifold: 0, rejectedOpposing: 0, rejectedWinding: 0, pushedVertices: 0, layeredPlaces: 0, seamBridgeTriangles: 0, gapBridgeTriangles: 0, smoothedVertices: 0, limitedVertices: 0, ringCapTriangles: 0, tJunctionSplits: 0 });
const addWeld = (a: WeldStats, b: WeldStats): void => { for (const k of Object.keys(a) as (keyof WeldStats)[]) a[k] += b[k]; };

/** Expands a welded group into flat per-corner geometry (owner = GLOBAL entry
 * index), dropping zero-area triangles (seam/bridge slivers - the final re-weld
 * regenerates whatever bridging is still needed). */
function groupToSoup(group: WeldedGroup, minArea: number): SoupMesh {
  const soup: SoupMesh = { positions: [], normals: [], uvs: [], owner: [] };
  const pos = group.positions;
  group.indices.forEach((list, slot) => {
    for (let t = 0; t + 2 < list.length; t += 3) {
      const a = list[t], b = list[t + 1], c = list[t + 2];
      const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2 <= minArea) continue;
      for (const v of [a, b, c]) {
        soup.positions.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        soup.normals.push(group.normals[v * 3], group.normals[v * 3 + 1], group.normals[v * 3 + 2]);
        soup.uvs.push(group.uvs[v * 2], group.uvs[v * 2 + 1]);
      }
      soup.owner.push(group.entryIndices[slot]);
    }
  });
  return soup;
}

function diagonal(positions: ArrayLike<number>): number {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const a = i % 3;
    if (positions[i] < mn[a]) mn[a] = positions[i];
    if (positions[i] > mx[a]) mx[a] = positions[i];
  }
  return positions.length ? Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) : 0;
}

export function weldAndRepair(entries: WeldInput[], options: RepairOptions): RepairResult {
  const welded = weldEntries(entries, options.weld);
  const repair: RepairStats = { groupsRepaired: 0, holes: zeroHoles(), intersections: zeroResolve(), gaps: zeroGaps(), manifold: zeroManifold(), reweld: zeroWeld(), coincidentOpenEdges: 0 };
  const narrowGap = options.narrowGap ?? 0, shellGap = options.shellGap ?? 0;
  const bridging = narrowGap > 0 || shellGap > 0;
  const needRepair = options.fillHoles || options.fixSelfIntersections || bridging;

  const guard = (g: WeldedGroup): WeldedGroup => {
    const r = enforceManifold(g);
    repair.manifold.duplicateTriangles += r.stats.duplicateTriangles;
    repair.manifold.detachedTriangles += r.stats.detachedTriangles;
    repair.manifold.splitVertices += r.stats.splitVertices;
    return r.changed ? { entryIndices: g.entryIndices, positions: r.mesh.positions, normals: r.mesh.normals, uvs: r.mesh.uvs, indices: r.mesh.indices } : g;
  };
  const diagTol = Math.max(options.weld.positionTolerance ?? 0, 1e-9);
  const finish = (groups: WeldedGroup[]): WeldedGroup[] => {
    for (const g of groups) repair.coincidentOpenEdges += countCoincidentOpenEdges(g, diagTol);
    return groups;
  };
  if (!needRepair) { const groups = finish(welded.groups.map(guard)); return { ...welded, groups, repair }; }

  // tolerance: as given, else the weld's own default (1e-6 of the overall diagonal)
  const tol = options.weld.positionTolerance ?? Math.max(Math.max(0, ...welded.groups.map((g) => diagonal(g.positions))) * 1e-6, 1e-12);

  const souped = welded.groups.map((g) => groupToSoup(g, tol * tol));
  const groupOfEntry = new Map<number, number>();
  welded.groups.forEach((g, gi) => g.entryIndices.forEach((e) => groupOfEntry.set(e, gi)));
  const parent = welded.groups.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const dirty = new Set<number>(); // groups whose geometry must be re-welded

  // ---- gap bridging, across all meshes ------------------------------------------------------
  let soupsByRoot = new Map<number, SoupMesh>();
  souped.forEach((s, gi) => soupsByRoot.set(gi, s));
  if (bridging) {
    // (concat, never push(...bigArray): spreading a large array overflows the call stack)
    const all: SoupMesh = {
      positions: ([] as number[]).concat(...souped.map((s) => s.positions)),
      normals: ([] as number[]).concat(...souped.map((s) => s.normals)),
      uvs: ([] as number[]).concat(...souped.map((s) => s.uvs)),
      owner: ([] as number[]).concat(...souped.map((s) => s.owner)),
    };
    const r = bridgeGaps(all, { tol, narrowGap, shellGap });
    const g = repair.gaps;
    g.boundaryEdges += r.stats.boundaryEdges; g.chains += r.stats.chains; g.strips += r.stats.strips;
    g.bridgedEdges += r.stats.bridgedEdges; g.rejectedStrips += r.stats.rejectedStrips; g.addedTriangles += r.stats.addedTriangles;
    if (r.stats.addedTriangles > 0) {
      for (let i = 0; i < r.links.length; i += 2) {
        const ga = groupOfEntry.get(r.links[i]), gb = groupOfEntry.get(r.links[i + 1]);
        if (ga !== undefined && gb !== undefined) parent[find(ga)] = find(gb);
      }
      soupsByRoot = new Map();
      const T = r.mesh.owner.length;
      for (let t = 0; t < T; t++) {
        const root = find(groupOfEntry.get(r.mesh.owner[t])!);
        let s = soupsByRoot.get(root);
        if (!s) soupsByRoot.set(root, (s = { positions: [], normals: [], uvs: [], owner: [] }));
        s.positions.push(...r.mesh.positions.slice(t * 9, t * 9 + 9));
        s.normals.push(...r.mesh.normals.slice(t * 9, t * 9 + 9));
        s.uvs.push(...r.mesh.uvs.slice(t * 6, t * 6 + 6));
        s.owner.push(r.mesh.owner[t]);
      }
      // groups that gained triangles or were merged need a re-weld
      const original = new Map<number, number>(); // root -> triangle count before bridging
      souped.forEach((s, gi) => original.set(find(gi), (original.get(find(gi)) ?? 0) + s.owner.length));
      for (const [root, s] of soupsByRoot) if (s.owner.length !== (original.get(root) ?? 0)) dirty.add(root);
      welded.groups.forEach((_, gi) => { if (find(gi) !== gi) dirty.add(find(gi)); });
      for (const root of [...dirty]) dirty.add(find(root));
    }
  }

  // ---- per (possibly merged) group ----------------------------------------------------------------
  const finalGroups: WeldedGroup[] = [];
  const roots = new Set<number>(welded.groups.map((_, gi) => find(gi)));
  for (const root of roots) {
    const members = welded.groups.filter((_, gi) => find(gi) === root);
    const entryIndices = members.flatMap((g) => g.entryIndices).sort((a, b) => a - b);
    let mesh = soupsByRoot.get(root) ?? { positions: [], normals: [], uvs: [], owner: [] };
    const untouchedGroup = members.length === 1 ? members[0] : undefined;
    if (mesh.owner.length === 0) { finalGroups.push(untouchedGroup ?? { entryIndices, positions: [], normals: [], uvs: [], indices: entryIndices.map(() => []) }); continue; }
    let changed = dirty.has(root);

    const fill = (): void => {
      const r = fillHoles(mesh, tol);
      repair.holes.loops += r.stats.loops;
      repair.holes.filled += r.stats.filled;
      repair.holes.failed += r.stats.failed;
      repair.holes.addedTriangles += r.stats.addedTriangles;
      repair.holes.skippedFlat = repair.holes.skippedFlat || r.stats.skippedFlat;
      if (r.stats.addedTriangles > 0) { mesh = r.mesh; changed = true; }
    };

    if (options.fillHoles) fill();
    if (options.fixSelfIntersections) {
      const r = resolveSelfIntersections(mesh, tol);
      const s = repair.intersections;
      s.intersectingPairs += r.stats.intersectingPairs;
      s.splitTriangles += r.stats.splitTriangles;
      s.failedTriangles += r.stats.failedTriangles;
      s.patches += r.stats.patches;
      s.removedPatches += r.stats.removedPatches;
      s.removedTriangles += r.stats.removedTriangles;
      s.skippedCoplanar += r.stats.skippedCoplanar;
      if (r.changed) {
        mesh = r.mesh;
        changed = true;
        if (options.fillHoles) fill(); // removing interior pieces can open new holes
      }
    }
    if (!changed && untouchedGroup) { finalGroups.push(untouchedGroup); continue; }

    // rebuild shared vertices / UV seams / normals for the repaired geometry
    repair.groupsRepaired++;
    const slotOfEntry = new Map<number, number>();
    entryIndices.forEach((e, slot) => slotOfEntry.set(e, slot));
    const owners = Int32Array.from(mesh.owner.map((e) => slotOfEntry.get(e) ?? 0));
    // (a re-weld only rebuilds shared vertices: pushing again would move already-repaired geometry)
    const rewelded = weldGeometry(mesh, { ...options.weld, ownerPush: undefined, noPush: true, mergeOpposed: true, positionTolerance: tol }, owners);
    addWeld(repair.reweld, rewelded.stats);
    const indices: number[][] = entryIndices.map(() => []);
    for (let i = 0; i < rewelded.indices.length; i++) indices[rewelded.triangleOwner[(i / 3) | 0]].push(rewelded.indices[i]);
    finalGroups.push({ entryIndices, positions: rewelded.positions, normals: rewelded.normals, uvs: rewelded.uvs, indices });
  }

  const groups = finish(finalGroups.map(guard));
  return { ...welded, groups, crossEntryGroups: groups.filter((g) => g.entryIndices.length > 1).length, repair };
}
