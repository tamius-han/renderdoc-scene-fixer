import type { AxisDirection } from "../types/axis-direction.type";
import type { ParsedOBJ } from "../types";

export interface InputGeometryOrientation {
  up: AxisDirection;
  forward: AxisDirection;
  right: AxisDirection;
}

/** The axis letter ('x'/'y'/'z') an AxisDirection refers to, ignoring sign -
 * e.g. '+z' and '-z' are both 'z'. Used to detect when two orientation
 * fields would occupy the same axis (see cmp.capture-importer.ts's
 * setInputGeometryOrientation()). */
export function axisLetter(direction: AxisDirection): "x" | "y" | "z" {
  return direction[1] as "x" | "y" | "z";
}

function axisIndex(direction: AxisDirection): 0 | 1 | 2 {
  const letter = axisLetter(direction);
  return letter === "x" ? 0 : letter === "y" ? 1 : 2;
}

function axisSign(direction: AxisDirection): 1 | -1 {
  return direction[0] === "-" ? -1 : 1;
}

/** Builds the 3x3 matrix (as 3 row arrays, applied as M*p) that converts a
 * point authored in the INPUT geometry's up/forward/right convention into
 * the app's own fixed convention: up=+Y, forward=+Z, right=+X - which is
 * also Config.defaultConfig.importOptions.inputGeometryOrientation's own
 * default, so importing with default settings is always an identity
 * remap.
 *
 * Each of the 3 settings pins one column of M: whichever raw input axis
 * (x/y/z) the setting names becomes the column index, and the app-space
 * direction that role should end up pointing at (up/forward/right's own
 * fixed target vector) - negated if the setting's sign is '-' - becomes
 * that column's value. The three settings are expected to name three
 * DIFFERENT axes (see setInputGeometryOrientation() for where that's
 * enforced), so this fills in all 3 columns exactly once; a caller that
 * breaks that invariant will silently get a degenerate matrix rather than
 * an error, since there's nothing here to correct a bad input against. */
export function buildOrientationMatrix(orientation: InputGeometryOrientation): number[][] {
  const m: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  const setColumn = (direction: AxisDirection, target: readonly [number, number, number]) => {
    const column = axisIndex(direction);
    const sign = axisSign(direction);
    m[0][column] = target[0] * sign;
    m[1][column] = target[1] * sign;
    m[2][column] = target[2] * sign;
  };

  setColumn(orientation.up, [0, 1, 0]);
  setColumn(orientation.forward, [0, 0, 1]);
  setColumn(orientation.right, [1, 0, 0]);

  return m;
}

function applyMatrix(m: number[][], p: readonly [number, number, number]): [number, number, number] {
  return [
    m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
    m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
    m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2],
  ];
}

/** Returns a NEW ParsedOBJ with positions and normals remapped from
 * `orientation`'s axis convention into the app's own fixed one (see
 * buildOrientationMatrix()) - faces/uvs/mtllib/usemtl are shared by
 * reference with the input, since they aren't spatial and don't need
 * remapping. The matrix is a signed permutation (orthogonal), so it's its
 * own inverse-transpose - applying it directly to normals is correct, not
 * just to positions. The input object is left untouched. */
export function remapObjOrientation(obj: ParsedOBJ, orientation: InputGeometryOrientation): ParsedOBJ {
  const m = buildOrientationMatrix(orientation);
  return {
    ...obj,
    positions: obj.positions.map((p) => applyMatrix(m, p)),
    normals: obj.normals.map((n) => applyMatrix(m, n)),
  };
}
