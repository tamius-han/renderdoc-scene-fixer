import * as THREE from "three";

export type ContextLossHandler = (lost: boolean) => void;
export type FlyStateHandler = (flying: boolean, speed: number) => void;

// If the camera's fixed near/far planes (see the PerspectiveCamera below)
// don't roughly match the scene's actual coordinate magnitude, everything
// ends up clipped - the canvas renders (GPU stays busy) but shows nothing,
// with no error of any kind. Exported coordinates can come out at very
// different absolute scales depending on the capture (this is especially
// true for reconstructed posed meshes, which carry an unknown-but-uniform
// scale factor - see the RenderDoc extension's own README), so rather than
// widen the clip planes indefinitely (which just trades the problem for
// depth-precision/z-fighting issues instead), the scene is normalized into
// a known-good range up front.
export const MIN_SPAN = 10;
export const MAX_SPAN = 10000;

/** Given the largest axis of a bounding box, returns the uniform scale
 * factor needed to bring it into [MIN_SPAN, MAX_SPAN]. 1 if it's already
 * in range. This is intentionally a pure function taking just a number
 * (not a Three.js Box3/Object3D) - the "hide largest % of objects" filter
 * needs this computed from *all* loaded draws regardless of which are
 * currently hidden, so the normalization scale stays fixed as the filter
 * changes rather than jittering every time the slider moves. */
export function computeNormalizationScale(maxDim: number): number {
  if (maxDim > MAX_SPAN) return MAX_SPAN / maxDim;
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
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private target = new THREE.Vector3(0, 0, 0);
  private distance = 10;
  private theta = Math.PI * 0.25;
  private phi = Math.PI * 0.35;
  /** Blender-style navigation: only the middle mouse button drives the
   * orbit camera at all. Shift+middle pans instead of orbiting. Which mode a
   * drag is doing is decided once at pointerdown and held for the whole
   * drag, rather than re-checked live on every move, so releasing/pressing
   * Shift mid-drag doesn't switch modes underneath you. */
  private mode: "none" | "rotate" | "pan" = "none";
  private lastX = 0;
  private lastY = 0;
  private contextLossHandlers: ContextLossHandler[] = [];

  // --- First-person fly mode -----------------------------------------
  // A completely separate camera model from the orbit one above: the
  // camera has its own free position and yaw/pitch instead of orbiting a
  // target at a fixed distance. Toggled with the physical 'A' key
  // (KeyboardEvent.code, not .key - .code reports the PHYSICAL key
  // position regardless of the OS keyboard layout, e.g. it stays "KeyA"
  // even on AZERTY where that position prints 'Q'. This is what keeps
  // ESDF movement in the same physical spot for AZERTY/QWERTZ users
  // instead of moving wherever "e/s/d/f" happen to be printed on their
  // layout, or worse, landing on punctuation).
  private flying = false;
  private flyPosition = new THREE.Vector3();
  private flyYaw = 0;
  private flyPitch = 0;
  private flySpeed = 5;
  private heldKeys = new Set<string>();
  private lastFrameTime = performance.now();
  private flyStateHandlers: FlyStateHandler[] = [];

  private static readonly FLY_TOGGLE_KEY = "KeyA";
  // ESDF: WASD shifted one column right on a QWERTY row - E/forward,
  // S/left, D/back, F/right - a common alternative to WASD.
  private static readonly KEY_FORWARD = "KeyE";
  private static readonly KEY_BACK = "KeyD";
  private static readonly KEY_LEFT = "KeyS";
  private static readonly KEY_RIGHT = "KeyF";
  private static readonly KEY_UP = "Space";
  private static readonly KEYS_DOWN = ["ControlLeft", "ControlRight"];
  private static readonly MOVEMENT_CODES = [
    SceneManager.KEY_FORWARD,
    SceneManager.KEY_BACK,
    SceneManager.KEY_LEFT,
    SceneManager.KEY_RIGHT,
    SceneManager.KEY_UP,
    ...SceneManager.KEYS_DOWN,
  ];

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e13);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100000);
    this.updateCamera();

    window.addEventListener("resize", () => this.resize());
    this.resize();

    // Blender-style controls: middle mouse button only. Left/right/other
    // buttons intentionally do nothing here - browser defaults (e.g. right-
    // click context menu) are left alone rather than suppressed. All of
    // this is skipped while flying, where mouse movement is used directly
    // for looking around via the Pointer Lock API instead - see below.
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      if (this.flying || e.button !== 1) return;
      e.preventDefault(); // stops the browser's middle-click autoscroll icon
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

    // Surfacing context loss explicitly matters here: on a scene with
    // thousands of draws, running out of GPU memory causes exactly this
    // event, and without handling it the canvas just goes black with no
    // indication of why - see textureManager.ts and meshBuilder.ts for the
    // actual fixes that reduce GPU memory/draw-call pressure.
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      for (const handler of this.contextLossHandlers) handler(true);
    });
    this.renderer.domElement.addEventListener("webglcontextrestored", () => {
      for (const handler of this.contextLossHandlers) handler(false);
    });

    this.animate();
  }

  onContextLoss(handler: ContextLossHandler): void {
    this.contextLossHandlers.push(handler);
  }

  /** Registers a listener for fly-mode state (on/off) and speed changes -
   * fired whenever either changes, from any trigger (the 'A' key, a UI
   * toggle via setFlying(), or scroll-to-adjust-speed while flying). Called
   * once immediately with the current state so the UI can initialize
   * without a separate query method. */
  onFlyStateChange(handler: FlyStateHandler): void {
    this.flyStateHandlers.push(handler);
    handler(this.flying, this.flySpeed);
  }

  private notifyFlyState(): void {
    for (const handler of this.flyStateHandlers) handler(this.flying, this.flySpeed);
  }

  /** Programmatic equivalent of pressing 'A' - lets a UI toggle (checkbox,
   * button, etc.) drive fly mode directly, kept in sync with the keyboard
   * shortcut via onFlyStateChange(). No-ops if already in the requested
   * state. */
  setFlying(value: boolean): void {
    if (value === this.flying) return;
    if (value) this.enterFlyMode();
    else this.exitFlyMode();
  }

  private isTypingInFormField(): boolean {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  }

  private setupFlyMode(): void {
    window.addEventListener("keydown", (e) => {
      if (e.repeat || this.isTypingInFormField()) return;
      if (e.code === SceneManager.FLY_TOGGLE_KEY) {
        this.setFlying(!this.flying);
        return;
      }
      if (this.flying && SceneManager.MOVEMENT_CODES.includes(e.code)) {
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
    // Seed fly position/orientation from wherever the orbit camera
    // currently is, so toggling into fly mode doesn't cause a visual jump.
    this.flyPosition.copy(this.camera.position);
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.flyPitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    this.flyYaw = Math.atan2(dir.x, dir.z);
    this.flySpeed = Math.max(this.distance * 0.5, 0.5);
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

  /** Reconstructs the orbit camera's target/theta/phi from the fly camera's
   * final position and look direction, so leaving fly mode doesn't snap the
   * view - matches Blender's own fly-mode exit behavior. */
  private handOffFlyToOrbit(): void {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.target.copy(this.camera.position).addScaledVector(dir, this.distance);
    const offset = this.camera.position.clone().sub(this.target);
    this.phi = Math.acos(Math.max(-1, Math.min(1, offset.y / this.distance)));
    this.theta = Math.atan2(offset.x, offset.z);
    this.heldKeys.clear();
    this.updateCamera();
  }

  /** Moves the fly camera this frame based on currently-held keys. Forward/
   * back/strafe move in true 3D relative to the current look direction
   * (this is a "fly", not a ground-constrained "walk" - looking up and
   * pressing forward flies upward); Space/Ctrl always move along the
   * absolute world vertical regardless of look direction, matching most
   * games' convention of keeping up/down independent of pitch. */
  private updateFlyMovement(deltaSeconds: number): void {
    const forward = new THREE.Vector3(
      Math.sin(this.flyYaw) * Math.cos(this.flyPitch),
      Math.sin(this.flyPitch),
      Math.cos(this.flyYaw) * Math.cos(this.flyPitch),
    );
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();

    const move = new THREE.Vector3();
    if (this.heldKeys.has(SceneManager.KEY_FORWARD)) move.add(forward);
    if (this.heldKeys.has(SceneManager.KEY_BACK)) move.sub(forward);
    if (this.heldKeys.has(SceneManager.KEY_RIGHT)) move.add(right);
    if (this.heldKeys.has(SceneManager.KEY_LEFT)) move.sub(right);
    if (this.heldKeys.has(SceneManager.KEY_UP)) move.y += 1;
    if (SceneManager.KEYS_DOWN.some((code) => this.heldKeys.has(code))) move.y -= 1;

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(this.flySpeed * deltaSeconds);
      this.flyPosition.add(move);
    }

    this.camera.position.copy(this.flyPosition);
    this.camera.lookAt(this.flyPosition.clone().add(forward));
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.mode === "none") return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.mode === "rotate") {
      this.theta -= dx * 0.006;
      this.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.phi - dy * 0.006));
      this.updateCamera();
    } else {
      this.pan(dx, dy);
    }
  }

  /** Translates the orbit target (and with it, the camera) within the
   * camera's own view plane - i.e. perpendicular to the view direction,
   * matching Blender's Ctrl+MMB pan. Scaled by distance and vertical FOV so
   * panning feels like dragging the scene under the cursor at any zoom
   * level, not a fixed world-space speed. */
  private pan(dx: number, dy: number): void {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const screenHeight = this.container.clientHeight || 1;
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const worldUnitsPerPixel = (2 * this.distance * Math.tan(fovRad / 2)) / screenHeight;

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
    this.distance = Math.max(0.01, this.distance * (1 + e.deltaY * 0.0012));
    this.updateCamera();
  }

  private updateCamera(): void {
    const x = this.target.x + this.distance * Math.sin(this.phi) * Math.sin(this.theta);
    const y = this.target.y + this.distance * Math.cos(this.phi);
    const z = this.target.z + this.distance * Math.sin(this.phi) * Math.cos(this.theta);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

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
   * rescale (and camera jump) every time the filter slider moves. */
  addContent(meshes: THREE.Mesh[], scale: number): void {
    const group = new THREE.Group();
    for (const mesh of meshes) group.add(mesh);
    group.scale.setScalar(scale);
    this.scene.add(group);
  }

  frameOnScene(): void {
    const box = new THREE.Box3().setFromObject(this.scene);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    this.target.copy(center);
    this.distance = maxDim * 1.6;
    this.updateCamera();
  }

  clear(): void {
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const obj = this.scene.children[i];
      this.scene.remove(obj);
      // Recursive traverse rather than checking `obj` itself: addContent()
      // wraps meshes in a Group, so the direct scene child usually isn't a
      // Mesh itself. Only geometry is disposed here - materials are cached/
      // shared by the caller across repeated rebuilds (e.g. every time the
      // "hide largest %" filter slider moves), so the caller is responsible
      // for disposing those only when actually done with them, not on every
      // rebuild.
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const now = performance.now();
    // Clamp so e.g. returning to a backgrounded tab doesn't teleport the
    // fly camera using a huge accumulated delta.
    const deltaSeconds = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    if (this.flying) this.updateFlyMovement(deltaSeconds);

    this.renderer.render(this.scene, this.camera);
  };
}
