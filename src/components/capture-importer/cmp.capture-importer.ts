import { UNITS } from '../../util/const.unit-conversion';
import { fakeManifest, loadManifests } from "../../manifest";
import template from './cmp.capture-importer.html?raw';
import { RenderPassList } from '../common/render-pass/cmp.render-pass-list';
import { guessIntelGPAImportTargetFromFilename, guessIntelGPAImportTargetsFromFilenames, identifyIntelGPAImport } from './intel-gpa-import-helpers';
import type { IntelGPADropzone } from './intel-gpa-dropzone.type';
import { FileInfo } from '../../types/file-info.interface';
import { Config } from '../../config/cls.config';
import { collectFromDrop, VirtualFileSystem } from '../../filesystem';
import type { AffineDistortionResult } from '../../mesh-tools/calculator';

enum ImportType {
  Unknown = 0,
  RenderDocExport = 1,
  IntelGPAExportFull = 2,
  IntelGPAExportPartial = 3,
}

export class CaptureImporter extends HTMLElement {

  private appConfig: Config;
  private vfs!: VirtualFileSystem;
  /** Set once processIntelGPAImport() successfully matches a
   * landmark-source.obj/landmark-output.obj pair (see
   * intel-gpa-import-helpers.ts) - carried through to reconstructScene()'s
   * event detail so the main app can auto-apply it instead of requiring
   * the user to mark a scale-reference object and click "Fix distortion"
   * themselves. Cleared on a plain RenderDoc-only import (see
   * handleFiles()) so a stale value from an earlier import attempt in the
   * same session can't leak into an unrelated one. */
  private intelGpaDistortion: AffineDistortionResult | null = null;

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


  constructor() {
    super();

    this.appConfig = Config.getConfig();
    this.elements = ({} as any);
  }

  private intelGPADropzones!: {
    [key in IntelGPADropzone]: {
      dropzone: HTMLElement;
      input: HTMLInputElement;
    }
  }

  private intelGPAImports: { [key in IntelGPADropzone]: FileInfo | null } = {
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
    this.elements.enforceMaxSceneSizeCheckbox = this.querySelector("#capture-importer-enforce-max-scene-size") as HTMLInputElement;
    this.elements.maxSceneSizeInput = this.querySelector("#capture-importer-max-scene-size") as HTMLInputElement;
    this.elements.enforceInitialScaleLimitCheckbox = this.querySelector("#capture-importer-enforce-initial-scale-limit") as HTMLInputElement;
    this.elements.initialScaleLimitInput = this.querySelector("#capture-importer-initial-scale-limit") as HTMLInputElement;

    // reconstruct button
    this.elements.reconstructBtn = this.querySelector("#capture-importer-reconstruct-btn") as HTMLButtonElement;
  }

  /**
   * Sets up event listeners for all relevant HTML elements.
   */
  private setupEvents() {
    this.setupDropzones();
    this.buildImportUnitDropdown();
    this.setupImportOptionsUI();

    this.elements.reconstructBtn.addEventListener("click", () => this.reconstructScene());
    this.elements.renderPassList.addEventListener("selection-changed", () => {
      this.elements.reconstructBtn.classList.toggle(
        'disabled',
        !this.elements.renderPassList.manifests.root.passes.some(p => this.elements.renderPassList.manifests.passManifests[p.folder]?.markedForRender)
      )
    });
  }

  /**
   * Sets up handlers for drag-and-drop target zones.
   */
  private setupDropzones() {
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

  private buildImportUnitDropdown() {
    this.elements.captureUnitUnit.innerHTML = "";
    for (const unit of UNITS) {
      const option = document.createElement("option");
      option.value = unit;
      option.textContent = unit;
      this.elements.captureUnitUnit.appendChild(option);
    }
  }

  /**
   * Sets up the import options form.
   */
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

  /**
   * Emits reconstruct-scene event.
   * Reconstructing scene should be done in the main app, not in this component.
   */
  private async reconstructScene(): Promise<void> {
    this.appConfig.saveConfig();
    console.log('manifest:', this.elements.renderPassList.manifests);
    this.dispatchEvent(
      new CustomEvent(
        'reconstruct-scene',
        {
          detail: {
            vfs: this.vfs,
            manifests: this.elements.renderPassList.manifests,
            importOptions: this.appConfig.config.importOptions,
            intelGpaDistortion: this.intelGpaDistortion
          },
          bubbles: true,
          composed: true
        }
      )
    );
    console.log('event dispatched.')
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
      if (!this.intelGPAImports[importTarget as IntelGPADropzone]) {
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

    // Computed once from the dropped landmark pair - see
    // intel-gpa-import-helpers.ts / mesh-tools/landmark-matching.ts.
    // Picked up by reconstructScene() (see its event detail below) so it
    // gets applied automatically instead of through the manual
    // scale-reference-object flow.
    this.intelGpaDistortion = fileRoles.distortion;

    const loaded = await fakeManifest(this.intelGPAImports['scene']!.file);

    if (!loaded) {
      this.setStatus("No manifest.json found in the dropped folder - is this a SceneExporter export?");
      return;
    }
    this.vfs = loaded.vfs;
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
        this.intelGPAImports[target] = entries[0];
        this.updateIntelGPADropzone(target as IntelGPADropzone, entries[0].file);
      } else {
        const guessedTarget = guessIntelGPAImportTargetFromFilename(entries[0]);
        if (guessedTarget) {
          this.intelGPAImports[guessedTarget] = entries[0];
          this.updateIntelGPADropzone(guessedTarget as IntelGPADropzone, entries[0].file);
        }
      }
      this.processIntelGPAImport();
      return;
    }

    if (importType === ImportType.IntelGPAExportFull) {
      const guessedTargets = guessIntelGPAImportTargetsFromFilenames(entries);
      for (const key in guessedTargets) {
        this.intelGPAImports[key as IntelGPADropzone] = guessedTargets[key as IntelGPADropzone];
        this.updateIntelGPADropzone(key as IntelGPADropzone, guessedTargets[key as IntelGPADropzone].file);
      }
      this.processIntelGPAImport();
      return;
    }

    // if we came this far, this should be a Renderdoc Scene Exporter folder.
    // A plain RenderDoc-only import has no landmark pair to auto-apply -
    // drop any distortion left over from an earlier IntelGPA import
    // attempt this session, so it doesn't get applied to an unrelated scene.
    this.intelGpaDistortion = null;

    const vfs = new VirtualFileSystem();
    for (const { path, file } of entries) {
     vfs.set(path, file);
    }

    const loaded = await loadManifests(vfs);
    if (!loaded) {
      this.setStatus("No manifest.json found in the dropped folder - is this a SceneExporter export?");
      return;
    }
    this.vfs = loaded.vfs;

    console.log("Loaded manifests:", loaded);

    this.elements.renderPassList.manifests = loaded.manifests;
    this.elements.importProcessingSection.style.display = "block";

    // this.loaded = loaded;
    // this.elements.renderPassList();
    const failedNote = loaded.manifests.failedPassFolders.length
      ? ` (WARNING: ${loaded.manifests.failedPassFolders.length} pass manifest(s) failed to load - see console)`
      : "";
    this.setStatus(`Loaded manifest: ${loaded.manifests.root.passes.length} pass(es) found.${failedNote}`);

    for (const dropzone in this.intelGPADropzones) {
      this.resetIntelGPADropzone(dropzone as IntelGPADropzone);
    }
  }
}
