import * as THREE from "three";
import { collectFromDrop, collectFromInput, dirname, joinPath, VirtualFileSystem } from "./filesystem";
import { loadManifests, type LoadedManifests } from "./manifest";
import { parseMTL } from "./parsers/mtl";
import { parseOBJ } from "./parsers/obj";
import {
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
  private hidePercent = 10;
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
  /** Indices into loadedDraws currently selected in the object list. */
  private selectedIndices = new Set<number>();
  /** Anchor point for shift-click range selection - the last index selected
   * via a plain or ctrl click (NOT updated by shift-clicks themselves, so
   * repeated shift-clicks all extend/shrink from the same anchor - standard
   * list multi-select convention). */
  private lastClickedIndex: number | null = null;

  private dropzone = this.el("dropzone");
  private folderInput = this.el<HTMLInputElement>("folder-input");
  private passSection = this.el("pass-section");
  private passList = this.el("pass-list");
  private poseWarning = this.el("pose-warning");
  private reconstructBtn = this.el<HTMLButtonElement>("reconstruct-btn");
  private resetCamBtn = this.el("reset-cam-btn");
  private statusBar = this.el("status-bar");
  private emptyHint = this.el("empty-hint");
  private hud = this.el("hud");
  private objectList = this.el('object-list');
  private viewport = this.el<HTMLElement>("viewport");
  private resourcePanelMinSize = { width: 360, height: 420 };
  private resourcePanelSize = { ...this.resourcePanelMinSize };

  private importFilterSlider = this.el<HTMLInputElement>("import-filter-size-slider");
  private importFilterValue = this.el<HTMLInputElement>("import-filter-size-value");
  private viewportFilterSlider = this.el<HTMLInputElement>("object-filter-size-slider");
  private viewportFilterValue = this.el<HTMLInputElement>("object-filter-size-value");

  private flyModeToggle = this.el<HTMLInputElement>("fly-mode-toggle");
  private flyModeLabel = this.el("fly-mode-label");
  private flySpeedIndicator = this.el("fly-speed-indicator");

  private controlSchemeToggle = this.el<HTMLInputElement>("control-scheme-toggle");
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
      this.controlSchemeToggle.checked = scheme === "wasd";
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
    this.resetCamBtn.addEventListener("click", () => this.sceneManager.frameOnScene());
    this.flyModeToggle.addEventListener("change", () => this.sceneManager.setFlying(this.flyModeToggle.checked));
    this.controlSchemeToggle.addEventListener("change", () =>
      this.sceneManager.setControlScheme(this.controlSchemeToggle.checked ? "wasd" : "esdf"),
    );

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

  private createDrawItem(draw: DrawEntry, drawIndex: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "draw-row-wrap";
    wrap.dataset.index = String(drawIndex);

    const div = document.createElement("div");
    div.className = "draw-item";
    div.dataset.index = String(drawIndex);
    div.innerHTML = `
      <b>Draw #${drawIndex}</b> <small>(eid ${draw.eventId})</small>
      &nbsp; &nbsp; vis: <button class="check-like" data-action="visibility" data-index="${drawIndex}"> </button>
      &nbsp; sel: <button class="check-like" data-action="selection" data-index="${drawIndex}">[ ]</button>
      &nbsp; is ref: <button class="check-like" data-action="landmark" data-index="${drawIndex}"> </button>
      <small>v: f: size: </small> &nbsp; <button data-action="resources" data-index="${drawIndex}">res</button>
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
              this.objectList.appendChild(this.createDrawItem(draw, globalIndex));
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
      builder.addDraw(draw.key, draw.material, draw.geometryData);
    });
    const meshes = builder.buildAll();

    this.sceneManager.clear();
    this.sceneManager.addContent(meshes, this.fixedScale);
    this.sceneManager.frameOnScene();

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
    this.renderObjectListState();
  }

  /** Not yet specified - left as a safe no-op for now. */
  private setLandmark(_index: number): void {
    // TODO: intentionally unimplemented.
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

    const bounds = draw.bounds;
    const center = bounds.min.clone().add(bounds.max).multiplyScalar(0.5);
    const size = bounds.max.clone().sub(bounds.min);
    const radius = Math.max(size.length() * 0.5, 0.25);
    const fitDistance = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.5;

    mesh.position.sub(center);
    mesh.rotation.x = -0.65;
    mesh.rotation.y = 0.85;

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

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
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
      mesh.rotation.y += dx * 0.01;
      mesh.rotation.x += dy * 0.01;
    };
    const handlePointerUp = (event: PointerEvent) => {
      pointerDown = false;
      previewCanvas.releasePointerCapture(event.pointerId);
    };

    previewCanvas.addEventListener("pointerdown", handlePointerDown);
    previewCanvas.addEventListener("pointermove", handlePointerMove);
    previewCanvas.addEventListener("pointerup", handlePointerUp);
    previewCanvas.addEventListener("pointerleave", () => {
      pointerDown = false;
    });

    const resize = () => {
      const sizePx = Math.max(200, Math.min(container.clientWidth, container.clientHeight));
      renderer.setSize(sizePx, sizePx, false);
      camera.aspect = 1;
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

  private applyResourcePanelSizing(panel: HTMLElement): void {
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    const previewWidth = Math.min(Math.max(panelWidth - 28, 240), 420);
    const previewHeight = Math.min(Math.max(panelHeight * 0.45, 220), 320);
    const preview = panel.querySelector<HTMLElement>(".resource-preview");
    if (preview) {
      preview.style.width = `${previewWidth}px`;
      preview.style.height = `${previewHeight}px`;
    }

    const thumbHeight = Math.min(Math.max(panelHeight * 0.12, 60), 96);
    panel.querySelectorAll<HTMLElement>(".resource-texture-thumb").forEach((thumb) => {
      thumb.style.height = `${thumbHeight}px`;
    });
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
      this.applyResourcePanelSizing(panel);
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
    const meshPath = draw.meshPath ?? "";
    const meshDir = dirname(meshPath);
    const candidate = joinPath(meshDir, textureFile);
    const direct = this.vfs.get(candidate) ? candidate : this.vfs.get(textureFile) ? textureFile : candidate;
    return direct ?? null;
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
      if (!filePath) return;
      const file = this.vfs.get(filePath);
      if (!file) return;
      if (file.type.startsWith("image/")) {
        img.src = URL.createObjectURL(file);
      } else {
        img.replaceWith(Object.assign(document.createElement("div"), {
          className: "resource-texture-thumb resource-texture-thumb--missing",
          textContent: "No image",
        }));
      }
    });

    this.viewport.appendChild(panel);
    this.syncResourcePanelPosition();
    this.applyResourcePanelSizing(panel);
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
    }
  }

  private setupObjectList(): void {
    this.objectList.addEventListener("scroll", () => {
      this.syncResourcePanelPosition();
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
