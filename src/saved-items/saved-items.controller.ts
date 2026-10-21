import * as THREE from "three";
import { VirtualFileSystem } from "../filesystem";
import { TextureManager } from "../scene/texture-manager";
import type { SceneManager } from "../scene/scene-manager";
import { createViewMaterial, type ViewUniforms } from "../scene/view-material";
import { isTextEntryFocused } from "../util/fn.text-entry-focus";
import * as storage from "./saved-items-db";
import type {
  SavedDrawPayload,
  SavedGeometry,
  SavedItemMeta,
  SavedItemPayload,
  SavedTextureKind,
  SavedTexturePayload,
} from "./saved-item.types";
import * as math from "./transform-math";
import type { AxisConstraint, AxisKey, CameraBasis, Mat4, Ray, TransformMode, Vec3 } from "./transform-math";

/** What the app hands over to save one draw call - plain arrays straight out
 * of its LoadedDraw, plus the texture FILES (not decoded textures) so they can
 * be stored as-is. */
export interface SaveDrawInput {
  name: string;
  eventId: number;
  output: { positions: number[]; normals: number[]; uvs: number[] };
  /** null when the input geometry is the same object as the output. */
  input: { positions: number[]; normals: number[]; uvs: number[] } | null;
  textures: Partial<Record<SavedTextureKind, { key: string; file: Blob; fileName: string }>>;
}

export interface SavedItemsHost {
  sceneManager: SceneManager;
  viewUniforms: ViewUniforms;
  /** Whether the viewport currently shades with normal maps (smooth shading
   * with textures on) - normal maps are only decoded when this is true. */
  wantsNormalMaps(): boolean;
  /** True while a dialog covers the viewport; shortcuts stay quiet then. */
  isInputBlocked(): boolean;
  isFlying(): boolean;
  /** Writes the viewport's status line (the HUD). */
  setStatus(text: string): void;
  /** The view switched between draw calls and saved items. */
  onActiveChange(active: boolean): void;
  /** Saved items were added/removed/loaded - e.g. texture availability, which
   * decides which view options exist, may have changed. */
  onItemsChanged(): void;
}

export interface SavedItemsElements {
  toggleButton: HTMLButtonElement;
  saveButton: HTMLButtonElement;
  /** The sidebar's draw-call UI (hidden while saved items are shown)... */
  drawCallPanel: HTMLElement;
  /** ...and its replacement. */
  savedPanel: HTMLElement;
  list: HTMLElement;
  arrangeButton: HTMLButtonElement;
  /** Element that gets a class while saved items are shown (see main.css). */
  appRoot: HTMLElement;
  /** Positioned ancestor for the toast. */
  viewport: HTMLElement;
}

/** One saved item at runtime. */
interface RuntimeItem {
  meta: SavedItemMeta;
  /** null until loaded from IndexedDB (done when the saved view first opens). */
  payload: SavedItemPayload | null;
  /** Centre of the geometry's bounding box in the item's own (pre-transform)
   * space - the pivot for rotate/scale. */
  localCenter: Vec3 | null;
  /** `outer` carries the item's editable matrix, `inner` the base matrix. */
  outer: THREE.Group | null;
  inner: THREE.Group | null;
  meshes: THREE.Mesh[];
  materials: THREE.Material[];
  texturePaths: string[];
  normalClones: THREE.Texture[];
  shadedSelected: boolean | null;
}

interface ModalState {
  mode: TransformMode;
  constraint: AxisConstraint;
  ids: string[];
  startMatrices: Map<string, Mat4>;
  pivot: Vec3;
  pivotPx: { x: number; y: number };
  startPx: { x: number; y: number };
  startRay: Ray;
  angle: math.AngleAccumulator;
}

interface Command {
  undo(): Promise<void> | void;
  redo(): Promise<void> | void;
}

const UNDO_LIMIT = 50;
const MODE_LABEL: Record<TransformMode, string> = { move: "Move", rotate: "Rotate", scale: "Scale" };

export class SavedItemsController {
  private items: RuntimeItem[] = [];
  private selected = new Set<string>();
  private lastClickedId: string | null = null;

  private active = false;
  private loaded = false;
  private loading: Promise<void> | null = null;

  /** Everything saved items draw into; handed to SceneManager while active. */
  private root = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private textures = new TextureManager();
  private textureFiles = new VirtualFileSystem();
  private builtWithNormals = false;

  private mainCamera: ReturnType<SceneManager["getCameraState"]> | null = null;
  private savedCamera: ReturnType<SceneManager["getCameraState"]> | null = null;

  private modal: ModalState | null = null;
  private lastPointer: { x: number; y: number } | null = null;

  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  private toastEl: HTMLElement | null = null;
  private toastTimer: number | undefined;
  private saveButtonLabel: string;

  constructor(
    private host: SavedItemsHost,
    private els: SavedItemsElements,
  ) {
    this.saveButtonLabel = els.saveButton.textContent ?? "Save selection";
    this.wireEvents();
    this.updateToggleButton();
    this.applySaveButtonState();
    void this.loadMetadata();
  }

  //#region public api

  isActive(): boolean {
    return this.active;
  }

  hasTextures(): boolean {
    return this.items.some((item) => item.meta.textureCount > 0);
  }

  itemCount(): number {
    return this.items.length;
  }

  /** Re-applies status text after something else overwrote the HUD. */
  updateStatus(): void {
    if (this.active) this.host.setStatus(this.buildStatusLine());
  }

  /**
   * Saves one new item made of `draws`. `baseMatrix` is the content group's
   * matrix at save time (up-axis/ground-plane correction and scale), so the
   * item shows up exactly where it sat in the scene. Throws if the browser
   * refuses the write (e.g. storage full) - nothing is kept in that case.
   */
  async saveDraws(draws: SaveDrawInput[], baseMatrix: Mat4): Promise<SavedItemMeta> {
    if (draws.length === 0) throw new Error("Nothing to save.");
    await this.loadMetadata();

    const textures: Record<string, SavedTexturePayload> = {};
    const toGeometry = (g: { positions: number[]; normals: number[]; uvs: number[] }): SavedGeometry => ({
      positions: Float32Array.from(g.positions),
      normals: Float32Array.from(g.normals),
      uvs: Float32Array.from(g.uvs),
    });

    let triangles = 0;
    const drawPayloads: SavedDrawPayload[] = draws.map((draw) => {
      const refs: SavedDrawPayload["textures"] = {};
      for (const kind of ["baseColor", "normal", "metallicRoughness"] as SavedTextureKind[]) {
        const tex = draw.textures[kind];
        if (!tex) continue;
        if (!textures[tex.key]) textures[tex.key] = { fileName: tex.fileName, type: tex.file.type, blob: tex.file };
        refs[kind] = tex.key;
      }
      triangles += draw.output.positions.length / 9;
      return {
        name: draw.name,
        eventId: draw.eventId,
        output: toGeometry(draw.output),
        input: draw.input ? toGeometry(draw.input) : null,
        textures: refs,
      };
    });

    const seq = this.items.reduce((max, item) => Math.max(max, item.meta.seq), 0) + 1;
    const id = newId();
    const meta: SavedItemMeta = {
      id,
      name: `Saved item ${seq}`,
      seq,
      createdAt: Date.now(),
      drawCount: drawPayloads.length,
      triangleCount: Math.round(triangles),
      textureCount: Object.keys(textures).length,
      baseMatrix: baseMatrix.slice(),
      matrix: math.identity(),
    };
    const payload: SavedItemPayload = { id, draws: drawPayloads, textures };

    await storage.putSavedItem(meta, payload);

    // The data now lives in IndexedDB; don't also hold a second copy in memory
    // until the saved view is opened (it's read back on demand).
    this.items.push(this.makeRuntimeItem(meta, null));
    this.renderList();
    this.updateToggleButton();
    this.host.onItemsChanged();
    return meta;
  }

  /** Switches between the draw-call view and the saved-items view. */
  async setActive(active: boolean): Promise<void> {
    if (active === this.active) return;
    const sm = this.host.sceneManager;

    if (active) {
      this.active = true;
      this.mainCamera = sm.getCameraState();
      this.els.appRoot.classList.add("saved-items-mode");
      this.els.drawCallPanel.classList.add("hidden");
      this.els.savedPanel.classList.remove("hidden");
      this.updateToggleButton();
      this.applySaveButtonState();
      this.host.onActiveChange(true);
      this.renderList(true);

      await this.ensureEverythingBuilt();
      // The user may have toggled back while payloads were loading.
      if (!this.active) return;

      sm.setAlternateContent(this.root);
      this.applySelectionShading();
      this.renderList();
      if (this.savedCamera) sm.setCameraState(this.savedCamera);
      else sm.frameOnScene();
      this.updateStatus();
    } else {
      if (this.modal) this.cancelModal();
      this.active = false;
      this.savedCamera = sm.getCameraState();
      sm.setAlternateContent(null);
      if (this.mainCamera) sm.setCameraState(this.mainCamera);
      this.els.appRoot.classList.remove("saved-items-mode");
      this.els.savedPanel.classList.add("hidden");
      this.els.drawCallPanel.classList.remove("hidden");
      this.updateToggleButton();
      this.applySaveButtonState();
      this.host.onActiveChange(false);
    }
  }

  /** The viewport look changed (shading/textures): decode normal maps if
   * smooth shading just started needing them. */
  refreshAppearance(): void {
    if (!this.active || !this.loaded) return;
    if (this.host.wantsNormalMaps() && !this.builtWithNormals) void this.rebuildAllItems();
  }

  /** Toast in the viewport (used for save feedback and errors). */
  showToast(text: string, isError = false): void {
    if (!this.toastEl) {
      this.toastEl = document.createElement("div");
      this.toastEl.className = "saved-toast";
      this.els.viewport.appendChild(this.toastEl);
    }
    this.toastEl.textContent = text;
    this.toastEl.classList.toggle("is-error", isError);
    this.toastEl.classList.add("visible");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl?.classList.remove("visible"), isError ? 6000 : 2500);
  }

  /** Pointer handling for the viewport canvas while the saved view is up. */
  handleViewportPointerDown(event: PointerEvent): void {
    if (this.modal) {
      // Any click while a transform is running ends it - same as Blender.
      if (event.button === 0) this.confirmModal();
      else if (event.button === 2) this.cancelModal();
      return;
    }
    if (event.button === 1) return;

    const hitId = this.pickItem(event);
    if (event.button === 2) {
      if (hitId === null) this.clearSelection();
      return;
    }

    if (hitId === null) {
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) this.clearSelection();
      return;
    }
    this.selectItem(hitId, event.shiftKey || event.ctrlKey || event.metaKey);
  }

  //#endregion

  //#region persistence / loading

  private makeRuntimeItem(meta: SavedItemMeta, payload: SavedItemPayload | null): RuntimeItem {
    return {
      meta,
      payload,
      localCenter: payload ? computeLocalCenter(payload) : null,
      outer: null,
      inner: null,
      meshes: [],
      materials: [],
      texturePaths: [],
      normalClones: [],
      shadedSelected: null,
    };
  }

  /** Reads item metadata (cheap) once, so the button can show a count right
   * away and saved items are available after any number of scene loads. */
  private loadMetadata(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      // Never run host callbacks synchronously from the constructor.
      await Promise.resolve();
      try {
        if (!storage.isSavedItemStorageAvailable()) return;
        const metas = await storage.listSavedItemMeta();
        const known = new Set(this.items.map((item) => item.meta.id));
        for (const meta of metas) {
          if (!known.has(meta.id)) this.items.push(this.makeRuntimeItem(meta, null));
        }
        this.items.sort((a, b) => a.meta.seq - b.meta.seq);
      } catch (e) {
        console.warn("[saved-items] Could not read saved items", e);
      } finally {
        this.loaded = true;
        this.loading = null;
        this.updateToggleButton();
        this.renderList();
        this.host.onItemsChanged();
      }
    })();
    return this.loading;
  }

  private async ensurePayload(item: RuntimeItem): Promise<SavedItemPayload | null> {
    if (item.payload) return item.payload;
    try {
      const payload = await storage.getSavedItemPayload(item.meta.id);
      if (payload) {
        item.payload = payload;
        item.localCenter = computeLocalCenter(payload);
      }
      return payload;
    } catch (e) {
      console.warn(`[saved-items] Could not load "${item.meta.name}"`, e);
      return null;
    }
  }

  private async ensureEverythingBuilt(): Promise<void> {
    await this.loadMetadata();
    // Sequential on purpose: texture decoding is throttled the same way the
    // main scene's is (see TextureManager's doc comment).
    for (const item of [...this.items]) {
      if (!this.active) return;
      if (!item.outer) await this.buildItem(item);
    }
  }

  private async rebuildAllItems(): Promise<void> {
    for (const item of [...this.items]) {
      if (!this.active) return;
      await this.buildItem(item);
    }
    this.applySelectionShading();
  }

  //#endregion

  //#region scene objects

  /** Builds are serialised: two overlapping builds of one item (e.g. the
   * view opening while a normal-map rebuild is still running) would each add
   * their own group to the scene. */
  private buildQueue: Promise<void> = Promise.resolve();

  private buildItem(item: RuntimeItem): Promise<void> {
    const next = this.buildQueue.then(() => this.buildItemNow(item));
    // A failed build must not wedge the queue for every later one.
    this.buildQueue = next.catch((e) => console.warn(`[saved-items] could not build "${item.meta.name}"`, e));
    return next;
  }

  private async buildItemNow(item: RuntimeItem): Promise<void> {
    const payload = await this.ensurePayload(item);
    if (!payload) return;
    this.unbuildItem(item);

    const wantNormals = this.host.wantsNormalMaps();
    this.builtWithNormals = wantNormals;

    const pathFor = (key: string): string => `${item.meta.id}/${encodeURIComponent(key)}`;
    const baseTextures = new Map<string, THREE.Texture | null>();
    const normalTextures = new Map<string, THREE.Texture | null>();

    const registerFile = (key: string): string => {
      const path = pathFor(key);
      const tex = payload.textures[key];
      if (tex && !this.textureFiles.has(path)) {
        this.textureFiles.set(path, new File([tex.blob], tex.fileName, { type: tex.type }));
      }
      if (!item.texturePaths.includes(path)) item.texturePaths.push(path);
      return path;
    };

    for (const draw of payload.draws) {
      const baseKey = draw.textures.baseColor;
      if (baseKey && !baseTextures.has(baseKey)) {
        baseTextures.set(baseKey, await this.textures.load(this.textureFiles, registerFile(baseKey)));
      }
      const normalKey = draw.textures.normal;
      if (wantNormals && normalKey && !normalTextures.has(normalKey)) {
        const base = await this.textures.load(this.textureFiles, registerFile(normalKey));
        const linear: THREE.Texture | null = base ? makeLinearClone(base) : null;
        if (linear) item.normalClones.push(linear);
        normalTextures.set(normalKey, linear);
      }
    }

    // One merged mesh per distinct material, like the main scene.
    const groups = new Map<string, { material: THREE.Material; parts: SavedGeometry[] }>();
    for (const draw of payload.draws) {
      const baseKey = draw.textures.baseColor ?? "";
      const normalKey = wantNormals ? (draw.textures.normal ?? "") : "";
      const groupKey = `${baseKey}|${normalKey}`;
      let group = groups.get(groupKey);
      if (!group) {
        const material = createViewMaterial(this.host.viewUniforms, {
          map: baseKey ? baseTextures.get(baseKey) : null,
          normalMap: normalKey ? normalTextures.get(normalKey) : null,
        });
        item.materials.push(material);
        group = { material, parts: [] };
        groups.set(groupKey, group);
      }
      group.parts.push(draw.output);
    }

    const inner = new THREE.Group();
    inner.matrixAutoUpdate = false;
    inner.matrix.fromArray(item.meta.baseMatrix);

    for (const { material, parts } of groups.values()) {
      const merged = mergeGeometry(parts);
      if (merged.positions.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(merged.positions, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(merged.uvs, 2));
      geometry.setAttribute("normal", new THREE.BufferAttribute(merged.normals, 3));
      // Per-vertex "selected" flag read by the viewport shader.
      geometry.setAttribute("aSelected", new THREE.BufferAttribute(new Float32Array(merged.positions.length / 3), 1));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.savedItemId = item.meta.id;
      inner.add(mesh);
      item.meshes.push(mesh);
    }

    const outer = new THREE.Group();
    outer.matrixAutoUpdate = false;
    outer.matrix.fromArray(item.meta.matrix);
    outer.matrixWorldNeedsUpdate = true;
    outer.add(inner);

    item.inner = inner;
    item.outer = outer;
    item.shadedSelected = null;
    this.root.add(outer);
  }

  private unbuildItem(item: RuntimeItem): void {
    if (item.outer) this.root.remove(item.outer);
    for (const mesh of item.meshes) mesh.geometry.dispose();
    for (const material of item.materials) material.dispose();
    for (const texture of item.normalClones) texture.dispose();
    for (const path of item.texturePaths) this.textures.dispose(path);
    item.outer = null;
    item.inner = null;
    item.meshes = [];
    item.materials = [];
    item.normalClones = [];
    item.texturePaths = [];
    item.shadedSelected = null;
  }

  private applyMatrixToScene(item: RuntimeItem): void {
    if (!item.outer) return;
    item.outer.matrix.fromArray(item.meta.matrix);
    item.outer.matrixWorldNeedsUpdate = true;
  }

  /** Feeds selection to the viewport shader (see view-material.ts): the
   * per-vertex flag per mesh, plus the global "something is selected" switch
   * that dims everything unselected. */
  private applySelectionShading(): void {
    this.host.viewUniforms.uHasSelection.value = this.selected.size > 0 ? 1 : 0;
    for (const item of this.items) {
      const isSelected = this.selected.has(item.meta.id);
      if (item.shadedSelected === isSelected) continue;
      for (const mesh of item.meshes) {
        const attribute = mesh.geometry.getAttribute("aSelected") as THREE.BufferAttribute;
        (attribute.array as Float32Array).fill(isSelected ? 1 : 0);
        attribute.needsUpdate = true;
      }
      item.shadedSelected = isSelected;
    }
  }

  //#endregion

  //#region selection

  private selectedItems(): RuntimeItem[] {
    return this.items.filter((item) => this.selected.has(item.meta.id));
  }

  private selectItem(id: string, additive: boolean): void {
    if (additive) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    } else {
      this.selected.clear();
      this.selected.add(id);
    }
    this.lastClickedId = id;
    this.afterSelectionChange();
  }

  private selectRangeTo(id: string): void {
    const from = this.items.findIndex((item) => item.meta.id === this.lastClickedId);
    const to = this.items.findIndex((item) => item.meta.id === id);
    if (from === -1 || to === -1) {
      this.selectItem(id, false);
      return;
    }
    const [lo, hi] = from < to ? [from, to] : [to, from];
    this.selected.clear();
    for (let i = lo; i <= hi; i++) this.selected.add(this.items[i].meta.id);
    this.afterSelectionChange();
  }

  private selectAll(): void {
    this.selected = new Set(this.items.map((item) => item.meta.id));
    this.afterSelectionChange();
  }

  private clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.lastClickedId = null;
    this.afterSelectionChange();
  }

  private afterSelectionChange(): void {
    this.applySelectionShading();
    this.updateListSelection();
    this.updateStatus();
  }

  private pickItem(event: PointerEvent): string | null {
    const canvas = this.host.sceneManager.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.host.sceneManager.activeCamera);
    this.root.updateMatrixWorld(true);
    for (const hit of this.raycaster.intersectObject(this.root, true)) {
      const id = hit.object.userData.savedItemId as string | undefined;
      if (id) return id;
    }
    return null;
  }

  //#endregion

  //#region modal transforms (G / R / S)

  private startModal(mode: TransformMode): void {
    // Switching mode mid-operation (G then R) restarts from the original pose.
    if (this.modal) this.revertModalPose();
    this.modal = null;

    const items = this.selectedItems().filter((item) => item.outer && item.localCenter);
    if (items.length === 0) return;

    const pivots = items.map((item) =>
      math.transformPoint(math.multiply(item.meta.matrix, item.meta.baseMatrix), item.localCenter!),
    );
    const pivot = mul3(pivots.reduce((a, b) => math.add(a, b), [0, 0, 0] as Vec3), 1 / pivots.length);

    const startPx = this.lastPointer ?? this.canvasCenter();
    const pivotPx = this.worldToClientPx(pivot);

    this.modal = {
      mode,
      constraint: { axis: null, plane: false },
      ids: items.map((item) => item.meta.id),
      startMatrices: new Map(items.map((item) => [item.meta.id, item.meta.matrix.slice()])),
      pivot,
      pivotPx,
      startPx: { ...startPx },
      startRay: this.rayAt(startPx.x, startPx.y),
      angle: new math.AngleAccumulator(math.screenAngle(pivotPx, startPx)),
    };

    // A focused sidebar button would otherwise turn Enter (confirm) into a
    // second click on itself.
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.addEventListener("pointerdown", this.onModalPointerDown, true);
    this.els.appRoot.classList.add("saved-items-transforming");
    this.updateStatus();
  }

  private updateModal(): void {
    const m = this.modal;
    if (!m) return;
    const cursor = this.lastPointer ?? m.startPx;

    let delta: Mat4;
    if (m.mode === "move") {
      const offset = math.solveMove(m.startRay, this.rayAt(cursor.x, cursor.y), m.pivot, this.cameraBasis(), m.constraint);
      delta = math.translation(offset);
    } else if (m.mode === "rotate") {
      const total = m.angle.update(math.screenAngle(m.pivotPx, cursor));
      const rotation = math.solveRotate(
        total,
        { x: cursor.x - m.startPx.x, y: cursor.y - m.startPx.y },
        this.cameraBasis(),
        m.constraint,
      );
      delta = math.aboutPivot(rotation, m.pivot);
    } else {
      const factor = math.scaleFactorFromCursor(m.pivotPx, m.startPx, cursor);
      delta = math.aboutPivot(math.solveScale(factor, m.constraint), m.pivot);
    }

    for (const id of m.ids) {
      const item = this.items.find((entry) => entry.meta.id === id);
      const start = m.startMatrices.get(id);
      if (!item || !start) continue;
      item.meta.matrix = math.multiply(delta, start);
      this.applyMatrixToScene(item);
    }
  }

  private confirmModal(): void {
    const m = this.modal;
    if (!m) return;
    const changed = m.ids
      .map((id) => this.items.find((item) => item.meta.id === id))
      .filter((item): item is RuntimeItem => !!item);
    const before = new Map(m.startMatrices);
    const after = new Map(changed.map((item) => [item.meta.id, item.meta.matrix.slice()] as [string, Mat4]));
    this.endModal();

    const moved = changed.some((item) => !sameMatrix(item.meta.matrix, before.get(item.meta.id)!));
    if (!moved) return;
    this.pushCommand(this.matrixCommand(before, after));
    void this.persistMeta(changed);
  }

  private cancelModal(): void {
    if (!this.modal) return;
    this.revertModalPose();
    this.endModal();
  }

  private revertModalPose(): void {
    const m = this.modal;
    if (!m) return;
    for (const id of m.ids) {
      const item = this.items.find((entry) => entry.meta.id === id);
      const start = m.startMatrices.get(id);
      if (!item || !start) continue;
      item.meta.matrix = start.slice();
      this.applyMatrixToScene(item);
    }
  }

  private endModal(): void {
    this.modal = null;
    window.removeEventListener("pointerdown", this.onModalPointerDown, true);
    this.els.appRoot.classList.remove("saved-items-transforming");
    this.updateStatus();
  }

  /** Capture-phase so a click ANYWHERE (sidebar included) ends the transform
   * instead of also triggering whatever it landed on. */
  private onModalPointerDown = (event: PointerEvent): void => {
    if (!this.modal || event.button === 1) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 0) {
      this.confirmModal();
      // pointerdown is swallowed, but the click that follows would still hit
      // whatever is under the cursor - swallow that too.
      const swallow = (e: Event): void => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 400);
    } else if (event.button === 2) {
      this.cancelModal();
    }
  };

  private applyConstraintKey(axis: AxisKey, plane: boolean): void {
    if (!this.modal) return;
    this.modal.constraint = math.toggleConstraint(this.modal.constraint, axis, plane);
    this.updateModal();
    this.updateStatus();
  }

  //#endregion

  //#region camera / screen helpers

  private canvasCenter(): { x: number; y: number } {
    const rect = this.host.sceneManager.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  private rayAt(clientX: number, clientY: number): Ray {
    const rect = this.host.sceneManager.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.host.sceneManager.activeCamera);
    const { origin, direction } = this.raycaster.ray;
    return { origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] };
  }

  private cameraBasis(): CameraBasis {
    const camera = this.host.sceneManager.activeCamera;
    const q = camera.getWorldQuaternion(new THREE.Quaternion());
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    return {
      right: [right.x, right.y, right.z],
      up: [up.x, up.y, up.z],
      forward: [forward.x, forward.y, forward.z],
    };
  }

  private worldToClientPx(world: Vec3): { x: number; y: number } {
    const rect = this.host.sceneManager.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector3(world[0], world[1], world[2]).project(this.host.sceneManager.activeCamera);
    return {
      x: rect.left + (p.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
    };
  }

  //#endregion

  //#region commands: delete, arrange, undo/redo

  private matrixCommand(before: Map<string, Mat4>, after: Map<string, Mat4>): Command {
    const apply = async (target: Map<string, Mat4>): Promise<void> => {
      const touched: RuntimeItem[] = [];
      for (const [id, matrix] of target) {
        const item = this.items.find((entry) => entry.meta.id === id);
        if (!item) continue;
        item.meta.matrix = matrix.slice();
        this.applyMatrixToScene(item);
        touched.push(item);
      }
      await this.persistMeta(touched);
    };
    return { undo: () => apply(before), redo: () => apply(after) };
  }

  private pushCommand(command: Command): void {
    this.undoStack.push(command);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private async undo(): Promise<void> {
    const command = this.undoStack.pop();
    if (!command) return;
    await command.undo();
    this.redoStack.push(command);
  }

  private async redo(): Promise<void> {
    const command = this.redoStack.pop();
    if (!command) return;
    await command.redo();
    this.undoStack.push(command);
  }

  private async deleteItems(targets: RuntimeItem[]): Promise<void> {
    if (targets.length === 0) return;
    if (this.modal) this.cancelModal();
    // Keep each item's data in memory so Ctrl+Z can bring it back.
    await Promise.all(targets.map((item) => this.ensurePayload(item)));
    if (targets.some((item) => !item.payload)) {
      this.showToast("Could not read an item from browser storage - not deleted.", true);
      return;
    }

    const remove = async (): Promise<void> => {
      for (const item of targets) {
        this.unbuildItem(item);
        this.selected.delete(item.meta.id);
      }
      const ids = new Set(targets.map((item) => item.meta.id));
      this.items = this.items.filter((item) => !ids.has(item.meta.id));
      await storage.deleteSavedItems(...ids);
      this.afterItemsChanged();
    };
    const restore = async (): Promise<void> => {
      for (const item of targets) {
        await storage.putSavedItem(item.meta, item.payload!);
        this.items.push(item);
      }
      this.items.sort((a, b) => a.meta.seq - b.meta.seq);
      if (this.active) await Promise.all(targets.map((item) => this.buildItem(item)));
      this.afterItemsChanged();
      this.applySelectionShading();
    };

    try {
      await remove();
    } catch (e) {
      console.warn("[saved-items] delete failed", e);
      this.showToast("Could not delete from browser storage.", true);
      return;
    }
    this.pushCommand({ undo: restore, redo: remove });
  }

  private afterItemsChanged(): void {
    this.applySelectionShading();
    this.renderList();
    this.updateToggleButton();
    this.updateStatus();
    this.host.onItemsChanged();
  }

  private async arrange(): Promise<void> {
    if (this.modal) this.cancelModal();
    await Promise.all(this.items.map((item) => this.ensurePayload(item)));

    const entries: math.ArrangeEntry[] = [];
    for (const item of this.items) {
      if (!item.payload) continue;
      const world = math.multiply(item.meta.matrix, item.meta.baseMatrix);
      let bounds: math.AxisAlignedBounds | null = null;
      for (const draw of item.payload.draws) {
        const b = math.transformedBounds(draw.output.positions, world);
        if (!b) continue;
        bounds = bounds
          ? {
              min: [Math.min(bounds.min[0], b.min[0]), Math.min(bounds.min[1], b.min[1]), Math.min(bounds.min[2], b.min[2])],
              max: [Math.max(bounds.max[0], b.max[0]), Math.max(bounds.max[1], b.max[1]), Math.max(bounds.max[2], b.max[2])],
            }
          : b;
      }
      if (bounds) entries.push({ id: item.meta.id, bounds });
    }
    if (entries.length === 0) return;

    const offsets = math.computeArrangement(entries);
    const before = new Map<string, Mat4>();
    const after = new Map<string, Mat4>();
    for (const item of this.items) {
      const offset = offsets.get(item.meta.id);
      if (!offset) continue;
      before.set(item.meta.id, item.meta.matrix.slice());
      after.set(item.meta.id, math.multiply(math.translation(offset), item.meta.matrix));
    }

    const command = this.matrixCommand(before, after);
    await command.redo();
    this.pushCommand(command);
    this.host.sceneManager.frameOnScene();
  }

  private async persistMeta(items: RuntimeItem[]): Promise<void> {
    try {
      await storage.putSavedItemMeta(...items.map((item) => item.meta));
    } catch (e) {
      console.warn("[saved-items] could not store transform", e);
      this.showToast("Could not store the new position in the browser - it will be lost on reload.", true);
    }
  }

  //#endregion

  //#region keyboard & events

  private wireEvents(): void {
    this.els.toggleButton.addEventListener("click", () => void this.setActive(!this.active));
    this.els.arrangeButton.addEventListener("click", () => void this.arrange());

    window.addEventListener("pointermove", (e) => {
      this.lastPointer = { x: e.clientX, y: e.clientY };
      if (this.modal) this.updateModal();
    });
    window.addEventListener("keydown", (e) => this.onKeyDown(e));

    this.els.list.addEventListener("click", (e) => this.onListClick(e));
    this.els.list.addEventListener("dblclick", (e) => this.onListDoubleClick(e));
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.active || event.repeat) return;
    if (this.host.isInputBlocked() || this.host.isFlying() || isTextEntryFocused()) return;

    const ctrlOrCmd = event.ctrlKey || event.metaKey;

    if (this.modal) {
      if (event.code === "Escape") {
        event.preventDefault();
        this.cancelModal();
        return;
      }
      if (event.code === "Enter" || event.code === "NumpadEnter") {
        event.preventDefault();
        this.confirmModal();
        return;
      }
      if (!ctrlOrCmd && !event.altKey) {
        // event.key (the printed letter) rather than event.code: Y and Z swap
        // physical positions on QWERTZ layouts.
        const letter = event.key.toLowerCase();
        if (letter === "x" || letter === "y" || letter === "z") {
          event.preventDefault();
          this.applyConstraintKey(letter, event.shiftKey);
          return;
        }
        const mode = modeForCode(event.code);
        if (mode) {
          event.preventDefault();
          this.startModal(mode);
        }
      }
      return;
    }

    if (ctrlOrCmd) {
      const letter = event.key.toLowerCase();
      if (letter === "a") {
        event.preventDefault();
        this.selectAll();
      } else if (letter === "z" && !event.shiftKey) {
        event.preventDefault();
        void this.undo();
      } else if (letter === "y" || (letter === "z" && event.shiftKey)) {
        event.preventDefault();
        void this.redo();
      }
      return;
    }
    if (event.altKey) return;

    const mode = modeForCode(event.code);
    if (mode) {
      event.preventDefault();
      this.startModal(mode);
      return;
    }
    if (event.code === "Delete" || event.code === "Backspace") {
      event.preventDefault();
      void this.deleteItems(this.selectedItems());
      return;
    }
    if (event.code === "Escape") this.clearSelection();
  }

  //#endregion

  //#region sidebar list

  private renderList(loading = false): void {
    const list = this.els.list;
    list.innerHTML = "";
    this.els.arrangeButton.disabled = this.items.length === 0;

    if (loading && this.items.some((item) => !item.outer)) {
      list.appendChild(textBlock("Loading saved items\u2026"));
      return;
    }
    if (this.items.length === 0) {
      list.appendChild(
        textBlock(
          storage.isSavedItemStorageAvailable()
            ? "Nothing saved yet. Select draw calls (or select nothing to take everything visible), then click \u201cSave selection\u201d."
            : "Saving needs IndexedDB, which this browser doesn't offer (private browsing?).",
        ),
      );
      return;
    }

    for (const item of this.items) {
      const wrap = document.createElement("div");
      wrap.className = "draw-row-wrap";
      wrap.dataset.savedId = item.meta.id;

      const row = document.createElement("div");
      row.className = "draw-item flex flex-col w-full";
      row.dataset.savedId = item.meta.id;

      const head = document.createElement("div");
      head.className = "flex flex-row justify-between items-baseline gap-2";
      const name = document.createElement("b");
      name.className = "name saved-name";
      name.title = "Double-click to rename";
      name.textContent = item.meta.name;
      const info = document.createElement("small");
      info.className = "role";
      info.textContent = describeItem(item.meta);
      head.append(name, info);

      const actions = document.createElement("div");
      actions.className = "flex flex-row flex-wrap gap-1 mt-1 saved-item-actions";
      actions.append(
        actionButton("move", "Move", "G", "Move (G)"),
        actionButton("rotate", "Rotate", "R", "Rotate (R)"),
        actionButton("scale", "Scale", "S", "Scale (S)"),
        actionButton("delete", "Delete", "Del", "Delete (Delete key)", true),
      );

      row.append(head, actions);
      wrap.appendChild(row);
      list.appendChild(wrap);
    }
    this.updateListSelection();
  }

  private updateListSelection(): void {
    for (const row of this.els.list.querySelectorAll<HTMLElement>(".draw-item[data-saved-id]")) {
      row.classList.toggle("is-selected", this.selected.has(row.dataset.savedId!));
    }
  }

  private onListClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".draw-item[data-saved-id]");
    if (!row) return;
    const id = row.dataset.savedId!;
    const button = target.closest<HTMLButtonElement>("button[data-action]");

    if (!button) {
      if (target.closest("input")) return;
      if (event.shiftKey) this.selectRangeTo(id);
      else this.selectItem(id, event.ctrlKey || event.metaKey);
      return;
    }

    // A row's buttons act on the selection if the row is part of it,
    // otherwise on just that row.
    if (!this.selected.has(id)) this.selectItem(id, false);

    const action = button.dataset.action;
    if (action === "delete") void this.deleteItems(this.selectedItems());
    else if (action === "move" || action === "rotate" || action === "scale") this.startModal(action);
  }

  private onListDoubleClick(event: MouseEvent): void {
    const nameEl = (event.target as HTMLElement).closest<HTMLElement>(".saved-name");
    const row = nameEl?.closest<HTMLElement>(".draw-item[data-saved-id]");
    if (!nameEl || !row) return;
    const item = this.items.find((entry) => entry.meta.id === row.dataset.savedId);
    if (!item) return;

    const input = document.createElement("input");
    input.type = "text";
    input.value = item.meta.name;
    input.className = "saved-name-input";
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      const next = input.value.trim();
      if (commit && next && next !== item.meta.name) {
        item.meta.name = next;
        void this.persistMeta([item]);
      }
      this.renderList();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  //#endregion

  //#region top-bar buttons & status

  private updateToggleButton(): void {
    const count = this.items.length;
    this.els.toggleButton.textContent = this.active ? "View draw calls" : count > 0 ? `View saved items (${count})` : "View saved items";
    this.els.toggleButton.classList.toggle("active", this.active);
  }

  private applySaveButtonState(): void {
    this.els.saveButton.disabled = this.active;
    this.els.saveButton.title = this.active
      ? "Switch back to draw calls to save a selection"
      : "Save the selected draw calls (or everything visible, if nothing is selected) in this browser";
    this.els.saveButton.textContent = this.saveButtonLabel;
  }

  private buildStatusLine(): string {
    if (this.modal) {
      const m = this.modal;
      return (
        `${MODE_LABEL[m.mode]} \u00b7 ${math.describeConstraint(m.constraint)} \u00b7 ` +
        `X / Y / Z lock axis, Shift+X / Y / Z lock plane \u00b7 click or Enter to confirm, right-click or Esc to cancel`
      );
    }
    return (
      `${this.items.length} saved item${this.items.length === 1 ? "" : "s"} \u00b7 ${this.selected.size} selected \u00b7 ` +
      `G move, R rotate, S scale, Delete remove, Ctrl+Z undo \u00b7 MMB drag to orbit, Shift+MMB to pan, scroll to zoom`
    );
  }

  //#endregion
}

// ------------------------------------------------------------------ helpers

/** The cached texture is tagged sRGB (right for colour, wrong for normals) -
 * a linear clone shares the decoded image. */
function makeLinearClone(base: THREE.Texture): THREE.Texture {
  const linear = base.clone();
  linear.colorSpace = THREE.NoColorSpace;
  linear.needsUpdate = true;
  return linear;
}

function modeForCode(code: string): TransformMode | null {
  return code === "KeyG" ? "move" : code === "KeyR" ? "rotate" : code === "KeyS" ? "scale" : null;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function mul3(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function sameMatrix(a: Mat4, b: Mat4): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-12) return false;
  return true;
}

function describeItem(meta: SavedItemMeta): string {
  const parts = [`${meta.drawCount} draw${meta.drawCount === 1 ? "" : "s"}`, `${meta.triangleCount.toLocaleString()} tris`];
  if (meta.textureCount > 0) parts.push(`${meta.textureCount} tex`);
  return parts.join(" \u00b7 ");
}

function textBlock(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "saved-items-empty";
  el.textContent = text;
  return el;
}

function actionButton(action: string, label: string, key: string, title: string, danger = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "check-like saved-action" + (danger ? " danger" : "");
  button.dataset.action = action;
  button.title = title;
  button.append(document.createTextNode(`${label} `));
  const kbd = document.createElement("span");
  kbd.className = "saved-action-key";
  kbd.textContent = key;
  button.appendChild(kbd);
  return button;
}

/** Centre of the bounding box of every draw's output geometry. */
function computeLocalCenter(payload: SavedItemPayload): Vec3 | null {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const draw of payload.draws) {
    const p = draw.output.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      any = true;
      if (p[i] < min[0]) min[0] = p[i];
      if (p[i + 1] < min[1]) min[1] = p[i + 1];
      if (p[i + 2] < min[2]) min[2] = p[i + 2];
      if (p[i] > max[0]) max[0] = p[i];
      if (p[i + 1] > max[1]) max[1] = p[i + 1];
      if (p[i + 2] > max[2]) max[2] = p[i + 2];
    }
  }
  return any ? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] : null;
}

/** Concatenates geometries into one buffer set (no copy for a single part). */
function mergeGeometry(parts: SavedGeometry[]): SavedGeometry {
  if (parts.length === 1) return parts[0];
  const total = (pick: (g: SavedGeometry) => Float32Array): number => parts.reduce((n, g) => n + pick(g).length, 0);
  const positions = new Float32Array(total((g) => g.positions));
  const normals = new Float32Array(total((g) => g.normals));
  const uvs = new Float32Array(total((g) => g.uvs));
  let p = 0;
  let n = 0;
  let u = 0;
  for (const g of parts) {
    positions.set(g.positions, p);
    normals.set(g.normals, n);
    uvs.set(g.uvs, u);
    p += g.positions.length;
    n += g.normals.length;
    u += g.uvs.length;
  }
  return { positions, normals, uvs };
}
