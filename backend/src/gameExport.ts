import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Game, GameAsset } from "./db.js";
import { exportFolderParts } from "./gameFile.js";
import { findAnyJob, OUTPUTS_DIR } from "./jobs.js";

// Export a game to a Unity-ready folder (FRG-70).
// {GAME_EXPORT_DIR}/{CODE}_Assets/ gets every approved file, renamed to {assetId}.{ending}, in its
// folder from docs/game-design-format.md; the approved concept art in _Reference/; the design file
// as {CODE}_GameDesign.md; asset_manifest.json; and the Claude Code handoff kit from templates/unity
// (FRG-71): README_ClaudeCode.md with the game's values filled in, and Editor/TeczoForgeImporter.cs.
// Safe to export again: files are only written or overwritten. Nothing in the export folder is
// ever deleted, so Unity's .meta files (and anything else someone put there) stay.

// Where exports go. Default: data/exports at the root of the repo (like data/outputs).
export const EXPORT_DIR = process.env.GAME_EXPORT_DIR
  ? path.resolve(process.env.GAME_EXPORT_DIR)
  : path.join(import.meta.dirname, "..", "..", "data", "exports");

export const MANIFEST_SCHEMA = "teczoforge-manifest/1";

// The fixed files of the handoff kit (FRG-71), at the root of the repo.
const TEMPLATES_DIR = path.join(import.meta.dirname, "..", "..", "templates", "unity");

// One asset in asset_manifest.json. path: inside the export folder, with "/" (as Unity writes paths).
type ManifestAsset = {
  id: string;
  type: string;
  category: string;
  use: string;
  path: string | null;
  status: "approved" | "external" | "missing";
  target_height_m: number | null;
  needs: string[];
  jobId: string | null;
};

export type ExportReport = {
  folder: string; // The full path of the export folder.
  written: string[]; // New files (paths inside the folder).
  overwritten: string[]; // Files that were there and were replaced.
  missing: string[]; // Asset ids with no approved file yet (external assets not counted).
  problems: string[]; // Approved assets whose file could not be found, in plain English.
};

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

// The finished file of an approved job in data/outputs, or null if it is not there.
// Only the file name is used, so a saved path can never point outside data/outputs.
async function approvedFile(jobId: string): Promise<{ file: string; jobId: string } | null> {
  const job = await findAnyJob(jobId);
  const saved = job?.outputFile ?? job?.imageUrl;
  if (!saved) return null;
  const file = path.join(OUTPUTS_DIR, path.basename(saved));
  return (await exists(file)) ? { file, jobId } : null;
}

// The approved job of an asset: the approved result of its last step, once every step is approved.
function approvedJobId(asset: GameAsset): string | null {
  if (asset.status !== "approved" || asset.steps.length === 0) return null;
  return asset.steps.at(-1)?.approvedJobId ?? null;
}

// Write the whole export. assets: every asset of the game that is not removed, the concept art included.
export async function exportGame(game: Game, assets: GameAsset[]): Promise<ExportReport> {
  const folder = path.join(EXPORT_DIR, `${game.code}_Assets`);
  const report: ExportReport = { folder, written: [], overwritten: [], missing: [], problems: [] };

  // Write one file inside the folder (parts: the path inside it), and note if it was new or replaced.
  async function put(parts: string[], write: (target: string) => Promise<void>) {
    const target = path.join(folder, ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    const replaced = await exists(target);
    await write(target);
    (replaced ? report.overwritten : report.written).push(parts.join("/"));
  }

  await mkdir(folder, { recursive: true });
  const manifestAssets: ManifestAsset[] = [];

  for (const asset of [...assets].sort((a, b) => a.order - b.order)) {
    const entry: ManifestAsset = {
      id: asset.assetId,
      type: asset.type,
      category: asset.category,
      use: asset.use,
      path: null,
      status: "missing",
      target_height_m: asset.options.target_height_m ?? null,
      needs: asset.needs,
      jobId: null,
    };
    manifestAssets.push(entry);

    if (asset.source === "external") {
      entry.status = "external"; // Made by hand, outside TeczoForge: no file here.
      continue;
    }
    const jobId = approvedJobId(asset);
    const found = jobId ? await approvedFile(jobId) : null;
    const folderParts = exportFolderParts(asset.type, asset.category);
    if (!found || !folderParts) {
      if (jobId) report.problems.push(`${asset.assetId}: the approved file is not in data/outputs any more.`);
      report.missing.push(asset.assetId);
      continue;
    }
    const parts = [...folderParts, `${asset.assetId}${path.extname(found.file).toLowerCase()}`];
    await put(parts, (target) => copyFile(found.file, target));
    Object.assign(entry, { path: parts.join("/"), status: "approved", jobId: found.jobId });
  }

  await put([`${game.code}_GameDesign.md`], (target) => writeFile(target, game.designText, "utf8"));

  const manifest = {
    schema: MANIFEST_SCHEMA,
    game: { code: game.code, name: game.name, dimension: game.dimension, pipeline: game.pipeline },
    exportedAt: new Date().toISOString(),
    assets: manifestAssets,
  };
  await put(["asset_manifest.json"], (target) => writeFile(target, JSON.stringify(manifest, null, 2) + "\n", "utf8"));

  // The Claude Code handoff kit (FRG-71). The README gets the game's values; the editor script is copied as it is.
  const readme = (await readFile(path.join(TEMPLATES_DIR, "README_ClaudeCode.md"), "utf8"))
    .replaceAll("{CODE}", game.code)
    .replaceAll("{NAME}", game.name)
    .replaceAll("{PIPELINE}", game.pipeline);
  await put(["README_ClaudeCode.md"], (target) => writeFile(target, readme, "utf8"));
  await put(["Editor", "TeczoForgeImporter.cs"], (target) => copyFile(path.join(TEMPLATES_DIR, "Editor", "TeczoForgeImporter.cs"), target));

  return report;
}
