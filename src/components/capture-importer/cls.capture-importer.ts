import { collectFromDrop, collectFromInput, dirname, joinPath, VirtualFileSystem } from "../../filesystem";
import { fakeManifest, loadManifests, type LoadedManifests } from "../../manifest";
import { UNIT_CONVERSION } from '../../util/const.unit-conversion';
import template from './cls.capture-importer.html?raw';
import { RenderPassList } from '../common/cmp.render-pass-list';
import { guessIntelGPAImportTargetFromFilename, guessIntelGPAImportTargetsFromFilenames, identifyIntelGPAImport } from './intel-gpa-import-helpers';
import type { IntelGPADropzone } from './intel-gpa-dropzone.type';
import { FileInfo } from '../../types/file-info.interface';
import { Config } from '../../config/cls.config';

enum ImportType {
  Unknown = 0,
  RenderDocExport = 1,
  IntelGPAExportFull = 2,
  IntelGPAExportPartial = 3,
}

export class CaptureImporter extends HTMLElement {

  private appConfig: Config;

  constructor() {
    super();

    this.appConfig = Config.getConfig();
    this.elements = ({} as any);
  }

  private elements: {
    dropzoneOuter: HTMLElement;
    dropzone: HTMLElement;
    folderInput: HTMLInputElement;

    importProcessingSection: HTMLElement;

    // import options
    captureUnitUnit: HTMLSelectElement;
    captureUnitSize: HTMLInputElement;
    importSizeFilterSlider: HTMLInputElement;
    importSizeFilterInput: HTMLInputElement;
    enforceMaxSceneSizeCheckbox: HTMLInputElement;
    maxSceneSizeInput: HTMLInputElement;
    enforceInitialScaleLimitCheckbox: HTMLInputElement;
    initialScaleLimitInput: HTMLInputElement;


    reconstructBtn: HTMLButtonElement;
    recalculateCorrectionBtn: HTMLButtonElement;
    resetCamBtn: HTMLButtonElement;
    recenterCamBtn: HTMLButtonElement;
    flyModeToggle: HTMLInputElement;
    controlSchemeDropdown: HTMLSelectElement;
    importFilterSlider: HTMLInputElement;
    viewportFilterSlider: HTMLInputElement;
    importFilterValue: HTMLInputElement;
    viewportFilterValue: HTMLInputElement;
    statusBar: HTMLElement;
    renderPassList: RenderPassList;
  };

  // private dropzoneOuter!: HTMLElement;
  // private dropzone!: HTMLElement;
  // private folderInput!: HTMLInputElement;

  // private importProcessingSection!: HTMLElement;

  // private reconstructBtn: HTMLButtonElement;
  // private recalculateCorrectionBtn: HTMLButtonElement;
  // private resetCamBtn: HTMLButtonElement;
  // private recenterCamBtn: HTMLButtonElement;
  // private flyModeToggle: HTMLInputElement;
  // private controlSchemeDropdown: HTMLSelectElement;
  // private importFilterSlider: HTMLInputElement;
  // private viewportFilterSlider: HTMLInputElement;
  // private importFilterValue: HTMLInputElement;
  // private viewportFilterValue: HTMLInputElement;
  // private statusBar!: HTMLElement;
  // private renderPassList!: RenderPassList;

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
    this.elements.dropzoneOuter = this.querySelector("#capture-importer-container") as HTMLElement;

    // individual dropzones and file inputs
    this.elements.dropzone = this.querySelector("#capture-importer-dropzone") as HTMLElement;
    this.elements.folderInput = this.querySelector("#capture-importer-folder-input") as HTMLInputElement;
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

    this.elements.importProcessingSection = this.querySelector("#capture-importer-import-processing-section") as HTMLElement;
    this.elements.renderPassList = this.querySelector(".render-pass-list") as RenderPassList;

    this.elements.statusBar = this.querySelector("#status-bar") as HTMLElement;

    // import options
    this.elements.captureUnitUnit = this.querySelector("#capture-importer-capture-unit-unit") as HTMLSelectElement;
    this.elements.captureUnitSize = this.querySelector("#capture-importer-capture-unit-size") as HTMLInputElement;
    this.elements.importSizeFilterSlider = this.querySelector("#capture-importer-import-size-filter-slider") as HTMLInputElement;
    this.elements.importSizeFilterInput = this.querySelector("#capture-importer-import-size-filter-value") as HTMLInputElement;
    this.elements.maxSceneSizeInput = this.querySelector("#capture-importer-max-scene-size") as HTMLInputElement;
    this.elements.enforceInitialScaleLimitCheckbox = this.querySelector("#capture-importer-enforce-initial-scale-limit") as HTMLInputElement;
    this.elements.initialScaleLimitInput = this.querySelector("#capture-importer-initial-scale-limit") as HTMLInputElement;


    // this.elements.reconstructBtn = this.querySelector("#capture-importer-reconstruct-btn") as HTMLButtonElement;
    // this.elements.recalculateCorrectionBtn = this.querySelector("#capture-importer-recalculate-correction-btn") as HTMLButtonElement;
    // this.elements.resetCamBtn = this.querySelector("#capture-importer-reset-cam-btn") as HTMLButtonElement;
    // this.elements.recenterCamBtn = this.querySelector("#recenter-camera-btn") as HTMLButtonElement;
    // this.elements.flyModeToggle = this.querySelector("#fly-mode-toggle") as HTMLInputElement;
    // this.elements.controlSchemeDropdown = this.querySelector("#control-scheme-dropdown") as HTMLSelectElement;
    // this.elements.importFilterSlider = this.querySelector("#capture-importer-import-filter-size-slider") as HTMLInputElement;
    // this.elements.viewportFilterSlider = this.querySelector("#object-filter-size-slider") as HTMLInputElement;
    // this.elements.importFilterValue = this.querySelector("#capture-importer-import-filter-size-value") as HTMLInputElement;
    // this.elements.viewportFilterValue = this.querySelector("#object-filter-size-value") as HTMLInputElement;

  }

  /**
   * Sets up event listeners for all relevant HTML elements.
   */
  private setupEvents() {
    this.setupDropzones();
    this.setupImportOptionsUI();

    this.elements.reconstructBtn.addEventListener("click", () => void this.reconstructScene());

    // this.elements.recalculateCorrectionBtn.addEventListener("click", () => this.recalculateTransformCorrection());
    // this.elements.resetCamBtn.addEventListener("click", () => this.sceneManager.frameOnScene());
    // this.elements.recenterCamBtn.addEventListener("click", () => this.sceneManager.frameOnScene());
    // this.elements.flyModeToggle.addEventListener("change", () => this.sceneManager.setFlying(this.elements.flyModeToggle.checked));
    // this.elements.controlSchemeDropdown.addEventListener("change", () => {
    //   const scheme = this.elements.controlSchemeDropdown.value === "wasd" ? "wasd" : "esdf";
    //   this.sceneManager.setControlScheme(scheme);
    // });

    // // Both filter control pairs (import screen + post-reconstruct viewport
    // // menu) drive the same underlying value and stay in sync with each
    // // other - see setHidePercent().


    // this.setupObjectList();
  }

  private setupDropzones() {
    // For the time being, we don't change classes when mouse hovers over global dropzone
    // this.elements.dropzoneOuter.addEventListener("dragover", (e) => {
    //   e.preventDefault();
    //   this.elements.dropzone.classList.add("drag");
    // });
    // this.elements.dropzoneOuter.addEventListener("dragleave", () => this.elements.dropzone.classList.remove("drag"));

    this.elements.dropzoneOuter.addEventListener("drop", async (e) => {
      e.preventDefault();
      this.elements.dropzone.classList.remove("drag");
      if (!e.dataTransfer) return;
      this.setStatus("[global dropzone] Reading dropped files ...");
      const entries = await collectFromDrop(e.dataTransfer);
      await this.handleFiles(entries);
    });
    this.elements.dropzone.addEventListener("dragover", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.elements.dropzone.classList.add("drag");
    });
    this.elements.dropzone.addEventListener("dragleave", () => this.elements.dropzone.classList.remove("drag"));
    this.elements.dropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.elements.dropzone.classList.remove("drag");
      if (!e.dataTransfer) return;
      this.setStatus("[renderdoc dropzone] Reading dropped folder...");
      const entries = await collectFromDrop(e.dataTransfer);
      await this.handleFiles(entries);
    });
    this.elements.dropzone.addEventListener("click", () => this.elements.folderInput.click());
    this.elements.folderInput.addEventListener("change", async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      this.setStatus("[renderdoc folder input] Reading folder...");
      await this.handleFiles(collectFromInput(files));
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

      dropzone.addEventListener('click', () => input.click());

      input.addEventListener('change', async (e) => {
        const files = (e.target as HTMLInputElement).files;
        if (!files) return;
        this.setStatus(`[intel GPA folder input::${target}] Reading folder...`);
        await this.handleFiles(collectFromInput(files), target as IntelGPADropzone);
      });
    }
  }

  private setupImportOptionsUI() {
    // load initial values
    this.elements.captureUnitSize.value = this.appConfig.config.importOptions.captureUnitSize as any;
    this.elements.captureUnitUnit.value = this.appConfig.config.importOptions.captureUnitUnit;

    this.elements.importSizeFilterSlider.value = this.appConfig.config.objectFiltering.hideLargestObjectsPercent as any;
    this.elements.importSizeFilterInput.value = this.appConfig.config.objectFiltering.hideLargestObjectsPercent as any;

    this.elements.maxSceneSizeInput.value = this.appConfig.config.importOptions.maxSceneSize as any;
    this.elements.enforceMaxSceneSizeCheckbox.checked = this.appConfig.config.importOptions.forceMaxSceneSize;
    this.elements.enforceInitialScaleLimitCheckbox.checked = this.appConfig.config.importOptions.forceInitialScaleLimit;
    this.elements.initialScaleLimitInput.value = this.appConfig.config.importOptions.initialScaleLimit as any;

    // disable appropriate fields
    {
      if (!this.elements.enforceMaxSceneSizeCheckbox.checked) {
        this.elements.maxSceneSizeInput.classList.add("disabled");
      } else {
        this.elements.maxSceneSizeInput.classList.remove("disabled");
      }

      if (!this.elements.enforceInitialScaleLimitCheckbox.checked) {
        this.elements.initialScaleLimitInput.classList.add("disabled");
      } else {
        this.elements.initialScaleLimitInput.classList.remove("disabled");
      }
    }

    // setup event listeners
    {
      this.elements.captureUnitSize.addEventListener("change", () => {
        this.appConfig.config.importOptions.captureUnitSize = Number(this.elements.captureUnitSize.value);
      });
      this.elements.captureUnitUnit.addEventListener("change", () => {
        this.appConfig.config.importOptions.captureUnitUnit = this.elements.captureUnitUnit.value;
      });
      this.elements.importSizeFilterSlider.addEventListener("input", () => {
        this.appConfig.config.objectFiltering.hideLargestObjectsPercent = Number(this.elements.importSizeFilterSlider.value);
        this.elements.importSizeFilterInput.value = this.elements.importSizeFilterSlider.value;
      });
      this.elements.importSizeFilterInput.addEventListener("change", () => {
        this.appConfig.config.objectFiltering.hideLargestObjectsPercent = Number(this.elements.importSizeFilterInput.value);
        this.elements.importSizeFilterSlider.value = this.elements.importSizeFilterInput.value;
      });
      this.elements.enforceMaxSceneSizeCheckbox.addEventListener("change", () => {
        this.appConfig.config.importOptions.forceMaxSceneSize = this.elements.enforceMaxSceneSizeCheckbox.checked;
        if (!this.elements.enforceMaxSceneSizeCheckbox.checked) {
          this.elements.maxSceneSizeInput.classList.add("disabled");
        } else {
          this.elements.maxSceneSizeInput.classList.remove("disabled");
        }
      });
      this.elements.maxSceneSizeInput.addEventListener("change", () => {
        this.appConfig.config.importOptions.maxSceneSize = Number(this.elements.maxSceneSizeInput.value);
      });
      this.elements.enforceInitialScaleLimitCheckbox.addEventListener("change", () => {
        this.appConfig.config.importOptions.forceInitialScaleLimit = this.elements.enforceInitialScaleLimitCheckbox.checked;
        if (!this.elements.enforceInitialScaleLimitCheckbox.checked) {
          this.elements.initialScaleLimitInput.classList.add("disabled");
        } else {
          this.elements.initialScaleLimitInput.classList.remove("disabled");
        }
      });
      this.elements.initialScaleLimitInput.addEventListener("change", () => {
        this.appConfig.config.importOptions.initialScaleLimit = Number(this.elements.initialScaleLimitInput.value);
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
    this.elements.statusBar.textContent = message;
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
   * Highlights the relevant Intel GPA dropzone segments and updates it to show the file name
   * @param dropzone
   * @param file
   */
  private updateIntelGPADropzone(dropzone: IntelGPADropzone, file: File) {
    const type = dropzone.split('.')[0].replace('-', ' ');

    this.intelGPADropzones[dropzone].dropzone.innerHTML = `<span class="text-warm-500">${type}:</span> ${file.name}`;
    this.intelGPADropzones[dropzone].dropzone.classList.add('has-file');
  }

  /**
   * Resets the relevant Intel GPA dropzone segment to its initial state
   * @param dropzone
   */
  private resetIntelGPADropzone(dropzone: IntelGPADropzone) {
    this.intelGPADropzones[dropzone].dropzone.innerHTML = `<div>Drop your <strong>${dropzone}.obj</strong> here</div>`;
    this.intelGPADropzones[dropzone].dropzone.classList.remove('has-file', 'drag');
    this.intelGPAImports[dropzone] = null;
  }

  /**
   * Processes the Intel GPA import once all required files are present
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

    const loaded = await fakeManifest(this.intelGPAImports['scene']!);

    if (!loaded) {
      this.setStatus("No manifest.json found in the dropped folder - is this a SceneExporter export?");
      return;
    }

    this.elements.renderPassList.manifests = loaded.manifests;
    this.elements.importProcessingSection.style.display = "block";

    // reset all dropzones on successful import
    for (const dropzone in this.intelGPADropzones) {
      this.resetIntelGPADropzone(dropzone as IntelGPADropzone);
    }
  }

  /**
   * Handles dropped files and builds render pass list
   * @param entries
   * @param target
   * @returns
   */
  private async handleFiles(entries: FileInfo[], target?: IntelGPADropzone | 'renderdoc-export'): Promise<void> {
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

    // if we came this far, this should be a Renderdoc Scene Exporter folder.
    const vfs = new VirtualFileSystem();
    for (const { path, file } of entries) vfs.set(path, file);

    const loaded = await loadManifests(vfs);
    if (!loaded) {
      this.setStatus("No manifest.json found in the dropped folder - is this a SceneExporter export?");
      return;
    }

    console.log("Loaded manifests:", loaded);

    this.elements.renderPassList.manifests = loaded;
    this.elements.importProcessingSection.style.display = "block";

    // this.loaded = loaded;
    // this.elements.renderPassList();
    const failedNote = loaded.failedPassFolders.length
      ? ` (WARNING: ${loaded.failedPassFolders.length} pass manifest(s) failed to load - see console)`
      : "";
    this.setStatus(`Loaded manifest: ${loaded.root.passes.length} pass(es) found.${failedNote}`);

    for (const dropzone in this.intelGPADropzones) {
      this.resetIntelGPADropzone(dropzone as IntelGPADropzone);
    }
  }
}
