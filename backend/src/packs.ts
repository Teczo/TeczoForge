import type { Request, Response } from "express";
import type { Collection } from "mongodb";
import { HttpError } from "./httpError.js";
import { getPackItemsCollection, getPacksCollection, getProjectsCollection, PACK_ITEM_STATUSES, safeMessage } from "./db.js";
import type { Pack, PackItem, PackItemStatus } from "./db.js";
import { checkPackFile, MODEL_PRESETS, readPackFileBody } from "./packFile.js";
import type { PlannedItem } from "./packFile.js";
import { JOB_ID_PATTERN, sendError } from "./jobs.js";
import { addProject } from "./projects.js";

// Packs (FRG-78).
// Importing a pack file saves a pack, its project (kind "pack", same name as the pack), and one
// item record per item in the file. The file is checked first (see packFile.ts).
// Nothing runs here: that is FRG-80.
// Packs live in MongoDB only. When MongoDB is offline these routes answer 503.

const OFFLINE_MESSAGE = "Packs are not available because MongoDB cannot be reached.";

// MongoDB's error code when a unique index says no (here: the pack code is already used).
const DUPLICATE_KEY = 11000;

type PackCollections = { packs: Collection<Pack>; items: Collection<PackItem> };

// Run work on the packs collections. If MongoDB cannot be reached, throw the clear 503 message.
async function withPacks<T>(work: (collections: PackCollections) => Promise<T>): Promise<T> {
  try {
    return await work({ packs: await getPacksCollection(), items: await getPackItemsCollection() });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn(`Warning: packs could not use MongoDB. ${safeMessage(error)}`);
    throw new HttpError(503, OFFLINE_MESSAGE);
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY;
}

function codeUsedMessage(code: string, otherName: string): string {
  return `The pack code "${code}" is already used by the pack "${otherName}". Choose another code in the file.`;
}

// One item record from a checked item. Skip items start as "skip", all others as "planned".
function itemRecord(packId: string, item: PlannedItem, order: number): PackItem {
  return {
    id: crypto.randomUUID(),
    packId,
    order,
    itemId: item.id,
    name: item.name,
    group: item.group,
    kind: item.kind,
    prompt: item.prompt,
    editFrom: item.edit_from,
    editPrompt: item.edit_prompt,
    size: item.size,
    pictures: item.pictures,
    modelPresetIds: item.model_presets.map((name) => MODEL_PRESETS[name]),
    modelSeeds: item.model_seeds,
    realSize: item.real_size,
    notes: item.notes,
    status: item.kind === "skip" ? "skip" : "planned",
    pictureJobIds: [],
    pickedPictureJobId: null,
    autoPicked: false,
    modelJobIds: [],
    pickedModelJobId: null,
    error: null,
  };
}

// POST /api/packs/import
// Body: { "fileName": "...", "text": "..." } (the whole .md file, max 1 MB).
// Answers 201 { ok: true, pack, items }, or 400 { ok: false, errors: [...] } when the file is wrong,
// the pack code is already used, or a project already has the pack's name.
export async function importPackHandler(req: Request, res: Response) {
  try {
    const { fileName, text } = readPackFileBody(req.body);
    const result = checkPackFile(text);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    const plan = result.plan;

    const other = await withPacks(({ packs }) => packs.findOne({ code: plan.pack.code }));
    if (other) {
      res.status(400).json({ ok: false, errors: [codeUsedMessage(plan.pack.code, other.name)] });
      return;
    }

    const createdBy: string | null = res.locals.username ?? null; // Set by requireLogin in auth.ts.
    let project;
    try {
      project = await addProject(plan.pack.name, createdBy, "pack");
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) {
        res.status(400).json({ ok: false, errors: [`A project named "${plan.pack.name}" already exists. Rename that project, or change the pack name in the file.`] });
        return;
      }
      throw error;
    }

    const now = new Date();
    const pack: Pack = {
      id: crypto.randomUUID(),
      projectId: project.id,
      ...plan.pack,
      fileName,
      packText: text,
      sourceDocName: "",
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
    const items = plan.items.map((item, index) => itemRecord(pack.id, item, index));

    try {
      await withPacks(async ({ packs, items: itemRecords }) => {
        // The unique index on code stops a duplicate, even when two people import the same code at once.
        await packs.insertOne({ ...pack }); // Copies: insertOne adds MongoDB's own _id to what it gets.
        await itemRecords.insertMany(items.map((item) => ({ ...item })));
      });
    } catch (error) {
      // The pack was not saved. Take back the empty project made above, so a new try can use the name.
      await undoImport(pack.id, project.id);
      if (error instanceof HttpError) throw error;
      if (isDuplicateKey(error)) {
        res.status(400).json({ ok: false, errors: [codeUsedMessage(plan.pack.code, "another pack")] });
        return;
      }
      throw error;
    }

    res.status(201).json({ ok: true, pack, items });
  } catch (error) {
    sendError(res, error);
  }
}

// Remove what a failed import saved: its item records, its pack record, and its new project.
// The project is brand new and empty, so nothing else is lost. Never throws: it only logs.
async function undoImport(packId: string, projectId: string): Promise<void> {
  try {
    await (await getPackItemsCollection()).deleteMany({ packId });
    await (await getPacksCollection()).deleteOne({ id: packId });
    await (await getProjectsCollection()).deleteOne({ id: projectId });
  } catch (error) {
    console.warn(`Warning: could not undo a failed pack import (project ${projectId}). ${safeMessage(error)}`);
  }
}

// GET /api/packs
// Answer: { "packs": [...] }, newest first. Each pack without its packText, plus "counts": how many
// items have each status.
export async function listPacksHandler(_req: Request, res: Response) {
  try {
    const { packs, rows } = await withPacks(async ({ packs, items }) => ({
      packs: await packs.find({}, { projection: { _id: 0, packText: 0 } }).sort({ createdAt: -1 }).toArray(),
      rows: await items
        .aggregate<{ _id: { packId: string; status: PackItemStatus }; count: number }>([
          { $group: { _id: { packId: "$packId", status: "$status" }, count: { $sum: 1 } } },
        ])
        .toArray(),
    }));

    const counts = new Map<string, Record<PackItemStatus, number>>();
    for (const pack of packs) {
      counts.set(pack.id, Object.fromEntries(PACK_ITEM_STATUSES.map((status) => [status, 0])) as Record<PackItemStatus, number>);
    }
    for (const row of rows) {
      const packCounts = counts.get(row._id.packId);
      if (packCounts && row._id.status in packCounts) packCounts[row._id.status] = row.count;
    }
    res.json({ packs: packs.map((pack) => ({ ...pack, counts: counts.get(pack.id) })) });
  } catch (error) {
    sendError(res, error);
  }
}

// GET /api/packs/<id>
// Answer: { pack, items }: the pack (with its packText) and all its items in file order.
export async function getPackHandler(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, "This is not a pack id.");
    const found = await withPacks(async ({ packs, items }) => {
      const pack = await packs.findOne({ id }, { projection: { _id: 0 } });
      if (!pack) return null;
      return { pack, items: await items.find({ packId: id }, { projection: { _id: 0 } }).sort({ order: 1 }).toArray() };
    });
    if (!found) throw new HttpError(404, "There is no pack with this id.");
    res.json(found);
  } catch (error) {
    sendError(res, error);
  }
}
