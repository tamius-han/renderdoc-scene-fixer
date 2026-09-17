import * as THREE from "three";

export type GizmoMode = "translate" | "scale";
export type GizmoAxis = "x" | "y" | "z";

export type GizmoHandleKind =
  | { type: "axis"; axis: GizmoAxis }
  | { type: "plane"; axes: [GizmoAxis, GizmoAxis] }
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
// Half as thick as before (was 0.045) - drives the arrow shaft/cone radius,
// the scale-mode box tip size, and the center ring's tube thickness (see
// buildHandles() below) all at once, without touching any of the LENGTHS
// (AXIS_LEN, PLANE_SIZE/OFFSET, RING_RADIUS) - so the gizmo's overall reach
// on screen is unchanged, just visually thinner.
const HANDLE_RADIUS = 0.0225;
const PLANE_SIZE = AXIS_LEN * 0.22;
const PLANE_OFFSET = AXIS_LEN * 0.32;
const RING_RADIUS = AXIS_LEN * 0.18;

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
 * (content-group-space) offset from originWorld - used to drive plane-
 * handle and center-handle (free move) drags, where up to 2-3 components
 * matter rather than a single scalar. */
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

/** Hand-rolled in-scene translate/scale gizmo (axis arrows, plane squares,
 * and a center free-move/uniform-scale ring) for the select-area tool's
 * placed shape - see SceneViewerApp's placeSelectAreaShape(). Deliberately
 * NOT three.js's official TransformControls addon: SceneManager already
 * avoids three/examples/jsm add-ons on purpose (see its own doc comment),
 * so this follows that same house convention rather than introducing the
 * first exception.
 *
 * Lives as a CHILD OF THE SAME content group the target itself is a child
 * of (the caller is responsible for adding object3d there and keeping it
 * there across a scene rebuild - see app.ts's restoreSelectAreaShape()),
 * so the gizmo's own local axes are simply the target's local X/Y/Z. That
 * means none of the drag math below needs to know anything about the
 * target's OWN rotation (there isn't one - the shape never rotates, only
 * translates/scales) - only the content group's rotation/scale, passed
 * into every method that needs it, is ever involved. */
export class SelectAreaGizmo {
  readonly object3d = new THREE.Group();

  private mode: GizmoMode;
  private readonly target: THREE.Object3D;
  private handles: GizmoHandle[] = [];
  private highlighted: GizmoHandle | null = null;
  private minScale = 1e-6;

  // Drag state - only meaningful while dragHandle is non-null.
  private dragHandle: GizmoHandle | null = null;
  private readonly dragStartPosition = new THREE.Vector3();
  private readonly dragStartScale = new THREE.Vector3();
  private readonly dragPlane = new THREE.Plane();
  private readonly dragAxisWorld = new THREE.Vector3();
  private dragStartT = 0;
  private readonly dragStartLocalOffset = new THREE.Vector3();
  private readonly dragStartScreenOrigin = new THREE.Vector2();
  private dragStartScreenDistance = 1;

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

  /** Smallest value a scale axis is allowed to shrink to while dragging -
   * the caller derives this from the loaded scene's own size (see
   * app.ts's overallLocalBounds()) so it stays meaningful across wildly
   * different scene scales, same as the old slider UI's scaleMin did. */
  setMinScale(min: number): void {
    this.minScale = Math.max(min, 1e-9);
  }

  /** Call every frame (see SceneManager.onBeforeRender()): re-centers the
   * gizmo on the target (in their shared parent's local space, so this is
   * a direct copy - no cross-space conversion needed) and rescales it for
   * a constant apparent screen size regardless of camera distance or the
   * target's own current scale, plus keeps the center ring facing the
   * camera. groupQuat/groupScale are the content group's current
   * rotation/(uniform) scale - passed in rather than looked up here so
   * this class doesn't need to know about SceneManager/contentGroup at
   * all. */
  update(camera: THREE.PerspectiveCamera, groupQuat: THREE.Quaternion, groupScale: number): void {
    this.object3d.position.copy(this.target.position);

    const worldPos = this.target.position.clone().applyQuaternion(groupQuat).multiplyScalar(groupScale);
    const distance = Math.max(camera.position.distanceTo(worldPos), 1e-6);
    const vFov = (camera.fov * Math.PI) / 180;
    const desiredWorldSize = 2 * distance * Math.tan(vFov / 2) * SCREEN_FRACTION;
    this.object3d.scale.setScalar(desiredWorldSize / Math.max(groupScale, 1e-9));

    const ring = this.handles.find((handle) => handle.kind.type === "center")?.mesh;
    if (ring) {
      const camDirWorld = camera.position.clone().sub(worldPos);
      const camDirLocal = camDirWorld.applyQuaternion(groupQuat.clone().invert()).normalize();
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
   * position/scale as they stood at drag start, plus whichever
   * plane/axis/screen-space reference frame that kind of handle drags
   * against - see the per-kind comments below and updateDrag()). */
  beginDrag(
    handle: GizmoHandle,
    raycaster: THREE.Raycaster,
    camera: THREE.PerspectiveCamera,
    groupQuat: THREE.Quaternion,
    groupScale: number,
    canvasRect: DOMRect,
    mouseClientX: number,
    mouseClientY: number,
  ): void {
    this.dragHandle = handle;
    this.dragStartPosition.copy(this.target.position);
    this.dragStartScale.copy(this.target.scale);
    this.setHighlight(handle);

    const originWorld = this.dragStartPosition.clone().applyQuaternion(groupQuat).multiplyScalar(groupScale);

    if (handle.kind.type === "axis") {
      // Constrain the drag to a plane that CONTAINS the axis line and is
      // oriented to face the camera as squarely as possible (standard
      // technique - keeps the ray/plane intersection well-conditioned
      // instead of degenerating at grazing angles): remove the
      // along-axis component of the eye vector, so what's left is
      // perpendicular to the axis and points "at" the camera.
      const axisWorld = axisVector(handle.kind.axis).applyQuaternion(groupQuat).normalize();
      this.dragAxisWorld.copy(axisWorld);
      const eye = camera.position.clone().sub(originWorld).normalize();
      let normal = axisWorld.clone().multiplyScalar(axisWorld.dot(eye)).sub(eye);
      if (normal.lengthSq() < 1e-8) normal = new THREE.Vector3().crossVectors(axisWorld, camera.up);
      if (normal.lengthSq() < 1e-8) normal = new THREE.Vector3().crossVectors(axisWorld, new THREE.Vector3(1, 0, 0));
      normal.normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(normal, originWorld);
      this.dragStartT = rayPlaneAxisT(raycaster, this.dragPlane, originWorld, axisWorld);
    } else if (handle.kind.type === "plane") {
      const normalWorld = axisVector(thirdAxis(...handle.kind.axes)).applyQuaternion(groupQuat).normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(normalWorld, originWorld);
      this.dragStartLocalOffset.copy(rayPlaneLocalOffset(raycaster, this.dragPlane, originWorld, groupQuat, groupScale));
    } else if (this.mode === "translate") {
      // Center handle, translate mode: free move within the camera's own
      // view plane (screen-parallel), through the object's current
      // position - drag anywhere and the shape follows the cursor.
      const normalWorld = camera.getWorldDirection(new THREE.Vector3());
      this.dragPlane.setFromNormalAndCoplanarPoint(normalWorld, originWorld);
      this.dragStartLocalOffset.copy(rayPlaneLocalOffset(raycaster, this.dragPlane, originWorld, groupQuat, groupScale));
    } else {
      // Center handle, scale mode: uniform scale via the on-screen PIXEL
      // distance from the gizmo's projected center - simpler and just as
      // intuitive as a 3D ray/plane approach for a "drag out to grow, in
      // to shrink" handle, and sidesteps degenerate cases entirely.
      const originNdc = originWorld.clone().project(camera);
      this.dragStartScreenOrigin.set(
        ((originNdc.x + 1) / 2) * canvasRect.width + canvasRect.left,
        ((1 - originNdc.y) / 2) * canvasRect.height + canvasRect.top,
      );
      this.dragStartScreenDistance = Math.max(
        Math.hypot(mouseClientX - this.dragStartScreenOrigin.x, mouseClientY - this.dragStartScreenOrigin.y),
        1,
      );
    }
  }

  /** Continues an in-progress drag (no-op if nothing's being dragged) -
   * call on every pointermove while isDragging() is true. Mutates the
   * target's position/scale directly. */
  updateDrag(
    raycaster: THREE.Raycaster,
    camera: THREE.PerspectiveCamera,
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
      if (this.mode === "translate") this.target.position[axis] = this.dragStartPosition[axis] + deltaLocal;
      else this.target.scale[axis] = Math.max(this.dragStartScale[axis] + deltaLocal, this.minScale);
      return;
    }

    if (handle.kind.type === "plane") {
      const [a, b] = handle.kind.axes;
      const offset = rayPlaneLocalOffset(raycaster, this.dragPlane, originWorld, groupQuat, groupScale);
      const da = offset[a] - this.dragStartLocalOffset[a];
      const db = offset[b] - this.dragStartLocalOffset[b];
      if (this.mode === "translate") {
        this.target.position[a] = this.dragStartPosition[a] + da;
        this.target.position[b] = this.dragStartPosition[b] + db;
      } else {
        this.target.scale[a] = Math.max(this.dragStartScale[a] + da, this.minScale);
        this.target.scale[b] = Math.max(this.dragStartScale[b] + db, this.minScale);
      }
      return;
    }

    // Center handle.
    if (this.mode === "translate") {
      const offset = rayPlaneLocalOffset(raycaster, this.dragPlane, originWorld, groupQuat, groupScale);
      this.target.position.x = this.dragStartPosition.x + (offset.x - this.dragStartLocalOffset.x);
      this.target.position.y = this.dragStartPosition.y + (offset.y - this.dragStartLocalOffset.y);
      this.target.position.z = this.dragStartPosition.z + (offset.z - this.dragStartLocalOffset.z);
    } else {
      const dist = Math.max(
        Math.hypot(mouseClientX - this.dragStartScreenOrigin.x, mouseClientY - this.dragStartScreenOrigin.y),
        1,
      );
      const ratio = dist / this.dragStartScreenDistance;
      this.target.scale.x = Math.max(this.dragStartScale.x * ratio, this.minScale);
      this.target.scale.y = Math.max(this.dragStartScale.y * ratio, this.minScale);
      this.target.scale.z = Math.max(this.dragStartScale.z * ratio, this.minScale);
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
