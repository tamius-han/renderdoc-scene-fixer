import type { Mat4 } from "./transform-math";

/** Flat, non-indexed per-corner geometry arrays - the same layout as
 * GeometryArrays elsewhere in the app, but as Float32Arrays so they're
 * cheap to store in IndexedDB and can be handed to three.js without a copy. */
export interface SavedGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
}

export type SavedTextureKind = "baseColor" | "normal" | "metallicRoughness";

/** One saved draw call. `textures` values are keys into
 * SavedItemPayload.textures, so a texture shared by several draws is stored
 * once per saved item. */
export interface SavedDrawPayload {
  name: string;
  eventId: number;
  /** Output (posed) geometry - what the viewport shows. */
  output: SavedGeometry;
  /** Input (un-posed) geometry; null when it was identical to the output. */
  input: SavedGeometry | null;
  textures: Partial<Record<SavedTextureKind, string>>;
}

export interface SavedTexturePayload {
  fileName: string;
  /** MIME type of `blob` (image/png etc.). */
  type: string;
  blob: Blob;
}

/** The heavy part of a saved item: geometry and texture files. Lives in its
 * own IndexedDB store so moving/renaming an item never rewrites it. */
export interface SavedItemPayload {
  id: string;
  draws: SavedDrawPayload[];
  textures: Record<string, SavedTexturePayload>;
}

/** The light part: everything the sidebar list and transforms need. */
export interface SavedItemMeta {
  id: string;
  name: string;
  /** Monotonic counter used for default names and list order. */
  seq: number;
  createdAt: number;
  drawCount: number;
  triangleCount: number;
  textureCount: number;
  /** Transform that put the geometry where it sat in the scene it was saved
   * from (the scene's up-axis/ground-plane correction and normalisation
   * scale). Never edited afterwards. */
  baseMatrix: Mat4;
  /** The item's own editable world transform (move/rotate/scale/arrange).
   * Identity = exactly where it was when saved. World = matrix * baseMatrix. */
  matrix: Mat4;
}
