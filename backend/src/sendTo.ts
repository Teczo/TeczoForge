import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { loadPreset } from "./presets.js";
import type { Preset } from "./presets.js";
import { findJob, findUsedIn } from "./db.js";
import type { Job } from "./db.js";
import { JOB_ID_PATTERN, sendError } from "./jobs.js";
import { createDraft } from "./drafts.js";
import { copyOutputToInputs } from "./upload.js";
import { extractLastFrame, findVideoJob } from "./lastFrame.js";

// "Send to" (FRG-26): use a finished picture as the start image of another preset.
// Any preset with an image input can receive a picture, so a new preset folder shows up in the
// menu with no code change. The picture is copied into data/inputs and ComfyUI's input folder,
// and the new job or card remembers where it came from (sourceJobId).

const MAX_TITLE_LENGTH = 100;

function checkJobId(value: unknown): string {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value)) throw new HttpError(400, "This is not a job id.");
  return value;
}

// POST /api/send-to
// Body: { "jobId": "<a finished picture>", "presetId": "image-to-video-basic", "target": "generate" | "board" }
// "generate": answer { presetId, inputs, sourceJobId } to fill the Generate form (nothing starts).
// "board": make a card in the Ready column, answer { card }. Its prompt is still empty: the user
// writes it with Edit, and the card cannot run before that.
export async function sendToHandler(req: Request, res: Response) {
  try {
    const { jobId, presetId, target } = req.body ?? {};
    const sourceJobId = checkJobId(jobId);
    if (target !== "generate" && target !== "board") throw new HttpError(400, 'target must be "generate" or "board".');

    if (target === "generate") {
      const { source, preset, inputs } = await sendToInputs(sourceJobId, presetId);
      res.json({ presetId: preset.id, inputs, sourceJobId: source.id });
      return;
    }
    const card = await sendToBoard(sourceJobId, presetId, res.locals.username ?? null); // Set by requireLogin in auth.ts.
    res.status(201).json({ card });
  } catch (error) {
    sendError(res, error);
  }
}

// Check a "Send to" and copy the picture: the finished job, the preset, and the inputs with the
// picture as the start image.
async function sendToInputs(sourceJobId: string, presetId: unknown): Promise<{ source: Job; preset: Preset; inputs: Record<string, unknown> }> {
  const source = await findJob(sourceJobId);
  if (!source) throw new HttpError(404, "There is no job with this id.");
  if (source.status !== "done" || !source.imageUrl) throw new HttpError(409, "Only a finished picture can be sent.");

  const { preset } = await loadPreset(presetId);
  const imageInput = preset.inputs.find((input) => input.kind === "image");
  if (!imageInput) throw new HttpError(400, `The preset "${preset.name}" has no start image.`);

  // Copy the picture (videos are refused here) into data/inputs and ComfyUI's input folder.
  const picture = await copyOutputToInputs(source.imageUrl, true);
  return { source, preset, inputs: { [imageInput.key]: picture.name } };
}

// "Send to -> board": a card in Ready with the finished picture as its start image. Also used by
// games (FRG-69): approving a model's reference picture makes its 3D card this way.
// The card is named after the menu item and the picture, for example "Animate: Cozy bookshop".
// Its prompt (if the preset has one) is still empty: the user writes it with Edit.
export async function sendToBoard(sourceJobId: string, presetId: unknown, createdBy: string | null): Promise<Job> {
  const { source, preset, inputs } = await sendToInputs(sourceJobId, presetId);
  const label = preset.sendToLabel || preset.name;
  const from = source.title ?? String((source.inputs as Record<string, unknown>)?.prompt ?? "a picture");
  const toWrite = preset.inputs.filter((input) => input.kind === "text" && input.default === undefined);
  return await createDraft({
    presetId: preset.id,
    inputs,
    title: `${label}: ${from}`.slice(0, MAX_TITLE_LENGTH),
    column: "ready",
    createdBy,
    sourceJobId, // The card goes into the same project as this job (FRG-40, see createDraft).
    allowEmptyText: true,
    ...(toWrite.length > 0
      ? { error: `Write the ${toWrite.map((input) => input.label.toLowerCase()).join(" and ")} with Edit, then press Generate.` }
      : {}),
  });
}

// POST /api/jobs/<id>/extend  ("Extend video", FRG-54)
// Continue a finished video from its last frame. Nothing starts: the answer fills the Generate form.
// Answer: { presetId, inputs, parentJobId }: the same preset and values as the clip (prompt,
// duration, ...), with its last frame as the start image and no seed, so a new random seed is used.
export async function extendHandler(req: Request, res: Response) {
  try {
    const parent = await findVideoJob(String(req.params.id));
    // Check the preset before the frame is saved, so a refused clip leaves no file behind.
    const { preset } = await loadPreset(parent.presetId);
    const imageInput = preset.inputs.find((input) => input.kind === "image");
    if (!imageInput) {
      throw new HttpError(400, `This video was made with "${preset.name}", which has no start image, so it cannot be extended.`);
    }

    const frame = await extractLastFrame(parent.id);
    // Keep only the values the preset still has, and leave out the seed.
    const old = (parent.inputs ?? {}) as Record<string, unknown>;
    const inputs: Record<string, unknown> = {};
    for (const input of preset.inputs) {
      if (input.kind !== "seed" && old[input.key] !== undefined) inputs[input.key] = old[input.key];
    }
    inputs[imageInput.key] = frame.name;
    res.json({ presetId: preset.id, inputs, parentJobId: parent.id });
  } catch (error) {
    sendError(res, error);
  }
}

// GET /api/jobs/<id>/used-in
// Answer: { "jobs": [...] }: the jobs and cards made from this job's result with "Send to".
export async function usedInHandler(req: Request, res: Response) {
  try {
    const jobs = await findUsedIn(checkJobId(req.params.id));
    res.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        presetId: job.presetId,
        status: job.status,
        title: job.title ?? null,
        imageUrl: job.imageUrl,
        createdAt: job.createdAt,
      })),
    });
  } catch (error) {
    sendError(res, error);
  }
}
