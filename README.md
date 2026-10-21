# Renderdoc Scene Fixer

A browser-based app used to fix 3D models exported with RenderDoc (using [renderdoc scene exporter](https://github.com/tamius-han/renderdoc-scene-exporter) addon) or Intel GPA. 
It is a successor to [Intel GPA squish calculator](https://github.com/tamius-han/intel-gpa-squish-calculator).

**[Click here](https://tamius-han.github.io/renderdoc-scene-fixer/) to open this app.**

When exporting output geometry from Intel GPA or RenderDoc, you will notice that models appear squished in the pose-preserving output geometry. This is less than ideal if
you want to 3D print your characters, and it's also kinda annoying to fix by hand — hence this.

> This tool has been developed with significant assistance of LLMs. 
> If you're an AI vegan who prefers not to use tools authored by AI if possible, your alternatives are:
> * export your models with Intel GPA and [fix everything by hand](https://stuff.tamius.net/sacred-texts/2024/10/25/old_how-to-print-your-guild-wars-2-character-or-any-game-really/). 
> * fork over some money and try your luck with NinjaRipper
> Do note that Intel dropped their Intel GPA suite. In the future, you might have to acquire Intel GPA from the Internet Archive.

In addition to fixing the squish, this app can also:

* splits the object by loose parts (which ends up saving two clicks in blender)
* fixes basic (but not all) issues that meshes exported from games have (and that tend to only be issues when you try to 3D print things)
* scale your object to approximately desired size

When using RenderDoc and RenderDoc Scene Exporter, this app will also apply textures to meshes. In this case, exported models will also
include model textures, which can then be used for reverse normal baking in order to add additional detail in Blender.

## Usage

The app is hosted here: https://tamius-han.github.io/renderdoc-scene-fixer/

If using Renderdoc and RenderDoc Scene Exporter, export the scene with the extension. Extension exports scene into a folder.
After export finishes, drag the folder onto the appropriate dropzone. 

If using intel GPA, you need to pick a landmark. Landmark is a static object with unchanging shape. Source geometry of your landmark
should look the way this object looks in game as you rotate it in the preview panel. You need to export both source geometry and output
geometry of your landmark. After you've exported your landmark, select meshes that make up your character (or any other object you wish to export)
and export output geometry.

Then, open this app (see link above) and drag landmark source geometry, landmark output geometry, and your character output geometry into 
their respective fields on the import page. If you name your files correctly (`landmakr-source.obj`, `landmark-output.obj` and `scene.obj`),
you can drag in all three files at once.

After files have been imported, render passes and import options will appear. If there's more than one render pass, select the appropriate pass. Usually, that's forward pass with most draw calls. For modern games, theory says you should also look at g-buffer passes, but in practice I haven't tested RenderDoc scene exporter with modern games (other than Styx 3, which didnt work with my RenderDoc addon).

Import options menu is pretty self-explanatory. Set stuff that you want to set, then click 'reconstruct scene'. 

Once scene is reconstructed, you can inspect the scene. Movement is blender-like: middle mouse to rotate, shift+middle mouse to move. See 'control options' (in app) for details.
Select the meshes that you want to export, or hide the meshes that you don't want to export. Click 'Fix & export'. This will present you with another fairly self-explanatory 
dialog. Tick the options you want. In the export preview panel, check that everything you expect to be in your export is actually there and looks the way you expect it to look.
Hit fix & export.


### Height maps from normal maps

The export dialog (*Fix & export*) has a **Height maps** section with two dropdowns:

* **Height map size** — Small 512, Medium 1024 (default), Large 2048, Extra large 4096 (slow, ~1 GB RAM). Disabled while *Generate height maps* is *None*.
* **Generate height maps** —
  * *None* (default): off.
  * *As occlusion texture*: each height map is embedded in the `.glb`'s occlusion slot (glTF has no height slot, and this one is otherwise unused).
  * *Replace normal maps*: each height map is embedded in the `.glb`'s normal slot instead of the normal map it was made from.
  * *Zip + Blender script*: a `.zip` is downloaded next to the `.glb` containing the 16-bit PNGs, `height_maps.json` (object name → PNG),
    `README.txt` and `apply_height_maps.py`. Import the `.glb`, run the script in Blender's Scripting workspace, and every object gets
    Image Texture → Displacement → Material Output, true displacement enabled, and a Subdivision modifier. Re-running is safe; tweak `RELIEF` and the
    subdivision levels at the top of the script.

How it works: a normal map is a gradient field (`dh/dx = -nx/nz`, `dh/dy = -ny/nz`), so the height is recovered by solving the Poisson equation in the
Fourier domain (Frankot–Chellappa). The gradient field is mirrored before solving so the texture's edges don't have to tile. Two-channel normal maps
(blue channel empty) have `nz` rebuilt automatically. The solver runs in a Web Worker (`src/texture-tools/`); fields beyond the 2048 size are
stored as Float32 to keep 4096 under ~1 GB.

Things worth knowing:

* Set *Normal map green channel* to match the source (OpenGL = +Y up, DirectX = +Y down). Picking wrong turns bumps into dents along one axis.
* Height is only recoverable up to scale and offset, so each map is normalised to the full 0–65535 range.
* Maps larger than the chosen size are downscaled first; output is written at that size.
* Which normal maps get converted follows the *Normal map textures* picker's per-texture checkboxes (but not its category checkbox).
* The two `.glb` modes need *Lit shading* on, otherwise viewers like Blender may ignore the slots.

### Saved items

**Save selection** (top bar) stores the selected draw calls - or everything visible if nothing is selected - as one saved item in this browser (IndexedDB): input and output geometry plus base color, normal and metalness/roughness textures. Saved items are independent copies, so they survive loading another pass or file.

**View saved items** (next to *Fix & export*) swaps the draw-call list for the saved list. With an item selected: **G** move, **R** rotate, **S** scale, **Delete** remove (Ctrl+Z / Ctrl+Y undo/redo). While moving/rotating/scaling, **X/Y/Z** locks to that world axis and **Shift+X/Y/Z** locks to the plane perpendicular to it; click/Enter confirms, right-click/Esc cancels. **Arrange** lines every saved item up along +X with spacing (bottoms on y=0, centred on z=0). Double-click a name to rename.

## Local dev

Perform the usual:

```
npm install
npm run dev
```

And 

```
npm run build
```

to generate a deployable package (which ends in `dist`).



## Design notes / known limitations

- **Large-capture handling.** Two things specifically address scenes with
  thousands of draws (this used to crash / turn the canvas black):
  - `textureManager.ts` downscales every texture to a configurable max
    dimension (1024px by default) and awaits decoding via
    `createImageBitmap()` inside the caller's sequential per-draw loop,
    rather than firing off unbounded concurrent full-resolution decodes.
  - `meshBuilder.ts` merges every draw that shares a material into one
    combined mesh, so a capture with e.g. 2500 draws sharing 40 textures
    becomes ~40 draw calls instead of 2500 separate `THREE.Mesh` objects.
  - `sceneManager.ts` also listens for `webglcontextlost` and reports it
    via the status bar instead of silently going black, in case a capture
    is still too large for the available GPU after the above.
- **No instancing.** If a capture has genuinely identical geometry drawn
  many times (e.g. many identical trees), each draw is still its own copy
  of vertex data inside the merged-by-material mesh - there's no detection
  of repeated geometry to turn into `InstancedMesh` instead. Worth adding
  if you run into scenes dominated by a few repeated meshes.
