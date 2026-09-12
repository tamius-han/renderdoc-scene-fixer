import { joinPath, type VirtualFileSystem } from "../filesystem";
import type { LoadedManifests } from "../manifest";

interface ParsedMesh {
  positions: number[];
  uvs: number[];
  normals: number[];
}

function decodeXmlDocument(xmlText: string): Document | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) return null;
    return doc;
  } catch {
    return null;
  }
}

function normalizeName(name: string | null | undefined): string {
  return (name ?? "").replace(/^.*:/, "").toLowerCase();
}

function getElementName(el: Element): string {
  return normalizeName(el.tagName);
}

function getTextNumbers(text: string): number[] {
  const matches = text.match(/-?(?:\d+\.\d+|\d+|\.\d+)(?:[eE][-+]?\d+)?/g);
  return matches ? matches.map(Number) : [];
}

function findCandidateValues(root: Element, names: RegExp): number[] {
  const values: number[] = [];

  const walk = (element: Element): void => {
    const elementName = getElementName(element);
    const attrName = normalizeName(element.getAttribute("name") ?? element.getAttribute("Name"));
    const attrType = normalizeName(element.getAttribute("typename") ?? element.getAttribute("type"));
    const combined = `${elementName} ${attrName} ${attrType}`;

    if (/(float|double|int|uint|long|ulong|short|ushort|byte|ubyte)/.test(elementName)) {
      const numericText = (element.textContent ?? "").trim();
      if (numericText && names.test(combined)) {
        values.push(...getTextNumbers(numericText));
      }
    }

    if (/(array|list|vector|values)/.test(elementName) || names.test(combined)) {
      const text = element.textContent ?? "";
      const numbers = getTextNumbers(text);
      if (numbers.length > 0 && names.test(combined)) {
        values.push(...numbers);
      }
    }

    for (const child of Array.from(element.children)) walk(child);
  };

  walk(root);
  return values;
}

function chunkValues(values: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + size <= values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

function parseMeshFromXml(xmlText: string): ParsedMesh | null {
  const doc = decodeXmlDocument(xmlText);
  if (!doc) return null;

  const positions = findCandidateValues(doc.documentElement, /position|vertex|point|mesh/);
  const normals = findCandidateValues(doc.documentElement, /normal|normals/);
  const uvs = findCandidateValues(doc.documentElement, /uv|texcoord|texturecoord|coord/);

  const positionTriples = chunkValues(positions, 3).filter((v) => v.length === 3);
  const normalTriples = chunkValues(normals, 3).filter((v) => v.length === 3);
  const uvPairs = chunkValues(uvs, 2).filter((v) => v.length === 2);

  if (positionTriples.length === 0) return null;

  const flatPositions = positionTriples.flat();
  const flatNormals = normalTriples.length > 0 ? normalTriples.flat() : new Array(flatPositions.length).fill(0);
  const flatUVs = uvPairs.length > 0 ? uvPairs.flat() : new Array(Math.max(0, flatPositions.length / 3 * 2)).fill(0);

  return {
    positions: flatPositions,
    normals: flatNormals,
    uvs: flatUVs,
  };
}

function makeOnePixelPng(): Uint8Array {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAF" +
    "c1uJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJ0UkG" +
    "AAAAAAgIYlKcAAAABG0lUOAAAABJRU5ErkJggg==";
  return Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
}

function buildObjText(mesh: ParsedMesh, mtlName: string): string {
  const lines: string[] = [`mtllib ${mtlName}`, "o raw_capture_mesh"];

  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`);
  }

  for (let i = 0; i < mesh.uvs.length; i += 2) {
    lines.push(`vt ${mesh.uvs[i]} ${mesh.uvs[i + 1]}`);
  }

  for (let i = 0; i < mesh.normals.length; i += 3) {
    lines.push(`vn ${mesh.normals[i]} ${mesh.normals[i + 1]} ${mesh.normals[i + 2]}`);
  }

  const vertexCount = mesh.positions.length / 3;
  for (let i = 1; i <= Math.max(0, vertexCount - 2); i += 1) {
    const a = i;
    const b = i + 1;
    const c = i + 2;
    if (c <= vertexCount) {
      lines.push(`f ${a}/${Math.min(a, Math.max(1, Math.ceil((a - 1) / 2) + 1))}/${a} ${b}/${Math.min(b, Math.max(1, Math.ceil((b - 1) / 2) + 1))}/${b} ${c}/${Math.min(c, Math.max(1, Math.ceil((c - 1) / 2) + 1))}/${c}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function loadRawCapture(vfs: VirtualFileSystem): Promise<LoadedManifests | null> {
  const xmlPath = Array.from(vfs.keys()).find((path) => path.toLowerCase().endsWith("index.xml") || path.toLowerCase().endsWith("capture.xml") || path.toLowerCase().endsWith(".xml"));
  if (!xmlPath) return null;

  const xmlText = await vfs.readText(xmlPath);
  if (!xmlText) return null;

  const mesh = parseMeshFromXml(xmlText);
  if (!mesh) return null;

  const rootDir = "raw-capture";
  const meshPath = joinPath(rootDir, "capture.obj");
  const mtlPath = joinPath(rootDir, "capture.mtl");
  const texPath = joinPath(rootDir, "capture.png");

  const objText = buildObjText(mesh, "capture.mtl");
  const mtlText = `newmtl default\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nmap_Kd ${texPath}\n`;

  vfs.set(meshPath, new File([objText], "capture.obj", { type: "text/plain" }));
  vfs.set(mtlPath, new File([mtlText], "capture.mtl", { type: "text/plain" }));
  vfs.set(texPath, new File([makeOnePixelPng()], "capture.png", { type: "image/png" }));

  const passFolder = "raw-capture";
  return {
    rootPrefix: "",
    root: {
      passes: [{
        folder: passFolder,
        index: 0,
        guessedRole: "raw-renderdoc-capture",
        colorTargets: [0],
        depthTarget: 0,
        drawCount: 1,
      }],
    },
    passManifests: {
      [passFolder]: {
        draws: [{
          eventId: 0,
          name: "raw capture mesh",
          mesh: meshPath,
          posedMesh: meshPath,
          textures: [{ bindPoint: 0, name: "baseColor", textureFile: texPath }],
        }],
      },
    },
    failedPassFolders: [],
  };
}
