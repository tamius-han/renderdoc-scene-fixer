# Renderdoc Scene Fixer

A browser-based app that takes output of [renderdoc scene exporter](https://github.com/tamius-han/renderdoc-scene-exporter) addon, displays it in a browser, and gives you a few quick fix options.

## Setup

```
npm install
npm run dev
```

Then open the printed local URL. `npm run build` produces a static `dist/`
folder you can host anywhere (it's a fully client-side app - nothing is
uploaded, everything happens in the browser from the files you drop in).

## Project layout

```
index.html              Vite entry point / static DOM shell
src/
  main.ts               Bootstraps the app
  app.ts                UI wiring + the reconstruction pipeline
  types.ts              Shared types for manifest/OBJ/MTL data
  fileSystem.ts          Drag-and-drop / folder-picker file collection, path helpers
  manifest.ts            Parses the exporter's manifest.json files
  parsers/
    obj.ts               OBJ parser (matches the exporter's own writer)
    mtl.ts               MTL parser (matches the exporter's own writer)
  scene/
    textureManager.ts     Texture loading, downscaling, caching
    meshBuilder.ts         OBJ -> geometry, and merging by material
    sceneManager.ts        Renderer/camera/orbit-controls/context-loss handling
  style.css
```

## Design notes / known limitations

- **Posed vs. bind-pose meshes.** Bind-pose (object-space) meshes have no
  world transform applied at all - loading only those piles every mesh up
  near the local origin rather than laying out a scene. "Use posed meshes"
  is on by default for this reason. The UI shows a warning whenever it's
  off, or the export doesn't contain posed data.
- **Posed meshes are camera-relative, not world-space.** They're
  reconstructed from each draw's post-vertex-shader clip-space output,
  which is relative to whatever camera was active *for that pass*. A
  shadow pass (light's view) and the main pass (player's view) generally
  use different cameras, so their posed geometry won't necessarily align
  spatially if you select both at once - the UI warns about this when more
  than one pass is selected.
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
- **Material guessing happens at export time, not here.** Which texture is
  "the diffuse map" for a given mesh was already decided by the RenderDoc
  extension when it wrote the `.mtl` file; this viewer just reads whatever
  `map_Kd` it finds.
- **Camera controls** are a small hand-rolled orbit implementation (drag to
  rotate, scroll to zoom) rather than Three.js's `OrbitControls`, since
  that's an examples/addon module not bundled with the core `three` npm
  package - pull it in yourself (`three/examples/jsm/controls/OrbitControls.js`)
  if you want to replace it.
- **No instancing.** If a capture has genuinely identical geometry drawn
  many times (e.g. many identical trees), each draw is still its own copy
  of vertex data inside the merged-by-material mesh - there's no detection
  of repeated geometry to turn into `InstancedMesh` instead. Worth adding
  if you run into scenes dominated by a few repeated meshes.
