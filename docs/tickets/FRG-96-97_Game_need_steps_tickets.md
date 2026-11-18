# TeczoForge Studio — Games: background removal and tiling steps (FRG-96 to FRG-97)

Tickets that let TeczoForge do two "to do by hand" jobs itself. Run them in order, one at a time.
Each ticket follows `CLAUDE.md` (git rules, definition of done, report format).

**Wroom is not connected right now.** This file takes its place. Treat each ticket below
exactly like a Wroom ticket. FRG-96 and FRG-97 follow the last used ticket (FRG-95).
If Wroom is used again later, Jaya adds these tickets there with the same numbers.

**Goal of the whole feature:** in a game design file, an image asset can list `needs`.
Today every need shows "To do by hand" on the Games page. After these tickets:

1. `transparent_bg`: TeczoForge removes the background itself, as an extra step after the picture.
2. `tiling`: TeczoForge makes the texture seamless itself, as an extra step after the picture.
3. `rigging` and `animation` stay "To do by hand". They are not part of these tickets.

**Why now:** the four NEWTON game files have 28 assets with `transparent_bg` and 15 with `tiling`.

**What is already there (checked on 18 Nov 2026)**

1. ComfyUI 0.39.0 has background removal built in: nodes `LoadBackgroundRemovalModel` and
   `RemoveBackground` (file `comfy_extras/nodes_bg_removal.py`). No custom node is needed.
2. The model `birefnet.safetensors` is already in `models/background_removal/`.
3. The preset `image-to-3d-trellis2` already uses these two nodes (workflow nodes 192 and 193).
4. A model asset already has two steps: picture, then 3D. The 3D step takes the approved picture
   of step 1 as its input (`games.ts`, `currentStepIndex` and the approve route). The new steps
   work the same way.
5. ComfyUI has no ready-made "seamless tiling" node. FRG-97 needs a workflow that Jaya builds first.

**Rules for all tickets**

1. No new npm dependency.
2. Do not create or edit any `workflow.json`. Jaya makes and tests workflows in ComfyUI
   (CLAUDE.md section 6). If a preset folder is missing, stop and ask.
3. Do not install, start, stop or change ComfyUI or its custom nodes (CLAUDE.md section 7 rule 6).
4. Do not change how model assets, music, Packs, Generate, Avatar or Translate work.
5. Do not change asset steps that are already approved, or delete any file in `data/`.
6. If something fails 2 times with the same error, stop and report. Do not keep retrying.
7. If a ticket and `CLAUDE.md` disagree, `CLAUDE.md` wins. Say so in the report.

---

## Before FRG-96 — Jaya makes the preset `image-remove-bg`

Not a code ticket. Jaya does this in ComfyUI.

1. Build this workflow with built-in nodes only:
   `Load Image` → `Load Background Removal Model` (birefnet.safetensors) → `Remove Background`
   → `Join Image with Alpha` (image + mask) → `Save Image`.
2. Test it with one icon picture. The saved PNG must have a see-through background.
3. Export it in API format to `presets/image-remove-bg/workflow.json`.
4. Write `presets/image-remove-bg/preset.json`. One input: `image` (kind `image`). No prompt.
   Use `presets/image-to-3d-trellis2/preset.json` as the example for an image-only preset.

---

## FRG-96 — Need steps, and the background removal step

**Branch:** `feat/FRG-96-game-need-steps-remove-bg`

**Goal:** An image asset with `transparent_bg` gets a second step that removes the background.
The step runs by itself after Jaya approves the picture. The Games page no longer says
"To do by hand: Transparent background" for it.

**Check before coding**

1. `presets/image-remove-bg/` exists and loads with `loadPreset`. If not, stop and ask Jaya.
2. Find where the 3D step of a model gets the approved picture of step 1. If this happens in more
   than one place, stop and ask.
3. Find which output the export (`gameExport.ts`) uses for an asset: the first step or the last step.
   Write the answer in the report.

**In scope**

1. In `gameFile.ts`, one small list that links a need to a preset:
   `transparent_bg` → `image-remove-bg`, `tiling` → `texture-make-tileable`.
   1. Only for picture types (texture, sprite, background, ui, icon). Models are left alone:
      the 3D preset already removes the background.
   2. A need gets a step only if its preset folder exists. If not, the need stays "To do by hand",
      exactly as today. (So `tiling` stays by hand until FRG-97.)
   3. If an asset has both needs: tiling step first, then background step.
2. The new step takes the approved output of the step before it as its `image` input.
   Reuse the code the 3D step uses. Do not write a second copy of it.
3. The export uses the output of the LAST approved step (the PNG with a see-through background).
   If the export uses the first step today, change it so that every asset uses its last step.
   If that would change how models export, stop and report.
4. Games page (`GamesPage.tsx`):
   1. A need that has a TeczoForge step does not show "To do by hand".
   2. The step shows with a clear name, for example "Step 2: Remove background".
   3. `rigging` and `animation` still show "To do by hand".
5. Games imported before this ticket: a script `npm run games-add-steps` (in `backend/package.json`).
   1. It adds the missing need steps to assets with status `planned` only.
   2. Assets that are already started or approved: it lists them and changes nothing.
   3. It prints every change in plain English, for example
      "NBE_ICO_Marks_Star: added step Remove background".
   4. Running it twice changes nothing the second time.
6. In `docs/game-design-format.md`, the `needs` line says: `transparent_bg` and `tiling` are done by
   TeczoForge when their preset is installed. `rigging` and `animation` are always done by hand.

**Out of scope:** tiling (FRG-97), rigging and animation, Unity import settings, any new preset.

**Exit criteria**

1. Import a small test game file with one icon that has `transparent_bg`. The asset has 2 steps.
2. Approve the picture. The background step starts by itself. Its result has a see-through
   background on the grey frame, in both light and dark mode.
3. With the folder `presets/image-remove-bg/` renamed for a moment, import still works and the
   label "To do by hand: Transparent background" shows as before.
4. Assets with `rigging` or `animation` look exactly as before.
5. `npm run games-add-steps` on the NBE, NBO, NFA and NRR games adds the step to planned assets
   with `transparent_bg`, and prints the list. A second run changes nothing.
6. The export puts the see-through PNG in `Icons/{Category}/`. Model exports still have the .glb.
7. `tsc --noEmit` passes in backend and frontend. No new dependency.

**Stop and report if:** the preset folder is missing, the step-input code is in more than one
place, or changing the export would change how models export.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## Before FRG-97 — Jaya makes the preset `texture-make-tileable`

Not a code ticket. Jaya does this in ComfyUI. This is a test first: if the result is not good,
stop here. Tiling then stays "To do by hand", and FRG-97 is not started.

A suggested method ("shift and repaint"), with built-in nodes:

1. `Load Image`.
2. Shift the picture by half its width and half its height, so the outer edges meet in the middle.
   Use `Image Crop` (cut into 4 pieces) and `Image Stitch` (put them back in swapped order).
3. Make a mask: a cross through the middle, about one eighth of the picture wide.
4. Repaint only the masked cross with the image model (`Inpaint Model Conditioning` → sampler
   → `VAE Decode`). Use a low denoise so the rest of the picture stays the same.
5. `Save Image`.

Test: put the result 2 × 2 next to itself in any image viewer. No line or jump should be visible.
Then export to `presets/texture-make-tileable/workflow.json` and write its `preset.json`
(input `image`, and `seed` if the workflow has one).

---

## FRG-97 — The tiling step

**Branch:** `feat/FRG-97-game-tiling-step`

**Goal:** A texture with `tiling` gets a step that makes it seamless. Jaya can see a tiled preview
to check for seams before approving.

**Check before coding:** `presets/texture-make-tileable/` exists and loads with `loadPreset`.
If not, stop and ask Jaya.

**In scope**

1. Confirm the need list from FRG-96 already adds the tiling step now that the preset exists.
   Fix it only if it does not.
2. A "Tiled preview" on the result of a tiling step: the picture shown 2 × 2, using CSS
   `background-repeat`. Theme colours only (CLAUDE.md section 15).
3. Run `npm run games-add-steps`. It adds the tiling step to planned assets with `tiling`.

**Out of scope:** Unity wrap mode settings, any change to the background removal step.

**Exit criteria**

1. A test texture with `tiling` has a tiling step. After the picture is approved, it runs by itself.
2. The tiled preview shows the picture 2 × 2. Jaya sees no seam on a good result.
3. `npm run games-add-steps` adds the tiling step to the planned NEWTON textures, and prints them.
4. The export puts the seamless texture in `Textures/{Category}/`.
5. `tsc --noEmit` passes in backend and frontend. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## Later (not tickets yet)

1. Unity import settings: the editor script `templates/unity/Editor/TeczoForgeImporter.cs` could
   read `needs` from the asset manifest. It could then turn on "Alpha Is Transparency" for
   `transparent_bg` and set wrap mode "Repeat" for `tiling`.
2. Rigging and animation: done outside TeczoForge (Meshy or Mixamo).
