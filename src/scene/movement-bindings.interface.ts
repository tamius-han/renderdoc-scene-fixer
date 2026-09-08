export interface MovementBindings {
  forward: string;
  back: string;
  left: string;
  right: string;
  up: string;
  down: string[];
  flyToggle: string;
}

export const ESDF_BINDINGS: MovementBindings = {
  forward: "KeyE",
  back: "KeyD",
  left: "KeyS",
  right: "KeyF",
  up: "Space",
  down: ["ControlLeft", "ControlRight"],
  flyToggle: "KeyA",
};

export const WASD_BINDINGS: MovementBindings = {
  forward: "KeyW",
  back: "KeyS",
  left: "KeyA",
  right: "KeyD",
  up: "Space",
  down: ["ControlLeft", "ControlRight"],
  flyToggle: "KeyF",
};
