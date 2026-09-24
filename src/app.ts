import * as THREE from "three";
import { dirname, joinPath, VirtualFileSystem } from "./filesystem";
import { type LoadedManifests } from "./manifest";
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
import { computeNormalizationScale, SceneManager, getDefaultViewDirection } from "./scene/scene-manager";
import { OrientationGizmo } from "./scene/orientation-gizmo";
import { SelectAreaGizmo, type GizmoMode } from "./scene/select-area-gizmo";
import { TextureManager } from "./scene/texture-manager";
import type { DrawEntry, ParsedOBJ } from "./types";
import { calculateDistortionMatrix, isGoodDistortionFitCandidate, findDistortionConsensus, type AffineDistortionResult } from "./mesh-tools/calculator";
import { splitGeometryByLooseParts, groupFixedMeshes, type NamedMeshPart, type MeshFixStatus } from "./mesh-tools/fill";
import { buildGlbBlob, type ExportMeshEntry, type ExportSceneTransform } from "./export/gltf-exporter";
import { CaptureImporter } from './components/capture-importer/cmp.capture-importer';
import { LoadingScreen } from './components/loading-screen/cmp.loading-screen';
import { Overlay } from './components/common/overlay/cmp.overlay';
import { ExportMesh } from './components/export-mesh/cmp.export-mesh';
import { Config, type AppConfiguration } from './config/cls.config';
import { UNIT_CONVERSION } from './util/const.unit-conversion';
import { remapObjOrientation } from './util/axis-orientation';
import { trianglesIntersect } from "fast-triangle-triangle-intersection";

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

  rawPreviewObj: ParsedOBJ | null;   // raw non-posed mesh, without any orientation corrections
  bounds: Bounds;
  diagonal: number;
  meshPath: string | null;
  previewPath: string | null;

  originalPosedPositions: number[] | null;
  originalPosedNormals: number[] | null;
  originalPosedUvs: number[] | null;

  appliedDistortionMatrix: THREE.Matrix4 | null;
}

/** A point-in-time snapshot of everything Ctrl+Z/Ctrl+Y travel through -
 * selection, manual visibility, and the landmark object. See
 * SceneViewerApp.pushUndoSnapshot()/undo()/redo(). */
interface HistorySnapshot {
  selectedIndices: Set<number>;
  lastClickedIndex: number | null;
  manuallyHiddenIndices: Set<number>;
  scaleReferenceIndex: number | null;
}

export class SceneViewerApp {
  private vfs = new VirtualFileSystem();
  private loaded: LoadedManifests | null = null;
  private textures = new TextureManager();
  private sceneManager: SceneManager;
  private appConfig: Config;

  private materialCache = new Map<string, THREE.Material>();
  private untexturedMaterial: THREE.Material | null = null;

  private loadedDraws: LoadedDraw[] = [];

  private fixedScale = 1;

  private hidePercent = 0;

  private hiddenDrawIndices = new Set<number>();       // geometry hidden by "hide largest %" filter
  private manuallyHiddenIndices = new Set<number>();   // geometry hidden manually

  private scaleReferenceIndex: number | null = null;   // index of the draw call for distortion fix calculation

  private intelGpaDistortion: AffineDistortionResult | null = null;  // distortion transform from IntelGPA landmark matching

  private showingRawImport = false;                     // enables or disables auto distortion correction

  private sceneRotation = new THREE.Quaternion();
  private lastDistortionSourceIndex: number | null = null;
  private worldUpAxis: "x" | "y" | "z" = "y";
  private groundPlaneToolActive = false;
  private groundPlanePoints: THREE.Vector3[] = [];

  private groundPlaneVisuals: THREE.Object3D[] = [];

  private manualUpRotation: THREE.Quaternion | null = null;
  private manualUpRotationActive = false;
  private groundPlaneRotationSnapshot: { manualUpRotation: THREE.Quaternion | null; manualUpRotationActive: boolean } | null = null;


  private selectAreaToolActive: "sphere" | "box" | null = null;
  private selectAreaShape: THREE.Mesh | null = null;
  private selectAreaKind: "sphere" | "box" | null = null;
  private selectAreaGizmo: SelectAreaGizmo | null = null;
  private selectAreaGizmoMode: GizmoMode = "translate";

  private static readonly LASSO_DRAG_THRESHOLD = 4; // drag this many px before engaging lasso tool
  private lassoDragActive = false;
  private lassoDragConfirmed = false;
  private lassoDragStart: { x: number; y: number } | null = null;
  private lassoPoints: { x: number; y: number }[] = [];

  private lassoOverlay: SVGSVGElement | null = null;
  private lassoPolyline: SVGPolylineElement | null = null;

  private isFlying = false;
  private selectedIndices = new Set<number>();
  private lastClickedIndex: number | null = null;
  private resourcePanelIndex: number | null = null;
  private resourcePanelPosition: { left: number; top: number } | null = null;
  private resourcePanelActiveTab: "last" | "all" = "last";

  // Ctrl+Z/Ctrl+Y (and Ctrl+Shift+Z) undo/redo history - covers selection,
  // manual visibility, and the landmark object, per pushUndoSnapshot()'s doc
  // comment. undoStack holds past states, redoStack holds states undone away
  // from - any fresh action (pushUndoSnapshot()) clears redoStack, same as
  // any normal undo/redo stack.
  private static readonly UNDO_STACK_LIMIT = 50;
  private undoStack: HistorySnapshot[] = [];
  private redoStack: HistorySnapshot[] = [];

  private selectionVisuals: THREE.Object3D[] = [];
  private selectionShaderCache = new WeakMap<THREE.Material, THREE.Material>();

  // stuff for outline rendering
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
      highlightCorrectionSourceBtn: this.el<HTMLButtonElement>("highlight-correction-source-btn"),
      fixDistortionBtn: this.el("fix-distortion-btn"),
      toggleRawImportBtn: this.el("toggle-raw-import-btn"),
      selectGroundPlaneBtn: this.el("select-ground-plane-btn"),
      mirrorBtn: this.el("mirror-scene-btn"),
      resetCameraBtn: this.el("reset-camera-btn"),
      frameSceneBtn: this.el("frame-scene-btn"),
      showResourcesPanelBtn: this.el("show-resources-panel-button"),
      hideResourcesPanelBtn: this.el("hide-resources-panel-button"),
      setAxisMappingBtn: this.el("set-axis-mapping-btn"),

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
        notHint: this.el("select-landmark-submenu_when-selection"),
        selectLandmarkApplyBtn: this.el("select-landmark-apply"),
        selectLandmarkResetBtn: this.el("select-landmark-reset"),
        selectLandmarkCancelBtn: this.el("select-landmark-cancel"),
      },

      selectGroundPlaneSubmenu: {
        menu: this.el("select-ground-plane-submenu"),
        hint: this.el("select-ground-plane_incomplete-selection"),
        actions: this.el('select-ground-plane_options'),
        selectGroundPlaneApplyBtn: this.el("select-ground-plane_accept-selection"),
        selectGroundPlaneApply180Btn: this.el("select-ground-plane_accept-selection-180"),
        selectGroundPlaneResetBtn: this.el("select-ground-plane_reset-selection"),
        selectGroundPlaneCancelBtn: this.el("select-ground-plane_cancel-selection"),
      },

      axisMapperSubmenu: {
        menu: this.el("axis-mapper-submenu"),
        axisMapper: this.el("axis-mapper-submenu-input-axis-mapper"),
      }
    },

    captureImporter: this.el<CaptureImporter>("capture-importer"),
    loadingScreen: this.el<LoadingScreen>("loading-screen"),
    controlsOverlay: this.el<Overlay>("controls-overlay"),
    exportOverlay: this.el<ExportMesh>("export-overlay"),
  };


  private exportSelectedBtn = this.el<HTMLButtonElement>("export-selected-btn");
  private selectOptionsMenu = this.el<HTMLDivElement>("select-options-menu");
  private emptyHint = this.el("empty-hint");
  private hud = this.el("hud");
  private objectList = this.el('object-list');
  private viewport = this.el<HTMLElement>("viewport");
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
      this.openExportDialog();
    });
    this.elements.exportOverlay.addEventListener('export-options-changed', () => this.renderExportMeshPreview());
    this.elements.exportOverlay.addEventListener('start-export', (e: any) =>
      this.handleStartExport(e.detail.selectedIndices, e.detail.exportOptions),
    );
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
          // The tool only ever allows a single selected landmark - collapse
          // down to just one object if a multi-selection was already active
          // from before the tool was turned on, rather than leaving an
          // invariant-violating multi-selection sitting there untouched.
          if (this.selectedIndices.size > 1) {
            this.selectOnly(this.resourcePanelIndex ?? Math.max(...this.selectedIndices));
          }
          this.syncResourcePanelVisibility();
          this.syncLandmarkSubmenuState();
        } else {
          this.cancelSelectLandmarkTool();
        }
      });
      this.elements.toolsMenu.setAxisMappingBtn.addEventListener('click', () => {
        this.hideAllToolSubmenus();
        this.cancelAllTools();
        if (Config.sessionConfig.tools.activeTool !== 'axis-mapper') {
          Config.sessionConfig.tools.activeTool = 'axis-mapper';
          this.elements.toolsMenu.axisMapperSubmenu.menu.classList.remove('hidden');
        } else {
          this.elements.toolsMenu.axisMapperSubmenu.menu.classList.add('hidden');
          Config.sessionConfig.tools.activeTool = null;
        }
      });

      this.elements.toolsMenu.toggleRawImportBtn.addEventListener('click', () => this.toggleRawImport());
      this.elements.toolsMenu.selectGroundPlaneBtn.addEventListener('click', () => {
        this.hideAllToolSubmenus();
        this.cancelAllTools();
        if (Config.sessionConfig.tools.activeTool !== 'select-ground-plane') {
          Config.sessionConfig.tools.activeTool = 'select-ground-plane';
          this.elements.toolsMenu.selectGroundPlaneSubmenu.menu.classList.remove('hidden');
          this.startGroundPlaneTool();
        } else {
          this.elements.toolsMenu.selectGroundPlaneSubmenu.menu.classList.add('hidden');
          Config.sessionConfig.tools.activeTool = null;
        }
      });

      this.elements.toolsMenu.mirrorBtn.addEventListener('click', () => {
        // mirror scene doesn't need to hide tool submenus or cancel tools
        this.mirrorSceneAlongX();
      });
      this.elements.toolsMenu.resetCameraBtn.addEventListener('click', () => {
        // this also doesn't need to hide or cancel any tools
        this.sceneManager.resetToInitialView();
      });

      this.elements.toolsMenu.showResourcesPanelBtn.addEventListener('click', () => {
        this.toggleResourcePanel(true);
      });
      this.elements.toolsMenu.hideResourcesPanelBtn.addEventListener('click', () => {
        this.toggleResourcePanel(false);
      });

      this.restoreResourcePanel();
      // Ensures the submenu's hint/apply-button visibility matches reality
      // (no tool active, nothing selected yet) from the very first render,
      // rather than relying on whatever hidden/shown state happens to be
      // baked into the markup.
      this.syncLandmarkSubmenuState();
    }

    // setup submenu: select volume
    {
      this.elements.toolsMenu.selectVolumeSubmenu.selectSphereBtn.addEventListener("click", () => this.setVolumeSelectTool("sphere"));
      this.elements.toolsMenu.selectVolumeSubmenu.selectBoxBtn.addEventListener("click", () => this.setVolumeSelectTool("box"));

      this.elements.toolsMenu.selectVolumeSubmenu.selectInsideBtn.addEventListener("click", () => this.setVolumeSelectMode("inside"));
      this.elements.toolsMenu.selectVolumeSubmenu.selectOutsideBtn.addEventListener("click", () => this.setVolumeSelectMode("outside"));

      this.elements.toolsMenu.selectVolumeSubmenu.selectReplaceBtn.addEventListener("click", () => this.applyVolumeSelection("replace"));
      this.elements.toolsMenu.selectVolumeSubmenu.selectAddBtn.addEventListener("click", () => this.applyVolumeSelection("add"));
      this.elements.toolsMenu.selectVolumeSubmenu.selectRemoveBtn.addEventListener("click", () => this.applyVolumeSelection("remove"));
      this.elements.toolsMenu.selectVolumeSubmenu.selectCancelBtn.addEventListener("click", () => this.cancelSelectByVolumeTool());
    }

    // setup submenu: select ground plane
    {
      this.elements.toolsMenu.selectGroundPlaneSubmenu.selectGroundPlaneApplyBtn.addEventListener("click", () =>
        this.acceptGroundPlaneTool(false),
      );
      this.elements.toolsMenu.selectGroundPlaneSubmenu.selectGroundPlaneApply180Btn.addEventListener("click", () =>
        this.acceptGroundPlaneTool(true),
      );
      this.elements.toolsMenu.selectGroundPlaneSubmenu.selectGroundPlaneResetBtn.addEventListener("click", () =>
        this.resetGroundPlaneTool(),
      );
      this.elements.toolsMenu.selectGroundPlaneSubmenu.selectGroundPlaneCancelBtn.addEventListener("click", () =>
        this.cancelSelectGroundPlaneTool(),
      );
    }

    // setup submenu: select landmark (fix distortion)
    {
      this.elements.toolsMenu.selectLandmarkSubmenu.selectLandmarkApplyBtn.addEventListener("click", () =>
        this.applySelectLandmarkTool(),
      );
      this.elements.toolsMenu.selectLandmarkSubmenu.selectLandmarkResetBtn.addEventListener("click", () =>
        this.resetSelectLandmarkTool(),
      );
      this.elements.toolsMenu.selectLandmarkSubmenu.selectLandmarkCancelBtn.addEventListener("click", () =>
        this.cancelSelectLandmarkTool(),
      );
    }

    // setup submenu: axis mapper
    {
      this.elements.toolsMenu.axisMapperSubmenu.axisMapper.addEventListener("axis-mapping-changed", () => {
        this.appConfig.saveConfig();
        this.applyAxisMappingChange();
      });
    }
  }

  private wireEvents(): void {
    this.elements.captureImporter.addEventListener('reconstruct-scene', (e: any) => {
      console.log('received reconstruct-scene:', e);
      this.reconstructScene(e.detail);
    });

    this.elements.toolsMenu.highlightCorrectionSourceBtn.addEventListener("click", () => this.highlightDistortionSource());
    this.exportSelectedBtn.addEventListener("click", () => this.exportSelectedMeshesAsGlb());

    window.addEventListener("pointermove", (e) => this.handleGizmoPointerMove(e));
    window.addEventListener("pointerup", (e) => this.handleGizmoPointerUp(e));
    window.addEventListener("keydown", (e) => this.handleGizmoKeydown(e));
    window.addEventListener("keydown", (e) => this.handleSelectionKeydown(e));

    // Right click is used as a selection tool (see handleSceneObjectPointer())
    // rather than a context-menu trigger, so the browser's own menu should
    // never appear over the viewport.
    this.sceneManager.renderer.domElement.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
    window.addEventListener("pointermove", (e) => this.handleLassoPointerMove(e));
    window.addEventListener("pointerup", (e) => this.handleLassoPointerUp(e));
    this.elements.toolsMenu.frameSceneBtn.addEventListener("click", () => this.sceneManager.frameOnScene());

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
    this.elements.toolsMenu.selectGroundPlaneSubmenu.menu.classList.add("hidden");
  }
  private cancelAllTools() {
    this.cancelVolumeSelectTool();
    this.cancelGroundPlaneTool();
    this.cancelLassoDrag();
  }
  /**
   * Toggles visibility of resource panel.
   * @param show whether to show or to hide the resource panel
   */
  private toggleResourcePanel(show: boolean, noSaveState?: boolean) {
    if (!noSaveState) {
      this.elements.toolsMenu.showResourcesPanelBtn.classList.toggle('hidden', show);
      this.elements.toolsMenu.hideResourcesPanelBtn.classList.toggle('hidden', !show);
      Config.sessionConfig.resourcesPanel.visible = show;
    }
    this.syncResourcePanelVisibility();
  }

  private restoreResourcePanel() {
    this.toggleResourcePanel(Config.sessionConfig.resourcesPanel.visible);
  }

  private noteSelectionTarget(candidate: number | null): void {
    if (candidate !== null && this.selectedIndices.has(candidate)) {
      this.resourcePanelIndex = candidate;
    } else if (this.selectedIndices.size > 0) {
      this.resourcePanelIndex = Math.max(...this.selectedIndices);
    } else {
      this.resourcePanelIndex = null;
    }
    this.syncResourcePanelVisibility();
    this.syncLandmarkSubmenuState();
  }

  private syncResourcePanelVisibility(): void {
    const forcedByLandmarkTool = Config.sessionConfig.tools.activeTool === "select-landmark";
    if ((Config.sessionConfig.resourcesPanel.visible || forcedByLandmarkTool) && this.resourcePanelIndex !== null) {
      this.renderResourcePanel(this.resourcePanelIndex);
    } else {
      this.removeResourcePanel();
    }
  }

  private removeResourcePanel(): void {
    this.viewport.querySelector<HTMLElement>(".resource-panel")?.remove();
  }

  private syncLandmarkSubmenuState(): void {
    const { hint, notHint, selectLandmarkApplyBtn } = this.elements.toolsMenu.selectLandmarkSubmenu;
    const landmarkSelected =
      Config.sessionConfig.tools.activeTool === "select-landmark" && this.selectedIndices.size > 0;
    hint.classList.toggle("hidden", landmarkSelected);
    notHint.classList.toggle("hidden", !landmarkSelected);
    selectLandmarkApplyBtn.classList.toggle("hidden", !landmarkSelected);
    if (landmarkSelected) selectLandmarkApplyBtn.textContent = "Fix distortion";
  }


  private clearLandmarkSelection(): void {
    this.selectedIndices.clear();
    this.lastClickedIndex = null;
    this.noteSelectionTarget(null);
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  private resetSelectLandmarkTool(): void {
    this.clearLandmarkSelection();
  }

  private cancelSelectLandmarkTool(): void {
    this.clearLandmarkSelection();
    this.elements.toolsMenu.selectLandmarkSubmenu.menu.classList.add("hidden");
    if (Config.sessionConfig.tools.activeTool === "select-landmark") {
      Config.sessionConfig.tools.activeTool = null;
    }
    this.syncResourcePanelVisibility();
    this.syncLandmarkSubmenuState();
  }

  private applySelectLandmarkTool(): void {
    if (this.resourcePanelIndex === null) return;
    this.recalculateTransformCorrection(this.resourcePanelIndex);
    this.cancelSelectLandmarkTool();
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
      const material = new THREE.MeshBasicMaterial({ color: 0x606a7a, side: THREE.DoubleSide });
      this.applyFlatFaceShading(material);
      this.untexturedMaterial = material;
    }
    return this.untexturedMaterial;
  }

  private applyFlatFaceShading(material: THREE.MeshBasicMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "varying vec3 vFlatShadeViewPos;\n#include <common>")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvFlatShadeViewPos = mvPosition.xyz;");

      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "varying vec3 vFlatShadeViewPos;\n#include <common>")
        .replace(
          "#include <specularmap_fragment>",
          `#include <specularmap_fragment>
          {
            vec3 faceNormal = normalize( cross( dFdx( vFlatShadeViewPos ), dFdy( vFlatShadeViewPos ) ) );
            float ndotl = abs( dot( faceNormal, normalize( vec3( 0.35, 0.55, 0.77 ) ) ) );
            diffuseColor.rgb *= 0.45 + 0.55 * ndotl;
          }`,
        );
    };
    material.needsUpdate = true;
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
    let rawPreviewObj: ParsedOBJ | null = null;
    if (previewRel && previewRel !== meshRel) {
      const previewPath = joinPath(passDir, previewRel);
      const previewText = await this.vfs.readText(previewPath);
      if (previewText) {
        const previewObj = parseOBJ(previewText);

        const remappedPreviewObj = remapObjOrientation(
          previewObj,
          this.appConfig.config.importOptions.inputGeometryOrientation,
        );
        previewGeometryData = objToGeometryArrays(remappedPreviewObj);
        rawPreviewObj = previewObj;
      }
    }

    this.loadedDraws.push({
      draw,
      key,
      material,
      geometryData,
      previewGeometryData,
      rawPreviewObj,
      bounds,
      diagonal: boundsDiagonal(bounds),
      meshPath: meshRel,
      previewPath: previewRel,
      originalPosedPositions:
        previewGeometryData !== geometryData || this.intelGpaDistortion !== null
          ? geometryData.positions.slice()
          : null,
      originalPosedNormals:
        previewGeometryData !== geometryData || this.intelGpaDistortion !== null
          ? geometryData.normals.slice()
          : null,
      originalPosedUvs:
        previewGeometryData !== geometryData || this.intelGpaDistortion !== null
          ? geometryData.uvs.slice()
          : null,
      appliedDistortionMatrix: null,
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

  private async reconstructScene({vfs, manifests, importOptions, intelGpaDistortion }: { vfs: VirtualFileSystem; manifests: LoadedManifests; importOptions: AppConfiguration['importOptions']; intelGpaDistortion?: AffineDistortionResult | null }): Promise<void> {
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

    this.intelGpaDistortion = intelGpaDistortion ?? null;
    this.elements.toolsMenu.fixDistortionBtn.classList.toggle("hidden", this.intelGpaDistortion !== null);
    this.elements.captureImporter.classList.add('hidden');
    this.elements.loadingScreen.show();
    this.elements.loadingScreen.log("Starting reconstruction...");


    this.emptyHint.style.display = "none";
    this.hud.style.display = "block";

    try {
      this.clearSelectionVisuals();
      this.hideAllToolSubmenus();
      Config.sessionConfig.tools.activeTool = null;
      this.cancelGroundPlaneTool();
      this.manualUpRotation = null;
      this.lastDistortionSourceIndex = null;
      this.updateHighlightCorrectionSourceBtn();
      this.manualUpRotationActive = false;
      this.cancelVolumeSelectTool();
      this.clearSelectAreaShape();
      this.sceneManager.clear();

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
      // A new scene invalidates every index in the old undo/redo history.
      this.undoStack = [];
      this.redoStack = [];

      this.showingRawImport = false;
      this.updateToggleRawImportBtn();
      this.noteSelectionTarget(null);

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
        }
      }

      this.elements.loadingScreen.log(`Finished processing all passes. Calculating scale and/or initial scale ...`);

      this.fixedScale = 1;
      this.worldUpAxis = "y";
      this.sceneRotation = new THREE.Quaternion();
      if (this.loadedDraws.length > 0) {
        let overall: Bounds = this.loadedDraws[0].bounds;
        for (let i = 1; i < this.loadedDraws.length; i++) overall = unionBounds(overall, this.loadedDraws[i].bounds);
        const size = overall.max.clone().sub(overall.min);
        const maxDim = Math.max(size.x, size.y, size.z);

        const unitScale =
          (importOptions.captureUnitSize || 1) *
          ((UNIT_CONVERSION as Record<string, number>)[importOptions.captureUnitUnit] ?? 1);
        const maxDimMeters = maxDim * unitScale;

        const clampScale = computeNormalizationScale(maxDimMeters, {
          forceMax: importOptions.forceMaxSceneSize,
          maxSpan: importOptions.maxSceneSize,
        });
        this.fixedScale = unitScale * clampScale;

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
          unitScale,
          maxDimMeters,
          scale: this.fixedScale,
          worldUpAxis: this.worldUpAxis,
        });
      }

      if (this.intelGpaDistortion) {
        const { corrected, skipped } = this.applyDistortionToScene(this.intelGpaDistortion, { rebuild: false });
        console.log("[reconstruct] auto-applied IntelGPA landmark distortion", { corrected, skipped });
      } else {
        this.autoCorrectRenderDocDistortion();
      }

      const problems: string[] = [];
      if (meshNotFoundCount) problems.push(`${meshNotFoundCount} mesh file(s) not found`);
      if (exceptionCount) problems.push(`${exceptionCount} threw an error`);
      if (noMeshPathCount) problems.push(`${noMeshPathCount} had no mesh path in the manifest`);

      this.elements.loadingScreen.log(`Rebuilding visible scene...`);

      this.setHidePercent(this.appConfig.config.objectFiltering.hideLargestObjectsPercent);
      this.elements.loadingScreen.log(`Visible scene rebuilt.`);

      this.elements.loadingScreen.log(`Placing camera...`);
      this.sceneManager.placeCameraForImport(
        1.2,
        importOptions.forceInitialScaleLimit ? importOptions.initialScaleLimit : undefined,
      );
    } catch (e) {
      console.error("[reconstruct] Reconstruction failed", e);
      // this.setStatus(`Reconstruct failed: ${e instanceof Error ? e.message : String(e)} (see console for details)`);
      this.elements.loadingScreen.log(`Reconstruction failed.`);
    }

    this.elements.loadingScreen.hide();
  }

  private rebuildVisibleScene(): void {
    if (this.loadedDraws.length === 0) return;

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
    this.noteSelectionTarget(null);

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

    this.clearSelectionVisuals();
    this.clearGroundPlaneVisuals();
    // The select-area shape (unlike the ground-plane tool's markers) is
    // user-configured, persistent data, not a transient in-progress tool
    // artifact - a filter/visibility change shouldn't silently discard it -
    // so its kind/position/scale/orientation are captured here and
    // re-applied to a freshly-created shape in the new content group below,
    // rather than just clearing it outright. worldQuaternion is captured
    // relative to the OLD content group (about to be torn down, quaternion
    // and all) - see restoreSelectAreaShape()'s own doc comment for why
    // that's what it expects, not the shape's own (group-relative)
    // quaternion directly.
    const previousGroup = this.sceneManager.getContentGroup();
    const previousShape = this.selectAreaKind
      ? {
          kind: this.selectAreaKind,
          position: this.selectAreaShape?.position.clone(),
          scale: this.selectAreaShape?.scale.clone(),
          worldQuaternion:
            this.selectAreaShape && previousGroup
              ? previousGroup.quaternion.clone().multiply(this.selectAreaShape.quaternion)
              : undefined,
        }
      : null;
    this.clearSelectAreaShape();
    this.sceneManager.clear();
    const contentGroup = this.sceneManager.addContent(meshes, this.fixedScale);
    contentGroup.quaternion.copy(this.getActiveSceneRotation());
    this.updateSelectionVisuals();
    if (previousShape?.position && previousShape.scale) {
      this.restoreSelectAreaShape(previousShape.kind, previousShape.position, previousShape.scale, previousShape.worldQuaternion);
    }

    const visibleCount = this.loadedDraws.length - excludedCount;
    const triCount = Math.round(builder.totalVertexCount / 3);

    this.hud.textContent =
      `${visibleCount}/${this.loadedDraws.length} objects \u00b7 ${meshes.length} draw calls \u00b7 ` +
      `${triCount.toLocaleString()} tris \u00b7 scale \u00d7${this.fixedScale.toExponential(2)} \u00b7 MMB drag to orbit, Shift+MMB to pan, scroll to zoom, A for fly mode`;

    this.renderObjectListState();
  }

  private toggleDrawVisibility(index: number): void {
    if (this.isObjectHidden(index)) return;
    this.pushUndoSnapshot();

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

  private toggleDrawSelection(index: number): void {
    if (this.isObjectHidden(index)) return;
    this.pushUndoSnapshot();
    if (this.selectedIndices.has(index)) this.selectedIndices.delete(index);
    else this.selectedIndices.add(index);
    this.lastClickedIndex = index;
    this.noteSelectionTarget(index);
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  private setLandmark(index: number): void {
    if (this.isObjectHidden(index)) return;
    this.pushUndoSnapshot();
    this.scaleReferenceIndex = this.scaleReferenceIndex === index ? null : index;
    this.renderObjectListState();
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

  private getActiveSceneRotation(): THREE.Quaternion {
    if (this.manualUpRotationActive && this.manualUpRotation) return this.manualUpRotation;
    return this.sceneRotation;
  }

  private applySceneRotation(): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;
    group.quaternion.copy(this.getActiveSceneRotation());
  }

  private startGroundPlaneTool(): void {
    if (this.loadedDraws.length === 0) return;
    this.groundPlaneRotationSnapshot = { manualUpRotation: this.manualUpRotation, manualUpRotationActive: this.manualUpRotationActive };
    this.groundPlaneToolActive = true;
    this.groundPlanePoints = [];
    this.clearGroundPlaneVisuals();
    this.sceneManager.renderer.domElement.style.cursor = "crosshair";
    this.showGroundPlaneHint();
  }

  private cancelGroundPlaneTool(): void {
    if (this.groundPlaneRotationSnapshot) {
      this.manualUpRotation = this.groundPlaneRotationSnapshot.manualUpRotation;
      this.manualUpRotationActive = this.groundPlaneRotationSnapshot.manualUpRotationActive;
      this.applySceneRotation();
      this.groundPlaneRotationSnapshot = null;
    }
    this.groundPlaneToolActive = false;
    this.groundPlanePoints = [];
    this.clearGroundPlaneVisuals();
    this.sceneManager.renderer.domElement.style.cursor = "";
    this.showGroundPlaneHint();
  }

  private cancelSelectGroundPlaneTool(): void {
    this.cancelGroundPlaneTool();
    this.elements.toolsMenu.selectGroundPlaneSubmenu.menu.classList.add("hidden");
    if (Config.sessionConfig.tools.activeTool === "select-ground-plane") {
      Config.sessionConfig.tools.activeTool = null;
    }
  }

  private resetGroundPlaneTool(): void {
    if (this.groundPlaneRotationSnapshot) {
      this.manualUpRotation = this.groundPlaneRotationSnapshot.manualUpRotation;
      this.manualUpRotationActive = this.groundPlaneRotationSnapshot.manualUpRotationActive;
      this.applySceneRotation();
    }
    this.groundPlaneToolActive = true;
    this.groundPlanePoints = [];
    this.clearGroundPlaneVisuals();
    this.sceneManager.renderer.domElement.style.cursor = "crosshair";
    this.showGroundPlaneHint();
  }

  private acceptGroundPlaneTool(flip180Depth: boolean): void {
    if (flip180Depth && this.manualUpRotation) {
      const flipDepth = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
      this.manualUpRotation.premultiply(flipDepth);
      this.applySceneRotation();
    }
    this.groundPlaneRotationSnapshot = null; // committed - nothing left to revert to
    this.groundPlaneToolActive = false;
    this.groundPlanePoints = [];
    this.clearGroundPlaneVisuals();
    this.sceneManager.renderer.domElement.style.cursor = "";
    this.showGroundPlaneHint();
    this.elements.toolsMenu.selectGroundPlaneSubmenu.menu.classList.add("hidden");
    if (Config.sessionConfig.tools.activeTool === "select-ground-plane") {
      Config.sessionConfig.tools.activeTool = null;
    }
  }

  private showGroundPlaneHint(): void {
    this.elements.toolsMenu.selectGroundPlaneSubmenu.hint.classList.remove("hidden");
    this.elements.toolsMenu.selectGroundPlaneSubmenu.actions.classList.add("hidden");
  }

  private showGroundPlaneActions(): void {
    this.elements.toolsMenu.selectGroundPlaneSubmenu.hint.classList.add("hidden");
    this.elements.toolsMenu.selectGroundPlaneSubmenu.actions.classList.remove("hidden");
  }

  private buildViewportRaycaster(event: PointerEvent): THREE.Raycaster {
    const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.sceneManager.activeCamera);
    return raycaster;
  }

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

    if (this.groundPlanePoints.length === 3) this.finishGroundPlaneTool();
  }

  private finishGroundPlaneTool(): void {
    const [p0, p1, p2] = this.groundPlanePoints;
    const edgeA = p1.clone().sub(p0);
    const edgeB = p2.clone().sub(p0);
    const normal = edgeA.cross(edgeB);

    if (normal.lengthSq() < 1e-12) {
      this.groundPlanePoints = [];
      this.clearGroundPlaneVisuals();
      return;
    }
    normal.normalize();

    const currentLocalUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.getActiveSceneRotation().clone().invert());
    if (normal.dot(currentLocalUp) < 0) normal.negate();

    this.manualUpRotation = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 1, 0));
    this.manualUpRotationActive = true;
    this.applySceneRotation();

    this.groundPlaneToolActive = false;
    this.sceneManager.renderer.domElement.style.cursor = "";
    this.showGroundPlaneActions();
  }

  private overallLocalBounds(): Bounds {
    let overall: Bounds = this.loadedDraws[0].bounds;
    for (let i = 1; i < this.loadedDraws.length; i++) overall = unionBounds(overall, this.loadedDraws[i].bounds);
    return overall;
  }

  private groundPlaneMarkerSize(): number {
    if (this.loadedDraws.length === 0) return 1;
    return Math.max(boundsDiagonal(this.overallLocalBounds()) * 0.015, 1e-6);
  }

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

    strokeX(size * 0.26, "#000000");
    strokeX(size * 0.14, `#${SELECTION_COLOR.getHexString()}`);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    SceneViewerApp.groundPlaneCrossTexture = texture;
    return texture;
  }

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

  private startSelectAreaTool(kind: "sphere" | "box"): void {
    if (this.loadedDraws.length === 0) {
      return;
    }
    this.cancelGroundPlaneTool(); // mutually exclusive with the ground-plane tool
    this.selectAreaToolActive = kind;
    this.sceneManager.renderer.domElement.style.cursor = SceneViewerApp.SELECT_AREA_CURSORS[kind];
    this.elements.toolsMenu.selectVolumeSubmenu.selectSphereBtn.classList.toggle("active", kind === "sphere");
    this.elements.toolsMenu.selectVolumeSubmenu.selectBoxBtn.classList.toggle("active", kind === "box");
  }

  private cancelVolumeSelectTool(): void {
    this.selectAreaToolActive = null;
    this.sceneManager.renderer.domElement.style.cursor = "";
    this.elements.toolsMenu.selectVolumeSubmenu.selectSphereBtn.classList.remove("active");
    this.elements.toolsMenu.selectVolumeSubmenu.selectBoxBtn.classList.remove("active");
  }


  private cancelSelectByVolumeTool(): void {
    this.cancelVolumeSelectTool();
    this.clearSelectAreaShape();
    this.elements.toolsMenu.selectVolumeSubmenu.menu.classList.add("hidden");
    if (Config.sessionConfig.tools.activeTool === "select-by-volume") {
      Config.sessionConfig.tools.activeTool = null;
    }
  }

  /** Reused across pointInSelectAreaShape() calls (see its own comment) -
   * safe since findDrawsWithinSelectAreaShape() calls it strictly
   * sequentially, never concurrently, over the course of one scan. */
  private static readonly scratchLocalPoint = new THREE.Vector3();

  private static pointInSelectAreaShape(
    x: number,
    y: number,
    z: number,
    kind: "sphere" | "box",
    center: THREE.Vector3,
    scale: THREE.Vector3,
    invQuaternion: THREE.Quaternion,
  ): boolean {
    const local = SceneViewerApp.scratchLocalPoint.set(x - center.x, y - center.y, z - center.z).applyQuaternion(invQuaternion);
    if (kind === "sphere") {
      const dx = local.x / (scale.x || 1e-9);
      const dy = local.y / (scale.y || 1e-9);
      const dz = local.z / (scale.z || 1e-9);
      return dx * dx + dy * dy + dz * dz <= 1;
    }
    return Math.abs(local.x) <= scale.x && Math.abs(local.y) <= scale.y && Math.abs(local.z) <= scale.z;
  }

  private static buildSelectAreaShapeTriangles(shape: THREE.Mesh): THREE.Triangle[] {
    const posAttr = shape.geometry.getAttribute("position");
    const triangles: THREE.Triangle[] = [];
    for (let i = 0; i + 2 < posAttr.count; i += 3) {
      const a = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i))
        .multiply(shape.scale)
        .applyQuaternion(shape.quaternion)
        .add(shape.position);
      const b = new THREE.Vector3(posAttr.getX(i + 1), posAttr.getY(i + 1), posAttr.getZ(i + 1))
        .multiply(shape.scale)
        .applyQuaternion(shape.quaternion)
        .add(shape.position);
      const c = new THREE.Vector3(posAttr.getX(i + 2), posAttr.getY(i + 2), posAttr.getZ(i + 2))
        .multiply(shape.scale)
        .applyQuaternion(shape.quaternion)
        .add(shape.position);
      triangles.push(new THREE.Triangle(a, b, c));
    }
    return triangles;
  }

  private findDrawsWithinSelectAreaShape(): number[] {
    const shape = this.selectAreaShape;
    const kind = this.selectAreaKind;
    if (!shape || !kind) return [];

    const mode = Config.sessionConfig.tools.selectAreaMode;
    const center = shape.position;
    const scale = shape.scale;
    const invQuaternion = shape.quaternion.clone().invert();

    // Conservative local-space AABB for the shape itself, to cheaply skip
    // draws whose own bounds can't possibly overlap it at all before doing
    // any per-vertex work. Both kinds use their own BOUNDING-SPHERE radius
    // (rather than a tighter, axis-aligned box) since the shape can now be
    // rotated (see the rotate-mode gizmo/shape.quaternion above) - unlike
    // an axis-aligned box, a bounding sphere's radius is intrinsic to the
    // shape and stays correct (if not perfectly tight) regardless of how
    // it's oriented: an ellipsoid's farthest surface point from its own
    // center is always its longest semi-axis, and a box's farthest CORNER
    // from its own center is always its half-extent vector's own length -
    // neither changes as the shape rotates about that same center.
    const boundingRadius = kind === "sphere" ? Math.max(scale.x, scale.y, scale.z) : scale.length();
    const shapeMin = new THREE.Vector3(center.x - boundingRadius, center.y - boundingRadius, center.z - boundingRadius);
    const shapeMax = new THREE.Vector3(center.x + boundingRadius, center.y + boundingRadius, center.z + boundingRadius);

    let shapeTriangles: THREE.Triangle[] | null = null;

    const matches: number[] = [];
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();

    for (let index = 0; index < this.loadedDraws.length; index++) {
      if (this.isObjectHidden(index) || this.manuallyHiddenIndices.has(index)) continue;
      const draw = this.loadedDraws[index];

      if (
        draw.bounds.max.x < shapeMin.x || draw.bounds.min.x > shapeMax.x ||
        draw.bounds.max.y < shapeMin.y || draw.bounds.min.y > shapeMax.y ||
        draw.bounds.max.z < shapeMin.z || draw.bounds.min.z > shapeMax.z
      ) {
        continue;
      }

      const positions = draw.geometryData.positions;
      if (positions.length === 0) continue;

      if (mode === "inside") {
        let allInside = true;
        for (let i = 0; i + 2 < positions.length; i += 3) {
          if (!SceneViewerApp.pointInSelectAreaShape(positions[i], positions[i + 1], positions[i + 2], kind, center, scale, invQuaternion)) {
            allInside = false;
            break;
          }
        }
        if (allInside) matches.push(index);
        continue;
      }

      // mode === "outside": cheap pass first - any vertex actually inside.
      let anyInside = false;
      for (let i = 0; i + 2 < positions.length; i += 3) {
        if (SceneViewerApp.pointInSelectAreaShape(positions[i], positions[i + 1], positions[i + 2], kind, center, scale, invQuaternion)) {
          anyInside = true;
          break;
        }
      }
      if (anyInside) {
        matches.push(index);
        continue;
      }

      // Fallback: exact surface-crossing test against the shape's own
      // triangles (built lazily, once, and reused across every draw that
      // needs it).
      if (!shapeTriangles) shapeTriangles = SceneViewerApp.buildSelectAreaShapeTriangles(shape);
      let crosses = false;
      for (let i = 0; i + 8 < positions.length && !crosses; i += 9) {
        va.set(positions[i], positions[i + 1], positions[i + 2]);
        vb.set(positions[i + 3], positions[i + 4], positions[i + 5]);
        vc.set(positions[i + 6], positions[i + 7], positions[i + 8]);
        const meshTri = new THREE.Triangle(va.clone(), vb.clone(), vc.clone());
        for (const shapeTri of shapeTriangles) {
          if (trianglesIntersect(meshTri, shapeTri)) {
            crosses = true;
            break;
          }
        }
      }
      if (crosses) matches.push(index);
    }

    return matches;
  }

  private applyVolumeSelection(op: "replace" | "add" | "remove"): void {
    if (!this.selectAreaShape || !this.selectAreaKind) return;
    this.pushUndoSnapshot();

    const matches = this.findDrawsWithinSelectAreaShape();

    if (op === "replace") {
      this.selectedIndices.clear();
      for (const index of matches) this.selectedIndices.add(index);
    } else if (op === "add") {
      for (const index of matches) this.selectedIndices.add(index);
    } else {
      for (const index of matches) this.selectedIndices.delete(index);
    }

    this.noteSelectionTarget(null);
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  private updateSelectAreaGizmoTransform(): void {
    const gizmo = this.selectAreaGizmo;
    const group = this.sceneManager.getContentGroup();
    if (!gizmo || !group) return;
    gizmo.update(this.sceneManager.activeCamera, group.quaternion, group.scale.x || 1);
  }

  private setSelectAreaGizmoMode(mode: GizmoMode): void {
    this.selectAreaGizmoMode = mode;
    this.selectAreaGizmo?.setMode(mode);
    this.renderSelectAreaOptionsPanel();
  }

  private isTypingInFormField(): boolean {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  }

  private handleGizmoKeydown(event: KeyboardEvent): void {
    if (event.repeat || this.isTypingInFormField() || this.isFlying || !this.selectAreaShape) return;
    if (event.code === "KeyG") this.setSelectAreaGizmoMode("translate");
    else if (event.code === "KeyS") this.setSelectAreaGizmoMode("scale");
    else if (event.code === "KeyR") this.setSelectAreaGizmoMode("rotate");
  }

  /** Global selection/export shortcuts - H (hide selected), Ctrl+I (invert
   * selection), Ctrl+A (select all visible), Escape (clear selection, same
   * as right-clicking empty space/an unselected object), Ctrl+E and
   * Ctrl+Shift+E (open the export dialog), Ctrl+Z (undo), and Ctrl+Y /
   * Ctrl+Shift+Z (redo). */
  private handleSelectionKeydown(event: KeyboardEvent): void {
    if (event.repeat || this.isTypingInFormField() || this.isFlying) return;
    const ctrlOrCmd = event.ctrlKey || event.metaKey;

    if (event.code === "Escape") {
      this.clearSelection();
      return;
    }

    if (event.code === "KeyH" && !ctrlOrCmd) {
      this.hideSelectedItems();
      return;
    }

    if (ctrlOrCmd && event.code === "KeyI") {
      event.preventDefault();
      this.invertSelection();
      return;
    }

    if (ctrlOrCmd && event.code === "KeyA") {
      event.preventDefault();
      this.selectAllVisible();
      return;
    }

    if (ctrlOrCmd && event.code === "KeyE") {
      event.preventDefault();
      this.openExportDialog();
      return;
    }

    // Z/Y are swapped between physical key positions on QWERTY vs QWERTZ
    // keyboards, so event.code (position-based: "KeyZ"/"KeyY" always mean
    // the same physical key regardless of layout) would have Ctrl+Z and
    // Ctrl+Y trade places on a QWERTZ layout. event.key instead reflects the
    // character the layout actually produces, so it tracks the printed
    // letter the user is pressing on any layout.
    const typedKey = event.key.toLowerCase();

    if (ctrlOrCmd && typedKey === "z" && !event.shiftKey) {
      event.preventDefault();
      this.undo();
      return;
    }

    if ((ctrlOrCmd && typedKey === "y") || (ctrlOrCmd && event.shiftKey && typedKey === "z")) {
      event.preventDefault();
      this.redo();
      return;
    }
  }

  private captureSnapshot(): HistorySnapshot {
    return {
      selectedIndices: new Set(this.selectedIndices),
      lastClickedIndex: this.lastClickedIndex,
      manuallyHiddenIndices: new Set(this.manuallyHiddenIndices),
      scaleReferenceIndex: this.scaleReferenceIndex,
    };
  }

  private applySnapshot(snapshot: HistorySnapshot): void {
    const visibilityChanged = !SceneViewerApp.indexSetsEqual(this.manuallyHiddenIndices, snapshot.manuallyHiddenIndices);

    this.selectedIndices = snapshot.selectedIndices;
    this.lastClickedIndex = snapshot.lastClickedIndex;
    this.manuallyHiddenIndices = snapshot.manuallyHiddenIndices;
    this.scaleReferenceIndex = snapshot.scaleReferenceIndex;

    if (visibilityChanged) {
      // rebuildVisibleScene() re-syncs selection visuals and the object
      // list itself once the new mesh set is in place.
      this.rebuildVisibleScene();
    } else {
      this.noteSelectionTarget(null);
      this.refreshSelectionVisuals();
      this.renderObjectListState();
    }
  }

  /** Records the CURRENT (pre-change) selection/visibility/landmark state so
   * it can be restored by undo(), and clears the redo stack - a fresh
   * action invalidates whatever was available to redo, same as any normal
   * undo/redo history. Call this right before mutating any of those, after
   * any early-return guards, so a no-op action doesn't clutter the stack. */
  private pushUndoSnapshot(): void {
    this.undoStack.push(this.captureSnapshot());
    if (this.undoStack.length > SceneViewerApp.UNDO_STACK_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Ctrl+Z - pops the most recent snapshot off the undo stack, stashes the
   * current state on the redo stack, and restores the popped one. */
  private undo(): void {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.redoStack.push(this.captureSnapshot());
    if (this.redoStack.length > SceneViewerApp.UNDO_STACK_LIMIT) this.redoStack.shift();
    this.applySnapshot(snapshot);
  }

  /** Ctrl+Y / Ctrl+Shift+Z - the mirror image of undo(): pops the most
   * recent state off the redo stack, stashes the current state back on the
   * undo stack, and restores the popped one. */
  private redo(): void {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return;
    this.undoStack.push(this.captureSnapshot());
    if (this.undoStack.length > SceneViewerApp.UNDO_STACK_LIMIT) this.undoStack.shift();
    this.applySnapshot(snapshot);
  }

  private static indexSetsEqual(a: Set<number>, b: Set<number>): boolean {
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
  }

  /** Clears the current selection - shared by Escape and right-clicking
   * empty space/an unselected object. */
  private clearSelection(): void {
    if (this.selectedIndices.size === 0) return;
    this.pushUndoSnapshot();
    this.selectedIndices.clear();
    this.lastClickedIndex = null;
    this.noteSelectionTarget(null);
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  /** Hides every currently selected item (manual hide, not a toggle) -
   * mirrors the "hide" half of toggleDrawVisibility() but always hides
   * rather than flipping state. Selection itself is left alone, same as
   * toggleDrawVisibility(). */
  private hideSelectedItems(): void {
    if (this.selectedIndices.size === 0) return;
    this.pushUndoSnapshot();
    for (const index of this.selectedIndices) this.manuallyHiddenIndices.add(index);
    this.rebuildVisibleScene();
  }

  /** Selects every visible (not filtered-out, not manually hidden) item. */
  private selectAllVisible(): void {
    this.pushUndoSnapshot();
    this.selectedIndices.clear();
    for (let i = 0; i < this.loadedDraws.length; i++) {
      if (!this.isObjectHidden(i) && !this.manuallyHiddenIndices.has(i)) this.selectedIndices.add(i);
    }
    this.lastClickedIndex = null;
    this.noteSelectionTarget(null);
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  /** Replaces the selection with the complement of itself among visible
   * items - hidden items (filtered or manually hidden) are ignored
   * entirely, neither contributing to nor being affected by the flip. */
  private invertSelection(): void {
    this.pushUndoSnapshot();
    const inverted = new Set<number>();
    for (let i = 0; i < this.loadedDraws.length; i++) {
      if (this.isObjectHidden(i) || this.manuallyHiddenIndices.has(i)) continue;
      if (!this.selectedIndices.has(i)) inverted.add(i);
    }
    this.selectedIndices = inverted;
    this.lastClickedIndex = null;
    this.noteSelectionTarget(null);
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  /** Opens the export dialog for the current selection - shared by the
   * "Export..." menu item and the Ctrl+E / Ctrl+Shift+E shortcuts. */
  private openExportDialog(): void {
    this.elements.exportOverlay.setSelectedIndices(this.getExportIndices());
    this.renderExportMeshPreview();
    this.elements.exportOverlay.show();
  }

  private handleGizmoPointerMove(event: PointerEvent): void {
    const gizmo = this.selectAreaGizmo;
    if (!gizmo) return;
    const group = this.sceneManager.getContentGroup();
    if (!group) return;

    if (gizmo.isDragging()) {
      const raycaster = this.buildViewportRaycaster(event);
      gizmo.updateDrag(raycaster, this.sceneManager.activeCamera, group.quaternion, group.scale.x || 1, event.clientX, event.clientY);
      return;
    }

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

  private handleSelectAreaClick(event: PointerEvent): void {
    const kind = this.selectAreaToolActive;
    if (!kind) return;

    const worldHit = this.raycastMeshSurface(event);
    if (worldHit) this.placeSelectAreaShape(kind, worldHit);
    this.cancelVolumeSelectTool();
  }

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
  }

  private restoreSelectAreaShape(
    kind: "sphere" | "box",
    localPosition: THREE.Vector3,
    localScale: THREE.Vector3,
    worldQuaternion?: THREE.Quaternion,
  ): void {

    const group = this.sceneManager.getContentGroup();
    if (!group) return;
    this.clearSelectAreaShape();

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
    shape.quaternion.copy(group.quaternion).invert().multiply(worldQuaternion ?? new THREE.Quaternion());
    shape.userData.isSelectAreaShape = true;
    shape.renderOrder = 998;

    group.add(shape);
    this.selectAreaShape = shape;
    this.selectAreaKind = kind;

    this.selectAreaGizmo = new SelectAreaGizmo(shape, this.selectAreaGizmoMode);
    this.selectAreaGizmo.setMinScale(Math.max(boundsDiagonal(this.overallLocalBounds()) * 0.0005, 1e-9));
    group.add(this.selectAreaGizmo.object3d);

    this.renderSelectAreaOptionsPanel();
  }

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
          <button class="${mode === "rotate" ? "active" : ""}" data-select-area="mode-rotate" title="Rotate (R)">Rotate</button>
          <button class="ghost" data-select-area="remove">Remove</button>
        </div>
      </div>
      <p class="subtitle" style="margin:8px 0 0">Drag the gizmo in the viewport to move, scale, or rotate it. Press G/S/R to switch modes.</p>
    `;

    this.selectOptionsMenu
      .querySelector('[data-select-area="mode-translate"]')
      ?.addEventListener("click", () => this.setSelectAreaGizmoMode("translate"));
    this.selectOptionsMenu
      .querySelector('[data-select-area="mode-scale"]')
      ?.addEventListener("click", () => this.setSelectAreaGizmoMode("scale"));
    this.selectOptionsMenu
      .querySelector('[data-select-area="mode-rotate"]')
      ?.addEventListener("click", () => this.setSelectAreaGizmoMode("rotate"));
    this.selectOptionsMenu
      .querySelector('[data-select-area="remove"]')
      ?.addEventListener("click", () => this.clearSelectAreaShape());
  }

  //#endregion

  //#region lasso select tool
  private cancelLassoDrag(): void {
    this.lassoDragActive = false;
    this.lassoDragConfirmed = false;
    this.lassoDragStart = null;
    this.lassoPoints = [];
    this.hideLassoOverlay();
  }

  private handleLassoPointerDown(event: PointerEvent): void {
    event.preventDefault();
    this.lassoDragActive = true;
    this.lassoDragConfirmed = false;
    const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
    this.lassoDragStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.lassoPoints = [];
  }

  private handleLassoPointerMove(event: PointerEvent): void {
    if (!this.lassoDragActive) return;
    const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (!this.lassoDragConfirmed) {
      const start = this.lassoDragStart!;
      if (Math.hypot(x - start.x, y - start.y) < SceneViewerApp.LASSO_DRAG_THRESHOLD) return;
      this.lassoDragConfirmed = true;
      this.lassoPoints = [start];
    }

    const last = this.lassoPoints[this.lassoPoints.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 3) return;
    this.lassoPoints.push({ x, y });
    this.updateLassoOverlay();
  }

  private handleLassoPointerUp(event: PointerEvent): void {
    if (!this.lassoDragActive) return;
    this.lassoDragActive = false;
    this.hideLassoOverlay();

    if (!this.lassoDragConfirmed) {
      this.lassoDragStart = null;
      this.selectDrawAtPointer(event);
      return;
    }

    this.lassoDragConfirmed = false;
    this.lassoDragStart = null;
    const points = this.lassoPoints;
    this.lassoPoints = [];

    const mode: "replace" | "add" | "remove" = event.ctrlKey || event.metaKey ? "remove" : event.shiftKey ? "add" : "replace";
    this.applyLassoSelection(points, mode);
  }

  private applyLassoSelection(points: { x: number; y: number }[], mode: "replace" | "add" | "remove"): void {
    this.pushUndoSnapshot();
    const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
    const camera = this.sceneManager.activeCamera;
    const group = this.sceneManager.getContentGroup();

    const inside: number[] = [];
    for (let index = 0; index < this.loadedDraws.length; index++) {
      if (this.isObjectHidden(index) || this.manuallyHiddenIndices.has(index)) continue;

      const center = boundsCenter(this.loadedDraws[index].bounds);
      if (group) center.applyMatrix4(group.matrixWorld);

      const projected = center.project(camera); // NDC space, each axis roughly -1..1
      if (projected.z < -1 || projected.z > 1) continue; // behind the camera, or beyond the far plane

      const screenX = ((projected.x + 1) / 2) * rect.width;
      const screenY = ((1 - projected.y) / 2) * rect.height;
      if (SceneViewerApp.isPointInPolygon(screenX, screenY, points)) inside.push(index);
    }

    if (mode === "replace") this.selectedIndices.clear();
    for (const index of inside) {
      if (mode === "remove") this.selectedIndices.delete(index);
      else this.selectedIndices.add(index);
    }

    this.lastClickedIndex = null;
    this.noteSelectionTarget(null);
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  private static isPointInPolygon(x: number, y: number, points: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i];
      const b = points[j];
      const straddles = a.y > y !== b.y > y;
      if (straddles && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  private ensureLassoOverlay(): SVGPolylineElement {
    if (this.lassoOverlay && this.lassoPolyline) return this.lassoPolyline;

    const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("lasso-select-overlay");
    svg.setAttribute("width", String(rect.width));
    svg.setAttribute("height", String(rect.height));

    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.classList.add("lasso-select-path");
    svg.appendChild(polyline);

    this.viewport.appendChild(svg);
    this.lassoOverlay = svg;
    this.lassoPolyline = polyline;
    return polyline;
  }

  /** Redraws the dotted lasso path from the current lassoPoints. */
  private updateLassoOverlay(): void {
    const polyline = this.ensureLassoOverlay();
    this.lassoOverlay!.classList.remove("hidden");
    polyline.setAttribute("points", this.lassoPoints.map((p) => `${p.x},${p.y}`).join(" "));
  }

  private hideLassoOverlay(): void {
    this.lassoOverlay?.classList.add("hidden");
  }

  //#endregion

  private applyMatrixToDraw(draw: LoadedDraw, matrix: THREE.Matrix4): boolean {
    if (draw.originalPosedPositions === null || draw.originalPosedNormals === null || draw.originalPosedUvs === null) return false;
    const correctedPositions = draw.originalPosedPositions.slice();
    this.applyMatrixToPositions(correctedPositions, matrix);

    const correctedNormals = draw.originalPosedNormals.slice();
    this.applyNormalMatrixToNormals(correctedNormals, matrix);

    const correctedUvs = draw.originalPosedUvs.slice();

    if (new THREE.Matrix3().setFromMatrix4(matrix).determinant() < 0) {
      this.flipTriangleWindingInPlace(correctedPositions, 3);
      this.flipTriangleWindingInPlace(correctedNormals, 3);
      this.flipTriangleWindingInPlace(correctedUvs, 2);
    }

    draw.geometryData.positions = correctedPositions;
    draw.geometryData.normals = correctedNormals;
    draw.geometryData.uvs = correctedUvs;
    draw.bounds = computeBounds(draw.geometryData.positions);
    draw.diagonal = boundsDiagonal(draw.bounds);
    draw.appliedDistortionMatrix = matrix;
    return true;
  }

  private applyDistortionToScene(
    distortion: AffineDistortionResult,
    options: { rebuild?: boolean; sourceIndex?: number } = {},
  ): { corrected: number; skipped: number } {
    const finalMatrix = distortion.posedToNonPosedInPlace;

    const anchor = distortion.posedCentroid;
    const rotationBefore = this.getActiveSceneRotation().clone();
    const scaleBefore = this.fixedScale;
    const worldBefore = anchor.clone().applyQuaternion(rotationBefore).multiplyScalar(scaleBefore);

    let corrected = 0;
    let skipped = 0;

    for (const draw of this.loadedDraws) {
      if (this.applyMatrixToDraw(draw, finalMatrix)) corrected++;
      else skipped++;
    }

    if (corrected > 0) {
      this.recomputeFixedScale();
      this.showingRawImport = false;
      this.updateToggleRawImportBtn();

      // Rotates the WHOLE scene to the fit's own orientation instead of
      // whatever detectWorldUpAxis()'s bounding-box-shape heuristic (or an
      // earlier, less-corroborated fit) had left sceneRotation at - a
      // real, geometrically-grounded rotation is available now that a fit
      // has actually succeeded, so use it in place of the heuristic guess.
      this.sceneRotation = distortion.distortionOrientation.clone();
      this.applySceneRotation();

      const worldAfter = anchor.clone().applyQuaternion(this.getActiveSceneRotation()).multiplyScalar(this.fixedScale);
      this.sceneManager.translateOrbitCenter(worldAfter.clone().sub(worldBefore));

      this.lastDistortionSourceIndex = options.sourceIndex ?? null;
      this.updateHighlightCorrectionSourceBtn();

      if (options.rebuild ?? true) this.rebuildVisibleScene();
    }

    return { corrected, skipped };
  }


  private updateHighlightCorrectionSourceBtn(): void {
    this.elements.toolsMenu.highlightCorrectionSourceBtn.disabled = this.lastDistortionSourceIndex === null;
  }

  private highlightDistortionSource(): void {
    const index = this.lastDistortionSourceIndex;
    if (index === null) return;
    if (this.isObjectHidden(index)) {
      return;
    }
    this.selectOnly(index);
    this.scrollDrawIntoView(index);
  }

  private autoCorrectRenderDocDistortion(): void {
    const logLine = this.elements.loadingScreen.log('Calculating object distortions ...');
    const updateLogLineEvery = 7;

    let skippedHighResidual = 0;
    let skippedNoPair = 0;
    let failed = 0;

    const candidates: Array<{ index: number; draw: LoadedDraw; distortion: AffineDistortionResult; linear: THREE.Matrix3 }> = [];

    for (const [index, draw] of this.loadedDraws.entries()) {
      if (draw.originalPosedPositions === null) {
        skippedNoPair++;
        continue;
      }

      let distortion: AffineDistortionResult;
      try {
        distortion = calculateDistortionMatrix({
          geometryData: { positions: draw.originalPosedPositions },
          previewGeometryData: draw.previewGeometryData,
        });
      } catch (e) {
        failed++;
        console.warn(`[reconstruct] auto distortion fit failed for eid${draw.draw.eventId}`, e);

        if (index % updateLogLineEvery === 0) {
          logLine.updateLogItem(`Calculating object distortions ... (${index}/${this.loadedDraws.length})`, {current: index, total: this.loadedDraws.length });
        }
        continue;
      }

      if (!isGoodDistortionFitCandidate(distortion, { maxScaleAnisotropy: Infinity })) {
        skippedHighResidual++;

        if (index % updateLogLineEvery === 0) {
          logLine.updateLogItem(`Calculating object distortions ... (${index}/${this.loadedDraws.length})`, {current: index, total: this.loadedDraws.length });
        }
        continue;
      }

      candidates.push({ index, draw, distortion, linear: new THREE.Matrix3().setFromMatrix4(distortion.posedToNonPosedInPlace) });
      if (index % updateLogLineEvery === 0) {
        logLine.updateLogItem(`Calculating object distortions ... (${index}/${this.loadedDraws.length})`, {current: index, total: this.loadedDraws.length });
      }
    }

    console.log("[reconstruct] RenderDoc distortion candidates", {
      total: this.loadedDraws.length,
      eligible: candidates.length,
      skippedHighResidual,
      skippedNoPair,
      failed,
    });

    if (candidates.length === 0) {
      console.log("[reconstruct] no eligible objects to compute a distortion from - leaving scene as imported");
      return;
    }

    const logLine2 = this.elements.loadingScreen.log('Sorting distortion candidates [ .. ]');

    const { clusterOf, largestCluster, largestClusterSize } = findDistortionConsensus(
      candidates.map((candidate) => candidate.linear),
    );

    logLine2.updateLogItem(`Sorting distortion candidates [ ok ]`);

    const ll3 = this.elements.loadingScreen.log('Selecting the best distortion candidate [ .. ]');
    let winnerIndex = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (clusterOf[i] !== largestCluster) continue;
      if (winnerIndex === -1 || candidates[i].distortion.relativeFitError < candidates[winnerIndex].distortion.relativeFitError) {
        winnerIndex = i;
      }
    }
    const winner = candidates[winnerIndex];
    ll3.updateLogItem(`Selecting the best distortion candidate [ ok ]`);

    console.log("[reconstruct] selected RenderDoc distortion", {
      fromEventId: winner.draw.draw.eventId,
      agreeingObjects: largestClusterSize,
      totalCandidates: candidates.length,
      relativeFitError: winner.distortion.relativeFitError,
      scaleAnisotropy: winner.distortion.scaleAnisotropy,
    });

    const { corrected, skipped } = this.applyDistortionToScene(winner.distortion, { rebuild: false, sourceIndex: winner.index });
    console.log("[reconstruct] auto-correct RenderDoc distortion", { corrected, skipped });
  }

  private recomputeFixedScale(): void {
    if (this.loadedDraws.length === 0) return;
    let overall: Bounds = this.loadedDraws[0].bounds;
    for (let i = 1; i < this.loadedDraws.length; i++) overall = unionBounds(overall, this.loadedDraws[i].bounds);
    const size = overall.max.clone().sub(overall.min);
    const maxDim = Math.max(size.x, size.y, size.z);
    const importOpts = this.appConfig.config.importOptions;
    const unitScale =
      (importOpts.captureUnitSize || 1) * ((UNIT_CONVERSION as Record<string, number>)[importOpts.captureUnitUnit] ?? 1);
    const clampScale = computeNormalizationScale(maxDim * unitScale, {
      forceMax: importOpts.forceMaxSceneSize,
      maxSpan: importOpts.maxSceneSize,
    });
    this.fixedScale = unitScale * clampScale;
  }

  private toggleRawImport(): void {
    if (this.loadedDraws.length === 0) return;
    if (!this.loadedDraws.some((draw) => draw.appliedDistortionMatrix !== null)) return;

    if (this.showingRawImport) {
      // Re-applies each draw's OWN recorded matrix (nothing is re-fit) -
      // just restores the corrected positions.
      for (const draw of this.loadedDraws) {
        if (draw.originalPosedPositions === null || draw.appliedDistortionMatrix === null) continue;
        this.applyMatrixToDraw(draw, draw.appliedDistortionMatrix);
      }
      this.showingRawImport = false;
    } else {
      for (const draw of this.loadedDraws) {
        if (draw.originalPosedPositions === null) continue;
        draw.geometryData.positions = draw.originalPosedPositions.slice();
        draw.bounds = computeBounds(draw.geometryData.positions);
        draw.diagonal = boundsDiagonal(draw.bounds);
      }
      this.showingRawImport = true;
    }

    this.recomputeFixedScale();
    this.rebuildVisibleScene();
    this.updateToggleRawImportBtn();
  }

  /** Syncs the toggle button's label/state to showingRawImport - called
   * whenever it changes (applyMatrixToDraw() call sites, toggleRawImport(),
   * and the full-reload reset in reconstructScene()). */
  private updateToggleRawImportBtn(): void {
    const btn = this.elements.toolsMenu.toggleRawImportBtn;
    btn.textContent = this.showingRawImport ? "Enable distortion correction" : "Disable distortion correction";
  }

  private applyAxisMappingChange(): void {
    if (this.loadedDraws.length === 0) return;

    const orientation = this.appConfig.config.importOptions.inputGeometryOrientation;
    let remappedAny = false;
    for (const draw of this.loadedDraws) {
      if (!draw.rawPreviewObj) continue;
      draw.previewGeometryData = objToGeometryArrays(remapObjOrientation(draw.rawPreviewObj, orientation));
      remappedAny = true;
    }
    if (!remappedAny) return;

    const referenceIndex = this.lastDistortionSourceIndex ?? this.scaleReferenceIndex;
    if (referenceIndex !== null && !this.showingRawImport) {
      this.recalculateTransformCorrection(referenceIndex);
    }

    this.refreshResourcePanel();
  }

  private refreshResourcePanel(): void {
    if (this.resourcePanelIndex === null) return;
    this.removeResourcePanel();
    this.syncResourcePanelVisibility();
  }


  private recalculateTransformCorrection(referenceIndex: number | null = this.scaleReferenceIndex): void {
    if (this.loadedDraws.length === 0) {
      return;
    }
    if (referenceIndex === null) {
      return;
    }

    const referenceObject = this.loadedDraws[referenceIndex];
    let distortion;
    try {
      distortion = calculateDistortionMatrix({
        geometryData: { positions: referenceObject.originalPosedPositions! },
        previewGeometryData: referenceObject.previewGeometryData,
      });
    } catch (e) {
      return;
    }

    const { corrected, skipped } = this.applyDistortionToScene(distortion, { sourceIndex: referenceIndex });

    if (corrected === 0) {
      return;
    }

    const statusParts = [`Applied per-object distortion correction to ${corrected} object(s)`];
    if (skipped > 0) statusParts.push(`${skipped} skipped (no separate posed mesh)`);
  }

  private applyMatrixToPositions(positions: number[], matrix: THREE.Matrix4): void {
    const v = new THREE.Vector3();
    for (let i = 0; i < positions.length; i += 3) {
      v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
      positions[i] = v.x;
      positions[i + 1] = v.y;
      positions[i + 2] = v.z;
    }
  }


  private applyNormalMatrixToNormals(normals: number[], matrix: THREE.Matrix4): void {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const v = new THREE.Vector3();
    for (let i = 0; i < normals.length; i += 3) {
      v.set(normals[i], normals[i + 1], normals[i + 2]).applyMatrix3(normalMatrix).normalize();
      normals[i] = v.x;
      normals[i + 1] = v.y;
      normals[i + 2] = v.z;
    }
  }

  private negateXInPlace(values: number[]): void {
    for (let i = 0; i < values.length; i += 3) values[i] = -values[i];
  }

  private flipTriangleWindingInPlace(values: number[], componentsPerVertex: number): void {
    const triStride = componentsPerVertex * 3;
    for (let base = 0; base + triStride <= values.length; base += triStride) {
      for (let c = 0; c < componentsPerVertex; c++) {
        const a = base + componentsPerVertex + c;
        const b = base + componentsPerVertex * 2 + c;
        const tmp = values[a];
        values[a] = values[b];
        values[b] = tmp;
      }
    }
  }


  private mirrorSceneAlongX(): void {
    if (this.loadedDraws.length === 0) return;

    for (const draw of this.loadedDraws) {
      this.negateXInPlace(draw.geometryData.positions);
      this.flipTriangleWindingInPlace(draw.geometryData.positions, 3);

      this.negateXInPlace(draw.geometryData.normals);
      this.flipTriangleWindingInPlace(draw.geometryData.normals, 3);

      this.flipTriangleWindingInPlace(draw.geometryData.uvs, 2);

      if (draw.originalPosedPositions) {
        this.negateXInPlace(draw.originalPosedPositions);
        this.flipTriangleWindingInPlace(draw.originalPosedPositions, 3);
      }
      if (draw.originalPosedNormals) {
        this.negateXInPlace(draw.originalPosedNormals);
        this.flipTriangleWindingInPlace(draw.originalPosedNormals, 3);
      }
      if (draw.originalPosedUvs) {
        this.flipTriangleWindingInPlace(draw.originalPosedUvs, 2);
      }

      draw.bounds = computeBounds(draw.geometryData.positions);
      draw.diagonal = boundsDiagonal(draw.bounds);
    }

    if (this.selectAreaShape) this.selectAreaShape.position.x = -this.selectAreaShape.position.x;

    this.rebuildVisibleScene();
  }


  private exportSelectedMeshesAsGlb(): void {
    const activeSelected = this.getExportIndices();
    if (activeSelected.length === 0) {
      return;
    }

    const entries: ExportMeshEntry[] = activeSelected.map((index) => {
      const draw = this.loadedDraws[index];
      return {
        name: `Draw #${index} (eid ${draw.draw.eventId})`,
        positions: draw.geometryData.positions,
        normals: draw.geometryData.normals,
        uvs: draw.geometryData.uvs,
        bounds: draw.bounds,
        material: draw.material,
      };
    });

    const group = this.sceneManager.getContentGroup();
    const sceneTransform: ExportSceneTransform = {
      quaternion: this.getActiveSceneRotation(),
      scale: group?.scale.x || this.fixedScale || 1,
    };

    const blob = buildGlbBlob(entries, sceneTransform);
    const fileName = `scene-export-${entries.length}-object${entries.length === 1 ? "" : "s"}.glb`;
    this.downloadBlob(blob, fileName);
  }

  /** Triggers a browser download of an already-built blob under the given
   * file name - the DOM-anchor-click dance shared by
   * exportSelectedMeshesAsGlb() and handleStartExport(), extracted so both
   * only have to build the blob and pick a name. */
  private downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  private handleStartExport(selectedIndices: number[], exportOptions: AppConfiguration["exportOptions"]): void {
    const draws = selectedIndices
      .map((index) => ({ index, draw: this.loadedDraws[index] }))
      .filter((entry): entry is { index: number; draw: LoadedDraw } => !!entry.draw);
    if (draws.length === 0) {
      return;
    }

    const posed = exportOptions.exportType === "output";
    const entries: ExportMeshEntry[] = draws.flatMap(({ index, draw }) =>
      this.buildExportEntriesForDraw(index, draw, posed, exportOptions),
    );

    const group = this.sceneManager.getContentGroup();
    const sceneTransform: ExportSceneTransform = posed
      ? { quaternion: this.getActiveSceneRotation(), scale: group?.scale.x || this.fixedScale || 1 }
      : { quaternion: new THREE.Quaternion(), scale: 1 };

    if (exportOptions.resizeExportedObject) {
      this.applyExportResize(entries, sceneTransform, exportOptions.approximateHeight);
    }

    const blob = buildGlbBlob(entries, sceneTransform);
    const fileName = `scene-export-${entries.length}-object${entries.length === 1 ? "" : "s"}.glb`;
    this.downloadBlob(blob, fileName);
  }

  private buildExportEntriesForDraw(
    index: number,
    draw: LoadedDraw,
    posed: boolean,
    exportOptions: AppConfiguration["exportOptions"],
  ): ExportMeshEntry[] {
    const sourceData = posed ? draw.geometryData : (draw.previewGeometryData ?? draw.geometryData);
    const material = exportOptions.exportTextures ? draw.material : this.getUntexturedMaterial();
    const baseName = `Draw #${index} (eid ${draw.draw.eventId})`;

    if (!exportOptions.splitLooseParts) {
      return [
        {
          name: baseName,
          positions: sourceData.positions,
          normals: sourceData.normals,
          uvs: sourceData.uvs,
          bounds: posed ? draw.bounds : computeBounds(sourceData.positions),
          material,
        },
      ];
    }

    const partGeometries = splitGeometryByLooseParts(sourceData);
    const namedParts: NamedMeshPart[] = partGeometries.map((geometry, i) => ({
      name: partGeometries.length > 1 ? `${baseName} part ${i + 1}` : baseName,
      geometry,
    }));

    const parts: (NamedMeshPart & { status?: MeshFixStatus })[] = exportOptions.fillHoles
      ? groupFixedMeshes(namedParts)
      : namedParts;

    return parts.map((part) => ({
      name: part.status ? `${part.name} [${part.status}]` : part.name,
      positions: part.geometry.positions,
      normals: part.geometry.normals,
      uvs: part.geometry.uvs,
      bounds: computeBounds(part.geometry.positions),
      material,
    }));
  }

  private applyExportResize(entries: ExportMeshEntry[], sceneTransform: ExportSceneTransform, targetHeight: number): void {
    let combined: Bounds | null = null;
    for (const entry of entries) {
      const bounds = computeBounds(entry.positions);
      combined = combined ? unionBounds(combined, bounds) : bounds;
    }
    if (!combined) return;

    const corners = [
      new THREE.Vector3(combined.min.x, combined.min.y, combined.min.z),
      new THREE.Vector3(combined.min.x, combined.min.y, combined.max.z),
      new THREE.Vector3(combined.min.x, combined.max.y, combined.min.z),
      new THREE.Vector3(combined.min.x, combined.max.y, combined.max.z),
      new THREE.Vector3(combined.max.x, combined.min.y, combined.min.z),
      new THREE.Vector3(combined.max.x, combined.min.y, combined.max.z),
      new THREE.Vector3(combined.max.x, combined.max.y, combined.min.z),
      new THREE.Vector3(combined.max.x, combined.max.y, combined.max.z),
    ];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const corner of corners) {
      corner.applyQuaternion(sceneTransform.quaternion);
      if (corner.y < minY) minY = corner.y;
      if (corner.y > maxY) maxY = corner.y;
    }

    const rotatedHeight = maxY - minY;
    if (rotatedHeight < 1e-9) return;

    sceneTransform.scale = targetHeight / rotatedHeight;
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

  private attachMeshPreview(
    container: HTMLElement,
    draw: LoadedDraw,
    options?: { poseMode?: "posed" | "non-posed"; textured?: boolean },
  ): void {
    this.attachMultiMeshPreview(container, [draw], { interactive: true, ...options });
  }

  private attachMultiMeshPreview(
    container: HTMLElement,
    draws: LoadedDraw[],
    options: { interactive: boolean; poseMode?: "posed" | "non-posed"; textured?: boolean },
  ): void {
    const poseMode = options.poseMode ?? "non-posed";
    const textured = options.textured ?? true;

    const previewCanvas = document.createElement("canvas");
    previewCanvas.className = "resource-preview-canvas";
    container.appendChild(previewCanvas);

    const renderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);

    const modelRoot = new THREE.Group();
    scene.add(modelRoot);

    const contentGroup = new THREE.Group();
    modelRoot.add(contentGroup);

    let overallBounds: Bounds | null = null;

    for (const draw of draws) {
      const geometry = new THREE.BufferGeometry();
      const sourceData = poseMode === "posed" ? draw.geometryData : (draw.previewGeometryData ?? draw.geometryData);
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(sourceData.positions, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(sourceData.uvs, 2));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(sourceData.normals, 3));
      geometry.computeVertexNormals();

      let material: THREE.Material;
      if (textured) {
        material = draw.material.clone();
        material.side = THREE.DoubleSide;
        material.needsUpdate = true;
      } else {
        material = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, flatShading: true, side: THREE.DoubleSide });
      }

      contentGroup.add(new THREE.Mesh(geometry, material));

      const bounds = computeBounds(sourceData.positions);
      overallBounds = overallBounds ? unionBounds(overallBounds, bounds) : bounds;
    }

    if (!overallBounds) overallBounds = { min: new THREE.Vector3(-0.5, -0.5, -0.5), max: new THREE.Vector3(0.5, 0.5, 0.5) };

    const center = boundsCenter(overallBounds);
    const rawSize = overallBounds.max.clone().sub(overallBounds.min);

    const PREVIEW_CUBE_SIZE = 100;
    const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z, 1e-6);
    const previewScale = maxDim > PREVIEW_CUBE_SIZE ? PREVIEW_CUBE_SIZE / maxDim : 1;
    contentGroup.position.copy(center).multiplyScalar(-previewScale);
    contentGroup.scale.setScalar(previewScale);

    const size = rawSize.clone().multiplyScalar(previewScale);
    const radius = Math.max(size.length() * 0.5, 0.25);
    const targetFill = 0.875;

    const computeFitDistance = (aspect: number): number => {
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
      const limitingFov = Math.min(vFov, hFov);
      return (radius / (targetFill * Math.tan(limitingFov / 2))) * 1.1;
    };

    let fitDistance = computeFitDistance(1);

    const viewDirection = getDefaultViewDirection();
    camera.position.copy(viewDirection).multiplyScalar(fitDistance);
    camera.lookAt(0, 0, 0);

    const light = new THREE.DirectionalLight(0xffffff, 1.3);
    light.position.set(1.5, 2.2, 2.5);
    scene.add(light);

    const fill = new THREE.HemisphereLight(0xb8d7ff, 0x1c2430, 0.75);
    scene.add(fill);

    let zoomRatio = 1;
    let currentDistance = fitDistance;

    const resize = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height, false);
      const aspect = width / height;
      camera.aspect = aspect;
      fitDistance = computeFitDistance(aspect);
      currentDistance = fitDistance * zoomRatio;

      camera.position.copy(viewDirection).multiplyScalar(currentDistance);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
    };

    if (options.interactive) {
      const gizmo = new OrientationGizmo();
      gizmo.element.classList.add("orientation-gizmo--preview");
      container.appendChild(gizmo.element);
      const gizmoCameraProxy = new THREE.Object3D();

      let pointerDown = false;
      let lastX = 0;
      let lastY = 0;

      let yawAngle = 0;
      let pitchAngle = 0;
      const worldUpAxis = new THREE.Vector3(0, 1, 0);
      const pitchAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const yawQuaternion = new THREE.Quaternion();
      const pitchQuaternion = new THREE.Quaternion();

      const handlePointerDown = (event: PointerEvent) => {

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
        yawAngle += dx * 0.01;
        // Clamped to +-90 degrees so vertical dragging can't carry the model
        // past vertical and flip it upside down
        const PITCH_LIMIT = Math.PI / 2;
        pitchAngle = THREE.MathUtils.clamp(pitchAngle + dy * 0.01, -PITCH_LIMIT, PITCH_LIMIT);

        yawQuaternion.setFromAxisAngle(worldUpAxis, yawAngle);
        pitchQuaternion.setFromAxisAngle(pitchAxis, pitchAngle);
        modelRoot.quaternion.copy(pitchQuaternion).multiply(yawQuaternion);
      };
      const handlePointerUp = (event: PointerEvent) => {
        pointerDown = false;
        previewCanvas.releasePointerCapture(event.pointerId);
      };
      const handleWheel = (event: WheelEvent) => {
        event.preventDefault();
        // Scrolling "up"/away from the user (negative deltaY) zooms IN
        // (camera moves closer); scrolling down (positive deltaY) zooms
        // OUT - the usual map/CAD-viewer convention. deltaY's sign is
        // therefore used directly (not negated) when driving distance.
        const zoomFactor = Math.exp(event.deltaY * 0.0015);
        zoomRatio = THREE.MathUtils.clamp(zoomRatio * zoomFactor, 0.2, 6);
        currentDistance = fitDistance * zoomRatio;
        camera.position.copy(viewDirection).multiplyScalar(currentDistance);
        camera.lookAt(0, 0, 0);
      };

      previewCanvas.addEventListener("pointerdown", handlePointerDown);
      previewCanvas.addEventListener("pointermove", handlePointerMove);
      previewCanvas.addEventListener("pointerup", handlePointerUp);
      previewCanvas.addEventListener("pointerleave", () => {
        pointerDown = false;
      });
      previewCanvas.addEventListener("wheel", handleWheel, { passive: false });

      const resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(container);

      const tick = () => {
        if (!container.isConnected) {
          renderer.dispose();
          resizeObserver.disconnect();
          return;
        }
        gizmoCameraProxy.quaternion.copy(modelRoot.quaternion).invert().multiply(camera.quaternion);
        gizmo.update(gizmoCameraProxy as unknown as THREE.Camera);
        renderer.render(scene, camera);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      resize();
    } else {
      // Non-interactive: nothing ever changes after the first real layout,
      // so render exactly once - as soon as the container actually has a
      // size (it can be zero on the very first synchronous call, before
      // layout has run) - and free the GL context right away instead of
      // holding one open per thumbnail (see this method's doc comment).
      const renderOnceReady = (): void => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        resize();
        renderer.render(scene, camera);
        renderer.dispose();
        resizeObserver.disconnect();
      };
      const resizeObserver = new ResizeObserver(() => renderOnceReady());
      resizeObserver.observe(container);
      renderOnceReady(); // covers the common case where layout's already settled
    }
  }

  private renderExportMeshPreview(): void {
    const host = this.el<HTMLElement>("export-mesh-export-preview");
    host.innerHTML = "";

    const draws = this.getExportIndices()
      .map((i) => this.loadedDraws[i])
      .filter((d): d is LoadedDraw => !!d);
    if (draws.length === 0) return;

    const exportOptions = this.appConfig.config.exportOptions;
    this.attachMultiMeshPreview(host, draws, {
      interactive: true,
      poseMode: exportOptions.exportType === "output" ? "posed" : "non-posed",
      textured: exportOptions.exportTextures,
    });
  }

  /** Sizes and positions the resource panel. Sizing always follows
   * resourcePanelSize/resourcePanelMinSize (as before); positioning now
   * comes from resourcePanelPosition, which defaults to the bottom-left
   * corner of the viewport the first time the panel is ever shown, and
   * from then on just remembers wherever the user last dragged it to
   * (see startResourceDrag()) - clamped back onscreen here in case the
   * viewport has since shrunk (e.g. a browser resize). */
  private positionResourcePanel(panel: HTMLElement): void {
    const viewportRect = this.viewport.getBoundingClientRect();
    const minWidth = this.resourcePanelMinSize.width;
    const minHeight = this.resourcePanelMinSize.height;
    const panelWidth = Math.max(minWidth, Math.min(this.resourcePanelSize.width, viewportRect.width - 24));
    const panelHeight = Math.max(minHeight, Math.min(this.resourcePanelSize.height, viewportRect.height - 24));
    panel.style.width = `${panelWidth}px`;
    panel.style.height = `${panelHeight}px`;

    if (!this.resourcePanelPosition) {
      this.resourcePanelPosition = { left: 12, top: viewportRect.height - panelHeight - 12 };
    }

    const maxLeft = Math.max(12, viewportRect.width - panelWidth - 12);
    const maxTop = Math.max(12, viewportRect.height - panelHeight - 12);
    const left = Math.min(Math.max(this.resourcePanelPosition.left, 12), maxLeft);
    const top = Math.min(Math.max(this.resourcePanelPosition.top, 12), maxTop);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  /** Drag-to-move for the whole panel, started from pointerdown on its
   * header (see renderResourcePanel()) - mirrors startResourceResize()'s
   * structure exactly, just moving left/top instead of resizing. Persists
   * the result to resourcePanelPosition so it's remembered across
   * selection changes and hide/show toggles (see positionResourcePanel()). */
  private startResourceDrag(panel: HTMLElement, event: PointerEvent): void {
    event.preventDefault();

    const origin = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };

    const onMove = (moveEvent: PointerEvent): void => {
      const viewportRect = this.viewport.getBoundingClientRect();
      const maxLeft = Math.max(12, viewportRect.width - panel.offsetWidth - 12);
      const maxTop = Math.max(12, viewportRect.height - panel.offsetHeight - 12);
      const left = Math.min(Math.max(origin.left + (moveEvent.clientX - origin.x), 12), maxLeft);
      const top = Math.min(Math.max(origin.top + (moveEvent.clientY - origin.y), 12), maxTop);
      this.resourcePanelPosition = { left, top };
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
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
    const multiRowHeight = 12.5 * vh + 34; // matches .resource-multi-row's fixed CSS height

    const header = panel.querySelector<HTMLElement>(".resource-header");
    const tabs = panel.querySelector<HTMLElement>(".resource-tabs");
    // There can be up to two of these now ("Textures" and "Selected
    // objects") - sum whichever are actually present rather than assuming
    // there's exactly one.
    const subheads = panel.querySelectorAll<HTMLElement>(".resource-subhead");
    const hasTextureRow = panel.querySelector(".resource-texture-list") !== null;
    const hasMultiRow = panel.querySelector(".resource-multi-row") !== null;
    const panelStyle = getComputedStyle(panel);
    const paddingX = parseFloat(panelStyle.paddingLeft || "0") + parseFloat(panelStyle.paddingRight || "0");
    const paddingY = parseFloat(panelStyle.paddingTop || "0") + parseFloat(panelStyle.paddingBottom || "0");

    const headerHeight = header?.offsetHeight ?? 20;
    const tabsHeight = tabs?.offsetHeight ?? 0;
    let subheadsHeight = 0;
    subheads.forEach((el) => (subheadsHeight += el.offsetHeight));
    const previewMarginBottom = 8; // matches .resource-preview's margin-bottom in CSS
    const rowsHeight = (hasTextureRow ? textureRowHeight : 0) + (hasMultiRow ? multiRowHeight : 0);

    return {
      width: Math.ceil(previewSize + paddingX),
      height: Math.ceil(
        headerHeight + tabsHeight + previewSize + previewMarginBottom + subheadsHeight + rowsHeight + paddingY,
      ),
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
      const clampedLeft = Math.min(Math.max(nextLeft, 12), viewRect.width - nextWidth - 12);
      const clampedTop = Math.min(Math.max(nextTop, 12), viewRect.height - nextHeight - 12);
      this.resourcePanelPosition = { left: clampedLeft, top: clampedTop };
      panel.style.width = `${nextWidth}px`;
      panel.style.height = `${nextHeight}px`;
      panel.style.left = `${clampedLeft}px`;
      panel.style.top = `${clampedTop}px`;
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

  private describeDrawLabel(index: number): string {
    const name = this.loadedDraws[index]?.draw.name;
    return name && name.trim().length > 0 ? name : `Draw #${index}`;
  }

  private setResourcePanelTab(tab: "last" | "all"): void {
    if (this.resourcePanelActiveTab === tab) return;
    this.resourcePanelActiveTab = tab;
    if (this.resourcePanelIndex !== null) this.renderResourcePanel(this.resourcePanelIndex);
  }

  private featureResourcePanelObject(index: number): void {
    this.resourcePanelIndex = index;
    this.resourcePanelActiveTab = "last";
    this.renderResourcePanel(index);
  }

  private renderResourcePanel(index: number): void {
    const existing = this.viewport.querySelector<HTMLElement>(".resource-panel");
    const selectedList = Array.from(this.selectedIndices).sort((a, b) => a - b);
    const isMulti = selectedList.length > 1;
    // A single-object selection has nothing to show a second tab for -
    // pin to "last" so a leftover "all" choice from a previous
    // multi-selection doesn't show a blank/nonsensical tab bar.
    const activeTab = isMulti ? this.resourcePanelActiveTab : "last";
    // Everything that decides what actually gets rendered below, joined
    // into one key - renderResourcePanel() gets called on every selection
    // tweak (see noteSelectionTarget()), most of which don't actually
    // require a rebuild, so this lets that stay a no-op like it always
    // was for the plain single-object case.
    const signature = `${activeTab}:${index}:${selectedList.join(",")}`;
    if (existing && existing.dataset.signature === signature) return;
    existing?.remove();

    const draw = this.loadedDraws[index];
    if (!draw) return;

    const panel = document.createElement("aside");
    panel.className = "resource-panel";
    panel.dataset.index = String(index);
    panel.dataset.signature = signature;

    const tabsMarkup = isMulti
      ? `
        <div class="resource-tabs">
          <button type="button" class="resource-tab${activeTab === "last" ? " is-active" : ""}" data-tab="last">Last selected</button>
          <button type="button" class="resource-tab${activeTab === "all" ? " is-active" : ""}" data-tab="all">All selected (${selectedList.length})</button>
        </div>`
      : "";

    const showTextures = activeTab === "last";
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
    const texturesMarkup = showTextures
      ? `
        <div class="resource-subhead">Textures</div>
        <ul class="resource-texture-list">${textureItems}</ul>`
      : "";

    const multiRowMarkup = isMulti
      ? `
        <div class="resource-subhead">Selected objects</div>
        <div class="resource-multi-row">
          ${selectedList
            .map(
              (i) => `
            <div class="resource-multi-thumb${i === index ? " selected" : ""}" data-multi-index="${i}" title="${this.describeDrawLabel(i)}">
              <div class="resource-multi-thumb-canvas-host"></div>
              <span class="resource-multi-thumb-label">${this.describeDrawLabel(i)}</span>
            </div>`,
            )
            .join("")}
          <div class="resource-multi-thumb resource-multi-thumb--combined${activeTab === "all" ? " selected" : ""}" data-multi-combined="true" title="All selected objects">
            <div class="resource-multi-thumb-canvas-host"></div>
            <span class="resource-multi-thumb-label">All selected</span>
          </div>
        </div>`
      : "";

    const previewText = draw.previewPath ? `Previewing ${draw.previewPath}` : "Preview mesh";
    panel.innerHTML = `
      <div class="resource-header" title="Drag to move">${previewText}</div>
      ${tabsMarkup}
      <div class="resource-preview"></div>
      ${texturesMarkup}
      ${multiRowMarkup}
      <div class="resource-corner resource-corner--upper-right" data-corner="upper-right" aria-label="Resize preview"></div>
      <div class="resource-corner resource-corner--lower-right" data-corner="lower-right" aria-label="Resize preview"></div>
    `;

    const previewHost = panel.querySelector<HTMLElement>(".resource-preview");
    if (previewHost) {
      if (activeTab === "all") {
        const selectedDraws = selectedList.map((i) => this.loadedDraws[i]).filter((d): d is LoadedDraw => !!d);
        this.attachMultiMeshPreview(previewHost, selectedDraws, { interactive: true });
      } else {
        this.attachMeshPreview(previewHost, draw);
      }
    }

    panel.querySelectorAll<HTMLElement>(".resource-corner").forEach((handle) => {
      handle.addEventListener("pointerdown", (event) => this.startResourceResize(panel, handle, event as PointerEvent));
    });


    const header = panel.querySelector<HTMLElement>(".resource-header");
    header?.addEventListener("pointerdown", (event) => this.startResourceDrag(panel, event as PointerEvent));

    if (isMulti) {
      panel.querySelectorAll<HTMLButtonElement>(".resource-tab").forEach((tabButton) => {
        tabButton.addEventListener("click", () => {
          const tab = tabButton.dataset.tab === "all" ? "all" : "last";
          this.setResourcePanelTab(tab);
        });
      });

      panel.querySelectorAll<HTMLElement>(".resource-multi-thumb[data-multi-index]").forEach((thumbEl) => {
        const thumbIndex = Number(thumbEl.dataset.multiIndex);
        if (!Number.isInteger(thumbIndex)) return;
        thumbEl.addEventListener("click", () => this.featureResourcePanelObject(thumbIndex));

        const host = thumbEl.querySelector<HTMLElement>(".resource-multi-thumb-canvas-host");
        const thumbDraw = this.loadedDraws[thumbIndex];
        if (host && thumbDraw) this.attachMultiMeshPreview(host, [thumbDraw], { interactive: false });
      });

      const combinedThumb = panel.querySelector<HTMLElement>(".resource-multi-thumb--combined");
      combinedThumb?.addEventListener("click", () => this.setResourcePanelTab("all"));
      const combinedHost = combinedThumb?.querySelector<HTMLElement>(".resource-multi-thumb-canvas-host");
      if (combinedHost) {
        const selectedDraws = selectedList.map((i) => this.loadedDraws[i]).filter((d): d is LoadedDraw => !!d);
        this.attachMultiMeshPreview(combinedHost, selectedDraws, { interactive: false });
      }
    }

    if (showTextures) {
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
    }

    this.viewport.appendChild(panel);

    const minSize = this.computeResourcePanelMinSize(panel);
    this.resourcePanelMinSize = minSize;
    this.resourcePanelSize = {
      width: Math.max(this.resourcePanelSize.width, minSize.width),
      height: Math.max(this.resourcePanelSize.height, minSize.height),
    };
    this.positionResourcePanel(panel);
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
    this.pushUndoSnapshot();
    this.selectedIndices.clear();
    this.selectedIndices.add(index);
    this.lastClickedIndex = index;
    this.noteSelectionTarget(index);
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
    this.pushUndoSnapshot();
    const anchor = this.lastClickedIndex ?? index;
    const lo = Math.min(anchor, index);
    const hi = Math.max(anchor, index);
    this.selectedIndices.clear();
    for (let i = lo; i <= hi; i++) {
      if (!this.isObjectHidden(i)) this.selectedIndices.add(i);
    }
    // Anchor intentionally left unchanged - see lastClickedIndex's doc comment.
    this.noteSelectionTarget(index);
    this.refreshSelectionVisuals();
    this.renderObjectListState();
  }

  private handleObjectClick(index: number, shiftKey: boolean, ctrlKey: boolean): void {
    if (this.isObjectHidden(index)) return;
    if (Config.sessionConfig.tools.activeTool === "select-landmark") {
      this.selectOnly(index);
      return;
    }
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
    raycaster.setFromCamera(mouse, this.sceneManager.activeCamera);
    const contentGroup = this.sceneManager.getContentGroup();
    const roots = contentGroup ? [contentGroup] : this.sceneManager.scene.children;
    const hits = raycaster.intersectObjects(roots, true).filter((hit) => !hit.object.userData.isSelectionVisual);
    const hit = hits.find((entry) => {
      const drawIndices = entry.object.userData.drawIndices;
      return Array.isArray(drawIndices) && drawIndices.length > 0;
    });
    if (!hit) return null;

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
            this.sceneManager.activeCamera,
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
    if (event.button === 2 && this.lassoDragActive) {
      this.cancelLassoDrag();
      return;
    }
    if (event.button === 1) return;

    if (event.button === 0 && Config.sessionConfig.tools.activeTool === null) {
      // Lasso select is the default left-drag behavior whenever no other
      // tool is armed - see handleLassoPointerDown()'s own doc comment.
      // Whether this ends up being a lasso or a plain click is only known
      // once the gesture finishes (handleLassoPointerUp() falls back to
      // selectDrawAtPointer() for anything that never crosses
      // LASSO_DRAG_THRESHOLD), so nothing is selected here on pointerdown.
      this.handleLassoPointerDown(event);
      return;
    }

    const index = this.pickDrawAtPointer(event);

    if (event.button === 2) {
      if (index === null || this.isObjectHidden(index) || this.manuallyHiddenIndices.has(index)) {
        this.clearSelection();
        return;
      }

      if (!this.selectedIndices.has(index)) {
        this.clearSelection();
      }
      return;
    }

    // Only reachable here for button === 0 with some OTHER tool armed (e.g.
    // select-landmark) that still wants immediate click-to-select rather
    // than the deferred lasso/click disambiguation above.
    this.selectDrawAtPointer(event, index);
  }

  private selectDrawAtPointer(event: PointerEvent, index?: number | null): void {
    const resolvedIndex = index === undefined ? this.pickDrawAtPointer(event) : index;
    if (resolvedIndex === null || this.isObjectHidden(resolvedIndex) || this.manuallyHiddenIndices.has(resolvedIndex)) return;
    this.pushUndoSnapshot();

    // Same single-selection-only restriction as handleObjectClick() for the
    // object list - see its doc comment.
    const forceSingleSelection = Config.sessionConfig.tools.activeTool === "select-landmark";
    if (!forceSingleSelection && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      if (this.selectedIndices.has(resolvedIndex)) this.selectedIndices.delete(resolvedIndex);
      else this.selectedIndices.add(resolvedIndex);
    } else {
      this.selectedIndices.clear();
      this.selectedIndices.add(resolvedIndex);
    }

    this.lastClickedIndex = resolvedIndex;
    this.noteSelectionTarget(resolvedIndex);
    this.refreshSelectionVisuals();
    this.renderObjectListState();
    this.scrollDrawIntoView(resolvedIndex);
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
  /** Currently selected AND actually visible objects - "selected" should
   * always mean what's actually highlighted/visible on screen, not some
   * separate notion of selection that includes hidden objects. Used for the
   * on-screen highlight (updateSelectionVisuals()) and as the base that
   * getExportIndices() falls back from. */
  private getActiveSelectedIndices(): number[] {
    return Array.from(this.selectedIndices).filter(
      (i) => !this.isObjectHidden(i) && !this.manuallyHiddenIndices.has(i),
    );
  }

  /** What "export" actually operates on: the active selection, or - if
   * nothing's selected - every currently visible object. Shared by the
   * quick export button (exportSelectedMeshesAsGlb()), the export dialog
   * (openExportDialog()), and its live preview (renderExportMeshPreview()),
   * so all three agree on what's being exported. */
  private getExportIndices(): number[] {
    const selected = this.getActiveSelectedIndices();
    if (selected.length > 0) return selected;

    const visible: number[] = [];
    for (let i = 0; i < this.loadedDraws.length; i++) {
      if (!this.isObjectHidden(i) && !this.manuallyHiddenIndices.has(i)) visible.push(i);
    }
    return visible;
  }

  private updateSelectionVisuals(): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;

    const activeSelected = this.getActiveSelectedIndices();

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
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.outlineQuadMaterial);
    quad.frustumCulled = false;
    this.outlineQuadScene.add(quad);

    this.sceneManager.onAfterRender(() => this.renderSelectionOutlinePass());
  }

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
    renderer.render(this.outlineMaskScene, this.sceneManager.activeCamera);

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.autoClear = false;
    renderer.render(this.outlineQuadScene, this.outlineQuadCamera);
    renderer.autoClear = previousAutoClear;
  }

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
        // The panel always tracks the selection now (see
        // noteSelectionTarget()), so "show resources for this row"
        // becomes "select this row, and make sure the panel's on".
        this.selectOnly(index);
        this.toggleResourcePanel(true);
        return;
      }

      const isSelectionButton = action === "selection";
      const shiftKey = event.shiftKey;
      const ctrlKey = event.ctrlKey || event.metaKey || (isSelectionButton && !shiftKey);
      this.handleObjectClick(index, shiftKey, ctrlKey);
    });
  }
}
