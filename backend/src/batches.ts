import type { Request, Response } from "express";
import type { Collection } from "mongodb";
import { HttpError } from "./httpError.js";
import { findCards, getBatchesCollection, safeMessage } from "./db.js";
import type { Batch, BatchState, Job } from "./db.js";
import { activeJobs, CANCELLED_CARD_ERROR, cancelFollowedJob, findAnyJob, isActive, JOB_ID_PATTERN, onJobDone, sendError } from "./jobs.js";
import { runDraft } from "./drafts.js";
import { getQueue } from "./comfyui.js";
import { checkProjectId } from "./projects.js";
import { batchTimeLeft } from "./estimate.js";

// Batches (FRG-75).
// ComfyUI's queue cannot pause. So TeczoForge keeps the list of cards itself (a "batch"), and gives
// ComfyUI only one batch card at a time. Single jobs (Generate page, a Generate button on the board)
// still go straight to ComfyUI, so they run right after the current batch card.
// 1. The runner checks every 2 seconds, and when a job is done.
// 2. At most one batch card is in ComfyUI at any time, over all batches. The oldest batch goes first.
// 3. A running batch with no current card runs its next card that is still a draft (runDraft in drafts.ts).
// 4. A card that comes back to the board with an error runs once more. If it fails again, it is
//    "failed" and the batch goes on. A failed card never stops the batch.
// 5. ComfyUI not running is not a failure: the batch pauses with a note.
// 6. Pause: no new card starts; the running one finishes. Resume: go on with the next card.
//    Stop now: cancel the running card (it goes back to Ready and stays first) and pause.
//    End batch: stop for good; cards not run stay on the board.
// 7. When the backend starts, every running batch is paused (see pauseAfterRestart).
// Batches live in MongoDB only. When MongoDB is offline the routes answer 503 and nothing new starts.

const OFFLINE_MESSAGE = "Batches are not available because MongoDB cannot be reached.";

const CHECK_INTERVAL_MS = 2000;
// A card that fails this many times is "failed", and the batch goes on.
const MAX_TRIES = 2;
const MAX_NAME_LENGTH = 100;
const MAX_CARDS = 500;
// GET /api/batches
const LIST_LIMIT = 50;

const STATES: BatchState[] = ["running", "paused", "done", "ended"];

const COMFYUI_NOTE = "Paused: ComfyUI is not running. Start it, then press Resume.";
const RESTART_NOTE = "Paused because the backend restarted. Press Resume.";
const CANCELLED_NOTE = "Paused: the current card was cancelled on the board. Press Resume to run it again.";

// Run work on the batches collection. If MongoDB cannot be reached, throw the clear 503 message.
async function withBatches<T>(work: (batches: Collection<Batch>) => Promise<T>): Promise<T> {
  try {
    return await work(await getBatchesCollection());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn(`Warning: batches could not use MongoDB. ${safeMessage(error)}`);
    throw new HttpError(503, OFFLINE_MESSAGE);
  }
}

// The runner and the buttons take turns, so they never change the same batch at the same time.
let lock: Promise<unknown> = Promise.resolve();
function withBatchLock<T>(work: () => Promise<T>): Promise<T> {
  const result = lock.then(work);
  lock = result.catch(() => {});
  return result;
}

async function saveBatch(batch: Batch): Promise<void> {
  batch.updatedAt = new Date();
  await withBatches((batches) => batches.replaceOne({ id: batch.id }, { ...batch }));
}

async function loadBatch(id: string): Promise<Batch | null> {
  return withBatches((batches) => batches.findOne({ id }, { projection: { _id: 0 } }));
}

// The cards that are not done or failed yet, in order.
function cardsLeft(batch: Batch): string[] {
  return batch.cardIds.filter((id) => !batch.doneCardIds.includes(id) && !batch.failedCardIds.includes(id));
}

function pause(batch: Batch, note: string | null) {
  batch.state = "paused";
  batch.pausedAt = new Date();
  batch.note = note;
}

// The card failed once more: run it again, or (the second time) mark it failed.
function countFailure(batch: Batch, cardId: string) {
  batch.retries[cardId] = (batch.retries[cardId] ?? 0) + 1;
  if (batch.retries[cardId] >= MAX_TRIES) batch.failedCardIds.push(cardId);
}

// Every card is done or failed, and nothing is running: the batch is done.
function finishIfAllDone(batch: Batch) {
  if (batch.currentCardId || cardsLeft(batch).length > 0) return;
  batch.state = "done";
  batch.finishedAt = new Date();
  batch.note = null;
}

// ---- The runner ----

// What happened to the current card. Nothing changes while it is still waiting or running.
async function settleCurrent(batch: Batch): Promise<void> {
  const cardId = batch.currentCardId!;
  const card = await findAnyJob(cardId);
  if (card && isActive(card.status)) return;

  batch.currentCardId = null;
  if (card?.status === "done") {
    batch.doneCardIds.push(cardId);
  } else if (card?.status === "draft" && card.error === CANCELLED_CARD_ERROR) {
    // Cancelled on the board (Stop now clears currentCardId itself). Not a failure: it stays first in the list.
    if (batch.state === "running") pause(batch, CANCELLED_NOTE);
  } else if (card?.status === "draft") {
    countFailure(batch, cardId); // Back on the board with an error.
  } else {
    batch.failedCardIds.push(cardId); // The card was deleted.
  }
  finishIfAllDone(batch);
  await saveBatch(batch);
}

// Start the next card of a running batch with no current card. A card someone ran by hand from the
// board is followed like any other card. Returns true if a new job went to ComfyUI.
async function startNext(batch: Batch, slotFree: boolean, activeIds: Set<string>): Promise<boolean> {
  const left = cardsLeft(batch);
  const byHand = left.find((id) => activeIds.has(id));
  if (byHand) {
    batch.currentCardId = byHand;
    await saveBatch(batch);
    return false;
  }
  if (!slotFree && left.length > 0) return false;

  let started = false;
  for (const cardId of left) {
    const card = await findAnyJob(cardId);
    if (card?.status === "done") {
      batch.doneCardIds.push(cardId); // Already made, for example by hand.
      continue;
    }
    if (card?.status !== "draft") {
      batch.failedCardIds.push(cardId); // The card was deleted.
      continue;
    }

    // Ask ComfyUI first, so a closed ComfyUI never counts as a failure of the card.
    try {
      await getQueue();
    } catch {
      pause(batch, COMFYUI_NOTE);
      break;
    }
    try {
      const { failedStatus } = await runDraft(cardId);
      if (failedStatus === null) {
        batch.currentCardId = cardId;
        started = true;
      } else if (failedStatus === 503) {
        pause(batch, COMFYUI_NOTE); // ComfyUI stopped answering just now.
      } else {
        countFailure(batch, cardId); // ComfyUI said no, for example a missing model.
      }
    } catch (error) {
      // 409: someone pressed Generate on it just now (followed at the next check).
      // 503: MongoDB or ComfyUI did not answer. Try again at the next check.
      if (!(error instanceof HttpError && (error.status === 409 || error.status === 503))) {
        if (!(error instanceof HttpError)) console.error(`Batch card ${cardId} could not be started:`, error);
        countFailure(batch, cardId); // For example wrong inputs. The card shows the reason.
      }
    }
    break;
  }
  finishIfAllDone(batch);
  await saveBatch(batch);
  return started;
}

// When the backend starts: every running batch is paused. A job that was running is followed by
// the normal recovery in jobs.ts, and the batch still records how it ends.
let restartHandled = false;
async function pauseAfterRestart() {
  const now = new Date();
  const result = await withBatches((batches) =>
    batches.updateMany({ state: "running" }, { $set: { state: "paused", note: RESTART_NOTE, pausedAt: now, updatedAt: now } }),
  );
  if (result.modifiedCount > 0) console.log(`Batches: paused ${result.modifiedCount} batch(es) because the backend restarted.`);
  restartHandled = true;
}

async function checkBatches() {
  if (!restartHandled) await pauseAfterRestart();
  const batches = await withBatches((collection) =>
    collection.find({ state: { $in: ["running", "paused"] } }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray(),
  );
  // 1. What happened to each current card (also of paused batches: Pause lets the card finish).
  for (const batch of batches) if (batch.currentCardId) await settleCurrent(batch);

  // 2. Start new cards, oldest batch first, while no batch card is in ComfyUI.
  const activeIds = new Set(activeJobs().map((job) => job.id));
  let slotFree = !batches.some((batch) => batch.currentCardId && activeIds.has(batch.currentCardId));
  for (const batch of batches) {
    if (batch.state !== "running" || batch.currentCardId) continue;
    if (await startNext(batch, slotFree, activeIds)) slotFree = false;
  }
}

let checking = false;
let lastProblem = "";

// Run one check now, unless one is already running. Never throws: problems go to the log (once each).
function checkNow() {
  if (checking) return;
  checking = true;
  withBatchLock(checkBatches)
    .then(() => (lastProblem = ""))
    .catch((error) => {
      const problem = error instanceof HttpError ? error.message : safeMessage(error);
      if (problem !== lastProblem) console.warn(`Warning: checking batches failed. ${problem}`);
      lastProblem = problem;
    })
    .finally(() => (checking = false));
}

export function startBatchRunner() {
  setInterval(checkNow, CHECK_INTERVAL_MS);
}

// A job is done: maybe it was a batch card, so start the next card now, not at the next check.
onJobDone(() => checkNow());

// ---- Making batches ----

// The cards among these ids that are already in a running or paused batch, and not done or failed there.
export async function cardsInActiveBatches(ids: string[]): Promise<Set<string>> {
  const batches = await withBatches((collection) =>
    collection.find({ state: { $in: ["running", "paused"] }, cardIds: { $in: ids } }, { projection: { _id: 0 } }).toArray(),
  );
  const wanted = new Set(ids);
  return new Set(batches.flatMap((batch) => cardsLeft(batch)).filter((id) => wanted.has(id)));
}

// Check the cards of a new batch, or of cards added to one: ids, all drafts, in no other batch.
async function checkCardIds(cardIds: unknown): Promise<string[]> {
  if (!Array.isArray(cardIds) || cardIds.length === 0) throw new HttpError(400, "cardIds must be a list of card ids.");
  if (cardIds.length > MAX_CARDS) throw new HttpError(400, `A batch can have at most ${MAX_CARDS} cards.`);
  if (!cardIds.every((id) => typeof id === "string" && JOB_ID_PATTERN.test(id))) throw new HttpError(400, "cardIds must be a list of card ids.");
  const ids = [...new Set(cardIds as string[])];
  const cards = new Map((await findCards(ids)).map((card) => [card.id, card]));
  for (const id of ids) {
    const card = cards.get(id);
    if (!card) throw new HttpError(400, `There is no card with the id ${id}.`);
    if (card.status !== "draft") throw new HttpError(400, `The card "${card.title ?? id}" has already run. A batch can only have cards that have not run.`);
  }
  const taken = await cardsInActiveBatches(ids);
  if (taken.size > 0) {
    const titles = [...taken].map((id) => cards.get(id)?.title ?? id);
    throw new HttpError(400, `These cards are already in a batch: ${titles.join(", ")}.`);
  }
  return ids;
}

// Check and save a new batch, then start it. Used by POST /api/batches and by "Generate all" of a game.
export async function createBatch(fields: {
  name: unknown;
  cardIds: unknown;
  projectId?: unknown;
  owner?: Batch["owner"];
  createdBy: string | null;
}): Promise<Batch> {
  const { name } = fields;
  if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "A batch needs a name.");
  if (name.trim().length > MAX_NAME_LENGTH) throw new HttpError(400, `The name is too long. Maximum is ${MAX_NAME_LENGTH} characters.`);
  const projectId = fields.projectId === undefined || fields.projectId === null ? null : await checkProjectId(fields.projectId);

  const batch = await withBatchLock(async () => {
    const cardIds = await checkCardIds(fields.cardIds);
    const now = new Date();
    const made: Batch = {
      id: crypto.randomUUID(),
      name: name.trim(),
      projectId,
      owner: fields.owner ?? { type: null, id: null },
      state: "running",
      cardIds,
      currentCardId: null,
      retries: {},
      failedCardIds: [],
      doneCardIds: [],
      note: null,
      createdBy: fields.createdBy,
      createdAt: now,
      updatedAt: now,
      pausedAt: null,
      finishedAt: null,
    };
    await withBatches((batches) => batches.insertOne({ ...made })); // A copy: insertOne adds MongoDB's own _id.
    return made;
  });
  checkNow();
  return batch;
}

// Add cards to the end of a batch (used by packs, FRG-80). A done batch runs again for the new cards.
// Throws an HttpError if the batch was ended, or a card is wrong.
export async function addCardsToBatch(batchId: string, cardIds: string[]): Promise<Batch> {
  const batch = await withBatchLock(async () => {
    const found = await loadBatch(batchId);
    if (!found) throw new HttpError(404, "There is no batch with this id.");
    if (found.state === "ended") throw new HttpError(400, "This batch was ended, so no cards can be added.");
    const ids = await checkCardIds(cardIds.filter((id) => !found.cardIds.includes(id)));
    found.cardIds.push(...ids);
    if (found.state === "done") {
      found.state = "running";
      found.finishedAt = null;
    }
    await saveBatch(found);
    return found;
  });
  checkNow();
  return batch;
}

// ---- Routes ----

// POST /api/batches
// Body: { "name": "...", "cardIds": ["<card id>", ...], "projectId": "<optional>" }.
// Every card must be a draft that is in no other running or paused batch. The batch starts at once.
// Answer: the batch.
export async function createBatchHandler(req: Request, res: Response) {
  try {
    const { name, cardIds, projectId } = req.body ?? {};
    // createdBy is set by requireLogin in auth.ts.
    res.status(201).json(await createBatch({ name, cardIds, projectId, createdBy: res.locals.username ?? null }));
  } catch (error) {
    sendError(res, error);
  }
}

// GET /api/batches?state=running,paused
// state: one state or a list (running, paused, done, ended). Missing: all. Answer: { "batches": [...] },
// newest first, at most 50.
export async function listBatchesHandler(req: Request, res: Response) {
  try {
    const stateText = typeof req.query.state === "string" ? req.query.state : "";
    const states = stateText === "" ? [] : stateText.split(",");
    if (!states.every((state) => STATES.includes(state as BatchState))) {
      throw new HttpError(400, `state must be one or more of: ${STATES.join(", ")}.`);
    }
    const filter = states.length > 0 ? { state: { $in: states as BatchState[] } } : {};
    const batches = await withBatches((collection) =>
      collection.find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(LIST_LIMIT).toArray(),
    );
    res.json({ batches });
  } catch (error) {
    sendError(res, error);
  }
}

function checkId(req: Request): string {
  const id = String(req.params.id);
  if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, "This is not a batch id.");
  return id;
}

// GET /api/batches/<id>
// Answer: the batch, with "cards" (each card's id, title, status, error and progress, in batch order),
// "canControl" (true for the user who started it: only they can use the buttons), and "timeLeft"
// ({ done, left, failed, leftMs, finishAt, unknownCards }, see estimate.ts, FRG-76).
export async function getBatchHandler(req: Request, res: Response) {
  try {
    const batch = await loadBatch(checkId(req));
    if (!batch) throw new HttpError(404, "There is no batch with this id.");
    const active = new Map(activeJobs().map((job) => [job.id, job]));
    const saved = new Map((await findCards(batch.cardIds)).map((card) => [card.id, card]));
    const known = new Map<string, Job>();
    for (const id of batch.cardIds) {
      const card = active.get(id) ?? saved.get(id);
      if (card) known.set(id, card);
    }
    const cards = batch.cardIds.map((id) => {
      const card = known.get(id);
      return {
        id,
        title: card?.title ?? "(card deleted)",
        status: card?.status ?? null,
        error: card?.error ?? null,
        progress: active.get(id)?.progress ?? null,
      };
    });
    const timeLeft = await batchTimeLeft(batch, cardsLeft(batch), known);
    res.json({ ...batch, cards, timeLeft, canControl: !!res.locals.username && batch.createdBy === res.locals.username });
  } catch (error) {
    sendError(res, error);
  }
}

// The buttons. Each loads the batch inside the lock, checks who presses it, changes it and saves it.
// action is used in the messages, for example "pause".
async function changeBatch(req: Request, res: Response, action: string, change: (batch: Batch, username: string) => Promise<void>) {
  try {
    const id = checkId(req);
    const username: string | null = res.locals.username ?? null;
    const batch = await withBatchLock(async () => {
      const found = await loadBatch(id);
      if (!found) throw new HttpError(404, "There is no batch with this id.");
      if (!username || found.createdBy !== username) {
        throw new HttpError(403, `Only ${found.createdBy ?? "the user who started this batch"} can ${action} this batch.`);
      }
      await change(found, username);
      await saveBatch(found);
      return found;
    });
    checkNow();
    res.json(batch);
  } catch (error) {
    sendError(res, error);
  }
}

function finishedMessage(batch: Batch): string {
  return batch.state === "done" ? "This batch is already done." : "This batch was already ended.";
}

// POST /api/batches/<id>/pause: no new card starts. The running card finishes.
export function pauseBatchHandler(req: Request, res: Response) {
  return changeBatch(req, res, "pause", async (batch) => {
    if (batch.state !== "running") throw new HttpError(409, batch.state === "paused" ? "This batch is already paused." : finishedMessage(batch));
    pause(batch, null);
  });
}

// POST /api/batches/<id>/resume: go on with the next card.
export function resumeBatchHandler(req: Request, res: Response) {
  return changeBatch(req, res, "resume", async (batch) => {
    if (batch.state !== "paused") throw new HttpError(409, batch.state === "running" ? "This batch is already running." : finishedMessage(batch));
    batch.state = "running";
    batch.pausedAt = null;
    batch.note = null;
  });
}

// POST /api/batches/<id>/stop-now: cancel the running card and pause. The card goes back to Ready
// and stays first in the list, so it runs first after Resume.
export function stopNowHandler(req: Request, res: Response) {
  return changeBatch(req, res, "stop", async (batch, username) => {
    if (batch.state !== "running" && batch.state !== "paused") throw new HttpError(409, finishedMessage(batch));
    if (batch.state === "running") pause(batch, null);
    if (!batch.currentCardId) return;
    // A card that has just finished is not cancelled: the runner records it as usual.
    if ((await cancelFollowedJob(batch.currentCardId, username)) === null) batch.currentCardId = null;
  });
}

// POST /api/batches/<id>/end: stop for good. Cards not run stay on the board. A running card finishes.
export function endBatchHandler(req: Request, res: Response) {
  return changeBatch(req, res, "end", async (batch) => {
    if (batch.state !== "running" && batch.state !== "paused") throw new HttpError(409, finishedMessage(batch));
    batch.state = "ended";
    batch.finishedAt = new Date();
    batch.note = null;
  });
}
