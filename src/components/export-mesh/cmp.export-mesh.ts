import { Config } from '../../config/cls.config';
import { Overlay } from '../common/overlay/cmp.overlay';
import template from "./cmp.export-mesh.html?raw";

export class ExportMesh extends Overlay {

  private appConfig: Config = Config.getConfig();

  private elements: {
    exportTexturesCheckbox: HTMLInputElement;
    splitLoosePartsCheckbox: HTMLInputElement;
    fillHolesCheckbox: HTMLInputElement;
    resizeExportedCheckbox: HTMLInputElement;
    approximateHeightInput: HTMLInputElement;
    startExportButton: HTMLButtonElement;
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

    // load initial values from appConfig
    this.elements.exportTexturesCheckbox.checked = this.appConfig.config.exportOptions.exportTextures;
    this.elements.splitLoosePartsCheckbox.checked = this.appConfig.config.exportOptions.splitLooseParts;
    this.elements.fillHolesCheckbox.checked = this.appConfig.config.exportOptions.fillHoles;
    this.elements.resizeExportedCheckbox.classList.toggle('disabled', !this.appConfig.config.exportOptions.resizeExportedObject);
    this.elements.resizeExportedCheckbox.checked = this.appConfig.config.exportOptions.resizeExportedObject;
    this.elements.approximateHeightInput.value = this.appConfig.config.exportOptions.approximateHeight.toString();
    this.elements.approximateHeightInput.classList.toggle('disabled', !this.appConfig.config.exportOptions.resizeExportedObject);

    this.elements.exportTexturesCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.splitLoosePartsCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.fillHolesCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.resizeExportedCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.approximateHeightInput.addEventListener('input', () => this.updateExportOptions());

    this.elements.startExportButton.addEventListener('click', () => this.startExport());
  }

  updateExportOptions() {
    this.appConfig.config.exportOptions.exportTextures = this.elements.exportTexturesCheckbox.checked;
    this.appConfig.config.exportOptions.splitLooseParts = this.elements.splitLoosePartsCheckbox.checked;
    this.appConfig.config.exportOptions.fillHoles = this.elements.fillHolesCheckbox.checked;
    this.appConfig.config.exportOptions.resizeExportedObject = this.elements.resizeExportedCheckbox.checked;

    const f = parseFloat(this.elements.approximateHeightInput.value);
    if (!isNaN(f)) {
      this.appConfig.config.exportOptions.approximateHeight = f;
    }
    this.appConfig.saveConfig();
  }

  startExport() {
    console.info('Starting export with options:', this.appConfig.config.exportOptions);

    this.updateExportOptions();
    this.dispatchEvent(
      new CustomEvent(
        'start-export',
        {
          detail: {
            exportOptions: this.appConfig.config.exportOptions
          }
        }
      )
    );

    this.hide();
  }

}
