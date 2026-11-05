# Pending preset: avatar-s2v-fast

Prepared by Claude chat on 2026-11-04. Not loaded by the app (it is in `docs/`, not `presets/`).
FRG-84 moves it into `presets/`. FRG-89 adds the longer files.

## Files

| File | Status | What it is |
|---|---|---|
| `workflow-15s.json` | here | Jaya's export of the ComfyUI template "Wan 2.2 14B Sound to Video" (`video_wan2_2_14B_s2v`), run once by Jaya. Unchanged. 3 parts (1 main + 2 Extend), about 14 s. |
| `workflow.json` | **missing** | Same export with both Extend parts removed (1 part, about 4.8 s). Jaya exports it. |
| `workflow-10s.json` | **missing** | Same export with one Extend part removed (2 parts, about 9.6 s). Jaya exports it. |
| `preset.json` | here (draft) | Node ids checked against `workflow-15s.json`. FRG-84 checks them again against `workflow.json`. |

## What the export contains

- 4-step LightX2V LoRA is **on** in the template itself (node `107`, `wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise`, strength 1). Steps 4 (node `103`), CFG 1 (node `105`).
- Chunk length 77 frames (node `104`), 640 x 640 (node `93`), 16 fps (node `82`).
- Inputs: face photo `52` (LoadImage), voice `58` (LoadAudio), prompt `6`, negative prompt `7` (kept as exported).
- Seeds: main sampler `3`. The Extend samplers `79:77` (seed 1) and `85:183` (seed 250) keep fixed seeds. Only `3` is a preset input.
- `96` (ImageFromBatch) drops the first 3 decoded frames (`100` = 3). FRG-83 measures the real frame count.
- Output: `113` (SaveVideo). `82` (CreateVideo) adds the **whole** voice file as sound, so the voice must be fitted to the video length (FRG-85).
- Sampler passes: 3 in this file, 2 in the 10 s file, 1 in the 5 s file (`stages` per file is set in FRG-89).
- `estimatedSeconds` is not set yet. FRG-83 measures it.
