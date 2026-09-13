import { collectFromDrop, collectFromInput, dirname, joinPath, VirtualFileSystem } from "../../filesystem";
import { loadManifests, type LoadedManifests } from "../../manifest";
import { UNIT_CONVERSION } from '../../util/const.unit-conversion';
import { RenderPassList } from '../common/cmp.render-pass-list';

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


  private htmlTemplate: string = `
    <div id="capture-importer-container" class="absolute left-0 top-0 !w-[100vw] h-[100dvh] bg-cool-800 z-100 flex flex-col items-center justify-center">

      <div class="max-h-[90%] max-w-[90%] bg-brown-800 border border-warm-500 p-4">
        <div class="
          w-[calc(100%+2rem)] bg-warm-200 text-warm-800 smallcap
          -mx-4 -mt-4 pt-1 pb-1 px-4
        ">
          Renderdoc scene explorer
        </div>
        <h2>Import scene</h2>
        <div class="text-warm-50 max-w-[960px]">Export scene from RenderDoc with Renderdoc Scene Exporter extension, then drop the exported folder below in order to reconstruct it.</div>
        <div class="text-warm-300 mt-4"> <> <a href="/help.html" target="_blank" class="!text-warm-300 underline">What is this?</a></div>

        <div id="capture-importer-dropzone" class="h-[8rem] flex flex-col items-center justify-center border border-4 border-warm-500 border-dashed m-8 text-warm-300" >
          <div><strong>Drop export folder</strong> or click to browse</div>
          <div class="hint">expects manifest.json at the top level</div>
        </div>
        <input type="file" id="capture-importer-folder-input" webkitdirectory multiple />

        <div
          id="capture-importer-import-processing-section"
          style="display: none"
        >
          <div class="flex flex-col lg:flex-row gap-4">

            <render-pass-list class="render-pass-list lg:flex-1"></render-pass-list>

            <!-- import options go inside div, because they aren't a separate component -->
            <div class="lg:flex-1">
              <h3>Import options</h3>
              <div class="field w-full">
                <div class="label">Capture unit size:</div>
                <div class="flex flex-row gap-4">
                  <input type="text" id="capture-importer-unit-size" class="text-right" min="0" value="1" />
                  <select value="m" class="w-12 text-amber-300">
                    ${Object.keys(UNIT_CONVERSION).map(unit => `<option value="${unit}">${unit}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div class="field">
                <div class="label">Hide largest % of objects:</div>
                <div class="combined-slider-value">
                  <input type="range" id="capture-importer-import-filter-size-slider" min="0" max="100" value="10" />
                  <input type="text" id="capture-importer-import-filter-size-value" class="input-percent" min="0" max="100" value="10" />
                </div>
              </div>
            </div>

          </div>

          <div id="capture-importer-pose-warning" class="warning" style="display: none"></div>



          <button class="primary" id="capture-importer-reconstruct-btn">Reconstruct scene</button>
        </div>
      </div>
      <div id="status-bar">Waiting for a folder&hellip;</div>
  `;

  connectedCallback() {
    this.innerHTML = this.htmlTemplate;

    this.registerElements();
    this.setupEvents();
  }

  /**
   * Puts all relevant HTML elements into class properties for convenient access.
   */
  private registerElements() {
    this.dropzoneOuter = this.querySelector("#capture-importer-container") as HTMLElement;
    this.dropzone = this.querySelector("#capture-importer-dropzone") as HTMLElement;
    this.folderInput = this.querySelector("#capture-importer-folder-input") as HTMLInputElement;

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
    this.dropzone.addEventListener("click", () => this.folderInput.click());

    this.dropzoneOuter.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.dropzone.classList.add("drag");
    });
    this.dropzoneOuter.addEventListener("dragleave", () => this.dropzone.classList.remove("drag"));
    this.dropzoneOuter.addEventListener("drop", async (e) => {
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

    // this.reconstructBtn.addEventListener("click", () => void this.reconstructScene());
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

  private setStatus(message: string): void {
    this.statusBar.textContent = message;
  }

  private async handleFiles(entries: { path: string; file: File }[]): Promise<void> {
    if (entries.length === 0) return;

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
