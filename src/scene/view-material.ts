import * as THREE from "three";

/**
 * Viewport material used for every merged scene mesh.
 *
 * One Phong-based material handles all viewport looks so that changing any
 * "View options" setting is just a uniform update (no material swapping, no
 * scene rebuild, no shader recompilation):
 *
 *  - mode 0 ("none"):  unlit, but ONLY for fragments actually showing a
 *                      texture; everything else (untextured meshes, textures
 *                      hidden, selected or flipped faces) falls back to flat
 *  - mode 1 ("flat"):  unlit, per-triangle shading from screen-space
 *                      derivatives (the look Intel GPA scenes have always had)
 *  - mode 2 ("smooth"): real lighting (headlight + ambient) using the
 *                      interpolated vertex normals, and the normal map if the
 *                      material has one
 *
 * Per fragment, base color / highlight color come from (in priority order):
 * flipped-normals colors, selection colors, default color (or the texture).
 * When something is selected, everything unselected is dimmed to 50%.
 *
 * "Flipped" means the triangle's winding-derived face normal disagrees with
 * its interpolated vertex normal - view independent, unlike a plain
 * back-face test, and only ever true for meshes that actually carry normals.
 */

/** Uniform objects shared (by reference) by every view material. */
export interface ViewUniforms {
  uViewMode: { value: number };
  uUseTextures: { value: number };
  uHasSelection: { value: number };
  uDefaultColor: { value: THREE.Color };
  uDefaultHighlight: { value: THREE.Color };
  uSelColor: { value: THREE.Color };
  uSelHighlight: { value: THREE.Color };
  uFlipColor: { value: THREE.Color };
  uFlipHighlight: { value: THREE.Color };
}

export function createViewUniforms(selectionColor: THREE.Color): ViewUniforms {
  return {
    uViewMode: { value: 0 },
    uUseTextures: { value: 1 },
    uHasSelection: { value: 0 },
    uDefaultColor: { value: new THREE.Color() },
    uDefaultHighlight: { value: new THREE.Color() },
    // Shared with the app's SELECTION_COLOR so the outline pass, gizmos and
    // this shader can never disagree.
    uSelColor: { value: selectionColor },
    uSelHighlight: { value: new THREE.Color() },
    uFlipColor: { value: new THREE.Color() },
    uFlipHighlight: { value: new THREE.Color() },
  };
}

const HIGHLIGHT_SHININESS = 30;
// Scales the highlight color so smooth (Phong lights) peaks at roughly the
// same brightness as the analytic highlight used by flat mode.
const SMOOTH_HIGHLIGHT_SCALE = 0.45;

export function createViewMaterial(
  uniforms: ViewUniforms,
  maps: { map?: THREE.Texture | null; normalMap?: THREE.Texture | null },
): THREE.MeshPhongMaterial {
  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    map: maps.map ?? null,
    normalMap: maps.normalMap ?? null,
    shininess: HIGHLIGHT_SHININESS,
    side: THREE.DoubleSide,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "attribute float aSelected;\nvarying float vSelected;\n#include <common>")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSelected = aSelected;");

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vSelected;
        uniform float uViewMode;
        uniform float uUseTextures;
        uniform float uHasSelection;
        uniform vec3 uDefaultColor;
        uniform vec3 uDefaultHighlight;
        uniform vec3 uSelColor;
        uniform vec3 uSelHighlight;
        uniform vec3 uFlipColor;
        uniform vec3 uFlipHighlight;`,
      )
      .replace(
        "#include <specularmap_fragment>",
        `#include <specularmap_fragment>
        bool vvSel = uHasSelection > 0.5 && vSelected > 0.5;
        vec3 vvViewDir = normalize( vViewPosition );
        float vvNormalLen = length( vNormal );
        bool vvFlipped = vvNormalLen > 0.001 && ( gl_FrontFacing != ( dot( vNormal / vvNormalLen, vvViewDir ) > 0.0 ) );
        vec3 vvBase = uDefaultColor;
        bool vvShowsTexture = false;
        #ifdef USE_MAP
          if ( uUseTextures > 0.5 ) { vvBase = diffuseColor.rgb; vvShowsTexture = true; }
        #endif
        vec3 vvHighlight = uDefaultHighlight;
        if ( vvSel ) { vvBase = uSelColor; vvHighlight = uSelHighlight; }
        if ( vvFlipped ) { vvBase = uFlipColor; vvHighlight = uFlipHighlight; }
        if ( vvSel || vvFlipped ) vvShowsTexture = false;
        // "none" shading only applies to textured geometry; the rest is flat.
        float vvMode = uViewMode;
        if ( vvMode < 0.5 && !vvShowsTexture ) vvMode = 1.0;
        if ( uHasSelection > 0.5 && !vvSel ) vvBase *= 0.5;
        diffuseColor.rgb = vvBase;`,
      )
      // "Show textures" off also turns normal mapping off.
      .replace(
        "#include <normal_fragment_maps>",
        `vec3 vvNormalBefore = normal;
        #include <normal_fragment_maps>
        if ( uUseTextures < 0.5 ) normal = vvNormalBefore;`,
      )
      .replace(
        "#include <lights_phong_fragment>",
        `#include <lights_phong_fragment>
        material.specularColor = vvHighlight * ${SMOOTH_HIGHLIGHT_SCALE.toFixed(2)};`,
      )
      .replace(
        "#include <opaque_fragment>",
        `if ( vvMode < 1.5 ) {
          if ( vvMode > 0.5 ) {
            vec3 vvFaceN = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );
            vec3 vvL = normalize( vec3( 0.35, 0.55, 0.77 ) );
            // abs() rather than clamp(): OBJ winding isn't reliable and there's
            // no real light to orient against in unlit modes.
            float vvNdotL = abs( dot( vvFaceN, vvL ) );
            vec3 vvH = normalize( vvL + vvViewDir );
            float vvSpec = pow( abs( dot( vvFaceN, vvH ) ), ${HIGHLIGHT_SHININESS.toFixed(1)} );
            outgoingLight = diffuseColor.rgb * ( 0.45 + 0.55 * vvNdotL ) + vvHighlight * vvSpec;
          } else {
            outgoingLight = diffuseColor.rgb;
          }
        }
        #include <opaque_fragment>`,
      );
  };
  // All view materials share one program (same source), differing only in
  // #defines (map/normalMap) - the default cache key already accounts for that.
  return material;
}

/** Headlight + ambient fill for smooth mode. Intensities are in three.js'
 * physical units (a Lambert surface divides by PI), so PI * k gives a
 * k-strength contribution - k = 0.45 ambient + 0.55 directional matches the
 * 0.45 + 0.55 * N.L falloff flat mode uses. */
export class ViewLights {
  readonly group = new THREE.Group();
  private readonly directional = new THREE.DirectionalLight(0xffffff, Math.PI * 0.55);
  private readonly ambient = new THREE.AmbientLight(0xffffff, Math.PI * 0.45);
  // Same fixed view-space direction flat mode shades with.
  private readonly viewSpaceDirection = new THREE.Vector3(0.35, 0.55, 0.77).normalize();

  constructor() {
    this.group.userData.persistent = true;
    this.group.add(this.directional, this.ambient);
  }

  /** Keeps the light fixed relative to the camera so lighting doesn't swing
   * around as the user orbits. Directional lights only use the direction
   * from light to target (left at the origin). */
  syncToCamera(camera: THREE.Camera): void {
    this.directional.position.copy(this.viewSpaceDirection).applyQuaternion(camera.quaternion);
  }
}
