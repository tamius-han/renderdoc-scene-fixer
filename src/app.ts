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
import { TextureManager } from "./scene/texture-manager";
import type { DrawEntry, PassIndexEntry } from "./types";
import { calculateDistortion } from "./mesh-tools/calculator";

// Selection outlines are rendered as a backface shell displaced in clip
// space so the visible thickness stays at a literal 3 screen pixels.
const SELECTION_OUTLINE_COLOR = new THREE.Color(0xffaa66);

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
}

export class SceneViewerApp {
  private vfs = new VirtualFileSystem();
  private loaded: LoadedManifests | null = null;
  private textures = new TextureManager();
  private sceneManager: SceneManager;

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
  /** Index into loadedDraws of the object marked as the scale reference for
   * transform-correction recalculation (see setLandmark() /
   * recalculateTransformCorrection()) - at most one object can hold this at
   * a time. */
  private scaleReferenceIndex: number | null = null;
  /** Rotation applied to the whole scene's content group (not to individual
   * objects) - persisted here so it survives rebuildVisibleScene() rebuilds
   * (filter/visibility changes tear down and recreate the content group).
   * Only ever set by recalculateTransformCorrection() when "also apply
   * rotation" is checked; identity otherwise. */
  private sceneRotation = new THREE.Quaternion();
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

  private dropzone = this.el("dropzone");
  private folderInput = this.el<HTMLInputElement>("folder-input");
  private passSection = this.el("pass-section");
  private passList = this.el("pass-list");
  private poseWarning = this.el("pose-warning");
  private reconstructBtn = this.el<HTMLButtonElement>("reconstruct-btn");
  private recalculateCorrectionBtn = this.el<HTMLButtonElement>("recalculate-correction-btn");
  private applyRotationCheckbox = this.el<HTMLInputElement>("apply-rotation-checkbox");
  private resetCamBtn = this.el("reset-cam-btn");
  private recenterCamBtn = this.el("recenter-camera-btn");
  private statusBar = this.el("status-bar");
  private emptyHint = this.el("empty-hint");
  private hud = this.el("hud");
  private objectList = this.el('object-list');
  private viewport = this.el<HTMLElement>("viewport");
  // Placeholder values - recomputed from the actual viewport height and the
  // panel's real rendered content every time a resource panel is opened,
  // see computeResourcePanelMinSize() and showResources().
  private resourcePanelMinSize = { width: 360, height: 420 };
  private resourcePanelSize = { ...this.resourcePanelMinSize };

  private importFilterSlider = this.el<HTMLInputElement>("import-filter-size-slider");
  private importFilterValue = this.el<HTMLInputElement>("import-filter-size-value");
  private viewportFilterSlider = this.el<HTMLInputElement>("object-filter-size-slider");
  private viewportFilterValue = this.el<HTMLInputElement>("object-filter-size-value");

  private flyModeToggle = this.el<HTMLInputElement>("fly-mode-toggle");
  private flyModeLabel = this.el("fly-mode-label");
  private flySpeedIndicator = this.el("fly-speed-indicator");

  private controlSchemeDropdown = this.el<HTMLSelectElement>("control-scheme-dropdown");
  private controlSchemeLabel = this.el("control-scheme-label");

  constructor(viewportEl: HTMLElement) {
    this.sceneManager = new SceneManager(viewportEl);
    this.sceneManager.onContextLoss((lost) => {
      if (lost) {
        this.setStatus(
          "WebGL context lost - the scene is likely too large for available GPU memory. Try selecting fewer passes.",
        );
      }
    });
    // Keeps the UI toggle/label/speed indicator in sync regardless of
    // whether fly mode was triggered from this checkbox or the 'A' key.
    this.sceneManager.onFlyStateChange((flying, speed) => {
      this.flyModeToggle.checked = flying;
      this.flyModeLabel.textContent = flying ? "Fly cam (first-person)" : "Orbit / pan";
      this.flySpeedIndicator.style.display = flying ? "block" : "none";
      this.flySpeedIndicator.textContent = flying ? `Speed: ${this.formatFlySpeed(speed)} \u00b7 scroll to adjust` : "";
    });
    this.sceneManager.onControlSchemeChange((scheme) => {
      this.controlSchemeDropdown.value = scheme;
      this.controlSchemeLabel.textContent =
        scheme === "wasd" ? "WASD - movement; F: toggle fly mode" : "ESDF - movement; A: toggle fly mode";
    });
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

  private wireEvents(): void {
    this.dropzone.addEventListener("click", () => this.folderInput.click());
    this.dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.dropzone.classList.add("drag");
    });
    this.dropzone.addEventListener("dragleave", () => this.dropzone.classList.remove("drag"));
    this.dropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      this.dropzone.classList.remove("drag");
      if (!e.dataTransfer) return;
      this.setStatus("Reading dropped folder...");
      const entries = await collectFromDrop(e.dataTransfer);
      await this.handleFiles(entries);
    });
    this.folderInput.addEventListener("change", async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      this.setStatus("Reading folder...");
      await this.handleFiles(collectFromInput(files));
    });

    this.reconstructBtn.addEventListener("click", () => void this.reconstructScene());
    this.recalculateCorrectionBtn.addEventListener("click", () => this.recalculateTransformCorrection());
    this.resetCamBtn.addEventListener("click", () => this.sceneManager.frameOnScene());
    this.recenterCamBtn.addEventListener("click", () => this.sceneManager.frameOnScene());
    this.flyModeToggle.addEventListener("change", () => this.sceneManager.setFlying(this.flyModeToggle.checked));
    this.controlSchemeDropdown.addEventListener("change", () => {
      const scheme = this.controlSchemeDropdown.value === "wasd" ? "wasd" : "esdf";
      this.sceneManager.setControlScheme(scheme);
    });

    // Both filter control pairs (import screen + post-reconstruct viewport
    // menu) drive the same underlying value and stay in sync with each
    // other - see setHidePercent().
    for (const slider of [this.importFilterSlider, this.viewportFilterSlider]) {
      slider.addEventListener("input", () => this.setHidePercent(Number(slider.value)));
    }
    for (const text of [this.importFilterValue, this.viewportFilterValue]) {
      text.addEventListener("change", () => this.setHidePercent(Number(text.value)));
    }

    this.setupObjectList();
  }

  private setHidePercent(value: number): void {
    const clamped = Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
    this.hidePercent = clamped;
    for (const slider of [this.importFilterSlider, this.viewportFilterSlider]) slider.value = String(clamped);
    for (const text of [this.importFilterValue, this.viewportFilterValue]) text.value = String(clamped);
    if (this.loadedDraws.length > 0) this.rebuildVisibleScene();
  }

  private async handleFiles(entries: { path: string; file: File }[]): Promise<void> {
    if (entries.length === 0) return;

    this.vfs = new VirtualFileSystem();
    for (const { path, file } of entries) this.vfs.set(path, file);

    const loaded = await loadManifests(this.vfs);
    if (!loaded) {
      this.setStatus("No manifest.json found in the dropped folder - is this a SceneExporter export?");
      return;
    }

    this.loaded = loaded;
    this.renderPassList();
    const failedNote = loaded.failedPassFolders.length
      ? ` (WARNING: ${loaded.failedPassFolders.length} pass manifest(s) failed to load - see console)`
      : "";
    this.setStatus(`Loaded manifest: ${loaded.root.passes.length} pass(es) found.${failedNote}`);
  }

  private renderPassList(): void {
    if (!this.loaded) return;
    this.passSection.style.display = "block";
    this.passList.innerHTML = "";

    const defaultIndex = this.loaded.root.passes.findIndex((p) => p.guessedRole?.includes("presented"));
    const selectedDefault = defaultIndex >= 0 ? defaultIndex : 0;

    this.loaded.root.passes.forEach((p: PassIndexEntry, i: number) => {
      const hasPosed = (this.loaded!.passManifests[p.folder]?.draws ?? []).some((d) => d.posedMesh);
      const row = document.createElement("label");
      row.className = "pass-row";
      row.innerHTML = `
        <input type="checkbox" data-folder="${p.folder}" ${i === selectedDefault ? "checked" : ""}>
        <div class="meta">
          <div class="name">${p.folder}</div>
          <div class="role">${p.guessedRole ?? ""}</div>
          <div class="stats">${p.drawCount} draw(s) &middot; ${p.colorTargets.length} color target(s) &middot; depth=${p.depthTarget ? "yes" : "no"} &middot; posed=${hasPosed ? "yes" : "no"}</div>
        </div>`;
      this.passList.appendChild(row);
    });

    for (const cb of this.passList.querySelectorAll("input")) {
      cb.addEventListener("change", () => this.updatePoseWarning());
    }
    this.updatePoseWarning();
  }

  private getSelectedFolders(): string[] {
    return Array.from(this.passList.querySelectorAll<HTMLInputElement>("input:checked")).map(
      (cb) => cb.dataset.folder as string,
    );
  }

  private updatePoseWarning(): void {
    if (!this.loaded) return;
    const selected = this.getSelectedFolders();
    const anyPosed = selected.some((f) => (this.loaded!.passManifests[f]?.draws ?? []).some((d) => d.posedMesh));

    if (!anyPosed) {
      this.showWarning(
        "None of the selected passes have posed mesh data (this export may have been done without \u201cwith posed meshes\u201d) - falling back to bind pose, piled near the origin.",
      );
    } else if (selected.length > 1) {
      this.showWarning(
        "Multiple passes selected: posed geometry is relative to whatever camera was active for that pass. Different passes may use different cameras and won't necessarily align spatially when combined.",
      );
    } else {
      this.poseWarning.style.display = "none";
    }
  }

  private showWarning(message: string): void {
    this.poseWarning.style.display = "block";
    this.poseWarning.textContent = message;
  }

  private setStatus(message: string): void {
    this.statusBar.textContent = message;
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
    div.className = "draw-item";
    div.dataset.index = String(drawIndex);
    div.innerHTML = `
      <b>Draw #${drawIndex}</b> <small>(eid ${draw.eventId})</small>
      &nbsp; &nbsp; vis: <button class="check-like" data-action="visibility" data-index="${drawIndex}">[ ]</button>
      &nbsp; sel: <button class="check-like" data-action="selection" data-index="${drawIndex}">[ ]</button>
      &nbsp; is ref: <button class="check-like" data-action="landmark" data-index="${drawIndex}">[ ]</button>
      <small>v: ${vertices}, f: ${faces}, size: ${size.toFixed(2)}</small> &nbsp; <button data-action="resources" data-index="${drawIndex}">res</button>
    `;

    wrap.appendChild(div);
    return wrap;
  }

  private async reconstructScene(): Promise<void> {
    if (!this.loaded) return;
    const selected = this.getSelectedFolders();
    if (selected.length === 0) {
      this.setStatus("Select at least one pass first.");
      return;
    }

    this.reconstructBtn.disabled = true;
    this.emptyHint.style.display = "none";
    this.hud.style.display = "block";
    this.setStatus(`Reconstructing ${selected.length} pass(es): ${selected.join(", ")}`);

    try {
      this.clearSelectionVisuals();
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
        const manifest = this.loaded.passManifests[folder];
        if (!manifest) {
          if (!loggedMissingManifest) {
            console.error(
              `[reconstruct] No manifest data for pass "${folder}" - it either failed to load ` +
                `(check the warning when the folder was dropped) or was never fetched.`,
            );
            loggedMissingManifest = true;
          }
          continue;
        }
        const passDir = joinPath(this.loaded.rootPrefix, folder);

        for (const draw of manifest.draws) {
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
          }
          if (processed % 50 === 0) {
            this.setStatus(`Loading... ${processed} draw(s) processed, ${this.loadedDraws.length} loaded so far`);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }

      // Normalization scale is computed ONCE here, from every loaded draw
      // regardless of the size filter, and then held fixed - see
      // computeNormalizationScale() and rebuildVisibleScene().
      this.fixedScale = 1;
      if (this.loadedDraws.length > 0) {
        let overall: Bounds = this.loadedDraws[0].bounds;
        for (let i = 1; i < this.loadedDraws.length; i++) overall = unionBounds(overall, this.loadedDraws[i].bounds);
        const size = overall.max.clone().sub(overall.min);
        const maxDim = Math.max(size.x, size.y, size.z);
        this.fixedScale = computeNormalizationScale(maxDim);
        console.log("[reconstruct] scene bounds", { min: overall.min, max: overall.max, size, scale: this.fixedScale });
      }

      const problems: string[] = [];
      if (meshNotFoundCount) problems.push(`${meshNotFoundCount} mesh file(s) not found`);
      if (exceptionCount) problems.push(`${exceptionCount} threw an error`);
      if (noMeshPathCount) problems.push(`${noMeshPathCount} had no mesh path in the manifest`);
      this.lastProblemNote = problems.length ? ` \u2014 PROBLEMS: ${problems.join(", ")} (see console)` : "";

      this.rebuildVisibleScene();
    } catch (e) {
      console.error("[reconstruct] Reconstruction failed", e);
      this.setStatus(`Reconstruct failed: ${e instanceof Error ? e.message : String(e)} (see console for details)`);
    } finally {
      this.reconstructBtn.disabled = false;
    }
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
    this.sceneManager.clear();
    const contentGroup = this.sceneManager.addContent(meshes, this.fixedScale);
    contentGroup.quaternion.copy(this.sceneRotation);
    this.updateSelectionVisuals();

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

  /** Runs the transform-correction recalculation for the object currently
   * marked as the scale reference (see setLandmark()), then applies the
   * resulting per-axis scale to EVERY loaded draw (including hidden ones -
   * hiddenness only affects rendering/selection, not the underlying data).
   * If "also apply rotation" is checked, the whole scene's content group
   * (not individual objects) is additionally rotated by
   * posedToNonPosedRotation. */
  private recalculateTransformCorrection(): void {
    if (this.scaleReferenceIndex === null) {
      this.setStatus("Mark an object as the scale reference first (\u201cis ref\u201d button in the object list).");
      return;
    }
    const scaleReferenceObject = this.loadedDraws[this.scaleReferenceIndex];
    if (!scaleReferenceObject) {
      this.scaleReferenceIndex = null;
      this.renderObjectListState();
      return;
    }

    const distortion = calculateDistortion(scaleReferenceObject);

    for (const draw of this.loadedDraws) {
      this.applyScaleToPositions(draw.geometryData.positions, distortion.scale);
      if (draw.previewGeometryData.positions !== draw.geometryData.positions) {
        this.applyScaleToPositions(draw.previewGeometryData.positions, distortion.scale);
      }
      draw.bounds = computeBounds(draw.geometryData.positions);
      draw.diagonal = boundsDiagonal(draw.bounds);
    }

    let overall: Bounds = this.loadedDraws[0].bounds;
    for (let i = 1; i < this.loadedDraws.length; i++) overall = unionBounds(overall, this.loadedDraws[i].bounds);
    const size = overall.max.clone().sub(overall.min);
    this.fixedScale = computeNormalizationScale(Math.max(size.x, size.y, size.z));

    if (this.applyRotationCheckbox.checked) {
      this.sceneRotation = distortion.posedToNonPosedRotation;
    }

    this.rebuildVisibleScene();
    this.setStatus(
      `Applied distortion correction (scale ${distortion.scale.x.toFixed(3)}, ${distortion.scale.y.toFixed(3)}, ${distortion.scale.z.toFixed(3)})` +
        `${this.applyRotationCheckbox.checked ? " and scene rotation" : ""} to ${this.loadedDraws.length} object(s).`,
    );
  }

  /** Multiplies every vertex in a flat, non-indexed positions array
   * (x0,y0,z0,x1,y1,z1,...) by scale, in place. */
  private applyScaleToPositions(positions: number[], scale: THREE.Vector3): void {
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] *= scale.x;
      positions[i + 1] *= scale.y;
      positions[i + 2] *= scale.z;
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
    const size = bounds.max.clone().sub(bounds.min);
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
    mesh.position.sub(center);
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
    // they'd zoomed in/out instead of resetting it.
    let zoomRatio = 1;
    let currentDistance = fitDistance;

    const handlePointerDown = (event: PointerEvent) => {
      // Middle mouse button only, matching the main viewport's Blender-
      // style scheme (left/other buttons intentionally do nothing).
      if (event.button !== 1) return;
      event.preventDefault(); // stops the browser's middle-click autoscroll icon
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
      modelRoot.rotation.x += dy * 0.01;
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

  /** Builds the screen-space outline mesh and both dot
   * marker pairs for the currently-selected, currently-rendered objects,
   * and adds them to the content group. No-ops if nothing is selected, or
   * if there's no content group yet (nothing reconstructed). Selected
   * objects that are filtered or manually hidden right now are excluded -
   * there's nothing to outline/mark if they're not actually being drawn. */
  private updateSelectionVisuals(): void {
    const group = this.sceneManager.getContentGroup();
    if (!group) return;

    const activeSelected = Array.from(this.selectedIndices).filter(
      (i) => !this.isObjectHidden(i) && !this.manuallyHiddenIndices.has(i),
    );
    if (activeSelected.length === 0) {
      this.applySelectionDimming(group, false);
      return;
    }

    this.applySelectionDimming(group, true);

    for (const index of activeSelected) {
      const outlineMesh = this.createOutlineMesh(this.loadedDraws[index]);
      if (!outlineMesh) continue;
      group.add(outlineMesh);
      this.selectionVisuals.push(outlineMesh);
    }

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

  private applySelectionDimming(group: THREE.Group, enabled: boolean): void {
    if (!enabled) return;

    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || obj.userData.isSelectionVisual) return;
      const drawIndices = obj.userData.drawIndices;
      if (!Array.isArray(drawIndices) || drawIndices.length === 0) return;
      const selected = drawIndices.some((index) => this.selectedIndices.has(Number(index)));
      if (selected) return;

      const material = obj.material;
      if (Array.isArray(material)) return;
      if (!(material instanceof THREE.MeshBasicMaterial)) return;

      const dimMaterial = material.clone();
      dimMaterial.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          "vec4 diffuseColor = vec4( diffuseColor.rgb, opacity );",
          "vec3 c = diffuseColor.rgb; float grayscale = dot(c, vec3(0.299, 0.587, 0.114)); c = mix(c, vec3(grayscale), 0.8); c *= vec3(0.38, 0.39, 0.42); vec4 diffuseColor = vec4( c, opacity );",
        );
      };
      dimMaterial.needsUpdate = true;
      obj.material = dimMaterial;
    });
  }

  /** Builds a slightly inflated shell mesh for a selected draw, so it creates
   * a real visible outline around the object instead of only tinting the back
   * side of the original mesh. */
  private createOutlineMesh(draw: LoadedDraw): THREE.Mesh | null {
    const { positions, normals } = draw.geometryData;
    if (positions.length === 0 || normals.length !== positions.length) return null;

    const offsetAmount = Math.max(0.001, draw.diagonal * 0.01);
    const expanded = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      expanded[i] = positions[i] + normals[i] * offsetAmount;
      expanded[i + 1] = positions[i + 1] + normals[i + 1] * offsetAmount;
      expanded[i + 2] = positions[i + 2] + normals[i + 2] * offsetAmount;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(expanded, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));

    const material = new THREE.MeshBasicMaterial({
      color: SELECTION_OUTLINE_COLOR,
      side: THREE.FrontSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.isSelectionVisual = true;
    mesh.renderOrder = 997;
    return mesh;
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
