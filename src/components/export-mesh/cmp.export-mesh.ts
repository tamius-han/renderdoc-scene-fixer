import { Config } from '../../config/cls.config';
import { Overlay } from '../common/overlay/cmp.overlay';
import template from "./cmp.export-mesh.html?raw";

export class ExportMesh extends Overlay {

  private appConfig: Config = Config.getConfig();

  /** Which loaded draws (by index into SceneViewerApp's loadedDraws) this
   * dialog is currently open for - set via setSelectedIndices() right
   * before show(), so the dialog (and whoever handles 'start-export')
   * knows what's being exported without needing access to the app's own
   * mesh data. */
  private selectedIndices: number[] = [];

  private elements: {
    exportTexturesCheckbox: HTMLInputElement;
    litShadingCheckbox: HTMLInputElement;
    splitLoosePartsCheckbox: HTMLInputElement;
    fillHolesCheckbox: HTMLInputElement;
    resizeExportedCheckbox: HTMLInputElement;
    approximateHeightInput: HTMLInputElement;
    moveToOriginCheckbox: HTMLInputElement;
    startExportButton: HTMLButtonElement;

    exportPosedButton: HTMLButtonElement;
    exportOriginalButton: HTMLButtonElement;
  } = {} as any;

  constructor() {
    super();
    this.innerHTML = template;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setupInteraction();

    this.element.querySelector('.window')!.addEventListener('click', (e) => e.stopPropagation());
  }

  setupInteraction() {
    this.elements.exportTexturesCheckbox = this.element.querySelector('#export-options-export-textures') as HTMLInputElement;
    this.elements.litShadingCheckbox = this.element.querySelector('#export-options-lit-shading') as HTMLInputElement;
    this.elements.splitLoosePartsCheckbox = this.element.querySelector('#export-options-split-loose-parts') as HTMLInputElement;
    this.elements.fillHolesCheckbox = this.element.querySelector('#export-options-fill-holes') as HTMLInputElement;
    this.elements.resizeExportedCheckbox = this.element.querySelector('#export-options-resize-exported') as HTMLInputElement;
    this.elements.approximateHeightInput = this.element.querySelector('#export-options-approximate-height') as HTMLInputElement;
    this.elements.moveToOriginCheckbox = this.element.querySelector('#export-options-move-to-origin') as HTMLInputElement;
    this.elements.startExportButton = this.element.querySelector('#export-options-start-export-btn') as HTMLButtonElement;
    this.elements.exportPosedButton = this.element.querySelector('#export-options-export-output') as HTMLButtonElement;
    this.elements.exportOriginalButton = this.element.querySelector('#export-options-export-input') as HTMLButtonElement;

    // load initial values from appConfig
    this.elements.exportTexturesCheckbox.checked = this.appConfig.config.exportOptions.exportTextures;
    this.elements.litShadingCheckbox.checked = this.appConfig.config.exportOptions.litShading;
    this.elements.splitLoosePartsCheckbox.checked = this.appConfig.config.exportOptions.splitLooseParts;
    this.elements.fillHolesCheckbox.checked = this.appConfig.config.exportOptions.fillHoles;
    this.elements.resizeExportedCheckbox.classList.toggle('disabled', !this.appConfig.config.exportOptions.resizeExportedObject);
    this.elements.resizeExportedCheckbox.checked = this.appConfig.config.exportOptions.resizeExportedObject;
    this.elements.approximateHeightInput.value = this.appConfig.config.exportOptions.approximateHeight.toString();
    this.elements.approximateHeightInput.disabled = !this.appConfig.config.exportOptions.resizeExportedObject;
    this.elements.approximateHeightInput.classList.toggle('disabled', !this.appConfig.config.exportOptions.resizeExportedObject);
    this.elements.moveToOriginCheckbox.checked = this.appConfig.config.exportOptions.moveToOrigin;

    this.elements.exportPosedButton.classList.toggle('active', this.appConfig.config.exportOptions.exportType === 'output');
    this.elements.exportOriginalButton.classList.toggle('active', this.appConfig.config.exportOptions.exportType === 'input');

    this.syncDependentDisabledStates();

    this.elements.exportTexturesCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.litShadingCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.splitLoosePartsCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.fillHolesCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.resizeExportedCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.moveToOriginCheckbox.addEventListener('change', () => this.updateExportOptions());

    this.elements.startExportButton.addEventListener('click', () => this.startExport());
    this.elements.exportPosedButton.addEventListener('click', () => this.updateExportType('output'));
    this.elements.exportOriginalButton.addEventListener('click', () => this.updateExportType('input'));
  }

  /** Keeps checkboxes that only make sense as a refinement of ANOTHER
   * checkbox in sync with that other one's current state:
   * "Fill holes" only makes sense when "Split by loose parts" is also
   * on - hole detection/filling runs per split-out part (see fill.ts),
   * and there's no such thing as "the hole in this whole, unsplit
   * object". "Approximate height" only matters when "Resize exported
   * object" is on. "Lit shading" only matters when "Export textures" is
   * on - with textures off, there's no normal/roughness map to shade
   * with regardless (see SceneViewerApp.buildExportEntriesForDraw()),
   * lit or not. Both dependent controls get genuinely disabled (not
   * just styled - see the `.disabled` class alongside), and are forced
   * unchecked/cleared-looking whenever their prerequisite turns off, so
   * the UI can't be left showing a checked-but-inert checkbox. Called
   * once from setupInteraction() for the initial state loaded from
   * config, and again from updateExportOptions() every time any checkbox
   * changes. */
  private syncDependentDisabledStates(): void {
    const splitEnabled = this.elements.splitLoosePartsCheckbox.checked;
    this.elements.fillHolesCheckbox.disabled = !splitEnabled;
    this.elements.fillHolesCheckbox.classList.toggle('disabled', !splitEnabled);
    if (!splitEnabled) this.elements.fillHolesCheckbox.checked = false;

    const resizeEnabled = this.elements.resizeExportedCheckbox.checked;
    this.elements.approximateHeightInput.disabled = !resizeEnabled;
    this.elements.approximateHeightInput.classList.toggle('disabled', !resizeEnabled);

    const texturesEnabled = this.elements.exportTexturesCheckbox.checked;
    this.elements.litShadingCheckbox.disabled = !texturesEnabled;
    this.elements.litShadingCheckbox.classList.toggle('disabled', !texturesEnabled);
    if (!texturesEnabled) this.elements.litShadingCheckbox.checked = false;
  }

  /** Called by SceneViewerApp right before show(), so this dialog knows
   * which meshes it's currently open for (see selectedIndices' doc
   * comment). */
  setSelectedIndices(indices: number[]): void {
    this.selectedIndices = indices;
  }

  updateExportType(type: 'output' | 'input') {
    if (type === 'output') {
      this.elements.exportPosedButton.classList.add('active');
      this.elements.exportOriginalButton.classList.remove('active');
    } else {
      this.elements.exportPosedButton.classList.remove('active');
      this.elements.exportOriginalButton.classList.add('active');
    }
    this.appConfig.config.exportOptions.exportType = type;

    this.elements.approximateHeightInput.addEventListener('input', () => this.updateExportOptions());

    this.notifyOptionsChanged();
  }

  updateExportOptions() {
    this.appConfig.config.exportOptions.exportType = this.elements.exportPosedButton.classList.contains('active') ? 'output' : 'input';
    this.appConfig.config.exportOptions.exportTextures = this.elements.exportTexturesCheckbox.checked;
    this.appConfig.config.exportOptions.splitLooseParts = this.elements.splitLoosePartsCheckbox.checked;

    this.syncDependentDisabledStates(); // may force-uncheck fillHoles/clear approximateHeight's enabled state above

    this.appConfig.config.exportOptions.fillHoles = this.elements.fillHolesCheckbox.checked;
    this.appConfig.config.exportOptions.resizeExportedObject = this.elements.resizeExportedCheckbox.checked;
    this.appConfig.config.exportOptions.moveToOrigin = this.elements.moveToOriginCheckbox.checked;
    this.appConfig.config.exportOptions.litShading = this.elements.litShadingCheckbox.checked;

    const f = parseFloat(this.elements.approximateHeightInput.value);
    if (!isNaN(f)) {
      this.appConfig.config.exportOptions.approximateHeight = f;
    }
    this.appConfig.saveConfig();

    this.notifyOptionsChanged();
  }

  /** Lets whoever's showing this dialog (SceneViewerApp) know the pending
   * export options just changed, so it can refresh anything derived from
   * them - currently just the live mesh preview in
   * #export-mesh-export-preview, which depends on exportType
   * (posed/non-posed) and exportTextures (textured/flat grey) - see
   * renderExportMeshPreview() in app.ts. */
  private notifyOptionsChanged(): void {
    this.dispatchEvent(new CustomEvent('export-options-changed'));
  }

  startExport() {
    console.info('Starting export with options:', this.appConfig.config.exportOptions);

    this.updateExportOptions();
    this.dispatchEvent(
      new CustomEvent(
        'start-export',
        {
          detail: {
            exportOptions: this.appConfig.config.exportOptions,
            selectedIndices: this.selectedIndices,
          }
        }
      )
    );

    this.hide();
  }

}
