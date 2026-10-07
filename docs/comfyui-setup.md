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
