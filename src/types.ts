/** Top-level manifest.json written by the RenderDoc SceneExporter extension. */
export interface RootManifest {
  passes: PassIndexEntry[];
}

export interface PassIndexEntry {
  folder: string;
  index: number;
  guessedRole: string;
  colorTargets: number[];
  depthTarget: number;
  drawCount: number;
}

/** Per-pass manifest.json, one level inside each pass_NN_tag/ folder. */
export interface PassManifest {
  draws: DrawEntry[];
}

export interface DrawEntry {
  eventId: number;
  name: string;
  mesh: string | null;
  posedMesh: string | null;
  textures: TextureBinding[];
}

export interface TextureBinding {
  bindPoint: number;
  name: string | null;
  textureFile: string | null;
}

/** One corner of a triangle as referenced by an OBJ face line - indices are
 * 1-based (OBJ convention) and t/n may be absent (e.g. "f 1//1"). */
export interface FaceVertex {
  v: number;
  t?: number;
  n?: number;
}

export interface ParsedOBJ {
  positions: [number, number, number][];
  uvs: [number, number][];
  normals: [number, number, number][];
  /** Already triangulated - each entry is exactly 3 FaceVertex corners. */
  faces: FaceVertex[][];
  mtllib: string | null;
  usemtl: string | null;
}

export interface MTLMaterial {
  name: string;
  mapKd?: string;
  bump?: string;
}
