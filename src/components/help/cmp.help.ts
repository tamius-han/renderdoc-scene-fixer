import { Overlay } from '../common/overlay/cmp.overlay';
import template from './cmp.help.html?raw';
// Imported (rather than left as the template's original "/res/img/..."
// literal) so Vite actually bundles it and rewrites the URL correctly -
// this project has no `public/` dir for a root-absolute path like that to
// resolve against, and even if it did, vite.config.ts's `base:
// "/renderdoc-scene-fixer/"` means a literal root-absolute path 404s once
// deployed under that subpath. See main.css's `../res/fonts/...` `url()`s
// for the same "let Vite resolve it" approach applied to a different asset
// type.
import renderdocSuccessImg from '../../../res/img/help/renderdoc_success.avif';

export class Help extends Overlay {


  elements: {
    tabs: NodeListOf<HTMLElement>;
    contents: NodeListOf<HTMLElement>
  } = {} as any;

  constructor() {
    super();
    this.innerHTML = template.replaceAll('/res/img/help/renderdoc_success.avif', renderdocSuccessImg);
  }

  connectedCallback() {
    super.connectedCallback();

    this.elements.tabs = this.querySelectorAll(".tab");
    this.elements.contents = this.querySelectorAll("[data-content]");

    this.showTab(/Linux/i.test(navigator.userAgent) ? "linux" : "windows-renderdoc");

    //#region expandable sections
    this.querySelectorAll(".expandable").forEach((section) => {
      const activator = section.querySelector(".expandable-activator");
      const content = section.querySelector(".expandable-content");

      activator!.addEventListener("click", () => {
        const isExpanded = activator!.getAttribute("aria-expanded") === "true";

        activator!.setAttribute("aria-expanded", String(!isExpanded));
        (content! as any).hidden = isExpanded;
      });
    });
    //#endregion
  }

  showTab(name: any) {
    this.elements.tabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === name);
    });

    this.elements.contents.forEach((content) => {
      content.hidden = content.dataset.content !== name;
    });

    this.elements.tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        this.showTab(tab.dataset.tab);
      });
    });
  }
}
