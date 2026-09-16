import { LoadedManifests } from "../../manifest.ts";
import { PassIndexEntry } from '../../types';

export class RenderPassList extends HTMLElement {
  private passList!: HTMLDivElement;

  private readonly htmlTemplate = `
    <div class="pass-list h-full overflow-hidden flex flex-col gap-2">
      <div class="pass-list-container">
        <h3 class="text-warm-300">Render passes:</h3>
        <div class="text-sm text-warm-400">
          You probably shouldn't select more than one pass at once, but if you know how to do it I'm not gonna stop you.
        </div>
      </div>
      <div class="pass-list-pass-list overflow-y-auto shrink flex flex-col gap-[2px] pr-4">
      </div>
    </div>
  `;

  private _manifests: LoadedManifests | undefined;

  set manifests(value: LoadedManifests) {
    console.log('setting manifests ...')
    this._manifests = value;
    this.renderPassList();
  }
  get manifests(): LoadedManifests | undefined {
    return this._manifests;
  }

  constructor() {
    super();
  }

  connectedCallback() {
    this.innerHTML = this.htmlTemplate;
    this.registerElements();
  }

  private registerElements() {
    this.passList = this.querySelector(".pass-list-pass-list") as HTMLDivElement;
  }

  private renderPassList(): void {
    if (!this.manifests) return;

    this.passList.innerHTML = "";

    const defaultIndex = this.manifests.root.passes.findIndex(
      (p) => p.guessedRole?.includes("presented")
    );
    const selectedDefault = defaultIndex >= 0 ? defaultIndex : 0;

    let lastClickedIndex = selectedDefault;

    this.manifests.root.passes.forEach((p: PassIndexEntry, i: number) => {
      const hasPosed = (
        this.manifests!.passManifests[p.folder]?.draws ?? []
      ).some((d) => d.posedMesh);

      const row = document.createElement("label");
      row.className = "pass-row";

      row.innerHTML = `
        <input
          type="checkbox"
          data-folder="${p.folder}"
          ${i === selectedDefault ? "checked" : ""}
        >
        <div class="meta">
          <div class="flex flex-row gap-2 items-baseline">
            <div class="name">${p.folder}</div>
            <div class="stats">
              ${p.drawCount} draw(s)<!-- &middot;
              ${p.colorTargets.length} color target(s) &middot;
              depth=${p.depthTarget ? "yes" : "no"} &middot;
              posed=${hasPosed ? "yes" : "no"}-->
            </div>
          </div>
          <div class="role">${p.guessedRole ?? ""}</div>
        </div>
      `;

      this.passList.appendChild(row);

      const cb = row.querySelector<HTMLInputElement>("input")!;
      cb.checked = !!this.manifests!.passManifests[p.folder]!.markedForRender;

      const updateRow = () => {
        console.log('updating row for folder:', p.folder, 'cb.checked?', cb.checked);
        row.classList.toggle("selected", cb.checked);
        this.manifests!.passManifests[p.folder]!.markedForRender = cb.checked;
      };
      updateRow();

      row.addEventListener("click", (event) => {
        const mouseEvent = event as MouseEvent;

        // Prevent the label's default behavior from toggling the checkbox
        // independently of our selection logic.
        event.preventDefault();

        const ctrlOrCmd = mouseEvent.ctrlKey || mouseEvent.metaKey;
        const shift = mouseEvent.shiftKey;

        const checkboxes =
          Array.from(
            this.passList.querySelectorAll<HTMLInputElement>(
              'input[type="checkbox"]'
            )
          );

        if (shift) {
          // Select everything between the previous click and this click.
          const start = Math.min(lastClickedIndex, i);
          const end = Math.max(lastClickedIndex, i);

          // Without Ctrl/Cmd, make the range the complete selection.
          if (!ctrlOrCmd) {
            checkboxes.forEach((checkbox) => {
              checkbox.checked = false;
            });
          }

          for (let j = start; j <= end; j++) {
            checkboxes[j].checked = true;
            const pass = this.manifests!.root.passes[j];
            this.manifests!.passManifests[pass.folder]!.markedForRender = true;
          }
        } else if (ctrlOrCmd) {
          // Toggle only this item.
          cb.checked = !cb.checked;
          this.manifests!.passManifests[p.folder]!.markedForRender = cb.checked;
        } else {
          // Normal click: select only this item.
          checkboxes.forEach((checkbox, j) => {
            checkbox.checked = j === i;
            const pass = this.manifests!.root.passes[j];
            this.manifests!.passManifests[pass.folder]!.markedForRender = checkbox.checked;
          });
        }

        // Update visual state.
        this.passList
          .querySelectorAll<HTMLElement>(".pass-row")
          .forEach((row) => {
            const checkbox =
              row.querySelector<HTMLInputElement>("input")!;

            row.classList.toggle("selected", checkbox.checked);
          });

        lastClickedIndex = i;
      });
    });
  }
}
