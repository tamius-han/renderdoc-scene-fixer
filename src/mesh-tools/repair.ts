import { weldEntries, weldGeometry, type WeldEntriesResult, type WeldInput, type WeldOptions, type WeldedGroup } from "./weld.ts";
import { fillHoles, type HoleFillStats, type SoupMesh } from "./holes.ts";
import { resolveSelfIntersections, type ResolveStats } from "./selfintersect.ts";

/** The full "Weld geometry" export pipeline:
 *
 *   1. weld (weldEntries): merge touching triangles / draw calls, bridge UV
 *      seams, push opposing layers apart (with bias), bridge the resulting gaps;
 *   2. fill holes (if enabled): plug open edges that can be plugged without
 *      intersecting anything else in the same mesh;
 *   3. fix self-intersections (if enabled): cut the mesh along its own
 *      intersection curves and drop the pieces that end up inside it, so only
 *      the outer shape remains;
 *   4. fill holes again (if enabled) - removing interior pieces can open new ones;
 *   5. re-weld the repaired geometry so shared vertices, UV seams and normals
 *      are rebuilt for the new triangles.
 *
 * Steps 2-5 run per welded group (the unit that shares one vertex buffer, i.e.
 * "the same mesh") and only touch groups that actually changed. */

export interface RepairOptions {
  weld: WeldOptions & { acrossEntries?: boolean; detectOpposingDraws?: boolean };
  fillHoles: boolean;
  fixSelfIntersections: boolean;
}

export interface RepairStats {
  groupsRepaired: number;
  holes: HoleFillStats;
  intersections: ResolveStats;
}

export interface RepairResult extends WeldEntriesResult {
  repair: RepairStats;
}

const zeroHoles = (): HoleFillStats => ({ loops: 0, filled: 0, failed: 0, addedTriangles: 0, skippedFlat: false });
const zeroResolve = (): ResolveStats => ({ intersectingPairs: 0, splitTriangles: 0, failedTriangles: 0, patches: 0, removedPatches: 0, removedTriangles: 0, skippedCoplanar: 0 });

/** Expands a welded group into flat per-corner geometry (owner = entry slot),
 * dropping zero-area triangles (seam/bridge slivers - the final re-weld
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
      soup.owner.push(slot);
    }
  });
  return soup;
}

export function weldAndRepair(entries: WeldInput[], options: RepairOptions): RepairResult {
  const welded = weldEntries(entries, options.weld);
  const repair: RepairStats = { groupsRepaired: 0, holes: zeroHoles(), intersections: zeroResolve() };
  if (!options.fillHoles && !options.fixSelfIntersections) return { ...welded, repair };

  const groups = welded.groups.map((group) => {
    if (group.positions.length === 0) return group;

    // tolerance: as given, else the weld's own default (1e-6 of the group's diagonal)
    let tol = options.weld.positionTolerance;
    if (tol === undefined) {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < group.positions.length; i++) {
        const a = i % 3;
        if (group.positions[i] < mn[a]) mn[a] = group.positions[i];
        if (group.positions[i] > mx[a]) mx[a] = group.positions[i];
      }
      tol = Math.max(Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * 1e-6, 1e-12);
    }

    let mesh = groupToSoup(group, tol * tol);
    if (mesh.owner.length === 0) return group;
    let changed = false;

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
    if (!changed) return group;

    // rebuild shared vertices / UV seams / normals for the repaired geometry
    repair.groupsRepaired++;
    const rewelded = weldGeometry(mesh, { ...options.weld, ownerPush: undefined, positionTolerance: tol }, Int32Array.from(mesh.owner));
    const indices: number[][] = group.indices.map(() => []);
    for (let i = 0; i < rewelded.indices.length; i++) indices[rewelded.triangleOwner[(i / 3) | 0]].push(rewelded.indices[i]);
    return { entryIndices: group.entryIndices, positions: rewelded.positions, normals: rewelded.normals, uvs: rewelded.uvs, indices };
  });

  return { ...welded, groups, repair };
}
