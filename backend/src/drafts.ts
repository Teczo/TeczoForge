import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { buildWorkflow, loadPreset } from "./presets.js";
import { ensureStartImages, inputFilesFor } from "./inputs.js";
import { claimDraft, deleteDraft, findBoardJob, insertDraft, listBoardJobs, updateDraft } from "./db.js";
import type { DraftColumn, Job } from "./db.js";
import { activeJobs, follow, JOB_ID_PATTERN, sendError, sendToComfyUI } from "./jobs.js";

// The board (FRG-22).
// A card is a job with status "draft": a preset, its inputs and a title. It is saved but not run.
// Running a draft turns the same record into a normal queued job (see jobs.ts).
// Drafts live in MongoDB only. When MongoDB is offline the board shows a message (see db.ts).
// There are no roles: everyone on the team can add, edit, move, run and delete drafts.

const MAX_TITLE_LENGTH = 100;
// How many finished cards the Done column shows.
const DONE_LIMIT = 30;

function checkTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim() === "") {
    throw new HttpError(400, "A card needs a title.");
  }
  if (title.trim().length > MAX_TITLE_LENGTH) {
    throw new HttpError(400, `The title is too long. Maximum is ${MAX_TITLE_LENGTH} characters.`);
  }
  return title.trim();
}

function checkColumn(column: unknown): DraftColumn {
  if (column !== "idea" && column !== "ready") {
    throw new HttpError(400, 'column must be "idea" or "ready".');
  }
  return column;
}

// The same checks as POST /api/jobs. The draft keeps the inputs as typed, so a card
// without a seed gets a new random seed each time it runs.
// With allowEmptyText, a text input may still be empty (a "Send to" card, FRG-26): the user writes
// it later with Edit. Running the card checks everything again, so it cannot run without it.
async function checkInputs(presetId: unknown, inputs: unknown, allowEmptyText = false): Promise<Record<string, unknown>> {
  const { preset, workflow } = await loadPreset(presetId);
  const values = (inputs ?? {}) as Record<string, unknown>;
  let toCheck: unknown = values;
  if (allowEmptyText && typeof values === "object" && !Array.isArray(values)) {
    // Check the other values with a stand-in for each empty text.
    const filled = { ...values };
    for (const input of preset.inputs) {
      if (input.kind === "text" && (filled[input.key] ?? "") === "") filled[input.key] = "(to be written)";
    }
    toCheck = filled;
  }
  buildWorkflow(preset, workflow, toCheck);
  return values;
}

// The kept start images of a card's inputs (FRG-25).
async function cardInputFiles(presetId: unknown, inputs: Record<string, unknown>): Promise<string[]> {
  const { preset } = await loadPreset(presetId);
  return inputFilesFor(preset, inputs);
}

function checkId(req: Request): string {
  const id = String(req.params.id);
  if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, "This is not a card id.");
  return id;
}

// A clear answer for a card id that is not (or no longer) a draft.
async function notADraft(id: string, action: string): Promise<HttpError> {
  const job = await findBoardJob(id);
  if (!job) return new HttpError(404, "There is no card with this id.");
  return new HttpError(409, `This card has already run, so it cannot be ${action}.`);
}

// Check and save a new draft. Also used by the chat when Claude makes a card (chatTools.ts).
// Throws an HttpError with a clear message if a value is wrong.
export async function createDraft(fields: {
  presetId: unknown;
  inputs: unknown;
  title: unknown;
  column?: unknown;
  createdBy: string | null;
  conversationId?: string;
  sourceJobId?: string;
  allowEmptyText?: boolean;
  error?: string; // A note shown on the new card.
}): Promise<Job> {
  const inputs = await checkInputs(fields.presetId, fields.inputs, fields.allowEmptyText);
  const inputFiles = await cardInputFiles(fields.presetId, inputs);
  const draft: Job = {
    id: crypto.randomUUID(),
    presetId: fields.presetId as string,
    inputs,
    status: "draft",
    promptId: null,
    outputFile: null,
    imageUrl: null,
    error: fields.error ?? null,
    durationMs: 0,
    createdAt: new Date(),
    createdBy: fields.createdBy,
    title: checkTitle(fields.title),
    column: fields.column === undefined ? "idea" : checkColumn(fields.column),
    ...(fields.conversationId ? { conversationId: fields.conversationId } : {}),
    ...(inputFiles.length > 0 ? { inputFiles } : {}),
    ...(fields.sourceJobId ? { sourceJobId: fields.sourceJobId } : {}),
  };
  await insertDraft(draft);
  return draft;
}

// POST /api/drafts
// Body: { "presetId": "...", "inputs": { ... }, "title": "...", "column": "idea" (default) }
// Answer: the new draft.
export async function createDraftHandler(req: Request, res: Response) {
  try {
    const { presetId, inputs, title, column } = req.body ?? {};
    // createdBy is set by requireLogin in auth.ts.
    const draft = await createDraft({ presetId, inputs, title, column, createdBy: res.locals.username ?? null });
    res.status(201).json(draft);
  } catch (error) {
    sendError(res, error);
  }
}

// PATCH /api/drafts/<id>
// Body: any of { "title", "inputs", "column" }. Only while the card is a draft.
// New inputs are checked like POST /api/jobs, and clear the card's last error.
export async function updateDraftHandler(req: Request, res: Response) {
  try {
    const id = checkId(req);
    const { title, inputs, column } = req.body ?? {};
    const fields: Partial<Job> = {};
    if (title !== undefined) fields.title = checkTitle(title);
    if (column !== undefined) fields.column = checkColumn(column);
    if (inputs !== undefined) {
      const draft = await findBoardJob(id);
      if (!draft || draft.status !== "draft") throw await notADraft(id, "edited");
      fields.inputs = await checkInputs(draft.presetId, inputs);
      fields.inputFiles = await cardInputFiles(draft.presetId, fields.inputs as Record<string, unknown>);
      fields.error = null;
    }
    if (Object.keys(fields).length === 0) {
      throw new HttpError(400, "Send a title, inputs or column to change.");
    }
    if (!(await updateDraft(id, fields))) throw await notADraft(id, "edited");
    res.json(await findBoardJob(id));
  } catch (error) {
    sendError(res, error);
  }
}

// DELETE /api/drafts/<id>
// Deletes a draft. A card that has run is never deleted.
export async function deleteDraftHandler(req: Request, res: Response) {
  try {
    const id = checkId(req);
    if (!(await deleteDraft(id))) throw await notADraft(id, "deleted");
    res.json({ deleted: id });
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/drafts/<id>/run
// Checks the inputs again, then queues the card like POST /api/jobs.
// Answer: { "jobId": "<the card id>" }. If the inputs are wrong, the card keeps the error.
export async function runDraftHandler(req: Request, res: Response) {
  let id: string;
  try {
    id = checkId(req);
  } catch (error) {
    sendError(res, error);
    return;
  }

  try {
    const draft = await findBoardJob(id);
    if (!draft || draft.status !== "draft") throw await notADraft(id, "run again");

    // 1. Check the inputs again (the preset may have changed since the card was made).
    //    Start images must be in ComfyUI's input folder; a missing one is uploaded again (FRG-25).
    let built;
    let inputFiles: string[];
    try {
      const { preset, workflow } = await loadPreset(draft.presetId);
      built = await ensureStartImages(preset, workflow, buildWorkflow(preset, workflow, draft.inputs));
      inputFiles = await inputFilesFor(preset, built.usedValues);
    } catch (error) {
      if (error instanceof HttpError) await updateDraft(id, { error: error.message });
      throw error;
    }

    // 2. Turn the draft into a queued job in one step, so it can never run twice.
    //    The inputs now include the seed that is used, like any other job.
    const job = await claimDraft(id, {
      status: "queued",
      inputs: built.usedValues,
      ...(inputFiles.length > 0 ? { inputFiles } : {}),
      promptId: null,
      error: null,
      createdAt: new Date(), // The job starts now. This also keeps the time taken right.
    });
    if (!job) throw await notADraft(id, "run again");

    // 3. Send it to ComfyUI and answer, like POST /api/jobs.
    await sendToComfyUI(follow(job), built.workflow, res);
  } catch (error) {
    sendError(res, error);
  }
}

// GET /api/board
// Answer: { "cards": [...] }: all drafts, every waiting or running job (with "progress"),
// and the newest finished jobs that started as a card.
export async function boardHandler(_req: Request, res: Response) {
  try {
    const { drafts, done } = await listBoardJobs(DONE_LIMIT);
    res.json({ cards: [...drafts, ...activeJobs(), ...done] });
  } catch (error) {
    sendError(res, error);
  }
}
