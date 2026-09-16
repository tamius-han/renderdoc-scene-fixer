import { Config } from '../../config/cls.config';
import { Overlay } from '../common/overlay/cmp.overlay';
import template from "./cmp.control-scheme.html?raw";

export class ControlScheme extends Overlay {

  private controlSchemeDropdown!: HTMLSelectElement;
  private appConfig: Config = Config.getConfig();

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
    this.controlSchemeDropdown = this.querySelector('#control-scheme-use-control-scheme-dropdown') as HTMLSelectElement;

    console.info('[control-scheme::setupInteraction()] Current control scheme:', this.appConfig.config.controls.controlScheme, this.appConfig);
    this.controlSchemeDropdown.value = this.appConfig.config.controls.controlScheme;

    this.controlSchemeDropdown.addEventListener('change', () => {
      console.log(`[control-scheme] Control scheme changed to: ${this.controlSchemeDropdown.value}`);
      this.appConfig.config.controls.controlScheme = this.controlSchemeDropdown.value as 'asdf' | 'esdf';
      this.appConfig.saveConfig();

      console.info(`[control-scheme] Dispatching new customEvent:`);
      this.dispatchEvent(
        new CustomEvent(
          'control-scheme-updated',
          {
            detail: {
              controlScheme: this.controlSchemeDropdown.value as 'asdf' | 'esdf',
              composed: true,
              bubbles: true,
            }
          }
        )
      );

      this.updateControlSchemeVisibility();
    });

    this.updateControlSchemeVisibility();
  }

  updateControlSchemeVisibility() {
    console.info('[control-scheme::updateControlSchemeVisibility()] Updating visibility. Current control scheme:', this.appConfig.config.controls.controlScheme);
    if (this.appConfig.config.controls.controlScheme === 'esdf') {
      this.querySelector('#control-scheme-esdf')!.classList.remove('hidden');
      this.querySelector('#control-scheme-wasd')!.classList.add('hidden');
    } else {
      this.querySelector('#control-scheme-esdf')!.classList.add('hidden');
      this.querySelector('#control-scheme-wasd')!.classList.remove('hidden');
    }
  }
}
