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
  key: string;
  material: THREE.Material;
  geometryData: GeometryArrays;
  bounds: Bounds;
  diagonal: number;
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

  private importFilterSlider = this.el<HTMLInputElement>("import-filter-size-slider");
  private importFilterValue = this.el<HTMLInputElement>("import-filter-size-value");
  private viewportFilterSlider = this.el<HTMLInputElement>("object-filter-size-slider");
  private viewportFilterValue = this.el<HTMLInputElement>("object-filter-size-value");

  private flyModeToggle = this.el<HTMLInputElement>("fly-mode-toggle");
  private flyModeLabel = this.el("fly-mode-label");
  private flySpeedIndicator = this.el("fly-speed-indicator");

  private objectList = this.el<HTMLDivElement>("object-list");

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
    if (!meshRel) return "no-mesh-path";

    const objPath = joinPath(passDir, meshRel);
    const objText = await this.vfs.readText(objPath);
    if (!objText) return "mesh-not-found";

    const obj = parseOBJ(objText);
    const geometryData = objToGeometryArrays(obj);
    const bounds = computeBounds(geometryData.positions);
    const { key, material } = await this.resolveMaterial(objPath, obj.mtllib, obj.usemtl);

    this.loadedDraws.push({ key, material, geometryData, bounds, diagonal: boundsDiagonal(bounds) });

    return "added";
  }

  private getVisibilityStatus(draw: DrawEntry) {

  }

  private createDrawItem(draw: DrawEntry, drawIndex: number) {
    const div = document.createElement('div');
    div.innerHTML = `
      <div>
        <b>Draw #${drawIndex}</b>
        &nbsp; &nbsp; vis: <button class="check-like" data-action="visibility" data-index="${drawIndex}> </button>
        %nbsp; sel: <button class="check-like" data-action="selection" data-index="${drawIndex}>[ ]</button>
        &nbsp; is ref: <button class="check-like" data-action="landmark" data-index="${drawIndex}"> </button>
        <small>v: f: size: </small> &nbsp; <button data-action="resources" data-index="${drawIndex}">res</button>
      </div>
    `;

    return div;
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

        for (const [index, draw] of manifest.draws.entries()) {
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
              this.objectList.appendChild(this.createDrawItem(draw, index));
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

  /** Rebuilds the rendered scene from this.loadedDraws according to the
   * current "hide largest %" filter, WITHOUT re-reading or re-parsing any
   * files - this is what makes dragging the filter slider instant. Hidden
   * objects were already counted in this.fixedScale (computed once from
   * every loaded draw in reconstructScene()) but are excluded here, so
   * frameOnScene() - which measures whatever's actually in the scene -
   * naturally only frames the camera on what's currently visible. */
  private rebuildVisibleScene(): void {
    if (this.loadedDraws.length === 0) return;

    // "Hide largest % of objects" = hide that fraction of objects BY COUNT,
    // ranked by size (bounding-box diagonal) - the simplest, most
    // predictable reading of a 0-100% slider.
    const sorted = [...this.loadedDraws].sort((a, b) => b.diagonal - a.diagonal);
    const hideCount = Math.round((this.hidePercent / 100) * sorted.length);
    const hidden = new Set(sorted.slice(0, hideCount));

    const builder = new SceneMeshBuilder();
    for (const draw of this.loadedDraws) {
      if (hidden.has(draw)) continue;
      builder.addDraw(draw.key, draw.material, draw.geometryData);
    }
    const meshes = builder.buildAll();

    this.sceneManager.clear();
    this.sceneManager.addContent(meshes, this.fixedScale);
    this.sceneManager.frameOnScene();

    const visibleCount = this.loadedDraws.length - hidden.size;
    const triCount = Math.round(builder.totalVertexCount / 3);

    this.setStatus(
      `${visibleCount}/${this.loadedDraws.length} object(s) shown (${this.hidePercent}% of largest hidden) \u00b7 ` +
        `${meshes.length} mesh(es) \u00b7 ~${triCount.toLocaleString()} triangles${this.lastProblemNote}`,
    );
    this.hud.textContent =
      `${visibleCount}/${this.loadedDraws.length} objects \u00b7 ${meshes.length} draw calls \u00b7 ` +
      `${triCount.toLocaleString()} tris \u00b7 scale \u00d7${this.fixedScale.toExponential(2)} \u00b7 MMB drag to orbit, Shift+MMB to pan, scroll to zoom, A for fly mode`;
  }

  toggleDrawVisibility(index) {
    this.manifest.dra
  }

  toggleDrawSelection(index) {

  }

  setLandmark(index) {

  }

  showResources(index) {

  }

  setupObjectList() {
    const objectList = document.getElementById('object-list')!;

    objectList.addEventListener('click', (event) => {
      const target = event.target;

      if (!(target instanceof HTMLButtonElement)) {
        return;
      }

      const action = target.dataset.action;
      const index = Number(target.dataset.index);

      if (!Number.isInteger(index)) {
        return;
      }

      switch (action) {
        case 'visibility':
          this.toggleDrawVisibility(index);
          break;

        case 'selection':
          this.toggleDrawSelection(index);
          break;

        case 'landmark':
          this.setLandmark(index);
          break;

        case 'resources':
          this.showResources(index);
          break;
      }
    });
  }
}
