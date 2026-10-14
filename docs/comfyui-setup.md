# ComfyUI setup on System 1

Last checked: 2026-10-07

## Install

- Install path: `C:\AI\ComfyUI_windows_portable\`
- Type: official Windows portable build (NVIDIA)
- Source: `github.com/Comfy-Org/ComfyUI` (the old `comfyanonymous/ComfyUI` address redirects here)
- ComfyUI version: 0.39.0
- PyTorch: 2.14.0 with CUDA 13.0
- Python: 3.13.14 (bundled inside the portable folder)
- Unpacked with Windows built-in `tar.exe`. 7-Zip is not installed.
- No custom nodes were added. No ComfyUI-Manager.

## Hardware seen by ComfyUI

- GPU: NVIDIA GeForce RTX 5090, 32,607 MB VRAM (driver 595.79)
- RAM: 128,627 MB
- Log line: `Device: cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync`

## How to start

Open PowerShell and run:

```powershell
cd C:\AI\ComfyUI_windows_portable
.\run_nvidia_gpu.bat
```

- It must be started from that folder. Starting it from another folder fails with "The system cannot find the path specified".
- Double-clicking `run_nvidia_gpu.bat` in File Explorer also works.
- Wait for: `To see the GUI go to: http://127.0.0.1:8188`
- Keep the window open. Closing it stops ComfyUI.
- To stop: press `Ctrl + C` in that window.

## Address

- `http://127.0.0.1:8188`
- It listens on this PC only. Do not change this (see CLAUDE.md section 7).

## Models installed

All inside `C:\AI\ComfyUI_windows_portable\ComfyUI\models\`.

| File | Folder | Size |
|---|---|---|
| `z_image_turbo_bf16.safetensors` | `diffusion_models\` | 11.46 GB |
| `qwen_3_4b.safetensors` | `text_encoders\` | 7.49 GB |
| `ae.safetensors` | `vae\` | 319.8 MB |
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | `diffusion_models\` | 13.31 GB |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | `diffusion_models\` | 13.31 GB |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `text_encoders\` | 6.27 GB |
| `wan_2.1_vae.safetensors` | `vae\` | 0.24 GB |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | `loras\` | 1.14 GB |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | `loras\` | 1.14 GB |
| `flux-2-klein-4b-fp8.safetensors` | `diffusion_models\` | 4.07 GB |
| `flux2-vae.safetensors` | `vae\` | 336.2 MB |

Note: the Download button in ComfyUI saves files through the browser.
Check that each file ends up in the folder listed above.

## First test (text to image)

- Template: `image_z_image_turbo` (Z-Image-Turbo)
- Settings: 1024 x 1024, 8 steps
- First run (models loading): 7.86 seconds
- Second run (models already loaded): 2.71 seconds
- Speed: about 3.5 steps per second
- Model memory loaded: about 19.6 GB in total

## Image-to-video test (FRG-13)

Date: 2026-10-07. Model chosen by Jaya: Wan 2.2 14B image to video (option A).

- Template: "Wan 2.2 14B Image to Video" (`video_wan2_2_14B_i2v`). No custom nodes needed.
- Jaya ran it once by hand in ComfyUI and exported it with Workflow > Export (API).
  It is the preset `presets/image-to-video-basic/` (workflow.json is the unchanged export).
- Settings in the export: 640 x 640, 81 frames at 16 fps (5 seconds), 20 steps
  (10 high-noise + 10 low-noise), cfg 3.5. The template's 4-step speed-up switch is **off**.
- Measured by Claude Code through the ComfyUI API, start image: the red car (1024 x 1024),
  models already in memory from Jaya's run. VRAM is the whole GPU (`nvidia-smi`), sampled every 0.5 s.

| Run | Time | GPU memory before | Peak GPU memory |
|---|---|---|---|
| As exported (20 steps), run 1 | 268.8 s | 15.9 GB | 29.8 GB |
| As exported (20 steps), run 2 | 265.8 s | 15.4 GB | 28.6 GB |
| Test copy with the 4-step speed-up switch on (not saved) | 32.8 s | 15.9 GB | 30.6 GB |

- Peak use is about 29 to 31 GB of the 32.6 GB VRAM. Close other GPU-heavy programs while making videos.
- Output: an `.mp4` file of about 1.5 MB in `ComfyUI\output\video\`.
- The first run after starting ComfyUI is slower, because about 30 GB of models must load. Not measured.

## Image-to-video fast preset (FRG-33)

Date: 2026-10-11. Preset `presets/image-to-video-fast/`.

- Jaya opened the Wan 2.2 image-to-video workflow in ComfyUI, turned the 4-step LightX2V switch **on**
  ("Enable 4steps LoRA?"), ran it, and exported it with Workflow > Export (API). workflow.json is the unchanged export.
- Settings: 640 x 640, 81 frames at 16 fps (5 seconds), 4 steps (2 high-noise + 2 low-noise), cfg 1,
  with the LoRAs `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise` and `..._low_noise`. Still two sampler passes (`"stages": 2`).
- Measured by Jaya, plus one check run:

| Run | Time | Peak GPU memory |
|---|---|---|
| First run, including model loading | 36.72 s | 28.8 GB |
| Check run by Claude Code through the preset (app's own input checks, then ComfyUI API), 2026-10-11 | 38.5 s | not measured |

- About 7 times faster than the basic preset (about 266 s). `estimatedSeconds` in preset.json is 37.

## Video duration for the Wan image-to-video presets (FRG-52)

Date: 2026-10-14. Both Wan image-to-video presets have a Duration input: 3, 5 (default) or 7 seconds.
The backend writes seconds x 16 + 1 frames (49, 81 or 113) into `length` of the WanImageToVideo node (`129:98`).

- Measured by Claude Code: the workflow was built by the app's own code (`buildWorkflow`), then sent to the
  ComfyUI API. 640 x 640, 16 fps, a new seed for each run. VRAM is the whole GPU (`nvidia-smi`), sampled every 0.5 s.
- Frame counts were checked by decoding each output file: 49, 81 and 113 frames, exactly as chosen.

| Preset | Length | Run | Time | GPU memory before | Peak GPU memory |
|---|---|---|---|---|---|
| Fast | 7 s (113 frames) | Run 1, including model loading | 60.5 s | 1.4 GB | 28.6 GB |
| Fast | 7 s (113 frames) | Run 2 | 52.3 s | 22.5 GB | 29.2 GB |
| Fast | 3 s (49 frames) | For comparison | 17.5 s | 22.6 GB | 31.4 GB |
| Fast | 5 s (81 frames) | For comparison | 34.0 s | 26.0 GB | 31.4 GB |
| Normal (20 steps) | 7 s (113 frames) | Run 1, right after the Fast runs | 468.0 s | 24.3 GB | 30.9 GB |

- 7 s did not run out of memory on either preset, so all three lengths stay.
- 7 s takes about 1.5 to 1.75 times as long as 5 s (Fast: 52 s against 34 to 37 s; Normal: 468 s against about 266 s).
- Peak GPU memory is about the same for every length (29 to 31 GB), because ComfyUI keeps models loaded
  as long as memory allows. It does not show how much memory each length needs.
- The page scales `estimatedSeconds` by the chosen length (Fast, 7 s: about 52 s, which matches the measurement).

## Image edit preset: FLUX.2 klein 4B (FRG-34)

Date: 2026-10-12. Preset `presets/image-edit-klein/` ("Edit Image").

- Template: "Image Edit (Flux.2 Klein 4B Distilled)" (`image_flux2_klein_image_edit_4b_distilled`). No custom nodes needed.
- Licence: Apache 2.0, so client work is OK. Use only the **4B** files. The 9B files have a non-commercial licence.
  The text encoder `qwen_3_4b.safetensors` is the same file Z-Image uses.
- Jaya ran it in ComfyUI and exported it with Workflow > Export (API). workflow.json is the unchanged export.
  It still holds the template's unused second Load Image (node `81`). It is not connected to anything, so ComfyUI skips it.
- Settings: 4 steps, cfg 1, start image scaled to about 1 megapixel. The result has the start image's shape.
- Measured by Claude Code through the preset in the app. Start image: the red paper boat (1024 x 1024),
  instruction "make the sky a sunset. Keep the paper boat, the water and the trees as they are."
  VRAM is the whole GPU (`nvidia-smi`), sampled every 0.5 s.

| Run | Time | GPU memory before | Peak GPU memory |
|---|---|---|---|
| Run 1 (models moved back onto the GPU) | 4.6 s | 4.0 GB | 15.4 GB |
| Run 2 | 2.7 s | 14.2 GB | 16.9 GB |
| Same picture with Z-Image "Image to Image", for comparison | 8.6 s | 2.4 GB | 22.6 GB |

- Result: klein changed only the sky (and its reflection in the water). The boat, water and trees stayed the same.
- Z-Image image to image redraws the whole picture from a full description. On the same picture the sky only turned
  a little pink, and the boat was redrawn. For "change one thing" requests, klein is the better choice.

## Problems found during setup

1. Claude Code could not start the `.bat` file itself. Jaya starts ComfyUI by hand.
2. First start failed with `WinError 4551` on `torch\lib\shm.dll`
   ("An Application Control policy has blocked this file").
   - Cause: Windows Smart App Control was On.
   - Fix used: Jaya turned Smart App Control off
     (Windows Security > App & browser control > Smart App Control settings).
   - If this error returns, check that Smart App Control is still off.

## Not done yet

- Showing videos in the app. This is ticket FRG-14.
