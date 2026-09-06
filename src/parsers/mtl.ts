import type { MTLMaterial } from "../types";

/** Parses the MTL subset the exporter writes: newmtl/map_Kd/bump. */
export function parseMTL(text: string): Record<string, MTLMaterial> {
  const materials: Record<string, MTLMaterial> = {};
  let current: MTLMaterial | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const parts = line.split(/\s+/);

    if (parts[0] === "newmtl") {
      current = { name: parts.slice(1).join(" ") };
      materials[current.name] = current;
    } else if (current && parts[0] === "map_Kd") {
      current.mapKd = parts.slice(1).join(" ");
    } else if (current && (parts[0] === "bump" || parts[0] === "map_Bump")) {
      current.bump = parts.slice(1).join(" ");
    }
  }

  return materials;
}
