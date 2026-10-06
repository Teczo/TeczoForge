# ComfyUI setup on System 1

Last checked: 2026-10-06

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

Note: the Download button in ComfyUI saves files through the browser.
Check that each file ends up in the folder listed above.

## First test (text to image)

- Template: `image_z_image_turbo` (Z-Image-Turbo)
- Settings: 1024 x 1024, 8 steps
- First run (models loading): 7.86 seconds
- Second run (models already loaded): 2.71 seconds
- Speed: about 3.5 steps per second
- Model memory loaded: about 19.6 GB in total

## Problems found during setup

1. Claude Code could not start the `.bat` file itself. Jaya starts ComfyUI by hand.
2. First start failed with `WinError 4551` on `torch\lib\shm.dll`
   ("An Application Control policy has blocked this file").
   - Cause: Windows Smart App Control was On.
   - Fix used: NOT CONFIRMED. Jaya to fill in
     (Smart App Control turned off, or only the Unblock-File command).
   - If this error returns, check Smart App Control first.

## Not done yet

- Image-to-video test (time and VRAM).
- Workflow export in API format to `presets/text-to-image-basic/workflow.json`.
