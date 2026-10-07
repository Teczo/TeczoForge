import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { buildWorkflow, loadPreset } from "./presets.js";
import { downloadOutput, queueWorkflow, waitForOutput } from "./comfyui.js";
import { saveJob } from "./db.js";
import { endJob, setJobPrompt, startJob } from "./progress.js";

// A job id made by the page with crypto.randomUUID(), used to ask for progress.
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Finished images and videos are saved here: data/outputs at the root of the repo.
export const OUTPUTS_DIR = path.join(import.meta.dirname, "..", "..", "data", "outputs");

// POST /api/generate
// Body: { "presetId": "text-to-image-basic", "inputs": { "prompt": "a red car" }, "jobId": "<optional uuid>" }
// With a jobId, the page can follow the job at GET /api/progress/<jobId>.
// Answer: { "imageUrl": "/api/outputs/<file name>" }, plus "warning" if the job was not saved.
// For a video preset the file is an .mp4. The name stays "imageUrl" so older jobs keep working.
// Every call is saved as one job in MongoDB, also when it fails.
export async function generateHandler(req: Request, res: Response) {
  const startedAt = new Date();
  const { presetId, inputs, jobId } = req.body ?? {};
  // Who started the job (set by requireLogin in auth.ts).
  const createdBy: string | null = res.locals.username ?? null;
  // Until the inputs are checked, save them as they were sent.
  let jobInputs: unknown = inputs ?? {};
  const tracked = typeof jobId === "string" && JOB_ID_PATTERN.test(jobId);
  if (tracked) startJob(jobId);

  try {
    if (jobId !== undefined && !tracked) {
      throw new HttpError(400, "jobId must be a UUID, for example from crypto.randomUUID().");
    }

    // 1. Load the preset and put the user's values into its workflow.
    const { preset, workflow } = await loadPreset(presetId);
    const built = buildWorkflow(preset, workflow, inputs ?? {});
    jobInputs = built.usedValues;

    // 2. Send it to ComfyUI and wait for the result.
    const promptId = await queueWorkflow(built.workflow);
    if (tracked) setJobPrompt(jobId, promptId);
    const [file] = await waitForOutput(promptId, preset.output.node);

    // 3. Copy the image or video into data/outputs (it keeps ComfyUI's extension, for example .png or .mp4).
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
      createdBy,
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
      createdBy,
    });

    res.status(status).json(warning ? { error: message, warning } : { error: message });
  } finally {
    // The page has its answer now, so stop tracking progress for this job.
    if (tracked) endJob(jobId);
  }
}
