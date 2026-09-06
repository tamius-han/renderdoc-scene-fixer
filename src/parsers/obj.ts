import type { FaceVertex, ParsedOBJ } from '../types';

/** Parses the OBJ subset the exporter writes: v/vt/vn/f plus mtllib/usemtl.
 * Faces with more than 3 corners are fan-triangulated (the exporter never
 * emits these, but a general parser should still handle it safely). */
export function parseOBJ(text: string): ParsedOBJ {
  const positions: [number, number, number][] = [];
  const uvs: [number, number][] = [];
  const normals: [number, number, number][] = [];
  const faces: FaceVertex[][] = [];
  let mtllib: string | null = null;
  let usemtl: string | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const parts = line.split(/\s+/);

    switch (parts[0]) {
      case "v":
        positions.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
        break;
      case "vt":
        uvs.push([parseFloat(parts[1]), parseFloat(parts[2])]);
        break;
      case "vn":
        normals.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
        break;
      case "mtllib":
        mtllib = parts.slice(1).join(" ");
        break;
      case "usemtl":
        usemtl = parts.slice(1).join(" ");
        break;
      case "f": {
        const verts: FaceVertex[] = parts.slice(1).map((token) => {
          const idx = token.split("/").map((x) => (x === "" ? undefined : parseInt(x, 10)));
          return { v: idx[0] as number, t: idx[1], n: idx[2] };
        });
        for (let i = 1; i + 1 < verts.length; i++) {
          faces.push([verts[0], verts[i], verts[i + 1]]);
        }
        break;
      }
      default:
        break;
    }
  }

  return { positions, uvs, normals, faces, mtllib, usemtl };
}

