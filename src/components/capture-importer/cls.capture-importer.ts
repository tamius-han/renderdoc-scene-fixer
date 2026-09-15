import { collectFromDrop, collectFromInput, dirname, joinPath, VirtualFileSystem } from "../../filesystem";
import { loadManifests, type LoadedManifests } from "../../manifest";
import { UNIT_CONVERSION } from '../../util/const.unit-conversion';
import template from './cls.capture-importer.html?raw';
import { RenderPassList } from '../common/cmp.render-pass-list';
import { guessIntelGPAImportTargetFromFilename, guessIntelGPAImportTargetsFromFilenames, identifyIntelGPAImport } from './intel-gpa-import-helpers';
import type { IntelGPADropzone } from './intel-gpa-dropzone.type';
import { FileInfo } from '../../types/file-info.interface';

enum ImportType {
  Unknown = 0,
  RenderDocExport = 1,
  IntelGPAExportFull = 2,
  IntelGPAExportPartial = 3,
}

export class CaptureImporter extends HTMLElement {
  constructor() {
    super();
  }

  private dropzoneOuter!: HTMLElement;
  private dropzone!: HTMLElement;
  private folderInput!: HTMLInputElement;

  private importProcessingSection!: HTMLElement;

  private reconstructBtn: HTMLButtonElement;
  private recalculateCorrectionBtn: HTMLButtonElement;
  private resetCamBtn: HTMLButtonElement;
  private recenterCamBtn: HTMLButtonElement;
  private flyModeToggle: HTMLInputElement;
  private controlSchemeDropdown: HTMLSelectElement;
  private importFilterSlider: HTMLInputElement;
  private viewportFilterSlider: HTMLInputElement;
  private importFilterValue: HTMLInputElement;
  private viewportFilterValue: HTMLInputElement;
  private statusBar!: HTMLElement;
  private renderPassList!: RenderPassList;

  private intelGPADropzones!: {
    [key in IntelGPADropzone]: {
      dropzone: HTMLElement;
      input: HTMLInputElement;
    }
  }

  private intelGPAImports: { [key in IntelGPADropzone]: File | null } = {
    'landmark-source': null,
    'landmark-output': null,
    'scene': null
  }

  connectedCallback() {
    this.innerHTML = template;

    this.registerElements();
    this.setupEvents();
  }

  /**
   * Puts all relevant HTML elements into class properties for convenient access.
   */
  private registerElements() {
    this.dropzoneOuter = this.querySelector("#capture-importer-container") as HTMLElement;

    // individual dropzones and file inputs
    this.dropzone = this.querySelector("#capture-importer-dropzone") as HTMLElement;
    this.folderInput = this.querySelector("#capture-importer-folder-input") as HTMLInputElement;
    this.intelGPADropzones = {
      'landmark-source': {
        dropzone: this.querySelector("#capture-importer-landmark-source-obj") as HTMLElement,
        input: this.querySelector("#capture-importer-landmark-source-input") as HTMLInputElement,
      },
      'landmark-output': {
        dropzone: this.querySelector("#capture-importer-landmark-output-obj") as HTMLElement,
        input: this.querySelector("#capture-importer-landmark-output-input") as HTMLInputElement,
      },
      'scene': {
        dropzone: this.querySelector("#capture-importer-scene-obj") as HTMLElement,
        input: this.querySelector("#capture-importer-scene-input") as HTMLInputElement,
      }
    }

    this.importProcessingSection = this.querySelector("#capture-importer-import-processing-section") as HTMLElement;
    this.renderPassList = this.querySelector(".render-pass-list") as RenderPassList;

    this.statusBar = this.querySelector("#status-bar") as HTMLElement;

    this.reconstructBtn = this.querySelector("#capture-importer-reconstruct-btn") as HTMLButtonElement;
    this.recalculateCorrectionBtn = this.querySelector("#capture-importer-recalculate-correction-btn") as HTMLButtonElement;
    this.resetCamBtn = this.querySelector("#capture-importer-reset-cam-btn") as HTMLButtonElement;
    this.recenterCamBtn = this.querySelector("#recenter-camera-btn") as HTMLButtonElement;
    this.flyModeToggle = this.querySelector("#fly-mode-toggle") as HTMLInputElement;
    this.controlSchemeDropdown = this.querySelector("#control-scheme-dropdown") as HTMLSelectElement;
    this.importFilterSlider = this.querySelector("#capture-importer-import-filter-size-slider") as HTMLInputElement;
    this.viewportFilterSlider = this.querySelector("#object-filter-size-slider") as HTMLInputElement;
    this.importFilterValue = this.querySelector("#capture-importer-import-filter-size-value") as HTMLInputElement;
    this.viewportFilterValue = this.querySelector("#object-filter-size-value") as HTMLInputElement;

  }

  /**
   * Sets up event listeners for all relevant HTML elements.
   */
  private setupEvents() {
    this.setupDropzones();

    this.reconstructBtn.addEventListener("click", () => void this.reconstructScene());

    // this.recalculateCorrectionBtn.addEventListener("click", () => this.recalculateTransformCorrection());
    // this.resetCamBtn.addEventListener("click", () => this.sceneManager.frameOnScene());
    // this.recenterCamBtn.addEventListener("click", () => this.sceneManager.frameOnScene());
    // this.flyModeToggle.addEventListener("change", () => this.sceneManager.setFlying(this.flyModeToggle.checked));
    // this.controlSchemeDropdown.addEventListener("change", () => {
    //   const scheme = this.controlSchemeDropdown.value === "wasd" ? "wasd" : "esdf";
    //   this.sceneManager.setControlScheme(scheme);
    // });

    // // Both filter control pairs (import screen + post-reconstruct viewport
    // // menu) drive the same underlying value and stay in sync with each
    // // other - see setHidePercent().
    // for (const slider of [this.importFilterSlider, this.viewportFilterSlider]) {
    //   slider.addEventListener("input", () => this.setHidePercent(Number(slider.value)));
    // }
    // for (const text of [this.importFilterValue, this.viewportFilterValue]) {
    //   text.addEventListener("change", () => this.setHidePercent(Number(text.value)));
    // }

    // this.setupObjectList();
  }

  private setupDropzones() {
    // For the time being, we don't change classes when mouse hovers over global dropzone
    // this.dropzoneOuter.addEventListener("dragover", (e) => {
    //   e.preventDefault();
    //   this.dropzone.classList.add("drag");
    // });
    // this.dropzoneOuter.addEventListener("dragleave", () => this.dropzone.classList.remove("drag"));

    this.dropzoneOuter.addEventListener("drop", async (e) => {
      e.preventDefault();
      this.dropzone.classList.remove("drag");
      if (!e.dataTransfer) return;
      this.setStatus("[global dropzone] Reading dropped files ...");
      const entries = await collectFromDrop(e.dataTransfer);
      await this.handleFiles(entries);
    });
    this.dropzone.addEventListener("dragover", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.dropzone.classList.add("drag");
    });
    this.dropzone.addEventListener("dragleave", () => this.dropzone.classList.remove("drag"));
    this.dropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dropzone.classList.remove("drag");
      if (!e.dataTransfer) return;
      this.setStatus("[renderdoc dropzone] Reading dropped folder...");
      const entries = await collectFromDrop(e.dataTransfer);
      await this.handleFiles(entries);
    });

    for (const target in this.intelGPADropzones) {
      const dropzone = this.intelGPADropzones[target as IntelGPADropzone].dropzone;
      const input = this.intelGPADropzones[target as IntelGPADropzone].input;

      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add("drag");
      });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove("drag"));

      dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.dataTransfer) return;
        this.setStatus(`[intel GPA dropzone::${target}] Reading dropped folder...`);
        const entries = await collectFromDrop(e.dataTransfer);
        await this.handleFiles(entries, target as IntelGPADropzone);
      });

      input.addEventListener('change', async (e) => {
        const files = (e.target as HTMLInputElement).files;
        if (!files) return;
        this.setStatus(`[intel GPA folder input::${target}] Reading folder...`);
        await this.handleFiles(collectFromInput(files), target as IntelGPADropzone);
      });
    }
  }

  private async reconstructScene(): Promise<void> {
  // if (!this.loaded) return;
  //   const selected = this.getSelectedFolders();
  //   if (selected.length === 0) {
  //     // this.setStatus("Select at least one pass first.");
  //     return;
  //   }

  //   this.reconstructBtn.disabled = true;
  //   this.emptyHint.style.display = "none";
  //   this.hud.style.display = "block";
  //   // this.setStatus(`Reconstructing ${selected.length} pass(es): ${selected.join(", ")}`);

  //   try {
  //     this.clearSelectionVisuals();
  //     this.sceneManager.clear();
  //     // Full reload: previous draws/materials/textures are genuinely done
  //     // with now, unlike a filter-only rebuild (see rebuildVisibleScene)
  //     // which reuses all of this.
  //     for (const material of this.materialCache.values()) material.dispose();
  //     this.materialCache.clear();
  //     if (this.untexturedMaterial) {
  //       this.untexturedMaterial.dispose();
  //       this.untexturedMaterial = null;
  //     }
  //     this.textures.disposeAll();
  //     this.loadedDraws = [];
  //     this.objectList.innerHTML = "";
  //     this.selectedIndices.clear();
  //     this.hiddenDrawIndices.clear();
  //     this.manuallyHiddenIndices.clear();
  //     this.lastClickedIndex = null;

  //     let noMeshPathCount = 0;
  //     let meshNotFoundCount = 0;
  //     let exceptionCount = 0;
  //     let processed = 0;
  //     let loggedMissingManifest = false;
  //     let loggedMissingMesh = false;

  //     for (const folder of selected) {
  //       const manifest = this.loaded.passManifests[folder];
  //       if (!manifest) {
  //         if (!loggedMissingManifest) {
  //           console.error(
  //             `[reconstruct] No manifest data for pass "${folder}" - it either failed to load ` +
  //               `(check the warning when the folder was dropped) or was never fetched.`,
  //           );
  //           loggedMissingManifest = true;
  //         }
  //         continue;
  //       }
  //       const passDir = joinPath(this.loaded.rootPrefix, folder);

  //       for (const draw of manifest.draws) {
  //         processed++;
  //         try {
  //           const outcome = await this.loadDraw(draw, passDir);
  //           if (outcome === "no-mesh-path") {
  //             noMeshPathCount++;
  //           } else if (outcome === "mesh-not-found") {
  //             meshNotFoundCount++;
  //             if (!loggedMissingMesh) {
  //               const meshRel = draw.posedMesh ? draw.posedMesh : draw.mesh;
  //               console.error(
  //                 `[reconstruct] Mesh file not found for eid${draw.eventId}: tried "${joinPath(passDir, meshRel ?? "")}". ` +
  //                   `A few sample paths that WERE found: ${Array.from(this.vfs.keys()).slice(0, 8).join(", ")}`,
  //               );
  //               loggedMissingMesh = true;
  //             }
  //           } else {
  //             // Global index into loadedDraws (loadDraw() just pushed this
  //             // draw onto it) - NOT the per-pass manifest index, which
  //             // would collide across multiple selected passes since each
  //             // pass's manifest.draws restarts at 0.
  //             const globalIndex = this.loadedDraws.length - 1;
  //             const loadedDraw = this.loadedDraws[globalIndex];
  //             const stats = {
  //               vertices: Math.max(0, loadedDraw.geometryData.positions.length / 3),
  //               faces: Math.max(0, loadedDraw.geometryData.positions.length / 9),
  //               size: loadedDraw.diagonal,
  //             };
  //             this.objectList.appendChild(this.createDrawItem(draw, globalIndex, stats));
  //           }
  //         } catch (e) {
  //           exceptionCount++;
  //           console.error(`[reconstruct] Exception loading draw eid${draw.eventId}`, draw, e);
  //         }
  //         if (processed % 50 === 0) {
  //           this.setStatus(`Loading... ${processed} draw(s) processed, ${this.loadedDraws.length} loaded so far`);
  //           await new Promise((resolve) => setTimeout(resolve, 0));
  //         }
  //       }
  //     }

  //     // Normalization scale is computed ONCE here, from every loaded draw
  //     // regardless of the size filter, and then held fixed - see
  //     // computeNormalizationScale() and rebuildVisibleScene().
  //     this.fixedScale = 1;
  //     if (this.loadedDraws.length > 0) {
  //       let overall: Bounds = this.loadedDraws[0].bounds;
  //       for (let i = 1; i < this.loadedDraws.length; i++) overall = unionBounds(overall, this.loadedDraws[i].bounds);
  //       const size = overall.max.clone().sub(overall.min);
  //       const maxDim = Math.max(size.x, size.y, size.z);
  //       this.fixedScale = computeNormalizationScale(maxDim);
  //       console.log("[reconstruct] scene bounds", { min: overall.min, max: overall.max, size, scale: this.fixedScale });
  //     }

  //     const problems: string[] = [];
  //     if (meshNotFoundCount) problems.push(`${meshNotFoundCount} mesh file(s) not found`);
  //     if (exceptionCount) problems.push(`${exceptionCount} threw an error`);
  //     if (noMeshPathCount) problems.push(`${noMeshPathCount} had no mesh path in the manifest`);
  //     this.lastProblemNote = problems.length ? ` \u2014 PROBLEMS: ${problems.join(", ")} (see console)` : "";

  //     this.rebuildVisibleScene();
  //   } catch (e) {
  //     console.error("[reconstruct] Reconstruction failed", e);
  //     this.setStatus(`Reconstruct failed: ${e instanceof Error ? e.message : String(e)} (see console for details)`);
  //   } finally {
  //     this.reconstructBtn.disabled = false;
  //   }
  }

  private setStatus(message: string): void {
    this.statusBar.textContent = message;
  }

  /**
   * Determines if files dropped into the input field represent an export
   * made with RenderDoc Scene Exporter addon
   * @param entries The list of file entries to check
   * @returns A promise that resolves to true if the entries represent a RenderDoc export, false otherwise
   */
  private async isRenderDocExport(entries: FileInfo[]): Promise<boolean> {
    let root = `${entries[0].path.split('/')[0]}/`;
    let hasManifest = false; let hasPass = false;

    if (root === "manifest.json") {
      hasManifest = true;
      root = '';
    }
    if (root.startsWith('pass_')) {
      hasPass = true;
      root = '';
    }

    const manifestPath = `${root}manifest.json`;
    const passPath = `${root}pass_`;

    if (!hasPass) {
      for (const e of entries) {
        if (e.path.startsWith(passPath)) {
          hasPass = true;
          break;
        }
      }
    }
    if (!hasManifest) {
      for (const e of entries) {
        if (e.path === manifestPath) {
          hasManifest = true;
          break;
        }
      }
    }

    return hasManifest && hasPass;
  }

  /**
   * Identifies what kind of import the dropped files represent
   * @param entries The list of file entries to check
   * @returns A promise that resolves to the identified import type
   */
  private async identifyImportType(entries: FileInfo[]): Promise<ImportType> {
    if (await this.isRenderDocExport(entries)) {
      return ImportType.RenderDocExport;
    }

    // if there's three files, and if all three files are .obj, then
    // we assume it's full IntelGPADropzone import
    if (entries.length === 3 && entries.every(e => e.path.endsWith('.obj'))) {
      return ImportType.IntelGPAExportFull;
    }

    if (entries.length === 1 && entries[0].path.endsWith('.obj')) {
      return ImportType.IntelGPAExportPartial;
    }

    return ImportType.Unknown;
  }

  /**
   * Updates
   * @param dropzone
   * @param file
   */
  private updateIntelGPADropzone(dropzone: IntelGPADropzone, file: File) {
    this.intelGPADropzones[dropzone].dropzone.innerHTML = file.name;
    this.intelGPADropzones[dropzone].dropzone.classList.add('has-file');
  }

  /**
   *
   */
  private async processIntelGPAImport() {
    // bail out unless all files are present
    for (const importTarget in this.intelGPAImports) {
      if (!this.intelGPAImports[importTarget]) {
        return;
      }
    }

    const fileRoles = await identifyIntelGPAImport(
      this.intelGPAImports['landmark-source']!,
      this.intelGPAImports['landmark-output']!,
      this.intelGPAImports['scene']!
    );

    if (!fileRoles) {
      // TODO: throw an error or something
      return;
    }

    alert('TODO: implement loading');
  }

  private async handleFiles(entries: FileInfo[], target?: IntelGPADropzone | 'renderdoc-export'): Promise<void> {
    console.log('handling files', entries, target);

    if (entries.length === 0) {
      return;
    }

    const importType = await this.identifyImportType(entries);

    if (importType === ImportType.Unknown) {
      this.setStatus("Unknown import type");
      return;
    }

    if (importType === ImportType.IntelGPAExportPartial) {
      if (target && target !== 'renderdoc-export') {
        this.intelGPAImports[target] = entries[0].file;
        this.updateIntelGPADropzone(target as IntelGPADropzone, entries[0].file);
      } else {
        const guessedTarget = guessIntelGPAImportTargetFromFilename(entries[0]);
        if (guessedTarget) {
          this.intelGPAImports[guessedTarget] = entries[0].file;
          this.updateIntelGPADropzone(guessedTarget as IntelGPADropzone, entries[0].file);
        }
      }
      this.processIntelGPAImport();
      return;
    }

    if (importType === ImportType.IntelGPAExportFull) {
      const guessedTargets = guessIntelGPAImportTargetsFromFilenames(entries);
      for (const key in guessedTargets) {
        this.intelGPAImports[key] = guessedTargets[key];
        this.updateIntelGPADropzone(key as IntelGPADropzone, guessedTargets[key].file);
      }
      this.processIntelGPAImport();
      return;
    }


    const vfs = new VirtualFileSystem();
    for (const { path, file } of entries) vfs.set(path, file);

    const loaded = await loadManifests(vfs);
    if (!loaded) {
      this.setStatus("No manifest.json found in the dropped folder - is this a SceneExporter export?");
      return;
    }

    this.renderPassList.manifests = loaded;
    this.importProcessingSection.style.display = "block";

    // this.loaded = loaded;
    // this.renderPassList();
    const failedNote = loaded.failedPassFolders.length
      ? ` (WARNING: ${loaded.failedPassFolders.length} pass manifest(s) failed to load - see console)`
      : "";
    this.setStatus(`Loaded manifest: ${loaded.root.passes.length} pass(es) found.${failedNote}`);
  }
}
