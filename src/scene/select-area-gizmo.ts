import * as THREE from "three";

export type GizmoMode = "translate" | "scale" | "rotate";
export type GizmoAxis = "x" | "y" | "z";

export type GizmoHandleKind =
  | { type: "axis"; axis: GizmoAxis }
  | { type: "plane"; axes: [GizmoAxis, GizmoAxis] }
  | { type: "rotate"; axis: GizmoAxis }
  | { type: "center" };

/** One draggable/hoverable piece of the gizmo. Returned (opaquely, from the
 * caller's point of view) by hitTest() and passed back into beginDrag() -
 * callers shouldn't need to inspect `kind`/`mesh` directly, just hold onto
 * the reference between pointerdown and the drag that follows. */
export interface GizmoHandle {
  readonly mesh: THREE.Mesh;
  readonly kind: GizmoHandleKind;
  readonly baseColor: THREE.Color;
}

const AXIS_COLORS: Record<GizmoAxis, number> = { x: 0xff5555, y: 0x55ff55, z: 0x5599ff };
const CENTER_COLOR = 0xffaa33;
const HIGHLIGHT_COLOR = 0xffff00;
/** Gizmo's overall apparent size, as a fraction of the viewport's vertical
 * world-space extent AT THE GIZMO'S CURRENT DISTANCE from the camera - see
 * update(). Kept constant on screen regardless of distance or the target
 * shape's own scale, matching how game-engine gizmos usually behave. */
const SCREEN_FRACTION = 0.14;
const AXIS_LEN = 1;

/** World-space height visible at the given distance from the camera - the
 * common piece of math behind both "keep this gizmo a constant fraction of
 * the viewport regardless of distance" (see update()) and the scale-mode
 * drag's screen-space reference point. Works for either camera type: for
 * perspective this is the standard fov-based frustum height; for
 * orthographic there's no fov, so it's read directly off the frustum
 * (divided by zoom, in case that's ever not 1). SceneManager keeps its
 * orthographic camera's frustum defined as distance*tan(fov/2) (see
 * syncOrthographicCamera()'s doc comment) specifically so this function
 * gives the same answer either way at any given moment - i.e. so nothing
 * here needs to care which projection is actually active. */
function visibleHeightAt(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, distance: number): number {
  if (camera instanceof THREE.OrthographicCamera) {
    return (camera.top - camera.bottom) / camera.zoom;
  }
  const vFov = (camera.fov * Math.PI) / 180;
  return 2 * distance * Math.tan(vFov / 2);
}

// Half as thick as before (was 0.045) - drives the arrow shaft/cone radius,
// the scale-mode box tip size, and the center ring's tube thickness (see
// buildHandles() below) all at once, without touching any of the LENGTHS
// (AXIS_LEN, PLANE_SIZE/OFFSET, RING_RADIUS) - so the gizmo's overall reach
// on screen is unchanged, just visually thinner.
const HANDLE_RADIUS = 0.0225;
const PLANE_SIZE = AXIS_LEN * 0.22;
const PLANE_OFFSET = AXIS_LEN * 0.32;
const RING_RADIUS = AXIS_LEN * 0.18;
/** Radius of the rotate-mode ring handles (see buildHandles()) - well
 * beyond PLANE_OFFSET/PLANE_SIZE's own reach so they don't visually
 * overlap the (mode-exclusive, never shown at the same time) axis/plane
 * handles, while staying inside AXIS_LEN so the whole gizmo's overall
 * reach on screen is consistent between modes. */
const ROTATE_RING_RADIUS = AXIS_LEN * 0.92;

function axisVector(axis: GizmoAxis): THREE.Vector3 {
  return axis === "x" ? new THREE.Vector3(1, 0, 0) : axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
}

function thirdAxis(a: GizmoAxis, b: GizmoAxis): GizmoAxis {
  const all: GizmoAxis[] = ["x", "y", "z"];
  return all.find((axis) => axis !== a && axis !== b) as GizmoAxis;
}

/** Signed distance, along axisWorld from originWorld, of where the given
 * raycaster's ray crosses dragPlane - the "t" parameter used to drive
 * single-axis translate/scale drags. 0 if the ray is parallel to the plane
 * (shouldn't normally happen - the plane is built to always contain the
 * axis and face the camera reasonably well - but a mouse position exactly
 * at the vanishing point is possible in principle). */
function rayPlaneAxisT(
  raycaster: THREE.Raycaster,
  dragPlane: THREE.Plane,
  originWorld: THREE.Vector3,
  axisWorld: THREE.Vector3,
): number {
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(dragPlane, hit)) return 0;
  return hit.sub(originWorld).dot(axisWorld);
}

/** Where the given raycaster's ray crosses dragPlane, expressed as a LOCAL
 * (content-group-space) offset from originWorld - used to drive the
 * center handle's free-move (translate) drag, the one remaining case
 * where up to 3 independent XYZ components matter rather than a
 * direction-projected scalar (see rayPlaneAxisT()) - free move isn't
 * relative to the target's own axes at all, unlike axis/plane handles
 * (see beginDrag()'s own comments), so this only ever needs to know
 * about the content group's rotation, never the target's. */
function rayPlaneLocalOffset(
  raycaster: THREE.Raycaster,
  dragPlane: THREE.Plane,
  originWorld: THREE.Vector3,
  groupQuat: THREE.Quaternion,
  groupScale: number,
): THREE.Vector3 {
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(dragPlane, hit)) return new THREE.Vector3();
  return hit
    .sub(originWorld)
    .applyQuaternion(groupQuat.clone().invert())
    .divideScalar(Math.max(groupScale, 1e-9));
}

/** Two unit vectors spanning the plane perpendicular to `normal` - turns a
 * 3D point on that plane into a single angle (see rayPlaneAngle()) for the
 * rotate-mode ring handles. Not a unique choice (any rotation of the pair
 * around `normal` works equally well) - it only has to be built the SAME
 * way at drag start and on every subsequent frame, since rotate drags only
 * ever look at the ANGLE DELTA since drag start, never this basis' own
 * absolute orientation. */
function orthonormalBasis(normal: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const reference = Math.abs(normal.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(reference, normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();
  return [u, v];
}

/** Angle (radians, atan2 range - so with a discontinuity at ±π that
 * updateDrag()'s own unwrapping accounts for) of wherever the given
 * raycaster's ray crosses dragPlane, measured around originWorld in the
 * (basisU, basisV) frame - the rotate-mode ring handles' equivalent of
 * rayPlaneAxisT(). 0 if the ray misses the plane (see rayPlaneAxisT()'s
 * own comment - the same rare degenerate case). */
function rayPlaneAngle(
  raycaster: THREE.Raycaster,
  dragPlane: THREE.Plane,
  originWorld: THREE.Vector3,
  basisU: THREE.Vector3,
  basisV: THREE.Vector3,
): number {
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(dragPlane, hit)) return 0;
  const offset = hit.sub(originWorld);
  return Math.atan2(offset.dot(basisV), offset.dot(basisU));
}

/** Hand-rolled in-scene translate/scale/rotate gizmo (axis arrows, plane
 * squares, rotate rings, and a center free-move/uniform-scale ring) for
 * the select-area tool's placed shape - see SceneViewerApp's
 * placeSelectAreaShape(). Deliberately NOT three.js's official
 * TransformControls addon: SceneManager already avoids three/examples/jsm
 * add-ons on purpose (see its own doc comment), so this follows that same
 * house convention rather than introducing the first exception.
 *
 * Lives as a CHILD OF THE SAME content group the target itself is a child
 * of (the caller is responsible for adding object3d there and keeping it
 * there across a scene rebuild - see app.ts's restoreSelectAreaShape()),
 * so `target.quaternion` (the target's own LOCAL rotation, relative to
 * that content group - see the rotate-mode ring handles below) is exactly
 * what the caller needs to persist across a rebuild for the shape's own
 * orientation to survive it - see restoreSelectAreaShape()'s own doc
 * comment on why a FRESH shape's target.quaternion is set to the content
 * group's own rotation, inverted, rather than left at the default
 * identity: so that this gizmo's (and the shape's) axes point along
 * WORLD space by default, regardless of any rotation already on the
 * content group (e.g. from the ground-plane alignment tool), rather than
 * that group's own rotated local axes - every axis/plane/rotate handle
 * below is built from `target.quaternion` composed with `groupQuat`
 * (never `groupQuat` alone) for exactly this reason, and object3d itself
 * is kept rotated to match target.quaternion every frame (see update()),
 * so the drawn gizmo rotates right along with the shape once the user
 * actually rotates it (via the rotate-mode rings) on top of that. */
export class SelectAreaGizmo {
  readonly object3d = new THREE.Group();

  private mode: GizmoMode;
  private readonly target: THREE.Object3D;
  private handles: GizmoHandle[] = [];
  private highlighted: GizmoHandle | null = null;
  /** Floor on any single scale axis, purely to keep it from going literally
   * zero or negative (which would collapse the shape's own matrix into a
   * useless/degenerate one) - NOT a practical/visible minimum size, and
   * deliberately tiny enough that no realistic drag ever reaches it
   * intentionally. setMinScale() used to let a caller raise this to
   * something bigger (app.ts's placeSelectAreaShape() tied it to the
   * whole SCENE's own bounding diagonal), but that meant a shape placed
   * small (it's sized off the VIEWPORT at placement, not the scene - see
   * placeSelectAreaShape()) in a large scene could already sit BELOW that
   * caller-supplied floor - at which point simply CLICKING a scale handle
   * (deltaLocal starts at ~0) would instantly snap it up to that floor via
   * updateDrag()'s Math.max(), which could be orders of magnitude bigger
   * than the shape's own current/intended size. No caller sets this
   * anymore for exactly that reason - it's a fixed, tiny, scene-agnostic
   * safety net now, not a caller-tunable practical limit. */
  private minScale = 1e-9;

  // Drag state - only meaningful while dragHandle is non-null.
  private dragHandle: GizmoHandle | null = null;
  private readonly dragStartPosition = new THREE.Vector3();
  private readonly dragStartScale = new THREE.Vector3();
  private readonly dragPlane = new THREE.Plane();
  // Axis handle (translate/scale): WORLD direction for the ray/plane math
  // below, and the same direction expressed in CONTENT-GROUP-LOCAL space
  // (i.e. still composed with the target's own rotation, just not
  // groupQuat) - position lives in that local space, unlike scale (see
  // updateDrag()'s own comment on why translate needs this second copy
  // and scale doesn't).
  private readonly dragAxisWorld = new THREE.Vector3();
  private readonly dragAxisLocal = new THREE.Vector3();
  private dragStartT = 0;
  // Plane handle (translate/scale): same idea as dragAxisWorld/Local
  // above, just two of each (one per in-plane axis) instead of one.
  private readonly dragPlaneAxisAWorld = new THREE.Vector3();
  private readonly dragPlaneAxisBWorld = new THREE.Vector3();
  private readonly dragPlaneAxisALocal = new THREE.Vector3();
  private readonly dragPlaneAxisBLocal = new THREE.Vector3();
  private dragStartTB = 0;
  // Center handle, translate mode only (free move) - see
  // rayPlaneLocalOffset()'s own doc comment on why this one stays in
  // content-group-local space regardless of the target's rotation.
  private readonly dragStartLocalOffset = new THREE.Vector3();
  private readonly dragStartScreenOrigin = new THREE.Vector2();
  /** World units represented by one screen pixel at the target's own
   * distance from the camera, captured at drag start - see the center
   * handle's own scale-mode comment in beginDrag() below. */
  private dragWorldPerPixel = 1;
  private dragStartScreenDistance = 0;
  // Rotate handle: the ring's own axis, in content-group-local space (see
  // dragAxisLocal above - reused here since a rotate drag and an
  // axis-translate drag never happen at the same time), plus a 2D
  // (basisU, basisV) frame spanning the plane it sweeps through, used to
  // turn the drag into a single ANGLE (see rayPlaneAngle()). dragLastAngle/
  // dragAccumulatedAngle unwrap that angle's own -π..π discontinuity into
  // a continuous value across the whole drag (see updateDrag()) - without
  // that, crossing the wrap point mid-drag would read as a sudden ~2π
  // jump, exactly the kind of bug this gizmo's scale handles already had
  // to be fixed for once (see the center handle's own history).
  private readonly dragBasisU = new THREE.Vector3();
  private readonly dragBasisV = new THREE.Vector3();
  private dragStartAngle = 0;
  private dragLastAngle = 0;
  private dragAccumulatedAngle = 0;
  private readonly dragStartQuaternion = new THREE.Quaternion();

  constructor(target: THREE.Object3D, mode: GizmoMode) {
    this.target = target;
    this.mode = mode;
    this.buildHandles();
  }

  getMode(): GizmoMode {
    return this.mode;
  }

  setMode(mode: GizmoMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.endDrag();
    for (const handle of this.handles) {
      this.object3d.remove(handle.mesh);
      handle.mesh.geometry.dispose();
      (handle.mesh.material as THREE.Material).dispose();
    }
    this.handles = [];
    this.buildHandles();
  }

  /** Raises the floor from minScale's own tiny numeric-safety default to
   * `min` instead - unused by app.ts by default now (see minScale's own
   * field comment for why tying it to the whole scene's size was the
   * wrong call there), but kept available for a caller with a floor
   * that's actually meaningful relative to the SHAPE itself, unlike the
   * scene as a whole. */
  setMinScale(min: number): void {
    this.minScale = Math.max(min, 1e-9);
  }

  /** Call every frame (see SceneManager.onBeforeRender()): re-centers the
   * gizmo on the target (in their shared parent's local space, so this is
   * a direct copy - no cross-space conversion needed), keeps it rotated to
   * match the target's own current orientation (see the class's own doc
   * comment on target.quaternion), and rescales it for a constant apparent
   * screen size regardless of camera distance or the target's own current
   * scale, plus keeps the center ring facing the camera. groupQuat/
   * groupScale are the content group's current rotation/(uniform) scale -
   * passed in rather than looked up here so this class doesn't need to
   * know about SceneManager/contentGroup at all. */
  update(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, groupQuat: THREE.Quaternion, groupScale: number): void {
    this.object3d.position.copy(this.target.position);
    this.object3d.quaternion.copy(this.target.quaternion);

    const worldPos = this.target.position.clone().applyQuaternion(groupQuat).multiplyScalar(groupScale);
    const distance = Math.max(camera.position.distanceTo(worldPos), 1e-6);
    const desiredWorldSize = visibleHeightAt(camera, distance) * SCREEN_FRACTION;
    this.object3d.scale.setScalar(desiredWorldSize / Math.max(groupScale, 1e-9));

    const ring = this.handles.find((handle) => handle.kind.type === "center")?.mesh;
    if (ring) {
      // ring is a child of object3d, which - now that object3d carries
      // the target's own rotation too (see above) - is no longer the same
      // space as the content group's own: undo BOTH, group's then
      // object3d's own, to land in the space ring.quaternion is actually
      // relative to.
      const camDirWorld = camera.position.clone().sub(worldPos);
      const camDirLocal = camDirWorld
        .applyQuaternion(groupQuat.clone().invert())
        .applyQuaternion(this.target.quaternion.clone().invert())
        .normalize();
      if (camDirLocal.lengthSq() > 1e-9) ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), camDirLocal);
    }
  }

  /** Raycasts against just this gizmo's own handle meshes (cheap - a
   * handful of primitives) and returns whichever one was hit closest to
   * the ray origin, or null. */
  hitTest(raycaster: THREE.Raycaster): GizmoHandle | null {
    const hits = raycaster.intersectObjects(
      this.handles.map((handle) => handle.mesh),
      false,
    );
    if (hits.length === 0) return null;
    return this.handles.find((handle) => handle.mesh === hits[0].object) ?? null;
  }

  /** Recolors the given handle to the highlight color (restoring whichever
   * one was previously highlighted, if any, back to its own base color
   * first) - used both for hover feedback and to keep the actively-dragged
   * handle lit up for the duration of the drag. Pass null to clear. */
  setHighlight(handle: GizmoHandle | null): void {
    if (this.highlighted === handle) return;
    if (this.highlighted) (this.highlighted.mesh.material as THREE.MeshBasicMaterial).color.copy(this.highlighted.baseColor);
    this.highlighted = handle;
    if (handle) (handle.mesh.material as THREE.MeshBasicMaterial).color.set(HIGHLIGHT_COLOR);
  }

  isDragging(): boolean {
    return this.dragHandle !== null;
  }

  /** Starts a drag on the given handle - captures everything the drag
   * needs to reference for the rest of its duration (the target's
   * position/scale/quaternion as they stood at drag start, plus whichever
   * plane/axis/screen-space reference frame that kind of handle drags
   * against - see the per-kind comments below and updateDrag()). */
  beginDrag(
    handle: GizmoHandle,
    raycaster: THREE.Raycaster,
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    groupQuat: THREE.Quaternion,
    groupScale: number,
    canvasRect: DOMRect,
    mouseClientX: number,
    mouseClientY: number,
  ): void {
    this.dragHandle = handle;
    this.dragStartPosition.copy(this.target.position);
    this.dragStartScale.copy(this.target.scale);
    this.dragStartQuaternion.copy(this.target.quaternion);
    this.setHighlight(handle);

    const originWorld = this.dragStartPosition.clone().applyQuaternion(groupQuat).multiplyScalar(groupScale);

    if (handle.kind.type === "axis") {
      // Constrain the drag to a plane that CONTAINS the axis line and is
      // oriented to face the camera as squarely as possible (standard
      // technique - keeps the ray/plane intersection well-conditioned
      // instead of degenerating at grazing angles): remove the
      // along-axis component of the eye vector, so what's left is
      // perpendicular to the axis and points "at" the camera.
      //
      // Composed through target.quaternion FIRST, then groupQuat - not
      // groupQuat alone - so this (and every other handle kind below)
      // tracks the TARGET's own current orientation rather than always
      // the content group's, per the class's own doc comment. dragAxisLocal
      // (content-group-local, i.e. still missing groupQuat) is what
      // updateDrag()'s translate branch actually adds to target.position
      // with, since position lives in that local space - scale doesn't
      // need it (see updateDrag()'s own comment there).
      const axisLocal = axisVector(handle.kind.axis).applyQuaternion(this.target.quaternion).normalize();
      this.dragAxisLocal.copy(axisLocal);
      const axisWorld = axisLocal.clone().applyQuaternion(groupQuat).normalize();
      this.dragAxisWorld.copy(axisWorld);
      const eye = camera.position.clone().sub(originWorld).normalize();
      let normal = axisWorld.clone().multiplyScalar(axisWorld.dot(eye)).sub(eye);
      if (normal.lengthSq() < 1e-8) normal = new THREE.Vector3().crossVectors(axisWorld, camera.up);
      if (normal.lengthSq() < 1e-8) normal = new THREE.Vector3().crossVectors(axisWorld, new THREE.Vector3(1, 0, 0));
      normal.normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(normal, originWorld);
      this.dragStartT = rayPlaneAxisT(raycaster, this.dragPlane, originWorld, axisWorld);
    } else if (handle.kind.type === "plane") {
      const [a, b] = handle.kind.axes;
      const axisALocal = axisVector(a).applyQuaternion(this.target.quaternion).normalize();
      const axisBLocal = axisVector(b).applyQuaternion(this.target.quaternion).normalize();
      const normalLocal = axisVector(thirdAxis(a, b)).applyQuaternion(this.target.quaternion).normalize();
      this.dragPlaneAxisALocal.copy(axisALocal);
      this.dragPlaneAxisBLocal.copy(axisBLocal);
      const axisAWorld = axisALocal.clone().applyQuaternion(groupQuat).normalize();
      const axisBWorld = axisBLocal.clone().applyQuaternion(groupQuat).normalize();
      this.dragPlaneAxisAWorld.copy(axisAWorld);
      this.dragPlaneAxisBWorld.copy(axisBWorld);
      const normalWorld = normalLocal.applyQuaternion(groupQuat).normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(normalWorld, originWorld);
      // Two independent single-axis projections (see rayPlaneAxisT()),
      // one per in-plane axis, rather than rayPlaneLocalOffset()'s XYZ
      // triple - that function's content-group-local decomposition only
      // lines up with a/b when they're not ALSO rotated by the target's
      // own quaternion (which, per this handle's whole point, they now
      // can be).
      this.dragStartT = rayPlaneAxisT(raycaster, this.dragPlane, originWorld, axisAWorld);
      this.dragStartTB = rayPlaneAxisT(raycaster, this.dragPlane, originWorld, axisBWorld);
    } else if (handle.kind.type === "rotate") {
      // Ring handle: constrained to the plane PERPENDICULAR to its own
      // axis (unlike the axis/plane handles above, this one doesn't tilt
      // to face the camera - it doesn't need to, since it's a full ring
      // rather than a single arm that could end up edge-on).
      const axisLocal = axisVector(handle.kind.axis).applyQuaternion(this.target.quaternion).normalize();
      this.dragAxisLocal.copy(axisLocal);
      const axisWorld = axisLocal.clone().applyQuaternion(groupQuat).normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(axisWorld, originWorld);
      const [u, v] = orthonormalBasis(axisWorld);
      this.dragBasisU.copy(u);
      this.dragBasisV.copy(v);
      this.dragStartAngle = rayPlaneAngle(raycaster, this.dragPlane, originWorld, u, v);
      this.dragLastAngle = this.dragStartAngle;
      this.dragAccumulatedAngle = 0;
    } else if (this.mode === "translate") {
      // Center handle, translate mode: free move within the camera's own
      // view plane (screen-parallel), through the object's current
      // position - drag anywhere and the shape follows the cursor.
      const normalWorld = camera.getWorldDirection(new THREE.Vector3());
      this.dragPlane.setFromNormalAndCoplanarPoint(normalWorld, originWorld);
      this.dragStartLocalOffset.copy(rayPlaneLocalOffset(raycaster, this.dragPlane, originWorld, groupQuat, groupScale));
    } else {
      // Center handle, scale mode: uniform scale, ADDITIVELY from the
      // on-screen pixel distance moved from the gizmo's projected center
      // - not a RATIO of that distance to its own starting value. A ratio
      // means the sensitivity is entirely dictated by wherever exactly the
      // click happened to land (dragStartScreenDistance as the divisor):
      // the center handle is a small ring drawn close to the gizmo's own
      // origin (see RING_RADIUS), so that starting distance is typically
      // just a handful of pixels - meaning almost ANY subsequent mouse
      // movement, however ordinary, divided by that tiny baseline,
      // multiplies the scale by many times over in a single frame. An
      // ADDITIVE delta - converting the pixel distance MOVED into world
      // units via a fixed, click-position-independent conversion factor,
      // then into local units the same way the axis/plane handles already
      // do (see updateDrag()) - has no such division at all, so its
      // sensitivity is stable regardless of precisely where on the ring
      // the drag started, the same way those other handles already are.
      const originNdc = originWorld.clone().project(camera);
      this.dragStartScreenOrigin.set(
        ((originNdc.x + 1) / 2) * canvasRect.width + canvasRect.left,
        ((1 - originNdc.y) / 2) * canvasRect.height + canvasRect.top,
      );
      const distance = Math.max(camera.position.distanceTo(originWorld), 1e-6);
      this.dragWorldPerPixel = visibleHeightAt(camera, distance) / Math.max(canvasRect.height, 1);
      this.dragStartScreenDistance = Math.hypot(
        mouseClientX - this.dragStartScreenOrigin.x,
        mouseClientY - this.dragStartScreenOrigin.y,
      );
    }
  }

  /** Continues an in-progress drag (no-op if nothing's being dragged) -
   * call on every pointermove while isDragging() is true. Mutates the
   * target's position/scale/quaternion directly. */
  updateDrag(
    raycaster: THREE.Raycaster,
    _camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    groupQuat: THREE.Quaternion,
    groupScale: number,
    mouseClientX: number,
    mouseClientY: number,
  ): void {
    const handle = this.dragHandle;
    if (!handle) return;
    const originWorld = this.dragStartPosition.clone().applyQuaternion(groupQuat).multiplyScalar(groupScale);

    if (handle.kind.type === "axis") {
      const axis = handle.kind.axis;
      const t = rayPlaneAxisT(raycaster, this.dragPlane, originWorld, this.dragAxisWorld);
      const deltaLocal = (t - this.dragStartT) / Math.max(groupScale, 1e-9);
      if (this.mode === "translate") {
        // Position lives in content-group-local space, and (unlike
        // scale - see the else branch) ISN'T automatically re-expressed
        // in the target's own rotated frame by three.js, so dragging
        // "along the object's own (possibly rotated) axis" has to move
        // MULTIPLE local x/y/z components at once here, via dragAxisLocal
        // - a single `target.position[axis] = ...` (as scale still does)
        // would only be correct while that axis happens to line up with
        // a pure local x/y/z, i.e. before the object's ever been rotated.
        this.target.position.copy(this.dragStartPosition).addScaledVector(this.dragAxisLocal, deltaLocal);
      } else {
        // Scale, by contrast, is ALREADY expressed in the target's own
        // (pre-rotation) local space by construction - three.js applies
        // an object's scale before its rotation, not after - so target.
        // scale[axis] correctly means "along the target's own axis"
        // (rotated or not) with no extra transformation needed here;
        // dragAxisWorld above already being composed through the
        // target's own quaternion is what makes deltaLocal itself track
        // the right (possibly rotated) direction.
        this.target.scale[axis] = Math.max(this.dragStartScale[axis] + deltaLocal, this.minScale);
      }
      return;
    }

    if (handle.kind.type === "plane") {
      const [a, b] = handle.kind.axes;
      const tA = rayPlaneAxisT(raycaster, this.dragPlane, originWorld, this.dragPlaneAxisAWorld);
      const tB = rayPlaneAxisT(raycaster, this.dragPlane, originWorld, this.dragPlaneAxisBWorld);
      const da = (tA - this.dragStartT) / Math.max(groupScale, 1e-9);
      const db = (tB - this.dragStartTB) / Math.max(groupScale, 1e-9);
      if (this.mode === "translate") {
        // See the axis handle's own translate-branch comment above - same
        // reasoning, just two local directions summed instead of one.
        this.target.position
          .copy(this.dragStartPosition)
          .addScaledVector(this.dragPlaneAxisALocal, da)
          .addScaledVector(this.dragPlaneAxisBLocal, db);
      } else {
        this.target.scale[a] = Math.max(this.dragStartScale[a] + da, this.minScale);
        this.target.scale[b] = Math.max(this.dragStartScale[b] + db, this.minScale);
      }
      return;
    }

    if (handle.kind.type === "rotate") {
      // Raw atan2 angle, unwrapped into a continuous value across the
      // whole drag by tracking the STEP since the previous frame (and
      // normalizing THAT into -π..π, which a single frame's worth of
      // mouse movement can never exceed) rather than comparing directly
      // against dragStartAngle every time - see the drag-state fields'
      // own comment on why a naive direct comparison would occasionally
      // jump by a full turn right as the raw angle crosses ±π.
      const rawAngle = rayPlaneAngle(raycaster, this.dragPlane, originWorld, this.dragBasisU, this.dragBasisV);
      let step = rawAngle - this.dragLastAngle;
      step -= Math.round(step / (Math.PI * 2)) * Math.PI * 2;
      this.dragAccumulatedAngle += step;
      this.dragLastAngle = rawAngle;

      // Rotating about a vector expressed in the PARENT's (content-group-
      // local) space, as dragAxisLocal is, means the incremental rotation
      // has to be applied on the OUTSIDE of (i.e. pre-multiplied onto) the
      // target's own existing local quaternion, not the inside - see the
      // class's own doc comment for why dragAxisLocal is exactly the right
      // frame for this in the first place.
      const deltaQuat = new THREE.Quaternion().setFromAxisAngle(this.dragAxisLocal, this.dragAccumulatedAngle);
      this.target.quaternion.multiplyQuaternions(deltaQuat, this.dragStartQuaternion);
      return;
    }

    // Center handle.
    if (this.mode === "translate") {
      const offset = rayPlaneLocalOffset(raycaster, this.dragPlane, originWorld, groupQuat, groupScale);
      this.target.position.x = this.dragStartPosition.x + (offset.x - this.dragStartLocalOffset.x);
      this.target.position.y = this.dragStartPosition.y + (offset.y - this.dragStartLocalOffset.y);
      this.target.position.z = this.dragStartPosition.z + (offset.z - this.dragStartLocalOffset.z);
    } else {
      // Center handle, scale mode: see beginDrag()'s own comment for why
      // this is an ADDITIVE delta (pixels moved * a fixed world-per-pixel
      // factor, converted to local units the same way the axis/plane
      // handles' own deltaLocal is - see above) rather than a RATIO of
      // screen distances. Applied identically to all 3 axes for a uniform
      // resize.
      const dist = Math.hypot(mouseClientX - this.dragStartScreenOrigin.x, mouseClientY - this.dragStartScreenOrigin.y);
      const deltaLocal = ((dist - this.dragStartScreenDistance) * this.dragWorldPerPixel) / Math.max(groupScale, 1e-9);
      this.target.scale.x = Math.max(this.dragStartScale.x + deltaLocal, this.minScale);
      this.target.scale.y = Math.max(this.dragStartScale.y + deltaLocal, this.minScale);
      this.target.scale.z = Math.max(this.dragStartScale.z + deltaLocal, this.minScale);
    }
  }

  /** Ends whatever drag is in progress (no-op if none) - the highlight
   * stays on the handle until a hover/hitTest elsewhere clears it, so the
   * cursor doesn't need to move for the highlight to look right
   * immediately after releasing. */
  endDrag(): void {
    this.dragHandle = null;
  }

  dispose(): void {
    this.endDrag();
    for (const handle of this.handles) {
      handle.mesh.geometry.dispose();
      (handle.mesh.material as THREE.Material).dispose();
    }
    this.handles = [];
  }

  private buildHandles(): void {
    if (this.mode === "rotate") {
      this.buildRotateHandles();
      return;
    }

    const isTranslate = this.mode === "translate";

    for (const axis of ["x", "y", "z"] as GizmoAxis[]) {
      const dir = axisVector(axis);
      const color = AXIS_COLORS[axis];
      const kind: GizmoHandleKind = { type: "axis", axis };

      const shaftGeometry = new THREE.CylinderGeometry(HANDLE_RADIUS * 0.5, HANDLE_RADIUS * 0.5, AXIS_LEN * 0.75, 8);
      this.addPart(shaftGeometry, dir, AXIS_LEN * 0.375, color, kind);

      // Tip: cone for translate ("arrow"), cube for scale - the standard
      // visual distinction game engines use between the two gizmo kinds.
      const tipGeometry = isTranslate
        ? new THREE.ConeGeometry(HANDLE_RADIUS * 2.2, AXIS_LEN * 0.22, 10)
        : new THREE.BoxGeometry(HANDLE_RADIUS * 3, HANDLE_RADIUS * 3, HANDLE_RADIUS * 3);
      const tipOffset = isTranslate ? AXIS_LEN * 0.75 + (AXIS_LEN * 0.22) / 2 : AXIS_LEN * 0.88;
      this.addPart(tipGeometry, dir, tipOffset, color, kind);
    }

    for (const axes of [
      ["x", "y"],
      ["y", "z"],
      ["x", "z"],
    ] as [GizmoAxis, GizmoAxis][]) {
      const [a, b] = axes;
      const normal = axisVector(thirdAxis(a, b));
      const color = AXIS_COLORS[thirdAxis(a, b)];
      const geometry = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal); // PlaneGeometry defaults to facing +Z
      mesh.position.copy(axisVector(a).multiplyScalar(PLANE_OFFSET)).add(axisVector(b).multiplyScalar(PLANE_OFFSET));
      mesh.renderOrder = 1000;
      mesh.userData.isGizmoHandle = true;
      this.object3d.add(mesh);
      this.handles.push({ mesh, kind: { type: "plane", axes }, baseColor: new THREE.Color(color) });
    }

    // Center ring: free-move (translate) or uniform-scale (scale) handle -
    // billboarded to face the camera every frame, see update().
    const ringGeometry = new THREE.TorusGeometry(RING_RADIUS, HANDLE_RADIUS * 0.6, 8, 24);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: CENTER_COLOR,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.renderOrder = 1001;
    ring.userData.isGizmoHandle = true;
    this.object3d.add(ring);
    this.handles.push({ mesh: ring, kind: { type: "center" }, baseColor: new THREE.Color(CENTER_COLOR) });
  }

  /** Rotate mode's own handle set: one full ring per axis, rather than the
   * axis/plane/center mix buildHandles() otherwise builds - a ring is
   * clickable anywhere around its circumference (unlike the single-arm
   * axis handles), so one per axis is enough with no plane/center
   * handles alongside them. */
  private buildRotateHandles(): void {
    for (const axis of ["x", "y", "z"] as GizmoAxis[]) {
      const dir = axisVector(axis);
      const color = AXIS_COLORS[axis];
      const geometry = new THREE.TorusGeometry(ROTATE_RING_RADIUS, HANDLE_RADIUS * 0.9, 8, 32);
      const material = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(geometry, material);
      // TorusGeometry's own "hole" axis defaults to Z (it's generated flat
      // in the XY plane) - align that with `dir` so the ring sweeps
      // around the axis it rotates, same convention the plane handles
      // above already use for PlaneGeometry (which also defaults to
      // facing +Z).
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      mesh.renderOrder = 1000;
      mesh.userData.isGizmoHandle = true;
      this.object3d.add(mesh);
      this.handles.push({ mesh, kind: { type: "rotate", axis }, baseColor: new THREE.Color(color) });
    }
  }

  private addPart(
    geometry: THREE.BufferGeometry,
    dir: THREE.Vector3,
    offset: number,
    color: number,
    kind: GizmoHandleKind,
  ): void {
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); // cylinder/cone geometry defaults to the Y axis
    mesh.position.copy(dir).multiplyScalar(offset);
    mesh.renderOrder = 1000;
    mesh.userData.isGizmoHandle = true;
    this.object3d.add(mesh);
    this.handles.push({ mesh, kind, baseColor: new THREE.Color(color) });
  }
}
