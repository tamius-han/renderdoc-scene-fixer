import { Config } from '../../../config/cls.config';
import { AxisDirection } from '../../../types/axis-direction.type';
import { axisLetter } from '../../../util/axis-orientation';
import template from './cmp.input-axis-mapper.html?raw';


export class InputAxisMapper extends HTMLElement {

  private appConfig: Config;
  private elements: {
    upAxis: HTMLSelectElement;
    forwardAxis: HTMLSelectElement;
    rightAxis: HTMLSelectElement;
  }

  constructor() {
    super();

    this.appConfig = Config.getConfig();
    this.elements = ({} as any);
  }

  connectedCallback() {
    this.innerHTML = template;
    this.registerElements();
    this.setupInitialValues();
  }

  private registerElements() {
    this.elements.upAxis = this.querySelector("#input-axis-mapper-up-axis") as HTMLSelectElement;
    this.elements.forwardAxis = this.querySelector("#input-axis-mapper-forward-axis") as HTMLSelectElement;
    this.elements.rightAxis = this.querySelector("#input-axis-mapper-right-axis") as HTMLSelectElement;

    this.elements.upAxis.addEventListener("change", () => {
      this.setInputGeometryOrientation('up', this.elements.upAxis.value);
    });
    this.elements.forwardAxis.addEventListener("change", () => {
      this.setInputGeometryOrientation('forward', this.elements.forwardAxis.value);
    });
    this.elements.rightAxis.addEventListener("change", () => {
      this.setInputGeometryOrientation('right', this.elements.rightAxis.value);
    });
  }

  private setupInitialValues() {
    const orientation = this.appConfig.config.importOptions.inputGeometryOrientation;
    console.info('[cmp.input-axis-mapper] setupInitialValues:', orientation);
    this.elements.upAxis.value = orientation.up;
    this.elements.forwardAxis.value = orientation.forward;
    this.elements.rightAxis.value = orientation.right;
  }

  private axisSelectElement(axis: 'up' | 'forward' | 'right'): HTMLSelectElement {
    if (axis === 'up') return this.elements.upAxis;
    if (axis === 'forward') return this.elements.forwardAxis;
    return this.elements.rightAxis;
  }

  /**
   * Sets mapping between axes of coordinate system of the input geometry and
   * the world coordinate system of the scene in this app.
   *
   * The function ensures there's no collisions between the axes, and will
   * swap conflicting axes if necessary. After assignment, new CustomEvent
   * is emitted, with the new & updated axis mapping.
   *
   * @param axis: axis/direction of the world space in this app
   * @param value: axis of input geometry that corresponds to the given world axis
   */
  private setInputGeometryOrientation(axis: 'up' | 'forward' | 'right', value: string): void {
    const orientation = this.appConfig.config.importOptions.inputGeometryOrientation;
    const newValue = value as AxisDirection;
    const oldValue = orientation[axis];
    if (newValue === oldValue) return;

    for (const other of (['up', 'forward', 'right'] as const)) {
      if (other === axis) continue;
      if (axisLetter(orientation[other]) === axisLetter(newValue)) {
        orientation[other] = oldValue;
        this.axisSelectElement(other).value = oldValue;
        break;
      }
    }

    orientation[axis] = newValue;

    this.dispatchEvent(
      new CustomEvent(
        'axis-mapping-changed',
        {
          detail: {
            orientation
          },
          bubbles: true,
          composed: true
        }
      )
    );
  }
}
