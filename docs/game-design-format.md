# Game design file format (teczoforge-game/1)

A game design file is a `.md` file. Jaya plans a game in Claude chat and gets this file,
then imports it into TeczoForge. TeczoForge plans every asset from it.

The file has free prose (for Claude Code) and exactly ONE ```json block with
`"schema": "teczoforge-game/1"`. JSON is used (not YAML) so no new dependency is needed.

The backend checks a file with `POST /api/games/check` (see `backend/src/gameFile.ts`).
A full example is in `docs/examples/sky-runner.game.md`.

## FORMAT (teczoforge-game/1)

- game.code: 3 capital letters. game.name: 1-60 chars. game.dimension: "2D"|"3D". game.pipeline: "URP"|"HDRP"|"BuiltIn". game.style: required, max 300 chars, added to the start of every image prompt. game.palette: optional, max 6 hex colours, added as "colour palette: ...".
- assets: 1 to 150. Each: id (required, unique, max 64), type, category (PascalCase, must equal part 3 of id), prompt (required, max 2000), use (required, max 200), optional size [w,h] (image types), target_height_m (models, default 1), duration_s (music), source "forge"(default)|"external", needs: any of rigging, animation, transparent_bg, tiling.
- id pattern {CODE}_{TYPECODE}_{Category}_{Name}[_{Variant}], regex ^[A-Z]{3}_(MDL|TEX|SPR|BG|UI|ICO|MUS|SFX)_[A-Z][A-Za-z0-9]*_[A-Z][A-Za-z0-9]*(_[A-Z0-9][A-Za-z0-9]*)?$ . CODE must equal game.code.
- type -> TYPECODE -> export folder -> preset:
  model MDL Models/{Category}/ : text-to-image-basic (reference image) then image-to-3d-trellis2 (.glb)
  texture TEX Textures/{Category}/ : text-to-image-basic
  sprite SPR Sprites/{Category}/ : text-to-image-basic
  background BG Backgrounds/{Category}/ : text-to-image-basic
  ui UI UI/{Category}/ : text-to-image-basic
  icon ICO Icons/{Category}/ : text-to-image-basic
  music MUS Audio/Music/{Category}/ : music-ace-step-xl
  sfx SFX Audio/SFX/{Category}/ : external only in v1 (error if source is not external)
- Concept art is made by TeczoForge, not listed in the file: {CODE}_REF_Style_Concept, exported to _Reference/.
- Model reference prompt: "{style}, {prompt}, single object, centred, full view from the front, plain white background, no shadow".
