import * as THREE from "three";
import type { Bounds } from "./mesh-builder";

// Requested look: translucent orange fill (kept mid-range of the requested
// 10-20% opacity band), 2px orange edges, with a 1px black outline on each
// side of every edge (so the black ring is 1px wider than the orange core
// on both sides, i.e. total edge width = 2 + 1 + 1 = 4px).
const FILL_COLOR = 0xff8c1a;
const FILL_OPACITY = 0.15;
const EDGE_COLOR = 0xff8c1a;
const EDGE_OUTLINE_COLOR = 0x000000;
const EDGE_WIDTH_PIXELS = 2;
const EDGE_OUTLINE_WIDTH_PIXELS = EDGE_WIDTH_PIXELS + 2 * 1;

/** The 8 corners of a unit cube (-0.5..0.5 on every axis) and the 12 edges
 * connecting them - built once and reused (via per-instance scale/position,
 * see setBounds()) rather than rebuilt from scratch on every selection
 * change. */
const UNIT_CORNERS: [number, number, number][] = [
  [-0.5, -0.5, -0.5],
  [0.5, -0.5, -0.5],
  [0.5, 0.5, -0.5],
  [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5],
  [0.5, -0.5, 0.5],
  [0.5, 0.5, 0.5],
  [-0.5, 0.5, 0.5],
];
const UNIT_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0], // bottom face
  [4, 5], [5, 6], [6, 7], [7, 4], // top face
  [0, 4], [1, 5], [2, 6], [3, 7], // verticals
];

/** Builds the 12-edge "fat line" geometry: each edge is a quad (4 verts, 2
 * tris) rather than a literal THREE.Line segment, because a plain
 * THREE.Line's `linewidth` is ignored on virtually every platform (a
 * long-standing WebGL limitation - it always renders at 1 physical pixel
 * regardless of what's requested). Getting an actual, constant SCREEN-SPACE
 * pixel width instead requires extruding each segment into a quad in the
 * vertex shader (see buildFatLineMaterial()) - this geometry just supplies,
 * per vertex: aStart/aEnd (the segment's two endpoints, in the SAME local
 * space every frame - scale/position changes are handled by transforming
 * the whole mesh, see setBounds()) and aSide (-1/+1, which edge of the
 * quad this vertex is on). A `position` attribute is also included (copied
 * from aStart) purely because THREE.ShaderMaterial always declares
 * `attribute vec3 position` whether or not this shader's own main() reads
 * it - the geometry needs SOME buffer bound there. */
function buildFatLineGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const sides: number[] = [];
  const indices: number[] = [];

  UNIT_EDGES.forEach(([ai, bi], edgeIndex) => {
    const a = UNIT_CORNERS[ai];
    const b = UNIT_CORNERS[bi];
    const base = edgeIndex * 4;
    const verts: Array<{ p: [number, number, number]; other: [number, number, number]; side: number }> = [
      { p: a, other: b, side: -1 },
      { p: a, other: b, side: 1 },
      { p: b, other: a, side: 1 },
      { p: b, other: a, side: -1 },
    ];
    for (const v of verts) {
      positions.push(...v.p);
      starts.push(...v.p);
      ends.push(...v.other);
      sides.push(v.side);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aStart", new THREE.Float32BufferAttribute(starts, 3));
  geometry.setAttribute("aEnd", new THREE.Float32BufferAttribute(ends, 3));
  geometry.setAttribute("aSide", new THREE.Float32BufferAttribute(sides, 1));
  geometry.setIndex(indices);
  return geometry;
}

/** The actual "fat line" shader: projects both endpoints of a segment to
 * clip space, converts to real device-pixel coordinates (multiplying by
 * half the resolution - NOT just using raw NDC, which would make the
 * extrusion direction/width aspect-ratio-dependent), offsets the vertex
 * perpendicular to the segment's on-screen direction by half the requested
 * pixel width, then converts that pixel offset back to a clip-space delta
 * (dividing by half-resolution, then re-multiplying by clip.w so the
 * offset survives the perspective divide as an exact, constant number of
 * screen pixels regardless of distance/zoom/projection). This is the same
 * technique three.js's own Line2/LineMaterial (three/examples/jsm/lines)
 * uses internally - hand-rolled here since this project deliberately
 * avoids importing from three's examples (see SceneManager's own doc
 * comment on that point). */
function buildFatLineMaterial(color: number, widthPixels: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uWidthPixels: { value: widthPixels },
    },
    vertexShader: `
      attribute vec3 aStart;
      attribute vec3 aEnd;
      attribute float aSide;
      uniform vec2 uResolution;
      uniform float uWidthPixels;

      void main() {
        vec4 clipStart = projectionMatrix * modelViewMatrix * vec4(aStart, 1.0);
        vec4 clipEnd = projectionMatrix * modelViewMatrix * vec4(aEnd, 1.0);

        vec2 halfRes = max(uResolution, vec2(1.0)) * 0.5;
        vec2 screenStart = (clipStart.xy / max(clipStart.w, 1e-6)) * halfRes;
        vec2 screenEnd = (clipEnd.xy / max(clipEnd.w, 1e-6)) * halfRes;

        vec2 dir = screenEnd - screenStart;
        dir = length(dir) < 1e-6 ? vec2(1.0, 0.0) : normalize(dir);
        vec2 normal = vec2(-dir.y, dir.x);

        vec2 pixelOffset = normal * (uWidthPixels * 0.5) * aSide;
        vec2 ndcOffset = pixelOffset / halfRes;

        vec4 clip = clipStart;
        clip.xy += ndcOffset * clip.w;
        gl_Position = clip;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
      }
    `,
  });
}

/** A transparent orange cube drawn tightly (no padding) around a bounding
 * box - the "Show bounding box" toggle's on-screen visual (see
 * SceneViewerApp.updateBoundingBoxVisual()).
 *
 * Deliberately NOT parented under the content group the way the selection
 * dot markers are (see SceneViewerApp.addDotPair()): the content group is
 * torn down and rebuilt from scratch on every import/filter change
 * (SceneManager.clear() disposes every THREE.Mesh geometry it finds by
 * traversing the group, with no way to tell "owned by the scene" meshes
 * apart from ones an app-level overlay merely parented there), which would
 * silently dispose and invalidate this gizmo's own reusable geometries.
 * Instead this lives as a sibling of the content group, directly in the
 * main scene, with its transform kept in sync with whatever the content
 * group's current scale/quaternion happen to be (see syncTransform()) -
 * exactly the same pattern SceneViewerApp already uses for the selection
 * outline's mask group. */
export class BoundingBoxGizmo {
  readonly group: THREE.Group;
  private readonly faceMesh: THREE.Mesh;
  private readonly faceMaterial: THREE.MeshBasicMaterial;
  private readonly edgeOutlineMesh: THREE.Mesh;
  private readonly edgeFillMesh: THREE.Mesh;
  private readonly edgeOutlineMaterial: THREE.ShaderMaterial;
  private readonly edgeFillMaterial: THREE.ShaderMaterial;

  constructor() {
    this.group = new THREE.Group();
    this.group.userData.isSelectionVisual = true;
    this.group.visible = false;
    this.group.matrixAutoUpdate = true;

    const faceGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.faceMaterial = new THREE.MeshBasicMaterial({
      color: FILL_COLOR,
      transparent: true,
      opacity: FILL_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.faceMesh = new THREE.Mesh(faceGeometry, this.faceMaterial);
    this.faceMesh.userData.isSelectionVisual = true;
    this.faceMesh.frustumCulled = false;
    this.faceMesh.renderOrder = 996;

    const edgeGeometry = buildFatLineGeometry();
    this.edgeOutlineMaterial = buildFatLineMaterial(EDGE_OUTLINE_COLOR, EDGE_OUTLINE_WIDTH_PIXELS);
    this.edgeFillMaterial = buildFatLineMaterial(EDGE_COLOR, EDGE_WIDTH_PIXELS);

    this.edgeOutlineMesh = new THREE.Mesh(edgeGeometry, this.edgeOutlineMaterial);
    this.edgeFillMesh = new THREE.Mesh(edgeGeometry, this.edgeFillMaterial);
    for (const mesh of [this.edgeOutlineMesh, this.edgeFillMesh]) {
      mesh.userData.isSelectionVisual = true;
      mesh.frustumCulled = false;
    }
    this.edgeOutlineMesh.renderOrder = 997;
    this.edgeFillMesh.renderOrder = 998;

    this.group.add(this.faceMesh, this.edgeOutlineMesh, this.edgeFillMesh);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /** Sizes/positions the cube to exactly match `bounds` - no padding, per
   * the toggle's own spec: the box mesh's own local space is a unit cube
   * from -0.5..0.5, so a non-uniform scale to `bounds`' own size plus a
   * translation to its center reproduces `bounds` exactly. Both the fill
   * and the edges share this same scale/position (only their materials
   * differ), and the fat-line shader's pixel-width math is unaffected by
   * this non-uniform local scale - it derives width purely from each
   * segment's own PROJECTED screen-space endpoints, computed after this
   * transform (and the group's own, see syncTransform()) is fully
   * applied, not from any local/object-space distance. */
  setBounds(bounds: Bounds): void {
    const size = bounds.max.clone().sub(bounds.min);
    const center = bounds.min.clone().add(bounds.max).multiplyScalar(0.5);
    const safeSize = new THREE.Vector3(Math.max(size.x, 1e-5), Math.max(size.y, 1e-5), Math.max(size.z, 1e-5));

    this.faceMesh.scale.copy(safeSize);
    this.faceMesh.position.copy(center);
    this.edgeOutlineMesh.scale.copy(safeSize);
    this.edgeOutlineMesh.position.copy(center);
    this.edgeFillMesh.scale.copy(safeSize);
    this.edgeFillMesh.position.copy(center);
  }

  /** Mirrors the content group's current scale/quaternion/position onto
   * this gizmo's group - see this class's own doc comment for why the
   * gizmo isn't simply parented under the content group instead. Cheap
   * enough (a few vector/quaternion copies) to call unconditionally every
   * frame from a beforeRender hook, same as the selection outline mask's
   * own per-frame sync. */
  syncTransform(contentGroup: THREE.Object3D | null): void {
    this.group.scale.setScalar(contentGroup?.scale.x ?? 1);
    this.group.quaternion.copy(contentGroup?.quaternion ?? new THREE.Quaternion());
    this.group.position.copy(contentGroup?.position ?? new THREE.Vector3());
  }

  /** Keeps the fat-line shaders' pixel-width math correct as the canvas is
   * resized - call once a frame (cheap: two uniform writes per material)
   * or at minimum after every resize. `width`/`height` should be the
   * renderer's DRAWING BUFFER size (i.e. already multiplied by device
   * pixel ratio), matching what the shader's own screen-space math
   * expects to divide clip-space coordinates by. */
  setResolution(width: number, height: number): void {
    this.edgeOutlineMaterial.uniforms.uResolution.value.set(width, height);
    this.edgeFillMaterial.uniforms.uResolution.value.set(width, height);
  }

  dispose(): void {
    this.faceMesh.geometry.dispose();
    this.faceMaterial.dispose();
    this.edgeOutlineMesh.geometry.dispose(); // shared with edgeFillMesh - dispose once
    this.edgeOutlineMaterial.dispose();
    this.edgeFillMaterial.dispose();
  }
}
