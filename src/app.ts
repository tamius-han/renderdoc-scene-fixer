import * as THREE from "three";
import { collectFromDrop, collectFromInput, dirname, joinPath, VirtualFileSystem } from "./filesystem";
import { loadManifests, type LoadedManifests } from "./manifest";
import { parseMTL } from "./parsers/mtl";
import { parseOBJ } from "./parsers/obj";
import { objToGeometryArrays, SceneMeshBuilder } from "./scene/mesh-builder";
import { SceneManager } from "./scene/scene-manager";
import { TextureManager } from "./scene/texture-manager";
import type { DrawEntry, PassIndexEntry } from "./types";

export class SceneViewerApp {
  private vfs = new VirtualFileSystem();
  private loaded: LoadedManifests | null = null;
  private textures = new TextureManager();
  private sceneManager: SceneManager;

  private materialCache = new Map<string, THREE.Material>();
  private untexturedMaterial: THREE.Material | null = null;

  private dropzone = this.el("dropzone");
  private folderInput = this.el<HTMLInputElement>("folder-input");
  private passSection = this.el("pass-section");
  private passList = this.el("pass-list");
  private posedToggle = this.el<HTMLInputElement>("posed-toggle");
  private poseWarning = this.el("pose-warning");
  private reconstructBtn = this.el<HTMLButtonElement>("reconstruct-btn");
  private resetCamBtn = this.el("reset-cam-btn");
  private statusBar = this.el("status-bar");
  private emptyHint = this.el("empty-hint");
  private hud = this.el("hud");

  constructor(viewportEl: HTMLElement) {
    this.sceneManager = new SceneManager(viewportEl);
    this.sceneManager.onContextLoss((lost) => {
      if (lost) {
        this.setStatus(
          "WebGL context lost - the scene is likely too large for available GPU memory. Try selecting fewer passes.",
        );
      }
    });
    this.wireEvents();
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
    this.posedToggle.addEventListener("change", () => this.updatePoseWarning());
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
    const usePosed = this.posedToggle.checked;
    const anyPosed = selected.some((f) => (this.loaded!.passManifests[f]?.draws ?? []).some((d) => d.posedMesh));

    if (!usePosed) {
      this.showWarning(
        "Bind-pose mode: meshes have no world transform applied and will pile up near the origin, not laid out as a scene. Turn on \u201cUse posed meshes\u201d for spatial reconstruction.",
      );
    } else if (!anyPosed) {
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

  private async addDrawToBuilder(
    builder: SceneMeshBuilder,
    draw: DrawEntry,
    passDir: string,
    usePosed: boolean,
  ): Promise<"added" | "no-mesh-path" | "mesh-not-found"> {
    const meshRel = usePosed && draw.posedMesh ? draw.posedMesh : draw.mesh;
    if (!meshRel) return "no-mesh-path";

    const objPath = joinPath(passDir, meshRel);
    const objText = await this.vfs.readText(objPath);
    if (!objText) return "mesh-not-found";

    const obj = parseOBJ(objText);
    const geometryData = objToGeometryArrays(obj);
    const { key, material } = await this.resolveMaterial(objPath, obj.mtllib, obj.usemtl);
    builder.addDraw(key, material, geometryData);
    return "added";
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
      this.materialCache.clear();
      this.untexturedMaterial = null;
      this.textures.disposeAll();

      const usePosed = this.posedToggle.checked;
      const builder = new SceneMeshBuilder();
      let addedCount = 0;
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
            const outcome = await this.addDrawToBuilder(builder, draw, passDir, usePosed);
            if (outcome === "added") addedCount++;
            else if (outcome === "no-mesh-path") noMeshPathCount++;
            else {
              meshNotFoundCount++;
              if (!loggedMissingMesh) {
                const meshRel = usePosed && draw.posedMesh ? draw.posedMesh : draw.mesh;
                console.error(
                  `[reconstruct] Mesh file not found for eid${draw.eventId}: tried "${joinPath(passDir, meshRel ?? "")}". ` +
                    `A few sample paths that WERE found: ${Array.from(this.vfs.keys()).slice(0, 8).join(", ")}`,
                );
                loggedMissingMesh = true;
              }
            }
          } catch (e) {
            exceptionCount++;
            console.error(`[reconstruct] Exception loading draw eid${draw.eventId}`, draw, e);
          }
          if (processed % 50 === 0) {
            this.setStatus(`Loading... ${processed} draw(s) processed, ${builder.groupCount} material group(s) so far`);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }

      const meshes = builder.buildAll();
      for (const mesh of meshes) this.sceneManager.scene.add(mesh);
      this.sceneManager.frameOnScene();

      const triCount = Math.round(builder.totalVertexCount / 3);
      const problems: string[] = [];
      if (meshNotFoundCount) problems.push(`${meshNotFoundCount} mesh file(s) not found`);
      if (exceptionCount) problems.push(`${exceptionCount} threw an error`);
      if (noMeshPathCount) problems.push(`${noMeshPathCount} had no mesh path in the manifest`);
      const problemNote = problems.length ? ` \u2014 PROBLEMS: ${problems.join(", ")} (see console)` : "";

      this.setStatus(
        `${addedCount}/${processed} draw(s) merged into ${meshes.length} mesh(es) \u00b7 ~${triCount.toLocaleString()} triangles${problemNote}`,
      );
      this.hud.textContent = `${meshes.length} draw calls \u00b7 ${triCount.toLocaleString()} tris \u00b7 drag to orbit \u00b7 scroll to zoom`;
    } catch (e) {
      console.error("[reconstruct] Reconstruction failed", e);
      this.setStatus(`Reconstruct failed: ${e instanceof Error ? e.message : String(e)} (see console for details)`);
    } finally {
      this.reconstructBtn.disabled = false;
    }
  }
}
