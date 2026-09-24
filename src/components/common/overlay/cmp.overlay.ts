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

  /** Whether the overlay is currently on screen - used by SceneViewerApp to
   * decide what Escape should do (close the topmost open overlay instead of
   * clearing selection) and to know which overlay, if any, is open. */
  isVisible(): boolean {
    return !this.element.classList.contains("hidden");
  }

  /** show()/hide() dispatch 'overlay-shown'/'overlay-hidden' so listeners
   * (see SceneViewerApp's use for the export overlay: pausing the main
   * viewport's render loop and tearing down the export preview) react no
   * matter how the overlay was opened/closed - a direct show()/hide() call,
   * clicking the backdrop above, or the overlay hiding itself (e.g.
   * ExportMesh.startExport()). Guarded so redundant calls (already
   * shown/hidden) don't re-dispatch. */
  show() {
    if (this.isVisible()) return;
    this.element.classList.remove("hidden");
    this.dispatchEvent(new CustomEvent("overlay-shown"));
  }
  hide() {
    if (!this.isVisible()) return;
    this.element.classList.add("hidden");
    this.dispatchEvent(new CustomEvent("overlay-hidden"));
  }
}
