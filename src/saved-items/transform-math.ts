/**
 * Pure (three.js-free) math for the saved-items modal transforms
 * (G / R / S, optionally locked to an axis or plane with X / Y / Z and
 * Shift+X / Shift+Y / Shift+Z).
 *
 * Matrices are plain column-major number[16] - the same layout as
 * THREE.Matrix4.elements, so `matrix.fromArray(m)` / `matrix.toArray()` convert
 * for free. Keeping this file free of three.js lets it be unit-tested without
 * a browser or WebGL.
 *
 * Every operation is expressed as a WORLD-space delta matrix D that is
 * left-multiplied onto an item's matrix at the moment the operation started:
 *   M' = D * M0
 * which makes cancel (just restore M0), multi-item pivoting, and non-uniform
 * world-axis scaling all fall out of the same one-liner.
 */

export type Vec3 = [number, number, number];
export type Mat4 = number[];
export type AxisKey = "x" | "y" | "z";
export type TransformMode = "move" | "rotate" | "scale";

/** `axis` null = free. `plane` true = locked to the plane PERPENDICULAR to
 * `axis` (Shift+X/Y/Z), false = locked along the axis itself (X/Y/Z). */
export interface AxisConstraint {
  axis: AxisKey | null;
  plane: boolean;
}

export interface Ray {
  origin: Vec3;
  /** Unit length. */
  dir: Vec3;
}

export interface CameraBasis {
  /** Unit vector the camera looks along (away from the viewer). */
  forward: Vec3;
  /** Unit vector pointing to the right of the screen. */
  right: Vec3;
  /** Unit vector pointing to the top of the screen. */
  up: Vec3;
}

// ---------------------------------------------------------------- vectors

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len > 1e-12 ? mul(a, 1 / len) : [0, 0, 0];
}

export function axisVector(axis: AxisKey): Vec3 {
  return axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
}

/** Removes the component of `v` along unit vector `n`. */
export function projectOntoPlane(v: Vec3, n: Vec3): Vec3 {
  return sub(v, mul(n, dot(v, n)));
}

// --------------------------------------------------------------- matrices

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** a * b (column-major, same convention as THREE.Matrix4.multiplyMatrices). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function translation(v: Vec3): Mat4 {
  const m = identity();
  m[12] = v[0];
  m[13] = v[1];
  m[14] = v[2];
  return m;
}

export function scaling(s: Vec3): Mat4 {
  const m = identity();
  m[0] = s[0];
  m[5] = s[1];
  m[10] = s[2];
  return m;
}

/** Rotation by `angle` radians about the UNIT vector `axis` (right-handed). */
export function rotationAxisAngle(axis: Vec3, angle: number): Mat4 {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  // Rodrigues' formula, written out in column-major order.
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

/** Makes `op` (a rotation/scale about the origin) act about `pivot`:
 * T(pivot) * op * T(-pivot). */
export function aboutPivot(op: Mat4, pivot: Vec3): Mat4 {
  return multiply(translation(pivot), multiply(op, translation(mul(pivot, -1))));
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] || 1;
  return [
    (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w,
    (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w,
    (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / w,
  ];
}

export interface AxisAlignedBounds {
  min: Vec3;
  max: Vec3;
}

/** Exact world-space bounding box of a flat xyz position array after `m`.
 * Returns null for an empty array. */
export function transformedBounds(positions: ArrayLike<number>, m: Mat4): AxisAlignedBounds | null {
  if (positions.length < 3) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (wx < min[0]) min[0] = wx;
    if (wy < min[1]) min[1] = wy;
    if (wz < min[2]) min[2] = wz;
    if (wx > max[0]) max[0] = wx;
    if (wy > max[1]) max[1] = wy;
    if (wz > max[2]) max[2] = wz;
  }
  return { min, max };
}

// ------------------------------------------------------- constraint state

/**
 * Applies an X/Y/Z (or Shift+X/Y/Z) key press to the current constraint the
 * way Blender does: pressing the same lock again clears it, pressing a
 * different one (or switching between axis and plane lock) replaces it.
 */
export function toggleConstraint(current: AxisConstraint, axis: AxisKey, plane: boolean): AxisConstraint {
  if (current.axis === axis && current.plane === plane) return { axis: null, plane: false };
  return { axis, plane };
}

export function describeConstraint(c: AxisConstraint): string {
  if (!c.axis) return "free";
  const label = c.axis.toUpperCase();
  return c.plane ? `plane \u22a5 ${label} (locked to ${planeAxes(c.axis)})` : `${label} axis`;
}

function planeAxes(axis: AxisKey): string {
  return (["x", "y", "z"] as AxisKey[]).filter((a) => a !== axis).join("").toUpperCase();
}

// ---------------------------------------------------------------- solvers

/** Where `ray` crosses the plane through `point` with unit normal `normal`;
 * null when the ray is (nearly) parallel to the plane. */
export function intersectRayPlane(ray: Ray, point: Vec3, normal: Vec3, minCos = 1e-6): Vec3 | null {
  const denom = dot(ray.dir, normal);
  if (Math.abs(denom) < minCos) return null;
  const t = dot(sub(point, ray.origin), normal) / denom;
  return add(ray.origin, mul(ray.dir, t));
}

/**
 * World-space translation for a Move.
 *
 *  - free:        the cursor drags the pivot across the plane facing the camera
 *  - X/Y/Z:       the free drag, projected onto that world axis as it appears on
 *                 screen (so the object tracks the cursor along the visible axis)
 *  - Shift+X/Y/Z: the cursor drags the pivot across the plane perpendicular to
 *                 that axis (the axis component of the motion is always zero)
 */
export function solveMove(
  startRay: Ray,
  currentRay: Ray,
  pivot: Vec3,
  camera: CameraBasis,
  constraint: AxisConstraint,
): Vec3 {
  const viewPlaneStart = intersectRayPlane(startRay, pivot, camera.forward);
  const viewPlaneNow = intersectRayPlane(currentRay, pivot, camera.forward);
  const freeDelta: Vec3 = viewPlaneStart && viewPlaneNow ? sub(viewPlaneNow, viewPlaneStart) : [0, 0, 0];

  if (!constraint.axis) return freeDelta;
  const axis = axisVector(constraint.axis);

  if (!constraint.plane) {
    // Screen-space projection of the axis. Floored so an axis pointing almost
    // straight at/away from the camera can't make the object fly off.
    const axisOnScreen = projectOntoPlane(axis, camera.forward);
    const len2 = Math.max(dot(axisOnScreen, axisOnScreen), 0.01);
    const t = dot(freeDelta, axisOnScreen) / len2;
    return mul(axis, t);
  }

  // Plane lock. A plane seen almost edge-on can't be intersected sensibly, so
  // fall back to the free drag with the locked axis removed.
  const MIN_COS = 0.05;
  const planeStart = intersectRayPlane(startRay, pivot, axis, MIN_COS);
  const planeNow = intersectRayPlane(currentRay, pivot, axis, MIN_COS);
  if (planeStart && planeNow) return sub(planeNow, planeStart);
  return projectOntoPlane(freeDelta, axis);
}

/** Accumulates a screen-space angle across frames so a rotation can pass
 * 180 degrees (atan2 alone wraps there). */
export class AngleAccumulator {
  total = 0;
  constructor(private last: number) {}

  update(angle: number): number {
    let step = angle - this.last;
    while (step > Math.PI) step -= 2 * Math.PI;
    while (step < -Math.PI) step += 2 * Math.PI;
    this.total += step;
    this.last = angle;
    return this.total;
  }
}

/** Screen angle of `point` around `center`, in px space with +y DOWN (so an
 * increasing angle is clockwise on screen). */
export function screenAngle(center: { x: number; y: number }, point: { x: number; y: number }): number {
  return Math.atan2(point.y - center.y, point.x - center.x);
}

/**
 * World-space rotation delta (about the origin - wrap with aboutPivot()).
 *
 *  - free:        spin about the view axis, following the cursor around the
 *                 pivot on screen (clockwise on screen = clockwise rotation)
 *  - X/Y/Z:       spin about that world axis; the sign is flipped when the axis
 *                 points toward the camera so on-screen direction stays natural
 *  - Shift+X/Y/Z: trackball-style - the rotation axis comes from the drag
 *                 direction but is confined to the plane perpendicular to the
 *                 locked axis, so the locked axis never receives any rotation
 *                 component along itself.
 *
 * `screenAngleTotal` is the accumulated screen angle (see AngleAccumulator),
 * `dragPx` the cursor offset from where the operation started (+y down).
 */
export function solveRotate(
  screenAngleTotal: number,
  dragPx: { x: number; y: number },
  camera: CameraBasis,
  constraint: AxisConstraint,
): Mat4 {
  if (!constraint.axis) return rotationAxisAngle(camera.forward, screenAngleTotal);

  const axis = axisVector(constraint.axis);

  if (!constraint.plane) {
    const sign = dot(axis, camera.forward) >= 0 ? 1 : -1;
    return rotationAxisAngle(axis, sign * screenAngleTotal);
  }

  const RADIANS_PER_PIXEL = 0.01;
  // Dragging right spins about the screen's up axis, dragging down about its
  // right axis (the near side of the object follows the cursor).
  const trackball = add(mul(camera.right, dragPx.y), mul(camera.up, dragPx.x));
  const dragLength = length(trackball);
  if (dragLength < 1e-9) return identity();

  const inPlane = projectOntoPlane(mul(trackball, 1 / dragLength), axis);
  const weight = length(inPlane);
  if (weight < 1e-6) return identity();

  return rotationAxisAngle(mul(inPlane, 1 / weight), dragLength * RADIANS_PER_PIXEL * weight);
}

/**
 * World-space scale delta (about the origin - wrap with aboutPivot()).
 * `factor` is current-cursor-distance / start-cursor-distance from the pivot's
 * screen position.
 *
 *  - free:        uniform
 *  - X/Y/Z:       only along that world axis
 *  - Shift+X/Y/Z: along the other two world axes (the locked axis is untouched)
 */
export function solveScale(factor: number, constraint: AxisConstraint): Mat4 {
  const f = Math.max(factor, 0.001);
  if (!constraint.axis) return scaling([f, f, f]);
  const s: Vec3 = constraint.plane ? [f, f, f] : [1, 1, 1];
  const index = constraint.axis === "x" ? 0 : constraint.axis === "y" ? 1 : 2;
  s[index] = constraint.plane ? 1 : f;
  return scaling(s);
}

/** current/start cursor distance from the pivot on screen, with the start
 * distance floored so starting right on top of the pivot doesn't explode. */
export function scaleFactorFromCursor(
  pivotPx: { x: number; y: number },
  startPx: { x: number; y: number },
  currentPx: { x: number; y: number },
  minStartDistancePx = 20,
): number {
  const start = Math.max(Math.hypot(startPx.x - pivotPx.x, startPx.y - pivotPx.y), minStartDistancePx);
  const now = Math.hypot(currentPx.x - pivotPx.x, currentPx.y - pivotPx.y);
  return now / start;
}

// ---------------------------------------------------------------- arrange

export interface ArrangeEntry {
  id: string;
  /** World-space bounds of the item as it currently sits. */
  bounds: AxisAlignedBounds;
}

/**
 * Lines items up along +X in the given order, with a gap between neighbours
 * (15% of the average item width, so spacing scales with what's being laid
 * out). Items are only translated - orientation and scale are untouched. Each
 * is dropped so its bottom sits on y=0 and it is centred on z=0, so the row
 * really is a row rather than a diagonal.
 *
 * Returns the translation delta per item id.
 */
export function computeArrangement(entries: ArrangeEntry[]): Map<string, Vec3> {
  const result = new Map<string, Vec3>();
  if (entries.length === 0) return result;

  const widths = entries.map((e) => e.bounds.max[0] - e.bounds.min[0]);
  const averageWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
  const gap = (averageWidth > 1e-9 ? averageWidth : 1) * 0.15;

  let cursor = 0;
  entries.forEach((entry, i) => {
    const { min, max } = entry.bounds;
    const centerZ = (min[2] + max[2]) / 2;
    result.set(entry.id, [cursor - min[0], -min[1], -centerZ]);
    cursor += widths[i] + gap;
  });
  return result;
}

// ------------------------------------------------------------ baking (export)

/** Positions run through `m` (flat xyz array in, plain number[] out). */
export function transformPositions(positions: ArrayLike<number>, m: Mat4): number[] {
  const out = new Array<number>(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/**
 * Normals run through the inverse-transpose of `m`'s upper 3x3 (the correct
 * transform for normals - plain `m` skews them under non-uniform scale, which
 * is exactly what a world-axis scale or a rotate-then-scale produces) and
 * re-normalised. Degenerate (zero-length) normals are left as zero.
 */
export function transformNormals(normals: ArrayLike<number>, m: Mat4): number[] {
  // Cofactor matrix of the 3x3 = det * inverse-transpose. Multiplying by
  // sign(det) keeps normals consistent with the (possibly mirrored) winding.
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const c00 = e * i - f * h, c01 = f * g - d * i, c02 = d * h - e * g;
  const c10 = c * h - b * i, c11 = a * i - c * g, c12 = b * g - a * h;
  const c20 = b * f - c * e, c21 = c * d - a * f, c22 = a * e - b * d;
  const det = a * c00 + b * c01 + c * c02;
  const s = det < 0 ? -1 : 1;

  const out = new Array<number>(normals.length);
  for (let k = 0; k + 2 < normals.length; k += 3) {
    const x = normals[k];
    const y = normals[k + 1];
    const z = normals[k + 2];
    let nx = s * (c00 * x + c01 * y + c02 * z);
    let ny = s * (c10 * x + c11 * y + c12 * z);
    let nz = s * (c20 * x + c21 * y + c22 * z);
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    out[k] = nx;
    out[k + 1] = ny;
    out[k + 2] = nz;
  }
  return out;
}
