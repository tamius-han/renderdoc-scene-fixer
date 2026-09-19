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
    splitLoosePartsCheckbox: HTMLInputElement;
    fillHolesCheckbox: HTMLInputElement;
    resizeExportedCheckbox: HTMLInputElement;
    approximateHeightInput: HTMLInputElement;
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
    this.elements.splitLoosePartsCheckbox = this.element.querySelector('#export-options-split-loose-parts') as HTMLInputElement;
    this.elements.fillHolesCheckbox = this.element.querySelector('#export-options-fill-holes') as HTMLInputElement;
    this.elements.resizeExportedCheckbox = this.element.querySelector('#export-options-resize-exported') as HTMLInputElement;
    this.elements.approximateHeightInput = this.element.querySelector('#export-options-approximate-height') as HTMLInputElement;
    this.elements.startExportButton = this.element.querySelector('#export-options-start-export-btn') as HTMLButtonElement;
    this.elements.exportPosedButton = this.element.querySelector('#export-options-export-output') as HTMLButtonElement;
    this.elements.exportOriginalButton = this.element.querySelector('#export-options-export-input') as HTMLButtonElement;

    // load initial values from appConfig
    this.elements.exportTexturesCheckbox.checked = this.appConfig.config.exportOptions.exportTextures;
    this.elements.splitLoosePartsCheckbox.checked = this.appConfig.config.exportOptions.splitLooseParts;
    this.elements.fillHolesCheckbox.checked = this.appConfig.config.exportOptions.fillHoles;
    this.elements.resizeExportedCheckbox.classList.toggle('disabled', !this.appConfig.config.exportOptions.resizeExportedObject);
    this.elements.resizeExportedCheckbox.checked = this.appConfig.config.exportOptions.resizeExportedObject;
    this.elements.approximateHeightInput.value = this.appConfig.config.exportOptions.approximateHeight.toString();
    this.elements.approximateHeightInput.classList.toggle('disabled', !this.appConfig.config.exportOptions.resizeExportedObject);

    this.elements.exportPosedButton.classList.toggle('active', this.appConfig.config.exportOptions.exportType === 'output');
    this.elements.exportOriginalButton.classList.toggle('active', this.appConfig.config.exportOptions.exportType === 'input');

    this.elements.exportTexturesCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.splitLoosePartsCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.fillHolesCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.resizeExportedCheckbox.addEventListener('change', () => this.updateExportOptions());

    this.elements.startExportButton.addEventListener('click', () => this.startExport());
    this.elements.exportPosedButton.addEventListener('click', () => this.updateExportType('output'));
    this.elements.exportOriginalButton.addEventListener('click', () => this.updateExportType('input'));
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
    this.appConfig.config.exportOptions.fillHoles = this.elements.fillHolesCheckbox.checked;
    this.appConfig.config.exportOptions.resizeExportedObject = this.elements.resizeExportedCheckbox.checked;

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
