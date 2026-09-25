import * as THREE from "three";
import type { Bounds } from "../scene/mesh-builder";

/** One mesh to embed in the exported .glb, becoming its own named object
 * (node) in Blender's outliner - see buildGlbBlob(). Positions/normals/uvs
 * are flat, non-indexed, per-corner arrays in the SAME convention as
 * GeometryArrays elsewhere in this app (see mesh-builder.ts) - i.e.
 * exactly draw.geometryData as already loaded/corrected, no reshaping
 * needed to call this. buildGlbBlob() itself welds matching corners back
 * into a proper indexed mesh on the way out (see weldVertices()) - this
 * interface stays in the same flat/exploded shape as the rest of the
 * app's geometry pipeline purely so nothing upstream of export needs to
 * know or care about indexing. */
export interface ExportMeshEntry {
  name: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  bounds: Bounds;
  material: THREE.Material;
  /** Optional normal map / combined metallic-roughness map (roughness in
   * the G channel, metalness in B - the same channel layout glTF's own
   * pbrMetallicRoughness.metallicRoughnessTexture expects, and what
   * RenderDoc-captured "metalness / roughness" bind-point textures are
   * already in) to embed on this mesh's material - see app.ts's
   * loadAuxiliaryDrawTextures(). Left undefined when the capture didn't
   * have a bound texture of that kind, or "Export textures" is off.
   *
   * NOTE: every material this app exports carries the KHR_materials_unlit
   * extension (see getOrCreateMaterial() below) so the flat, unshaded look
   * this app deliberately renders with round-trips into Blender correctly
   * - and per the KHR_materials_unlit spec, conformant viewers (Blender's
   * glTF importer included) SHOULD ignore normalTexture and
   * metallicRoughnessTexture entirely when that extension is present, i.e.
   * these two maps won't visibly do anything by default even once
   * embedded. They're still written into the file (as real, referenced
   * images, not just loose embedded bytes) because that's what was
   * actually missing - a user hand-wiring a proper lit material in
   * Blender's shader editor, or a different tool that doesn't special-case
   * KHR_materials_unlit, can still make use of them from there. */
  normalTexture?: THREE.Texture;
  metallicRoughnessTexture?: THREE.Texture;
}

/** The overall scene orientation/scale to bake into a single root node that
 * every exported mesh is parented under - matching contentGroup's own
 * quaternion/scale at export time, so the arrangement Blender loads looks
 * the same as what's currently on screen (ground-plane leveling, up-axis,
 * fixedScale and all) without needing to bake that transform into every
 * individual mesh's vertex data. */
export interface ExportSceneTransform {
  quaternion: THREE.Quaternion;
  scale: number;
  /** Root-node translation, applied AFTER rotation/scale (standard glTF
   * TRS order: local = T * R * S) - so this is expressed in the ALREADY
   * rotated-and-scaled space, not the mesh data's own raw local space.
   * Optional; omitted (or left at (0,0,0)) exports at whatever position
   * the scene's own geometry naturally sits at, same as before this field
   * existed. Set by app.ts's applyExportMoveToOrigin() for the "move
   * object to origin" export option. */
  translation?: THREE.Vector3;
}

/** Deliberately NOT three.js's own GLTFExporter addon: that lives under
 * three/examples/jsm, which this project avoids importing from (see
 * SceneManager's own doc comment on the same point) - so this hand-rolls
 * just the (fairly small) subset of the glTF 2.0 + GLB container spec this
 * app actually needs: one unlit, possibly-textured material per mesh, one
 * embedded PNG per distinct texture, indexed triangle primitives (each
 * entry's flat per-corner arrays are welded back down to shared vertices
 * on the way out - see weldVertices()), and a single root node carrying
 * the scene's current orientation/scale. */

const GLB_MAGIC = 0x46546c67; // "glTF" (little-endian bytes: 'g','l','T','F')
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a; // "JSON" LE
const CHUNK_TYPE_BIN = 0x004e4942; // "BIN\0" LE

const COMPONENT_TYPE_UNSIGNED_SHORT = 5123;
const COMPONENT_TYPE_UNSIGNED_INT = 5125;
const COMPONENT_TYPE_FLOAT = 5126;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

/** Accumulates binary chunks (typed-array attribute data, embedded PNG
 * bytes) into one contiguous buffer, padding each chunk up to a 4-byte
 * boundary as it's added (glTF accessors/bufferViews are only guaranteed
 * well-aligned this way) and handing back the byteOffset/byteLength each
 * chunk landed at for the corresponding bufferView. */
class BinaryBufferBuilder {
  private chunks: Uint8Array[] = [];
  private cursor = 0;

  push(bytes: Uint8Array): { byteOffset: number; byteLength: number } {
    const byteOffset = this.cursor;
    this.chunks.push(bytes);
    this.cursor += bytes.byteLength;
    const pad = (4 - (this.cursor % 4)) % 4;
    if (pad > 0) {
      this.chunks.push(new Uint8Array(pad));
      this.cursor += pad;
    }
    return { byteOffset, byteLength: bytes.byteLength };
  }

  get byteLength(): number {
    return this.cursor;
  }

  build(): Uint8Array {
    const out = new Uint8Array(this.cursor);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

function floatArrayToBytes(values: number[]): Uint8Array {
  // Float32Array's underlying buffer is native-endian, which in every
  // real-world JS engine (V8, JSC, SpiderMonkey all run on little-endian
  // hardware in practice) matches the little-endian byte order glTF
  // requires - the same assumption three.js's own GLTFExporter makes, so
  // no manual byte-swapping/DataView writes are needed here.
  return new Uint8Array(new Float32Array(values).buffer);
}

/** OBJ/OpenGL UVs put v=0 at the BOTTOM of the image; glTF (like most
 * modern formats) puts v=0 at the TOP. This app's own on-screen rendering
 * compensates for that mismatch via THREE.Texture's default flipY:true
 * GPU-upload behavior instead - which only affects how the texture is
 * uploaded, not the pixels captured off the canvas for export (see
 * canvasToPngBytes()) - so the UVs need the equivalent v'=1-v flip here to
 * look right against the plain, unflipped PNG bytes being embedded. */
function flipUvV(uvs: number[]): number[] {
  const out = new Array<number>(uvs.length);
  for (let i = 0; i < uvs.length; i += 2) {
    out[i] = uvs[i];
    out[i + 1] = 1 - uvs[i + 1];
  }
  return out;
}

// Vertices whose position/normal/uv all agree to within this absolute
// tolerance are considered "the same vertex" by weldVertices() below.
// Loose enough to swallow the tiny floating-point noise a chain of
// otherwise-exact transforms (distortion correction, ground-plane
// rotation, export resize/move-to-origin, ...) can introduce even between
// corners that started out byte-identical, but tight enough that it can't
// plausibly merge two corners a real mesh feature actually needs kept
// apart (this app's geometry lives on the scale of whole scenes/objects,
// never anywhere near 1e-5 units apart on purpose).
const WELD_EPSILON = 1e-5;

function weldKeyComponent(value: number): number {
  return Math.round(value / WELD_EPSILON);
}

/** Deduplicates a flat, non-indexed (one vertex per triangle corner) mesh
 * down to an indexed one: any corners whose position, normal, AND uv all
 * match (within WELD_EPSILON) collapse into one shared vertex.
 *
 * Every mesh this app hands to buildGlbBlob() arrives in that flat,
 * exploded shape - see objToGeometryArrays()'s own doc comment on why
 * OBJ/geometryData itself is already like this well before export ever
 * gets involved - so two triangles that visually share an edge on screen
 * usually don't share any actual vertex DATA once they reach here, each
 * carrying its own separate (if numerically identical) copy of that
 * edge's two corners. That's invisible to a GPU, which doesn't care, but
 * it matters to a real DCC tool: smoothing, subdivision, sculpting,
 * weight-painting, symmetry, and anything else that depends on genuine
 * mesh topology all misbehave right along every one of those invisible
 * seams, since as far as the mesh's own connectivity is concerned there
 * IS no shared edge there at all.
 *
 * Matching requires ALL THREE attributes to agree, not just position: two
 * corners at the same point but with a different normal (a genuine hard
 * edge, e.g. a cube corner) or different UVs (a texture seam) are
 * correctly left as separate vertices - welding those would visibly
 * distort shading or texturing across a seam that's supposed to be
 * there, not just fix topology. */
function weldVertices(
  positions: number[],
  normals: number[],
  uvs: number[],
): { positions: number[]; normals: number[]; uvs: number[]; indices: number[] } {
  const weldedPositions: number[] = [];
  const weldedNormals: number[] = [];
  const weldedUvs: number[] = [];
  const indices: number[] = [];
  const indexByKey = new Map<string, number>();

  const vertexCount = positions.length / 3;
  for (let i = 0; i < vertexCount; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    const nx = normals[i * 3];
    const ny = normals[i * 3 + 1];
    const nz = normals[i * 3 + 2];
    const u = uvs[i * 2];
    const v = uvs[i * 2 + 1];

    const key = [px, py, pz, nx, ny, nz, u, v].map(weldKeyComponent).join(",");
    let weldedIndex = indexByKey.get(key);
    if (weldedIndex === undefined) {
      weldedIndex = weldedPositions.length / 3;
      weldedPositions.push(px, py, pz);
      weldedNormals.push(nx, ny, nz);
      weldedUvs.push(u, v);
      indexByKey.set(key, weldedIndex);
    }
    indices.push(weldedIndex);
  }

  return { positions: weldedPositions, normals: weldedNormals, uvs: weldedUvs, indices };
}

/** Packs a triangle-index list into the smallest glTF-legal component type
 * that can hold every value (UNSIGNED_SHORT below 65536 distinct
 * vertices, UNSIGNED_INT otherwise - UNSIGNED_BYTE is legal too but not
 * worth the extra branch, since it only ever helps for genuinely tiny
 * meshes), alongside which component type it picked (buildGlbBlob() needs
 * that for the accessor, not just the bytes). */
function indicesToBytes(indices: number[], vertexCount: number): { bytes: Uint8Array; componentType: number } {
  if (vertexCount > 65535) {
    return { bytes: new Uint8Array(new Uint32Array(indices).buffer), componentType: COMPONENT_TYPE_UNSIGNED_INT };
  }
  return { bytes: new Uint8Array(new Uint16Array(indices).buffer), componentType: COMPONENT_TYPE_UNSIGNED_SHORT };
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Re-encodes whatever image data a texture is currently holding as PNG
 * bytes. TextureManager's own textures wrap an ImageBitmap at its native,
 * undownscaled resolution (see texture-manager.ts), not a <canvas>, so this
 * always goes through the draw-to-a-fresh-canvas path below - which is why
 * the exported PNG always ends up at the source texture's full resolution.
 * THREE.Texture#image is loosely typed (effectively `any` in @types/three,
 * to accommodate every possible image source), so this accepts the same. */
function canvasToPngBytes(image: unknown): Uint8Array {
  const canvas =
    image instanceof HTMLCanvasElement
      ? image
      : (() => {
          const fallback = document.createElement("canvas");
          const source = image as CanvasImageSource & { width?: number; height?: number };
          fallback.width = source.width || 1;
          fallback.height = source.height || 1;
          fallback.getContext("2d")?.drawImage(source, 0, 0, fallback.width, fallback.height);
          return fallback;
        })();
  return dataUrlToBytes(canvas.toDataURL("image/png"));
}

interface GltfJson {
  asset: { version: string; generator: string };
  extensionsUsed?: string[];
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: Array<{ name?: string; mesh?: number; rotation?: number[]; scale?: number[]; translation?: number[]; children?: number[] }>;
  meshes: Array<{ name?: string; primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number }> }>;
  materials: Array<{
    name?: string;
    pbrMetallicRoughness: {
      baseColorFactor?: number[];
      baseColorTexture?: { index: number };
      metallicRoughnessTexture?: { index: number };
      metallicFactor: number;
      roughnessFactor: number;
    };
    normalTexture?: { index: number };
    doubleSided?: boolean;
    extensions?: { KHR_materials_unlit: Record<string, never> };
  }>;
  textures: Array<{ sampler: number; source: number }>;
  images: Array<{ mimeType: string; bufferView: number }>;
  samplers: Array<{ magFilter: number; minFilter: number; wrapS: number; wrapT: number }>;
  accessors: Array<{
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }>;
  bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number; target?: number }>;
  buffers: Array<{ byteLength: number }>;
}

/** Builds a single, self-contained .glb (binary glTF 2.0) file from the
 * given meshes - each becomes its own named node/object, so a "drag and
 * drop into Blender" (or File > Import > glTF 2.0) load shows a list of
 * separate objects rather than one merged mesh. Every material's texture
 * (if any) is embedded directly in the binary payload as PNG data - there
 * are no external file references, so the one .glb is everything Blender
 * needs.
 *
 * `litShading` controls whether exported materials carry the
 * KHR_materials_unlit extension - see getOrCreateMaterial() and
 * ExportMeshEntry's own doc comment for what turning it on/off means for
 * any embedded normal/metallic-roughness maps. Driven by the "Lit
 * shading" checkbox in the export dialog (cmp.export-mesh.ts) via
 * AppConfiguration.exportOptions.litShading. */
export function buildGlbBlob(meshes: ExportMeshEntry[], sceneTransform: ExportSceneTransform, litShading: boolean): Blob {
  const buffer = new BinaryBufferBuilder();
  const bufferViews: GltfJson["bufferViews"] = [];
  const accessors: GltfJson["accessors"] = [];
  const images: GltfJson["images"] = [];
  const textures: GltfJson["textures"] = [];
  const materials: GltfJson["materials"] = [];
  const gltfMeshes: GltfJson["meshes"] = [];
  const nodes: GltfJson["nodes"] = [];

  const samplers: GltfJson["samplers"] = [
    { magFilter: 9729 /* LINEAR */, minFilter: 9987 /* LINEAR_MIPMAP_LINEAR */, wrapS: 10497 /* REPEAT */, wrapT: 10497 /* REPEAT */ },
  ];

  // Textures are keyed by the actual image object so two materials
  // sharing the same decoded texture (the common case - see
  // resolveMaterial()'s materialCache) only embed the PNG once.
  const imageIndexByElement = new Map<unknown, number>();
  const textureIndexByMap = new Map<THREE.Texture, number>();
  const materialIndexByMaterial = new Map<THREE.Material, number>();

  const addBufferView = (bytes: Uint8Array, target?: number): number => {
    const { byteOffset, byteLength } = buffer.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset, byteLength, ...(target !== undefined ? { target } : {}) });
    return bufferViews.length - 1;
  };

  const getOrCreateTexture = (map: THREE.Texture): number => {
    const cachedTexture = textureIndexByMap.get(map);
    if (cachedTexture !== undefined) return cachedTexture;

    const image: unknown = map.image;
    let imageIndex = imageIndexByElement.get(image);
    if (imageIndex === undefined) {
      const pngBytes = canvasToPngBytes(image);
      const bufferViewIndex = addBufferView(pngBytes);
      imageIndex = images.length;
      images.push({ mimeType: "image/png", bufferView: bufferViewIndex });
      imageIndexByElement.set(image, imageIndex);
    }

    const textureIndex = textures.length;
    textures.push({ sampler: 0, source: imageIndex });
    textureIndexByMap.set(map, textureIndex);
    return textureIndex;
  };

  const getOrCreateMaterial = (entry: ExportMeshEntry, fallbackName: string): number => {
    const material = entry.material;
    // Two draws can legitimately share the exact same diffuse-only
    // material object (see resolveMaterial()'s materialCache) while having
    // different normal/roughness bindings of their own (those aren't part
    // of `material` at all - THREE.MeshBasicMaterial has nowhere to hold
    // them - they're carried separately on the entry, see
    // loadAuxiliaryDrawTextures()). So the material-identity cache below
    // only applies when neither aux texture is present; entries that DO
    // have one always get their own glTF material rather than risking
    // reusing another entry's unrelated normal/roughness map.
    const cacheable = !entry.normalTexture && !entry.metallicRoughnessTexture;
    if (cacheable) {
      const cached = materialIndexByMaterial.get(material);
      if (cached !== undefined) return cached;
    }

    const basic = material instanceof THREE.MeshBasicMaterial ? material : null;
    const color = basic?.color ?? new THREE.Color(0xffffff);
    const materialIndex = materials.length;
    materials.push({
      name: material.name || fallbackName,
      pbrMetallicRoughness: {
        baseColorFactor: [color.r, color.g, color.b, basic?.opacity ?? 1],
        ...(basic?.map ? { baseColorTexture: { index: getOrCreateTexture(basic.map) } } : {}),
        ...(entry.metallicRoughnessTexture
          ? { metallicRoughnessTexture: { index: getOrCreateTexture(entry.metallicRoughnessTexture) } }
          : {}),
        // Only claim the map actually drives metalness once one is
        // present - otherwise leave the material at its previous
        // (fully-dielectric, unmetallic) defaults.
        metallicFactor: entry.metallicRoughnessTexture ? 1 : 0,
        roughnessFactor: 1,
      },
      ...(entry.normalTexture ? { normalTexture: { index: getOrCreateTexture(entry.normalTexture) } } : {}),
      doubleSided: material.side === THREE.DoubleSide,
      // Every material in this app is rendered unlit ON SCREEN
      // (MeshBasicMaterial, no lights in the scene at all - see
      // resolveMaterial()), but that's a choice about EXPORT, not a fact
      // about the underlying capture - this extension is only added when
      // `litShading` is off (the default), to make Blender's glTF
      // importer reproduce that same flat, unshaded look instead of
      // treating baseColorFactor as input to its normal lit PBR shading.
      // With `litShading` on, it's deliberately left off instead, so any
      // embedded normalTexture/metallicRoughnessTexture above (see
      // ExportMeshEntry's own doc comment) actually drive real PBR
      // shading in Blender rather than being ignored per the
      // KHR_materials_unlit spec.
      ...(litShading ? {} : { extensions: { KHR_materials_unlit: {} } }),
    });
    if (cacheable) materialIndexByMaterial.set(material, materialIndex);
    return materialIndex;
  };

  meshes.forEach((entry) => {
    const welded = weldVertices(entry.positions, entry.normals, entry.uvs);
    const vertexCount = welded.positions.length / 3;

    const positionView = addBufferView(floatArrayToBytes(welded.positions), TARGET_ARRAY_BUFFER);
    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      componentType: COMPONENT_TYPE_FLOAT,
      count: vertexCount,
      type: "VEC3",
      // Still the pre-weld, whole-mesh bounds computed upstream (see
      // app.ts) - welding only merges duplicate corners, it can't change
      // the mesh's actual extent, so these remain correct.
      min: entry.bounds.min.toArray(),
      max: entry.bounds.max.toArray(),
    });

    const normalView = addBufferView(floatArrayToBytes(welded.normals), TARGET_ARRAY_BUFFER);
    const normalAccessor = accessors.length;
    accessors.push({ bufferView: normalView, componentType: COMPONENT_TYPE_FLOAT, count: vertexCount, type: "VEC3" });

    const uvView = addBufferView(floatArrayToBytes(flipUvV(welded.uvs)), TARGET_ARRAY_BUFFER);
    const uvAccessor = accessors.length;
    accessors.push({ bufferView: uvView, componentType: COMPONENT_TYPE_FLOAT, count: vertexCount, type: "VEC2" });

    const { bytes: indexBytes, componentType: indexComponentType } = indicesToBytes(welded.indices, vertexCount);
    const indexView = addBufferView(indexBytes, TARGET_ELEMENT_ARRAY_BUFFER);
    const indexAccessor = accessors.length;
    accessors.push({ bufferView: indexView, componentType: indexComponentType, count: welded.indices.length, type: "SCALAR" });

    const materialIndex = getOrCreateMaterial(entry, entry.name);

    const meshIndex = gltfMeshes.length;
    gltfMeshes.push({
      name: entry.name,
      primitives: [
        {
          attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor },
          indices: indexAccessor,
          material: materialIndex,
        },
      ],
    });

    nodes.push({ name: entry.name, mesh: meshIndex });
  });

  // One root node carries the scene's current orientation/scale; every
  // mesh node above sits under it with an identity transform, since their
  // own vertex data is already all in the SAME shared local space (exactly
  // how contentGroup + its children work live in the viewer - see
  // SceneManager.addContent()).
  const meshNodeIndices = nodes.map((_, index) => index);
  const rootNodeIndex = nodes.length;
  nodes.push({
    name: "Scene",
    rotation: sceneTransform.quaternion.toArray(),
    scale: [sceneTransform.scale, sceneTransform.scale, sceneTransform.scale],
    ...(sceneTransform.translation ? { translation: sceneTransform.translation.toArray() } : {}),
    children: meshNodeIndices,
  });

  const json: GltfJson = {
    asset: { version: "2.0", generator: "RenderDoc Scene Fixer" },
    extensionsUsed: litShading ? [] : ["KHR_materials_unlit"],
    scene: 0,
    scenes: [{ nodes: [rootNodeIndex] }],
    nodes,
    meshes: gltfMeshes,
    materials,
    textures,
    images,
    samplers,
    accessors,
    bufferViews,
    buffers: [{ byteLength: buffer.byteLength }],
  };

  const jsonText = JSON.stringify(json);
  const jsonBytesRaw = new TextEncoder().encode(jsonText);
  const jsonPad = (4 - (jsonBytesRaw.byteLength % 4)) % 4;
  const jsonBytes = new Uint8Array(jsonBytesRaw.byteLength + jsonPad);
  jsonBytes.set(jsonBytesRaw, 0);
  jsonBytes.fill(0x20 /* space - required padding byte for the JSON chunk */, jsonBytesRaw.byteLength);

  const binBytes = buffer.build();

  const totalLength = 12 + (8 + jsonBytes.byteLength) + (8 + binBytes.byteLength);
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);
  let offset = 0;

  view.setUint32(offset, GLB_MAGIC, true);
  offset += 4;
  view.setUint32(offset, GLB_VERSION, true);
  offset += 4;
  view.setUint32(offset, totalLength, true);
  offset += 4;

  view.setUint32(offset, jsonBytes.byteLength, true);
  offset += 4;
  view.setUint32(offset, CHUNK_TYPE_JSON, true);
  offset += 4;
  glb.set(jsonBytes, offset);
  offset += jsonBytes.byteLength;

  view.setUint32(offset, binBytes.byteLength, true);
  offset += 4;
  view.setUint32(offset, CHUNK_TYPE_BIN, true);
  offset += 4;
  glb.set(binBytes, offset);
  offset += binBytes.byteLength;

  return new Blob([glb], { type: "model/gltf-binary" });
}
