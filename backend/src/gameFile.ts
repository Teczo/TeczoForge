import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { sendError } from "./jobs.js";

// Game design files (FRG-65). The format is in docs/game-design-format.md.
// A game design file is a .md file with free prose and exactly ONE ```json block
// with "schema": "teczoforge-game/1". This file finds that block, checks every rule,
// and answers with a plan (every asset with its defaults and the preset for each step),
// or with ALL the errors at once, in plain English.
// Nothing is saved here. Saving is FRG-66.

export const GAME_SCHEMA = "teczoforge-game/1";

// The biggest file we read: 1 MB of text.
export const MAX_GAME_FILE_BYTES = 1024 * 1024;

const MAX_GAME_NAME = 60;
const MAX_STYLE = 300;
const MAX_PALETTE = 6;
const MAX_ASSETS = 150;
const MAX_ID = 64;
const MAX_PROMPT = 2000;
const MAX_USE = 200;

// Picture sizes, the same limits as the text-to-image-basic preset.
const MIN_SIZE = 512;
const MAX_SIZE = 2048;
const SIZE_STEP = 16;
const DEFAULT_SIZE: [number, number] = [1024, 1024];

const DEFAULT_TARGET_HEIGHT_M = 1;
const MAX_TARGET_HEIGHT_M = 1000;
const MAX_DURATION_S = 600;

const ID_PATTERN = /^[A-Z]{3}_(MDL|TEX|SPR|BG|UI|ICO|MUS|SFX)_[A-Z][A-Za-z0-9]*_[A-Z][A-Za-z0-9]*(_[A-Z0-9][A-Za-z0-9]*)?$/;
const CODE_PATTERN = /^[A-Z]{3}$/;
const CATEGORY_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const HEX_COLOUR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const DIMENSIONS = ["2D", "3D"];
const PIPELINES = ["URP", "HDRP", "BuiltIn"];
const SOURCES = ["forge", "external"];
const NEEDS = ["rigging", "animation", "transparent_bg", "tiling"];

export const IMAGE_PRESET = "text-to-image-basic";
const MODEL_PRESET = "image-to-3d-trellis2";
const MUSIC_PRESET = "music-ace-step-xl";

type AssetType = "model" | "texture" | "sprite" | "background" | "ui" | "icon" | "music" | "sfx";

// For each type: its code in the id, its export folder, and whether it is a picture.
const ASSET_TYPES: Record<AssetType, { code: string; folder: string; image: boolean }> = {
  model: { code: "MDL", folder: "Models", image: false },
  texture: { code: "TEX", folder: "Textures", image: true },
  sprite: { code: "SPR", folder: "Sprites", image: true },
  background: { code: "BG", folder: "Backgrounds", image: true },
  ui: { code: "UI", folder: "UI", image: true },
  icon: { code: "ICO", folder: "Icons", image: true },
  music: { code: "MUS", folder: "Audio/Music", image: false },
  sfx: { code: "SFX", folder: "Audio/SFX", image: false },
};

// The folder of an asset inside the export (FRG-70), as path parts, for example ["Audio", "Music", "Levels"].
// The concept art (type "reference", FRG-68) goes to _Reference/. null for an unknown type.
export function exportFolderParts(type: string, category: string): string[] | null {
  if (type === "reference") return ["_Reference"];
  if (!isAssetType(type)) return null;
  return [...ASSET_TYPES[type].folder.split("/"), category];
}

const GAME_FIELDS = ["code", "name", "dimension", "pipeline", "style", "palette"];
const ASSET_FIELDS = ["id", "type", "category", "prompt", "use", "size", "target_height_m", "duration_s", "source", "needs"];

// One generation step: which preset runs, and the full prompt it gets.
export type PlanStep = { preset: string; prompt: string };

export type PlannedAsset = {
  id: string;
  type: AssetType | "concept";
  category: string;
  prompt: string;
  use: string;
  source: "forge" | "external";
  needs: string[];
  size?: [number, number];
  target_height_m?: number;
  duration_s?: number;
  exportFolder: string;
  // Empty for external assets: TeczoForge does not make them.
  steps: PlanStep[];
};

export type GamePlan = {
  game: {
    code: string;
    name: string;
    dimension: string;
    pipeline: string;
    style: string;
    palette: string[];
  };
  // The concept art TeczoForge makes first. It is not listed in the file.
  concept: PlannedAsset;
  assets: PlannedAsset[];
};

export type CheckResult = { ok: true; plan: GamePlan } | { ok: false; errors: string[] };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Find every ```json block in the text. Each block runs from a line "```json" to the next line "```".
function findJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split(/\r?\n/);
  let current: string[] | null = null;
  for (const line of lines) {
    if (current === null) {
      if (/^\s*```\s*json\s*$/i.test(line)) current = [];
    } else if (/^\s*```\s*$/.test(line)) {
      blocks.push(current.join("\n"));
      current = null;
    } else {
      current.push(line);
    }
  }
  // A block that is never closed still counts, so we can say what is wrong with it.
  if (current !== null) blocks.push(current.join("\n"));
  return blocks;
}

// Find the one json block with our schema. Returns the parsed JSON, or the errors.
function findGameBlock(text: string): { data: Json } | { errors: string[] } {
  const blocks = findJsonBlocks(text);
  if (blocks.length === 0) {
    return { errors: [`No \`\`\`json block was found. The file needs exactly one, with "schema": "${GAME_SCHEMA}".`] };
  }

  const found: Json[] = [];
  const otherErrors: string[] = [];
  blocks.forEach((block, index) => {
    const name = blocks.length === 1 ? "The json block" : `Json block ${index + 1}`;
    let data: unknown;
    try {
      data = JSON.parse(block);
    } catch (error) {
      // Only complain about a broken block if it looks like ours.
      if (block.includes(GAME_SCHEMA) || blocks.length === 1) {
        otherErrors.push(`${name} is not valid JSON: ${(error as Error).message}`);
      }
      return;
    }
    if (isObject(data) && data.schema === GAME_SCHEMA) {
      found.push(data);
    } else if (isObject(data) && "schema" in data) {
      otherErrors.push(`${name} has "schema": ${JSON.stringify(data.schema)}. It must be "${GAME_SCHEMA}".`);
    }
  });

  if (found.length > 1) {
    return { errors: [`Found ${found.length} json blocks with "schema": "${GAME_SCHEMA}". The file must have exactly one.`] };
  }
  if (found.length === 1 && otherErrors.length === 0) return { data: found[0] };
  if (found.length === 0 && otherErrors.length === 0) {
    return { errors: [`No json block has "schema": "${GAME_SCHEMA}". The file needs exactly one.`] };
  }
  return { errors: otherErrors };
}

// Check text: required, a string, not empty, and not too long. Adds an error and returns "" if wrong.
function checkText(value: unknown, label: string, max: number, errors: string[], prefix: string): string {
  if (value === undefined || value === null) {
    errors.push(`${prefix}${label} is missing.`);
    return "";
  }
  if (typeof value !== "string") {
    errors.push(`${prefix}${label} must be text.`);
    return "";
  }
  if (value.trim() === "") {
    errors.push(`${prefix}${label} is empty.`);
    return "";
  }
  if (value.trim().length > max) {
    errors.push(`${prefix}${label} is too long (${value.trim().length} characters). Maximum is ${max}.`);
  }
  return value.trim();
}

function checkUnknownFields(data: Json, allowed: string[], errors: string[], prefix: string) {
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) {
      errors.push(`${prefix}"${key}" is not a known field. Known fields: ${allowed.join(", ")}.`);
    }
  }
}

function checkGame(value: unknown, errors: string[]): GamePlan["game"] | null {
  if (!isObject(value)) {
    errors.push(`"game" is missing. It must be an object with code, name, dimension, pipeline and style.`);
    return null;
  }
  const prefix = "Game: ";
  checkUnknownFields(value, GAME_FIELDS, errors, prefix);

  let code = "";
  if (typeof value.code !== "string" || !CODE_PATTERN.test(value.code)) {
    errors.push(`${prefix}the code must be 3 capital letters, for example "SKR".`);
  } else {
    code = value.code;
  }

  const name = checkText(value.name, "the name", MAX_GAME_NAME, errors, prefix);

  let dimension = "";
  if (typeof value.dimension !== "string" || !DIMENSIONS.includes(value.dimension)) {
    errors.push(`${prefix}the dimension must be "2D" or "3D".`);
  } else {
    dimension = value.dimension;
  }

  let pipeline = "";
  if (typeof value.pipeline !== "string" || !PIPELINES.includes(value.pipeline)) {
    errors.push(`${prefix}the pipeline must be "URP", "HDRP" or "BuiltIn".`);
  } else {
    pipeline = value.pipeline;
  }

  const style = checkText(value.style, "the style", MAX_STYLE, errors, prefix);

  let palette: string[] = [];
  if (value.palette !== undefined) {
    if (!Array.isArray(value.palette)) {
      errors.push(`${prefix}the palette must be a list of hex colours, for example ["#87CEEB", "#FFD166"].`);
    } else {
      if (value.palette.length > MAX_PALETTE) {
        errors.push(`${prefix}the palette has ${value.palette.length} colours. Maximum is ${MAX_PALETTE}.`);
      }
      value.palette.forEach((colour, index) => {
        if (typeof colour !== "string" || !HEX_COLOUR_PATTERN.test(colour)) {
          errors.push(`${prefix}palette colour ${index + 1} (${JSON.stringify(colour)}) is not a hex colour like "#87CEEB".`);
        }
      });
      palette = value.palette.filter((colour): colour is string => typeof colour === "string");
    }
  }

  return { code, name, dimension, pipeline, style, palette };
}

function isAssetType(value: unknown): value is AssetType {
  return typeof value === "string" && Object.hasOwn(ASSET_TYPES, value);
}

// Check one asset. Adds every problem to errors. Returns the asset with defaults filled in.
function checkAsset(value: unknown, number: number, game: GamePlan["game"], seenIds: Set<string>, errors: string[]): PlannedAsset | null {
  if (!isObject(value)) {
    errors.push(`Asset ${number}: must be an object with id, type, category, prompt and use.`);
    return null;
  }

  // Name the asset by its id in every message, if it has one.
  const rawId = typeof value.id === "string" ? value.id.trim() : "";
  const prefix = rawId ? `Asset ${number} (${rawId}): ` : `Asset ${number}: `;
  checkUnknownFields(value, ASSET_FIELDS, errors, prefix);

  const id = checkText(value.id, "the id", MAX_ID, errors, prefix);
  let idParts: string[] = [];
  if (id) {
    if (seenIds.has(id)) errors.push(`${prefix}the id is used twice. Every id must be unique.`);
    seenIds.add(id);
    if (!ID_PATTERN.test(id)) {
      errors.push(`${prefix}the id does not follow the pattern {CODE}_{TYPECODE}_{Category}_{Name}[_{Variant}], for example "SKR_BG_Levels_Sky".`);
    } else {
      idParts = id.split("_");
      if (game.code && idParts[0] !== game.code) {
        errors.push(`${prefix}the id starts with "${idParts[0]}", but the game code is "${game.code}".`);
      }
    }
  }

  let type: AssetType | null = null;
  if (value.type === undefined) {
    errors.push(`${prefix}the type is missing.`);
  } else if (!isAssetType(value.type)) {
    errors.push(`${prefix}the type ${JSON.stringify(value.type)} is unknown. Use one of: ${Object.keys(ASSET_TYPES).join(", ")}.`);
  } else {
    type = value.type;
    if (idParts.length > 0 && idParts[1] !== ASSET_TYPES[type].code) {
      errors.push(`${prefix}the type is "${type}", so the id must have "${ASSET_TYPES[type].code}" as its second part, not "${idParts[1]}".`);
    }
  }

  let category = "";
  if (value.category === undefined) {
    errors.push(`${prefix}the category is missing.`);
  } else if (typeof value.category !== "string" || !CATEGORY_PATTERN.test(value.category)) {
    errors.push(`${prefix}the category must be PascalCase, for example "Levels".`);
  } else {
    category = value.category;
    if (idParts.length > 0 && idParts[2] !== category) {
      errors.push(`${prefix}the category is "${category}", but the third part of the id is "${idParts[2]}". They must be the same.`);
    }
  }

  const prompt = checkText(value.prompt, "the prompt", MAX_PROMPT, errors, prefix);
  const use = checkText(value.use, "the use", MAX_USE, errors, prefix);

  let source: "forge" | "external" = "forge";
  if (value.source !== undefined) {
    if (typeof value.source !== "string" || !SOURCES.includes(value.source)) {
      errors.push(`${prefix}the source must be "forge" or "external".`);
    } else {
      source = value.source as "forge" | "external";
    }
  }
  if (type === "sfx" && source !== "external") {
    errors.push(`${prefix}sound effects cannot be made by TeczoForge yet. Set "source": "external".`);
  }

  let needs: string[] = [];
  if (value.needs !== undefined) {
    if (!Array.isArray(value.needs)) {
      errors.push(`${prefix}"needs" must be a list, for example ["transparent_bg"].`);
    } else {
      for (const need of value.needs) {
        if (typeof need !== "string" || !NEEDS.includes(need)) {
          errors.push(`${prefix}the need ${JSON.stringify(need)} is unknown. Use any of: ${NEEDS.join(", ")}.`);
        } else if (needs.includes(need)) {
          errors.push(`${prefix}the need "${need}" is listed twice.`);
        } else {
          needs.push(need);
        }
      }
    }
  }

  const isImage = type !== null && ASSET_TYPES[type].image;

  let size: [number, number] | undefined;
  if (value.size !== undefined) {
    if (type !== null && !isImage) {
      errors.push(`${prefix}"size" is only for picture types (texture, sprite, background, ui, icon).`);
    } else if (!Array.isArray(value.size) || value.size.length !== 2) {
      errors.push(`${prefix}the size must be [width, height], for example [1024, 1024].`);
    } else {
      const [width, height] = value.size;
      const good = (n: unknown) => Number.isInteger(n) && (n as number) >= MIN_SIZE && (n as number) <= MAX_SIZE && (n as number) % SIZE_STEP === 0;
      if (!good(width) || !good(height)) {
        errors.push(`${prefix}the size must be whole numbers from ${MIN_SIZE} to ${MAX_SIZE} that divide by ${SIZE_STEP}, for example [1344, 768].`);
      } else {
        size = [width, height];
      }
    }
  } else if (isImage) {
    size = [...DEFAULT_SIZE];
  }

  let targetHeight: number | undefined;
  if (value.target_height_m !== undefined) {
    if (type !== null && type !== "model") {
      errors.push(`${prefix}"target_height_m" is only for models.`);
    } else if (typeof value.target_height_m !== "number" || !(value.target_height_m > 0) || value.target_height_m > MAX_TARGET_HEIGHT_M) {
      errors.push(`${prefix}target_height_m must be a number above 0 and at most ${MAX_TARGET_HEIGHT_M}.`);
    } else {
      targetHeight = value.target_height_m;
    }
  } else if (type === "model") {
    targetHeight = DEFAULT_TARGET_HEIGHT_M;
  }

  let duration: number | undefined;
  if (value.duration_s !== undefined) {
    if (type !== null && type !== "music") {
      errors.push(`${prefix}"duration_s" is only for music.`);
    } else if (typeof value.duration_s !== "number" || !(value.duration_s > 0) || value.duration_s > MAX_DURATION_S) {
      errors.push(`${prefix}duration_s must be a number of seconds above 0 and at most ${MAX_DURATION_S}.`);
    } else {
      duration = value.duration_s;
    }
  }

  if (type === null) return null;

  const asset: PlannedAsset = {
    id,
    type,
    category,
    prompt,
    use,
    source,
    needs,
    exportFolder: `${ASSET_TYPES[type].folder}/${category}/`,
    steps: source === "external" ? [] : stepsFor(type, prompt, game),
  };
  if (size) asset.size = size;
  if (targetHeight !== undefined) asset.target_height_m = targetHeight;
  if (duration !== undefined) asset.duration_s = duration;
  return asset;
}

// The parts of a game that its prompts use.
type PromptGame = { name: string; style: string; palette: string[] };

// The full prompt for a picture: "{style}, colour palette: {palette}, {parts}" (FRG-68).
// Without a palette: "{style}, {parts}".
function imagePrompt(game: PromptGame, ...parts: string[]): string {
  const all = [game.style];
  if (game.palette.length > 0) all.push(`colour palette: ${game.palette.join(", ")}`);
  return [...all, ...parts].join(", ");
}

// The prompt of an asset's first step, the one its board card runs (FRG-68).
// Models: the reference picture prompt from the format doc. Music: the asset prompt as written
// (the style is for pictures). Every other type: the picture prompt.
export function firstStepPrompt(game: PromptGame, type: string, prompt: string): string {
  if (type === "model") return imagePrompt(game, prompt, "single object, centred, full view from the front, plain white background, no shadow");
  if (type === "music") return prompt;
  return imagePrompt(game, prompt);
}

// The prompt of the concept art (FRG-68): style, palette, the game name, "key art, concept art".
export function conceptPrompt(game: PromptGame): string {
  return imagePrompt(game, game.name, "key art, concept art");
}

function stepsFor(type: AssetType, prompt: string, game: GamePlan["game"]): PlanStep[] {
  if (type === "model") {
    // The 3D step uses the reference picture, not text.
    return [
      { preset: IMAGE_PRESET, prompt: firstStepPrompt(game, type, prompt) },
      { preset: MODEL_PRESET, prompt: "" },
    ];
  }
  if (type === "sfx") return [];
  return [{ preset: type === "music" ? MUSIC_PRESET : IMAGE_PRESET, prompt: firstStepPrompt(game, type, prompt) }];
}

// The concept art: made by TeczoForge first, sets the look for every other asset.
function conceptFor(game: GamePlan["game"]): PlannedAsset {
  const prompt = "key art, concept art";
  return {
    id: `${game.code}_REF_Style_Concept`,
    type: "concept",
    category: "Style",
    prompt,
    use: "Style reference for every asset",
    source: "forge",
    needs: [],
    size: [...DEFAULT_SIZE],
    exportFolder: "_Reference/",
    steps: [{ preset: IMAGE_PRESET, prompt: conceptPrompt(game) }],
  };
}

// Check a whole game design file. Returns the plan, or every error found.
export function checkGameFile(text: string): CheckResult {
  const block = findGameBlock(text);
  if ("errors" in block) return { ok: false, errors: block.errors };
  const data = block.data;

  const errors: string[] = [];
  checkUnknownFields(data, ["schema", "game", "assets"], errors, "");

  // Keep checking the assets even when the game part is wrong, so every error shows at once.
  const game = checkGame(data.game, errors) ?? { code: "", name: "", dimension: "", pipeline: "", style: "", palette: [] };

  const assets: PlannedAsset[] = [];
  if (!Array.isArray(data.assets)) {
    errors.push(`"assets" is missing. It must be a list of 1 to ${MAX_ASSETS} assets.`);
  } else if (data.assets.length === 0) {
    errors.push(`"assets" is empty. List 1 to ${MAX_ASSETS} assets.`);
  } else {
    if (data.assets.length > MAX_ASSETS) {
      errors.push(`There are ${data.assets.length} assets. Maximum is ${MAX_ASSETS}.`);
    }
    const seenIds = new Set<string>();
    data.assets.forEach((value, index) => {
      const asset = checkAsset(value, index + 1, game, seenIds, errors);
      if (asset) assets.push(asset);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: { game, concept: conceptFor(game), assets } };
}

// Read the body of a game file request: { fileName, text }. Throws a 400 or 413 if it is wrong.
export function readGameFileBody(body: unknown): { fileName: string | null; text: string } {
  if (!isObject(body) || typeof body.text !== "string") {
    throw new HttpError(400, 'Send { "fileName": "...", "text": "..." } with the text of the game design file.');
  }
  if (body.fileName !== undefined && body.fileName !== null && typeof body.fileName !== "string") {
    throw new HttpError(400, "fileName must be text.");
  }
  if (Buffer.byteLength(body.text, "utf8") > MAX_GAME_FILE_BYTES) {
    throw new HttpError(413, "This file is too big. The limit is 1 MB.");
  }
  return { fileName: typeof body.fileName === "string" ? body.fileName : null, text: body.text };
}

// POST /api/games/check. Body: { fileName, text }. Answers { ok: true, plan } or { ok: false, errors }.
// The file is only checked here, nothing is saved.
export function checkGameFileHandler(req: Request, res: Response) {
  try {
    const { text } = readGameFileBody(req.body);
    res.json(checkGameFile(text));
  } catch (error) {
    sendError(res, error);
  }
}
