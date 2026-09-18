import * as THREE from "three";
import type { Bounds } from "../scene/mesh-builder";

/** One mesh to embed in the exported .glb, becoming its own named object
 * (node) in Blender's outliner - see buildGlbBlob(). Positions/normals/uvs
 * are flat, non-indexed, per-corner arrays in the SAME convention as
 * GeometryArrays elsewhere in this app (see mesh-builder.ts) - i.e.
 * exactly draw.geometryData as already loaded/corrected, no reshaping
 * needed to call this. */
export interface ExportMeshEntry {
  name: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  bounds: Bounds;
  material: THREE.Material;
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
}

/** Deliberately NOT three.js's own GLTFExporter addon: that lives under
 * three/examples/jsm, which this project avoids importing from (see
 * SceneManager's own doc comment on the same point) - so this hand-rolls
 * just the (fairly small) subset of the glTF 2.0 + GLB container spec this
 * app actually needs: one unlit, possibly-textured material per mesh, one
 * embedded PNG per distinct texture, non-indexed triangle primitives, and
 * a single root node carrying the scene's current orientation/scale. */

const GLB_MAGIC = 0x46546c67; // "glTF" (little-endian bytes: 'g','l','T','F')
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a; // "JSON" LE
const CHUNK_TYPE_BIN = 0x004e4942; // "BIN\0" LE

const COMPONENT_TYPE_FLOAT = 5126;
const TARGET_ARRAY_BUFFER = 34962;

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

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Re-encodes whatever image data a texture is currently holding as PNG
 * bytes. TextureManager's own textures already wrap a plain <canvas> (see
 * texture-manager.ts), so the common case is just reading it straight
 * back off that canvas - the defensive draw-to-a-fresh-canvas fallback
 * only matters for some other, unexpected image source ever ending up on
 * a material's .map. THREE.Texture#image is loosely typed (effectively
 * `any` in @types/three, to accommodate every possible image source), so
 * this accepts the same. */
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
  nodes: Array<{ name?: string; mesh?: number; rotation?: number[]; scale?: number[]; children?: number[] }>;
  meshes: Array<{ name?: string; primitives: Array<{ attributes: Record<string, number>; material?: number }> }>;
  materials: Array<{
    name?: string;
    pbrMetallicRoughness: { baseColorFactor?: number[]; baseColorTexture?: { index: number }; metallicFactor: number; roughnessFactor: number };
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
 * needs. */
export function buildGlbBlob(meshes: ExportMeshEntry[], sceneTransform: ExportSceneTransform): Blob {
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

  const getOrCreateMaterial = (material: THREE.Material, fallbackName: string): number => {
    const cached = materialIndexByMaterial.get(material);
    if (cached !== undefined) return cached;

    const basic = material instanceof THREE.MeshBasicMaterial ? material : null;
    const color = basic?.color ?? new THREE.Color(0xffffff);
    const materialIndex = materials.length;
    materials.push({
      name: material.name || fallbackName,
      pbrMetallicRoughness: {
        baseColorFactor: [color.r, color.g, color.b, basic?.opacity ?? 1],
        ...(basic?.map ? { baseColorTexture: { index: getOrCreateTexture(basic.map) } } : {}),
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      doubleSided: material.side === THREE.DoubleSide,
      // Every material in this app is rendered unlit (MeshBasicMaterial,
      // no lights in the scene at all - see resolveMaterial()) - this
      // extension is what makes Blender's glTF importer reproduce that
      // same flat, unshaded look instead of treating baseColorFactor as
      // input to its normal lit PBR shading.
      extensions: { KHR_materials_unlit: {} },
    });
    materialIndexByMaterial.set(material, materialIndex);
    return materialIndex;
  };

  meshes.forEach((entry) => {
    const vertexCount = entry.positions.length / 3;

    const positionView = addBufferView(floatArrayToBytes(entry.positions), TARGET_ARRAY_BUFFER);
    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      componentType: COMPONENT_TYPE_FLOAT,
      count: vertexCount,
      type: "VEC3",
      min: entry.bounds.min.toArray(),
      max: entry.bounds.max.toArray(),
    });

    const normalView = addBufferView(floatArrayToBytes(entry.normals), TARGET_ARRAY_BUFFER);
    const normalAccessor = accessors.length;
    accessors.push({ bufferView: normalView, componentType: COMPONENT_TYPE_FLOAT, count: vertexCount, type: "VEC3" });

    const uvView = addBufferView(floatArrayToBytes(flipUvV(entry.uvs)), TARGET_ARRAY_BUFFER);
    const uvAccessor = accessors.length;
    accessors.push({ bufferView: uvView, componentType: COMPONENT_TYPE_FLOAT, count: vertexCount, type: "VEC2" });

    const materialIndex = getOrCreateMaterial(entry.material, entry.name);

    const meshIndex = gltfMeshes.length;
    gltfMeshes.push({
      name: entry.name,
      primitives: [
        {
          attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor },
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
    children: meshNodeIndices,
  });

  const json: GltfJson = {
    asset: { version: "2.0", generator: "RenderDoc Scene Fixer" },
    extensionsUsed: ["KHR_materials_unlit"],
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
