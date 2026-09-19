import * as THREE from "three";
import type { FaceVertex, ParsedOBJ } from "../types";
import { calculateDistortionMatrix, type AffineDistortionOptions, type AffineDistortionResult } from "./calculator";

/** Result of matchLandmarkCorrespondence(): flat, per-face-corner position
 * arrays (3 floats per corner, 9 per face) for landmarkSource and
 * landmarkOutput, reordered so that sourcePositions[i] and
 * outputPositions[i] are the SAME physical mesh corner - i.e. exactly the
 * "vertex i of one array corresponds to vertex i of the other" input that
 * calculateDistortionMatrix() (see calculator.ts) already assumes. Same
 * length in both arrays (3 * 3 * matched face count). */
export interface LandmarkCorrespondence {
  sourcePositions: number[];
  outputPositions: number[];
  /** True if two or more faces in either mesh had near-identical volume
   * signatures (see matchLandmarkFaces()'s doc comment) - when this is
   * set, rank-based matching couldn't tell those faces apart with
   * confidence, so the correspondence (and any transform fit from it) may
   * be wrong for a subset of faces. Not a hard failure: matching still
   * proceeds with its best guess. */
  ambiguousMatch: boolean;
}

/** Looks up a face's 3 corner positions as THREE.Vector3s. */
function faceCorners(obj: ParsedOBJ, face: FaceVertex[]): THREE.Vector3[] {
  return face.map(({ v }) => {
    const p = obj.positions[v - 1] ?? [0, 0, 0];
    return new THREE.Vector3(p[0], p[1], p[2]);
  });
}

function centroidOf(points: THREE.Vector3[]): THREE.Vector3 {
  const sum = new THREE.Vector3();
  for (const p of points) sum.add(p);
  return sum.divideScalar(points.length);
}

/** Signed volume of the tetrahedron formed by a face's 3 corners plus a
 * fixed reference point (here, the mesh's own centroid) - i.e. the scalar
 * triple product (a-ref)x(b-ref).(c-ref). */
function signedTetraVolume(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ref: THREE.Vector3): number {
  const ea = a.clone().sub(ref);
  const eb = b.clone().sub(ref);
  const ec = c.clone().sub(ref);
  return ea.dot(eb.clone().cross(ec));
}

function flattenVec3(points: THREE.Vector3[]): number[] {
  const out: number[] = [];
  for (const p of points) out.push(p.x, p.y, p.z);
  return out;
}

const AMBIGUITY_EPSILON = 1e-3; // relative difference below which two faces' volume signatures are considered "too close to tell apart"

/** Flags whether any two faces in `sortedAbsVolumes` (ascending) are close
 * enough to each other, relative to their own magnitude, that rank-based
 * matching can't reliably tell them apart. */
function hasAmbiguousNeighbors(sortedAbsVolumes: number[]): boolean {
  for (let i = 1; i < sortedAbsVolumes.length; i++) {
    const a = sortedAbsVolumes[i - 1];
    const b = sortedAbsVolumes[i];
    if (Math.abs(a - b) < AMBIGUITY_EPSILON * Math.max(a, b, 1e-9)) return true;
  }
  return false;
}

/** Matches faces between landmarkSource and landmarkOutput WITHOUT relying
 * on file order or vertex indices, since face order isn't guaranteed to be
 * preserved between the two exports (see this module's callers).
 *
 * The trick: both files describe the same mesh put through the same single
 * affine transform (uniform for the whole mesh, whatever it turns out to
 * be - similarity, anisotropic scale, shear...). For any invertible 3x3
 * linear map L, the VOLUME of a tetrahedron scales by the same constant
 * factor |det(L)| regardless of the tetrahedron's shape or orientation -
 * unlike a face's plain area, whose scale factor under L also depends on
 * which way the face happens to be facing (relevant here because the true
 * transform can be anisotropic/shear, not just similarity, per
 * calculator.ts's own analyzeTransformMatrix()). So: pin a tetrahedron to
 * each face by pairing it with a transform-consistent reference point (the
 * mesh's own centroid, itself affine-equivariant), take the ABSOLUTE
 * volume of each, and rank faces by it in each mesh separately - ranks
 * should line up 1:1 between source and output as long as no two faces
 * happen to have near-identical volumes (see hasAmbiguousNeighbors()).
 *
 * The mesh centroid used as that reference point is computed as the mean
 * of FACE centroids (one point per face) rather than the mean of raw
 * vertex positions - so both meshes weight it identically despite
 * landmarkSource's vertices being unevenly shared across faces while
 * landmarkOutput's aren't (see this module's other doc comments). */
function matchLandmarkFaces(
  sourceObj: ParsedOBJ,
  outputObj: ParsedOBJ,
): { matchedFaces: Array<{ sourceCorners: THREE.Vector3[]; outputCorners: THREE.Vector3[] }>; ambiguous: boolean } {
  if (sourceObj.faces.length !== outputObj.faces.length) {
    throw new Error(
      `matchLandmarkFaces: face count mismatch (source has ${sourceObj.faces.length}, output has ${outputObj.faces.length}) - these can't be the same landmark object`,
    );
  }
  if (sourceObj.faces.length === 0) {
    throw new Error("matchLandmarkFaces: landmark object has no faces");
  }

  const sourceFaceCorners = sourceObj.faces.map((face) => faceCorners(sourceObj, face));
  const outputFaceCorners = outputObj.faces.map((face) => faceCorners(outputObj, face));

  const sourceFaceCentroids = sourceFaceCorners.map(centroidOf);
  const outputFaceCentroids = outputFaceCorners.map(centroidOf);

  const sourceMeshCentroid = centroidOf(sourceFaceCentroids);
  const outputMeshCentroid = centroidOf(outputFaceCentroids);

  const sourceVolumes = sourceFaceCorners.map((c) =>
    Math.abs(signedTetraVolume(c[0], c[1], c[2], sourceMeshCentroid)),
  );
  const outputVolumes = outputFaceCorners.map((c) =>
    Math.abs(signedTetraVolume(c[0], c[1], c[2], outputMeshCentroid)),
  );

  const sourceOrder = sourceVolumes.map((_, i) => i).sort((a, b) => sourceVolumes[a] - sourceVolumes[b]);
  const outputOrder = outputVolumes.map((_, i) => i).sort((a, b) => outputVolumes[a] - outputVolumes[b]);

  const ambiguous =
    hasAmbiguousNeighbors(sourceOrder.map((i) => sourceVolumes[i])) ||
    hasAmbiguousNeighbors(outputOrder.map((i) => outputVolumes[i]));

  const matchedFaces = sourceOrder.map((sourceFaceIndex, rank) => ({
    sourceCorners: sourceFaceCorners[sourceFaceIndex],
    outputCorners: outputFaceCorners[outputOrder[rank]],
  }));

  return { matchedFaces, ambiguous };
}

/** All 6 ways to assign 3 output corners to 3 source corners: 3 cyclic
 * rotations x 2 windings (the face's corner LIST can start at any of its 3
 * corners and be wound either direction between the two exports). */
const CORNER_PERMUTATIONS: [number, number, number][] = [
  [0, 1, 2], [1, 2, 0], [2, 0, 1], // winding as-is
  [0, 2, 1], [2, 1, 0], [1, 0, 2], // reversed winding
];

/** Within one already face-matched pair, figures out which of the 3
 * output corners each source corner actually corresponds to (matched
 * faces are matched as unordered corner SETS - matchLandmarkFaces() above
 * says nothing about corner order or winding). Resolved by transforming
 * the source corners through an approximate source->output transform
 * (see bootstrapTransform()) and picking whichever of the 6 possible
 * corner assignments lands closest to the actual output corners. */
function resolveCornerOrder(
  sourceCorners: THREE.Vector3[],
  outputCorners: THREE.Vector3[],
  approxSourceToOutput: THREE.Matrix4,
): THREE.Vector3[] {
  const transformedSource = sourceCorners.map((v) => v.clone().applyMatrix4(approxSourceToOutput));

  let bestPermutation = CORNER_PERMUTATIONS[0];
  let bestError = Infinity;
  for (const permutation of CORNER_PERMUTATIONS) {
    let error = 0;
    for (let i = 0; i < 3; i++) {
      error += transformedSource[i].distanceToSquared(outputCorners[permutation[i]]);
    }
    if (error < bestError) {
      bestError = error;
      bestPermutation = permutation;
    }
  }

  return bestPermutation.map((i) => outputCorners[i]);
}

/** Rough source->output transform fit from face CENTROIDS alone (one point
 * per matched face, correspondence already resolved by matchLandmarkFaces
 * - centroids need no corner-order resolution since a face's centroid
 * doesn't depend on which corner is "first"). Only accurate enough to
 * disambiguate corner order (resolveCornerOrder() above); the real result
 * is the corner-level fit computed afterwards from every corner, not this. */
function bootstrapTransform(
  matchedFaces: Array<{ sourceCorners: THREE.Vector3[]; outputCorners: THREE.Vector3[] }>,
): THREE.Matrix4 {
  const sourceCentroids = matchedFaces.map((f) => centroidOf(f.sourceCorners));
  const outputCentroids = matchedFaces.map((f) => centroidOf(f.outputCorners));

  const { nonPosedToPosed } = calculateDistortionMatrix({
    geometryData: { positions: flattenVec3(outputCentroids) }, // "posed" slot = output
    previewGeometryData: { positions: flattenVec3(sourceCentroids) }, // "non-posed" slot = source
  });

  return nonPosedToPosed; // source -> output
}

/** Builds a correct, per-corner vertex correspondence between
 * landmarkSource and landmarkOutput despite landmarkSource sharing
 * vertices between neighbouring faces (so its raw vertex count is lower
 * than landmarkOutput's, which has an unshared vertex per face corner) and
 * despite face order not being guaranteed to match between the two files.
 * See matchLandmarkFaces()/resolveCornerOrder() for how each part is
 * solved. The returned arrays are ready to hand straight to
 * calculateDistortionMatrix() (see calculateLandmarkTransform() below). */
export function matchLandmarkCorrespondence(
  sourceObj: ParsedOBJ,
  outputObj: ParsedOBJ,
): LandmarkCorrespondence {
  const { matchedFaces, ambiguous } = matchLandmarkFaces(sourceObj, outputObj);
  const approxTransform = bootstrapTransform(matchedFaces);

  const sourcePositions: number[] = [];
  const outputPositions: number[] = [];

  for (const face of matchedFaces) {
    const orderedOutputCorners = resolveCornerOrder(face.sourceCorners, face.outputCorners, approxTransform);
    for (let i = 0; i < 3; i++) {
      sourcePositions.push(face.sourceCorners[i].x, face.sourceCorners[i].y, face.sourceCorners[i].z);
      outputPositions.push(orderedOutputCorners[i].x, orderedOutputCorners[i].y, orderedOutputCorners[i].z);
    }
  }

  return { sourcePositions, outputPositions, ambiguousMatch: ambiguous };
}

/** Entry point: computes the matrix that maps landmarkSource onto
 * landmarkOutput (plus the rest of calculateDistortionMatrix()'s result -
 * the inverse, the in-place shape-only correction, etc.), handling the
 * vertex-count and face-order mismatches between the two Intel GPA export
 * files. `result.nonPosedToPosed` is specifically the requested
 * source->output matrix (landmarkSource is passed as the "non-posed" side,
 * landmarkOutput as "posed" - see calculateDistortionMatrix()'s own
 * parameter naming in calculator.ts). */
export function calculateLandmarkTransform(
  sourceObj: ParsedOBJ,
  outputObj: ParsedOBJ,
  options: AffineDistortionOptions = {},
): AffineDistortionResult & { ambiguousMatch: boolean } {
  const { sourcePositions, outputPositions, ambiguousMatch } = matchLandmarkCorrespondence(sourceObj, outputObj);

  const result = calculateDistortionMatrix(
    {
      geometryData: { positions: outputPositions }, // "posed" slot = output
      previewGeometryData: { positions: sourcePositions }, // "non-posed" slot = source
    },
    options,
  );

  if (ambiguousMatch) {
    console.warn(
      "[landmark-matching] two or more faces had near-identical volume signatures - face correspondence (and " +
        "therefore the fitted transform) may be wrong for some faces. Double-check the landmark object has " +
        "visibly different-sized faces if this matters for your capture.",
    );
  }

  return { ...result, ambiguousMatch };
}
