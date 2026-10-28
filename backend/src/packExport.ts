import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { getPackItemsCollection, getPacksCollection, safeMessage } from "./db.js";
import type { Job, Pack, PackItem } from "./db.js";
import { findAnyJob, JOB_ID_PATTERN, OUTPUTS_DIR, sendError } from "./jobs.js";
import { loadPreset } from "./presets.js";

// Export a pack to one folder that Claude Code can import into Unreal (FRG-82).
// {PACK_EXPORT_DIR}/{CODE}_Forge/ gets:
// - each done model item: {group}/{id}_{name}.glb (the picked 3D result) and {group}/_Pictures/{id}_{name}.png
//   (the picked picture it was made from);
// - each done picture item: {group}/{id}_{name}.png;
// - {CODE}_pack.md (the pack file), forge_manifest.json (every item), forge_record.md (one row per model,
//   to paste into ASSETS.md), and for engine "unreal" README_ClaudeCode.md from templates/unreal.
// Safe to export again: files are only written or overwritten. Nothing in the export folder is ever deleted.

export const PACK_MANIFEST_SCHEMA = "teczoforge-pack-manifest/1";

// The fixed README for Claude Code, at the root of the repo.
const TEMPLATES_DIR = path.join(import.meta.dirname, "..", "..", "templates", "unreal");

// Where pack exports go. Default: data/exports at the root of the repo (like game exports).
// Read on each export, so a changed backend/.env only needs a restart.
function packExportDir(): string {
  return process.env.PACK_EXPORT_DIR ? path.resolve(process.env.PACK_EXPORT_DIR) : path.join(import.meta.dirname, "..", "..", "data", "exports");
}

// One item in forge_manifest.json. Paths are inside the export folder, with "/".
type ManifestItem = {
  id: string;
  name: string;
  group: string;
  kind: PackItem["kind"];
  status: "done" | "missing" | "skip";
  path: string | null; // The model (model items) or the picture (picture items).
  picturePath: string | null; // Model items: the picture the model was made from.
  real_size: PackItem["realSize"];
  notes: string;
  presetId: string | null; // The preset of the exported file (the 3D preset for models).
  seed: number | null;
  jobId: string | null;
};

export type PackExportReport = {
  folder: string; // The full path of the export folder.
  written: string[]; // New files (paths inside the folder).
  overwritten: string[]; // Files that were there and were replaced.
  missing: string[]; // Item ids that are not done yet (skip items not counted).
  problems: string[]; // Done items whose file could not be found, in plain English.
};

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

// A finished job and its file in data/outputs, or null if either is gone.
// Only the file name is used, so a saved path can never point outside data/outputs.
async function finishedFile(jobId: string | null): Promise<{ job: Job; file: string } | null> {
  if (!jobId) return null;
  const job = await findAnyJob(jobId);
  const saved = job?.outputFile ?? job?.imageUrl;
  if (!job || job.status !== "done" || !saved) return null;
  const file = path.join(OUTPUTS_DIR, path.basename(saved));
  return (await exists(file)) ? { job, file } : null;
}

function seedOf(job: Job): number | null {
  const seed = (job.inputs as Record<string, unknown> | null)?.seed;
  return typeof seed === "number" ? seed : null;
}

// A table cell: no line breaks, and a "|" cannot end the cell early.
function cell(text: string): string {
  return text.replace(/\s+/g, " ").replaceAll("|", "\\|").trim() || "-";
}

// Write the whole export. items: every item of the pack.
export async function exportPack(pack: Pack, items: PackItem[]): Promise<PackExportReport> {
  const folder = path.join(packExportDir(), `${pack.code}_Forge`);
  const report: PackExportReport = { folder, written: [], overwritten: [], missing: [], problems: [] };

  // Write one file inside the folder (parts: the path inside it), and note if it was new or replaced.
  async function put(parts: string[], write: (target: string) => Promise<void>) {
    const target = path.join(folder, ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    const replaced = await exists(target);
    await write(target);
    (replaced ? report.overwritten : report.written).push(parts.join("/"));
  }

  await mkdir(folder, { recursive: true });
  const manifestItems: ManifestItem[] = [];
  const recordRows: string[] = [];

  for (const item of [...items].sort((a, b) => a.order - b.order)) {
    const entry: ManifestItem = {
      id: item.itemId,
      name: item.name,
      group: item.group,
      kind: item.kind,
      status: item.kind === "skip" ? "skip" : "missing",
      path: null,
      picturePath: null,
      real_size: item.realSize,
      notes: item.notes,
      presetId: null,
      seed: null,
      jobId: null,
    };
    manifestItems.push(entry);
    if (item.kind === "skip") continue; // Built by hand: the notes say how.
    if (item.status !== "done") {
      report.missing.push(item.itemId);
      continue;
    }

    const base = `${item.itemId}_${item.name}`;
    const picture = await finishedFile(item.pickedPictureJobId);
    const model = item.kind === "model" ? await finishedFile(item.pickedModelJobId) : null;
    const main = item.kind === "model" ? model : picture;
    if (!main) {
      report.problems.push(`${item.itemId}: the picked ${item.kind === "model" ? "3D model" : "picture"} is not in data/outputs any more.`);
      report.missing.push(item.itemId);
      continue;
    }

    // The picked file, named {id}_{name} with the file's own ending (.glb for models, .png for pictures).
    const mainParts = [item.group, `${base}${path.extname(main.file).toLowerCase()}`];
    await put(mainParts, (target) => copyFile(main.file, target));
    Object.assign(entry, { status: "done", path: mainParts.join("/"), presetId: main.job.presetId, seed: seedOf(main.job), jobId: main.job.id });

    if (item.kind === "model") {
      if (picture) {
        const pictureParts = [item.group, "_Pictures", `${base}${path.extname(picture.file).toLowerCase()}`];
        await put(pictureParts, (target) => copyFile(picture.file, target));
        entry.picturePath = pictureParts.join("/");
      } else {
        report.problems.push(`${item.itemId}: the picked picture is not in data/outputs any more. The model was exported without it.`);
      }
      // One record row per exported model, with the 3D preset's name and licence note.
      let presetName = main.job.presetId ?? "-";
      let licenceNote = "";
      try {
        const { preset } = await loadPreset(main.job.presetId);
        presetName = preset.name;
        licenceNote = preset.licenceNote ?? (preset.licence ? `Licence: ${preset.licence}` : "");
      } catch {
        // The preset folder is gone: keep its id.
      }
      const date = new Date(main.job.createdAt).toISOString().slice(0, 10);
      const seed = seedOf(main.job);
      recordRows.push(`| ${cell(item.itemId)} | ${cell(item.name)} | ${cell(presetName)} | ${seed ?? "-"} | ${date} | ${cell(licenceNote)} |`);
    }
  }

  await put([`${pack.code}_pack.md`], (target) => writeFile(target, pack.packText, "utf8"));

  const manifest = {
    schema: PACK_MANIFEST_SCHEMA,
    pack: { code: pack.code, name: pack.name, engine: pack.engine },
    exportedAt: new Date().toISOString(),
    items: manifestItems,
  };
  await put(["forge_manifest.json"], (target) => writeFile(target, JSON.stringify(manifest, null, 2) + "\n", "utf8"));

  const record = [
    `# TeczoForge record: ${pack.name} (${pack.code})`,
    "",
    "One row per exported 3D model. Paste the rows into ASSETS.md.",
    "",
    "| ID | Name | TeczoForge preset | Seed | Date | Licence note |",
    "| --- | --- | --- | --- | --- | --- |",
    ...recordRows,
    "",
  ].join("\n");
  await put(["forge_record.md"], (target) => writeFile(target, record, "utf8"));

  // The README for Claude Code, only for Unreal packs.
  if (pack.engine === "unreal") {
    const readme = (await readFile(path.join(TEMPLATES_DIR, "README_ClaudeCode.md"), "utf8")).replaceAll("{CODE}", pack.code).replaceAll("{NAME}", pack.name);
    await put(["README_ClaudeCode.md"], (target) => writeFile(target, readme, "utf8"));
  }

  return report;
}

// POST /api/packs/<id>/export
// Writes {PACK_EXPORT_DIR}/{CODE}_Forge/. Only writes and overwrites; nothing in the folder is deleted.
// Answer: { folder, written, overwritten, missing, problems }.
export async function exportPackHandler(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, "This is not a pack id.");
    let found: { pack: Pack; items: PackItem[] } | null;
    try {
      const pack = await (await getPacksCollection()).findOne({ id }, { projection: { _id: 0 } });
      found = pack ? { pack, items: await (await getPackItemsCollection()).find({ packId: id }, { projection: { _id: 0 } }).toArray() } : null;
    } catch (error) {
      console.warn(`Warning: packs could not use MongoDB. ${safeMessage(error)}`);
      throw new HttpError(503, "Packs are not available because MongoDB cannot be reached.");
    }
    if (!found) throw new HttpError(404, "There is no pack with this id.");
    try {
      res.json(await exportPack(found.pack, found.items));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.error(`Export of pack ${found.pack.code} failed:`, error);
      throw new HttpError(500, `The export could not be written: ${(error as Error).message}`);
    }
  } catch (error) {
    sendError(res, error);
  }
}
