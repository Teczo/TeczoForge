import type { Request, Response } from "express";
import type { Collection } from "mongodb";
import { HttpError } from "./httpError.js";
import { averageDurationsByPreset, findReadyDrafts, GAME_ASSET_STATUSES, getGameAssetsCollection, getGamesCollection, getProjectsCollection, safeMessage } from "./db.js";
import type { Game, GameAsset, GameAssetStatus, Job } from "./db.js";
import { checkGameFile, conceptPrompt, firstStepPrompt, IMAGE_PRESET, readGameFileBody } from "./gameFile.js";
import type { PlannedAsset } from "./gameFile.js";
import { findAnyJob, JOB_ID_PATTERN, onJobDone, sendError } from "./jobs.js";
import { createDraft, runDraft } from "./drafts.js";
import { loadPreset } from "./presets.js";
import { sendToBoard } from "./sendTo.js";
import { addProject } from "./projects.js";
import { exportGame } from "./gameExport.js";
import { cardsInActiveBatches, createBatch } from "./batches.js";

// Games (FRG-66).
// Importing a game design file saves a game, its project (kind "game", same name as the game),
// and one asset record per asset in the file. The file is checked first (see gameFile.ts).
// Games live in MongoDB only. When MongoDB is offline these routes answer 503.

const OFFLINE_MESSAGE = "Games are not available because MongoDB cannot be reached.";

// MongoDB's error code when a unique index says no (here: the game code is already used).
const DUPLICATE_KEY = 11000;

type GameCollections = { games: Collection<Game>; assets: Collection<GameAsset> };

// Run work on the games collections. If MongoDB cannot be reached, throw the clear 503 message.
async function withGames<T>(work: (collections: GameCollections) => Promise<T>): Promise<T> {
  try {
    return await work({ games: await getGamesCollection(), assets: await getGameAssetsCollection() });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn(`Warning: games could not use MongoDB. ${safeMessage(error)}`);
    throw new HttpError(503, OFFLINE_MESSAGE);
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY;
}

function codeUsedMessage(code: string, otherName: string): string {
  return `The game code "${code}" is already used by the game "${otherName}". Choose another code in the file.`;
}

// One asset record from a planned asset.
function assetRecord(gameId: string, asset: PlannedAsset, order: number): GameAsset {
  const options: GameAsset["options"] = {};
  if (asset.size) options.size = asset.size;
  if (asset.target_height_m !== undefined) options.target_height_m = asset.target_height_m;
  if (asset.duration_s !== undefined) options.duration_s = asset.duration_s;
  return {
    id: crypto.randomUUID(),
    gameId,
    order,
    assetId: asset.id,
    type: asset.type,
    category: asset.category,
    prompt: asset.prompt,
    use: asset.use,
    options,
    source: asset.source,
    needs: asset.needs,
    status: asset.source === "external" ? "external" : "planned",
    steps: asset.steps.map((step) => ({ presetId: step.preset, jobIds: [], approvedJobId: null })),
    removed: false,
  };
}

// POST /api/games/import
// Body: { "fileName": "...", "text": "..." } (the whole .md file, max 1 MB).
// Answers 201 { ok: true, game, assets }, or 400 { ok: false, errors: [...] } when the file is wrong,
// the game code is already used, or a project already has the game's name.
export async function importGameHandler(req: Request, res: Response) {
  try {
    const { fileName, text } = readGameFileBody(req.body);
    const result = checkGameFile(text);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    const plan = result.plan;

    const other = await withGames(({ games }) => games.findOne({ code: plan.game.code }));
    if (other) {
      res.status(400).json({ ok: false, errors: [codeUsedMessage(plan.game.code, other.name)] });
      return;
    }

    const createdBy: string | null = res.locals.username ?? null; // Set by requireLogin in auth.ts.
    let project;
    try {
      project = await addProject(plan.game.name, createdBy, "game");
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) {
        res.status(400).json({ ok: false, errors: [`A project named "${plan.game.name}" already exists. Rename that project, or change the game name in the file.`] });
        return;
      }
      throw error;
    }

    const now = new Date();
    const game: Game = {
      id: crypto.randomUUID(),
      projectId: project.id,
      ...plan.game,
      fileName,
      designText: text,
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
    const assets = plan.assets.map((asset, index) => assetRecord(game.id, asset, index));

    try {
      await withGames(async ({ games, assets: assetRecords }) => {
        // The unique index on code stops a duplicate, even when two people import the same code at once.
        await games.insertOne({ ...game }); // Copies: insertOne adds MongoDB's own _id to what it gets.
        await assetRecords.insertMany(assets.map((asset) => ({ ...asset })));
      });
    } catch (error) {
      // The game was not saved. Take back the empty project made above, so a new try can use the name.
      await undoImport(game.id, project.id);
      if (error instanceof HttpError) throw error;
      if (isDuplicateKey(error)) {
        res.status(400).json({ ok: false, errors: [codeUsedMessage(plan.game.code, "another game")] });
        return;
      }
      throw error;
    }

    res.status(201).json({ ok: true, game, assets });
  } catch (error) {
    sendError(res, error);
  }
}

// Remove what a failed import saved: its asset records, its game record, and its new project.
// The project is brand new and empty, so nothing else is lost. Never throws: it only logs.
async function undoImport(gameId: string, projectId: string): Promise<void> {
  try {
    await (await getGameAssetsCollection()).deleteMany({ gameId });
    await (await getGamesCollection()).deleteOne({ id: gameId });
    await (await getProjectsCollection()).deleteOne({ id: projectId });
  } catch (error) {
    console.warn(`Warning: could not undo a failed game import (project ${projectId}). ${safeMessage(error)}`);
  }
}

// GET /api/games
// Answer: { "games": [...] }, newest first. Each game without its designText, plus "counts":
// how many assets have each status (removed assets are not counted).
export async function listGamesHandler(_req: Request, res: Response) {
  try {
    const { games, rows } = await withGames(async ({ games, assets }) => ({
      games: await games.find({}, { projection: { _id: 0, designText: 0 } }).sort({ createdAt: -1 }).toArray(),
      rows: await assets
        .aggregate<{ _id: { gameId: string; status: GameAssetStatus }; count: number }>([
          { $match: { removed: false, type: { $ne: REFERENCE_TYPE } } }, // The concept art is not counted.
          { $group: { _id: { gameId: "$gameId", status: "$status" }, count: { $sum: 1 } } },
        ])
        .toArray(),
    }));

    const counts = new Map<string, Record<GameAssetStatus, number>>();
    for (const game of games) {
      counts.set(game.id, Object.fromEntries(GAME_ASSET_STATUSES.map((status) => [status, 0])) as Record<GameAssetStatus, number>);
    }
    for (const row of rows) {
      const gameCounts = counts.get(row._id.gameId);
      if (gameCounts && row._id.status in gameCounts) gameCounts[row._id.status] = row.count;
    }
    res.json({ games: games.map((game) => ({ ...game, counts: counts.get(game.id) })) });
  } catch (error) {
    sendError(res, error);
  }
}

// GET /api/games/<id>
// Answer: { game, assets }: the game (with its designText) and all its assets in file order,
// also the removed ones (they have removed: true).
export async function getGameHandler(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, "This is not a game id.");
    const found = await withGames(async ({ games, assets }) => {
      const game = await games.findOne({ id }, { projection: { _id: 0 } });
      if (!game) return null;
      return { game, assets: await assets.find({ gameId: id }, { projection: { _id: 0 } }).sort({ order: 1 }).toArray() };
    });
    if (!found) throw new HttpError(404, "There is no game with this id.");
    res.json(found);
  } catch (error) {
    sendError(res, error);
  }
}

// GET /api/games/preset-times (FRG-67)
// Answer: { "presets": { "<preset id>": { "averageMs": 41000, "jobs": 12 }, ... } }: the average time
// of finished jobs per preset, for the time estimate before an import. A preset with no finished jobs is left out.
export async function presetTimesHandler(_req: Request, res: Response) {
  try {
    res.json({ presets: Object.fromEntries(await averageDurationsByPreset()) });
  } catch (error) {
    sendError(res, error);
  }
}

// ---- Concept art and asset cards (FRG-68) ----
// 1. "Make concept art": 3 cards for the concept asset, queued at once.
// 2. Approve one finished concept picture (the same Approve as every asset, FRG-69).
// 3. "Create all asset cards" (only after 2): one card per planned asset, in the Ready column.
// 4. "Generate all": one batch of the game's Ready cards (batches.ts, FRG-75), so they run one at a time.
// 5. When a game card's job is done, its asset goes to "review" (see onJobDone below).

const REFERENCE_TYPE = "reference";
const CONCEPT_CARDS = 3;

function conceptAssetId(game: Game): string {
  return `${game.code}_REF_Style_Concept`;
}

// The game of a /api/games/<id>/... route, or 404.
async function loadGame(req: Request): Promise<Game> {
  const id = String(req.params.id);
  if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, "This is not a game id.");
  const game = await withGames(({ games }) => games.findOne({ id }, { projection: { _id: 0 } }));
  if (!game) throw new HttpError(404, "There is no game with this id.");
  return game;
}

function findConcept(game: Game): Promise<GameAsset | null> {
  return withGames(({ assets }) => assets.findOne({ gameId: game.id, type: REFERENCE_TYPE }, { projection: { _id: 0 } }));
}

// Run cards one after the other, through the normal run path (runDraft in drafts.ts).
// Stops at the first card ComfyUI does not accept (it is probably not running): that card goes
// back to Ready with the reason, like a failed Generate.
// Returns how many were queued, and the problems in plain English.
async function runCards(cards: { id: string; title: string }[]): Promise<{ queued: number; errors: string[] }> {
  let queued = 0;
  const errors: string[] = [];
  for (const [index, card] of cards.entries()) {
    try {
      const { live, failedStatus } = await runDraft(card.id);
      if (failedStatus !== null) {
        const left = cards.length - index - 1;
        const rest = left > 0 ? ` The other ${left} card(s) were not started.` : "";
        errors.push(`${card.title}: ${live.job.error ?? "ComfyUI did not accept it."}${rest}`);
        break;
      }
      queued += 1;
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(`Game card ${card.id} could not be started:`, error);
      errors.push(`${card.title}: ${error instanceof HttpError ? error.message : "could not be started. See the backend log."}`);
    }
  }
  return { queued, errors };
}

// POST /api/games/<id>/concept
// "Make concept art": 3 cards in the game's project, queued at once. They belong to the concept asset
// ({CODE}_REF_Style_Concept, type "reference"), which is added the first time.
// Answer: { concept, queued, errors }.
export async function makeConceptHandler(req: Request, res: Response) {
  try {
    const game = await loadGame(req);
    const createdBy: string | null = res.locals.username ?? null; // Set by requireLogin in auth.ts.

    // Add the concept asset once. An upsert, so two clicks at once never make two.
    await withGames(({ assets }) =>
      assets.updateOne(
        { gameId: game.id, type: REFERENCE_TYPE },
        {
          $setOnInsert: {
            id: crypto.randomUUID(),
            gameId: game.id,
            order: -1,
            assetId: conceptAssetId(game),
            type: REFERENCE_TYPE,
            category: "Style",
            prompt: "key art, concept art",
            use: "Style reference for every asset",
            options: {},
            source: "forge",
            needs: [],
            status: "planned",
            steps: [{ presetId: IMAGE_PRESET, jobIds: [], approvedJobId: null }],
            removed: false,
          },
        },
        { upsert: true },
      ),
    );
    const concept = await findConcept(game);
    if (!concept) throw new HttpError(500, "The concept asset could not be made.");
    if (concept.status === "approved") throw new HttpError(400, "A concept is already chosen for this game.");

    // Save the cards and their ids on the asset first, so a finished job always finds its asset.
    const cards: Job[] = [];
    for (let i = 1; i <= CONCEPT_CARDS; i++) {
      cards.push(
        await createDraft({
          presetId: IMAGE_PRESET,
          inputs: { prompt: conceptPrompt(game) },
          title: `${concept.assetId} (${i} of ${CONCEPT_CARDS})`,
          column: "ready",
          projectId: game.projectId,
          createdBy,
        }),
      );
    }
    await withGames(({ assets }) =>
      assets.updateOne(
        { id: concept.id },
        { $push: { "steps.0.jobIds": { $each: cards.map((card) => card.id) } }, $set: { status: "generating" } },
      ),
    );

    const { queued, errors } = await runCards(cards.map((card) => ({ id: card.id, title: card.title ?? card.id })));
    res.json({ concept: await findConcept(game), queued, errors });
  } catch (error) {
    sendError(res, error);
  }
}

// ---- Review, variants and approve (FRG-69) ----
// Only results a person approved go into the game. Each asset works on one step at a time: the
// first step without an approved result. On that step:
// - Approve a finished result. A model's reference picture then gets its 3D card (step 2), made
//   with "Send to" (sendTo.ts) and queued at once. The last step approved: the asset is approved.
// - Make variant: a new card with the same preset and values, a new seed, and the asset's prompt.
// - Edit prompt: saved on the asset, used for the next variant (first step only).
// External assets: "Mark as done by hand" approves them with no file.

const MAX_PROMPT_LENGTH = 2000; // The same limit as the design file (gameFile.ts).

// The asset of a /api/games/<id>/assets/<assetId>/... route (assetId: the record id), or 404.
async function loadAsset(req: Request, game: Game): Promise<GameAsset> {
  const id = String(req.params.assetId);
  if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, "This is not an asset id.");
  const asset = await withGames(({ assets }) => assets.findOne({ id, gameId: game.id, removed: false }, { projection: { _id: 0 } }));
  if (!asset) throw new HttpError(404, "There is no such asset in this game.");
  return asset;
}

function findAsset(id: string): Promise<GameAsset | null> {
  return withGames(({ assets }) => assets.findOne({ id }, { projection: { _id: 0 } }));
}

// The step being worked on: the first one without an approved result, or -1 when all are approved.
function currentStepIndex(asset: GameAsset): number {
  return asset.steps.findIndex((step) => !step.approvedJobId);
}

// POST /api/games/<id>/assets/<assetId>/approve
// Body: { "jobId": "<a finished result of the current step>" }.
// Saves it as the step's approvedJobId. If the asset has another step (models: the 3D step), its
// card is made from the approved picture and queued, and the asset is "generating" again.
// Otherwise the asset is "approved". Answer: { asset, errors }.
export async function approveHandler(req: Request, res: Response) {
  try {
    const game = await loadGame(req);
    const asset = await loadAsset(req, game);
    const jobId = req.body?.jobId;
    if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) throw new HttpError(400, "jobId must be a job id.");
    const index = currentStepIndex(asset);
    if (asset.status === "approved" || index < 0) throw new HttpError(400, "This asset is already approved.");
    const step = asset.steps[index];
    if (!step.jobIds.includes(jobId)) throw new HttpError(400, "This result does not belong to the step of this asset that is being reviewed.");
    const job = await findAnyJob(jobId);
    if (!job || job.status !== "done") throw new HttpError(400, "This result is not finished yet.");

    const next = asset.steps[index + 1];
    // Save the approval only if nobody approved this step in the meantime (two clicks at once).
    const claimed = await withGames(({ assets }) =>
      assets.updateOne(
        { id: asset.id, [`steps.${index}.approvedJobId`]: null },
        { $set: { [`steps.${index}.approvedJobId`]: jobId, status: next ? "generating" : "approved" } },
      ),
    );
    if (claimed.matchedCount === 0) throw new HttpError(409, "This step was already approved. Refresh the page.");

    let errors: string[] = [];
    if (next) {
      let card: Job;
      try {
        card = await sendToBoard(jobId, next.presetId, res.locals.username ?? null); // Set by requireLogin in auth.ts.
      } catch (error) {
        // The next card could not be made: take the approval back, so it can be tried again.
        await withGames(({ assets }) =>
          assets.updateOne({ id: asset.id }, { $set: { [`steps.${index}.approvedJobId`]: null, status: "review" } }),
        );
        throw error;
      }
      await withGames(({ assets }) => assets.updateOne({ id: asset.id }, { $push: { [`steps.${index + 1}.jobIds`]: card.id } }));
      errors = (await runCards([{ id: card.id, title: card.title ?? asset.assetId }])).errors;
    }
    res.json({ asset: await findAsset(asset.id), errors });
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/games/<id>/assets/<assetId>/variant
// "Make variant": a new card for the current step, with the same preset and values as its newest
// card, a new random seed, and (first step) the asset's prompt as it is now. Queued at once.
// Answer: { asset, errors }.
export async function variantHandler(req: Request, res: Response) {
  try {
    const game = await loadGame(req);
    const asset = await loadAsset(req, game);
    const index = currentStepIndex(asset);
    if (asset.status === "approved" || index < 0) throw new HttpError(400, "This asset is already approved.");
    if (asset.source === "external") throw new HttpError(400, "External assets are not made by TeczoForge.");
    const lastJobId = asset.steps[index].jobIds.at(-1);
    if (!lastJobId) throw new HttpError(400, "This asset has no card yet. Create the asset cards first.");
    const last = await findAnyJob(lastJobId);
    if (!last || !last.presetId) throw new HttpError(400, "The card of this asset cannot be found.");

    // The same values without the seed, so the card gets a new random seed when it runs.
    const { preset } = await loadPreset(last.presetId);
    const seedKeys = new Set(preset.inputs.filter((input) => input.kind === "seed").map((input) => input.key));
    const inputs = Object.fromEntries(Object.entries((last.inputs ?? {}) as Record<string, unknown>).filter(([key]) => !seedKeys.has(key)));
    // The first step of a file asset uses the asset's prompt, which may have been edited. The concept keeps its prompt.
    if (index === 0 && asset.type !== REFERENCE_TYPE) inputs.prompt = firstStepPrompt(game, asset.type, asset.prompt);

    const card = await createDraft({
      presetId: last.presetId,
      inputs,
      title: last.title ?? asset.assetId,
      column: "ready",
      projectId: game.projectId,
      createdBy: res.locals.username ?? null,
      ...(last.sourceJobId ? { sourceJobId: last.sourceJobId } : {}),
    });
    await withGames(({ assets }) =>
      assets.updateOne({ id: asset.id }, { $push: { [`steps.${index}.jobIds`]: card.id }, $set: { status: "generating" } }),
    );
    const { errors } = await runCards([{ id: card.id, title: card.title ?? asset.assetId }]);
    res.json({ asset: await findAsset(asset.id), errors });
  } catch (error) {
    sendError(res, error);
  }
}

// PATCH /api/games/<id>/assets/<assetId>
// Body: { "prompt": "..." }. "Edit prompt": saved on the asset, used by the next variant.
// Not for the concept art or external assets. Answer: the asset.
export async function editAssetHandler(req: Request, res: Response) {
  try {
    const game = await loadGame(req);
    const asset = await loadAsset(req, game);
    if (asset.type === REFERENCE_TYPE || asset.source === "external") throw new HttpError(400, "The prompt of this asset cannot be changed.");
    const prompt = req.body?.prompt;
    if (typeof prompt !== "string" || prompt.trim() === "") throw new HttpError(400, "The prompt is empty.");
    if (prompt.trim().length > MAX_PROMPT_LENGTH) throw new HttpError(400, `The prompt is too long. Maximum is ${MAX_PROMPT_LENGTH} characters.`);
    await withGames(({ assets }) => assets.updateOne({ id: asset.id }, { $set: { prompt: prompt.trim() } }));
    res.json(await findAsset(asset.id));
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/games/<id>/assets/<assetId>/done-by-hand
// "Mark as done by hand": an external asset becomes approved, with no file. Answer: the asset.
export async function doneByHandHandler(req: Request, res: Response) {
  try {
    const game = await loadGame(req);
    const asset = await loadAsset(req, game);
    if (asset.source !== "external") throw new HttpError(400, "Only external assets are done by hand.");
    await withGames(({ assets }) => assets.updateOne({ id: asset.id }, { $set: { status: "approved" } }));
    res.json(await findAsset(asset.id));
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/games/<id>/cards
// "Create all asset cards": one card per planned asset (not external, not removed), in the game's
// project, Ready column. Title: the asset id. Models get only their first step (the reference picture).
// Each asset goes to "generating", and the card id is saved in its first step.
// Only after a concept is chosen. Assets that already have a card are not planned any more, so a
// second click adds nothing. Answer: { created, errors }.
export async function createAssetCardsHandler(req: Request, res: Response) {
  try {
    const game = await loadGame(req);
    const concept = await findConcept(game);
    if (concept?.status !== "approved") throw new HttpError(400, "Choose a concept first (step 1), then create the asset cards.");
    const createdBy: string | null = res.locals.username ?? null;

    const planned = await withGames(({ assets }) =>
      assets
        .find(
          { gameId: game.id, removed: false, status: "planned", source: "forge", type: { $ne: REFERENCE_TYPE } },
          { projection: { _id: 0 } },
        )
        .sort({ order: 1 })
        .toArray(),
    );

    let created = 0;
    const errors: string[] = [];
    for (const asset of planned) {
      const step = asset.steps[0];
      if (!step) continue;
      // The size comes from the asset. Music: the preset has no duration input yet (FRG-44), so duration_s is not used.
      const inputs: Record<string, unknown> = { prompt: firstStepPrompt(game, asset.type, asset.prompt) };
      if (asset.options.size) [inputs.width, inputs.height] = asset.options.size;
      try {
        const card = await createDraft({
          presetId: step.presetId,
          inputs,
          title: asset.assetId,
          column: "ready",
          projectId: game.projectId,
          createdBy,
        });
        await withGames(({ assets }) =>
          assets.updateOne({ id: asset.id }, { $push: { "steps.0.jobIds": card.id }, $set: { status: "generating" } }),
        );
        created += 1;
      } catch (error) {
        if (error instanceof HttpError && error.status === 503) throw error; // MongoDB offline: stop here.
        if (!(error instanceof HttpError)) console.error(`The card of ${asset.assetId} could not be made:`, error);
        errors.push(`${asset.assetId}: ${error instanceof HttpError ? error.message : "could not be made. See the backend log."}`);
      }
    }
    res.json({ created, errors });
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/games/<id>/generate
// "Generate all": one batch (batches.ts, FRG-75) of every card of this game that is still in the Ready
// column, oldest first. The batch runs them one at a time and can be paused. Cards already in a
// running or paused batch are left out. Answer: { queued, errors, batch } (batch is missing when queued is 0).
export async function generateAllHandler(req: Request, res: Response) {
  try {
    const game = await loadGame(req);
    const assets = await withGames(({ assets }) =>
      assets.find({ gameId: game.id, removed: false }, { projection: { _id: 0 } }).toArray(),
    );
    const jobIds = assets.flatMap((asset) => asset.steps.flatMap((step) => step.jobIds));
    const ready = jobIds.length === 0 ? [] : await findReadyDrafts(jobIds);
    const taken = await cardsInActiveBatches(ready.map((card) => card.id));
    const cards = ready.filter((card) => !taken.has(card.id));
    if (cards.length === 0) {
      const errors = ready.length > 0 ? ["Every Ready card of this game is already in a batch. Use the batch bar to pause or resume it."] : [];
      res.json({ queued: 0, errors });
      return;
    }
    const batch = await createBatch({
      name: `${game.name}: Generate all`,
      cardIds: cards.map((card) => card.id),
      projectId: game.projectId,
      owner: { type: "game", id: game.id },
      createdBy: res.locals.username ?? null, // Set by requireLogin in auth.ts.
    });
    res.json({ queued: cards.length, errors: [], batch });
  } catch (error) {
    sendError(res, error);
  }
}

// When a game card's job is done, its asset goes from "generating" to "review" (FRG-68).
// Approving is FRG-69. A failed job goes back to the board as a draft, and its asset stays "generating".
onJobDone((job) => {
  getGameAssetsCollection()
    .then((assets) => assets.updateOne({ "steps.jobIds": job.id, status: "generating" }, { $set: { status: "review" } }))
    .catch((error) => console.warn(`Warning: could not set the game asset of job ${job.id} to review. ${safeMessage(error)}`));
});

// POST /api/games/<id>/export (FRG-70)
// Writes the Unity-ready folder {GAME_EXPORT_DIR}/{CODE}_Assets/ (see gameExport.ts). Only writes
// and overwrites; nothing in the folder is deleted. Answer: { folder, written, overwritten, missing, problems }.
export async function exportGameHandler(req: Request, res: Response) {
  try {
    const game = await loadGame(req);
    const assets = await withGames(({ assets }) => assets.find({ gameId: game.id, removed: false }, { projection: { _id: 0 } }).toArray());
    try {
      res.json(await exportGame(game, assets));
    } catch (error) {
      console.error(`Export of ${game.code} failed:`, error);
      throw new HttpError(500, `The export could not be written: ${(error as Error).message}`);
    }
  } catch (error) {
    sendError(res, error);
  }
}
