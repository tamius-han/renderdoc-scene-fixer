import { CaptureImporter } from "./capture-importer/cmp.capture-importer";
import { RenderPassList } from "./common/render-pass/cmp.render-pass-list";
import { LoadingScreen } from "./loading-screen/cmp.loading-screen";
import { Overlay } from "./common/overlay/cmp.overlay";
import { ControlScheme } from "./control-scheme/cmp.control-scheme";
import { ExportMesh } from './export-mesh/cmp.export-mesh';
import { Help } from './help/cmp.help';
import { InputAxisMapper } from './common/input-axis-mapper/cmp.input-axis-mapper';

export function registerWebComponents() {
  customElements.define("capture-importer", CaptureImporter);
  customElements.define("render-pass-list", RenderPassList);
  customElements.define("loading-screen", LoadingScreen);
  customElements.define("overlay-component", Overlay);
  customElements.define("control-scheme", ControlScheme);
  customElements.define("export-mesh", ExportMesh);
  customElements.define("input-axis-mapper", InputAxisMapper);
  customElements.define("help-component", Help);
}
