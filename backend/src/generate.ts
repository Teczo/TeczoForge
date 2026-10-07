import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { buildWorkflow, loadPreset } from "./presets.js";
import { downloadOutput, queueWorkflow, waitForOutput } from "./comfyui.js";
import { saveJob } from "./db.js";

// Finished images are saved here: data/outputs at the root of the repo.
export const OUTPUTS_DIR = path.join(import.meta.dirname, "..", "..", "data", "outputs");

// POST /api/generate
// Body: { "presetId": "text-to-image-basic", "inputs": { "prompt": "a red car" } }
// Answer: { "imageUrl": "/api/outputs/<file name>" }, plus "warning" if the job was not saved.
// Every call is saved as one job in MongoDB, also when it fails.
export async function generateHandler(req: Request, res: Response) {
  const startedAt = new Date();
  const { presetId, inputs } = req.body ?? {};
  // Until the inputs are checked, save them as they were sent.
  let jobInputs: unknown = inputs ?? {};

  try {
    // 1. Load the preset and put the user's values into its workflow.
    const { preset, workflow } = await loadPreset(presetId);
    const built = buildWorkflow(preset, workflow, inputs ?? {});
    jobInputs = built.usedValues;

    // 2. Send it to ComfyUI and wait for the result.
    const promptId = await queueWorkflow(built.workflow);
    const [file] = await waitForOutput(promptId, preset.output.node);

    // 3. Copy the image into data/outputs.
    const image = await downloadOutput(file);
    const fileName = `${presetId}-${Date.now()}${path.extname(file.filename)}`;
    await mkdir(OUTPUTS_DIR, { recursive: true });
    await writeFile(path.join(OUTPUTS_DIR, fileName), image);
    const imageUrl = `/api/outputs/${fileName}`;

    // 4. Save the job. If MongoDB is offline, we still return the image, with a warning.
    const warning = await saveJob({
      presetId,
      inputs: jobInputs,
      status: "done",
      outputFile: `data/outputs/${fileName}`,
      imageUrl,
      error: null,
      durationMs: Date.now() - startedAt.getTime(),
      createdAt: startedAt,
    });

    res.json(warning ? { imageUrl, warning } : { imageUrl });
  } catch (error) {
    let status = 500;
    let message = "Something went wrong on the server. See the backend log.";
    if (error instanceof HttpError) {
      status = error.status;
      message = error.message;
    } else {
      console.error("Generate failed:", error);
    }

    const warning = await saveJob({
      presetId: typeof presetId === "string" ? presetId : null,
      inputs: jobInputs,
      status: "failed",
      outputFile: null,
      imageUrl: null,
      error: message,
      durationMs: Date.now() - startedAt.getTime(),
      createdAt: startedAt,
    });

    res.status(status).json(warning ? { error: message, warning } : { error: message });
  }
}
