export class Overlay extends HTMLElement {

  protected element!: HTMLDivElement;

  constructor() {
    super();
  }

  connectedCallback() {
    this.element = this.querySelector('div')!;
    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) {
        this.hide();
      }
    });
  }

  show() {
    this.element.classList.remove("hidden");
  }
  hide() {
    this.element.classList.add("hidden");
  }
}
