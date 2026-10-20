import type { Request, Response } from "express";
import type { Collection } from "mongodb";
import { HttpError } from "./httpError.js";
import { GAME_ASSET_STATUSES, getGameAssetsCollection, getGamesCollection, getProjectsCollection, safeMessage } from "./db.js";
import type { Game, GameAsset, GameAssetStatus } from "./db.js";
import { checkGameFile, readGameFileBody } from "./gameFile.js";
import type { PlannedAsset } from "./gameFile.js";
import { JOB_ID_PATTERN, sendError } from "./jobs.js";
import { addProject } from "./projects.js";

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
          { $match: { removed: false } },
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
