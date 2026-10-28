import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { sendError } from "./jobs.js";
import { checkText, checkUnknownFields, findSchemaBlock, isObject, MAX_GAME_FILE_BYTES } from "./gameFile.js";
import type { Json } from "./gameFile.js";

// Pack files (FRG-77). The format is in docs/pack-format.md ("Appendix B").
// A pack file is a .md file with free text and exactly ONE ```json block with
// "schema": "teczoforge-pack/1" (found with the same finder as game files, gameFile.ts).
// This file checks every rule, and answers with a plan (every item with its defaults and its
// jobs) or with ALL the errors at once, in plain English.
// Nothing is saved here. Saving is FRG-78.

export const PACK_SCHEMA = "teczoforge-pack/1";

const MAX_PACK_NAME = 60;
const MAX_STYLE = 300;
const MIN_ITEMS = 1;
const MAX_ITEMS = 300;
const MAX_ID = 10;
const MAX_ITEM_NAME = 40;
const MAX_GROUP = 30;
const MAX_PROMPT = 2000;
const MAX_EDIT_PROMPT = 1000;
const MAX_NOTES = 500;
const MAX_PICTURES = 6;
const MAX_MODEL_SEEDS = 4;
const MAX_REAL_SIZE_M = 1000;

// Picture sizes, the same limits as the text-to-image-basic preset.
const MIN_SIZE = 512;
const MAX_SIZE = 2048;
const SIZE_STEP = 16;
const DEFAULT_SIZE: [number, number] = [1024, 1024];

const CODE_PATTERN = /^[A-Z]{2,5}$/;
const ID_PATTERN = /^[A-Z]{2,5}-[0-9]{2,3}[A-Z]?$/;
const PASCAL_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

const ENGINES = ["unreal", "none"];
const KINDS = ["model", "picture", "skip"] as const;
type ItemKind = (typeof KINDS)[number];

// The presets the jobs use (B3).
export const PICTURE_PRESET = "text-to-image-basic";
export const EDIT_PRESET = "image-edit-klein";
// The short names a file may use in model_presets, and their preset ids.
export const MODEL_PRESETS: Record<string, string> = { trellis2: "image-to-3d-trellis2", pixal3d: "image-to-3d-pixal3d" };

const DEFAULT_PICTURES = 1;
const DEFAULT_MODEL_PRESETS = ["trellis2"];
const DEFAULT_MODEL_SEEDS = 1;

const PACK_FIELDS = ["code", "name", "engine", "style", "defaults"];
const DEFAULTS_FIELDS = ["pictures", "model_presets", "model_seeds"];
const ITEM_FIELDS = [
  "id",
  "name",
  "group",
  "kind",
  "prompt",
  "edit_from",
  "edit_prompt",
  "size",
  "pictures",
  "model_presets",
  "model_seeds",
  "real_size",
  "notes",
];
const REAL_SIZE_FIELDS = ["height_m", "length_m", "width_m"];
// Fields that make something. A skip item is made outside TeczoForge, so it cannot have them.
const MAKING_FIELDS = ["prompt", "edit_from", "edit_prompt", "size", "pictures", "model_presets", "model_seeds"];

// How many jobs of one preset.
export type JobCount = { presetId: string; count: number };

export type PackDefaults = { pictures: number; model_presets: string[]; model_seeds: number };

export type PlannedItem = {
  id: string;
  name: string;
  group: string;
  kind: ItemKind;
  prompt: string | null; // The full prompt ("{style}, {prompt}" when the pack has a style). null for edits and skips.
  edit_from: string | null;
  edit_prompt: string | null;
  size: [number, number] | null; // null for edits (the size comes from the picked picture) and skips.
  pictures: number; // 0 for skips.
  model_presets: string[]; // Short names, for example ["trellis2"]. Empty unless kind "model".
  model_seeds: number; // 0 unless kind "model".
  real_size: { height_m?: number; length_m?: number; width_m?: number } | null;
  notes: string;
  exportFolder: string; // "{group}/" (B5)
  exportName: string; // "{id}_{name}" (B5). The ending (.png, .glb) is added at export.
  jobs: JobCount[]; // B4: the picture (or edit) jobs, then the 3D jobs on the picked picture.
};

export type PackPlan = {
  pack: { code: string; name: string; engine: string; style: string; defaults: PackDefaults };
  items: PlannedItem[];
  // Every job of the pack, per preset, for the time estimate (POST /api/estimate, FRG-76).
  jobTotals: JobCount[];
};

export type PackCheckResult = { ok: true; plan: PackPlan } | { ok: false; errors: string[] };

// What later items need to know about an item, to check their edit_from.
type SeenItem = { kind: ItemKind | null; isEdit: boolean };

function isWhole(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

// Check "pictures" (pack defaults or an item). Adds an error and returns undefined if it is wrong.
function checkPictures(value: unknown, errors: string[], prefix: string): number | undefined {
  if (value === undefined) return undefined;
  if (!isWhole(value, 1, MAX_PICTURES)) {
    errors.push(`${prefix}"pictures" must be a whole number from 1 to ${MAX_PICTURES}.`);
    return undefined;
  }
  return value;
}

function checkModelPresets(value: unknown, errors: string[], prefix: string): string[] | undefined {
  if (value === undefined) return undefined;
  const names = Object.keys(MODEL_PRESETS);
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${prefix}"model_presets" must be a list with any of ${names.map((name) => `"${name}"`).join(", ")}, for example ["trellis2"].`);
    return undefined;
  }
  const presets: string[] = [];
  let good = true;
  for (const name of value) {
    if (typeof name !== "string" || !Object.hasOwn(MODEL_PRESETS, name)) {
      errors.push(`${prefix}the model preset ${JSON.stringify(name)} is unknown. Use any of: ${names.join(", ")}.`);
      good = false;
    } else if (presets.includes(name)) {
      errors.push(`${prefix}the model preset "${name}" is listed twice.`);
      good = false;
    } else {
      presets.push(name);
    }
  }
  return good ? presets : undefined;
}

function checkModelSeeds(value: unknown, errors: string[], prefix: string): number | undefined {
  if (value === undefined) return undefined;
  if (!isWhole(value, 1, MAX_MODEL_SEEDS)) {
    errors.push(`${prefix}"model_seeds" must be a whole number from 1 to ${MAX_MODEL_SEEDS}.`);
    return undefined;
  }
  return value;
}

// Optional text: a string, not too long. Returns "" when missing or wrong.
function checkOptionalText(value: unknown, label: string, max: number, errors: string[], prefix: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    errors.push(`${prefix}${label} must be text.`);
    return "";
  }
  if (value.trim().length > max) {
    errors.push(`${prefix}${label} is too long (${value.trim().length} characters). Maximum is ${max}.`);
  }
  return value.trim();
}

function checkPack(value: unknown, errors: string[]): PackPlan["pack"] {
  const pack: PackPlan["pack"] = {
    code: "",
    name: "",
    engine: "",
    style: "",
    defaults: { pictures: DEFAULT_PICTURES, model_presets: [...DEFAULT_MODEL_PRESETS], model_seeds: DEFAULT_MODEL_SEEDS },
  };
  if (!isObject(value)) {
    errors.push(`"pack" is missing. It must be an object with code, name and engine.`);
    return pack;
  }
  const prefix = "Pack: ";
  checkUnknownFields(value, PACK_FIELDS, errors, prefix);

  if (typeof value.code !== "string" || !CODE_PATTERN.test(value.code)) {
    errors.push(`${prefix}the code must be 2 to 5 capital letters, for example "AQT".`);
  } else {
    pack.code = value.code;
  }
  pack.name = checkText(value.name, "the name", MAX_PACK_NAME, errors, prefix);
  if (typeof value.engine !== "string" || !ENGINES.includes(value.engine)) {
    errors.push(`${prefix}the engine must be "unreal" or "none".`);
  } else {
    pack.engine = value.engine;
  }
  pack.style = checkOptionalText(value.style, "the style", MAX_STYLE, errors, prefix);

  if (value.defaults !== undefined) {
    if (!isObject(value.defaults)) {
      errors.push(`${prefix}"defaults" must be an object with any of pictures, model_presets and model_seeds.`);
    } else {
      const defaultsPrefix = "Pack defaults: ";
      checkUnknownFields(value.defaults, DEFAULTS_FIELDS, errors, defaultsPrefix);
      pack.defaults.pictures = checkPictures(value.defaults.pictures, errors, defaultsPrefix) ?? DEFAULT_PICTURES;
      pack.defaults.model_presets = checkModelPresets(value.defaults.model_presets, errors, defaultsPrefix) ?? [...DEFAULT_MODEL_PRESETS];
      pack.defaults.model_seeds = checkModelSeeds(value.defaults.model_seeds, errors, defaultsPrefix) ?? DEFAULT_MODEL_SEEDS;
    }
  }
  return pack;
}

function checkPascal(value: unknown, label: string, max: number, example: string, errors: string[], prefix: string): string {
  if (value === undefined || value === null) {
    errors.push(`${prefix}${label} is missing.`);
    return "";
  }
  if (typeof value !== "string" || !PASCAL_PATTERN.test(value) || value.length > max) {
    errors.push(`${prefix}${label} must be PascalCase, letters and digits only, 1 to ${max} characters, for example "${example}".`);
    return "";
  }
  return value;
}

function checkSize(value: unknown, errors: string[], prefix: string): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    errors.push(`${prefix}the size must be [width, height], for example [1024, 1024].`);
    return undefined;
  }
  const [width, height] = value;
  const good = (n: unknown) => isWhole(n, MIN_SIZE, MAX_SIZE) && (n as number) % SIZE_STEP === 0;
  if (!good(width) || !good(height)) {
    errors.push(`${prefix}the size must be whole numbers from ${MIN_SIZE} to ${MAX_SIZE} that divide by ${SIZE_STEP}, for example [1344, 768].`);
    return undefined;
  }
  return [width, height];
}

function checkRealSize(value: unknown, errors: string[], prefix: string): PlannedItem["real_size"] {
  if (!isObject(value) || Object.keys(value).length === 0) {
    errors.push(`${prefix}"real_size" must be an object with any of height_m, length_m and width_m, for example { "height_m": 12 }.`);
    return null;
  }
  checkUnknownFields(value, REAL_SIZE_FIELDS, errors, `${prefix}real_size: `);
  const realSize: NonNullable<PlannedItem["real_size"]> = {};
  for (const key of REAL_SIZE_FIELDS as (keyof typeof realSize)[]) {
    const n = value[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !(n > 0) || n > MAX_REAL_SIZE_M) {
      errors.push(`${prefix}real_size ${key} must be a number above 0 and at most ${MAX_REAL_SIZE_M}.`);
    } else {
      realSize[key] = n;
    }
  }
  return realSize;
}

// Check one item. Adds every problem to errors. Returns the item with defaults filled in.
function checkItem(value: unknown, number: number, pack: PackPlan["pack"], seen: Map<string, SeenItem>, errors: string[]): PlannedItem | null {
  if (!isObject(value)) {
    errors.push(`Item ${number}: must be an object with id, name, group and kind.`);
    return null;
  }

  // Name the item by its id in every message, if it has one.
  const rawId = typeof value.id === "string" ? value.id.trim() : "";
  const prefix = rawId ? `Item ${number} (${rawId}): ` : `Item ${number}: `;
  checkUnknownFields(value, ITEM_FIELDS, errors, prefix);

  let id = "";
  if (value.id === undefined || value.id === null) {
    errors.push(`${prefix}the id is missing.`);
  } else if (typeof value.id !== "string" || !ID_PATTERN.test(value.id) || value.id.length > MAX_ID) {
    errors.push(`${prefix}the id must look like "VEG-01" or "REF-09A": 2 to 5 capital letters, a dash, 2 or 3 digits, and maybe one capital letter.`);
  } else {
    id = value.id;
    if (seen.has(id)) errors.push(`${prefix}the id is used twice. Every id must be unique.`);
  }

  const name = checkPascal(value.name, "the name", MAX_ITEM_NAME, "CoconutPalm", errors, prefix);
  const group = checkPascal(value.group, "the group", MAX_GROUP, "Vegetation", errors, prefix);

  let kind: ItemKind | null = null;
  if (value.kind === undefined) {
    errors.push(`${prefix}the kind is missing.`);
  } else if (typeof value.kind !== "string" || !(KINDS as readonly string[]).includes(value.kind)) {
    errors.push(`${prefix}the kind ${JSON.stringify(value.kind)} is unknown. Use one of: ${KINDS.join(", ")}.`);
  } else {
    kind = value.kind as ItemKind;
  }

  const isEdit = value.edit_from !== undefined;
  // Remember this item for the edit_from of later items, also when it has errors. A duplicate id keeps the first.
  if (id && !seen.has(id)) seen.set(id, { kind, isEdit });

  const notes = checkOptionalText(value.notes, "the notes", MAX_NOTES, errors, prefix);
  const realSize = value.real_size === undefined ? null : checkRealSize(value.real_size, errors, prefix);

  // A skip item is made outside TeczoForge: it has no prompt, pictures or 3D settings.
  if (kind === "skip") {
    for (const field of MAKING_FIELDS) {
      if (value[field] !== undefined) errors.push(`${prefix}"${field}" is not allowed on a skip item. Skip items are made outside TeczoForge.`);
    }
  }

  // The 3D settings are only for models.
  if (kind === "picture") {
    for (const field of ["model_presets", "model_seeds"]) {
      if (value[field] !== undefined) errors.push(`${prefix}"${field}" is only allowed on kind "model".`);
    }
  }

  let prompt: string | null = null;
  let editFrom: string | null = null;
  let editPrompt: string | null = null;
  let size: [number, number] | null = null;
  const makes = kind === "model" || kind === "picture";

  if (isEdit && kind !== "skip") {
    // An edit: Edit Image on the picked picture of an earlier item. No prompt and no size of its own.
    if (typeof value.edit_from !== "string" || value.edit_from.trim() === "") {
      errors.push(`${prefix}edit_from must be the id of an earlier item.`);
    } else {
      const target = value.edit_from.trim();
      const earlier = seen.get(target);
      if (target === rawId) errors.push(`${prefix}edit_from "${target}" is the item itself. It must be an earlier item.`);
      else if (!earlier) errors.push(`${prefix}edit_from "${target}" is not an earlier item.`);
      else if (earlier.kind === "skip") errors.push(`${prefix}edit_from "${target}" is a skip item. It must be an earlier item of kind "model" or "picture".`);
      else if (earlier.isEdit) errors.push(`${prefix}edit_from "${target}" is itself an edit. It must point to an item that is not an edit.`);
      else editFrom = target;
    }
    if (value.prompt !== undefined) errors.push(`${prefix}"prompt" is not allowed with edit_from. Write the change in edit_prompt.`);
    if (value.size !== undefined) errors.push(`${prefix}"size" is not allowed with edit_from. The size comes from the picture that is edited.`);
    editPrompt = checkText(value.edit_prompt, "edit_prompt", MAX_EDIT_PROMPT, errors, prefix) || null;
  } else if (!isEdit) {
    if (value.edit_prompt !== undefined) errors.push(`${prefix}"edit_prompt" is only allowed with edit_from.`);
    if (makes) {
      const text = checkText(value.prompt, "the prompt", MAX_PROMPT, errors, prefix);
      if (text) prompt = pack.style ? `${pack.style}, ${text}` : text;
      size = value.size === undefined ? [...DEFAULT_SIZE] : (checkSize(value.size, errors, prefix) ?? null);
    }
  }

  const pictures = makes ? (checkPictures(value.pictures, errors, prefix) ?? pack.defaults.pictures) : 0;
  const modelPresets = kind === "model" ? (checkModelPresets(value.model_presets, errors, prefix) ?? [...pack.defaults.model_presets]) : [];
  const modelSeeds = kind === "model" ? (checkModelSeeds(value.model_seeds, errors, prefix) ?? pack.defaults.model_seeds) : 0;

  if (kind === null) return null;

  // B4: the picture (or edit) jobs, then model_presets x model_seeds 3D jobs on the picked picture.
  const jobs: JobCount[] = [];
  if (makes) jobs.push({ presetId: isEdit ? EDIT_PRESET : PICTURE_PRESET, count: pictures });
  for (const preset of modelPresets) jobs.push({ presetId: MODEL_PRESETS[preset], count: modelSeeds });

  return {
    id,
    name,
    group,
    kind,
    prompt,
    edit_from: editFrom,
    edit_prompt: editPrompt,
    size,
    pictures,
    model_presets: modelPresets,
    model_seeds: modelSeeds,
    real_size: realSize,
    notes,
    exportFolder: `${group}/`,
    exportName: `${id}_${name}`,
    jobs,
  };
}

// Every job of the pack, per preset, in the order the presets first appear.
function totalJobs(items: PlannedItem[]): JobCount[] {
  const totals = new Map<string, number>();
  for (const item of items) for (const job of item.jobs) totals.set(job.presetId, (totals.get(job.presetId) ?? 0) + job.count);
  return [...totals].map(([presetId, count]) => ({ presetId, count }));
}

// Check a whole pack file. Returns the plan, or every error found.
export function checkPackFile(text: string): PackCheckResult {
  const block = findSchemaBlock(text, PACK_SCHEMA);
  if ("errors" in block) return { ok: false, errors: block.errors };
  const data: Json = block.data;

  const errors: string[] = [];
  checkUnknownFields(data, ["schema", "pack", "items"], errors, "");

  // Keep checking the items even when the pack part is wrong, so every error shows at once.
  const pack = checkPack(data.pack, errors);

  const items: PlannedItem[] = [];
  if (!Array.isArray(data.items)) {
    errors.push(`"items" is missing. It must be a list of ${MIN_ITEMS} to ${MAX_ITEMS} items.`);
  } else if (data.items.length < MIN_ITEMS) {
    errors.push(`"items" is empty. List ${MIN_ITEMS} to ${MAX_ITEMS} items.`);
  } else {
    if (data.items.length > MAX_ITEMS) errors.push(`There are ${data.items.length} items. Maximum is ${MAX_ITEMS}.`);
    const seen = new Map<string, SeenItem>();
    data.items.forEach((value, index) => {
      const item = checkItem(value, index + 1, pack, seen, errors);
      if (item) items.push(item);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: { pack, items, jobTotals: totalJobs(items) } };
}

// Read the body of a pack file request: { fileName, text }. Throws a 400 or 413 if it is wrong.
// Used by the check and by the import (packs.ts, FRG-78).
export function readPackFileBody(body: unknown): { fileName: string | null; text: string } {
  if (!isObject(body) || typeof body.text !== "string") {
    throw new HttpError(400, 'Send { "fileName": "...", "text": "..." } with the text of the pack file.');
  }
  if (body.fileName !== undefined && body.fileName !== null && typeof body.fileName !== "string") {
    throw new HttpError(400, "fileName must be text.");
  }
  if (Buffer.byteLength(body.text, "utf8") > MAX_GAME_FILE_BYTES) throw new HttpError(413, "This file is too big. The limit is 1 MB.");
  return { fileName: typeof body.fileName === "string" ? body.fileName : null, text: body.text };
}

// POST /api/packs/check
// Body: { "fileName": "...", "text": "..." } (the whole .md file, max 1 MB).
// Answers { ok: true, plan } or { ok: false, errors }. The file is only checked here, nothing is saved.
export function checkPackFileHandler(req: Request, res: Response) {
  try {
    const { text } = readPackFileBody(req.body);
    res.json(checkPackFile(text));
  } catch (error) {
    sendError(res, error);
  }
}
