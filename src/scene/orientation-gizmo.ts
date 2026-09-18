import * as THREE from "three";

// Pixel size doubles as the SVG viewBox size, so there's no separate unit
// conversion to keep in sync.
const SIZE = 96;
const CENTER = SIZE / 2;
const RADIUS = 32;
const HANDLE_RADIUS_POSITIVE = 8;
const HANDLE_RADIUS_NEGATIVE = 6;

interface AxisSpec {
  dir: THREE.Vector3;
  label: string;
  color: string;
  positive: boolean;
}

// Standard X=red/Y=green/Z=blue convention, one entry per direction so
// each end of an axis can be styled (and depth-sorted) independently.
const AXES: AxisSpec[] = [
  { dir: new THREE.Vector3(1, 0, 0), label: "X", color: "#e2564a", positive: true },
  { dir: new THREE.Vector3(-1, 0, 0), label: "X", color: "#e2564a", positive: false },
  { dir: new THREE.Vector3(0, 1, 0), label: "Y", color: "#74c952", positive: true },
  { dir: new THREE.Vector3(0, -1, 0), label: "Y", color: "#74c952", positive: false },
  { dir: new THREE.Vector3(0, 0, 1), label: "Z", color: "#4a90d9", positive: true },
  { dir: new THREE.Vector3(0, 0, -1), label: "Z", color: "#4a90d9", positive: false },
];

/** A small always-visible compass, drawn as a plain SVG overlay in the
 * corner of the viewport, showing which way each world axis currently
 * points relative to the camera - a lightweight stand-in for the
 * "navigation gizmo" familiar from Blender/CAD viewers. This project
 * deliberately avoids three.js's own examples/addons (see SceneManager's
 * class doc comment), so this is hand-rolled SVG rather than a second
 * WebGL viewport rendered via scissor/viewport tricks - cheaper, and it
 * composites with the rest of the DOM UI (z-index, etc.) for free.
 *
 * Pure readout: it only reflects camera orientation, never accepts
 * input, and deliberately ignores camera POSITION entirely (it's a
 * compass, not a minimap) - see update(). */
export class OrientationGizmo {
  readonly element: HTMLDivElement;
  private readonly lines: SVGLineElement[] = [];
  private readonly circles: SVGCircleElement[] = [];
  private readonly labels: SVGTextElement[] = [];
  private readonly projectionLabel: HTMLDivElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "orientation-gizmo";

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute("width", String(SIZE));
    svg.setAttribute("height", String(SIZE));

    // Faint reference ring - purely decorative, gives the handles a
    // "sphere" to sit on.
    const ring = document.createElementNS(svgNS, "circle");
    ring.setAttribute("cx", String(CENTER));
    ring.setAttribute("cy", String(CENTER));
    ring.setAttribute("r", String(RADIUS));
    ring.setAttribute("class", "orientation-gizmo-ring");
    svg.appendChild(ring);

    // One line + circle + label per axis direction, created once and
    // just repositioned every frame in update() - cheaper than rebuilding
    // the DOM every frame, and keeps element identity (and thus any
    // hover/focus state, if this ever grows any) stable.
    for (const axis of AXES) {
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("class", "orientation-gizmo-axis-line");
      line.setAttribute("stroke", axis.color);
      svg.appendChild(line);
      this.lines.push(line);

      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("r", String(axis.positive ? HANDLE_RADIUS_POSITIVE : HANDLE_RADIUS_NEGATIVE));
      circle.setAttribute("fill", axis.positive ? axis.color : "transparent");
      circle.setAttribute("stroke", axis.color);
      circle.setAttribute("stroke-width", "1.5");
      svg.appendChild(circle);
      this.circles.push(circle);

      const text = document.createElementNS(svgNS, "text");
      text.textContent = axis.positive ? axis.label : "";
      text.setAttribute("class", "orientation-gizmo-label");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      svg.appendChild(text);
      this.labels.push(text);
    }

    this.element.appendChild(svg);

    this.projectionLabel = document.createElement("div");
    this.projectionLabel.className = "orientation-gizmo-projection";
    this.element.appendChild(this.projectionLabel);
  }

  /** Shows which projection is currently active (e.g. "Perspective" /
   * "Orthographic") underneath the compass - not orientation exactly,
   * but the other half of "what am I currently looking through", and
   * cheap to surface here since SceneManager already owns both. */
  setProjectionLabel(text: string): void {
    this.projectionLabel.textContent = text;
  }

  /** Recomputes every axis handle's screen position from the camera's
   * current orientation. Call once a frame. */
  update(camera: THREE.Camera): void {
    const inverseRotation = camera.quaternion.clone().invert();

    const projected = AXES.map((axis, index) => {
      // Camera-space coordinates of this world axis: x/y map directly to
      // screen right/up (SVG's y grows downward, so that's flipped
      // below), and z is "toward the camera" - i.e. how near vs. far
      // this end of the axis currently is, used for depth ordering,
      // fading, and (implicitly) nothing else.
      const v = axis.dir.clone().applyQuaternion(inverseRotation);
      return { index, x: CENTER + v.x * RADIUS, y: CENTER - v.y * RADIUS, depth: v.z };
    });
    // Farthest first, so - as each handle below gets moved to the end of
    // its parent - nearer handles end up drawn last, i.e. on top,
    // wherever two overlap on screen.
    projected.sort((a, b) => a.depth - b.depth);

    for (const { index, x, y, depth } of projected) {
      const axis = AXES[index];
      const line = this.lines[index];
      const circle = this.circles[index];
      const label = this.labels[index];

      // appendChild on an already-attached node just moves it - this is
      // what gives the depth ordering above an effect on paint order.
      line.parentNode?.appendChild(line);
      circle.parentNode?.appendChild(circle);
      label.parentNode?.appendChild(label);

      if (axis.positive) {
        line.setAttribute("x1", String(CENTER));
        line.setAttribute("y1", String(CENTER));
        line.setAttribute("x2", String(x));
        line.setAttribute("y2", String(y));
        line.style.opacity = "1";
      } else {
        // Only the positive ends get a spoke drawn to center - the
        // negative ends are just the dim hollow circles at the far side
        // of the same lines.
        line.style.opacity = "0";
      }

      circle.setAttribute("cx", String(x));
      circle.setAttribute("cy", String(y));
      // Ends pointing toward the camera (depth near +1) read as
      // "nearest" and get full opacity; ends pointing away fade out -
      // the same depth cue Blender's own gizmo uses.
      circle.style.opacity = String(0.35 + 0.65 * ((depth + 1) / 2));

      label.setAttribute("x", String(x));
      label.setAttribute("y", String(y));
      label.style.opacity = axis.positive ? "1" : "0";
    }
  }
}
