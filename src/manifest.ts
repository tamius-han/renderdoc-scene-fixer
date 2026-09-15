import { dirname, joinPath, VirtualFileSystem } from "./filesystem";
import { splitObj } from "./parsers/obj";
import type { DrawEntry, ParsedOBJ, PassIndexEntry, PassManifest, RootManifest } from "./types";

export interface LoadedManifests {
  /** Folder (relative to the dropped root) that manifest.json was found in -
   * everything else is resolved relative to this. */
  rootPrefix: string;
  root: RootManifest;
  passManifests: Record<string, PassManifest>;
  /** Pass folders whose own manifest.json couldn't be found/parsed - kept
   * separate from a hard failure since the top-level manifest still loaded
   * fine, but reconstructing these passes will silently do nothing unless
   * this is surfaced somewhere. */
  failedPassFolders: string[];
}

/** Finds the top-level manifest.json (the shallowest one in the tree - a
 * per-pass manifest.json sits one level deeper, inside pass_NN_tag/) and
 * loads every pass's own manifest alongside it. */
export async function loadManifests(vfs: VirtualFileSystem): Promise<LoadedManifests | null> {
  let manifestPath: string | null = null;
  for (const path of vfs.keys()) {
    if (!path.endsWith("manifest.json")) continue;
    if (manifestPath === null || path.split("/").length < manifestPath.split("/").length) {
      manifestPath = path;
    }
  }
  if (!manifestPath) return null;

  const rootPrefix = dirname(manifestPath);
  const rootText = await vfs.readText(manifestPath);
  if (!rootText) return null;

  let root: RootManifest;
  try {
    root = JSON.parse(rootText) as RootManifest;
  } catch (e) {
    console.error(`Failed to parse ${manifestPath}`, e);
    return null;
  }

  const passManifests: Record<string, PassManifest> = {};
  const failedPassFolders: string[] = [];
  for (const pass of root.passes) {
    const pmPath = joinPath(rootPrefix, pass.folder, "manifest.json");
    const pmText = await vfs.readText(pmPath);
    if (!pmText) {
      console.error(
        `[manifest] Could not find ${pmPath} in the dropped files for pass "${pass.folder}". ` +
          `A few sample paths that WERE found: ${Array.from(vfs.keys()).slice(0, 5).join(", ")}`,
      );
      failedPassFolders.push(pass.folder);
      continue;
    }
    try {
      passManifests[pass.folder] = JSON.parse(pmText) as PassManifest;
    } catch (e) {
      console.error(`[manifest] Failed to parse ${pmPath}`, e);
      failedPassFolders.push(pass.folder);
    }
  }

  return { rootPrefix, root, passManifests, failedPassFolders };
}

export interface FakeManifestResult {
  manifests: LoadedManifests;
  /** The generated part_N.obj files the fake manifest's draws point at -
   * there's no real capture folder backing them, so they can't be read
   * from any vfs the caller already has. */
  vfs: VirtualFileSystem;
}

/** Computes a unit face normal from a triangle's three corner positions
 * (right-hand rule). Falls back to +Z for a degenerate (zero-area)
 * triangle, the same default objToGeometryArrays uses for a missing
 * normal. */
function computeFlatNormal(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): [number, number, number] {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len > 1e-12 ? [nx / len, ny / len, nz / len] : [0, 0, 1];
}

/** Serializes one split-off part back to OBJ text for the fake manifest's
 * draws. Every face gets its own `vn`, shared by all 3 of its corners, so
 * the part reads as flat/faceted rather than smoothed. There are no `vt`s
 * and no `mtllib` - these parts have no UVs or material, so the viewer's
 * normal untextured-material fallback (flat grey) applies to them. */
function partToFlatShadedOBJText(part: ParsedOBJ): string {
  const vLines = part.positions.map(([x, y, z]) => `v ${x} ${y} ${z}`);
  const vnLines: string[] = [];
  const fLines: string[] = [];

  for (const face of part.faces) {
    const [a, b, c] = face.map((corner) => part.positions[corner.v - 1]);
    const normal = computeFlatNormal(a, b, c);
    vnLines.push(`vn ${normal[0]} ${normal[1]} ${normal[2]}`);
    const n = vnLines.length;
    fLines.push(`f ${face.map((corner) => `${corner.v}//${n}`).join(" ")}`);
  }

  return `${[...vLines, ...vnLines, ...fLines].join("\n")}\n`;
}

/**
 * Converts Intel GPA export into a format compatible with RenderDoc exports.
 *
 * The dropped scene .obj is split into its loose parts (see splitObj) and
 * each part becomes one "draw" of a single synthetic pass, so the rest of
 * the viewer - built around RenderDoc's pass/manifest/draw shape - can load
 * an Intel GPA scene without any special-casing. None of the parts carry a
 * material or texture, so each is written out flat-shaded (one normal per
 * face) and left without a `mtllib`, which is what makes the viewer fall
 * back to its plain grey untextured material for them.
 * @param sceneObj
 */
export async function fakeManifest(sceneObj: File): Promise<FakeManifestResult> {
  const text = await sceneObj.text();
  const parts = splitObj(text);

  const passFolder = "intel-gpa-scene";
  const vfs = new VirtualFileSystem();

  const draws: DrawEntry[] = parts.map((part, i) => {
    const meshFile = `part_${i}.obj`;
    vfs.set(joinPath(passFolder, meshFile), new File([partToFlatShadedOBJText(part)], meshFile, { type: "text/plain" }));

    return {
      eventId: i,
      name: `${sceneObj.name} part ${i}`,
      mesh: meshFile,
      posedMesh: null,
      textures: [],
    };
  });

  const passIndex: PassIndexEntry = {
    folder: passFolder,
    index: 0,
    // No real pass roles to guess from, but marking it "presented" makes
    // the (only) pass auto-selected in the render pass list UI.
    guessedRole: "presented",
    colorTargets: [],
    depthTarget: 0,
    drawCount: draws.length,
  };

  const root: RootManifest = { passes: [passIndex] };
  const passManifests: Record<string, PassManifest> = { [passFolder]: { draws } };

  return {
    manifests: { rootPrefix: "", root, passManifests, failedPassFolders: [] },
    vfs,
  };
}
