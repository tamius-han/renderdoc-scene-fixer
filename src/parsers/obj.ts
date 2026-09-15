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


/** Deduplicates a parsed OBJ's positions (merges vertices at identical
 * coordinates) and remaps every face's `v` index onto the deduped array.
 * `t`/`n` indices are left untouched since they still point into the
 * unmodified `uvs`/`normals` arrays. */
function dedupeVerts(obj: ParsedOBJ): ParsedOBJ {
  const uniquePositions: [number, number, number][] = [];
  const positionMap = new Map<string, number>(); // "x,y,z" -> new 1-based index
  const remap = new Map<number, number>(); // original 1-based index -> new 1-based index

  obj.positions.forEach((p, i) => {
    const key = p.join(",");
    let newIndex = positionMap.get(key);
    if (newIndex === undefined) {
      newIndex = uniquePositions.length + 1;
      positionMap.set(key, newIndex);
      uniquePositions.push(p);
    }
    remap.set(i + 1, newIndex);
  });

  const faces = obj.faces.map((face) => face.map((corner) => ({ ...corner, v: remap.get(corner.v)! })));

  return { ...obj, positions: uniquePositions, faces };
}

/**
 * Splits a mesh into connected components ("loose parts"): faces that share
 * a (deduped) position vertex end up in the same part. Each returned part is
 * a self-contained ParsedOBJ with its own compact, 1-based `positions`/`faces`;
 * `uvs`/`normals` are shared by reference since their indices are untouched.
 */
function groupByLooseParts(obj: ParsedOBJ): ParsedOBJ[] {
  // Build adjacency: position vertex -> list of face indices
  const vertexToFaces = new Map<number, number[]>();
  obj.faces.forEach((face, fi) => {
    for (const { v } of face) {
      if (!vertexToFaces.has(v)) vertexToFaces.set(v, []);
      vertexToFaces.get(v)!.push(fi);
    }
  });

  const visitedFaces = new Set<number>();
  const parts: ParsedOBJ[] = [];

  // BFS/DFS to group connected faces
  for (let i = 0; i < obj.faces.length; i++) {
    if (visitedFaces.has(i)) continue;

    const faceQueue = [i];
    const partFaceIndices: number[] = [];

    while (faceQueue.length > 0) {
      const fIndex = faceQueue.pop()!;
      if (visitedFaces.has(fIndex)) continue;
      visitedFaces.add(fIndex);
      partFaceIndices.push(fIndex);

      // All faces sharing any of these vertices are connected
      for (const { v } of obj.faces[fIndex]) {
        for (const neighborFace of vertexToFaces.get(v) ?? []) {
          if (!visitedFaces.has(neighborFace)) faceQueue.push(neighborFace);
        }
      }
    }

    // Renumber this part's positions onto a compact local 1-based range.
    const localIndex = new Map<number, number>(); // global position index -> local index
    const positions: [number, number, number][] = [];
    const faces: FaceVertex[][] = partFaceIndices.map((fIndex) =>
      obj.faces[fIndex].map((corner) => {
        let local = localIndex.get(corner.v);
        if (local === undefined) {
          local = positions.length + 1;
          localIndex.set(corner.v, local);
          positions.push(obj.positions[corner.v - 1]);
        }
        return { ...corner, v: local };
      }),
    );

    parts.push({
      positions,
      uvs: obj.uvs,
      normals: obj.normals,
      faces,
      mtllib: obj.mtllib,
      usemtl: obj.usemtl,
    });
  }

  return parts;
}

/** Parses OBJ text, dedupes coincident vertices, then splits the mesh into
 * one ParsedOBJ per connected ("loose") part. */
export function splitObj(text: string): ParsedOBJ[] {
  const parsed = parseOBJ(text);
  const deduped = dedupeVerts(parsed);
  return groupByLooseParts(deduped);
}
