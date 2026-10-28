import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { findCards, getBatchesCollection, getPackItemsCollection, getPacksCollection, safeMessage, updateDraft } from "./db.js";
import type { Batch, Job, Pack, PackItem } from "./db.js";
import { findAnyJob, JOB_ID_PATTERN, onJobDone, sendError } from "./jobs.js";
import { createDraft, runDraft } from "./drafts.js";
import { sendToBoard } from "./sendTo.js";
import { addCardsToBatch, createBatch, onBatchCardFailed } from "./batches.js";
import { EDIT_PRESET, PICTURE_PRESET } from "./packFile.js";
import { loadPreset } from "./presets.js";
import { inputFilesFor } from "./inputs.js";
import { copyOutputToInputs } from "./upload.js";

// Running a pack (FRG-80). Every card runs in a batch (batches.ts), one job at a time.
// Phase 1, "Make pictures": `pictures` Text to Image cards per item that is not an edit, in one batch.
//   When all pictures of an item are finished: "pick_picture" (or "failed" if every one failed).
// Edits: when an item gets a picked picture, the items that edit it get their Edit Image cards
//   (made from that picture with "Send to"), added to the pack's batch.
// Pick: a picture item is then "done". A model item waits for phase 2.
// Phase 2, "Make 3D models": `modelSeeds` cards per 3D preset for each model item with a picked
//   picture, in one batch. All finished: "pick_model". Picking a 3D result makes the item "done".
// Full auto: phase 1 in one batch. When an item's pictures are finished, the first finished one is
//   picked (autoPicked) and its edit and 3D cards go to the end of the same batch. 3D results are
//   never picked by themselves: model items end in "pick_model".
// A picked picture can be changed only while the item has no 3D jobs (FRG-81). Edit cards made from it
// that have not run yet move to the new picture.
// The fast pick screen (FRG-81) adds one more picture (N), an edit of a picture (E) or one more 3D run (P).

const OFFLINE_MESSAGE = "Packs are not available because MongoDB cannot be reached.";

// The 3D presets by preset id, as card titles show them.
const MODEL_LABELS: Record<string, string> = { "image-to-3d-trellis2": "TRELLIS.2", "image-to-3d-pixal3d": "Pixal3D" };
const MODEL_PRESET_IDS = { trellis2: "image-to-3d-trellis2", pixal3d: "image-to-3d-pixal3d" };

type RunMode = NonNullable<Pack["runMode"]>;

// Pack changes take turns: a job that finishes and a Pick button never change one item at the same time.
let lock: Promise<unknown> = Promise.resolve();
function withPackLock<T>(work: () => Promise<T>): Promise<T> {
  const result = lock.then(work);
  lock = result.catch(() => {});
  return result;
}

// MongoDB work for packs. If MongoDB cannot be reached, throw the clear 503 message.
async function db<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn(`Warning: packs could not use MongoDB. ${safeMessage(error)}`);
    throw new HttpError(503, OFFLINE_MESSAGE);
  }
}

function loadPack(id: string): Promise<Pack | null> {
  return db(async () => (await getPacksCollection()).findOne({ id }, { projection: { _id: 0 } }));
}

function packItems(packId: string): Promise<PackItem[]> {
  return db(async () => (await getPackItemsCollection()).find({ packId }, { projection: { _id: 0 } }).sort({ order: 1 }).toArray());
}

async function saveItem(item: PackItem, fields: Partial<PackItem>): Promise<void> {
  Object.assign(item, fields);
  await db(async () => (await getPackItemsCollection()).updateOne({ id: item.id }, { $set: fields }));
}

// "VEG-01_CoconutPalm (2 of 4)"
function cardTitle(item: PackItem, number: number, total: number): string {
  return `${item.itemId}_${item.name} (${number} of ${total})`;
}

// The newest batch of this pack that was not ended, or null.
function latestPackBatch(packId: string): Promise<Batch | null> {
  return db(async () =>
    (await getBatchesCollection()).findOne(
      { "owner.type": "pack", "owner.id": packId, state: { $ne: "ended" } },
      { projection: { _id: 0 }, sort: { createdAt: -1 } },
    ),
  );
}

function startBatch(pack: Pack, name: string, cardIds: string[], createdBy: string | null): Promise<Batch> {
  return createBatch({ name: `${pack.name}: ${name}`, cardIds, projectId: pack.projectId, owner: { type: "pack", id: pack.id }, createdBy });
}

// Add cards to the end of the pack's batch (a done batch runs again), or start a new batch if it has none.
async function addToPackBatch(pack: Pack, cardIds: string[], createdBy: string | null): Promise<void> {
  if (cardIds.length === 0) return;
  const batch = await latestPackBatch(pack.id);
  if (batch) await addCardsToBatch(batch.id, cardIds);
  else await startBatch(pack, "more cards", cardIds, createdBy);
}

// A plain message for a card that could not be made.
function problemText(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  console.error("A pack card could not be made:", error);
  return "A card could not be made. See the backend log.";
}

// ---- Making cards ----

// Phase 1 cards of one item: `pictures` Text to Image cards with the item's prompt and size.
// No seed, so each card gets its own random seed.
async function makePictureCards(pack: Pack, item: PackItem, createdBy: string | null): Promise<string[]> {
  const ids: string[] = [];
  for (let number = 1; number <= item.pictures; number++) {
    const card = await createDraft({
      presetId: PICTURE_PRESET,
      inputs: { prompt: item.prompt, ...(item.size ? { width: item.size[0], height: item.size[1] } : {}) },
      title: cardTitle(item, number, item.pictures),
      column: "ready",
      projectId: pack.projectId,
      createdBy,
    });
    ids.push(card.id);
  }
  await saveItem(item, { pictureJobIds: ids, status: "pictures", error: null });
  return ids;
}

// Edit Image cards of an edit item, made from the picked picture of its source with "Send to".
async function makeEditCards(item: PackItem, pictureJobId: string, createdBy: string | null): Promise<string[]> {
  const ids: string[] = [];
  for (let number = 1; number <= item.pictures; number++) {
    const card = await sendToBoard(pictureJobId, EDIT_PRESET, createdBy);
    // The edit instruction goes into the prompt, so the card can run as it is.
    await updateDraft(card.id, { inputs: { ...(card.inputs as Record<string, unknown>), prompt: item.editPrompt }, title: cardTitle(item, number, item.pictures), error: null });
    ids.push(card.id);
  }
  await saveItem(item, { pictureJobIds: ids, status: "pictures", error: null });
  return ids;
}

// 3D cards of a model item: modelSeeds cards per 3D preset, made from its picked picture with "Send to".
async function makeModelCards(item: PackItem, createdBy: string | null): Promise<string[]> {
  const ids: string[] = [];
  for (const presetId of item.modelPresetIds) {
    for (let seed = 1; seed <= item.modelSeeds; seed++) {
      const card = await sendToBoard(item.pickedPictureJobId!, presetId, createdBy);
      const label = MODEL_LABELS[presetId] ?? presetId;
      await updateDraft(card.id, { title: `${item.itemId}_${item.name} 3D (${label}, ${seed} of ${item.modelSeeds})` });
      ids.push(card.id);
    }
  }
  await saveItem(item, { modelJobIds: ids, status: "models", error: null });
  return ids;
}

// The edit items of a pack that edit this item and have not started yet: make their cards.
// Returns the new card ids. An edit whose cards cannot be made is marked failed.
async function startEdits(pack: Pack, source: PackItem, pictureJobId: string, createdBy: string | null): Promise<string[]> {
  const edits = (await packItems(pack.id)).filter((item) => item.editFrom === source.itemId && item.status === "planned");
  const ids: string[] = [];
  for (const edit of edits) {
    try {
      ids.push(...(await makeEditCards(edit, pictureJobId, createdBy)));
    } catch (error) {
      if (error instanceof HttpError && error.status === 503) throw error;
      await saveItem(edit, { status: "failed", error: problemText(error) });
    }
  }
  return ids;
}

// ---- Picking ----

// A card made from a picture has run when it is not a draft any more, or when it came back with an error.
function hasRun(card: Job | undefined): boolean {
  return !card || card.status !== "draft" || card.error !== null;
}

// Point cards that have not run yet at another picture: copy it as their start image.
// Returns false (and changes nothing) if one of them has already run.
async function retarget(cardIds: string[], pictureJobId: string): Promise<boolean> {
  if (cardIds.length === 0) return true;
  const cards = await findCards(cardIds);
  if (cards.length !== cardIds.length || cards.some(hasRun)) return false;
  const picture = await findAnyJob(pictureJobId);
  for (const card of cards) {
    const { preset } = await loadPreset(card.presetId);
    const imageInput = preset.inputs.find((input) => input.kind === "image");
    if (!imageInput) continue;
    const copied = await copyOutputToInputs(picture?.imageUrl, true);
    const inputs = { ...(card.inputs as Record<string, unknown>), [imageInput.key]: copied.name };
    await updateDraft(card.id, { inputs, inputFiles: await inputFilesFor(preset, inputs), sourceJobId: pictureJobId });
  }
  return true;
}

// Use a picture of an item. Picture items are then "done". In full auto (auto: true) a model item
// gets its 3D cards at once. The items that edit this item get their edit cards.
// Returns the new card ids, to add to the pack's batch.
async function applyPicturePick(pack: Pack, item: PackItem, pictureJobId: string, auto: boolean, createdBy: string | null): Promise<string[]> {
  const fields: Partial<PackItem> = { pickedPictureJobId: pictureJobId, autoPicked: auto, error: null };
  if (item.kind === "picture") fields.status = "done";
  else if (item.modelJobIds.length === 0) fields.status = "pick_picture";
  await saveItem(item, fields);

  const ids = await startEdits(pack, item, pictureJobId, createdBy);
  if (auto && item.kind === "model" && item.modelJobIds.length === 0) {
    try {
      ids.push(...(await makeModelCards(item, createdBy)));
    } catch (error) {
      if (error instanceof HttpError && error.status === 503) throw error;
      await saveItem(item, { status: "failed", error: problemText(error) });
    }
  }
  return ids;
}

// ---- Following the jobs ----

// Is every card finished: done, failed for good in its batch (after the retry), or deleted?
async function finishedCards(ids: string[]): Promise<{ finished: boolean; done: string[]; lastError: string | null }> {
  const cards = new Map((await findCards(ids)).map((card) => [card.id, card]));
  const batches = await db(async () => (await getBatchesCollection()).find({ cardIds: { $in: ids } }, { projection: { failedCardIds: 1 } }).toArray());
  const failed = new Set(batches.flatMap((batch) => batch.failedCardIds));
  const done = ids.filter((id) => cards.get(id)?.status === "done");
  const finished = ids.every((id) => cards.get(id)?.status === "done" || failed.has(id) || !cards.has(id));
  const lastError = ids.map((id) => cards.get(id)?.error).find((error) => !!error) ?? null;
  return { finished, done, lastError };
}

// A card finished (done, or failed for good): update its item, and in full auto start the next cards.
async function settleCard(cardId: string) {
  const item = await db(async () =>
    (await getPackItemsCollection()).findOne({ $or: [{ pictureJobIds: cardId }, { modelJobIds: cardId }] }, { projection: { _id: 0 } }),
  );
  if (!item) return; // Not a pack card.

  if (item.status === "pictures" && item.pictureJobIds.includes(cardId)) {
    const { finished, done, lastError } = await finishedCards(item.pictureJobIds);
    if (!finished) return;
    if (done.length === 0) {
      await saveItem(item, { status: "failed", error: `All ${item.pictureJobIds.length} pictures failed. ${lastError ?? ""}`.trim() });
      return;
    }
    await saveItem(item, { status: "pick_picture" });
    const pack = await loadPack(item.packId);
    if (pack?.runMode !== "full_auto") return;
    // Full auto: the first finished picture, in card order.
    const batch = await latestPackBatch(pack.id);
    const createdBy = batch?.createdBy ?? pack.createdBy;
    const ids = await applyPicturePick(pack, item, done[0], true, createdBy);
    await addToPackBatch(pack, ids, createdBy);
  } else if (item.status === "models" && item.modelJobIds.includes(cardId)) {
    const { finished, done, lastError } = await finishedCards(item.modelJobIds);
    if (!finished) return;
    if (done.length === 0) await saveItem(item, { status: "failed", error: `All ${item.modelJobIds.length} 3D runs failed. ${lastError ?? ""}`.trim() });
    else await saveItem(item, { status: "pick_model" }); // 3D results are never picked by themselves.
  }
}

function settleLater(cardId: string) {
  withPackLock(() => settleCard(cardId)).catch((error) =>
    console.warn(`Warning: the pack item of card ${cardId} could not be updated. ${error instanceof HttpError ? error.message : safeMessage(error)}`),
  );
}

onJobDone((job) => settleLater(job.id));
onBatchCardFailed((cardId) => settleLater(cardId));

// ---- Routes ----

function checkId(value: unknown, what: string): string {
  const id = String(value);
  if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, `This is not ${what} id.`);
  return id;
}

async function packFromRequest(req: Request): Promise<Pack> {
  const pack = await loadPack(checkId(req.params.id, "a pack"));
  if (!pack) throw new HttpError(404, "There is no pack with this id.");
  return pack;
}

// POST /api/packs/<id>/run
// Body: { "mode": "pictures_first" (default) | "full_auto" }. Phase 1: the picture cards of every
// planned item that is not an edit, in one batch. Answer: { batch, cards }.
export async function runPackHandler(req: Request, res: Response) {
  try {
    const mode: unknown = req.body?.mode ?? "pictures_first";
    if (mode !== "pictures_first" && mode !== "full_auto") throw new HttpError(400, 'mode must be "pictures_first" or "full_auto".');
    const createdBy: string | null = res.locals.username ?? null; // Set by requireLogin in auth.ts.
    const answer = await withPackLock(async () => {
      const pack = await packFromRequest(req);
      const items = (await packItems(pack.id)).filter((item) => item.status === "planned" && item.kind !== "skip" && !item.editFrom);
      if (items.length === 0) throw new HttpError(400, "There is nothing to make: no item of this pack is still planned.");
      await db(async () => (await getPacksCollection()).updateOne({ id: pack.id }, { $set: { runMode: mode as RunMode, updatedAt: new Date() } }));
      pack.runMode = mode as RunMode;

      const cardIds: string[] = [];
      for (const item of items) {
        try {
          cardIds.push(...(await makePictureCards(pack, item, createdBy)));
        } catch (error) {
          if (error instanceof HttpError && error.status === 503) throw error;
          await saveItem(item, { status: "failed", error: problemText(error) });
        }
      }
      if (cardIds.length === 0) throw new HttpError(400, "No picture card could be made. See the item errors.");
      const batch = await startBatch(pack, mode === "full_auto" ? "full auto" : "pictures", cardIds, createdBy);
      return { batch, cards: cardIds.length };
    });
    res.json(answer);
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/packs/<id>/models
// Phase 2: the 3D cards of every model item with a picked picture and no 3D cards yet, in one batch.
// Answer: { batch, items, cards }.
export async function makeModelsHandler(req: Request, res: Response) {
  try {
    const createdBy: string | null = res.locals.username ?? null;
    const answer = await withPackLock(async () => {
      const pack = await packFromRequest(req);
      const items = (await packItems(pack.id)).filter(
        (item) => item.kind === "model" && item.status === "pick_picture" && item.pickedPictureJobId && item.modelJobIds.length === 0,
      );
      if (items.length === 0) throw new HttpError(400, "No model item has a picked picture yet. Pick a picture first.");
      const cardIds: string[] = [];
      for (const item of items) {
        try {
          cardIds.push(...(await makeModelCards(item, createdBy)));
        } catch (error) {
          if (error instanceof HttpError && error.status === 503) throw error;
          await saveItem(item, { status: "failed", error: problemText(error) });
        }
      }
      if (cardIds.length === 0) throw new HttpError(400, "No 3D card could be made. See the item errors.");
      const batch = await startBatch(pack, "3D models", cardIds, createdBy);
      return { batch, items: items.length, cards: cardIds.length };
    });
    res.json(answer);
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/packs/<id>/items/<itemId>/pick
// Body: { "jobId": "<a finished result>", "target": "picture" | "model" }. itemId: the item record id.
// picture: the item's picked picture. A picture item is then "done"; the items that edit it get their
//   cards. It can be changed only while the item has no 3D jobs (FRG-81), and while the edit cards made
//   from it have not run (those cards then use the new picture).
// model: the item's picked 3D result. The item is then "done".
// Answer: the item.
export async function pickHandler(req: Request, res: Response) {
  try {
    const createdBy: string | null = res.locals.username ?? null;
    const { jobId, target } = req.body ?? {};
    if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) throw new HttpError(400, "jobId must be a job id.");
    if (target !== "picture" && target !== "model") throw new HttpError(400, 'target must be "picture" or "model".');
    const item = await withPackLock(async () => {
      const pack = await packFromRequest(req);
      const itemId = checkId(req.params.itemId, "an item");
      const found = (await packItems(pack.id)).find((candidate) => candidate.id === itemId);
      if (!found) throw new HttpError(404, "There is no such item in this pack.");
      const job = await findAnyJob(jobId);
      if (!job || job.status !== "done") throw new HttpError(400, "This result is not finished.");

      if (target === "model") {
        if (!found.modelJobIds.includes(jobId)) throw new HttpError(400, "This 3D result does not belong to this item.");
        await saveItem(found, { pickedModelJobId: jobId, status: "done", error: null });
        return found;
      }

      if (!found.pictureJobIds.includes(jobId)) throw new HttpError(400, "This picture does not belong to this item.");
      if (found.pickedPictureJobId === jobId) {
        if (found.autoPicked) await saveItem(found, { autoPicked: false });
        return found;
      }
      if (found.pickedPictureJobId) {
        if (found.modelJobIds.length > 0) {
          throw new HttpError(409, "This item already has 3D jobs made from the picked picture, so the pick cannot be changed.");
        }
        // A new pick: the edit cards already made from the old picture move to the new one.
        const edits = (await packItems(pack.id)).filter((candidate) => candidate.editFrom === found.itemId);
        if (!(await retarget(edits.flatMap((edit) => edit.pictureJobIds), jobId))) {
          throw new HttpError(409, "Edit cards made from the picked picture have already run, so the pick cannot be changed any more.");
        }
      }
      const ids = await applyPicturePick(pack, found, jobId, false, createdBy);
      await addToPackBatch(pack, ids, createdBy);
      return found;
    });
    res.json(item);
  } catch (error) {
    sendError(res, error);
  }
}

// ---- More results from the fast pick screen (FRG-81) ----

const MAX_EDIT_INSTRUCTION = 1000; // The same limit as edit_prompt in a pack file.

// The pack's batch that is running or paused, or null.
function activePackBatch(packId: string): Promise<Batch | null> {
  return db(async () =>
    (await getBatchesCollection()).findOne(
      { "owner.type": "pack", "owner.id": packId, state: { $in: ["running", "paused"] } },
      { projection: { _id: 0 }, sort: { createdAt: -1 } },
    ),
  );
}

// One new card: added to the pack's running batch, or run at once as a single job when no batch runs.
// Returns a note for the answer.
async function runOneCard(pack: Pack, cardId: string): Promise<string> {
  const batch = await activePackBatch(pack.id);
  if (batch) {
    await addCardsToBatch(batch.id, [cardId]);
    return "Added to the running batch.";
  }
  const { live, failedStatus } = await runDraft(cardId);
  if (failedStatus !== null) {
    return `The card was made, but ComfyUI did not take it: ${live.job.error ?? "unknown reason"} Press Generate on the board when ComfyUI runs.`;
  }
  return "Started.";
}

// The item of a /api/packs/<id>/items/<itemId>/... route, with its pack.
async function itemFromRequest(req: Request): Promise<{ pack: Pack; item: PackItem }> {
  const pack = await packFromRequest(req);
  const itemId = checkId(req.params.itemId, "an item");
  const item = (await packItems(pack.id)).find((candidate) => candidate.id === itemId);
  if (!item) throw new HttpError(404, "There is no such item in this pack.");
  return { pack, item };
}

// POST /api/packs/<id>/items/<itemId>/more-picture  ("N" on the pick screen)
// One more picture with a new random seed: the item's prompt and size, or for an edit item one more edit
// of its source's picked picture. Only before the item has 3D jobs. Answer: { item, cardId, note }.
export async function morePictureHandler(req: Request, res: Response) {
  try {
    const createdBy: string | null = res.locals.username ?? null;
    const answer = await withPackLock(async () => {
      const { pack, item } = await itemFromRequest(req);
      if (item.kind === "skip") throw new HttpError(400, "This item is made outside TeczoForge.");
      if (item.modelJobIds.length > 0) throw new HttpError(409, "This item already has 3D jobs. Make one more 3D run instead (P).");
      if (item.pictureJobIds.length === 0) throw new HttpError(400, "This item has no pictures yet. Start the pictures on the pack page first.");
      const title = `${item.itemId}_${item.name} (extra ${item.pictureJobIds.length + 1})`;
      let cardId: string;
      if (item.editFrom) {
        const source = (await packItems(pack.id)).find((candidate) => candidate.itemId === item.editFrom);
        if (!source?.pickedPictureJobId) throw new HttpError(400, `Pick a picture for ${item.editFrom} first: this item edits it.`);
        const card = await sendToBoard(source.pickedPictureJobId, EDIT_PRESET, createdBy);
        await updateDraft(card.id, { inputs: { ...(card.inputs as Record<string, unknown>), prompt: item.editPrompt }, title, error: null });
        cardId = card.id;
      } else {
        const card = await createDraft({
          presetId: PICTURE_PRESET,
          inputs: { prompt: item.prompt, ...(item.size ? { width: item.size[0], height: item.size[1] } : {}) },
          title,
          column: "ready",
          projectId: pack.projectId,
          createdBy,
        });
        cardId = card.id;
      }
      // A failed item waits for this picture now; any other status stays as it is.
      await saveItem(item, { pictureJobIds: [...item.pictureJobIds, cardId], ...(item.status === "failed" ? { status: "pictures" as const, error: null } : {}) });
      return { item, cardId, note: await runOneCard(pack, cardId) };
    });
    res.json(answer);
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/packs/<id>/items/<itemId>/edit-picture  ("E" on the pick screen)
// Body: { "jobId": "<a finished picture of this item>", "instruction": "..." }. An Edit Image card made
// from that picture; its result joins the item's pictures. Only before the item has 3D jobs.
// Answer: { item, cardId, note }.
export async function editPictureHandler(req: Request, res: Response) {
  try {
    const createdBy: string | null = res.locals.username ?? null;
    const { jobId, instruction } = req.body ?? {};
    if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) throw new HttpError(400, "jobId must be a job id.");
    if (typeof instruction !== "string" || instruction.trim() === "") throw new HttpError(400, "Write what to change.");
    if (instruction.trim().length > MAX_EDIT_INSTRUCTION) {
      throw new HttpError(400, `The instruction is too long. Maximum is ${MAX_EDIT_INSTRUCTION} characters.`);
    }
    const answer = await withPackLock(async () => {
      const { pack, item } = await itemFromRequest(req);
      if (item.modelJobIds.length > 0) throw new HttpError(409, "This item already has 3D jobs, so its pictures cannot change any more.");
      if (!item.pictureJobIds.includes(jobId)) throw new HttpError(400, "This picture does not belong to this item.");
      const card = await sendToBoard(jobId, EDIT_PRESET, createdBy);
      await updateDraft(card.id, {
        inputs: { ...(card.inputs as Record<string, unknown>), prompt: instruction.trim() },
        title: `${item.itemId}_${item.name} (edit ${item.pictureJobIds.length + 1})`,
        error: null,
      });
      await saveItem(item, { pictureJobIds: [...item.pictureJobIds, card.id], ...(item.status === "failed" ? { status: "pictures" as const, error: null } : {}) });
      return { item, cardId: card.id, note: await runOneCard(pack, card.id) };
    });
    res.json(answer);
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/packs/<id>/items/<itemId>/more-model  ("P" on the pick screen)
// One more 3D run from the picked picture: with Pixal3D, or with TRELLIS.2 if Pixal3D was used already.
// Answer: { item, cardId, note }.
export async function moreModelHandler(req: Request, res: Response) {
  try {
    const createdBy: string | null = res.locals.username ?? null;
    const answer = await withPackLock(async () => {
      const { pack, item } = await itemFromRequest(req);
      if (item.kind !== "model") throw new HttpError(400, "Only model items have 3D runs.");
      if (!item.pickedPictureJobId) throw new HttpError(400, "Pick a picture first.");
      const used = new Set((await findCards(item.modelJobIds)).map((card) => card.presetId));
      const presetId = used.has(MODEL_PRESET_IDS.pixal3d) ? MODEL_PRESET_IDS.trellis2 : MODEL_PRESET_IDS.pixal3d;
      const card = await sendToBoard(item.pickedPictureJobId, presetId, createdBy);
      await updateDraft(card.id, { title: `${item.itemId}_${item.name} 3D (${MODEL_LABELS[presetId]}, extra ${item.modelJobIds.length + 1})` });
      const fields: Partial<PackItem> = { modelJobIds: [...item.modelJobIds, card.id] };
      // A picked 3D model stays picked. An item still waiting for its first 3D jobs, or failed, now waits for this one.
      if (item.status === "pick_picture" || item.status === "failed") Object.assign(fields, { status: "models", error: null });
      await saveItem(item, fields);
      return { item, cardId: card.id, note: await runOneCard(pack, card.id) };
    });
    res.json(answer);
  } catch (error) {
    sendError(res, error);
  }
}
