import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { buildWorkflow, loadPreset } from "./presets.js";
import { downloadOutput, queueWorkflow, waitForOutput } from "./comfyui.js";

// Finished images are saved here: data/outputs at the root of the repo.
export const OUTPUTS_DIR = path.join(import.meta.dirname, "..", "..", "data", "outputs");

// POST /api/generate
// Body: { "presetId": "text-to-image-basic", "inputs": { "prompt": "a red car" } }
// Answer: { "imageUrl": "/api/outputs/<file name>" }
export async function generateHandler(req: Request, res: Response) {
  try {
    const { presetId, inputs } = req.body ?? {};

    // 1. Load the preset and put the user's values into its workflow.
    const { preset, workflow } = await loadPreset(presetId);
    const filledWorkflow = buildWorkflow(preset, workflow, inputs ?? {});

    // 2. Send it to ComfyUI and wait for the result.
    const promptId = await queueWorkflow(filledWorkflow);
    const [file] = await waitForOutput(promptId, preset.output.node);

    // 3. Copy the image into data/outputs.
    const image = await downloadOutput(file);
    const fileName = `${presetId}-${Date.now()}${path.extname(file.filename)}`;
    await mkdir(OUTPUTS_DIR, { recursive: true });
    await writeFile(path.join(OUTPUTS_DIR, fileName), image);

    res.json({ imageUrl: `/api/outputs/${fileName}` });
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
    } else {
      console.error("Generate failed:", error);
      res.status(500).json({ error: "Something went wrong on the server. See the backend log." });
    }
  }
}
