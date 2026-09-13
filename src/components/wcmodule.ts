import { CaptureImporter } from "./capture-importer/cls.capture-importer";
import { RenderPassList } from "./common/cmp.render-pass-list";

export function registerWebComponents() {
  customElements.define("capture-importer", CaptureImporter);
  customElements.define("render-pass-list", RenderPassList);
}
