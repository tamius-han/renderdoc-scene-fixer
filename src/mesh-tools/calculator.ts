import * as THREE from "three";

/** Converts a flat, non-indexed GeometryArrays (positions as
 * [x0,y0,z0,x1,y1,z1,...]) into per-vertex THREE.Vector3s. */
function toVector3Array(geometryData: { positions: number[] }): THREE.Vector3[] {
  const vertices: THREE.Vector3[] = [];
  const positions = geometryData.positions;
  for (let i = 0; i < positions.length; i += 3) {
    vertices.push(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
  }
  return vertices;
}

/** How to resolve the left/right handedness (chirality) of the corrected
 * output:
 * - "auto" (default): keep posed geometry's own handedness. The shape-only
 *   correction (see posedToNonPosedInPlace) never introduces a reflection
 *   on its own - see analyzeTransformMatrix's doc comment - so this is a
 *   no-op in practice, not an active "fix".
 * - "left" / "right": force that chirality, flipping Z if it differs from
 *   world space's own convention. World space - and therefore posed
 *   geometry, since it's expressed directly in that space - is always
 *   right-handed in this viewer, because that's three.js/WebGL's fixed
 *   rendering convention, not something that varies per scene. So "right"
 *   is always a no-op here and "left" always flips. */
export type HandednessMode = "auto" | "left" | "right";

export interface AffineDistortionOptions {
  handedness?: HandednessMode;
}

export interface DistortionResult {
  /** Per-axis scale factors needed to stretch the (rotated) non-posed mesh
   * to match the posed mesh's size. The posed mesh's Y (vertical) axis is
   * assumed accurate, so scale.y is always normalized to 1. */
  scale: THREE.Vector3;
  /** Rotation that orients the non-posed (initial) mesh to match the posed
   * mesh's orientation. */
  nonPosedToPosedRotation: THREE.Quaternion;
  /** Inverse of nonPosedToPosedRotation - orients the posed mesh to match
   * the non-posed mesh's orientation. */
  posedToNonPosedRotation: THREE.Quaternion;
}

/** Entry point for the scale-reference recalculation flow: takes the
 * object marked as the scale reference in the object list, extracts its
 * posed and initial (bind-pose) geometry, and runs the Kabsch-based
 * transform analysis to determine the distortion scale/rotation factors. */
export function calculateDistortion(scaleReferenceObject: {
  geometryData: { positions: number[] };
  previewGeometryData: { positions: number[] };
}): DistortionResult {
  const posedVertices = toVector3Array(scaleReferenceObject.geometryData);
  const nonPosedVertices = toVector3Array(scaleReferenceObject.previewGeometryData);

  return analyzeTransform(nonPosedVertices, posedVertices);
}

function computeCentroid(vertices: THREE.Vector3[]): THREE.Vector3 {
  const sum = new THREE.Vector3();
  for (const v of vertices) sum.add(v);
  return sum.divideScalar(vertices.length);
}

/** Kabsch algorithm: finds the rotation that best aligns nonPosedVertices
 * onto posedVertices (vertex-for-vertex correspondence assumed, since both
 * are just different poses of the same mesh), then measures the remaining
 * per-axis size difference as the distortion scale. The posed mesh's
 * vertical (Y) axis is assumed accurate, so the returned scale is
 * normalized relative to it - only X/Z carry real distortion. */
function analyzeTransform(nonPosedVertices: THREE.Vector3[], posedVertices: THREE.Vector3[]): DistortionResult {
  if (nonPosedVertices.length === 0 || posedVertices.length === 0) {
    throw new Error("calculateDistortion: empty geometry input");
  }

  const nonPosedCentroid = computeCentroid(nonPosedVertices);
  const posedCentroid = computeCentroid(posedVertices);

  const nonPosedCentered = nonPosedVertices.map((v) => v.clone().sub(nonPosedCentroid));
  const posedCentered = posedVertices.map((v) => v.clone().sub(posedCentroid));

  const covariance = computeCovariance(nonPosedCentered, posedCentered);
  const rotation = solveOptimalRotation(covariance);

  const rotatedNonPosed = nonPosedCentered.map((v) => v.clone().applyMatrix3(rotation).add(posedCentroid));

  const rotatedNonPosedSize = new THREE.Box3().setFromPoints(rotatedNonPosed).getSize(new THREE.Vector3());
  const posedSize = new THREE.Box3().setFromPoints(posedVertices).getSize(new THREE.Vector3());

  const rawScale = rotatedNonPosedSize.divide(posedSize);
  const scale = rawScale.clone().divideScalar(rawScale.y);

  const nonPosedToPosedRotation = matrix3ToQuaternion(rotation);
  const posedToNonPosedRotation = nonPosedToPosedRotation.clone().invert();

  console.log('mesh results:', { scale, nonPosedToPosedRotation, posedToNonPosedRotation });

  return { scale, nonPosedToPosedRotation, posedToNonPosedRotation };
}

/** Sum of outer products between two equal-length, centroid-centered point
 * sets - the cross-covariance matrix H used by the Kabsch algorithm below. */
function computeCovariance(a: THREE.Vector3[], b: THREE.Vector3[]): THREE.Matrix3 {
  const n = Math.min(a.length, b.length);
  let m00 = 0, m01 = 0, m02 = 0;
  let m10 = 0, m11 = 0, m12 = 0;
  let m20 = 0, m21 = 0, m22 = 0;
  for (let i = 0; i < n; i++) {
    const va = a[i];
    const vb = b[i];
    m00 += va.x * vb.x; m01 += va.x * vb.y; m02 += va.x * vb.z;
    m10 += va.y * vb.x; m11 += va.y * vb.y; m12 += va.y * vb.z;
    m20 += va.z * vb.x; m21 += va.z * vb.y; m22 += va.z * vb.z;
  }
  return new THREE.Matrix3().set(m00, m01, m02, m10, m11, m12, m20, m21, m22);
}

/** Kabsch's solution for the optimal rotation given covariance H = A^T*B:
 * R = V * U^T, where U/V come from H's SVD. Three.js has no SVD or
 * eigendecomposition, so that part stays a hand-rolled Jacobi eigensolver
 * (see eigenSymmetric3x3 below); everything else (transpose/multiply/
 * determinant/point transforms) uses THREE.Matrix3 / THREE.Vector3. */
function solveOptimalRotation(covariance: THREE.Matrix3): THREE.Matrix3 {
  const covarianceSquared = covariance.clone().transpose().multiply(covariance);
  const { vectors, values } = eigenSymmetric3x3(matrix3ToRows(covarianceSquared));
  const singularValues = values.map((v) => Math.sqrt(Math.max(v, 0)));

  let vMatrix = rowsToMatrix3(vectors);

  // U's columns are H * V's columns, normalized by the singular values.
  const uColumns: THREE.Vector3[] = [];
  for (let col = 0; col < 3; col++) {
    const vColumn = new THREE.Vector3().setFromMatrix3Column(vMatrix, col);
    const inverseSingularValue = singularValues[col] !== 0 ? 1 / singularValues[col] : 0;
    uColumns.push(vColumn.applyMatrix3(covariance).multiplyScalar(inverseSingularValue));
  }
  const uMatrix = columnsToMatrix3(uColumns);

  let rotation = vMatrix.clone().multiply(uMatrix.clone().transpose());

  if (rotation.determinant() < 0) {
    // Flip the smallest singular vector to avoid a reflection.
    vectors[2][0] *= -1;
    vectors[2][1] *= -1;
    vectors[2][2] *= -1;
    vMatrix = rowsToMatrix3(vectors);
    rotation = vMatrix.clone().multiply(uMatrix.clone().transpose());
  }

  return rotation;
}

function matrix3ToRows(m: THREE.Matrix3): number[][] {
  const e = m.elements; // column-major: [n11,n21,n31, n12,n22,n32, n13,n23,n33]
  return [
    [e[0], e[3], e[6]],
    [e[1], e[4], e[7]],
    [e[2], e[5], e[8]],
  ];
}

function rowsToMatrix3(rows: number[][]): THREE.Matrix3 {
  return new THREE.Matrix3().set(
    rows[0][0], rows[0][1], rows[0][2],
    rows[1][0], rows[1][1], rows[1][2],
    rows[2][0], rows[2][1], rows[2][2],
  );
}

function columnsToMatrix3(columns: THREE.Vector3[]): THREE.Matrix3 {
  return new THREE.Matrix3().set(
    columns[0].x, columns[1].x, columns[2].x,
    columns[0].y, columns[1].y, columns[2].y,
    columns[0].z, columns[1].z, columns[2].z,
  );
}

function matrix3ToQuaternion(m: THREE.Matrix3): THREE.Quaternion {
  const xAxis = new THREE.Vector3().setFromMatrix3Column(m, 0);
  const yAxis = new THREE.Vector3().setFromMatrix3Column(m, 1);
  const zAxis = new THREE.Vector3().setFromMatrix3Column(m, 2);
  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

// ============ Matrix-based distortion (replaces bounding-box scale) ======
// analyzeTransform() above only recovers a rotation (via Kabsch) plus a
// single per-axis scale derived from comparing bounding-box sizes AFTER
// that rotation. That scale is only correct if the true posed/non-posed
// difference happens to be a plain axis-aligned stretch once the rotation
// is undone - it can't represent shear, and it's sensitive to outlier
// vertices skewing the box. Since posed/non-posed vertices are already in
// 1:1 correspondence (same mesh, same vertex order, two different poses),
// we can instead fit the actual best 3x3 linear map directly from that
// correspondence via ordinary least squares (multivariate linear
// regression) - this captures anisotropic scale, shear, and rotation
// together in whatever combination actually explains the distortion,
// rather than assuming it lines up with the bounding box's own axes. It
// also needs no eigendecomposition/SVD: forming the two covariance
// matrices below and inverting one of them (a plain closed-form 3x3
// inverse - see THREE.Matrix3.invert()) is enough.

export interface AffineDistortionResult {
  /** Full affine transform (3x3 linear map + translation) that maps a POSED
   * vertex position directly to its corresponding NON-POSED (bind-pose)
   * position. Apply this to raw, uncentered posed vertex coordinates - e.g.
   * via THREE.Vector3.applyMatrix4() per-vertex, or BufferGeometry's
   * applyMatrix4() to bake it into the whole mesh - to "unpose" the posed
   * geometry back to its bind-pose shape. NOTE: this also relocates the
   * mesh's centroid to wherever the non-posed geometry's centroid is - if
   * posed and non-posed geometry live in different coordinate spaces (e.g.
   * posed = world space, non-posed/preview = local/bind-pose space, which
   * is the common case for RenderDoc-exported scenes), that collapses
   * every object toward the non-posed centroid's location instead of
   * correcting each object in place. For that, use
   * posedToNonPosedInPlace instead. */
  posedToNonPosed: THREE.Matrix4;
  /** Inverse of posedToNonPosed - maps a NON-POSED vertex to (approximately)
   * the posed mesh's distorted shape. Same relocation caveat as
   * posedToNonPosed applies in reverse. */
  nonPosedToPosed: THREE.Matrix4;
  /** Shape-only correction: fixes anisotropic squish/shear in the POSED
   * geometry, pivoted about the posed geometry's OWN centroid - so the
   * object's world-space position is preserved (contrast posedToNonPosed,
   * which also relocates it). This intentionally does NOT rotate the
   * result to match non-posed source geometry's orientation either (see
   * analyzeTransformMatrix's doc comment for why) - it leaves the object's
   * current orientation untouched, which is what you want when posed
   * geometry is already expressed in world space and world space's own up
   * axis has already been made vertical elsewhere (see detectWorldUpAxis()
   * in app.ts). This is what recalculateTransformCorrection() applies. */
  posedToNonPosedInPlace: THREE.Matrix4;
  /** Whether the raw vertex correspondence indicated posed and non-posed
   * geometry differ in handedness/chirality. Informational: with the
   * default "auto" handedness option, posedToNonPosedInPlace never
   * introduces a reflection regardless of this flag (see its doc comment),
   * so this only matters if you're using the "left"/"right" handedness
   * override, or investigating why a fit looks off. */
  handednessMismatchDetected: boolean;
  /** Centroid of the POSED vertex set, in the same space as the input
   * positions - exposed so callers can pivot additional corrections (e.g.
   * an up-axis realignment) about the same point posedToNonPosedInPlace
   * uses, instead of recomputing it. */
  posedCentroid: THREE.Vector3;
}

/** Entry point mirroring calculateDistortion() above, but returning a full
 * transformation matrix instead of separate scale/rotation factors. */
export function calculateDistortionMatrix(
  scaleReferenceObject: {
    geometryData: { positions: number[] };
    previewGeometryData: { positions: number[] };
  },
  options: AffineDistortionOptions = {},
): AffineDistortionResult {
  const posedVertices = toVector3Array(scaleReferenceObject.geometryData);
  const nonPosedVertices = toVector3Array(scaleReferenceObject.previewGeometryData);

  return analyzeTransformMatrix(nonPosedVertices, posedVertices, options);
}

/** Fits the 3x3 linear map L (plus translation) that best explains
 * posed_i ~= L * nonPosed_i + t for every corresponding vertex pair, via
 * ordinary least squares - the standard multivariate linear regression
 * solution L = Cov(posed, nonPosed) * Cov(nonPosed, nonPosed)^-1, computed
 * about each side's own centroid to isolate the translation (t) from the
 * linear part (L). Unlike Kabsch, L is not constrained to be orthogonal, so
 * it can represent shear and anisotropic scale directly instead of only
 * rotation + a separate, cruder axis-scale estimate.
 *
 * For posedToNonPosedInPlace, L gets split further via polar decomposition
 * (L = R * S, R a rotation, S a symmetric stretch/shear) and only S is
 * used. Two reasons: (1) R aligns posed's orientation to non-posed SOURCE
 * geometry's own local-space axes, which is often an arbitrary convention
 * with no relation to world space's up direction - baking it in would
 * reorient every corrected object to match whatever the source mesh's
 * local axes happen to be, not to look "upright" in the scene. (2) S, built
 * from SVD singular values (always >= 0), can never itself contain a
 * reflection - so using it alone sidesteps the handedness/chirality
 * question entirely for the default path: no rotation is applied at all,
 * so posed geometry's own chirality is trivially preserved. See
 * HandednessMode for the override that deliberately introduces a flip.
 */
function analyzeTransformMatrix(
  nonPosedVertices: THREE.Vector3[],
  posedVertices: THREE.Vector3[],
  options: AffineDistortionOptions = {},
): AffineDistortionResult {
  if (nonPosedVertices.length === 0 || posedVertices.length === 0) {
    throw new Error("calculateDistortionMatrix: empty geometry input");
  }
  if (nonPosedVertices.length !== posedVertices.length) {
    // The fit assumes vertex i of one array corresponds to vertex i of the
    // other (same mesh, same vertex order, different pose) - a mismatched
    // count means that assumption doesn't hold and the fit would silently
    // pair up unrelated vertices for the shorter array's length.
    throw new Error(
      "calculateDistortionMatrix: posed and non-posed vertex counts must match (vertex correspondence is assumed)",
    );
  }

  const handedness: HandednessMode = options.handedness ?? "auto";

  const nonPosedCentroid = computeCentroid(nonPosedVertices);
  const posedCentroid = computeCentroid(posedVertices);

  const nonPosedCentered = nonPosedVertices.map((v) => v.clone().sub(nonPosedCentroid));
  const posedCentered = posedVertices.map((v) => v.clone().sub(posedCentroid));

  // computeCovariance(a, b)[r][c] = sum_i a_i[r] * b_i[c], i.e. A^T * B for
  // A/B with rows a_i/b_i - see its doc comment above. The least-squares
  // linear map minimizing sum_i || posed_i - L * nonPosed_i ||^2 is
  // L = (Posed^T NonPosed) * (NonPosed^T NonPosed)^-1.
  const nonPosedNonPosedCov = computeCovariance(nonPosedCentered, nonPosedCentered);
  const posedNonPosedCov = computeCovariance(posedCentered, nonPosedCentered);

  const nonPosedNonPosedCovInv = nonPosedNonPosedCov.clone().invert();
  if (isZeroMatrix3(nonPosedNonPosedCovInv)) {
    // THREE.Matrix3.invert() silently zeroes out a singular matrix rather
    // than throwing - this happens if the non-posed vertices are coplanar,
    // collinear, or coincident, which leaves no unique 3x3 map to solve for.
    throw new Error(
      "calculateDistortionMatrix: non-posed geometry is degenerate (coplanar/collinear/coincident vertices) - can't fit a unique 3x3 transform",
    );
  }

  const nonPosedToPosedLinear = posedNonPosedCov.clone().multiply(nonPosedNonPosedCovInv);
  const posedToNonPosedLinear = nonPosedToPosedLinear.clone().invert();
  if (isZeroMatrix3(posedToNonPosedLinear)) {
    throw new Error(
      "calculateDistortionMatrix: fitted transform is singular (posed geometry collapses onto a plane/line) and can't be inverted",
    );
  }

  const nonPosedToPosed = affineFromLinearAndTranslation(nonPosedToPosedLinear, nonPosedCentroid, posedCentroid);
  const posedToNonPosed = affineFromLinearAndTranslation(posedToNonPosedLinear, posedCentroid, nonPosedCentroid);

  // Polar-decompose the posed-facing linear map so we can drop its rotation
  // and keep only the symmetric stretch/shear - see this function's doc
  // comment for why. u/v/singularValues come from an SVD of
  // posedToNonPosedLinear (posedToNonPosedLinear = U * Sigma * V^T);
  // R = U*V^T is the rotation part, S = V*Sigma*V^T is the stretch part.
  const { u, singularValues, v } = svd3x3(posedToNonPosedLinear);
  const naiveRotation = u.clone().multiply(v.clone().transpose());
  const handednessMismatchDetected = naiveRotation.determinant() < 0;

  let stretch = buildDiagonalConjugate(v, singularValues);

  // World space (and posed geometry, expressed directly in it) is always
  // right-handed here - see HandednessMode's doc comment - so only "left"
  // needs an active flip; "right" and "auto" both leave `stretch` as-is.
  // Negating stretch's Z column/row is the conventional right<->left
  // handed conversion axis (mirrors, e.g., the common DirectX/Unity(LH)
  // <-> OpenGL/three.js(RH) Z-negation convention) - picked for
  // predictability since this is a deliberate, caller-requested flip
  // rather than a data-driven guess like handednessMismatchDetected above.
  if (handedness === "left") {
    stretch = negateMatrix3RowAndColumn(stretch, 2);
  }

  const posedToNonPosedInPlace = affineFromLinearAndTranslation(stretch, posedCentroid, posedCentroid);

  console.log("mesh matrix results:", {
    posedToNonPosed,
    nonPosedToPosed,
    posedToNonPosedInPlace,
    handednessMismatchDetected,
  });

  return {
    posedToNonPosed,
    nonPosedToPosed,
    posedToNonPosedInPlace,
    handednessMismatchDetected,
    posedCentroid,
  };
}

/** Generic SVD of a 3x3 matrix: m = u * diag(singularValues) * v^T. Same
 * construction solveOptimalRotation() above uses for Kabsch (eigendecompose
 * m^T*m to get v and the singular values, then u = m*v*Sigma^-1 per
 * column), generalized here to an arbitrary 3x3 matrix rather than a
 * square cross-covariance. */
function svd3x3(m: THREE.Matrix3): { u: THREE.Matrix3; singularValues: number[]; v: THREE.Matrix3 } {
  const mtm = m.clone().transpose().multiply(m);
  const { vectors, values } = eigenSymmetric3x3(matrix3ToRows(mtm));
  const singularValues = values.map((value) => Math.sqrt(Math.max(value, 0)));
  const v = rowsToMatrix3(vectors);

  const uColumns: THREE.Vector3[] = [];
  for (let col = 0; col < 3; col++) {
    const vColumn = new THREE.Vector3().setFromMatrix3Column(v, col);
    const inverseSingularValue = singularValues[col] !== 0 ? 1 / singularValues[col] : 0;
    uColumns.push(vColumn.applyMatrix3(m).multiplyScalar(inverseSingularValue));
  }
  const u = columnsToMatrix3(uColumns);
  return { u, singularValues, v };
}

/** Builds V * diag(values) * V^T - used both for the stretch tensor S in
 * polarDecompose-style splitting above (values = singular values, always
 * >= 0) and would equally work for a general symmetric reconstruction. */
function buildDiagonalConjugate(v: THREE.Matrix3, values: number[]): THREE.Matrix3 {
  const sigma = new THREE.Matrix3().set(values[0], 0, 0, 0, values[1], 0, 0, 0, values[2]);
  return v.clone().multiply(sigma).multiply(v.clone().transpose());
}

/** Negates row AND column `index` of a matrix - the standard way to flip
 * one axis of chirality/handedness for a matrix built as V*diag*V^T
 * (negating only the row or only the column would break its symmetry). */
function negateMatrix3RowAndColumn(m: THREE.Matrix3, index: number): THREE.Matrix3 {
  const rows = matrix3ToRows(m);
  for (let c = 0; c < 3; c++) rows[index][c] *= -1;
  for (let r = 0; r < 3; r++) rows[r][index] *= -1;
  return rowsToMatrix3(rows);
}

/** Builds the 4x4 affine matrix implementing
 * `to = linear * (from - fromCentroid) + toCentroid`
 * - i.e. the linear map applied about fromCentroid's origin, then
 * translated so that fromCentroid lands on toCentroid. Passing the same
 * centroid for both `fromCentroid` and `toCentroid` pivots the linear map
 * about that point without any net translation. */
function affineFromLinearAndTranslation(
  linear: THREE.Matrix3,
  fromCentroid: THREE.Vector3,
  toCentroid: THREE.Vector3,
): THREE.Matrix4 {
  const linear4 = matrix3ToMatrix4(linear);
  const pre = new THREE.Matrix4().makeTranslation(-fromCentroid.x, -fromCentroid.y, -fromCentroid.z);
  const post = new THREE.Matrix4().makeTranslation(toCentroid.x, toCentroid.y, toCentroid.z);
  // Composition order matters: pre is applied to the input vector first,
  // then linear4, then post - matrix multiplication applies right-to-left.
  return post.multiply(linear4).multiply(pre);
}

/** Embeds a 3x3 linear map as the upper-left block of a 4x4 matrix with no
 * translation, by reusing each column as-is (unlike matrix3ToQuaternion's
 * use of makeBasis elsewhere in this file, the columns here are NOT
 * assumed to be orthonormal - makeBasis itself doesn't require that, it
 * just places the three vectors as columns). */
function matrix3ToMatrix4(m: THREE.Matrix3): THREE.Matrix4 {
  const xAxis = new THREE.Vector3().setFromMatrix3Column(m, 0);
  const yAxis = new THREE.Vector3().setFromMatrix3Column(m, 1);
  const zAxis = new THREE.Vector3().setFromMatrix3Column(m, 2);
  return new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
}

function isZeroMatrix3(m: THREE.Matrix3): boolean {
  return m.elements.every((v) => v === 0);
}

// ============ Eigen decomposition for symmetric 3x3 matrices =============
// Jacobi iteration - sufficient for small 3x3 numeric stability. Three.js
// has no eigendecomposition/SVD utility, so this stays hand-rolled.
function eigenSymmetric3x3(a: number[][]): { values: number[]; vectors: number[][] } {
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const d = [
    [a[0][0], a[0][1], a[0][2]],
    [a[1][0], a[1][1], a[1][2]],
    [a[2][0], a[2][1], a[2][2]],
  ];

  for (let iter = 0; iter < 50; iter++) {
    // Find the largest off-diagonal element.
    let p = 0, q = 1, max = Math.abs(d[0][1]);
    if (Math.abs(d[0][2]) > max) { p = 0; q = 2; max = Math.abs(d[0][2]); }
    if (Math.abs(d[1][2]) > max) { p = 1; q = 2; max = Math.abs(d[1][2]); }
    if (max < 1e-10) break;

    const diff = d[q][q] - d[p][p];
    const phi = 0.5 * Math.atan2(2 * d[p][q], diff);
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    const rowP = d[p].slice();
    const rowQ = d[q].slice();
    for (let i = 0; i < 3; i++) {
      d[p][i] = c * rowP[i] - s * rowQ[i];
      d[q][i] = s * rowP[i] + c * rowQ[i];
    }
    for (let i = 0; i < 3; i++) {
      const dip = d[i][p], diq = d[i][q];
      d[i][p] = c * dip - s * diq;
      d[i][q] = s * dip + c * diq;
    }
    for (let i = 0; i < 3; i++) {
      const vip = v[i][p], viq = v[i][q];
      v[i][p] = c * vip - s * viq;
      v[i][q] = s * vip + c * viq;
    }
  }

  const values = [d[0][0], d[1][1], d[2][2]];
  const order = [0, 1, 2].sort((x, y) => values[y] - values[x]);
  const sortedValues = order.map((i) => values[i]);
  // Columns of the returned matrix are the eigenvectors, sorted to match
  // sortedValues (descending eigenvalue order).
  const sortedVectors = order.map((i) => [v[0][i], v[1][i], v[2][i]]);
  const vectors = [
    [sortedVectors[0][0], sortedVectors[1][0], sortedVectors[2][0]],
    [sortedVectors[0][1], sortedVectors[1][1], sortedVectors[2][1]],
    [sortedVectors[0][2], sortedVectors[1][2], sortedVectors[2][2]],
  ];

  return { values: sortedValues, vectors };
}
