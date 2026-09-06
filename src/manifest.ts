import { dirname, joinPath, VirtualFileSystem } from "./filesystem";
import type { PassManifest, RootManifest } from "./types";

export interface LoadedManifests {
  /** Folder (relative to the dropped root) that manifest.json was found in -
   * everything else is resolved relative to this. */
  rootPrefix: string;
  root: RootManifest;
  passManifests: Record<string, PassManifest>;
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
  for (const pass of root.passes) {
    const pmPath = joinPath(rootPrefix, pass.folder, "manifest.json");
    const pmText = await vfs.readText(pmPath);
    if (!pmText) continue;
    try {
      passManifests[pass.folder] = JSON.parse(pmText) as PassManifest;
    } catch (e) {
      console.warn(`Failed to parse ${pmPath}`, e);
    }
  }

  return { rootPrefix, root, passManifests };
}

