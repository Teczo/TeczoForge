import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { getBatchesCollection, safeMessage, updateDraft } from "./db.js";
import type { Job } from "./db.js";
import { onJobDone, sendError } from "./jobs.js";
import { createDraft } from "./drafts.js";
import { sendToBoard } from "./sendTo.js";
import { listPresets } from "./presets.js";
import { addCardsToBatch, createBatch } from "./batches.js";

// "Time test" (FRG-76): measure how long each preset takes, so the time estimate (estimate.ts) has
// history for every preset it can test.
// 1. A batch (batches.ts) with one Text to Image card and a fixed simple prompt.
// 2. When that picture is done: one card for each preset with a start image (3D, Edit Image,
//    Image to Image, Image to Video), made from the picture with "Send to" (sendTo.ts), added to
//    the same batch. Their text inputs get fixed simple text, so they can run without Edit.
// 3. After that, the estimate uses the new finished jobs by itself.
// A preset with no start image and no Text to Image (music) is not tested.

const PICTURE_PRESET = "text-to-image-basic";
const TEST_PROMPT = "one red wooden chair, three-quarter view, plain white background, soft even light";
// Fixed text for the text inputs of the follow-up cards, by preset type.
const EDIT_TEXT = "make the chair blue, keep everything else the same";
const MOTION_TEXT = "the chair stands still while the camera slowly moves around it";

// POST /api/time-test
// Body: { "projectId": "<optional, default Unsorted>" }. Starts the Time test batch.
// Only one Time test can be running or paused at a time. Answer: the batch.
export async function timeTestHandler(req: Request, res: Response) {
  try {
    const createdBy: string | null = res.locals.username ?? null; // Set by requireLogin in auth.ts.
    const running = await (await getBatchesCollection())
      .findOne({ "owner.type": "time-test", state: { $in: ["running", "paused"] } })
      .catch(() => {
        throw new HttpError(503, "The Time test needs MongoDB, which cannot be reached right now.");
      });
    if (running) throw new HttpError(409, "A Time test is already running. Wait for it, or end it in its batch bar.");

    const projectId = req.body?.projectId;
    const card = await createDraft({
      presetId: PICTURE_PRESET,
      inputs: { prompt: TEST_PROMPT },
      title: "Time test: Text to Image",
      column: "ready",
      ...(projectId !== undefined ? { projectId } : {}),
      createdBy,
    });
    const batch = await createBatch({
      name: "Time test",
      cardIds: [card.id],
      projectId: card.projectId,
      owner: { type: "time-test", id: card.id },
      createdBy,
    });
    res.status(201).json(batch);
  } catch (error) {
    sendError(res, error);
  }
}

// The Time test picture is done: add one card per preset with a start image to its batch.
async function addFollowUpCards(picture: Job) {
  const batch = await (await getBatchesCollection()).findOne({ "owner.type": "time-test", "owner.id": picture.id }, { projection: { _id: 0 } });
  // Not a Time test picture, or the follow-up cards were already added, or the test was ended.
  if (!batch || batch.cardIds.length > 1 || batch.state === "ended") return;

  const presets = (await listPresets()).filter((preset) => preset.inputs.some((input) => input.kind === "image"));
  const cardIds: string[] = [];
  for (const preset of presets) {
    try {
      const card = await sendToBoard(picture.id, preset.id, batch.createdBy);
      // Fill the text inputs the user would write with Edit, so the card can run as it is.
      const inputs = { ...(card.inputs as Record<string, unknown>) };
      for (const input of preset.inputs) {
        if (input.kind !== "text" || input.default !== undefined || (inputs[input.key] ?? "") !== "") continue;
        inputs[input.key] = preset.type === "edit" ? EDIT_TEXT : preset.type === "video" ? MOTION_TEXT : TEST_PROMPT;
      }
      await updateDraft(card.id, { inputs, error: null });
      cardIds.push(card.id);
    } catch (error) {
      console.warn(`Warning: the Time test card for "${preset.id}" could not be made. ${error instanceof HttpError ? error.message : safeMessage(error)}`);
    }
  }
  if (cardIds.length > 0) await addCardsToBatch(batch.id, cardIds);
}

onJobDone((job) => {
  if (job.presetId !== PICTURE_PRESET) return;
  addFollowUpCards(job).catch((error) =>
    console.warn(`Warning: the Time test could not go on after job ${job.id}. ${error instanceof HttpError ? error.message : safeMessage(error)}`),
  );
});
