# {NAME} ({CODE}): assets from TeczoForge

This folder was exported by TeczoForge. It holds the art and audio for the Unity game
**{NAME}** (game code `{CODE}`, render pipeline `{PIPELINE}`).
These are the instructions for Claude Code. Follow them when you use these assets.

## 1. Read the manifest first

- Read `asset_manifest.json` before you do anything with these assets.
- Find every asset by its `id`, and use its `path` from the manifest.
  Never guess a file name or a folder.
- The ids also appear in the game design file `{CODE}_GameDesign.md` in this folder.
  The design file says what each asset is for. The manifest says where its file is.

## 2. Do not change this folder

- Do not rename, move or edit any file in this folder.
- TeczoForge overwrites these files every time Jaya exports the game again.
  Your changes would be lost, and the ids in the manifest would no longer match.
- If you need a changed copy of an asset, put it somewhere else in the project.
- TeczoForge never deletes files here, so Unity's `.meta` files stay.

## 3. 3D models (.glb)

- `.glb` files need the Unity package `com.unity.cloud.gltfast` (glTFast).
  Check `Packages/manifest.json`. If it is missing, install it with the Package Manager
  (Add package by name: `com.unity.cloud.gltfast`).
- Scale each model so its height in the scene is its `target_height_m` (in metres) from the manifest.
  Measure the model's bounds after import, then set the scale. Do not guess the scale.

## 4. Assets that are not ready

- Some assets have `"status": "missing"` and `"path": null`. They are not approved in TeczoForge yet.
- For each missing asset, use a grey placeholder named exactly after its `id`:
  for example a grey cube for a model, a grey square sprite for a sprite or icon, or silence for audio.
  When Jaya exports again, the real file appears at the path in the new manifest. Then swap it in.
- `"status": "external"` means the asset is made by hand outside TeczoForge, so it has no file here.
  Use a placeholder named after its `id` too, and tell Jaya it is still needed.

## 5. Needs: work that is not done yet

- An asset's `needs` list (`rigging`, `animation`, `transparent_bg`, `tiling`) is work that is NOT done yet.
  For example, a sprite with `transparent_bg` still has a background.
- Do not pretend it is done. Make a list for Jaya: each asset id with its open needs.

## 6. Import settings

`Editor/TeczoForgeImporter.cs` sets the import settings by folder when Unity imports the files:

| Folder | Import settings |
|---|---|
| `Sprites/`, `UI/`, `Icons/` | Sprite (2D and UI) |
| `Backgrounds/` | Default, no mipmaps |
| `Textures/` | Default, with mipmaps |
| `Audio/Music/` | Streaming |
| `Audio/SFX/` | Decompress On Load |

It only acts inside this folder (a folder named `*_Assets` that holds `asset_manifest.json`).
The script runs on every import, so settings changed by hand in this folder are set back.
The script is overwritten by every export too. If an asset needs other settings, tell Jaya.
