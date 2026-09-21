import * as THREE from "three";
import { MovementBindings, WASD_BINDINGS, ESDF_BINDINGS } from './movement-bindings.interface';
import { Config } from '../config/cls.config';
import { OrientationGizmo } from './orientation-gizmo';

export type ContextLossHandler = (lost: boolean) => void;
export type FlyStateHandler = (flying: boolean, speed: number) => void;
export type ControlScheme = "esdf" | "wasd";
export type ControlSchemeHandler = (scheme: ControlScheme) => void;
export type CameraProjection = "perspective" | "orthographic";
export type CameraProjectionHandler = (projection: CameraProjection) => void;

const VIEW_TRANSITION_DURATION_MS = 500;

/** Unit direction the main scene's camera looks FROM at startup (see the
 * constructor below) - diagonal, from the positive-x/positive-y/positive-z
 * octant toward the origin. Exported so anything else that wants to match
 * this same "look" (e.g. the small mesh-preview panels in
 * SceneViewerApp.attachMultiMeshPreview() - the resource panel and the
 * "Fix & export" dialog) doesn't have to duplicate the theta/phi numbers
 * and risk drifting out of sync with this one. */
export function getDefaultViewDirection(): THREE.Vector3 {
  const theta = Math.PI * 0.25;
  const phi = Math.PI * 0.35;
  return new THREE.Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta));
}

/** In-flight animated transition to a numpad-triggered view (see
 * startViewTransition()/setAxisView()/viewOppositeDirection()) - `target`
 * never moves during one of these, only offset/quaternion/up, so it's not
 * captured here. */
interface ViewTransition {
  fromOffset: THREE.Vector3;
  toOffset: THREE.Vector3;
  fromQuat: THREE.Quaternion;
  toQuat: THREE.Quaternion;
  fromUp: THREE.Vector3;
  toUp: THREE.Vector3;
  startTime: number;
}

/** Smooth start/end, matching the CSS ease-in-out most UI motion already
 * reads as "natural" - a sharp linear snap over 0.5s reads as mechanical
 * for a camera move this size. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}



// We need scene size limits, otherwise there can be issues with camera and clipping
// (i.e. nothing shows because meshes are beyond clipping distance)
export const MIN_SPAN = 10;
export const MAX_SPAN = 10000;

export function computeNormalizationScale(
  maxDim: number,
  options?: { forceMax?: boolean; maxSpan?: number },
): number {
  const forceMax = options?.forceMax ?? true;
  const maxSpan = options?.maxSpan ?? MAX_SPAN;
  // The upper clamp is the user-configurable "enforce max scene size"
  // option (see importOptions.forceMaxSceneSize/maxSceneSize) - only
  // applied when explicitly requested. The lower clamp always applies:
  // it's not about scene-size preference, it's what keeps a tiny scene
  // from falling below the camera's near-plane precision (see MIN_SPAN's
  // comment above).
  if (forceMax && maxDim > maxSpan) return maxSpan / maxDim;
  if (maxDim > 0 && maxDim < MIN_SPAN) return MIN_SPAN / maxDim;
  return 1;
}

/** Owns the renderer/scene/camera and a hand-rolled Blender-style camera:
 * middle mouse button drags to orbit, Shift+middle mouse button drags to
 * pan, scroll to zoom - plus a first-person fly mode toggled with the
 * physical 'A' key position (ESDF + Space/Ctrl to move, scroll to adjust
 * fly speed instead of zoom while active). No external controls library,
 * since Three.js's example add-ons aren't part of the core npm package. */
export class SceneManager {
  readonly scene: THREE.Scene;
  /** The "control" camera - every orbit/pan/fly/view-snap interaction in
   * this class reads and writes this camera directly, and it's ALWAYS
   * perspective. Orthographic mode (see cameraProjection) doesn't touch
   * any of that: it just mirrors this camera's transform onto a second,
   * purely cosmetic orthographic camera (see syncOrthographicCamera())
   * and renders through that instead - see activeCamera. This means
   * switching projection can never perturb the underlying orbit
   * target/offset state, and flipping back is always exact. */
  readonly camera: THREE.PerspectiveCamera;
  private readonly orthographicCamera: THREE.OrthographicCamera;
  private cameraProjection: CameraProjection = "perspective";
  private cameraProjectionHandlers: CameraProjectionHandler[] = [];
  /** Whatever cameraProjection was set to just before fly mode was
   * entered - restored on exit. See enterFlyMode()/handOffFlyToOrbit(). */
  private preFlyCameraProjection: CameraProjection = "perspective";
  private orientationGizmo: OrientationGizmo;
  readonly renderer: THREE.WebGLRenderer;

  private target = new THREE.Vector3(0, 0, 0);
  // Camera position relative to target. Replaces the old distance/theta/phi
  // spherical-coordinate model - see updateCamera()'s doc comment for why:
  // that model tied camera ORIENTATION to wherever `target` pointed via an
  // unconditional lookAt(), which meant simply changing the pivot (e.g. to
  // re-center rotation/zoom on whatever's under the cursor) would snap the
  // view to stare directly at the new pivot, even though the pivot is
  // deliberately often off-center. This model keeps position (target +
  // offset) and orientation (camera.quaternion) fully independent, so
  // repivoting can never, by construction, touch orientation.
  private offset = new THREE.Vector3(0, 0, 10);
  /** Snapshot of (target, offset) taken the moment placeCameraForImport()
   * last placed the camera - null until an import has actually run. Lets
   * resetToInitialView() ("Reset camera") restore EXACTLY that placement,
   * as opposed to frameOnScene() ("Frame scene"), which recomputes a fresh
   * framing from whatever's CURRENTLY visible and can therefore differ
   * from the original import placement once visibility/filtering has
   * changed. */
  private initialTarget: THREE.Vector3 | null = null;
  private initialOffset: THREE.Vector3 | null = null;
  /** Non-null while a numpad view snap (see setAxisView()/
   * viewOppositeDirection()) is animating - advanced each frame in
   * animate(). Any manual camera input (drag-rotate/pan, wheel zoom, fly
   * mode) cancels it outright rather than blending with it - see the
   * cancellations at the top of the pointerdown/onWheel/enterFlyMode
   * handlers. */
  private viewTransition: ViewTransition | null = null;
  private contentGroup: THREE.Group | null = null;
  private raycaster = new THREE.Raycaster();

  // mouse movement mode (needed for blender-style mouse navigation)
  private mode: "none" | "rotate" | "pan" = "none";
  private lastX = 0;
  private lastY = 0;
  private contextLossHandlers: ContextLossHandler[] = [];
  /** Run every frame, right after the main scene render call - lets a
   * caller (see SceneViewerApp's selection outline) layer extra render
   * passes onto the same canvas/frame without SceneManager needing to know
   * anything about what those passes are. */
  private afterRenderHandlers: Array<() => void> = [];
  /** Run every frame, right BEFORE the main scene render call - for
   * anything that needs its transform brought up to date before that
   * frame is drawn (e.g. SceneViewerApp's select-area gizmo keeping a
   * constant apparent screen size as the camera moves) rather than one
   * frame late, which onAfterRender would cause. */
  private beforeRenderHandlers: Array<() => void> = [];

  // first person/flying mode
  private flying = false;
  private flyPosition = new THREE.Vector3();
  private flyYaw = 0;
  private flyPitch = 0;
  private flySpeed = 5;
  private heldKeys = new Set<string>();
  private lastFrameTime = performance.now();
  private flyStateHandlers: FlyStateHandler[] = [];
  private controlSchemeHandlers: ControlSchemeHandler[] = [];
  private scheme: ControlScheme = "esdf";
  private bindings: MovementBindings = ESDF_BINDINGS;

  private appConfig = Config.getConfig();

  constructor(private container: HTMLElement) {
    // stencil:true is required for the selection outline's mask+ring
    // stencil technique (see buildSelectionOutline() in app.ts) - not
    // guaranteed on by default across three.js versions, so it's requested
    // explicitly rather than relying on whatever the current default is.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e13);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100000);
    // Bounds are recomputed every frame from the control camera (see
    // syncOrthographicCamera()) - the constructor values are placeholders.
    this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100000);
    // Initial view angle, matching the old default (theta=pi/4, phi=0.35pi)
    // - see getDefaultViewDirection(). A one-time lookAt() here is fine -
    // unlike everywhere else in this class, there's no prior orientation
    // to preserve at construction time.
    this.offset.copy(getDefaultViewDirection()).multiplyScalar(10);
    this.updateCamera();
    this.camera.lookAt(this.target);

    this.orientationGizmo = new OrientationGizmo();
    this.orientationGizmo.setProjectionLabel("Perspective");
    container.appendChild(this.orientationGizmo.element);

    window.addEventListener("resize", () => this.resize());
    this.resize();

    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      if (this.flying || e.button !== 1) return;
      e.preventDefault(); // stops the browser's middle-click autoscroll icon
      // Manual input always wins over an in-flight numpad view animation.
      this.viewTransition = null;
      // Re-pivot to whatever's under the cursor RIGHT NOW, once, at the
      // start of this drag - not continuously during it (see
      // repivotAtMouse's doc comment for why).
      this.repivotAtMouse(e.clientX, e.clientY);
      this.mode = e.shiftKey ? "pan" : "rotate";
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener("pointerup", (e) => {
      if (e.button === 1) this.mode = "none";
    });
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.renderer.domElement.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

    this.setupFlyMode();
    this.setupViewControls();

    // needed to handle cases where we run out of GPU memory, or other
    // canvas/context related issues
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      for (const handler of this.contextLossHandlers) handler(true);
    });
    this.renderer.domElement.addEventListener("webglcontextrestored", () => {
      for (const handler of this.contextLossHandlers) handler(false);
    });

    this.animate();

    this.setControlScheme(this.appConfig.config.controls.controlScheme as ControlScheme);
  }

  onContextLoss(handler: ContextLossHandler): void {
    this.contextLossHandlers.push(handler);
  }

  /** Registers a callback to run every frame immediately after the main
   * scene is rendered, before the frame is presented - see
   * afterRenderHandlers' doc comment. Order relative to other handlers
   * isn't guaranteed to matter; there's currently only ever one caller. */
  onAfterRender(handler: () => void): void {
    this.afterRenderHandlers.push(handler);
  }

  /** Registers a callback to run every frame immediately BEFORE the main
   * scene is rendered - see beforeRenderHandlers' doc comment. */
  onBeforeRender(handler: () => void): void {
    this.beforeRenderHandlers.push(handler);
  }

  //#region camera projection (perspective/orthographic) and view snapping
  /** The camera that's actually rendered/raycast against right now -
   * unlike `camera`, which stays perspective at all times, this reflects
   * whichever projection is currently active (see setCameraProjection()).
   * External code that needs to reason about what's actually on screen
   * (raycasting, the outline render pass, the select-area gizmo's
   * screen-space math) should use this rather than `camera`. */
  get activeCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.cameraProjection === "orthographic" ? this.orthographicCamera : this.camera;
  }

  onCameraProjectionChange(handler: CameraProjectionHandler): void {
    this.cameraProjectionHandlers.push(handler);
    handler(this.cameraProjection);
  }

  private notifyCameraProjection(): void {
    for (const handler of this.cameraProjectionHandlers) handler(this.cameraProjection);
  }

  setCameraProjection(projection: CameraProjection): void {
    if (projection === this.cameraProjection) return;
    this.cameraProjection = projection;
    this.orientationGizmo.setProjectionLabel(projection === "orthographic" ? "Orthographic" : "Perspective");
    this.notifyCameraProjection();
  }

  toggleCameraProjection(): void {
    this.setCameraProjection(this.cameraProjection === "orthographic" ? "perspective" : "orthographic");
  }

  /** Recomputes the orthographic camera's position/orientation/frustum
   * from the control camera - called every frame (cheap: a couple of
   * vector copies plus some trig) so it's always ready the instant
   * setCameraProjection() switches to it, with no one-frame lag/pop.
   * The frustum's half-height is deliberately derived the same way a
   * perspective camera's visible height at that distance would be
   * (distance * tan(fov/2)) - this is what makes switching projection
   * keep the same apparent framing instead of jump-cutting to some
   * unrelated default zoom, and it's also why callers elsewhere (e.g.
   * SelectAreaGizmo's constant-screen-size scaling, or pan()'s
   * world-units-per-pixel calc) can keep doing their fov-based math
   * against the perspective `camera` unconditionally, without caring
   * which projection is actually on screen - the two are kept
   * mathematically equivalent by construction. */
  private syncOrthographicCamera(): void {
    const ortho = this.orthographicCamera;
    ortho.position.copy(this.camera.position);
    ortho.quaternion.copy(this.camera.quaternion);
    ortho.up.copy(this.camera.up);

    const distance = this.offset.length() || 1;
    const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const halfWidth = halfHeight * this.camera.aspect;
    ortho.left = -halfWidth;
    ortho.right = halfWidth;
    ortho.top = halfHeight;
    ortho.bottom = -halfHeight;
    ortho.near = this.camera.near;
    ortho.far = this.camera.far;
    ortho.updateProjectionMatrix();
  }

  private setupViewControls(): void {
    window.addEventListener("keydown", (e) => {
      // View-snapping and the ortho/persp toggle only make sense for the
      // orbit camera - while flying, the numpad is left alone entirely
      // (fly mode has its own notion of "where you're looking" that
      // isn't the target/offset model these act on).
      if (e.repeat || this.isTypingInFormField() || this.flying) return;
      switch (e.code) {
        case "Numpad1":
          e.preventDefault();
          this.viewFront();
          break;
        case "Numpad3":
          e.preventDefault();
          this.viewRightSide();
          break;
        case "Numpad7":
          e.preventDefault();
          this.viewTop();
          break;
        case "Numpad9":
          e.preventDefault();
          this.viewOppositeDirection();
          break;
        case "Numpad5":
          e.preventDefault();
          this.toggleCameraProjection();
          break;
      }
    });
  }

  /** Kicks off a VIEW_TRANSITION_DURATION_MS animated move to the given
   * offset/up, leaving `target` untouched - advanced each frame in
   * animate(). The target orientation is worked out via a scratch
   * camera's lookAt() (mirroring exactly what the old instant version
   * did), purely so there's a quaternion to slerp towards; the scratch
   * object itself is discarded immediately; it's never part of the scene. */
  private startViewTransition(targetOffset: THREE.Vector3, targetUp: THREE.Vector3): void {
    // Deliberately THREE.Camera, not THREE.Object3D: Object3D.lookAt()
    // special-cases cameras/lights to point -Z at the target (the
    // convention this.camera itself relies on); for anything else it
    // swaps eye/target under the hood so that object's +Z faces the
    // target instead - a fine convention for e.g. billboarding a sprite,
    // but it hands back a quaternion rotated 180 degrees from what a real
    // camera needs, which used to send the camera facing away from the
    // scene entirely. THREE.Camera is cheap and gets isCamera right.
    const scratch = new THREE.Camera();
    scratch.up.copy(targetUp);
    scratch.position.copy(this.target).add(targetOffset);
    scratch.lookAt(this.target);

    this.viewTransition = {
      fromOffset: this.offset.clone(),
      toOffset: targetOffset.clone(),
      fromQuat: this.camera.quaternion.clone(),
      toQuat: scratch.quaternion.clone(),
      fromUp: this.camera.up.clone(),
      toUp: targetUp.clone(),
      startTime: performance.now(),
    };
  }

  /** Snaps to a fixed axis-aligned view, keeping the current orbit
   * distance and target - a deliberate reorientation (like
   * frameOnScene()). `up` is specified explicitly (rather than left
   * however a previous snap left it) since e.g. top/bottom views need a
   * horizontal up vector to produce a sane, non-degenerate orientation.
   * Also switches to orthographic, since that's what these axis-aligned
   * views are for - measuring/comparing without perspective
   * foreshortening (standard CAD/Blender behavior); viewOppositeDirection()
   * deliberately does NOT do this, since it can be used from a
   * non-axis-aligned view too. The move itself is animated - see
   * startViewTransition(). */
  private setAxisView(direction: THREE.Vector3, up: THREE.Vector3): void {
    const distance = this.offset.length() || 10;
    const targetOffset = direction.clone().normalize().multiplyScalar(distance);
    this.startViewTransition(targetOffset, up);
    this.setCameraProjection("orthographic");
  }

  viewFront(): void {
    this.setAxisView(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  }

  viewRightSide(): void {
    this.setAxisView(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
  }

  viewTop(): void {
    this.setAxisView(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
  }

  /** Orbits 180 degrees around the target, i.e. looks at the same point
   * from exactly the opposite side - works from ANY current view, not
   * just the three axis-aligned ones above, and (since `up` is passed
   * through unchanged) doing this from an axis view lands exactly on that
   * axis's opposite (front<->back, right<->left, top<->bottom) with no
   * incidental roll. The move itself is animated - see
   * startViewTransition(). */
  viewOppositeDirection(): void {
    const targetOffset = this.offset.clone().negate();
    this.startViewTransition(targetOffset, this.camera.up.clone());
  }
  //#endregion

  //#region fly mode handling
  onFlyStateChange(handler: FlyStateHandler): void {
    this.flyStateHandlers.push(handler);
    handler(this.flying, this.flySpeed);
  }

  private notifyFlyState(): void {
    for (const handler of this.flyStateHandlers) handler(this.flying, this.flySpeed);
  }

  onControlSchemeChange(handler: ControlSchemeHandler): void {
    this.controlSchemeHandlers.push(handler);
    handler(this.scheme);
  }

  setControlScheme(scheme: ControlScheme): void {
    if (scheme === this.scheme) return;
    this.scheme = scheme;
    this.bindings = scheme === "wasd" ? WASD_BINDINGS : ESDF_BINDINGS;
    this.heldKeys.clear();
    for (const handler of this.controlSchemeHandlers) handler(this.scheme);
  }

  private movementCodes(): string[] {
    const b = this.bindings;
    return [b.forward, b.back, b.left, b.right, b.up, ...b.down];
  }

  private isTypingInFormField(): boolean {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  }

  setFlying(value: boolean): void {
    if (value === this.flying) return;
    if (value) this.enterFlyMode();
    else this.exitFlyMode();
  }

  private setupFlyMode(): void {
    window.addEventListener("keydown", (e) => {
      if (e.repeat || this.isTypingInFormField()) return;
      if (e.code === this.bindings.flyToggle) {
        this.setFlying(!this.flying);
        return;
      }
      if (this.flying && this.movementCodes().includes(e.code)) {
        this.heldKeys.add(e.code);
        e.preventDefault(); // stop Space from scrolling the page, etc.
      }
    });
    window.addEventListener("keyup", (e) => {
      this.heldKeys.delete(e.code);
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.flying || document.pointerLockElement !== this.renderer.domElement) return;
      const sensitivity = 0.0025;
      this.flyYaw -= e.movementX * sensitivity;
      this.flyPitch -= e.movementY * sensitivity;
      const pitchLimit = Math.PI / 2 - 0.01;
      this.flyPitch = Math.max(-pitchLimit, Math.min(pitchLimit, this.flyPitch));
    });

    // If the pointer lock is released some other way than our own toggle
    // (browsers force this on Escape, alt-tab, etc.), fall back out of fly
    // mode cleanly rather than being stuck flying with no mouse-look.
    document.addEventListener("pointerlockchange", () => {
      if (this.flying && document.pointerLockElement !== this.renderer.domElement) {
        this.flying = false;
        this.handOffFlyToOrbit();
        this.notifyFlyState();
      }
    });
  }

  private enterFlyMode(): void {
    this.flying = true;
    this.heldKeys.clear();
    // Manual input (of which "start flying" counts as one) wins over an
    // in-flight view animation - whatever position/orientation it had
    // reached becomes fly mode's seed below, same as any other orbit state.
    this.viewTransition = null;
    // Fly mode is always perspective - remember whatever projection was
    // active so handOffFlyToOrbit() can restore it on the way out.
    this.preFlyCameraProjection = this.cameraProjection;
    this.setCameraProjection("perspective");
    // Seed fly position/orientation from wherever the orbit camera
    // currently is, so toggling into fly mode doesn't cause a visual jump.
    this.flyPosition.copy(this.camera.position);
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.flyPitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    this.flyYaw = Math.atan2(dir.x, dir.z);
    this.flySpeed = Math.max(this.offset.length() * 0.5, 0.5);
    // Pointer lock can be rejected (needs a user gesture / focused
    // document) - this is called from a keydown/click handler so it
    // normally qualifies, but browsers vary, hence the catch to avoid a
    // noisy unhandled-rejection for something the user can just retry.
    const request = this.renderer.domElement.requestPointerLock();
    if (request && typeof (request as Promise<void>).catch === "function") {
      (request as Promise<void>).catch(() => {
        console.warn("[SceneManager] Pointer lock request was rejected - click the viewport and try again.");
      });
    }
    this.notifyFlyState();
  }

  private exitFlyMode(): void {
    this.flying = false;
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
    this.handOffFlyToOrbit();
    this.notifyFlyState();
  }

  private updateFlyMovement(deltaSeconds: number): void {
    const forward = new THREE.Vector3(
      Math.sin(this.flyYaw) * Math.cos(this.flyPitch),
      Math.sin(this.flyPitch),
      Math.cos(this.flyYaw) * Math.cos(this.flyPitch),
    );
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();

    const move = new THREE.Vector3();
    if (this.heldKeys.has(this.bindings.forward)) move.add(forward);
    if (this.heldKeys.has(this.bindings.back)) move.sub(forward);
    if (this.heldKeys.has(this.bindings.right)) move.add(right);
    if (this.heldKeys.has(this.bindings.left)) move.sub(right);
    if (this.heldKeys.has(this.bindings.up)) move.y += 1;
    if (this.bindings.down.some((code) => this.heldKeys.has(code))) move.y -= 1;

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(this.flySpeed * deltaSeconds);
      this.flyPosition.add(move);
    }

    this.camera.position.copy(this.flyPosition);
    this.camera.lookAt(this.flyPosition.clone().add(forward));
  }
  //#endregion fly mode handling

  /** Reconstructs the orbit camera's target/offset from the fly camera's
   * final position and look direction, so leaving fly mode doesn't snap the
   * view - matches Blender's own fly-mode exit behavior. Places target
   * exactly along the current view direction (i.e. dead center) so that
   * camera.quaternion - already correct, untouched, from fly mode - stays
   * exactly valid without needing a lookAt() call here. */
  private handOffFlyToOrbit(): void {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const distance = this.offset.length() || 1; // preserve prior zoom level across the fly<->orbit transition
    this.target.copy(this.camera.position).addScaledVector(dir, distance);
    this.offset.copy(this.camera.position).sub(this.target);
    this.heldKeys.clear();
    this.updateCamera();
    // Restore whatever projection was active before fly mode forced
    // perspective (see enterFlyMode()) - a no-op if it was already
    // perspective.
    this.setCameraProjection(this.preFlyCameraProjection);
  }

  //#region orbit/pan mode handling
  private onPointerMove(e: PointerEvent): void {
    if (this.mode === "none") return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.mode === "rotate") {
      this.rotateAroundPivot(dx, dy);
    } else {
      this.pan(dx, dy);
    }
  }

  /** Orbits the camera around `target` by revolving BOTH the position
   * (offset) and the camera's own orientation (quaternion) by the same
   * incremental rotation - rather than recomputing position from stored
   * absolute angles and then calling lookAt(). This is what keeps the
   * pivot from "jumping to center": at zero rotation delta nothing changes
   * at all (no snap), and composing the SAME rotation onto both position
   * and orientation preserves how the pivot was framed at the start of the
   * drag as it swings around it. Yaw is always around world-up and pitch
   * around the just-updated local right axis (recomputed after yaw, not
   * cached) - the standard order that avoids any roll drift accumulating
   * over many drags. */
  private rotateAroundPivot(dx: number, dy: number): void {
    const ROTATE_SENSITIVITY = 0.006;
    const worldUp = new THREE.Vector3(0, 1, 0);

    const yawAngle = -dx * ROTATE_SENSITIVITY;
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(worldUp, yawAngle);
    this.offset.applyQuaternion(yawQuat);
    this.camera.quaternion.premultiply(yawQuat);

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const requestedPitchAngle = -dy * ROTATE_SENSITIVITY;

    // Clamp against the CAMERA'S OWN forward direction, not the offset
    // (camera position relative to the pivot) - once the pivot has been
    // re-centered under the cursor (see repivotAtMouse) it's often no
    // longer anywhere near the center of the view, so offset's angle from
    // world-up can stay well clear of the poles while the camera itself
    // keeps pitching straight through vertical, flipping it upside down.
    // Reading the limit off the camera's actual forward vector is correct
    // no matter where the pivot sits on screen. As with fly mode's pitch
    // clamp, only the ALLOWED portion of this drag's pitch is applied (not
    // a hard revert-to-zero), so the camera still eases up to the limit
    // smoothly instead of sticking the instant a drag would cross it -
    // and offset gets that same allowed angle, not the full requested one,
    // so it keeps rotating in lockstep with the orientation.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const currentPitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
    const pitchLimit = Math.PI / 2 - 0.01;
    const clampedPitch = THREE.MathUtils.clamp(currentPitch + requestedPitchAngle, -pitchLimit, pitchLimit);
    const pitchAngle = clampedPitch - currentPitch;

    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(right, pitchAngle);
    this.offset.applyQuaternion(pitchQuat);
    this.camera.quaternion.premultiply(pitchQuat);

    this.updateCamera();
  }

  private pan(dx: number, dy: number): void {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const screenHeight = this.container.clientHeight || 1;
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const worldUnitsPerPixel = (2 * this.offset.length() * Math.tan(fovRad / 2)) / screenHeight;

    this.target.addScaledVector(right, -dx * worldUnitsPerPixel);
    this.target.addScaledVector(up, dy * worldUnitsPerPixel);
    this.updateCamera();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.flying) {
      // Same "scroll up = more" direction as zoom below (scroll up shrinks
      // orbit distance = zooms in = "more"), applied multiplicatively so it
      // feels consistent whether current speed is small or large.
      this.flySpeed = Math.min(1e6, Math.max(0.001, this.flySpeed * (1 - e.deltaY * 0.0012)));
      this.notifyFlyState();
      return;
    }
    // Each wheel tick is its own atomic "movement" (there's no drag to hold
    // a pivot steady across, unlike rotate/pan), so re-pivot every time -
    // this gives the expected "zoom toward whatever's under the cursor"
    // feel rather than always zooming toward a stale point. Critically,
    // repivotAtMouse() only ever touches target/offset, never
    // camera.quaternion - so this can't cause the view to rotate, only to
    // dolly toward/away from wherever the cursor is pointing.
    this.viewTransition = null; // manual input wins over an in-flight view animation
    this.repivotAtMouse(e.clientX, e.clientY);
    const newLength = Math.max(0.01, this.offset.length() * (1 + e.deltaY * 0.0012));
    this.offset.setLength(newLength);
    this.updateCamera();
  }

  /** Re-centers the orbit pivot (target/offset) on whatever scene geometry
   * is directly under the given screen position, via a raycast - WITHOUT
   * moving OR reorienting the camera at all: offset is recomputed from the
   * camera's CURRENT (unchanged) position relative to the new target, and
   * camera.quaternion isn't touched here at all (this model keeps
   * orientation fully independent of target/offset - see updateCamera()).
   * This is deliberately called once at the start of a rotate/pan drag or
   * on each individual wheel tick - never continuously during an ongoing
   * drag, which would make the pivot drift mid-gesture instead of staying
   * put for it. If the ray doesn't hit anything (e.g. empty space, or
   * nothing's been loaded yet), the current pivot is left exactly as it
   * was - there's nothing sensible to fall back to that isn't just
   * guessing. Selection-highlight overlays (outline shell, center-point
   * markers) are excluded from the hit test via their userData tag, so the
   * pivot always lands on actual mesh surface, not on outline geometry
   * that's been pushed outward from it. */
  private repivotAtMouse(clientX: number, clientY: number): void {
    const hit = this.raycastAtMouse(clientX, clientY);
    if (!hit) return;

    const newOffset = this.camera.position.clone().sub(hit);
    if (newOffset.lengthSq() < 1e-12) return; // camera is essentially AT the hit point - degenerate

    this.target.copy(hit);
    this.offset.copy(newOffset);
  }

  private raycastAtMouse(clientX: number, clientY: number): THREE.Vector3 | null {
    const group = this.contentGroup;
    if (!group) return null;

    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.activeCamera);

    const targets = group.children.filter((child) => !child.userData?.isSelectionVisual);
    const hits = this.raycaster.intersectObjects(targets, true);
    return hits.length > 0 ? hits[0].point.clone() : null;
  }

  /** Repositions the camera from target+offset. Deliberately does NOT call
   * lookAt() - orientation is maintained independently (by
   * rotateAroundPivot()'s incremental quaternion composition, or fly
   * mode's own yaw/pitch), which is exactly what lets target/offset change
   * (via repivotAtMouse or pan) without ever moving or reorienting the
   * camera as a side effect. */
  private updateCamera(): void {
    this.camera.position.copy(this.target).add(this.offset);
  }

  /** Advances the in-flight numpad view animation, if any - called once a
   * frame. `target` is never touched (see ViewTransition's doc comment);
   * only offset/quaternion/up are interpolated, then updateCamera() folds
   * the new offset back into camera.position the same way every other
   * camera-moving method here does. */
  private updateViewTransition(): void {
    const transition = this.viewTransition;
    if (!transition) return;
    const t = Math.min((performance.now() - transition.startTime) / VIEW_TRANSITION_DURATION_MS, 1);
    const eased = easeInOutCubic(t);

    this.offset.lerpVectors(transition.fromOffset, transition.toOffset, eased);
    this.camera.quaternion.slerpQuaternions(transition.fromQuat, transition.toQuat, eased);
    this.camera.up.lerpVectors(transition.fromUp, transition.toUp, eased).normalize();
    this.updateCamera();

    if (t >= 1) this.viewTransition = null;
  }

  //#endregion

  resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Wraps the given meshes in a single Group and applies the given uniform
   * scale, then adds it to the scene. The scale is computed by the caller
   * (see computeNormalizationScale()) from the FULL set of loaded draws,
   * not just whatever's passed in here - when the "hide largest %" filter
   * is active, meshes will only be a subset of everything that was loaded,
   * and measuring scale from just the visible subset would make the scene
   * rescale (and camera jump) every time the filter slider moves. Returns
   * the group so the caller can attach additional objects (e.g. selection
   * highlight overlays) that need to live in the same transform space -
   * see getContentGroup(). */
  addContent(meshes: THREE.Mesh[], scale: number): THREE.Group {
    const group = new THREE.Group();
    for (const mesh of meshes) group.add(mesh);
    group.scale.setScalar(scale);
    this.scene.add(group);
    this.contentGroup = group;
    return group;
  }

  /** The group created by the most recent addContent() call, or null if
   * clear() has been called since (or addContent() was never called). Used
   * by the caller to attach objects that need the same scale/position space
   * as the loaded content, without re-deriving the normalization scale. */
  getContentGroup(): THREE.Group | null {
    return this.contentGroup;
  }

  /** Resets to a fixed default viewing angle framing the whole scene - a
   * deliberate full view reset (unlike repivotAtMouse), so unconditionally
   * reorienting via lookAt() here is intentional and correct, not a case of
   * the snap-to-pivot bug this class otherwise avoids. The "Frame scene"
   * button's own behavior - see resetToInitialView() ("Reset camera") for
   * the sibling operation that restores the original import placement
   * instead of recomputing a fresh one from the current scene bounds. */
  frameOnScene(): void {
    const box = new THREE.Box3().setFromObject(this.scene);
    if (box.isEmpty()) return;
    // Reframing is itself an instant, unconditional move - cancel any
    // in-flight numpad view animation rather than have it fight this.
    this.viewTransition = null;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const distance = maxDim * 1.2;

    const theta = Math.PI * 0.25;
    const phi = Math.PI * 0.35;
    this.target.copy(center);
    this.offset.set(
      distance * Math.sin(phi) * Math.sin(theta),
      distance * Math.cos(phi),
      distance * Math.sin(phi) * Math.cos(theta),
    );
    // A view-snap (setAxisView(), for the numpad top/bottom views) may
    // have left `up` pointing along a horizontal axis - reset it before
    // this lookAt() so this always reproduces the same default framing
    // regardless of whatever view was active beforehand.
    this.camera.up.set(0, 1, 0);
    this.updateCamera();
    this.camera.lookAt(this.target);
  }

  /** Places the camera once, right after import (see reconstructScene()) -
   * distinct from frameOnScene(), which resets to the class's own default
   * viewing angle centered on the box's center and is reachable any time
   * via "Frame scene", and from resetToInitialView() ("Reset camera"),
   * which restores exactly THIS placement rather than recomputing a fresh
   * one. This instead always sits on the diagonal through the +x/+y/+z
   * octant and always looks through the scene ORIGIN (not the bounding
   * box's center - an off-center import should still be viewed from a
   * predictable, origin-relative angle), placed far enough back that a
   * sphere centered on the origin and reaching every corner of the
   * scene's bounding box is fully inside the frustum, times `padding`. If
   * `maxDistance` is given (the "enforce initial scale limit" option),
   * the camera is pulled in to at most that distance - it's fine, and
   * expected, for it to end up closer. */
  placeCameraForImport(padding: number = 1.2, maxDistance?: number): void {
    const box = new THREE.Box3().setFromObject(this.scene);
    if (box.isEmpty()) return;
    this.viewTransition = null;

    // Farthest distance from the ORIGIN (not the box center) to any
    // corner of the bounding box - the radius of the smallest
    // origin-centered sphere that fully contains the scene.
    let radius = 0;
    for (let xi = 0; xi < 2; xi++) {
      for (let yi = 0; yi < 2; yi++) {
        for (let zi = 0; zi < 2; zi++) {
          const corner = new THREE.Vector3(
            xi ? box.max.x : box.min.x,
            yi ? box.max.y : box.min.y,
            zi ? box.max.z : box.min.z,
          );
          radius = Math.max(radius, corner.length());
        }
      }
    }
    if (radius <= 0) radius = MIN_SPAN * 0.5;

    // Fit that sphere within whichever of the vertical/horizontal FOV is
    // tighter for the current aspect ratio - same reasoning as the
    // resource-panel thumbnail's computeFitDistance(), just for a sphere
    // (distance*sin(halfAngle) = radius) instead of a flat plane.
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const limitingFov = Math.min(vFov, hFov);
    let distance = radius / Math.sin(limitingFov / 2);
    distance *= padding;

    if (maxDistance !== undefined && Number.isFinite(maxDistance) && maxDistance > 0) {
      distance = Math.min(distance, maxDistance);
    }

    const dir = new THREE.Vector3(1, 1, 1).normalize();
    this.target.set(0, 0, 0);
    this.offset.copy(dir).multiplyScalar(distance);
    this.camera.up.set(0, 1, 0);
    this.updateCamera();
    this.camera.lookAt(this.target);

    // Snapshot for resetToInitialView() ("Reset camera") to restore later -
    // see initialTarget/initialOffset's own doc comment.
    this.initialTarget = this.target.clone();
    this.initialOffset = this.offset.clone();
  }

  /** Restores the camera to exactly where placeCameraForImport() last put
   * it - "Reset camera"'s own distinct behavior, as opposed to "Frame
   * scene" (frameOnScene()), which recomputes a fresh framing from
   * whatever's CURRENTLY visible instead of reproducing the original
   * placement. No-op before anything's been imported (initialTarget/
   * initialOffset are only ever set by placeCameraForImport()). */
  resetToInitialView(): void {
    if (!this.initialTarget || !this.initialOffset) return;
    this.viewTransition = null;
    this.target.copy(this.initialTarget);
    this.offset.copy(this.initialOffset);
    this.camera.up.set(0, 1, 0);
    this.updateCamera();
    this.camera.lookAt(this.target);
  }

  clear(): void {
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const obj = this.scene.children[i];
      this.scene.remove(obj);

      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
    }
    this.contentGroup = null;
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const now = performance.now();
    // Clamp so e.g. returning to a backgrounded tab doesn't teleport the
    // fly camera using a huge accumulated delta.
    const deltaSeconds = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    if (this.flying) this.updateFlyMovement(deltaSeconds);
    this.updateViewTransition();
    this.syncOrthographicCamera();
    this.orientationGizmo.update(this.activeCamera);

    for (const handler of this.beforeRenderHandlers) handler();
    this.renderer.render(this.scene, this.activeCamera);
    for (const handler of this.afterRenderHandlers) handler();
  };
}
