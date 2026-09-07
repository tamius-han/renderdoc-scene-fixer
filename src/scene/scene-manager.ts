import * as THREE from "three";

export type ContextLossHandler = (lost: boolean) => void;

export interface SceneExtent {
  /** Bounding box size of the content as originally loaded, before any
   * normalization scale was applied. */
  rawSize: THREE.Vector3;
  /** Uniform scale factor applied to fit rawSize into [MIN_SPAN, MAX_SPAN]
   * on its largest axis. 1 if no scaling was needed. */
  scale: number;
  /** rawSize * scale - the extent actually visible in the scene. */
  scaledSize: THREE.Vector3;
}

// If the camera's fixed near/far planes (see the PerspectiveCamera below)
// don't roughly match the scene's actual coordinate magnitude, everything
// ends up clipped - the canvas renders (GPU stays busy) but shows nothing,
// with no error of any kind. Exported coordinates can come out at very
// different absolute scales depending on the capture (this is especially
// true for reconstructed posed meshes, which carry an unknown-but-uniform
// scale factor - see the RenderDoc extension's own README), so rather than
// widen the clip planes indefinitely (which just trades the problem for
// depth-precision/z-fighting issues instead), addContent() below normalizes
// whatever comes in in to a known-good range up front.
const MIN_SPAN = 10;
const MAX_SPAN = 10000;

/** Owns the renderer/scene/camera and a hand-rolled orbit camera (drag to
 * rotate, scroll to zoom) - no external controls library, since Three.js's
 * example add-ons aren't part of the core npm package. */
export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private target = new THREE.Vector3(0, 0, 0);
  private distance = 10;
  private theta = Math.PI * 0.25;
  private phi = Math.PI * 0.35;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private contextLossHandlers: ContextLossHandler[] = [];

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

    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener("pointerup", () => (this.dragging = false));
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.renderer.domElement.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

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

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.theta -= dx * 0.006;
    this.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.phi - dy * 0.006));
    this.updateCamera();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
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

  /** Wraps the given meshes in a single Group, measures their combined
   * bounding box, and applies a uniform scale so the largest axis lands
   * within [MIN_SPAN, MAX_SPAN] - keeping the scene within a range the
   * camera's fixed near/far planes can actually see, regardless of the
   * absolute coordinate magnitude the source data came in at. Returns the
   * measured extent (both before and after scaling) so the caller can
   * display it. */
  addContent(meshes: THREE.Mesh[]): SceneExtent {
    const group = new THREE.Group();
    for (const mesh of meshes) group.add(mesh);

    let rawSize = new THREE.Vector3();
    let scale = 1;

    const box = new THREE.Box3().setFromObject(group);
    if (!box.isEmpty()) {
      rawSize = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z);
      if (maxDim > MAX_SPAN) scale = MAX_SPAN / maxDim;
      else if (maxDim > 0 && maxDim < MIN_SPAN) scale = MIN_SPAN / maxDim;
    }

    group.scale.setScalar(scale);
    this.scene.add(group);

    return { rawSize, scale, scaledSize: rawSize.clone().multiplyScalar(scale) };
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
      // Mesh itself.
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
          else child.material.dispose();
        }
      });
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.renderer.render(this.scene, this.camera);
  };
}
