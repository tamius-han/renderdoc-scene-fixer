import { Config, type ExportTextureCategoryOptions, type HeightMapMode } from '../../config/cls.config';
import { Overlay } from '../common/overlay/cmp.overlay';
import template from "./cmp.export-mesh.html?raw";

/** One texture available to embed under a given category (base color,
 * normal map, or combined metalness/roughness) across the draws this
 * dialog is currently open for - what populates a category's thumbnail
 * strip and its picker popup. `objectUrl` is an already-created
 * `URL.createObjectURL()` blob URL (see SceneViewerApp.
 * buildExportTextureCategories()), owned by whoever called
 * setTextureCategories() - this component only ever reads it, never
 * revokes it itself. */
export interface ExportTextureCategoryEntry {
  path: string;
  fileName: string;
  objectUrl: string;
}

export interface ExportTextureCategories {
  baseColor: ExportTextureCategoryEntry[];
  normal: ExportTextureCategoryEntry[];
  metallicRoughness: ExportTextureCategoryEntry[];
}

type TextureCategoryKey = keyof ExportTextureCategories;

export class ExportMesh extends Overlay {

  private appConfig: Config = Config.getConfig();

  /** Which loaded draws (by index into SceneViewerApp's loadedDraws) this
   * dialog is currently open for - set via setSelectedIndices() right
   * before show(), so the dialog (and whoever handles 'start-export')
   * knows what's being exported without needing access to the app's own
   * mesh data. */
  private selectedIndices: number[] = [];

  /** The textures actually available to export for the current selection,
   * one list per category - set via setTextureCategories(), which
   * SceneViewerApp calls right alongside setSelectedIndices() before
   * show(). Empty categories until the first call (e.g. briefly while the
   * dialog's own markup is still being set up). */
  private textureCategories: ExportTextureCategories = { baseColor: [], normal: [], metallicRoughness: [] };

  /** Which category's picker popup is currently open, if any - so the
   * popup's own checkboxes know which config.exportOptions.*Textures
   * object to read/write. */
  private openPickerCategory: TextureCategoryKey | null = null;

  /** "List" (one row per texture with its filename) vs "Thumbnails"
   * (256x256 grid, the default) vs "Large" (512x512 grid) for the
   * currently-open picker popup - shared across all three categories
   * rather than per-category, since it's a display preference for the
   * popup itself, not something tied to what's in it. Not persisted to
   * config: this is a within-session display choice, not an export
   * option. */
  private texturePickerViewMode: 'list' | 'grid' | 'large' = 'grid';

  private elements: {
    litShadingCheckbox: HTMLInputElement;
    splitLoosePartsCheckbox: HTMLInputElement;
    fillHolesCheckbox: HTMLInputElement;
    weldGeometryCheckbox: HTMLInputElement;
    weldOptionsContainer: HTMLElement;
    weldPushInput: HTMLInputElement;
    weldMergeInput: HTMLInputElement;
    weldUvInput: HTMLInputElement;
    weldAngleInput: HTMLInputElement;
    weldBiasSlider: HTMLInputElement;
    fixSelfIntersectionsCheckbox: HTMLInputElement;
    weldAcrossDrawsCheckbox: HTMLInputElement;
    weldBridgeGapsCheckbox: HTMLInputElement;
    resizeExportedCheckbox: HTMLInputElement;
    approximateHeightInput: HTMLInputElement;
    moveToOriginCheckbox: HTMLInputElement;
    startExportButton: HTMLButtonElement;

    exportPosedButton: HTMLButtonElement;
    exportOriginalButton: HTMLButtonElement;

    textureCategoryCheckboxes: Record<TextureCategoryKey, HTMLInputElement>;
    textureCategoryFields: Record<TextureCategoryKey, HTMLButtonElement>;

    metallicFactorSlider: HTMLInputElement;
    metallicFactorValue: HTMLElement;
    roughnessFactorSlider: HTMLInputElement;
    roughnessFactorValue: HTMLElement;

    heightModeSelect: HTMLSelectElement;
    heightGreenSelect: HTMLSelectElement;
    heightSizeSelect: HTMLSelectElement;
    heightStatus: HTMLElement;

    texturePickerPopup: HTMLElement;
    texturePickerTitle: HTMLElement;
    texturePickerList: HTMLElement;
    texturePickerCloseButton: HTMLButtonElement;
    texturePickerViewListButton: HTMLButtonElement;
    texturePickerViewGridButton: HTMLButtonElement;
    texturePickerViewLargeButton: HTMLButtonElement;
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

  /** Also closes the texture-picker popup (if open) whenever the dialog
   * itself closes - otherwise it'd still be showing, overlapping the very
   * first frame of the NEXT time this dialog opens. */
  override hide(): void {
    this.closeTexturePicker();
    super.hide();
  }

  setupInteraction() {
    this.elements.litShadingCheckbox = this.element.querySelector('#export-options-lit-shading') as HTMLInputElement;
    this.elements.splitLoosePartsCheckbox = this.element.querySelector('#export-options-split-loose-parts') as HTMLInputElement;
    this.elements.fillHolesCheckbox = this.element.querySelector('#export-options-fill-holes') as HTMLInputElement;
    this.elements.weldGeometryCheckbox = this.element.querySelector('#export-options-weld-geometry') as HTMLInputElement;
    this.elements.weldOptionsContainer = this.element.querySelector('#export-options-weld-options') as HTMLElement;
    this.elements.weldPushInput = this.element.querySelector('#export-options-weld-push') as HTMLInputElement;
    this.elements.weldMergeInput = this.element.querySelector('#export-options-weld-merge') as HTMLInputElement;
    this.elements.weldUvInput = this.element.querySelector('#export-options-weld-uv') as HTMLInputElement;
    this.elements.weldAngleInput = this.element.querySelector('#export-options-weld-angle') as HTMLInputElement;
    this.elements.weldBiasSlider = this.element.querySelector('#export-options-weld-bias') as HTMLInputElement;
    this.elements.fixSelfIntersectionsCheckbox = this.element.querySelector('#export-options-fix-self-intersections') as HTMLInputElement;
    this.elements.weldAcrossDrawsCheckbox = this.element.querySelector('#export-options-weld-across-draws') as HTMLInputElement;
    this.elements.weldBridgeGapsCheckbox = this.element.querySelector('#export-options-weld-bridge-gaps') as HTMLInputElement;
    this.elements.resizeExportedCheckbox = this.element.querySelector('#export-options-resize-exported') as HTMLInputElement;
    this.elements.approximateHeightInput = this.element.querySelector('#export-options-approximate-height') as HTMLInputElement;
    this.elements.moveToOriginCheckbox = this.element.querySelector('#export-options-move-to-origin') as HTMLInputElement;
    this.elements.startExportButton = this.element.querySelector('#export-options-start-export-btn') as HTMLButtonElement;
    this.elements.exportPosedButton = this.element.querySelector('#export-options-export-output') as HTMLButtonElement;
    this.elements.exportOriginalButton = this.element.querySelector('#export-options-export-input') as HTMLButtonElement;

    this.elements.textureCategoryCheckboxes = {
      baseColor: this.element.querySelector('#export-options-export-basecolor') as HTMLInputElement,
      normal: this.element.querySelector('#export-options-export-normal') as HTMLInputElement,
      metallicRoughness: this.element.querySelector('#export-options-export-metalrough') as HTMLInputElement,
    };
    this.elements.textureCategoryFields = {
      baseColor: this.element.querySelector('#export-options-basecolor-field') as HTMLButtonElement,
      normal: this.element.querySelector('#export-options-normal-field') as HTMLButtonElement,
      metallicRoughness: this.element.querySelector('#export-options-metalrough-field') as HTMLButtonElement,
    };

    this.elements.metallicFactorSlider = this.element.querySelector('#export-options-metallic-factor') as HTMLInputElement;
    this.elements.metallicFactorValue = this.element.querySelector('#export-options-metallic-factor-value') as HTMLElement;
    this.elements.roughnessFactorSlider = this.element.querySelector('#export-options-roughness-factor') as HTMLInputElement;
    this.elements.roughnessFactorValue = this.element.querySelector('#export-options-roughness-factor-value') as HTMLElement;

    this.elements.heightModeSelect = this.element.querySelector('#export-options-height-mode') as HTMLSelectElement;
    this.elements.heightGreenSelect = this.element.querySelector('#export-options-height-green') as HTMLSelectElement;
    this.elements.heightSizeSelect = this.element.querySelector('#export-options-height-size') as HTMLSelectElement;

    this.elements.heightStatus = this.element.querySelector('#export-options-height-status') as HTMLElement;

    this.elements.texturePickerPopup = this.element.querySelector('#export-texture-picker-popup') as HTMLElement;
    this.elements.texturePickerTitle = this.element.querySelector('#export-texture-picker-popup-title') as HTMLElement;
    this.elements.texturePickerList = this.element.querySelector('#export-texture-picker-popup-list') as HTMLElement;
    this.elements.texturePickerCloseButton = this.element.querySelector('#export-texture-picker-popup-close') as HTMLButtonElement;
    this.elements.texturePickerViewListButton = this.element.querySelector('#export-texture-picker-view-list') as HTMLButtonElement;
    this.elements.texturePickerViewGridButton = this.element.querySelector('#export-texture-picker-view-grid') as HTMLButtonElement;
    this.elements.texturePickerViewLargeButton = this.element.querySelector('#export-texture-picker-view-large') as HTMLButtonElement;

    // load initial values from appConfig
    this.elements.litShadingCheckbox.checked = this.appConfig.config.exportOptions.litShading;
    this.elements.splitLoosePartsCheckbox.checked = this.appConfig.config.exportOptions.splitLooseParts;
    this.elements.fillHolesCheckbox.checked = this.appConfig.config.exportOptions.fillHoles;
    this.elements.weldGeometryCheckbox.checked = this.appConfig.config.exportOptions.weldGeometry;
    const weldOptions = this.appConfig.config.exportOptions.weldOptions;
    this.elements.weldPushInput.value = weldOptions.pushDistance.toString();
    this.elements.weldMergeInput.value = weldOptions.mergeDistance.toString();
    this.elements.weldUvInput.value = weldOptions.uvTolerance.toString();
    this.elements.weldAngleInput.value = weldOptions.opposingAngle.toString();
    this.elements.weldBiasSlider.value = weldOptions.pushBias.toString();
    this.elements.fixSelfIntersectionsCheckbox.checked = this.appConfig.config.exportOptions.fixSelfIntersections;
    this.elements.weldAcrossDrawsCheckbox.checked = weldOptions.weldAcrossDrawCalls;
    this.elements.weldBridgeGapsCheckbox.checked = weldOptions.bridgePushedGaps;
    this.elements.resizeExportedCheckbox.classList.toggle('disabled', !this.appConfig.config.exportOptions.resizeExportedObject);
    this.elements.resizeExportedCheckbox.checked = this.appConfig.config.exportOptions.resizeExportedObject;
    this.elements.approximateHeightInput.value = this.appConfig.config.exportOptions.approximateHeight.toString();
    this.elements.approximateHeightInput.disabled = !this.appConfig.config.exportOptions.resizeExportedObject;
    this.elements.approximateHeightInput.classList.toggle('disabled', !this.appConfig.config.exportOptions.resizeExportedObject);
    this.elements.moveToOriginCheckbox.checked = this.appConfig.config.exportOptions.moveToOrigin;

    this.elements.textureCategoryCheckboxes.baseColor.checked = this.appConfig.config.exportOptions.baseColorTextures.enabled;
    this.elements.textureCategoryCheckboxes.normal.checked = this.appConfig.config.exportOptions.normalTextures.enabled;
    this.elements.textureCategoryCheckboxes.metallicRoughness.checked = this.appConfig.config.exportOptions.metallicRoughnessTextures.enabled;

    this.elements.metallicFactorSlider.value = this.appConfig.config.exportOptions.metallicFactor.toString();
    this.elements.roughnessFactorSlider.value = this.appConfig.config.exportOptions.roughnessFactor.toString();
    this.refreshFactorReadouts();

    const heightOptions = this.appConfig.config.exportOptions.heightMaps;
    this.elements.heightModeSelect.value = heightOptions.mode;
    if (this.elements.heightModeSelect.value !== heightOptions.mode) this.elements.heightModeSelect.value = 'none'; // unknown/stale saved value
    this.elements.heightGreenSelect.value = heightOptions.greenConvention;
    this.elements.heightSizeSelect.value = heightOptions.maxSize.toString();
    if (this.elements.heightSizeSelect.value !== heightOptions.maxSize.toString()) this.elements.heightSizeSelect.value = '1024';

    this.elements.exportPosedButton.classList.toggle('active', this.appConfig.config.exportOptions.exportType === 'output');
    this.elements.exportOriginalButton.classList.toggle('active', this.appConfig.config.exportOptions.exportType === 'input');

    this.syncDependentDisabledStates();
    this.renderTextureCategoryFields();

    this.elements.litShadingCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.splitLoosePartsCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.fillHolesCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.weldGeometryCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.fixSelfIntersectionsCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.weldBiasSlider.addEventListener('input', () => this.updateExportOptions());
    this.elements.weldBiasSlider.addEventListener('dblclick', () => {
      this.elements.weldBiasSlider.value = '0';
      this.updateExportOptions();
    });
    this.elements.weldAcrossDrawsCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.weldBridgeGapsCheckbox.addEventListener('change', () => this.updateExportOptions());
    for (const input of [this.elements.weldPushInput, this.elements.weldMergeInput, this.elements.weldUvInput, this.elements.weldAngleInput]) {
      input.addEventListener('input', () => this.updateExportOptions());
    }
    this.elements.resizeExportedCheckbox.addEventListener('change', () => this.updateExportOptions());
    this.elements.moveToOriginCheckbox.addEventListener('change', () => this.updateExportOptions());

    for (const key of Object.keys(this.elements.textureCategoryCheckboxes) as TextureCategoryKey[]) {
      this.elements.textureCategoryCheckboxes[key].addEventListener('change', () => this.updateExportOptions());
      this.elements.textureCategoryFields[key].addEventListener('click', () => this.openTexturePicker(key));
    }

    this.elements.metallicFactorSlider.addEventListener('input', () => this.updateExportOptions());
    this.elements.roughnessFactorSlider.addEventListener('input', () => this.updateExportOptions());

    this.elements.heightModeSelect.addEventListener('change', () => this.updateExportOptions());
    this.elements.heightGreenSelect.addEventListener('change', () => this.updateExportOptions());
    this.elements.heightSizeSelect.addEventListener('change', () => this.updateExportOptions());

    this.elements.texturePickerCloseButton.addEventListener('click', () => this.closeTexturePicker());
    this.elements.texturePickerViewListButton.addEventListener('click', () => this.setTexturePickerViewMode('list'));
    this.elements.texturePickerViewGridButton.addEventListener('click', () => this.setTexturePickerViewMode('grid'));
    this.elements.texturePickerViewLargeButton.addEventListener('click', () => this.setTexturePickerViewMode('large'));
    this.elements.texturePickerPopup.addEventListener('click', (e) => {
      if (e.target === this.elements.texturePickerPopup) this.closeTexturePicker();
    });

    this.elements.startExportButton.addEventListener('click', () => this.startExport());
    this.elements.exportPosedButton.addEventListener('click', () => this.updateExportType('output'));
    this.elements.exportOriginalButton.addEventListener('click', () => this.updateExportType('input'));
  }

  /** Keeps checkboxes/fields that only make sense as a refinement of
   * ANOTHER control in sync with that control's current state:
   * "Fill holes" only makes sense when "Split by loose parts" is also
   * on - hole detection/filling runs per split-out part (see fill.ts),
   * and there's no such thing as "the hole in this whole, unsplit
   * object". "Approximate height" only matters when "Resize exported
   * object" is on. Dependent controls get genuinely disabled (not just
   * styled - see the `.disabled` class alongside), and are forced
   * unchecked/cleared-looking whenever their prerequisite turns off, so
   * the UI can't be left showing a checked-but-inert checkbox. Called
   * once from setupInteraction() for the initial state loaded from
   * config, and again from updateExportOptions() every time any checkbox
   * changes. */
  private syncDependentDisabledStates(): void {
    const splitEnabled = this.elements.splitLoosePartsCheckbox.checked;
    const weldEnabled = this.elements.weldGeometryCheckbox.checked;
    // Filling holes happens either per loose part ("Split by loose parts") or
    // after welding ("Weld geometry"); it needs one of the two.
    const fillAvailable = splitEnabled || weldEnabled;
    this.elements.fillHolesCheckbox.disabled = !fillAvailable;
    this.elements.fillHolesCheckbox.classList.toggle('disabled', !fillAvailable);
    if (!fillAvailable) this.elements.fillHolesCheckbox.checked = false;
    // Fixing self-intersections is a step of the weld pipeline.
    this.elements.fixSelfIntersectionsCheckbox.disabled = !weldEnabled;
    this.elements.fixSelfIntersectionsCheckbox.classList.toggle('disabled', !weldEnabled);

    // The weld tunables only show while "Weld geometry" is checked.
    this.elements.weldOptionsContainer.classList.toggle('hidden', !this.elements.weldGeometryCheckbox.checked);

    const resizeEnabled = this.elements.resizeExportedCheckbox.checked;
    this.elements.approximateHeightInput.disabled = !resizeEnabled;
    this.elements.approximateHeightInput.classList.toggle('disabled', !resizeEnabled);

    // Height map size/green channel only matter once a mode other than
    // "None" is picked.
    const heightEnabled = this.elements.heightModeSelect.value !== 'none';
    for (const control of [this.elements.heightGreenSelect, this.elements.heightSizeSelect]) {
      control.disabled = !heightEnabled;
      control.classList.toggle('disabled', !heightEnabled);
    }
  }

  /** Called by SceneViewerApp right before show(), so this dialog knows
   * which meshes it's currently open for (see selectedIndices' doc
   * comment). */
  setSelectedIndices(indices: number[]): void {
    this.selectedIndices = indices;
  }

  /** Called by SceneViewerApp right alongside setSelectedIndices() (and
   * again any time the selection changes while the dialog is already
   * open), handing this dialog the actual texture data for the "Base
   * color"/"Normal map"/"Metalness-roughness" pickers below - this
   * component has no access to loadedDraws/the virtual filesystem itself,
   * so it can't gather this on its own (see
   * SceneViewerApp.buildExportTextureCategories()). */
  setTextureCategories(categories: ExportTextureCategories): void {
    this.textureCategories = categories;
    this.renderTextureCategoryFields();
    if (this.openPickerCategory) this.renderTexturePickerList(this.openPickerCategory);
  }

  private categoryOptions(key: TextureCategoryKey): ExportTextureCategoryOptions {
    if (key === 'baseColor') return this.appConfig.config.exportOptions.baseColorTextures;
    if (key === 'normal') return this.appConfig.config.exportOptions.normalTextures;
    return this.appConfig.config.exportOptions.metallicRoughnessTextures;
  }

  private categoryLabel(key: TextureCategoryKey): string {
    if (key === 'baseColor') return 'Base color textures';
    if (key === 'normal') return 'Normal map textures';
    return 'Metalness/roughness textures';
  }

  /** Fills each category's little thumbnail-strip button with up to 4 tiny
   * previews (plus a "+N" overflow count) from textureCategories, or a
   * dimmed placeholder when the current selection has none of that kind -
   * called after every setTextureCategories() and whenever an exclusion
   * in the picker popup could change what should visually read as
   * "included" (see openTexturePicker()'s checkbox handler). */
  private renderTextureCategoryFields(): void {
    for (const key of Object.keys(this.textureCategories) as TextureCategoryKey[]) {
      const field = this.elements.textureCategoryFields[key];
      const entries = this.textureCategories[key];
      const excludedPaths = this.categoryOptions(key).excludedPaths;

      if (entries.length === 0) {
        field.innerHTML = `<span class="texture-picker-field-empty">No textures found</span>`;
        continue;
      }

      const maxThumbs = 4;
      const shown = entries.slice(0, maxThumbs);
      const overflow = entries.length - shown.length;
      const thumbsMarkup = shown
        .map(
          (entry) => `
          <img class="texture-picker-thumb${excludedPaths.includes(entry.path) ? ' texture-picker-thumb--excluded' : ''}"
               src="${entry.objectUrl}" alt="${entry.fileName}" title="${entry.fileName}" />`,
        )
        .join('');
      const overflowMarkup = overflow > 0 ? `<span class="texture-picker-field-count">+${overflow}</span>` : '';
      field.innerHTML = `<span class="texture-picker-thumbs">${thumbsMarkup}</span>${overflowMarkup}`;
    }
    this.refreshHeightMapStatus();
  }

  /** Tells the user, before they export, what the height map option will
   * do: how many normal maps it will pick up (the same set the app builds
   * in SceneViewerApp.collectHeightMapSources(): every normal map in the
   * current selection minus the ones unchecked in the "Normal map
   * textures" picker, regardless of that category's own checkbox), where
   * the result ends up, and - since each is a trap for the unwary - the
   * caveats of the two modes that write into the .glb. */
  private refreshHeightMapStatus(): void {
    const statusEl = this.elements.heightStatus;
    if (!statusEl) return;
    const mode = this.elements.heightModeSelect.value as HeightMapMode;
    if (mode === 'none') {
      statusEl.textContent = '';
      return;
    }

    const excluded = this.appConfig.config.exportOptions.normalTextures.excludedPaths;
    const usable = this.textureCategories.normal.filter((entry) => !excluded.includes(entry.path)).length;
    const parts: string[] = [
      usable === 0
        ? 'No normal maps in the current selection - nothing to convert.'
        : `${usable} normal map${usable === 1 ? '' : 's'} will be converted.`,
    ];

    if (mode === 'occlusion') {
      parts.push('Height maps go into the .glb\'s occlusion slot (other viewers will read them as ambient occlusion).');
    } else if (mode === 'replace-normal') {
      parts.push('Height maps go into the .glb\'s normal-map slot instead of the normal maps - Blender will treat them as normal maps until you rewire them.');
    } else {
      parts.push('Downloads a .zip (PNGs + Blender script) next to the .glb - see the README inside.');
    }
    if (mode !== 'zip-script' && !this.elements.litShadingCheckbox.checked) {
      parts.push('Turn on "Lit shading" too: viewers like Blender may ignore these slots on unlit materials.');
    }
    statusEl.textContent = parts.join(' ');
  }

  private openTexturePicker(key: TextureCategoryKey): void {
    this.openPickerCategory = key;
    this.elements.texturePickerTitle.textContent = this.categoryLabel(key);
    this.renderTexturePickerList(key);
    this.elements.texturePickerPopup.classList.remove('hidden');
  }

  private closeTexturePicker(): void {
    this.openPickerCategory = null;
    this.elements.texturePickerPopup.classList.add('hidden');
  }

  /** Switches the OPEN popup between "List" (one row per texture, with its
   * filename alongside a small thumbnail), "Thumbnails" (a 256x256 grid,
   * the default), and "Large" (a 512x512 grid) - a display preference for
   * however many textures are currently shown, not tied to any one
   * category, so it carries over as-is the next time a (possibly
   * different) category's picker is opened. */
  private setTexturePickerViewMode(mode: 'list' | 'grid' | 'large'): void {
    this.texturePickerViewMode = mode;
    this.elements.texturePickerViewListButton.classList.toggle('active', mode === 'list');
    this.elements.texturePickerViewGridButton.classList.toggle('active', mode === 'grid');
    this.elements.texturePickerViewLargeButton.classList.toggle('active', mode === 'large');
    if (this.openPickerCategory) this.renderTexturePickerList(this.openPickerCategory);
  }

  /** (Re)builds the picker popup's list of individual textures for `key`,
   * each with its own checkbox reflecting whether it's currently in
   * exportOptions' excludedPaths for that category - unchecking one adds
   * its path to excludedPaths (and persists/notifies immediately, same as
   * every other export option), independently of the category's own
   * top-level checkbox. Exists specifically so a texture this app's
   * bind-point heuristic misclassified (see SceneViewerApp.
   * describeTextureType()'s own doc comment) can be left out without
   * having to disable the whole category.
   *
   * Renders as a one-row-per-texture list, or one of two grid sizes
   * ("grid"/"large" both use buildTextureGridItemMarkup() - the actual
   * 256px/512px sizing is pure CSS, see .grid-view/.large-view in
   * main.css), depending on texturePickerViewMode (see
   * setTexturePickerViewMode()). All three render the SAME `entries` in
   * the SAME order, so the checkbox-wiring loop at the bottom (matching
   * each checkbox to `entries[i]` purely by DOM order) works identically
   * regardless of which markup was actually used. */
  private renderTexturePickerList(key: TextureCategoryKey): void {
    const entries = this.textureCategories[key];
    const excludedPaths = this.categoryOptions(key).excludedPaths;

    const isGrid = this.texturePickerViewMode === 'grid' || this.texturePickerViewMode === 'large';
    this.elements.texturePickerList.classList.toggle('grid-view', isGrid);
    this.elements.texturePickerList.classList.toggle('large-view', this.texturePickerViewMode === 'large');

    if (entries.length === 0) {
      this.elements.texturePickerList.innerHTML = `<div class="texture-picker-popup-empty">No textures of this kind in the current selection.</div>`;
      return;
    }

    this.elements.texturePickerList.innerHTML = entries
      .map((entry) =>
        isGrid
          ? this.buildTextureGridItemMarkup(entry, excludedPaths.includes(entry.path))
          : this.buildTextureRowMarkup(entry, excludedPaths.includes(entry.path)),
      )
      .join('');

    this.elements.texturePickerList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox, i) => {
      checkbox.addEventListener('change', () => {
        const path = entries[i].path;
        const options = this.categoryOptions(key);
        if (checkbox.checked) {
          options.excludedPaths = options.excludedPaths.filter((p) => p !== path);
        } else {
          options.excludedPaths = [...options.excludedPaths, path];
        }
        this.appConfig.saveConfig();
        this.renderTextureCategoryFields();
        this.notifyOptionsChanged();
      });
    });
  }

  private buildTextureRowMarkup(entry: ExportTextureCategoryEntry, excluded: boolean): string {
    return `
      <label class="texture-picker-popup-row">
        <input type="checkbox" ${excluded ? '' : 'checked'} />
        <img class="texture-picker-popup-thumb" src="${entry.objectUrl}" alt="${entry.fileName}" />
        <span class="texture-picker-popup-filename" title="${entry.fileName}">${entry.fileName}</span>
      </label>`;
  }

  private buildTextureGridItemMarkup(entry: ExportTextureCategoryEntry, excluded: boolean): string {
    return `
      <label class="texture-picker-grid-item">
        <div class="texture-picker-grid-thumb-wrap">
          <img class="texture-picker-grid-thumb" src="${entry.objectUrl}" alt="${entry.fileName}" />
          <input type="checkbox" class="texture-picker-grid-checkbox" ${excluded ? '' : 'checked'} />
        </div>
        <span class="texture-picker-grid-filename" title="${entry.fileName}">${entry.fileName}</span>
      </label>`;
  }

  private refreshFactorReadouts(): void {
    this.elements.metallicFactorValue.textContent = Number(this.elements.metallicFactorSlider.value).toFixed(2);
    this.elements.roughnessFactorValue.textContent = Number(this.elements.roughnessFactorSlider.value).toFixed(2);
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
    this.appConfig.config.exportOptions.splitLooseParts = this.elements.splitLoosePartsCheckbox.checked;

    this.syncDependentDisabledStates(); // may force-uncheck fillHoles/clear approximateHeight's enabled state above

    this.appConfig.config.exportOptions.fillHoles = this.elements.fillHolesCheckbox.checked;
    this.appConfig.config.exportOptions.weldGeometry = this.elements.weldGeometryCheckbox.checked;
    // Weld tunables: a field that's empty/invalid/out of range keeps its last
    // good value rather than clobbering the config mid-typing.
    const weldOptions = this.appConfig.config.exportOptions.weldOptions;
    const readNumber = (input: HTMLInputElement, min: number, max: number, fallback: number): number => {
      const value = parseFloat(input.value);
      return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
    };
    weldOptions.pushDistance = readNumber(this.elements.weldPushInput, 0, Infinity, weldOptions.pushDistance);
    weldOptions.mergeDistance = readNumber(this.elements.weldMergeInput, 0, Infinity, weldOptions.mergeDistance);
    weldOptions.uvTolerance = readNumber(this.elements.weldUvInput, 0, 1, weldOptions.uvTolerance);
    weldOptions.opposingAngle = readNumber(this.elements.weldAngleInput, 90, 180, weldOptions.opposingAngle);
    weldOptions.pushBias = readNumber(this.elements.weldBiasSlider, -1, 1, weldOptions.pushBias);
    this.appConfig.config.exportOptions.fixSelfIntersections = this.elements.fixSelfIntersectionsCheckbox.checked;
    weldOptions.weldAcrossDrawCalls = this.elements.weldAcrossDrawsCheckbox.checked;
    weldOptions.bridgePushedGaps = this.elements.weldBridgeGapsCheckbox.checked;
    this.appConfig.config.exportOptions.resizeExportedObject = this.elements.resizeExportedCheckbox.checked;
    this.appConfig.config.exportOptions.moveToOrigin = this.elements.moveToOriginCheckbox.checked;
    this.appConfig.config.exportOptions.litShading = this.elements.litShadingCheckbox.checked;

    this.appConfig.config.exportOptions.baseColorTextures.enabled = this.elements.textureCategoryCheckboxes.baseColor.checked;
    this.appConfig.config.exportOptions.normalTextures.enabled = this.elements.textureCategoryCheckboxes.normal.checked;
    this.appConfig.config.exportOptions.metallicRoughnessTextures.enabled = this.elements.textureCategoryCheckboxes.metallicRoughness.checked;

    this.appConfig.config.exportOptions.metallicFactor = Number(this.elements.metallicFactorSlider.value);
    this.appConfig.config.exportOptions.roughnessFactor = Number(this.elements.roughnessFactorSlider.value);
    this.refreshFactorReadouts();

    const heightOptions = this.appConfig.config.exportOptions.heightMaps;
    heightOptions.mode = this.elements.heightModeSelect.value as HeightMapMode;
    heightOptions.greenConvention = this.elements.heightGreenSelect.value === 'directx' ? 'directx' : 'opengl';
    heightOptions.maxSize = Number(this.elements.heightSizeSelect.value) || 1024;

    const f = parseFloat(this.elements.approximateHeightInput.value);
    if (!isNaN(f)) {
      this.appConfig.config.exportOptions.approximateHeight = f;
    }
    this.appConfig.saveConfig();

    this.refreshHeightMapStatus();
    this.notifyOptionsChanged();
  }

  /** Lets whoever's showing this dialog (SceneViewerApp) know the pending
   * export options just changed, so it can refresh anything derived from
   * them - currently just the live mesh preview in
   * #export-mesh-export-preview, which depends on exportType
   * (posed/non-posed) and baseColorTextures.enabled (textured/flat grey) -
   * see renderExportMeshPreview() in app.ts. */
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
