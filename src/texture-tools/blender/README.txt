RenderDoc Scene Fixer - height maps for Blender
================================================

1. Extract this whole .zip into a folder.
2. In Blender: File > Import > glTF 2.0, and pick the .glb you exported
   together with this zip.
3. Switch to the Scripting workspace, Text > Open, pick apply_height_maps.py
   from the extracted folder, and press Run Script (the play button).

Done. Every object that has a height map now has a Displacement node wired to
its material and a Subdivision modifier. The height maps are packed into your
.blend, so you can move or delete the extracted folder afterwards.

If the result is too flat or too spiky, change RELIEF at the top of the script
and run it again (it replaces its own nodes). Displacement is visible in the
Cycles render engine, or in EEVEE on Blender 4.2 and newer.

height_maps.json lists which object gets which PNG. The PNGs are 16-bit
grayscale: black = lowest point, white = highest.
