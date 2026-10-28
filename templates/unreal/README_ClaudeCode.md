# {CODE}_Forge: models and pictures for {NAME}

This folder was written by TeczoForge (pack "{NAME}", code `{CODE}`). It holds the picked 3D models and
pictures of the pack. Claude Code: read all of this before you import anything.

## 1. You may import these files

These are Teczo's own generated files, made on Teczo's own PC with TeczoForge. They are not store assets.
You may import them into the Unreal project.

## 2. Read the manifest first

1. Read `forge_manifest.json` first. It lists every item of the pack.
2. Find each item by its `id` (for example `VEG-01`). Use the `path` from the manifest.
3. Never guess file names. If an item is not in the manifest, ask Jaya.

## 3. Import

1. Import the `.glb` files directly. Unreal 5.8 imports glTF, so no Blender step is needed.
2. Turn Nanite on for every mesh.
3. Scale each model so its size matches `real_size` in the manifest. Metres × 100 = Unreal centimetres.
   Measure the model's bounds after import, then scale. Do not guess the scale from the file.
4. Put the pivot at the bottom centre.
5. Use simple box collision, or none.
6. The pictures in `_Pictures/` are the pictures each model was made from. Use them as a reference for colours.

## 4. Missing and skipped items

1. `missing` items have no file yet (`path` is `null`). Skip them, and give Jaya a list of their ids.
2. `skip` items are built by hand, for example in Unreal with Modeling Tools. Read their `notes`.

## 5. Do not change this folder

Do not rename or move files in this folder. TeczoForge overwrites them on the next export.
Copy files into the Unreal project instead.

## 6. Keep a record

Add the rows from `forge_record.md` to the project's ASSETS.md.
