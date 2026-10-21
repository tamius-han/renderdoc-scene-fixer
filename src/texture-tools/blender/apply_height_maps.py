"""
Applies the height maps exported by RenderDoc Scene Fixer to the objects you
imported from the matching .glb.

HOW TO USE
  1. Import the .glb  (File > Import > glTF 2.0).
  2. Open this script in Blender's Scripting workspace (Text > Open) and press
     Run Script. That's it - no need to keep this folder next to your .blend
     afterwards, the height maps get packed into it.

For every object listed in height_maps.json this script:
  * loads the object's height map (as Non-Color data, packed into the .blend),
  * adds  Image Texture > Displacement > Material Output (Displacement),
  * switches the material to true displacement (Displacement Only / Bump too),
  * adds a Subdivision modifier so there is geometry to displace.
Running it again is safe: it replaces its own nodes/modifier instead of
stacking new ones.

Displacement needs Cycles, or EEVEE in Blender 4.2 or newer.
"""
import json
import os
import re

import bpy

# ---------------------------------------------------------------------------
# Settings - tweak these, then run again.
# ---------------------------------------------------------------------------

# Folder containing height_maps.json and the PNGs. Leave empty to auto-detect
# (next to this script, or next to the .blend file).
HEIGHT_MAP_FOLDER = ""

# Total height of the relief (black to white), as a fraction of each object's
# largest dimension. 0.02 = a 100-unit-tall object gets 2 units of relief.
RELIEF = 0.02

# Add a Subdivision modifier so there is geometry for the height map to move.
# "Simple" keeps the original shape; it only adds vertices. Note that each
# level multiplies the face count by 4 - lower these if Blender gets slow.
ADD_SUBDIVISION = True
SUBDIVISION_VIEWPORT_LEVELS = 1
SUBDIVISION_RENDER_LEVELS = 3

# ---------------------------------------------------------------------------

MAPPING_FILE = "height_maps.json"
NODE_LABEL = "Height map (RenderDoc Scene Fixer)"
MODIFIER_NAME = "Height map subdivision"
BLENDER_NAME_LIMIT = 63  # Blender truncates object names to this many characters


def find_folder():
    candidates = []
    if HEIGHT_MAP_FOLDER:
        candidates.append(bpy.path.abspath(HEIGHT_MAP_FOLDER))
    try:
        candidates.append(os.path.dirname(os.path.abspath(__file__)))
    except NameError:  # running from Blender's text editor
        pass
    for text in bpy.data.texts:  # a script opened from disk knows its path
        if text.filepath:
            candidates.append(os.path.dirname(bpy.path.abspath(text.filepath)))
    if bpy.data.filepath:
        candidates.append(os.path.dirname(bpy.data.filepath))
    for folder in candidates:
        if os.path.isfile(os.path.join(folder, MAPPING_FILE)):
            return folder
    raise RuntimeError(
        "Could not find %s. Set HEIGHT_MAP_FOLDER at the top of this script to the "
        "folder you extracted the .zip into. Looked in: %s" % (MAPPING_FILE, candidates or "nowhere")
    )


def strip_duplicate_suffix(name):
    # Blender renames clashing names "Name.001", "Name.002", ...
    return re.sub(r"\.\d{3,}$", "", name)


def remove_previous_setup(material):
    tree = material.node_tree
    for node in [n for n in tree.nodes if n.label == NODE_LABEL]:
        tree.nodes.remove(node)


def find_output_node(tree):
    outputs = [n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"]
    for node in outputs:
        if getattr(node, "is_active_output", False):
            return node
    return outputs[0] if outputs else None


def enable_true_displacement(material):
    # Blender 4.2+ moved this setting from material.cycles to the material.
    try:
        if hasattr(material, "displacement_method"):
            material.displacement_method = "BOTH"
        elif hasattr(material, "cycles") and hasattr(material.cycles, "displacement_method"):
            material.cycles.displacement_method = "BOTH"
    except Exception as error:  # never let a version quirk abort the whole run
        print("  could not set displacement method on %s: %s" % (material.name, error))


def apply_height_map(material, image, scale):
    try:
        material.use_nodes = True  # deprecated (always on) in newer Blender
    except Exception:
        pass
    tree = material.node_tree
    output = find_output_node(tree)
    if output is None:
        print("  material %s has no Material Output node - skipped" % material.name)
        return False

    remove_previous_setup(material)

    texture = tree.nodes.new("ShaderNodeTexImage")
    texture.label = NODE_LABEL
    texture.image = image
    texture.interpolation = "Linear"
    texture.extension = "REPEAT"
    texture.location = (output.location.x - 700, output.location.y - 400)

    displacement = tree.nodes.new("ShaderNodeDisplacement")
    displacement.label = NODE_LABEL
    displacement.inputs["Midlevel"].default_value = 0.5
    displacement.inputs["Scale"].default_value = scale
    displacement.location = (output.location.x - 300, output.location.y - 400)

    tree.links.new(texture.outputs["Color"], displacement.inputs["Height"])
    tree.links.new(displacement.outputs["Displacement"], output.inputs["Displacement"])
    enable_true_displacement(material)
    return True


def add_subdivision(obj):
    modifier = obj.modifiers.get(MODIFIER_NAME)
    if modifier is None:
        modifier = obj.modifiers.new(MODIFIER_NAME, "SUBSURF")
    modifier.subdivision_type = "SIMPLE"
    modifier.levels = SUBDIVISION_VIEWPORT_LEVELS
    modifier.render_levels = SUBDIVISION_RENDER_LEVELS


def load_height_image(folder, file_name, cache):
    if file_name not in cache:
        path = os.path.join(folder, file_name)
        if not os.path.isfile(path):
            print("  missing height map file: %s" % path)
            cache[file_name] = None
        else:
            image = bpy.data.images.load(path, check_existing=True)
            image.colorspace_settings.name = "Non-Color"  # height is data, not colour
            image.pack()  # keeps the .blend working without this folder
            cache[file_name] = image
    return cache[file_name]


def main():
    folder = find_folder()
    with open(os.path.join(folder, MAPPING_FILE), encoding="utf-8") as handle:
        mapping = json.load(handle)["objects"]
    lookup = {name[:BLENDER_NAME_LIMIT]: file_name for name, file_name in mapping.items()}

    images = {}
    done_materials = {}  # material -> height map file it was set up with
    objects_done = 0

    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            continue
        file_name = lookup.get(strip_duplicate_suffix(obj.name)) or lookup.get(strip_duplicate_suffix(obj.data.name))
        if not file_name:
            continue
        image = load_height_image(folder, file_name, images)
        if image is None:
            continue

        scale = max(obj.dimensions) * RELIEF if max(obj.dimensions) > 0 else RELIEF
        for slot in obj.material_slots:
            material = slot.material
            if material is None:
                continue
            if material in done_materials and done_materials[material] != file_name:
                # Two objects share a material but need different height maps:
                # give this one its own copy.
                material = material.copy()
                slot.material = material
            if done_materials.get(material) == file_name:
                continue
            if apply_height_map(material, image, scale):
                done_materials[material] = file_name

        if ADD_SUBDIVISION:
            add_subdivision(obj)
        objects_done += 1

    print("Height maps applied to %d object(s), %d material(s)." % (objects_done, len(done_materials)))
    if objects_done == 0:
        print("No objects matched. Did you import the .glb exported together with this zip?")


main()
