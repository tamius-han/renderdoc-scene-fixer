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

// Handedness/chirality mismatches between posed and non-posed geometry are
// now detected and corrected automatically and unconditionally, inline in
// analyzeTransformMatrix() below - there's no longer a caller-facing option
// for it (the old "auto"/"left"/"right" override is gone; posed geometry's
// own genuine chirality, whatever it is, is what gets detected and fixed).

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
   * in app.ts). This is what recalculateTransformCorrection() applies.
   *
   * CAN be a reflection (negative determinant) when
   * handednessMismatchDetected is true - see that field's doc comment.
   * Callers that bake this into actual vertex data must also flip
   * triangle winding when that happens, or the mesh renders inside-out -
   * see app.ts's applyMatrixToDraw(). */
  posedToNonPosedInPlace: THREE.Matrix4;
  /** Whether the raw vertex correspondence indicated posed and non-posed
   * geometry genuinely differ in handedness/chirality - and, when true,
   * posedToNonPosedInPlace (and posedToNonPosedOrientedInPlace) DOES
   * introduce a reflection to correct it (see analyzeTransformMatrix's
   * doc comment for how). distortionOrientation never does, regardless -
   * a THREE.Quaternion can't represent a reflection at all, so any
   * mismatch always ends up on the shape-correction side, not the
   * whole-scene rotation. */
  handednessMismatchDetected: boolean;
  /** Centroid of the POSED vertex set, in the same space as the input
   * positions - exposed so callers can pivot additional corrections (e.g.
   * an up-axis realignment) about the same point posedToNonPosedInPlace
   * uses, instead of recomputing it. */
  posedCentroid: THREE.Vector3;
  /** Like posedToNonPosedInPlace, but keeping the fit's rotation as well as
   * its stretch (R*S instead of just S), still pivoted about posedCentroid
   * with no net translation. R itself is always proper here (never a
   * reflection) - not because a genuine mismatch gets discarded, but
   * because it's fit AFTER the shape correction already resolved one (see
   * analyzeTransformMatrix's doc comment) - so by the time R is fit,
   * posed and non-posed genuinely share the same chirality and the best
   * rigid alignment between them is a real, proper rotation.
   *
   * NOT used by app.ts's default pipeline (applyDistortionToScene()) -
   * baking R into each object's OWN vertices individually rotates every
   * object to match ITS OWN bind pose's local forward/right convention,
   * which is generally unrelated to how that object was actually placed
   * in the world (most placed objects share the scene's up direction, not
   * a global forward/right - a chair can face any direction and still be
   * "upright"). That mismatch is what previously made corrected scenes
   * come out visibly tilted. app.ts now applies rotation ONCE, for the
   * whole scene, from distortionOrientation below (the same R, but as a
   * standalone quaternion) instead - kept here mainly for completeness /
   * lower-level callers that genuinely do want one object's full posed-
   * to-non-posed map, R and S combined. */
  posedToNonPosedOrientedInPlace: THREE.Matrix4;
  /** The fitted rotation ALONE - no stretch/shear, no translation - the
   * exact same rotation baked into posedToNonPosedOrientedInPlace above
   * (see that field's doc comment for what it represents: posed's raw
   * orientation -> non-posed geometry's own up/forward/right convention,
   * meaningful specifically because loadDraw() already remaps non-posed
   * geometry into the app's fixed convention via remapObjOrientation()
   * before fitting). Exposed as its own standalone quaternion, rather
   * than only reachable by pulling it back out of ...OrientedInPlace's
   * 4x4, so a caller can apply it as ONE WHOLE-SCENE rotation (see
   * app.ts's applyDistortionToScene(), which sets this.sceneRotation from
   * it after every distortion fix) instead of baking it into each
   * object's own vertices individually. Baking a per-object rotation like
   * that previously caused the reconstructed scene to come out visibly
   * tilted: an object placed with some arbitrary yaw in the world (most
   * furniture, most placed props) does NOT actually share its own bind-
   * pose mesh's local forward/right convention, only (usually) its up
   * direction - fitting and applying a FULL per-object rotation from
   * posed to that object's own local convention was therefore fighting
   * each object's real, legitimate placement instead of just correcting
   * the capture's systemic distortion. A single whole-scene rotation,
   * chosen once (from whichever reference/consensus object's fit is most
   * trustworthy) and applied uniformly, doesn't have this problem. */
  distortionOrientation: THREE.Quaternion;
  /** RMS distance between each posed vertex and where nonPosedToPosed
   * predicts it should land, relative to the posed mesh's own bounding
   * diagonal - a unitless "how well does a single affine map actually
   * explain posed from non-posed" signal. 0 means a perfect fit (typical
   * for a rigid prop with a uniform scale/shear error); a large value
   * means the two shapes plausibly differ by more than any single 3x3
   * matrix can correct - most commonly because the mesh is rigged/skinned
   * and posed via independent per-bone transforms rather than one
   * whole-object transform. See isGoodDistortionFitCandidate(). */
  relativeFitError: number;
  /** Ratio between the largest and smallest of the fit's 3 singular values
   * (posedToNonPosedLinear's per-axis stretch factors, whichever 3
   * directions they actually fall along - not necessarily x/y/z). 1 means
   * the correction is a pure uniform scale: same aspect ratio, just a
   * different overall size. Larger means the correction reshapes the
   * object non-uniformly - changes its aspect ratio, not just its size.
   *
   * A low relativeFitError alone doesn't tell a genuine capture/export
   * artifact apart from an INTENTIONAL non-uniform scale the game applies
   * on purpose (e.g. a prop deliberately stretched to fit a space, a
   * squash-and-stretch animation frame, or a LOD authored with different
   * proportions than the source model) - both fit a single affine map
   * equally well, since "fits well" only checks whether one matrix
   * explains ALL of posed from non-posed, not whether that matrix looks
   * like a plausible bug. scaleAnisotropy is the second signal
   * isGoodDistortionFitCandidate() uses to tell those apart: a mild
   * aspect-ratio change is plausibly a real distortion worth fixing; a
   * drastic one is plausibly a deliberate difference between the source
   * model and its in-game appearance, and safer to leave alone than to
   * silently "correct" away. */
  scaleAnisotropy: number;
}

/** Default threshold for isGoodDistortionFitCandidate() below - an RMS fit
 * residual above 8% of the posed mesh's own bounding diagonal is treated
 * as "not a shape a single affine map can explain" (see
 * AffineDistortionResult.relativeFitError). Picked by feel, not derived
 * from any formal statistic - a real capture with a lot of false
 * positives/negatives would be a reason to revisit this, not a fixed law. */
export const DEFAULT_FIT_ERROR_THRESHOLD = 0.08;

/** Default threshold for isGoodDistortionFitCandidate() below - a fitted
 * correction that stretches one axis more than 35% relative to another
 * (see AffineDistortionResult.scaleAnisotropy) is treated as reshaping the
 * object rather than fixing a small export quirk. Also picked by feel, not
 * derived from any formal statistic - same caveat as
 * DEFAULT_FIT_ERROR_THRESHOLD above. */
export const DEFAULT_MAX_SCALE_ANISOTROPY = 1.35;

/** Whether a fit is trustworthy enough to auto-apply without a human
 * checking it first. Two independent checks, both must pass:
 * - relativeFitError: does a single affine map even explain the
 *   difference well? Catches meshes a matrix fundamentally can't correct
 *   (typically rigged/skinned ones - see that field's doc comment).
 * - scaleAnisotropy: if it does, is that map itself a small, plausible
 *   correction rather than a drastic reshaping? Catches meshes where the
 *   fit is clean but the "distortion" is probably intentional (see that
 *   field's doc comment) - a good fit alone doesn't imply a good
 *   CANDIDATE, since an intentional aspect-ratio change fits just as
 *   cleanly as an accidental one.
 *
 * That second check assumes genuine capture distortion is USUALLY closer
 * to a uniform scale than a drastic one - true for some pipelines, but
 * not a safe assumption everywhere: app.ts's autoCorrectRenderDocDistortion()
 * disables it entirely (maxScaleAnisotropy: Infinity) because for THAT
 * capture pipeline, the distortion being corrected routinely presents AS
 * a large anisotropic squish - excluding high-anisotropy fits there would
 * throw out the very thing being detected, not just intentional design
 * choices. Pass maxScaleAnisotropy: Infinity for any other caller in the
 * same situation (systemic distortion that's known to look anisotropic on
 * this data, not merely suspected to be). */
export function isGoodDistortionFitCandidate(
  result: Pick<AffineDistortionResult, "relativeFitError" | "scaleAnisotropy">,
  options: { maxRelativeFitError?: number; maxScaleAnisotropy?: number } = {},
): boolean {
  const maxRelativeFitError = options.maxRelativeFitError ?? DEFAULT_FIT_ERROR_THRESHOLD;
  const maxScaleAnisotropy = options.maxScaleAnisotropy ?? DEFAULT_MAX_SCALE_ANISOTROPY;
  return (
    Number.isFinite(result.relativeFitError) &&
    result.relativeFitError <= maxRelativeFitError &&
    Number.isFinite(result.scaleAnisotropy) &&
    result.scaleAnisotropy <= maxScaleAnisotropy
  );
}

/** Entry point mirroring calculateDistortion() above, but returning a full
 * transformation matrix instead of separate scale/rotation factors. */
export function calculateDistortionMatrix(scaleReferenceObject: {
  geometryData: { positions: number[] };
  previewGeometryData: { positions: number[] };
}): AffineDistortionResult {
  const posedVertices = toVector3Array(scaleReferenceObject.geometryData);
  const nonPosedVertices = toVector3Array(scaleReferenceObject.previewGeometryData);

  return analyzeTransformMatrix(nonPosedVertices, posedVertices);
}

/**
 * Analyzes the affine transformation that maps non-posed vertices to posed vertices
 * and tries to determine matrix that transformed mesh made from nonPosedVertices
 * into mesh made out of posedVertices.
 *
 * @param nonPosedVertices
 * @param posedVertices
 * @returns
 */
function analyzeTransformMatrix(
  nonPosedVertices: THREE.Vector3[],
  posedVertices: THREE.Vector3[],
): AffineDistortionResult {
  if (nonPosedVertices.length === 0 || posedVertices.length === 0) {
    throw new Error("calculateDistortionMatrix: empty geometry input");
  }
  if (nonPosedVertices.length !== posedVertices.length) {
    throw new Error(
      "calculateDistortionMatrix: posed and non-posed vertex counts must match",
    );
  }

  const nonPosedCentroid = computeCentroid(nonPosedVertices);
  const posedCentroid = computeCentroid(posedVertices);

  const nonPosedCentered = nonPosedVertices.map((v) => v.clone().sub(nonPosedCentroid));
  const posedCentered = posedVertices.map((v) => v.clone().sub(posedCentroid));

  const nonPosedNonPosedCov = computeCovariance(nonPosedCentered, nonPosedCentered);
  const posedNonPosedCov = computeCovariance(posedCentered, nonPosedCentered);

  const nonPosedNonPosedCovInv = nonPosedNonPosedCov.clone().invert();
  if (isZeroMatrix3(nonPosedNonPosedCovInv)) {
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

  const { u, singularValues, v } = svd3x3(posedToNonPosedLinear);
  const naiveRotation = u.clone().multiply(v.clone().transpose());
  const handednessMismatchDetected = naiveRotation.determinant() < 0;

  const rawStretch = buildDiagonalConjugate(v, singularValues);
  const stretch = handednessMismatchDetected ? mirrorZ.clone().multiply(rawStretch) : rawStretch;

  const posedToNonPosedInPlace = affineFromLinearAndTranslation(stretch, posedCentroid, posedCentroid);

  const correctedPosedCentered = posedCentered.map((p) => p.clone().applyMatrix3(stretch));
  const orientationRotation = solveOptimalRotation(computeCovariance(correctedPosedCentered, nonPosedCentered));
  const orientedLinear = orientationRotation.clone().multiply(stretch);
  const posedToNonPosedOrientedInPlace = affineFromLinearAndTranslation(orientedLinear, posedCentroid, posedCentroid);
  const distortionOrientation = matrix3ToQuaternion(orientationRotation);

  let sumSquaredResidual = 0;
  for (let i = 0; i < posedVertices.length; i++) {
    const predicted = nonPosedVertices[i].clone().applyMatrix4(nonPosedToPosed);
    sumSquaredResidual += predicted.distanceToSquared(posedVertices[i]);
  }
  const rmsResidual = Math.sqrt(sumSquaredResidual / posedVertices.length);
  const posedDiagonal = new THREE.Box3().setFromPoints(posedVertices).getSize(new THREE.Vector3()).length();
  const relativeFitError = posedDiagonal > 0 ? rmsResidual / posedDiagonal : 0;

  const positiveSingularValues = singularValues.filter((value) => value > 1e-9);
  const scaleAnisotropy =
    positiveSingularValues.length > 0
      ? Math.max(...positiveSingularValues) / Math.min(...positiveSingularValues)
      : 1;

  // console.log("mesh matrix results:", {
  //   posedToNonPosed,
  //   nonPosedToPosed,
  //   posedToNonPosedInPlace,
  //   posedToNonPosedOrientedInPlace,
  //   distortionOrientation,
  //   handednessMismatchDetected,
  //   relativeFitError,
  //   scaleAnisotropy,
  // });

  return {
    posedToNonPosed,
    nonPosedToPosed,
    posedToNonPosedInPlace,
    posedToNonPosedOrientedInPlace,
    distortionOrientation,
    handednessMismatchDetected,
    posedCentroid,
    relativeFitError,
    scaleAnisotropy,
  };
}


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

function buildDiagonalConjugate(v: THREE.Matrix3, values: number[]): THREE.Matrix3 {
  const sigma = new THREE.Matrix3().set(values[0], 0, 0, 0, values[1], 0, 0, 0, values[2]);
  return v.clone().multiply(sigma).multiply(v.clone().transpose());
}

/** Fixed Z-axis reflection (det = -1) - the conventional right<->left
 * handed conversion axis (e.g. the common DirectX/Unity(LH) <-> OpenGL/
 * three.js(RH) Z-negation convention), used to factor a genuine chirality
 * mismatch out of a rotation and into stretch instead - see
 * analyzeTransformMatrix's doc comment. Left-multiplying by this actually
 * flips a matrix's determinant sign (unlike the old negate-row-and-column
 * approach it replaces, which cancels out and never did - see that same
 * doc comment). */
const mirrorZ = new THREE.Matrix3().set(1, 0, 0, 0, 1, 0, 0, 0, -1);

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

function frobeniusNorm(elements: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < elements.length; i++) sum += elements[i] * elements[i];
  return Math.sqrt(sum);
}

function frobeniusDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export interface DistortionConsensusResult {
  clusterOf: number[];
  largestCluster: number;
  largestClusterSize: number;
}

export const DEFAULT_MATRIX_CLUSTER_TOLERANCE = 0.1;

export function findDistortionConsensus(
  matrices: THREE.Matrix3[],
  tolerance: number = DEFAULT_MATRIX_CLUSTER_TOLERANCE,
): DistortionConsensusResult {
  const clusterSums: number[][] = [];
  const clusterCounts: number[] = [];
  const clusterOf: number[] = [];

  for (const matrix of matrices) {
    let placedIn = -1;
    for (let c = 0; c < clusterSums.length; c++) {
      const mean = clusterSums[c].map((sum) => sum / clusterCounts[c]);
      if (frobeniusDistance(matrix.elements, mean) <= tolerance * Math.max(frobeniusNorm(mean), 1e-6)) {
        placedIn = c;
        break;
      }
    }
    if (placedIn === -1) {
      clusterSums.push(Array.from(matrix.elements));
      clusterCounts.push(1);
      placedIn = clusterSums.length - 1;
    } else {
      for (let i = 0; i < 9; i++) clusterSums[placedIn][i] += matrix.elements[i];
      clusterCounts[placedIn]++;
    }
    clusterOf.push(placedIn);
  }

  let largestCluster = 0;
  let largestClusterSize = 0;
  for (let c = 0; c < clusterCounts.length; c++) {
    if (clusterCounts[c] > largestClusterSize) {
      largestClusterSize = clusterCounts[c];
      largestCluster = c;
    }
  }

  return { clusterOf, largestCluster, largestClusterSize };
}

function matrix3ToMatrix4(m: THREE.Matrix3): THREE.Matrix4 {
  const xAxis = new THREE.Vector3().setFromMatrix3Column(m, 0);
  const yAxis = new THREE.Vector3().setFromMatrix3Column(m, 1);
  const zAxis = new THREE.Vector3().setFromMatrix3Column(m, 2);
  return new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
}

function isZeroMatrix3(m: THREE.Matrix3): boolean {
  return m.elements.every((v) => v === 0);
}

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
