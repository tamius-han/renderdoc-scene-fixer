import * as THREE from "three";
import { collectFromDrop, collectFromInput, dirname, joinPath, VirtualFileSystem } from "./filesystem";
import { loadManifests, type LoadedManifests } from "./manifest";
import { parseMTL } from "./parsers/mtl";
import { parseOBJ } from "./parsers/obj";
import {
  boundsCenter,
  boundsDiagonal,
  computeBounds,
  objToGeometryArrays,
  SceneMeshBuilder,
  unionBounds,
  type Bounds,
  type GeometryArrays,
} from "./scene/mesh-builder";
import { computeNormalizationScale, SceneManager } from "./scene/scene-manager";
import { SelectAreaGizmo, type GizmoMode } from "./scene/select-area-gizmo";
import { TextureManager } from "./scene/texture-manager";
import type { DrawEntry, PassIndexEntry, PassManifest } from "./types";
import { calculateDistortionMatrix, type HandednessMode } from "./mesh-tools/calculator";
import { CaptureImporter } from './components/capture-importer/cmp.capture-importer';
import { LoadingScreen } from './components/loading-screen/cmp.loading-screen';
import { Overlay } from './components/common/overlay/cmp.overlay';
import { Config } from './config/cls.config';

// Shared by both the selected-mesh flat-orange recolor and the outline
// ring around it.
const SELECTION_COLOR = new THREE.Color(0xff8c1a);
// Outline ring thickness, in device (drawing-buffer) pixels - see
// renderSelectionOutlinePass()'s doc comment.
const OUTLINE_THICKNESS_PIXELS = 3;

/** One draw's fully-parsed geometry/material/bounds, cached in memory so the
 * "hide largest % of objects" filter can rebuild the visible scene instantly
 * without re-reading or re-parsing any files. */
interface LoadedDraw {
  draw: DrawEntry;
  key: string;
  material: THREE.Material;
  geometryData: GeometryArrays;
  previewGeometryData: GeometryArrays;
  bounds: Bounds;
  diagonal: number;
  meshPath: string | null;
  previewPath: string | null;
  /** Pristine copy of the posed mesh's positions as originally loaded (a
   * plain copy, never mutated) - null when this draw has no separate posed
   * export (geometryData IS previewGeometryData, same array - see
   * loadDraw()). Distortion correction always re-fits and re-applies from
   * this copy rather than from draw.geometryData.positions, so
   * recalculateTransformCorrection() can be re-run (e.g. after changing
   * the up-axis/handedness option) without compounding a previous run's
   * correction onto itself. */
  originalPosedPositions: number[] | null;
}

export class SceneViewerApp {
  private vfs = new VirtualFileSystem();
  private loaded: LoadedManifests | null = null;
  private textures = new TextureManager();
  private sceneManager: SceneManager;
  private appConfig: Config;

  private materialCache = new Map<string, THREE.Material>();
  private untexturedMaterial: THREE.Material | null = null;

  /** Everything loaded by the last reconstruct, kept around so the size
   * filter can rebuild without re-parsing. Cleared at the start of each
   * fresh "Reconstruct scene" click. */
  private loadedDraws: LoadedDraw[] = [];
  /** Computed once per reconstruct from ALL loaded draws (see
   * computeNormalizationScale) - stays fixed as the filter slider moves, so
   * hidden objects still count for scale even though they're excluded from
   * the rendered scene and from camera framing. */
  private fixedScale = 1;
  /** 0-100. How much of the largest-by-diagonal objects to exclude from the
   * rendered scene. Kept in sync across the import-screen and viewport
   * filter controls. */
  private hidePercent = 0;
  private lastProblemNote = "";

  /** Indices into loadedDraws currently excluded by the "hide largest %"
   * filter - recomputed by rebuildVisibleScene() whenever the filter
   * changes, and the single source of truth for "is this object
   * selectable/visible in the list" (see isObjectHidden()). */
  private hiddenDrawIndices = new Set<number>();
  /** Indices manually hidden via the object list's own visibility button -
   * independent of and layered with hiddenDrawIndices (the "hide largest %"
   * filter). An object filtered by the size slider always shows 'f' and its
   * manual state is irrelevant to rendering either way; otherwise it shows
   * 'v' (visible, default) or 'h' (manually hidden) - see
   * getVisibilityState(). */
  private manuallyHiddenIndices = new Set<number>();
  /** Index into loadedDraws of the object marked as the scale reference in
   * the object list ("is ref" button - see setLandmark()). No longer read
   * by recalculateTransformCorrection(), which now fits a distortion
   * independently per object instead of broadcasting one reference
   * object's correction to the whole scene; kept only for the UI marker
   * itself, which is otherwise harmless to leave clicked. */
  private scaleReferenceIndex: number | null = null;
  /** Rotation applied to the whole scene's content group (not to individual
   * objects) - persisted here so it survives rebuildVisibleScene() rebuilds
   * (filter/visibility changes tear down and recreate the content group).
   * Set once per reconstructScene() from the auto-detected world-up axis
   * (see detectWorldUpAxis()) - NOT by recalculateTransformCorrection(),
   * whose per-object matrix correction bakes only a shape (stretch/shear)
   * fix directly into each object's own vertices and deliberately leaves
   * orientation untouched (see posedToNonPosedInPlace in calculator.ts),
   * relying on this already having made world space's up axis vertical. */
  private sceneRotation = new THREE.Quaternion();
  /** World-space axis (in RAW, pre-sceneRotation coordinates - i.e. as
   * draw.geometryData.positions are actually stored) that
   * detectWorldUpAxis() concluded was most likely "up", set once per
   * reconstructScene(). Used both to build sceneRotation and, when the "Up
   * axis" selector is set to a specific axis instead of "auto", as the
   * target that override is expressed relative to - see
   * buildUpAxisAdjustment(). */
  private worldUpAxis: "x" | "y" | "z" = "y";
  /** True while the "Mark ground plane" tool is armed and collecting the
   * next of its three clicks on the mesh surface - see
   * startGroundPlaneTool()/handleGroundPlaneClick(). Left/right clicks in
   * the viewport are routed to the tool instead of normal object
   * selection while this is true (see handleSceneObjectPointer()). */
  private groundPlaneToolActive = false;
  /** Points placed so far by the ground-plane tool (0-3), in the SAME
   * local (pre-scale, pre-sceneRotation) space as
   * draw.geometryData.positions/bounds - i.e. the space addDotPair()'s
   * callers already use for selection markers - so these stay correctly
   * attached to the mesh regardless of the content group's current
   * scale/rotation. Cleared on cancel, on completion, and on any fresh
   * reconstruct. */
  private groundPlanePoints: THREE.Vector3[] = [];
  /** Cross + dotted-line markers currently shown by the ground-plane tool
   * - tracked separately from selectionVisuals (a different, unrelated
   * overlay system) so the two never interfere with each other. */
  private groundPlaneVisuals: THREE.Object3D[] = [];
  /** Rotation computed by the ground-plane tool from its three marked
   * points the last time it completed (see finishGroundPlaneTool()) -
   * null until that has happened at least once for the current scene.
   * Selecting "Manual" in the "Up axis" dropdown applies this instead of
   * the auto-detected worldUpAxis-to-Y rotation - see
   * getActiveSceneRotation(). */
  private manualUpRotation: THREE.Quaternion | null = null;
  /** Which select-area tool ("sphere" or "box") is currently armed and
   * waiting for its single placement click, if any - see
   * startSelectAreaTool()/handleSelectAreaClick(). Left-click in the
   * viewport places the shape while this is set (see
   * handleSceneObjectPointer()); right-click cancels, same convention as
   * the ground-plane tool. Mutually exclusive with groundPlaneToolActive -
   * arming either tool cancels the other. */
  private selectAreaToolActive: "sphere" | "box" | null = null;
  /** The current select-area shape, if one has been placed - a child of
   * the content group, positioned/scaled in its LOCAL space (see
   * placeSelectAreaShape()), so it moves/rotates with the mesh like the
   * ground-plane markers do. Only one shape exists at a time: placing a
   * new one (of either kind) replaces it - see clearSelectAreaShape().
   * Cleared on any fresh reconstruct or scene rebuild, same as the
   * ground-plane tool's own state. */
  private selectAreaShape: THREE.Mesh | null = null;
  private selectAreaKind: "sphere" | "box" | null = null;
  /** In-scene translate/scale gizmo for selectAreaShape - see
   * select-area-gizmo.ts. Recreated alongside the shape itself (not a
   * persistent instance carried across rebuilds - see restoreSelectAreaShape()'s
   * doc comment for why that wouldn't survive a scene rebuild anyway). */
  private selectAreaGizmo: SelectAreaGizmo | null = null;
  /** Which mode the NEXT (and current) gizmo should use - persists across
   * shape/gizmo recreation (placement, rebuild-triggered recreation) so the
   * user's last choice sticks, unlike the transient gizmo instance itself. */
  private selectAreaGizmoMode: GizmoMode = "translate";
  /** Mirrors SceneManager's fly-mode state (see onFlyStateChange()) purely
   * so the 'G'/'S' gizmo-mode keyboard shortcuts can avoid firing while
   * flying - 'S' collides with both movement schemes' own key bindings
   * there (see movement-bindings.interface.ts). */
  private isFlying = false;
  /** Indices into loadedDraws currently selected in the object list. */
  private selectedIndices = new Set<number>();
  /** Anchor point for shift-click range selection - the last index selected
   * via a plain or ctrl click (NOT updated by shift-clicks themselves, so
   * repeated shift-clicks all extend/shrink from the same anchor - standard
   * list multi-select convention). */
  private lastClickedIndex: number | null = null;

  /** Every Object3D currently added to the content group for the selection
   * highlight (screen-space outline meshes + the two dot-marker Points
   * pairs) -
   * tracked here so they can be cleanly removed/disposed on the next
   * selection or scene rebuild, independent of the main content meshes'
   * own lifecycle (see clearSelectionVisuals()). */
  private selectionVisuals: THREE.Object3D[] = [];
  /** One compiled "selected = flat orange / else = darkened" shader
   * material per unique base (untouched) material - see
   * buildSelectionShaderMaterial(). Keyed by the base material so it
   * survives rebuildVisibleScene() (which recreates every Mesh but reuses
   * the same underlying per-draw material instances) without recompiling a
   * shader per selection change. */
  private selectionShaderCache = new WeakMap<THREE.Material, THREE.Material>();

  /** Selection outline: an image-space ("post-process") technique rather
   * than expanding the mesh's own geometry - see renderSelectionOutlinePass()
   * for why. outlineMaskGroup holds a plain white copy of each currently
   * selected (and visible) draw's geometry, rendered every frame into
   * outlineMaskTarget from the main camera; outlineQuadScene/Camera then
   * draw a single fullscreen quad that samples that mask and paints a ring
   * wherever a non-selected pixel is near a selected one. All set up once
   * in setupSelectionOutlinePass(); outlineMaskGroup's children are
   * rebuilt from scratch on every selection change (see
   * rebuildSelectionOutlineMask()). */
  private outlineMaskScene = new THREE.Scene();
  private outlineMaskGroup = new THREE.Group();
  private outlineMaskTarget: THREE.WebGLRenderTarget | null = null;
  private outlineQuadScene = new THREE.Scene();
  private outlineQuadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private outlineQuadMaterial: THREE.ShaderMaterial | null = null;

  private elements = {
    menu: {
      importScene: this.el("menu-import-scene"),
      controlOptions: this.el("menu-control-options"),
      fixExport: this.el("menu-fix-export"),
    },

    toolsMenu: {
      selectVolumeBtn: this.el("select-volume-btn"),
      fixDistortionBtn: this.el("fix-distortion-btn"),
      selectGroundPlaneBtn: this.el("select-ground-plane-btn"),
      setUpAxisBtn: this.el("set-up-axis-btn"),
      mirrorBtn: this.el("mirror-scene-btn"),
      resetCameraBtn: this.el("reset-camera-btn"),
      showResourcesPanelBtn: this.el("show-resources-panel-button"),
      hideResourcesPanelBtn: this.el("hide-resources-panel-button"),

      selectVolumeSubmenu: {
        menu: this.el("select-by-volume-submenu"),
        selectSphereBtn: this.el("select-by-volume-sphere-btn"),
        selectBoxBtn: this.el("select-by-volume-box-btn"),
        selectInsideBtn: this.el("select-by-volume-inside"),
        selectOutsideBtn: this.el("select-by-volume-outside"),
        selectReplaceBtn: this.el("select-by-volume_replace"),
        selectAddBtn: this.el("select-by-volume_add"),
        selectRemoveBtn: this.el("select-by-volume_remove"),
        selectCancelBtn: this.el("select-by-volume_cancel"),
      },

      selectLandmarkSubmenu: {
        menu: this.el("select-landmark-submenu"),
        hint: this.el("select-landmark-submenu_no-selection"),
        selectLandmarkApplyBtn: this.el("select-landmark-apply"),
        selectLandmarkCancelBtn: this.el("select-landmark-cancel"),
      }
    },

    captureImporter: this.el<CaptureImporter>("capture-importer"),
    loadingScreen: this.el<LoadingScreen>("loading-screen"),
    controlsOverlay: this.el<Overlay>("controls-overlay"),
    exportOverlay: this.el<Overlay>("export-overlay"),
  };


  private recalculateCorrectionBtn = this.el<HTMLButtonElement>("recalculate-correction-btn");
  private markGroundPlaneBtn = this.el<HTMLButtonElement>("mark-ground-plane-btn");
  private selectOptionsMenu = this.el<HTMLDivElement>("select-options-menu");
  private upAxisSelect = this.el<HTMLSelectElement>("up-axis-select");
  private handednessSelect = this.el<HTMLSelectElement>("handedness-select");
  private recenterCamBtn = this.el("recenter-camera-btn");
  private emptyHint = this.el("empty-hint");
  private hud = this.el("hud");
  private objectList = this.el('object-list');
  private viewport = this.el<HTMLElement>("viewport");
  // Placeholder values - recomputed from the actual viewport height and the
  // panel's real rendered content every time a resource panel is opened,
  // see computeResourcePanelMinSize() and showResources().
  private resourcePanelMinSize = { width: 360, height: 420 };
  private resourcePanelSize = { ...this.resourcePanelMinSize };

  private viewportFilterSlider = this.el<HTMLInputElement>("object-filter-size-slider");
  private viewportFilterValue = this.el<HTMLInputElement>("object-filter-size-value");

  private flySpeedIndicator = this.el("fly-speed-indicator");


  constructor(viewportEl: HTMLElement) {
    this.appConfig = Config.getConfig();

    this.sceneManager = new SceneManager(viewportEl);
    try {
      this.setupSelectionOutlinePass();
    } catch (e) {
      console.warn('setupSelectionOutlinePass failed', e);
    }
    this.sceneManager.onContextLoss((lost) => {
      if (lost) {
        // this.setStatus(
        //   "WebGL context lost - the scene is likely too large for available GPU memory. Try selecting fewer passes.",
        // );
      }
    });
    // Keeps the UI toggle/label/speed indicator in sync regardless of
    // whether fly mode was triggered from this checkbox or the 'A' key.
    this.sceneManager.onFlyStateChange((flying, speed) => {
      this.flySpeedIndicator.classList.toggle('hidden', !flying);
      this.flySpeedIndicator.textContent = flying ? `Fly cam. Speed: ${this.formatFlySpeed(speed)} \u00b7 scroll to adjust` : "";
      this.isFlying = flying;
    });
    this.sceneManager.onBeforeRender(() => this.updateSelectAreaGizmoTransform());
    this.sceneManager.onControlSchemeChange((scheme) => {
      console.warn('Control scheme change called from scene manager!', scheme);
    });
    this.setupMenu();
    this.setupToolsMenu();
    this.wireEvents();
  }

  private formatFlySpeed(speed: number): string {
    if (speed >= 100) return `${speed.toFixed(0)} units/s`;
    if (speed >= 1) return `${speed.toFixed(1)} units/s`;
    return `${speed.toFixed(3)} units/s`;
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing #${id} in the page`);
    return found as T;
  }

  private setStatus() {

  }


  private setupMenu() {
    this.elements.menu.importScene.addEventListener('click', () => {
      this.elements.captureImporter.classList.remove('hidden');
    });
    this.elements.menu.controlOptions.addEventListener('click', () => {
      console.info('opening control options overlay');
      this.elements.controlsOverlay.show();
    });
    this.elements.controlsOverlay.addEventListener('control-scheme-updated', (e: any) => {
      console.log('[app] Control scheme updated:', e.detail.controlScheme);
      this.sceneManager.setControlScheme(e.detail.controlScheme);
    });
    this.elements.menu.fixExport.addEventListener('click', () => {
      console.info('opening export overlay');
      this.elements.exportOverlay.show();
    });
  }

  private setupToolsMenu() {
    // setup top level
    {
      this.elements.toolsMenu.selectVolumeBtn.addEventListener('click', () => {
        this.hideAllToolSubmenus();
        this.cancelAllTools();
        if (Config.sessionConfig.tools.activeTool !== 'select-by-volume') {
          Config.sessionConfig.tools.activeTool = 'select-by-volume';
          this.elements.toolsMenu.selectVolumeSubmenu.menu.classList.remove('hidden');
          this.toggleVolumeSelectTool(true);
        } else {
          this.elements.toolsMenu.selectVolumeSubmenu.menu.classList.add('hidden');
          Config.sessionConfig.tools.activeTool = null;
        }
      });
      this.elements.toolsMenu.fixDistortionBtn.addEventListener('click', () => {
        this.hideAllToolSubmenus();
        this.cancelAllTools();
        if (Config.sessionConfig.tools.activeTool !== 'select-landmark') {
          Config.sessionConfig.tools.activeTool = 'select-landmark';
          this.elements.toolsMenu.selectLandmarkSubmenu.menu.classList.remove('hidden');
        } else {
          this.elements.toolsMenu.selectLandmarkSubmenu.menu.classList.add('hidden');
          Config.sessionConfig.tools.activeTool = null;
        }
      });
      // TODO: merge in ground plane select button
      this.elements.toolsMenu.setUpAxisBtn.addEventListener('click', () => {
        this.hideAllToolSubmenus();
        this.cancelAllTools();
        // we don't have 'select up axis' submenu yet
        // this.elements.toolsMenu.setUpAxisSubmenu.menu.classList.remove('hidden');
      });
      this.elements.toolsMenu.mirrorBtn.addEventListener('click', () => {
        // mirror scene doesn't need to hide tool submenus or cancel tools
        this.mirrorSceneAlongX();
      });
      this.elements.toolsMenu.resetCameraBtn.addEventListener('click', () => {
        // this also doesn't need to hide or cancel any tools
        this.sceneManager.frameOnScene();
      });

      this.elements.toolsMenu.showResourcesPanelBtn.addEventListener('click', () => {
        this.toggleResourcePanel(true);
      });
      this.elements.toolsMenu.hideResourcesPanelBtn.addEventListener('click', () => {
        this.toggleResourcePanel(false);
      });

      this.restoreResourcePanel();
    }

    // setup submenu: select volume
    {
      this.elements.toolsMenu.selectVolumeSubmenu.selectSphereBtn.addEventListener("click", () => this.setVolumeSelectTool("sphere"));
      this.elements.toolsMenu.selectVolumeSubmenu.selectBoxBtn.addEventListener("click", () => this.setVolumeSelectTool("box"));

      this.elements.toolsMenu.selectVolumeSubmenu.selectInsideBtn.addEventListener("click", () => this.setVolumeSelectMode("inside"));
      this.elements.toolsMenu.selectVolumeSubmenu.selectOutsideBtn.addEventListener("click", () => this.setVolumeSelectMode("outside"));
    }
  }

  private wireEvents(): void {
    this.elements.captureImporter.addEventListener('reconstruct-scene', (e: any) => {
      console.log('received reconstruct-scene:', e);
      this.reconstructScene(e.detail);
    });


    this.recalculateCorrectionBtn.addEventListener("click", () => this.recalculateTransformCorrection());
    this.markGroundPlaneBtn.addEventListener("click", () => this.toggleGroundPlaneTool());

    // Gizmo drag tracking - window-level, not canvas-level, so an
    // in-progress drag keeps updating even if the cursor leaves the canvas
    // mid-gesture (same reasoning as SceneManager's own orbit/pan drags).
    window.addEventListener("pointermove", (e) => this.handleGizmoPointerMove(e));
    window.addEventListener("pointerup", (e) => this.handleGizmoPointerUp(e));
    window.addEventListener("keydown", (e) => this.handleGizmoKeydown(e));
    this.upAxisSelect.addEventListener("change", () => this.applySceneRotation());
    // The tools' own right-click handling (cancel + clear) happens in
    // handleSceneObjectPointer() via pointerdown, which fires before the
    // browser's native contextmenu event - this just stops that native
    // menu from popping up over the viewport afterwards.
    this.sceneManager.renderer.domElement.addEventListener("contextmenu", (event) => {
      if (this.groundPlaneToolActive || this.selectAreaToolActive) event.preventDefault();
    });
    this.recenterCamBtn.addEventListener("click", () => this.sceneManager.frameOnScene());

    // Both filter control pairs (import screen + post-reconstruct viewport
    // menu) drive the same underlying value and stay in sync with each
    // other - see setHidePercent().
    for (const slider of [this.viewportFilterSlider]) {
      slider.addEventListener("input", () => this.setHidePercent(Number(slider.value)));
    }
    for (const text of [this.viewportFilterValue]) {
      text.addEventListener("change", () => this.setHidePercent(Number(text.value)));
    }

    this.setupObjectList();
  }

  //#region tools
  private hideAllToolSubmenus() {
    this.elements.toolsMenu.selectVolumeSubmenu.menu.classList.add("hidden");
    this.elements.toolsMenu.selectLandmarkSubmenu.menu.classList.add("hidden");
  }
  private cancelAllTools() {
    this.cancelVolumeSelectTool();

  }
  /**
   * Toggles visibility of resource panel.
   * @param show whether to show or to hide the resource panel
   */
  private toggleResourcePanel(show: boolean, noSaveState?: boolean) {
    if (show) {
      // TODO: Show the resource panel
    } else {
      // TODO: Hide the resource panel
    }

    if (!noSaveState) {
      if (show) {
        this.elements.toolsMenu.showResourcesPanelBtn.classList.add('hidden');
        this.elements.toolsMenu.hideResourcesPanelBtn.classList.remove('hidden');
        // TODO: Show the resource panel
      } else {
        this.elements.toolsMenu.hideResourcesPanelBtn.classList.add('hidden');
        this.elements.toolsMenu.showResourcesPanelBtn.classList.remove('hidden');
        // TODO: Hide the resource panel
      }

      Config.sessionConfig.resourcesPanel.visible = show;
    }
  }

  private restoreResourcePanel() {
    this.toggleResourcePanel(Config.sessionConfig.resourcesPanel.visible);
  }

  //#endregion

  private setHidePercent(value: number): void {
    const clamped = Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
    this.hidePercent = clamped;
    for (const slider of [this.viewportFilterSlider]) slider.value = String(clamped);
    for (const text of [this.viewportFilterValue]) text.value = String(clamped);
    if (this.loadedDraws.length > 0) this.rebuildVisibleScene();
  }

  private getUntexturedMaterial(): THREE.Material {
    if (!this.untexturedMaterial) {
      this.untexturedMaterial = new THREE.MeshBasicMaterial({ color: 0x606a7a, side: THREE.DoubleSide });
    }
    return this.untexturedMaterial;
  }

  private async resolveMaterial(
    objPath: string,
    mtllibName: string | null,
    usemtlName: string | null,
  ): Promise<{ key: string; material: THREE.Material }> {
    if (!mtllibName) return { key: "untextured", material: this.getUntexturedMaterial() };

    const mtlPath = joinPath(dirname(objPath), mtllibName);
    const mtlText = await this.vfs.readText(mtlPath);
    if (!mtlText) return { key: "untextured", material: this.getUntexturedMaterial() };

    const materials = parseMTL(mtlText);
    const material = (usemtlName && materials[usemtlName]) || Object.values(materials)[0];
    if (!material?.mapKd) return { key: "untextured", material: this.getUntexturedMaterial() };

    const texPath = joinPath(dirname(mtlPath), material.mapKd);
    const cached = this.materialCache.get(texPath);
    if (cached) return { key: texPath, material: cached };

    const texture = await this.textures.load(this.vfs, texPath);
    const threeMaterial = texture
      ? new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
      : this.getUntexturedMaterial();
    this.materialCache.set(texPath, threeMaterial);
    return { key: texPath, material: threeMaterial };
  }

  /** Parses one draw's OBJ/MTL/texture and appends it to this.loadedDraws -
   * this is the expensive, I/O-bound step, done once per reconstruct. Scene
   * *building* (merging + filtering) is separate, see rebuildVisibleScene(). */
  private async loadDraw(
    draw: DrawEntry,
    passDir: string,
  ): Promise<"added" | "no-mesh-path" | "mesh-not-found"> {
    const meshRel = draw.posedMesh ? draw.posedMesh : draw.mesh;
    const previewRel = draw.mesh ?? draw.posedMesh ?? null;
    if (!meshRel) return "no-mesh-path";

    const objPath = joinPath(passDir, meshRel);
    const objText = await this.vfs.readText(objPath);
    if (!objText) return "mesh-not-found";

    const obj = parseOBJ(objText);
    const geometryData = objToGeometryArrays(obj);
    const bounds = computeBounds(geometryData.positions);
    const { key, material } = await this.resolveMaterial(objPath, obj.mtllib, obj.usemtl);

    let previewGeometryData = geometryData;
    if (previewRel && previewRel !== meshRel) {
      const previewPath = joinPath(passDir, previewRel);
      const previewText = await this.vfs.readText(previewPath);
      if (previewText) {
        const previewObj = parseOBJ(previewText);
        previewGeometryData = objToGeometryArrays(previewObj);
      }
    }

    this.loadedDraws.push({
      draw,
      key,
      material,
      geometryData,
      previewGeometryData,
      bounds,
      diagonal: boundsDiagonal(bounds),
      meshPath: meshRel,
      previewPath: previewRel,
      originalPosedPositions: previewGeometryData !== geometryData ? geometryData.positions.slice() : null,
    });

    return "added";
  }

  private createDrawItem(draw: DrawEntry, drawIndex: number, stats?: { vertices: number; faces: number; size: number }): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "draw-row-wrap";
    wrap.dataset.index = String(drawIndex);

    const vertices = stats?.vertices ?? 0;
    const faces = stats?.faces ?? 0;
    const size = stats?.size ?? 0;

    const div = document.createElement("div");
    div.className = "draw-item flex flex-col w-full";
    div.dataset.index = String(drawIndex);
    div.innerHTML = `
      <div class="flex flex-row justify-between items-baseline">
        <div>
          <b class="name">Draw #${drawIndex}</b> <small class="role">(eid ${draw.eventId})</small>
        </div>
        <div class="flex flex-row">
          <div>vis: <button class="check-like" data-action="visibility" data-index="${drawIndex}">[ ]</button></div>
          <div>sel: <button class="check-like" data-action="selection" data-index="${drawIndex}">[ ]</button></div>
        </div>
      </div>
      <div>
        <small>v: ${vertices}, f: ${faces}, size: ${size.toFixed(2)}</small>
      </div>

      <div class="hidden">
      &nbsp; is ref: <button class="check-like" data-action="landmark" data-index="${drawIndex}">[ ]</button>
       &nbsp; <button data-action="resources" data-index="${drawIndex}">res</button>
      </div>
    `;

    wrap.appendChild(div);
    return wrap;
  }

  private async reconstructScene({vfs, manifests, importOptions }: { vfs: VirtualFileSystem; manifests: LoadedManifests; importOptions: any }): Promise<void> {
    this.loaded = manifests;
    if (!this.loaded || !vfs) {
      console.info('No manifests loaded — doing nothing.');
      return;
    }

    const selected: string[] = [];
    for (const f in this.loaded.passManifests) {
      if (this.loaded.passManifests[f].markedForRender) {
        selected.push(f);
      }
    }

    if (selected.length === 0) {
      console.info('No passes selected — doing nothing.');
      return;
    }
    this.vfs = vfs;
    this.elements.captureImporter.classList.add('hidden');
    this.elements.loadingScreen.show();
    this.elements.loadingScreen.log("Starting reconstruction...");


    this.emptyHint.style.display = "none";
    this.hud.style.display = "block";
    // this.setStatus(`Reconstructing ${selected.length} pass(es): ${selected.join(", ")}`);

    try {
      this.clearSelectionVisuals();
      // A fresh reconstruct starts a genuinely new scene - any in-progress
      // or previously-completed ground-plane marking, and any placed
      // select-area shape, belonged to the old one and no longer mean
      // anything against new geometry.
      this.cancelGroundPlaneTool();
      this.manualUpRotation = null;
      if (this.upAxisSelect.value === "manual") this.upAxisSelect.value = "auto";
      this.cancelVolumeSelectTool();
      this.clearSelectAreaShape();
      this.sceneManager.clear();
      // Full reload: previous draws/materials/textures are genuinely done
      // with now, unlike a filter-only rebuild (see rebuildVisibleScene)
      // which reuses all of this.
      for (const material of this.materialCache.values()) material.dispose();
      this.materialCache.clear();
      if (this.untexturedMaterial) {
        this.untexturedMaterial.dispose();
        this.untexturedMaterial = null;
      }
      this.textures.disposeAll();
      this.loadedDraws = [];
      this.objectList.innerHTML = "";
      this.selectedIndices.clear();
      this.hiddenDrawIndices.clear();
      this.manuallyHiddenIndices.clear();
      this.lastClickedIndex = null;

      let noMeshPathCount = 0;
      let meshNotFoundCount = 0;
      let exceptionCount = 0;
      let processed = 0;
      let loggedMissingManifest = false;
      let loggedMissingMesh = false;

      for (const folder of selected) {
        const logLine = this.elements.loadingScreen.log(`Processing pass "${folder}"...`);

        const manifest = this.loaded.passManifests[folder];
        if (!manifest) {
          if (!loggedMissingManifest) {
            console.error(
              `[reconstruct] No manifest data for pass "${folder}" - it either failed to load ` +
                `(check the warning when the folder was dropped) or was never fetched.`,
            );
            loggedMissingManifest = true;
          }
          logLine.updateLogItem(`No manifest found for pass "${folder}"; skipping`);
          continue;
        }
        const passDir = joinPath(this.loaded.rootPrefix, folder);

        for (const draw of manifest.draws) {
          logLine.updateLogItem(`Processing pass "${folder}" ...`, { current: processed, total: manifest.draws.length });
          processed++;
          try {
            const outcome = await this.loadDraw(draw, passDir);
            if (outcome === "no-mesh-path") {
              noMeshPathCount++;
            } else if (outcome === "mesh-not-found") {
              meshNotFoundCount++;
              if (!loggedMissingMesh) {
                const meshRel = draw.posedMesh ? draw.posedMesh : draw.mesh;
                console.error(
                  `[reconstruct] Mesh file not found for eid${draw.eventId}: tried "${joinPath(passDir, meshRel ?? "")}". ` +
                    `A few sample paths that WERE found: ${Array.from(this.vfs.keys()).slice(0, 8).join(", ")}`,
                );
                loggedMissingMesh = true;
                this.elements.loadingScreen.log(`Mesh file not found for eid${draw.eventId}`);
              }
            } else {
              // Global index into loadedDraws (loadDraw() just pushed this
              // draw onto it) - NOT the per-pass manifest index, which
              // would collide across multiple selected passes since each
              // pass's manifest.draws restarts at 0.
              const globalIndex = this.loadedDraws.length - 1;
              const loadedDraw = this.loadedDraws[globalIndex];
              const stats = {
                vertices: Math.max(0, loadedDraw.geometryData.positions.length / 3),
                faces: Math.max(0, loadedDraw.geometryData.positions.length / 9),
                size: loadedDraw.diagonal,
              };
              this.objectList.appendChild(this.createDrawItem(draw, globalIndex, stats));
            }
          } catch (e) {
            exceptionCount++;
            console.error(`[reconstruct] Exception loading draw eid${draw.eventId}`, draw, e);
            this.elements.loadingScreen.log(`Exception loading draw eid${draw.eventId}`);
          }
          if (processed % 50 === 0) {
            // this.setStatus(`Loading... ${processed} draw(s) processed, ${this.loadedDraws.length} loaded so far`);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }

      this.elements.loadingScreen.log(`Finished processing all passes. Calculating scale and/or initial scale ...`);

      // Normalization scale is computed ONCE here, from every loaded draw
      // regardless of the size filter, and then held fixed - see
      // computeNormalizationScale() and rebuildVisibleScene(). World-space
      // up-axis detection piggybacks on the same combined bounding box -
      // see detectWorldUpAxis().
      this.fixedScale = 1;
      this.worldUpAxis = "y";
      this.sceneRotation = new THREE.Quaternion();
      if (this.loadedDraws.length > 0) {
        let overall: Bounds = this.loadedDraws[0].bounds;
        for (let i = 1; i < this.loadedDraws.length; i++) overall = unionBounds(overall, this.loadedDraws[i].bounds);
        const size = overall.max.clone().sub(overall.min);
        const maxDim = Math.max(size.x, size.y, size.z);
        this.fixedScale = computeNormalizationScale(maxDim);

        this.worldUpAxis = this.detectWorldUpAxis(overall);
        if (this.worldUpAxis !== "y") {
          this.sceneRotation = new THREE.Quaternion().setFromUnitVectors(
            SceneViewerApp.axisVector(this.worldUpAxis),
            new THREE.Vector3(0, 1, 0),
          );
        }

        console.log("[reconstruct] scene bounds", {
          min: overall.min,
          max: overall.max,
          size,
          scale: this.fixedScale,
          worldUpAxis: this.worldUpAxis,
        });
      }

      const problems: string[] = [];
      if (meshNotFoundCount) problems.push(`${meshNotFoundCount} mesh file(s) not found`);
      if (exceptionCount) problems.push(`${exceptionCount} threw an error`);
      if (noMeshPathCount) problems.push(`${noMeshPathCount} had no mesh path in the manifest`);
      this.lastProblemNote = problems.length ? ` \u2014 PROBLEMS: ${problems.join(", ")} (see console)` : "";

      this.elements.loadingScreen.log(`Rebuilding visible scene...`);
      this.rebuildVisibleScene();
      this.elements.loadingScreen.log(`Visible scene rebuilt.`);
    } catch (e) {
      console.error("[reconstruct] Reconstruction failed", e);
      // this.setStatus(`Reconstruct failed: ${e instanceof Error ? e.message : String(e)} (see console for details)`);
      this.elements.loadingScreen.log(`Reconstruction failed.`);
    }

    this.elements.loadingScreen.hide();
  }

  /** Rebuilds the rendered scene from this.loadedDraws according to both
   * the "hide largest %" filter AND per-object manual visibility, WITHOUT
   * re-reading or re-parsing any files - this is what makes dragging the
   * filter slider (and toggling an object's own visibility) instant. Hidden
   * objects were already counted in this.fixedScale (computed once from
   * every loaded draw in reconstructScene()) but are excluded here, so
   * frameOnScene() - which measures whatever's actually in the scene -
   * naturally only frames the camera on what's currently visible. Also
   * recomputes hiddenDrawIndices, which the object list uses to gray out /
   * disable selection on anything the filter is currently excluding. */
  private rebuildVisibleScene(): void {
    if (this.loadedDraws.length === 0) return;

    // "Hide largest % of objects" = hide that fraction of objects BY COUNT,
    // ranked by size (bounding-box diagonal) - the simplest, most
    // predictable reading of a 0-100% slider.
    const sorted = this.loadedDraws
      .map((draw, index) => ({ draw, index }))
      .sort((a, b) => b.draw.diagonal - a.draw.diagonal);
    const hideCount = Math.round((this.hidePercent / 100) * sorted.length);
    this.hiddenDrawIndices = new Set(sorted.slice(0, hideCount).map((entry) => entry.index));

    // Anything that just became hidden can't stay selected - "objects must
    // be selectable, unless hidden by the size filter".
    for (const index of this.selectedIndices) {
      if (this.hiddenDrawIndices.has(index)) this.selectedIndices.delete(index);
    }

    const builder = new SceneMeshBuilder();
    let excludedCount = 0;
    this.loadedDraws.forEach((draw, index) => {
      if (this.hiddenDrawIndices.has(index) || this.manuallyHiddenIndices.has(index)) {
        excludedCount++;
        return;
      }
      builder.addDraw(draw.key, draw.material, draw.geometryData, index);
    });
    const meshes = builder.buildAll();

    // Must clear our own overlay objects BEFORE sceneManager.clear() runs -
    // they live inside the content group that's about to be torn down and
    // rebuilt, and sceneManager.clear() only disposes the Mesh objects it
    // owns directly, not these app-level Points markers.
    this.clearSelectionVisuals();
    this.clearGroundPlaneVisuals();
    // The select-area shape (unlike the ground-plane tool's markers) is
    // user-configured, persistent data, not a transient in-progress tool
    // artifact - a filter/visibility change shouldn't silently discard it -
    // so its kind/position/scale are captured here and re-applied to a
    // freshly-created shape in the new content group below, rather than
    // just clearing it outright.
    const previousShape = this.selectAreaKind
      ? {
          kind: this.selectAreaKind,
          position: this.selectAreaShape?.position.clone(),
          scale: this.selectAreaShape?.scale.clone(),
        }
      : null;
    this.clearSelectAreaShape();
    this.sceneManager.clear();
    const contentGroup = this.sceneManager.addContent(meshes, this.fixedScale);
    contentGroup.quaternion.copy(this.getActiveSceneRotation());
    this.updateSelectionVisuals();
    if (previousShape?.position && previousShape.scale) {
      this.restoreSelectAreaShape(previousShape.kind, previousShape.position, previousShape.scale);
    }

    const visibleCount = this.loadedDraws.length - excludedCount;
    const triCount = Math.round(builder.totalVertexCount / 3);

    this.setStatus(
      `${visibleCount}/${this.loadedDraws.length} object(s) shown (${this.hidePercent}% of largest hidden by filter, ` +
        `${this.manuallyHiddenIndices.size} manually hidden) \u00b7 ${meshes.length} mesh(es) \u00b7 ` +
        `~${triCount.toLocaleString()} triangles${this.lastProblemNote}`,
    );
    this.hud.textContent =
      `${visibleCount}/${this.loadedDraws.length} objects \u00b7 ${meshes.length} draw calls \u00b7 ` +
      `${triCount.toLocaleString()} tris \u00b7 scale \u00d7${this.fixedScale.toExponential(2)} \u00b7 MMB drag to orbit, Shift+MMB to pan, scroll to zoom, A for fly mode`;

    this.renderObjectListState();
  }

  /** Toggles manual per-object visibility (independent of the "hide
   * largest %" filter - see manuallyHiddenIndices). If the clicked object
   * isn't part of the current selection, only it is toggled. If it IS
   * selected, every selected object is set to the opposite of the clicked
   * object's CURRENT state (Blender's own convention for toggling
   * visibility with a multi-selection active). No-ops on filtered ('f')
   * objects - their visibility button is disabled anyway, but this guards
   * against it regardless. */
  private toggleDrawVisibility(index: number): void {
    if (this.isObjectHidden(index)) return;

    if (this.selectedIndices.has(index)) {
      const makeHidden = !this.manuallyHiddenIndices.has(index);
      for (const i of this.selectedIndices) {
        if (makeHidden) this.manuallyHiddenIndices.add(i);
        else this.manuallyHiddenIndices.delete(i);
      }
    } else if (this.manuallyHiddenIndices.has(index)) {
      this.manuallyHiddenIndices.delete(index);
    } else {
      this.manuallyHiddenIndices.add(index);
    }

    this.rebuildVisibleScene();
  }

  /** Adds the object to the selection if it isn't selected, removes it if
   * it is. Used both for ctrl-clicks and as the effective behavior of a
   * plain click on the dedicated "selection" button - see
   * handleObjectClick(). */
  private toggleDrawSelection(index: number): void {
    if (this.isObjectHidden(index)) return;
    if (this.selectedIndices.has(index)) this.selectedIndices.delete(index);
    else this.selectedIndices.add(index);
    this.lastClickedIndex = index;
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  /** Marks/unmarks the draw at index as the scale reference object. Only one
   * object may be the scale reference at a time, so marking a new one
   * replaces the previous one. */
  private setLandmark(index: number): void {
    if (this.isObjectHidden(index)) return;
    this.scaleReferenceIndex = this.scaleReferenceIndex === index ? null : index;
    this.renderObjectListState();
  }

  /**
   * Mirrors the entire scene along the X axis.
   */
  private mirrorSceneAlongX(): {

  }

  /** Best-effort heuristic for which world-space axis is "up": the axis
   * with the SMALLEST extent across the whole scene's combined bounding
   * box. Most captured scenes (game levels, rooms, even most single
   * characters) span much further horizontally than vertically, so the
   * flattest axis is usually vertical - this is a common heuristic for
   * unlabeled geometry, but not a guarantee; it can guess wrong for e.g. a
   * narrow hallway or a very flat/wide creature. There's no way to verify
   * this from bare geometry alone - if it guesses wrong, override it with
   * the "Up axis" selector next to Recalculate. */
  private detectWorldUpAxis(bounds: Bounds): "x" | "y" | "z" {
    const size = bounds.max.clone().sub(bounds.min);
    if (size.x <= size.y && size.x <= size.z) return "x";
    if (size.z <= size.x && size.z <= size.y) return "z";
    return "y";
  }

  private static axisVector(axis: "x" | "y" | "z"): THREE.Vector3 {
    if (axis === "x") return new THREE.Vector3(1, 0, 0);
    if (axis === "z") return new THREE.Vector3(0, 0, 1);
    return new THREE.Vector3(0, 1, 0);
  }

  /** Extra per-object rotation for the "Up axis" selector next to
   * Recalculate, composed on TOP of posedToNonPosedInPlace's shape-only
   * correction (see recalculateTransformCorrection()):
   * - "auto": identity. this.sceneRotation (see reconstructScene()) already
   *   rotates worldUpAxis to vertical for the WHOLE scene uniformly, and
   *   posedToNonPosedInPlace never disturbs an object's orientation, so
   *   nothing extra is needed here for objects to end up world-axis-up.
   * - "x"/"y"/"z": rotates the CHOSEN axis to wherever worldUpAxis
   *   currently points, rather than straight to three.js's Y. That's
   *   deliberate: sceneRotation is still going to rotate worldUpAxis to Y
   *   at render time regardless of this per-object override, so composing
   *   "chosen -> worldUpAxis" here (instead of "chosen -> Y" directly)
   *   means the two rotations chain into exactly "chosen -> worldUpAxis ->
   *   Y" - the chosen axis ends up vertical in the final display without
   *   fighting or double-applying sceneRotation.
   * - "manual": identity, same as "auto" - the ground-plane tool's
   *   rotation (this.manualUpRotation) already replaces the whole-scene
   *   rotation directly (see getActiveSceneRotation()) rather than
   *   composing with worldUpAxis the way a plain axis choice does, so
   *   there's nothing extra to add per-object here either. */
  private buildUpAxisAdjustment(mode: "auto" | "x" | "y" | "z" | "manual"): THREE.Quaternion {
    if (mode === "auto" || mode === "manual") return new THREE.Quaternion();
    return new THREE.Quaternion().setFromUnitVectors(
      SceneViewerApp.axisVector(mode),
      SceneViewerApp.axisVector(this.worldUpAxis),
    );
  }

  /** Whichever rotation should currently sit on the content group: the
   * ground-plane tool's marked rotation when "Up axis" is set to "Manual"
   * and the tool has completed at least once for this scene (see
   * manualUpRotation), otherwise the auto-detected worldUpAxis-to-Y
   * rotation computed once per reconstruct (see reconstructScene()). */
  private getActiveSceneRotation(): THREE.Quaternion {
    if (this.upAxisSelect.value === "manual" && this.manualUpRotation) return this.manualUpRotation;
    return this.sceneRotation;
  }

  /** Re-applies getActiveSceneRotation() to whatever's currently in the
   * content group, if anything - called whenever that choice could have
   * changed: the "Up axis" dropdown and the ground-plane tool completing a
   * new manual rotation. A no-op before anything's been reconstructed. */
  private applySceneRotation(): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;
    group.quaternion.copy(this.getActiveSceneRotation());
  }

  /** Arms/disarms the "Mark ground plane" tool - see
   * startGroundPlaneTool()/cancelGroundPlaneTool(). */
  private toggleGroundPlaneTool(): void {
    if (this.groundPlaneToolActive) this.cancelGroundPlaneTool();
    else this.startGroundPlaneTool();
  }

  /** Arms the ground-plane tool: switches the viewport cursor to a
   * crosshair and starts collecting the next 3 left-clicks on mesh surface
   * (see handleSceneObjectPointer()/handleGroundPlaneClick()). Left-clicks
   * elsewhere while armed are effectively no-ops (see raycastMeshSurface())
   * rather than falling through to normal object selection. */
  private startGroundPlaneTool(): void {
    if (this.loadedDraws.length === 0) {
      this.setStatus("Reconstruct a scene first.");
      return;
    }
    this.cancelVolumeSelectTool(); // mutually exclusive with the select-area tools
    this.groundPlaneToolActive = true;
    this.groundPlanePoints = [];
    this.clearGroundPlaneVisuals();
    this.sceneManager.renderer.domElement.style.cursor = "crosshair";
    this.markGroundPlaneBtn.classList.add("active");
    this.setStatus("Mark ground plane: click 3 points on the mesh surface (right-click to cancel).");
  }

  /** Disarms the ground-plane tool and clears any points/markers placed so
   * far without computing a rotation - used both for an explicit
   * right-click cancel and for toggling the button off mid-placement.
   * Harmless to call when the tool isn't active (e.g. from
   * reconstructScene()'s per-reconstruct reset). */
  private cancelGroundPlaneTool(): void {
    this.groundPlaneToolActive = false;
    this.groundPlanePoints = [];
    this.clearGroundPlaneVisuals();
    this.sceneManager.renderer.domElement.style.cursor = "";
    this.markGroundPlaneBtn.classList.remove("active");
  }

  /** Builds a Raycaster for the given pointer event, from the camera
   * through wherever it landed on the canvas in NDC space - the shared
   * first step behind raycastMeshSurface() and the gizmo hit-testing in
   * handleSceneObjectPointer()/handleGizmoPointerMove(). */
  private buildViewportRaycaster(event: PointerEvent): THREE.Raycaster {
    const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.sceneManager.camera);
    return raycaster;
  }

  /** Raycasts the viewport at the given pointer event against mesh surface
   * only (excluding selection-highlight, ground-plane-marker,
   * select-area-shape, and gizmo-handle overlays, via the same
   * userData-tag convention as pickDrawAtPointer()), returning the
   * world-space hit point, or null if the ray missed everything. */
  private raycastMeshSurface(event: PointerEvent): THREE.Vector3 | null {
    const raycaster = this.buildViewportRaycaster(event);
    const contentGroup = this.sceneManager.getContentGroup();
    const roots = contentGroup ? [contentGroup] : this.sceneManager.scene.children;
    const hits = raycaster
      .intersectObjects(roots, true)
      .filter(
        (hit) =>
          !hit.object.userData.isSelectionVisual &&
          !hit.object.userData.isGroundPlaneVisual &&
          !hit.object.userData.isSelectAreaShape &&
          !hit.object.userData.isGizmoHandle,
      );
    return hits.length > 0 ? hits[0].point.clone() : null;
  }

  /** Handles one left-click while the ground-plane tool is armed: raycasts
   * for mesh surface under the cursor (ignored if it missed), records the
   * point (converted to the content group's local space - see
   * groundPlanePoints' doc comment), draws its cross marker and, from the
   * second point on, a dotted line back to the previous one. The third
   * point triggers finishGroundPlaneTool(). */
  private handleGroundPlaneClick(event: PointerEvent): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;

    const worldHit = this.raycastMeshSurface(event);
    if (!worldHit) return;

    const local = group.worldToLocal(worldHit.clone());
    this.groundPlanePoints.push(local);
    this.addGroundPlaneCross(local);
    if (this.groundPlanePoints.length >= 2) {
      const previous = this.groundPlanePoints[this.groundPlanePoints.length - 2];
      this.addGroundPlaneDottedLine(previous, local);
    }
    this.setStatus(`Mark ground plane: ${this.groundPlanePoints.length}/3 points placed (right-click to cancel).`);

    if (this.groundPlanePoints.length === 3) this.finishGroundPlaneTool();
  }

  /** Called once the third point is placed: fits the plane through all
   * three marked points, computes the rotation that makes that plane
   * horizontal (its normal vertical), stores it as manualUpRotation,
   * switches "Up axis" to "Manual" and applies the rotation immediately,
   * then disarms the tool. The three crosses/dashes are left in place as a
   * visual record of what was marked - they're cleared the next time the
   * tool is (re)started or the scene is rebuilt. */
  private finishGroundPlaneTool(): void {
    const [p0, p1, p2] = this.groundPlanePoints;
    const edgeA = p1.clone().sub(p0);
    const edgeB = p2.clone().sub(p0);
    const normal = edgeA.cross(edgeB);

    if (normal.lengthSq() < 1e-12) {
      this.setStatus("Mark ground plane: those three points are collinear - couldn't compute a plane. Try again.");
      this.cancelGroundPlaneTool();
      return;
    }
    normal.normalize();

    // Keep whichever side is currently "up" up, rather than risking an
    // arbitrary flip depending on the order the three points happened to
    // be clicked in - compares against the LOCAL-space direction that
    // currently renders as world-up.
    const currentLocalUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.getActiveSceneRotation().clone().invert());
    if (normal.dot(currentLocalUp) < 0) normal.negate();

    this.manualUpRotation = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 1, 0));
    this.upAxisSelect.value = "manual";

    this.groundPlaneToolActive = false;
    this.groundPlanePoints = [];
    this.sceneManager.renderer.domElement.style.cursor = "";
    this.markGroundPlaneBtn.classList.remove("active");

    this.applySceneRotation();
    this.setStatus("Ground plane marked - scene reoriented (Up axis: Manual).");
  }

  /** Unions every loaded draw's LOCAL (pre-scale) bounds together - the
   * space groundPlanePoints/select-area shape positions all live in.
   * Shared by groundPlaneMarkerSize() and the select-area tool's slider
   * ranges (see renderSelectAreaOptionsPanel()). */
  private overallLocalBounds(): Bounds {
    let overall: Bounds = this.loadedDraws[0].bounds;
    for (let i = 1; i < this.loadedDraws.length; i++) overall = unionBounds(overall, this.loadedDraws[i].bounds);
    return overall;
  }

  /** Marker/dash size for the ground-plane tool's dotted connector lines: a
   * small fraction of the whole loaded scene's local-space (pre-scale)
   * bounding diagonal - the same space groundPlanePoints live in - so
   * dashes read at a sensible size regardless of how big or small the
   * loaded scene is. (The cross markers themselves are fixed-pixel-size
   * screen-space sprites - see addGroundPlaneCross() - so they don't need
   * this.) */
  private groundPlaneMarkerSize(): number {
    if (this.loadedDraws.length === 0) return 1;
    return Math.max(boundsDiagonal(this.overallLocalBounds()) * 0.015, 1e-6);
  }

  /** Lazily-built, shared texture for the ground-plane cross markers: a
   * black-outlined orange "X" on a transparent background - built once and
   * reused for every marker rather than regenerated per click. */
  private static groundPlaneCrossTexture: THREE.Texture | null = null;

  private static getGroundPlaneCrossTexture(): THREE.Texture {
    if (SceneViewerApp.groundPlaneCrossTexture) return SceneViewerApp.groundPlaneCrossTexture;

    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const pad = size * 0.16;

    const strokeX = (lineWidth: number, color: string) => {
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = color;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(pad, pad);
      ctx.lineTo(size - pad, size - pad);
      ctx.moveTo(size - pad, pad);
      ctx.lineTo(pad, size - pad);
      ctx.stroke();
    };

    // Black outline drawn first, thicker, with the orange "X" stroked
    // narrower on top of it - same layered outline-underneath/fill-on-top
    // approach as addDotPair()'s two-Points selection-dot marker pairs.
    strokeX(size * 0.26, "#000000");
    strokeX(size * 0.14, `#${SELECTION_COLOR.getHexString()}`);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    SceneViewerApp.groundPlaneCrossTexture = texture;
    return texture;
  }

  /** Adds one black-outlined orange "X" marker at the given LOCAL position,
   * as a single-point Points object using getGroundPlaneCrossTexture() as
   * its sprite. Points are always screen-aligned billboards, so this
   * always faces the camera "for free" with no per-frame work needed - and
   * sizeAttenuation:false (literal pixel size via gl_PointSize, not scaled
   * by distance) keeps it a constant, readable size regardless of how far
   * the camera is, matching addDotPair()'s selection-dot convention.
   * depthTest:false so it stays visible through occluding geometry, same
   * as those dots. */
  private addGroundPlaneCross(point: THREE.Vector3): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([point.x, point.y, point.z], 3));
    const material = new THREE.PointsMaterial({
      map: SceneViewerApp.getGroundPlaneCrossTexture(),
      size: 22,
      sizeAttenuation: false,
      transparent: true,
      alphaTest: 0.4,
      depthTest: false,
      depthWrite: false,
    });
    const cross = new THREE.Points(geometry, material);
    cross.userData.isGroundPlaneVisual = true;
    cross.renderOrder = 999;

    group.add(cross);
    this.groundPlaneVisuals.push(cross);
  }

  /** Adds a dotted line between two LOCAL points, connecting consecutive
   * ground-plane markers. */
  private addGroundPlaneDottedLine(from: THREE.Vector3, to: THREE.Vector3): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;
    const dash = this.groundPlaneMarkerSize() * 0.6;

    const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    const material = new THREE.LineDashedMaterial({
      color: SELECTION_COLOR,
      dashSize: dash,
      gapSize: dash,
      depthTest: false,
    });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    line.userData.isGroundPlaneVisual = true;
    line.renderOrder = 999;

    group.add(line);
    this.groundPlaneVisuals.push(line);
  }

  /** Removes and disposes every currently-tracked ground-plane marker -
   * mirrors clearSelectionVisuals()'s must-run-before-teardown handling,
   * since these also live inside the content group. Never disposes the
   * shared cross texture itself (see getGroundPlaneCrossTexture()) - only
   * each marker's own geometry/material. Safe to call with nothing to
   * clear. */
  private clearGroundPlaneVisuals(): void {
    const group = this.sceneManager.getContentGroup();
    for (const obj of this.groundPlaneVisuals) {
      group?.remove(obj);
      if (obj instanceof THREE.Line || obj instanceof THREE.LineSegments || obj instanceof THREE.Points) {
        obj.geometry.dispose();
        const material = obj.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    }
    this.groundPlaneVisuals = [];
  }

  //#region select-area tool (sphere/box)

  /** Placeholder cursor icons for the two select-area tools - each a small
   * inline SVG data URI (orange outline shape, transparent background), so
   * the tool is fully functional out of the box. REPLACE these two data
   * URIs (or swap in `url("/path/to/real-image.png") 0 0, crosshair`
   * instead) once the real cursor images are provided - per spec, the
   * click/hotspot point is the UPPER-LEFT corner (0 0) of each image, which
   * is why both are built with their "clickable" corner at (0,0) rather
   * than centered. */
  private static readonly SELECT_AREA_CURSORS: Record<"sphere" | "box", string> = {
    sphere:
      `url('data:image/svg+xml;utf8,` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">` +
      `<circle cx="12" cy="12" r="10" fill="none" stroke="black" stroke-width="4"/>` +
      `<circle cx="12" cy="12" r="10" fill="none" stroke="orange" stroke-width="2"/>` +
      `</svg>') 0 0, crosshair`,
    box:
      `url('data:image/svg+xml;utf8,` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">` +
      `<rect x="2" y="2" width="20" height="20" fill="none" stroke="black" stroke-width="4"/>` +
      `<rect x="2" y="2" width="20" height="20" fill="none" stroke="orange" stroke-width="2"/>` +
      `</svg>') 0 0, crosshair`,
  };

  /** Arms/disarms one of the select-area tools - see
   * startSelectAreaTool()/cancelSelectAreaTool(). Clicking the currently-
   * armed tool's own button again disarms it. */
  private toggleVolumeSelectTool(enable?: boolean): void {
    if (!enable) {
      this.cancelVolumeSelectTool();
    } else {
      this.startSelectAreaTool(Config.sessionConfig.tools.selectAreaTool);
    }
  }

  private setVolumeSelectTool(kind: "sphere" | "box"): void {
    if (this.selectAreaToolActive === kind) {
      return;
    }

    Config.sessionConfig.tools.selectAreaTool = kind;
    this.startSelectAreaTool(kind);
  }

  private setVolumeSelectMode(mode: "inside" | "outside"): void {
    Config.sessionConfig.tools.selectAreaMode = mode;
    if (mode === "inside") {
      this.elements.toolsMenu.selectVolumeSubmenu.selectInsideBtn.classList.add("active");
      this.elements.toolsMenu.selectVolumeSubmenu.selectOutsideBtn.classList.remove("active");
    } else {
      this.elements.toolsMenu.selectVolumeSubmenu.selectInsideBtn.classList.remove("active");
      this.elements.toolsMenu.selectVolumeSubmenu.selectOutsideBtn.classList.add("active");
    }
  }

  /** Arms the given select-area tool: swaps the viewport cursor for that
   * tool's custom image (see SELECT_AREA_CURSORS) and waits for the next
   * left-click on mesh surface to place the shape (see
   * handleSceneObjectPointer()/handleSelectAreaClick()). */
  private startSelectAreaTool(kind: "sphere" | "box"): void {
    if (this.loadedDraws.length === 0) {
      this.setStatus("Reconstruct a scene first.");
      return;
    }
    this.cancelGroundPlaneTool(); // mutually exclusive with the ground-plane tool
    this.selectAreaToolActive = kind;
    this.sceneManager.renderer.domElement.style.cursor = SceneViewerApp.SELECT_AREA_CURSORS[kind];
    this.elements.toolsMenu.selectVolumeSubmenu.selectSphereBtn.classList.toggle("active", kind === "sphere");
    this.elements.toolsMenu.selectVolumeSubmenu.selectBoxBtn.classList.toggle("active", kind === "box");
    const shapeName = kind === "sphere" ? "Sphere" : "Box";
    this.setStatus(`${shapeName} select: click the mesh surface to place it (right-click to cancel).`);
  }

  /** Disarms whichever select-area tool is active (if any) without placing
   * anything - restores the normal cursor. Does NOT remove an
   * already-placed shape (see clearSelectAreaShape() for that); harmless to
   * call when no tool is active. */
  private cancelVolumeSelectTool(): void {
    this.selectAreaToolActive = null;
    this.sceneManager.renderer.domElement.style.cursor = "";
    this.elements.toolsMenu.selectVolumeSubmenu.selectSphereBtn.classList.remove("active");
    this.elements.toolsMenu.selectVolumeSubmenu.selectBoxBtn.classList.remove("active");
  }

  /** Called every frame (see SceneManager.onBeforeRender()) to keep the
   * gizmo's transform current - a no-op whenever there's nothing to
   * update. */
  private updateSelectAreaGizmoTransform(): void {
    const gizmo = this.selectAreaGizmo;
    const group = this.sceneManager.getContentGroup();
    if (!gizmo || !group) return;
    gizmo.update(this.sceneManager.camera, group.quaternion, group.scale.x || 1);
  }

  /** Switches the gizmo's mode (and remembers the choice for the next
   * shape/gizmo too - see selectAreaGizmoMode's doc comment), then
   * refreshes the options panel so its Move/Scale buttons reflect it. */
  private setSelectAreaGizmoMode(mode: GizmoMode): void {
    this.selectAreaGizmoMode = mode;
    this.selectAreaGizmo?.setMode(mode);
    this.renderSelectAreaOptionsPanel();
  }

  private isTypingInFormField(): boolean {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  }

  /** 'G' (translate) / 'S' (scale) gizmo-mode shortcuts, matching Blender's
   * own grab/scale keys - only while there's actually a shape/gizmo to
   * affect, and guarded against typing in a form field and against fly
   * mode (where 'S' is already a movement key in both control schemes -
   * see movement-bindings.interface.ts). */
  private handleGizmoKeydown(event: KeyboardEvent): void {
    if (event.repeat || this.isTypingInFormField() || this.isFlying || !this.selectAreaShape) return;
    if (event.code === "KeyG") this.setSelectAreaGizmoMode("translate");
    else if (event.code === "KeyS") this.setSelectAreaGizmoMode("scale");
  }

  /** Drives both an in-progress gizmo drag (if any) and hover highlighting
   * (if not) - see wireEvents()'s window-level "pointermove" listener. */
  private handleGizmoPointerMove(event: PointerEvent): void {
    const gizmo = this.selectAreaGizmo;
    if (!gizmo) return;
    const group = this.sceneManager.getContentGroup();
    if (!group) return;

    if (gizmo.isDragging()) {
      const raycaster = this.buildViewportRaycaster(event);
      gizmo.updateDrag(raycaster, this.sceneManager.camera, group.quaternion, group.scale.x || 1, event.clientX, event.clientY);
      return;
    }

    // Hover feedback only - never while a placement tool is armed (those
    // take priority over the gizmo entirely - see handleSceneObjectPointer()),
    // and only while the cursor is actually over the canvas.
    if (this.groundPlaneToolActive || this.selectAreaToolActive) {
      gizmo.setHighlight(null);
      return;
    }
    const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      gizmo.setHighlight(null);
      return;
    }
    gizmo.setHighlight(gizmo.hitTest(this.buildViewportRaycaster(event)));
  }

  private handleGizmoPointerUp(event: PointerEvent): void {
    if (event.button !== 0 || !this.selectAreaGizmo?.isDragging()) return;
    this.selectAreaGizmo.endDrag();
  }

  /** Handles one left-click while a select-area tool is armed: raycasts for
   * mesh surface under the cursor (ignored if it missed), places the shape
   * there, then disarms the tool - this is a single-click placement, unlike
   * the ground-plane tool's three. */
  private handleSelectAreaClick(event: PointerEvent): void {
    const kind = this.selectAreaToolActive;
    if (!kind) return;

    const worldHit = this.raycastMeshSurface(event);
    if (worldHit) this.placeSelectAreaShape(kind, worldHit);
    this.cancelVolumeSelectTool();
  }

  /** Places (replacing any existing one - see clearSelectAreaShape()) a
   * new select-area shape centered on worldHit, sized so it initially
   * covers 10% of the viewport's width. */
  private placeSelectAreaShape(kind: "sphere" | "box", worldHit: THREE.Vector3): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;

    // "10% of the viewport width" is a SCREEN-space fraction, which (under
    // a perspective camera) corresponds to a different WORLD size
    // depending on how far away the clicked point is - convert via the
    // camera's horizontal FOV at that distance, then divide out the
    // content group's own (uniform) scale to get back to the LOCAL size
    // the shape's geometry/scale need to be specified in.
    const camera = this.sceneManager.camera;
    const distance = Math.max(camera.position.distanceTo(worldHit), 1e-6);
    const vFov = (camera.fov * Math.PI) / 180;
    const viewportWorldWidth = 2 * distance * Math.tan(vFov / 2) * camera.aspect;
    const worldDiameter = viewportWorldWidth * 0.1;
    const groupScale = group.scale.x || 1;
    const localHalfExtent = Math.max(worldDiameter / groupScale / 2, 1e-6);

    const localPosition = group.worldToLocal(worldHit.clone());
    const localScale = new THREE.Vector3(localHalfExtent, localHalfExtent, localHalfExtent);
    this.restoreSelectAreaShape(kind, localPosition, localScale);
    this.setStatus(`${kind === "sphere" ? "Sphere" : "Box"} select area placed.`);
  }

  /** Builds and adds the actual select-area shape mesh at an already-known
   * LOCAL position/scale (replacing any existing shape - see
   * clearSelectAreaShape()), as a child of the content group so it
   * moves/rotates with the mesh exactly like the ground-plane tool's own
   * markers. Split out from placeSelectAreaShape() so rebuildVisibleScene()
   * can recreate the shape (from its previous position/scale) in the new
   * content group after a filter/visibility rebuild, without re-running the
   * viewport-width sizing math or requiring a fresh click. */
  private restoreSelectAreaShape(kind: "sphere" | "box", localPosition: THREE.Vector3, localScale: THREE.Vector3): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;
    this.clearSelectAreaShape();

    // Unit shapes (radius/half-extent 1, i.e. spanning -1..1 per axis) so
    // mesh.scale directly IS each axis' half-extent in local space -
    // that's what the gizmo's per-axis scale handles edit (see
    // select-area-gizmo.ts).
    const geometry = kind === "sphere" ? new THREE.SphereGeometry(1, 24, 16) : new THREE.BoxGeometry(2, 2, 2);
    const flatGeometry = geometry.toNonIndexed();
    flatGeometry.computeVertexNormals();
    this.applyFlatFaceVertexColors(flatGeometry);

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const shape = new THREE.Mesh(flatGeometry, material);
    shape.position.copy(localPosition);
    shape.scale.copy(localScale);
    shape.userData.isSelectAreaShape = true;
    shape.renderOrder = 998;

    group.add(shape);
    this.selectAreaShape = shape;
    this.selectAreaKind = kind;

    // A fresh gizmo INSTANCE (not a persisted/reattached one) - it's a
    // child of this same content group, which gets fully torn down and
    // rebuilt (see SceneManager.clear()) on every filter/visibility
    // change, so nothing about a previous instance could survive that
    // anyway. Sized (minScale) from the whole scene's own diagonal so
    // dragging a scale handle to near-zero can't collapse the shape
    // entirely, same reasoning the old slider UI's scaleMin used.
    this.selectAreaGizmo = new SelectAreaGizmo(shape, this.selectAreaGizmoMode);
    this.selectAreaGizmo.setMinScale(Math.max(boundsDiagonal(this.overallLocalBounds()) * 0.0005, 1e-9));
    group.add(this.selectAreaGizmo.object3d);

    this.renderSelectAreaOptionsPanel();
  }

  /** Bakes a per-triangle (genuinely flat/faceted, not smoothed) "shaded"
   * look into vertex colors for use with an UNLIT material
   * (MeshBasicMaterial + vertexColors:true). The main scene has no lights
   * at all - every other mesh in it uses MeshBasicMaterial too (see
   * resolveMaterial()/getUntexturedMaterial()) - so a normally-LIT material
   * like MeshStandardMaterial would just render pitch black here instead of
   * visibly faceted; this fakes the same "flat per-face" look without
   * needing any scene lighting. Expects geometry.toNonIndexed() +
   * computeVertexNormals() to already have been called (see
   * placeSelectAreaShape()), so each triangle's 3 vertices are unique to it
   * and share exactly that triangle's face normal - meaning all 3 get
   * exactly the same baked color, i.e. a uniform, flat-shaded face. */
  private applyFlatFaceVertexColors(geometry: THREE.BufferGeometry): void {
    const normalAttr = geometry.getAttribute("normal");
    const count = normalAttr.count;
    const colors = new Float32Array(count * 3);

    // Arbitrary fixed pseudo-light direction - not tied to any real light
    // or the camera, just needs to vary with face normal enough to read as
    // "faceted" rather than a single flat color.
    const lightDir = new THREE.Vector3(0.4, 0.8, 0.5).normalize();
    const minBrightness = 0.45;

    for (let i = 0; i < count; i++) {
      const nDotL = Math.max(
        0,
        normalAttr.getX(i) * lightDir.x + normalAttr.getY(i) * lightDir.y + normalAttr.getZ(i) * lightDir.z,
      );
      const brightness = minBrightness + (1 - minBrightness) * nDotL;
      colors[i * 3] = SELECTION_COLOR.r * brightness;
      colors[i * 3 + 1] = SELECTION_COLOR.g * brightness;
      colors[i * 3 + 2] = SELECTION_COLOR.b * brightness;
    }

    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  }

  /** Removes, disposes, and un-tracks the current select-area shape and its
   * gizmo (if any), and clears the options panel. Safe to call with
   * nothing placed. */
  private clearSelectAreaShape(): void {
    const group = this.sceneManager.getContentGroup();
    if (this.selectAreaGizmo) {
      group?.remove(this.selectAreaGizmo.object3d);
      this.selectAreaGizmo.dispose();
      this.selectAreaGizmo = null;
    }
    if (this.selectAreaShape) {
      group?.remove(this.selectAreaShape);
      this.selectAreaShape.geometry.dispose();
      const material = this.selectAreaShape.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
    this.selectAreaShape = null;
    this.selectAreaKind = null;
    this.renderSelectAreaOptionsPanel();
  }

  /** Rebuilds the "select area" options panel (#select-options-menu) from
   * scratch to match the current selectAreaShape - empty/hidden when
   * there's no shape placed, otherwise a small panel with Move/Scale
   * gizmo-mode buttons (reflecting selectAreaGizmoMode) and a Remove
   * button. Actual translating/scaling happens via the in-scene gizmo
   * itself (see select-area-gizmo.ts) or the 'G'/'S' shortcuts
   * (handleGizmoKeydown()), not through this panel. Called on every
   * placement, mode switch, and removal - there's no persistent DOM to
   * keep in sync incrementally, so it's simplest to just rebuild. */
  private renderSelectAreaOptionsPanel(): void {
    const kind = this.selectAreaKind;
    if (!kind) {
      this.selectOptionsMenu.classList.remove("menu");
      this.selectOptionsMenu.innerHTML = "";
      return;
    }

    const mode = this.selectAreaGizmoMode;
    this.selectOptionsMenu.classList.add("menu");
    this.selectOptionsMenu.innerHTML = `
      <div class="flex flex-row items-center justify-between gap-2">
        <b class="text-white">${kind === "sphere" ? "Sphere" : "Box"} select area</b>
        <div class="flex flex-row gap-2">
          <button class="${mode === "translate" ? "active" : ""}" data-select-area="mode-translate" title="Translate (G)">Move</button>
          <button class="${mode === "scale" ? "active" : ""}" data-select-area="mode-scale" title="Scale (S)">Scale</button>
          <button class="ghost" data-select-area="remove">Remove</button>
        </div>
      </div>
      <p class="subtitle" style="margin:8px 0 0">Drag the gizmo in the viewport to move or scale it. Press G/S to switch modes.</p>
    `;

    this.selectOptionsMenu
      .querySelector('[data-select-area="mode-translate"]')
      ?.addEventListener("click", () => this.setSelectAreaGizmoMode("translate"));
    this.selectOptionsMenu
      .querySelector('[data-select-area="mode-scale"]')
      ?.addEventListener("click", () => this.setSelectAreaGizmoMode("scale"));
    this.selectOptionsMenu
      .querySelector('[data-select-area="remove"]')
      ?.addEventListener("click", () => this.clearSelectAreaShape());
  }

  //#endregion

  /** Runs the matrix-based transform-correction fit independently for EVERY
   * loaded draw (including hidden ones - hiddenness only affects
   * rendering/selection, not the underlying data), rather than fitting one
   * correction from a single marked "scale reference" object and
   * broadcasting it to the whole scene. Each draw already carries its own
   * posed/non-posed vertex pair (geometryData/previewGeometryData - see
   * loadDraw()), from the SAME draw call, so each object can - and, since
   * different objects can genuinely be distorted differently (different
   * skinning, different shaders, different bones), *should* - fit and
   * apply its own correction instead of assuming one object's distortion
   * speaks for the whole scene.
   *
   * Always re-fits from draw.originalPosedPositions (a pristine copy taken
   * at load time - see loadDraw()) rather than from
   * draw.geometryData.positions, and writes the result into a NEW array
   * rather than mutating in place - so re-running this (e.g. after
   * changing the Up axis / handedness option) starts fresh each time
   * instead of compounding the previous run's correction onto itself.
   *
   * A draw with no separate posed export (originalPosedPositions is null -
   * see loadDraw()) has no posed/non-posed pair to fit a distortion from,
   * so it's skipped rather than fed a degenerate identity fit. A draw
   * whose fit fails for another reason (mismatched vertex counts,
   * degenerate/planar geometry - see calculateDistortionMatrix()) is also
   * skipped, logged, and counted, rather than aborting correction for the
   * rest of the scene. */
  private recalculateTransformCorrection(): void {
    if (this.loadedDraws.length === 0) {
      this.setStatus("Reconstruct a scene first.");
      return;
    }
    if (this.scaleReferenceIndex === null) {
      return;
    }

    const handedness = this.handednessSelect.value as HandednessMode;
    const upAxisMode = this.upAxisSelect.value as "auto" | "x" | "y" | "z" | "manual";
    const upAxisAdjustment = this.buildUpAxisAdjustment(upAxisMode);
    const upAxisAdjustment4 = new THREE.Matrix4().makeRotationFromQuaternion(upAxisAdjustment);

    let corrected = 0;
    let skipped = 0;
    const failures: string[] = [];

    const referenceObject = this.loadedDraws[this.scaleReferenceIndex];
    let distortion;
    try {
      distortion = calculateDistortionMatrix(
        { geometryData: { positions: referenceObject.originalPosedPositions }, previewGeometryData: referenceObject.previewGeometryData },
        { handedness },
      );
    } catch (e) {
      // const label = `eid${draw.draw.eventId}`;
      // failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      // console.warn(`[recalculateTransformCorrection] skipping ${label}`, e);
      // continue;
      return;
    }

    for (const draw of this.loadedDraws) {
      if (draw.originalPosedPositions === null) {
        skipped++;
        continue;
      }

      // Shape-only fix (posedToNonPosedInPlace) pivoted about this draw's
      // own posed centroid, plus the "Up axis" override (also pivoted
      // about that same centroid, applied after the shape fix) - see
      // buildUpAxisAdjustment() for why composing it this way avoids
      // fighting the whole-scene sceneRotation set up in reconstructScene().
      const c = distortion.posedCentroid;
      const pivotedUpAdjustment = new THREE.Matrix4()
        .makeTranslation(c.x, c.y, c.z)
        .multiply(upAxisAdjustment4)
        .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
      const finalMatrix = pivotedUpAdjustment.multiply(distortion.posedToNonPosedInPlace);

      const correctedPositions = draw.originalPosedPositions.slice();
      this.applyMatrixToPositions(correctedPositions, finalMatrix);
      draw.geometryData.positions = correctedPositions;
      draw.bounds = computeBounds(draw.geometryData.positions);
      draw.diagonal = boundsDiagonal(draw.bounds);
      corrected++;
    }

    if (corrected === 0) {
      this.setStatus(
        failures.length > 0
          ? `Distortion correction failed for all ${failures.length} eligible object(s) - first error: ${failures[0]}`
          : "No objects have a separate posed mesh to correct - nothing to do.",
      );
      return;
    }

    let overall: Bounds = this.loadedDraws[0].bounds;
    for (let i = 1; i < this.loadedDraws.length; i++) overall = unionBounds(overall, this.loadedDraws[i].bounds);
    const size = overall.max.clone().sub(overall.min);
    this.fixedScale = computeNormalizationScale(Math.max(size.x, size.y, size.z));

    this.rebuildVisibleScene();

    const statusParts = [`Applied per-object distortion correction to ${corrected} object(s)`];
    if (skipped > 0) statusParts.push(`${skipped} skipped (no separate posed mesh)`);
    if (failures.length > 0) statusParts.push(`${failures.length} failed (see console)`);
    this.setStatus(statusParts.join(", ") + ".");
  }

  /** Applies a 4x4 affine transform to every vertex in a flat, non-indexed
   * positions array (x0,y0,z0,x1,y1,z1,...), in place. */
  private applyMatrixToPositions(positions: number[], matrix: THREE.Matrix4): void {
    const v = new THREE.Vector3();
    for (let i = 0; i < positions.length; i += 3) {
      v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
      positions[i] = v.x;
      positions[i + 1] = v.y;
      positions[i + 2] = v.z;
    }
  }

  private describeTextureType(binding: { bindPoint: number; name: string | null; textureFile: string | null }): string {
    const haystack = `${binding.bindPoint} ${binding.name ?? ""} ${binding.textureFile ?? ""}`.toLowerCase();
    if (/normal|bump|height|detail/.test(haystack)) return "normal map";
    if (/metal|rough|gloss|spec|reflect/.test(haystack)) return "metalness / roughness";
    if (/albedo|basecolor|diffuse|color|albedo|base_color/.test(haystack)) return "albedo / diffuse";
    if (/emissive|light|illum/.test(haystack)) return "emissive";
    if (/ao|ambient|occlusion/.test(haystack)) return "AO / ambient";
    if (/mask|opacity|alpha/.test(haystack)) return "mask / opacity";
    if (binding.bindPoint === 0) return "albedo / diffuse";
    if (binding.bindPoint === 1) return "normal map";
    if (binding.bindPoint === 2) return "metalness / roughness";
    if (binding.bindPoint === 3) return "emissive";
    return `bind ${binding.bindPoint}`;
  }

  private attachMeshPreview(container: HTMLElement, draw: LoadedDraw): void {
    const previewCanvas = document.createElement("canvas");
    previewCanvas.className = "resource-preview-canvas";
    container.appendChild(previewCanvas);

    const renderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);

    const geometry = new THREE.BufferGeometry();
    const sourceData = draw.previewGeometryData ?? draw.geometryData;
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(sourceData.positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(sourceData.uvs, 2));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(sourceData.normals, 3));
    geometry.computeVertexNormals();

    const material = draw.material.clone();
    material.side = THREE.DoubleSide;
    material.needsUpdate = true;

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const bounds = computeBounds(sourceData.positions);
    const center = bounds.min.clone().add(bounds.max).multiplyScalar(0.5);
    const rawSize = bounds.max.clone().sub(bounds.min);

    // Non-posed preview copy: centered at the origin, then scaled down
    // (never up) to fit inside a 100x100x100 cube if it doesn't already -
    // applied as the mesh's own position/scale (not baked into the
    // geometry) so it's purely a property of this preview render, not of
    // sourceData itself. Object3D's local matrix scales geometry BEFORE
    // translating by position, so position has to be -scale*center (not
    // just -center) for the result to be "centered, then scaled" rather
    // than "centered by an unscaled offset, then scaled off-center".
    const PREVIEW_CUBE_SIZE = 100;
    const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z);
    const previewScale = maxDim > PREVIEW_CUBE_SIZE ? PREVIEW_CUBE_SIZE / maxDim : 1;
    mesh.position.copy(center).multiplyScalar(-previewScale);
    mesh.scale.setScalar(previewScale);

    const size = rawSize.clone().multiplyScalar(previewScale);
    const radius = Math.max(size.length() * 0.5, 0.25);
    const targetFill = 0.875;

    // Aspect-aware: as the panel is resized non-uniformly, the container
    // (and therefore the canvas - see resize() below, which now fills it
    // fully rather than a centered square) can end up wider or taller than
    // square. camera.fov is the VERTICAL fov, so for a portrait-ish aspect
    // the horizontal fov is the tighter constraint instead - use whichever
    // is smaller so the model stays approximately fully covering the
    // canvas regardless of its current shape.
    const computeFitDistance = (aspect: number): number => {
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
      const limitingFov = Math.min(vFov, hFov);
      return (radius / (targetFill * Math.tan(limitingFov / 2))) * 1.1;
    };

    let fitDistance = computeFitDistance(1);

    const modelRoot = new THREE.Group();
    modelRoot.add(mesh);
    scene.add(modelRoot);

    modelRoot.rotation.x = -0.65;
    modelRoot.rotation.y = 0.85;

    camera.position.set(0, 0, fitDistance);
    camera.lookAt(0, 0, 0);

    const light = new THREE.DirectionalLight(0xffffff, 1.3);
    light.position.set(1.5, 2.2, 2.5);
    scene.add(light);

    const fill = new THREE.HemisphereLight(0xb8d7ff, 0x1c2430, 0.75);
    scene.add(fill);

    let pointerDown = false;
    let lastX = 0;
    let lastY = 0;
    // currentDistance = fitDistance * zoomRatio - keeping the user's zoom as
    // a RATIO (rather than an absolute distance) means resizing the panel
    // (which changes fitDistance, see resize() below) preserves how far
    // // they'd zoomed in/out instead of resetting it.
    let zoomRatio = 1;
    let currentDistance = fitDistance;

    const handlePointerDown = (event: PointerEvent) => {
      // Left OR middle mouse button rotate - unlike the main viewport
      // (left click there selects an object, middle orbits), there's
      // nothing to select in this thumbnail, so both buttons are just
      // "rotate" here.
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault(); // stops the browser's middle-click autoscroll icon (and any drag/selection UI on left)
      pointerDown = true;
      lastX = event.clientX;
      lastY = event.clientY;
      previewCanvas.setPointerCapture(event.pointerId);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerDown) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      modelRoot.rotation.y += dx * 0.01;
      // Clamped to +-90 degrees so vertical dragging can't carry the model
      // past vertical and flip it upside down - horizontal dragging (yaw,
      // above) has no such limit since spinning all the way around is fine.
      const PITCH_LIMIT = Math.PI / 2;
      modelRoot.rotation.x = THREE.MathUtils.clamp(
        modelRoot.rotation.x + dy * 0.01,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
    };
    const handlePointerUp = (event: PointerEvent) => {
      pointerDown = false;
      previewCanvas.releasePointerCapture(event.pointerId);
    };
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const zoomFactor = Math.exp(-event.deltaY * 0.0015);
      zoomRatio = THREE.MathUtils.clamp(zoomRatio * zoomFactor, 0.2, 6);
      currentDistance = fitDistance * zoomRatio;
      camera.position.set(0, 0, currentDistance);
      camera.lookAt(0, 0, 0);
    };

    previewCanvas.addEventListener("pointerdown", handlePointerDown);
    previewCanvas.addEventListener("pointermove", handlePointerMove);
    previewCanvas.addEventListener("pointerup", handlePointerUp);
    previewCanvas.addEventListener("pointerleave", () => {
      pointerDown = false;
    });
    previewCanvas.addEventListener("wheel", handleWheel, { passive: false });

    const resize = () => {
      // Fill the container's actual (possibly non-square) size, rather
      // than a centered square inscribed within it - "canvas should grow
      // to fill the available space" as the panel is resized.
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height, false);
      const aspect = width / height;
      camera.aspect = aspect;
      fitDistance = computeFitDistance(aspect);
      currentDistance = fitDistance * zoomRatio;
      camera.position.set(0, 0, currentDistance);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
    };

    const onResize = () => resize();
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    const tick = () => {
      if (!container.isConnected) {
        renderer.dispose();
        resizeObserver.disconnect();
        return;
      }
      renderer.render(scene, camera);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    resize();
  }

  private syncResourcePanelPosition(): void {
    const panel = this.viewport.querySelector<HTMLElement>(".resource-panel");
    if (!panel) return;

    const index = Number(panel.dataset.index);
    if (!Number.isInteger(index)) return;

    const row = this.objectList.querySelector<HTMLElement>(`.draw-row-wrap[data-index="${index}"] .draw-item`);
    if (!row) return;

    const viewportRect = this.viewport.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const minWidth = this.resourcePanelMinSize.width;
    const minHeight = this.resourcePanelMinSize.height;
    const panelWidth = Math.max(minWidth, Math.min(this.resourcePanelSize.width, viewportRect.width - 24));
    const panelHeight = Math.max(minHeight, Math.min(this.resourcePanelSize.height, viewportRect.height - 24));
    panel.style.width = `${panelWidth}px`;
    panel.style.height = `${panelHeight}px`;

    const left = Math.min(rowRect.right - viewportRect.left + 12, viewportRect.width - panelWidth - 12);
    const top = Math.min(rowRect.top - viewportRect.top, viewportRect.height - panelHeight - 12);

    panel.style.left = `${Math.max(12, left)}px`;
    panel.style.top = `${Math.max(12, top)}px`;
  }

  /** The panel's minimum no-overflow size, computed from the ACTUAL current
   * viewport height (25vh preview + the fixed 12.5vh+48px texture row +
   * measured header/subhead heights + padding) - matches the CSS rules on
   * .resource-preview/.resource-texture-list exactly, so the panel's
   * initial size never needs a scrollbar or clips anything (other than the
   * texture row's own deliberate horizontal scroll). Must be called AFTER
   * the panel (with its real header/subhead text already in place) is in
   * the DOM, since it measures their actual rendered heights rather than
   * guessing - a header can wrap to more than one line depending on the
   * object's name length, for instance. */
  private computeResourcePanelMinSize(panel: HTMLElement): { width: number; height: number } {
    const vh = window.innerHeight / 100;
    const previewSize = 25 * vh;
    const textureRowHeight = 12.5 * vh + 48; // matches .resource-texture-list's fixed CSS height

    const header = panel.querySelector<HTMLElement>(".resource-header");
    const subhead = panel.querySelector<HTMLElement>(".resource-subhead");
    const panelStyle = getComputedStyle(panel);
    const paddingX = parseFloat(panelStyle.paddingLeft || "0") + parseFloat(panelStyle.paddingRight || "0");
    const paddingY = parseFloat(panelStyle.paddingTop || "0") + parseFloat(panelStyle.paddingBottom || "0");

    const headerHeight = header?.offsetHeight ?? 20;
    const subheadHeight = subhead?.offsetHeight ?? 18;
    const previewMarginBottom = 8; // matches .resource-preview's margin-bottom in CSS

    return {
      width: Math.ceil(previewSize + paddingX),
      height: Math.ceil(headerHeight + previewSize + previewMarginBottom + subheadHeight + textureRowHeight + paddingY),
    };
  }

  private startResourceResize(panel: HTMLElement, corner: HTMLElement, event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const origin = {
      x: event.clientX,
      y: event.clientY,
      width: panel.offsetWidth,
      height: panel.offsetHeight,
      left: panel.offsetLeft,
      top: panel.offsetTop,
    };
    const cornerName = corner.dataset.corner;

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - origin.x;
      const dy = moveEvent.clientY - origin.y;
      const viewRect = this.viewport.getBoundingClientRect();
      const minWidth = this.resourcePanelMinSize.width;
      const minHeight = this.resourcePanelMinSize.height;
      const maxWidth = Math.max(minWidth, viewRect.width - 24);
      const maxHeight = Math.max(minHeight, viewRect.height - 24);

      let nextWidth = origin.width;
      let nextHeight = origin.height;
      let nextTop = origin.top;
      let nextLeft = origin.left;

      if (cornerName === "upper-right") {
        nextWidth = Math.min(Math.max(origin.width + dx, minWidth), maxWidth);
        nextHeight = Math.min(Math.max(origin.height - dy, minHeight), maxHeight);
        nextTop = Math.min(Math.max(origin.top + dy, 12), viewRect.height - nextHeight - 12);
      } else {
        nextWidth = Math.min(Math.max(origin.width + dx, minWidth), maxWidth);
        nextHeight = Math.min(Math.max(origin.height + dy, minHeight), maxHeight);
      }

      this.resourcePanelSize = { width: nextWidth, height: nextHeight };
      panel.style.width = `${nextWidth}px`;
      panel.style.height = `${nextHeight}px`;
      panel.style.left = `${Math.min(Math.max(nextLeft, 12), viewRect.width - nextWidth - 12)}px`;
      panel.style.top = `${Math.min(Math.max(nextTop, 12), viewRect.height - nextHeight - 12)}px`;
    };

    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  private resolveTexturePath(draw: LoadedDraw, textureFile: string | null): string | null {
    if (!textureFile) return null;

    const raw = textureFile.replace(/\\/g, "/").replace(/^\.\//, "");
    const meshPath = draw.meshPath ?? "";
    const meshDir = dirname(meshPath);
    const parts = raw.split("/").filter(Boolean);
    const baseName = parts.length > 0 ? parts[parts.length - 1] : raw;

    const candidates = new Set<string>([
      raw,
      joinPath(meshDir, raw),
      joinPath(dirname(meshDir), raw),
      joinPath(meshDir, baseName),
      joinPath(dirname(meshDir), baseName),
      baseName,
    ]);

    for (const candidate of candidates) {
      const resolved = this.vfs.get(candidate);
      if (resolved) return candidate;
    }

    for (const key of this.vfs.keys()) {
      const normalized = key.replace(/\\/g, "/");
      if (normalized === raw || normalized.endsWith(`/${raw}`) || normalized.endsWith(`/${baseName}`)) {
        return normalized;
      }
    }

    return null;
  }

  private loadTextureThumb(img: HTMLImageElement, file: File): void {
    const asBlob = URL.createObjectURL(file);
    img.decoding = "async";
    img.onload = () => {
      console.log('texture image loaded.')
      img.dataset.loaded = "true";
    };
    img.onerror = () => {
      console.warn('failed to load texture image')
      img.replaceWith(Object.assign(document.createElement("div"), {
        className: "resource-texture-thumb resource-texture-thumb--missing",
        textContent: "No image",
      }));
    };
    img.src = asBlob;
  }

  private showResources(index: number): void {
    const existing = this.viewport.querySelector<HTMLElement>(".resource-panel");
    if (existing) {
      if (existing.dataset.index === String(index)) {
        existing.remove();
        return;
      }
      existing.remove();
    }

    const draw = this.loadedDraws[index];
    if (!draw) return;

    const panel = document.createElement("aside");
    panel.className = "resource-panel";
    panel.dataset.index = String(index);

    const textureItems = draw.draw.textures.length
      ? draw.draw.textures
          .map((binding) => {
            const fileName = binding.textureFile || binding.name || "unnamed texture";
            const kind = this.describeTextureType(binding);
            const resolvedPath = this.resolveTexturePath(draw, binding.textureFile);
            const imageMarkup = resolvedPath
              ? `<img class="resource-texture-thumb" data-texture-path="${resolvedPath}" alt="${fileName}" />`
              : "<div class=\"resource-texture-thumb resource-texture-thumb--missing\">No image</div>";
            return `
              <li data-texture-path="${resolvedPath ?? ""}">
                ${imageMarkup}
                <span class="resource-texture-kind">${kind}</span>
                <span class="resource-texture-file">${fileName}</span>
              </li>`;
          })
          .join("")
      : "<li class=\"empty\">No textures bound to this draw.</li>";

    const previewText = draw.previewPath ? `Previewing ${draw.previewPath}` : "Preview mesh";
    panel.innerHTML = `
      <div class="resource-header">${previewText}</div>
      <div class="resource-preview"></div>
      <div class="resource-subhead">Textures</div>
      <ul class="resource-texture-list">${textureItems}</ul>
      <div class="resource-corner resource-corner--upper-right" data-corner="upper-right" aria-label="Resize preview"></div>
      <div class="resource-corner resource-corner--lower-right" data-corner="lower-right" aria-label="Resize preview"></div>
    `;

    const previewHost = panel.querySelector<HTMLElement>(".resource-preview");
    if (previewHost) this.attachMeshPreview(previewHost, draw);

    panel.querySelectorAll<HTMLElement>(".resource-corner").forEach((handle) => {
      handle.addEventListener("pointerdown", (event) => this.startResourceResize(panel, handle, event as PointerEvent));
    });

    panel.querySelectorAll<HTMLImageElement>(".resource-texture-thumb[data-texture-path]").forEach((img) => {
      const filePath = img.dataset.texturePath;
      console.info('> processing img tag. Trying to load texture:', filePath, ' — img.dataset:', img.dataset);
      if (!filePath) return;
      const file = this.vfs.get(filePath);
      console.info('> processing img tag. Attempting to load file', filePath, ' — file from vfs:', file, '\nvfs:', this.vfs);

      if (!file) return;

      const isLikelyImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(file.name);
      if (isLikelyImage) {
        this.loadTextureThumb(img, file);
      } else {
        img.replaceWith(Object.assign(document.createElement("div"), {
          className: "resource-texture-thumb resource-texture-thumb--missing",
          textContent: "No image",
        }));
      }
    });

    this.viewport.appendChild(panel);

    // Recompute the minimum size from the panel's actual rendered content
    // and the CURRENT viewport height (25vh/12.5vh are relative to it) -
    // done every time a panel is opened so it stays correct even if the
    // browser window was resized since the last time one was shown. Any
    // larger size the user had previously dragged to is preserved.
    const minSize = this.computeResourcePanelMinSize(panel);
    this.resourcePanelMinSize = minSize;
    this.resourcePanelSize = {
      width: Math.max(this.resourcePanelSize.width, minSize.width),
      height: Math.max(this.resourcePanelSize.height, minSize.height),
    };
    this.syncResourcePanelPosition();
  }

  private isObjectHidden(index: number): boolean {
    return this.hiddenDrawIndices.has(index);
  }

  /** 'f' (filtered - excluded by the size slider, takes priority and the
   * vis button is disabled), 'h' (manually hidden), or 'v' (visible,
   * default). */
  private getVisibilityState(index: number): "f" | "h" | "v" {
    if (this.isObjectHidden(index)) return "f";
    return this.manuallyHiddenIndices.has(index) ? "h" : "v";
  }

  /** Replaces the selection with exactly this one object. The plain-click
   * (no modifiers) behavior. */
  private selectOnly(index: number): void {
    if (this.isObjectHidden(index)) return;
    this.selectedIndices.clear();
    this.selectedIndices.add(index);
    this.lastClickedIndex = index;
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  /** Replaces the selection with every VISIBLE object between the anchor
   * (this.lastClickedIndex) and index, inclusive - hidden objects within
   * that range are skipped rather than selected. The shift-click behavior.
   * Falls back to a plain select if there's no prior anchor (e.g. the very
   * first click on the list is a shift-click). */
  private selectRangeTo(index: number): void {
    if (this.isObjectHidden(index)) return;
    const anchor = this.lastClickedIndex ?? index;
    const lo = Math.min(anchor, index);
    const hi = Math.max(anchor, index);
    this.selectedIndices.clear();
    for (let i = lo; i <= hi; i++) {
      if (!this.isObjectHidden(i)) this.selectedIndices.add(i);
    }
    // Anchor intentionally left unchanged - see lastClickedIndex's doc comment.
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  /** Central dispatch for anything that affects selection: a plain click on
   * a row, a ctrl/shift-click on a row, or a click on the "selection"
   * button (which the caller maps onto this the same way, per spec: a
   * plain click on that button behaves like a ctrl-click on the row, while
   * an actually-modified click on it behaves exactly like the same
   * modifier on the row). Hidden objects (excluded by the size filter)
   * can't be selected at all. */
  private handleObjectClick(index: number, shiftKey: boolean, ctrlKey: boolean): void {
    if (this.isObjectHidden(index)) return;
    if (shiftKey) this.selectRangeTo(index);
    else if (ctrlKey) this.toggleDrawSelection(index);
    else this.selectOnly(index);
  }

  private pickDrawAtPointer(event: PointerEvent): number | null {
    const target = this.sceneManager.renderer.domElement;
    const rect = target.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.sceneManager.camera);
    const contentGroup = this.sceneManager.getContentGroup();
    const roots = contentGroup ? [contentGroup] : this.sceneManager.scene.children;
    const hits = raycaster.intersectObjects(roots, true).filter((hit) => !hit.object.userData.isSelectionVisual);
    const hit = hits.find((entry) => {
      const drawIndices = entry.object.userData.drawIndices;
      return Array.isArray(drawIndices) && drawIndices.length > 0;
    });
    if (!hit) return null;

    // A single mesh here is usually a MaterialMergeGroup batch of many
    // draws sharing one material (see SceneMeshBuilder) - drawIndices[0]
    // would just be "the first draw in the batch", not the one actually
    // under the cursor. faceDrawIndices maps the raycast's own faceIndex
    // (which triangle of the merged, non-indexed geometry was hit) back to
    // the specific draw that triangle came from.
    const faceDrawIndices = hit.object.userData.faceDrawIndices as Uint32Array | undefined;
    if (faceDrawIndices && hit.faceIndex !== undefined && hit.faceIndex !== null) {
      const owner = faceDrawIndices[hit.faceIndex];
      if (owner !== undefined) return owner;
    }

    // Fallback for objects without a face map (e.g. selection visuals that
    // slipped through, or single-draw batches) - only correct when the
    // batch really does contain just one draw.
    const drawIndices = hit.object.userData.drawIndices;
    if (Array.isArray(drawIndices) && drawIndices.length > 0) return Number(drawIndices[0]);
    return null;
  }

  private scrollDrawIntoView(index: number): void {
    const row = this.objectList.querySelector<HTMLElement>(`.draw-item[data-index="${index}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private handleSceneObjectPointer(event: PointerEvent): void {
    // Gizmo handles take priority over everything else EXCEPT an armed
    // placement tool (ground-plane/select-area) - those already fully
    // claim left-click for their own purposes while active, so skip gizmo
    // hit-testing entirely rather than risk a stray gizmo drag starting
    // mid-placement.
    if (event.button === 0 && this.selectAreaGizmo && !this.groundPlaneToolActive && !this.selectAreaToolActive) {
      const group = this.sceneManager.getContentGroup();
      if (group) {
        const raycaster = this.buildViewportRaycaster(event);
        const handle = this.selectAreaGizmo.hitTest(raycaster);
        if (handle) {
          event.preventDefault();
          this.selectAreaGizmo.beginDrag(
            handle,
            raycaster,
            this.sceneManager.camera,
            group.quaternion,
            group.scale.x || 1,
            this.sceneManager.renderer.domElement.getBoundingClientRect(),
            event.clientX,
            event.clientY,
          );
          return;
        }
      }
    }
    if (this.groundPlaneToolActive) {
      if (event.button === 2) this.cancelGroundPlaneTool();
      else if (event.button === 0) this.handleGroundPlaneClick(event);
      return;
    }
    if (this.selectAreaToolActive) {
      if (event.button === 2) this.cancelVolumeSelectTool();
      else if (event.button === 0) this.handleSelectAreaClick(event);
      return;
    }
    if (event.button === 1) return;
    const index = this.pickDrawAtPointer(event);

    if (event.button === 2) {
      if (index === null || this.isObjectHidden(index) || this.manuallyHiddenIndices.has(index)) {
        if (this.selectedIndices.size > 0) {
          this.selectedIndices.clear();
          this.lastClickedIndex = null;
          this.refreshSelectionVisuals();
          this.renderObjectListState();
        }
        return;
      }

      if (!this.selectedIndices.has(index)) {
        this.selectedIndices.clear();
        this.lastClickedIndex = null;
        this.refreshSelectionVisuals();
        this.renderObjectListState();
      }
      return;
    }

    if (index === null || this.isObjectHidden(index) || this.manuallyHiddenIndices.has(index)) return;

    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      if (this.selectedIndices.has(index)) this.selectedIndices.delete(index);
      else this.selectedIndices.add(index);
    } else {
      this.selectedIndices.clear();
      this.selectedIndices.add(index);
    }

    this.lastClickedIndex = index;
    this.refreshSelectionVisuals();
    this.renderObjectListState();
    this.scrollDrawIntoView(index);
  }

  /** Rebuilds the selection highlight (outline + dot markers) from scratch -
   * cheap enough to call on every selection change since it only touches
   * the small selected subset, not the full merged scene. */
  private refreshSelectionVisuals(): void {
    this.clearSelectionVisuals();
    this.updateSelectionVisuals();
  }

  /** Removes and disposes every currently-tracked selection visual. Safe to
   * call with an empty list. Must run BEFORE sceneManager.clear()/a fresh
   * addContent() call, since these objects live inside the content group
   * that gets torn down and rebuilt - sceneManager.clear() only knows how
   * to dispose the Mesh objects it owns directly, not app-level overlay
   * objects like these Points markers. */
  private clearSelectionVisuals(): void {
    const group = this.sceneManager.getContentGroup();
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    for (const obj of this.selectionVisuals) {
      group?.remove(obj);
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        // The two dot markers in a pair (outline + fill) intentionally
        // share one BufferGeometry - guard against disposing it twice.
        if (!disposedGeometries.has(obj.geometry)) {
          obj.geometry.dispose();
          disposedGeometries.add(obj.geometry);
        }
        const material = obj.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    }
    this.selectionVisuals = [];
  }

  /** Refreshes everything selection-related: recolors selected/dimmed
   * triangles (applySelectionShading()), rebuilds the outline's mask
   * geometry (rebuildSelectionOutlineMask()) - the actual outline drawing
   * happens continuously in renderSelectionOutlinePass(), not here - and,
   * for the currently-selected, currently-rendered objects, (re)builds
   * both center-dot marker pairs, adding them to the content group.
   * Selected objects that are filtered or manually hidden right now are
   * excluded from outlining/marking - there's nothing to draw if they're
   * not actually being rendered - but the shading and mask-rebuild passes
   * above still run regardless, so hiding the last visible selected object
   * still clears any leftover dimming/outline. */
  private updateSelectionVisuals(): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;

    const activeSelected = Array.from(this.selectedIndices).filter(
      (i) => !this.isObjectHidden(i) && !this.manuallyHiddenIndices.has(i),
    );

    // Recolors selected/non-selected triangles (or restores everything to
    // normal if activeSelected is empty) - see applySelectionShading()'s
    // doc comment. Always runs, regardless of whether there's anything to
    // outline below.
    this.applySelectionShading();

    // Rebuilds the image-space outline's mask geometry (see
    // rebuildSelectionOutlineMask()) - also unconditional, since an empty
    // activeSelected needs to clear out any previous mask just as much as
    // a non-empty one needs to populate it.
    this.rebuildSelectionOutlineMask(activeSelected);

    if (activeSelected.length === 0) return;

    const perObjectCenters: number[] = [];
    let unionBoundsAcc: Bounds | null = null;
    for (const index of activeSelected) {
      const bounds = this.loadedDraws[index].bounds;
      const center = boundsCenter(bounds);
      perObjectCenters.push(center.x, center.y, center.z);
      unionBoundsAcc = unionBoundsAcc ? unionBounds(unionBoundsAcc, bounds) : bounds;
    }
    // #f82 - one dot per selected object, at its own bounding-box center.
    this.addDotPair(group, perObjectCenters, 0xff8822);

    if (unionBoundsAcc) {
      const center = boundsCenter(unionBoundsAcc);
      // #fa6 - one dot at the center of the whole selection (the bounding
      // box that contains every selected object's bounding box).
      this.addDotPair(group, [center.x, center.y, center.z], 0xffaa66);
    }
  }

  /** Applies the "selected mesh(es) turn solid flat-shaded orange, every
   * other mesh darkens by 50%" look (or, with nothing selected, restores
   * everything to normal). Runs per merged BATCH mesh (what's actually in
   * the scene graph - see SceneMeshBuilder), but recolors per TRIANGLE
   * within each one using that mesh's precomputed faceDrawIndices (see
   * mesh-builder.ts) rather than treating a whole batch as one unit - a
   * batch is a group of draws sharing one material, so it very often mixes
   * selected and non-selected draws together, and the old draw-index-based
   * dimming here couldn't tell those apart.
   *
   * A mesh's material is only ever swapped for a cached shader variant (see
   * buildSelectionShaderMaterial()) or restored to its original - never
   * mutated in place - so repeated selection changes can't accumulate
   * clones-of-clones, and a mesh with nothing selected always ends up back
   * at pixel-identical output to before any selection existed. */
  private applySelectionShading(): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;

    const hasSelection = this.selectedIndices.size > 0;

    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || obj.userData.isSelectionVisual) return;
      const faceDrawIndices = obj.userData.faceDrawIndices as Uint32Array | undefined;
      if (!faceDrawIndices) return;

      // Stash the pristine material the first time this (freshly built -
      // see addContent()) mesh is seen, so there's always something exact
      // to restore to, regardless of how many times its material gets
      // swapped afterward.
      const baseMaterial = (obj.userData.baseMaterial as THREE.Material | undefined) ?? obj.material;
      obj.userData.baseMaterial = baseMaterial;

      if (!hasSelection) {
        obj.material = baseMaterial;
        return;
      }

      // One flag per triangle, expanded to 3 (one per vertex, since the
      // geometry is non-indexed - see mesh-builder.ts) - lets the shader
      // below shade each triangle according to whether ITS OWN draw is
      // selected, not the batch as a whole.
      const vertexCount = faceDrawIndices.length * 3;
      const selectedFlags = new Float32Array(vertexCount);
      for (let face = 0; face < faceDrawIndices.length; face++) {
        const flag = this.selectedIndices.has(faceDrawIndices[face]) ? 1 : 0;
        const base = face * 3;
        selectedFlags[base] = flag;
        selectedFlags[base + 1] = flag;
        selectedFlags[base + 2] = flag;
      }
      obj.geometry.setAttribute("aSelected", new THREE.Float32BufferAttribute(selectedFlags, 1));

      let shaded = this.selectionShaderCache.get(baseMaterial);
      if (!shaded) {
        shaded = this.buildSelectionShaderMaterial(baseMaterial);
        this.selectionShaderCache.set(baseMaterial, shaded);
      }
      obj.material = shaded;
    });
  }

  /** Clones a batch mesh's own (always MeshBasicMaterial - see
   * mesh-builder.ts) material into one that branches per-vertex on the
   * "aSelected" attribute applySelectionShading() maintains: triangles
   * belonging to a selected draw render as flat, per-face-shaded
   * SELECTION_COLOR (texture/vertex-color ignored entirely); everything
   * else renders as normal, just at 50% brightness. The "flat per-face"
   * look comes from computing a face normal in the fragment shader via
   * screen-space derivatives (dFdx/dFdy) of a view-space position varying,
   * rather than trusting the mesh's own (likely smoothed) normal attribute
   * - that's what makes each triangle read as a distinct facet instead of
   * a uniform flat blob. There's no actual light in this scene (everything
   * else here is unlit MeshBasicMaterial - see scene-manager.ts), so the
   * "light direction" is just a fixed vector chosen to give a pleasant
   * range of shading across a typical model's orientation.
   *
   * Returns the material unchanged (no clone) if `base` isn't a
   * MeshBasicMaterial - would only happen if a new material type is
   * introduced elsewhere and this wasn't updated to match, and rendering
   * that mesh unmodified is a safer failure mode than a broken shader. */
  private buildSelectionShaderMaterial(base: THREE.Material): THREE.Material {
    if (!(base instanceof THREE.MeshBasicMaterial)) return base;

    const c = SELECTION_COLOR;
    const shaded = base.clone();
    shaded.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "attribute float aSelected;\nvarying float vSelected;\nvarying vec3 vSelectionViewPos;\n#include <common>",
        )
        .replace(
          "#include <project_vertex>",
          "#include <project_vertex>\nvSelected = aSelected;\nvSelectionViewPos = mvPosition.xyz;",
        );

      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "varying float vSelected;\nvarying vec3 vSelectionViewPos;\n#include <common>")
        .replace(
          "#include <specularmap_fragment>",
          `#include <specularmap_fragment>
          if ( vSelected > 0.5 ) {
            vec3 faceNormal = normalize( cross( dFdx( vSelectionViewPos ), dFdy( vSelectionViewPos ) ) );
            // abs() rather than clamp(): OBJ meshes don't reliably have
            // consistent winding, and we don't have or want a real light
            // to orient against - this just avoids any facet going
            // completely black if its normal happens to point "away".
            float ndotl = abs( dot( faceNormal, normalize( vec3( 0.35, 0.55, 0.77 ) ) ) );
            float shade = 0.45 + 0.55 * ndotl;
            diffuseColor.rgb = vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}) * shade;
          } else {
            diffuseColor.rgb *= 0.5;
          }`,
        );
    };
    shaded.needsUpdate = true;
    return shaded;
  }

  /** One-time setup for the selection outline's render pass (see the
   * outlineMaskScene/outlineQuadScene field doc comment for the overall
   * approach and why it replaced the earlier mesh-geometry-based
   * techniques). Builds the fullscreen quad and its mask-sampling shader,
   * and registers the actual per-frame render work with the SceneManager
   * so it runs every frame regardless of whether anything else in the app
   * triggers a redraw (needed because the outline's on-screen position
   * must track the camera continuously, not just at selection-change
   * time). Called once, from the constructor. */
  private setupSelectionOutlinePass(): void {
    this.outlineMaskScene.add(this.outlineMaskGroup);

    this.outlineQuadMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uMask: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
        uThicknessPixels: { value: OUTLINE_THICKNESS_PIXELS },
        uColor: { value: SELECTION_COLOR },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4( position.xy, 0.0, 1.0 );
        }
      `,
      // For every screen pixel NOT covered by the selection mask, checks a
      // ring of sample points at radius uThicknessPixels around it - if
      // any of those samples IS covered, this pixel is part of the outline
      // ring (discard otherwise). This is a direct, angle- and
      // topology-independent read of "how close is this pixel to the
      // selection's silhouette", which is what makes it immune to the
      // failure modes of pushing the mesh's own geometry outward: it
      // doesn't care what the mesh's normals look like, how it's
      // tessellated, or which way any given triangle happens to be
      // facing - only the already-rasterized 2D shape of the mask matters.
      fragmentShader: `
        uniform sampler2D uMask;
        uniform vec2 uTexelSize;
        uniform float uThicknessPixels;
        uniform vec3 uColor;
        varying vec2 vUv;

        const int OUTLINE_SAMPLES = 16;

        void main() {
          if ( texture2D( uMask, vUv ).r > 0.5 ) discard;

          bool nearSelection = false;
          for ( int i = 0; i < OUTLINE_SAMPLES; i++ ) {
            float angle = 6.28318530718 * ( float( i ) / float( OUTLINE_SAMPLES ) );
            vec2 offset = vec2( cos( angle ), sin( angle ) ) * uThicknessPixels * uTexelSize;
            if ( texture2D( uMask, vUv + offset ).r > 0.5 ) {
              nearSelection = true;
              break;
            }
          }
          if ( !nearSelection ) discard;

          gl_FragColor = vec4( uColor, 1.0 );
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.userData.isSelectionVisual = true;
    ring.renderOrder = renderOrderBase + 1;

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.outlineQuadMaterial);
    quad.frustumCulled = false;
    this.outlineQuadScene.add(quad);

    this.sceneManager.onAfterRender(() => this.renderSelectionOutlinePass());
  }

  /** Rebuilds outlineMaskGroup's children from scratch to match the
   * currently-selected, currently-rendered draws - called once per
   * selection change from updateSelectionVisuals(), NOT every frame (unlike
   * the actual outline render pass, which does run every frame - see
   * renderSelectionOutlinePass()). Each selected draw becomes a plain white,
   * double-sided, depth-untested mesh: color and shading don't matter here
   * since this scene only ever gets sampled for "is this pixel covered at
   * all", and depthTest:false/no other content in this scene means the
   * mask always covers a selected draw's FULL silhouette, regardless of
   * what's occluding it in the real scene - which is what makes the
   * resulting outline visible through walls.
   *
   * Positions are added in the SAME local (pre-scale, pre-rotation) space
   * as draw.geometryData.positions itself - outlineMaskGroup's own
   * scale/rotation is what maps that into the real scene's space, and is
   * kept in sync with contentGroup's on EVERY FRAME by
   * renderSelectionOutlinePass(), not just here - see that method's doc
   * comment for why a one-time sync isn't enough. */
  private rebuildSelectionOutlineMask(activeSelected: number[]): void {
    for (const child of [...this.outlineMaskGroup.children]) {
      this.outlineMaskGroup.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }

    // Full transform (scale + rotation) sync happens every frame in
    // renderSelectionOutlinePass() - see this method's doc comment - so
    // nothing needs to be set on outlineMaskGroup here beyond its children.
    for (const index of activeSelected) {
      const { positions } = this.loadedDraws[index].geometryData;
      if (positions.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      this.outlineMaskGroup.add(new THREE.Mesh(geometry, material));
    }
  }

  /** Runs every frame (registered as a SceneManager afterRender hook - see
   * setupSelectionOutlinePass()): re-renders the selection mask from the
   * current camera into outlineMaskTarget, then draws the fullscreen ring
   * shader on top of the already-rendered main scene. A no-op cost-wise
   * whenever nothing is selected (returns immediately).
   *
   * Runs unconditionally every frame rather than only on selection change
   * because the mask has to be re-projected from whatever the camera is
   * doing right now - an outline computed once and left as static mesh
   * geometry (the old approach) can only ever be exactly correct for one
   * camera angle at a time.
   *
   * Also re-syncs outlineMaskGroup's own scale/rotation from contentGroup
   * every frame, for the same reason: contentGroup's transform can change
   * (recalculating transform correction, switching "Up axis" - including
   * to/from the ground-plane tool's "Manual" - or completing the
   * ground-plane tool itself) at any time OTHER than a selection change,
   * and none of those paths call rebuildSelectionOutlineMask(). Syncing
   * only there (as this used to) meant the mask could silently render with
   * a stale rotation and drift out of registration with the actual
   * (already-rotated) mesh - syncing it here instead means the outline can
   * never go stale regardless of which of those paths caused the change.
   * (The ground-plane tool's own dot/cross markers don't need this fix -
   * they're ordinary children of contentGroup itself, so they already pick
   * up any transform change for free through the normal scene graph.) */
  private renderSelectionOutlinePass(): void {
    if (!this.outlineQuadMaterial || this.outlineMaskGroup.children.length === 0) return;

    const contentGroup = this.sceneManager.getContentGroup();
    this.outlineMaskGroup.scale.setScalar(contentGroup?.scale.x ?? 1);
    this.outlineMaskGroup.quaternion.copy(contentGroup?.quaternion ?? new THREE.Quaternion());
    this.outlineMaskGroup.position.copy(contentGroup?.position ?? new THREE.Vector3());

    const renderer = this.sceneManager.renderer;
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    const width = Math.max(1, Math.round(size.x));
    const height = Math.max(1, Math.round(size.y));

    if (!this.outlineMaskTarget || this.outlineMaskTarget.width !== width || this.outlineMaskTarget.height !== height) {
      this.outlineMaskTarget?.dispose();
      this.outlineMaskTarget = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false,
        stencilBuffer: false,
      });
    }

    this.outlineQuadMaterial.uniforms.uMask.value = this.outlineMaskTarget.texture;
    this.outlineQuadMaterial.uniforms.uTexelSize.value.set(1 / width, 1 / height);

    // Saved/restored rather than assumed, since this hook runs interleaved
    // with SceneManager's own render call every frame and shouldn't leave
    // renderer state different from how it found it.
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousClearColor = new THREE.Color();
    renderer.getClearColor(previousClearColor);
    const previousClearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this.outlineMaskTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.render(this.outlineMaskScene, this.sceneManager.camera);

    // autoClear:false here is essential - the main scene was already drawn
    // to this same target (the canvas) by SceneManager just before this
    // hook ran, and a normal render() call defaults to clearing its target
    // first, which would erase it.
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.autoClear = false;
    renderer.render(this.outlineQuadScene, this.outlineQuadCamera);
    renderer.autoClear = previousAutoClear;
  }

  /** Adds one dot-marker pair (a black 1px-wider outline dot underneath, a
   * colored 3px dot on top) at each given xyz position. Both use
   * depthTest:false so they stay visible through occluding geometry, and
   * sizeAttenuation:false so the pixel sizes are literal screen-space
   * pixels rather than shrinking with distance. The pair shares one
   * BufferGeometry (see clearSelectionVisuals() for the matching
   * dispose-once handling). */
  private addDotPair(group: THREE.Group, positions: number[], fillColor: number): void {
    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

    const outlineMaterial = new THREE.PointsMaterial({
      color: 0x000000,
      size: 5, // 3px dot + 1px outline on each side
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
    });
    const fillMaterial = new THREE.PointsMaterial({
      color: fillColor,
      size: 3,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
    });

    const outline = new THREE.Points(geometry, outlineMaterial);
    const fill = new THREE.Points(geometry, fillMaterial);
    outline.userData.isSelectionVisual = true;
    fill.userData.isSelectionVisual = true;
    outline.renderOrder = 998; // black underneath
    fill.renderOrder = 999; // colored dot on top

    group.add(outline, fill);
    this.selectionVisuals.push(outline, fill);
  }

  /** Refreshes the object list's DOM to reflect current selection/hidden
   * state - called after any selection change and after rebuildVisibleScene
   * (since the hidden set can change independently, via the size filter). */
  private renderObjectListState(): void {
    for (const item of this.objectList.querySelectorAll<HTMLElement>(".draw-item")) {
      const index = Number(item.dataset.index);
      if (!Number.isInteger(index)) continue;

      const hidden = this.isObjectHidden(index);
      const selected = this.selectedIndices.has(index) && !hidden;

      item.classList.toggle("is-hidden-by-filter", hidden);
      item.classList.toggle("is-selected", selected);

      const selectionBtn = item.querySelector<HTMLButtonElement>('button[data-action="selection"]');
      if (selectionBtn) {
        selectionBtn.textContent = selected ? "[x]" : "[ ]";
        selectionBtn.disabled = hidden;
        selectionBtn.classList.toggle("active", selected);
      }

      const visBtn = item.querySelector<HTMLButtonElement>('button[data-action="visibility"]');
      if (visBtn) {
        const state = this.getVisibilityState(index);
        visBtn.textContent = state;
        visBtn.disabled = state === "f";
        visBtn.classList.toggle("state-hidden", state === "h");
      }

      const landmarkBtn = item.querySelector<HTMLButtonElement>('button[data-action="landmark"]');
      if (landmarkBtn) {
        const isScaleReference = this.scaleReferenceIndex === index;
        landmarkBtn.textContent = isScaleReference ? "[x]" : "[ ]";
        landmarkBtn.disabled = hidden;
        landmarkBtn.classList.toggle("active", isScaleReference);
      }
    }
  }

  private setupObjectList(): void {
    this.objectList.addEventListener("scroll", () => {
      this.syncResourcePanelPosition();
    });

    this.sceneManager.renderer.domElement.addEventListener("pointerdown", (event) => {
      if (event.button === 0 || event.button === 2) this.handleSceneObjectPointer(event as PointerEvent);
    });

    this.objectList.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const itemEl = target.closest<HTMLElement>("[data-index]");
      if (!itemEl) return;

      const index = Number(itemEl.dataset.index);
      if (!Number.isInteger(index)) return;

      const actionButton = target.closest<HTMLButtonElement>("button[data-action]");
      const action = actionButton?.dataset.action;

      if (action === "visibility") {
        this.toggleDrawVisibility(index);
        return;
      }
      if (action === "landmark") {
        this.setLandmark(index);
        return;
      }
      if (action === "resources") {
        this.showResources(index);
        return;
      }

      // Either the dedicated "selection" button, or a plain click anywhere
      // else on the row - both drive selection. A plain (unmodified) click
      // on the selection button is treated as a ctrl-click on the row; an
      // actually-modified click on it (ctrl or shift) behaves exactly like
      // that same modifier on the row itself.
      const isSelectionButton = action === "selection";
      const shiftKey = event.shiftKey;
      const ctrlKey = event.ctrlKey || event.metaKey || (isSelectionButton && !shiftKey);
      this.handleObjectClick(index, shiftKey, ctrlKey);
    });
  }
}
