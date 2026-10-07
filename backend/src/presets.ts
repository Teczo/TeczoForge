import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./httpError.js";

// The presets folder at the root of the repo.
const PRESETS_DIR = path.join(import.meta.dirname, "..", "..", "presets");

// Limits for user input.
const MAX_TEXT_LENGTH = 2000;
const MIN_NUMBER = 1;
const MAX_NUMBER = 4096;
// An image input is the file name from POST /api/upload, for example "teczoforge-1791361258118-a1b2c3.png".
// ComfyUI may add " (1)" if the name is taken. Nothing else is allowed (no folders, no "..").
const IMAGE_NAME_PATTERN = /^[A-Za-z0-9_-]+( \(\d+\))?\.(png|jpe?g|webp)$/i;

// One input the user can change, from preset.json.
type PresetInput = {
  key: string;
  label: string;
  kind: "text" | "seed" | "number" | "image";
  node: string;
  field: string;
  default?: number | string;
};

export type Preset = {
  id: string;
  name: string;
  description?: string;
  type: string;
  inputs: PresetInput[];
  output: { node: string };
};

// A ComfyUI workflow in API format: node id -> node.
export type Workflow = Record<string, { inputs: Record<string, unknown> }>;

// What the page needs to show a preset and build its form.
// Node ids and fields stay in the backend.
export type PresetSummary = {
  id: string;
  name: string;
  description: string;
  type: string;
  inputs: { key: string; label: string; kind: string; default?: number | string }[];
};

// Every folder in presets/ that has a preset.json and a workflow.json, sorted by name.
// A broken folder is skipped with a warning in the log, so one bad preset does not hide the others.
export async function listPresets(): Promise<PresetSummary[]> {
  const folders = await readdir(PRESETS_DIR, { withFileTypes: true });
  const presets: PresetSummary[] = [];

  for (const folder of folders) {
    if (!folder.isDirectory() || !/^[a-z0-9-]+$/.test(folder.name)) continue;
    try {
      const folderPath = path.join(PRESETS_DIR, folder.name);
      await access(path.join(folderPath, "workflow.json"));
      const preset: Preset = JSON.parse(await readFile(path.join(folderPath, "preset.json"), "utf8"));
      presets.push({
        id: folder.name, // The folder name is the id used by POST /api/jobs.
        name: preset.name ?? folder.name,
        description: preset.description ?? "",
        type: preset.type,
        inputs: preset.inputs.map(({ key, label, kind, default: defaultValue }) => ({
          key,
          label,
          kind,
          default: defaultValue,
        })),
      });
    } catch (error) {
      console.warn(`Warning: skipped preset folder "${folder.name}": ${(error as Error).message}`);
    }
  }

  return presets.sort((a, b) => a.name.localeCompare(b.name));
}

// Load preset.json and workflow.json for one preset folder.
export async function loadPreset(presetId: unknown): Promise<{ preset: Preset; workflow: Workflow }> {
  // Only plain folder names like "text-to-image-basic". This also blocks paths like "../".
  if (typeof presetId !== "string" || !/^[a-z0-9-]+$/.test(presetId)) {
    throw new HttpError(400, "presetId must be a preset folder name, for example text-to-image-basic.");
  }

  const folder = path.join(PRESETS_DIR, presetId);
  let presetText: string;
  let workflowText: string;
  try {
    presetText = await readFile(path.join(folder, "preset.json"), "utf8");
    workflowText = await readFile(path.join(folder, "workflow.json"), "utf8");
  } catch {
    throw new HttpError(404, `Unknown preset: ${presetId}`);
  }

  return { preset: JSON.parse(presetText), workflow: JSON.parse(workflowText) };
}

// Check the user's values and put them into a copy of the workflow.
// Also returns the values used, including defaults and the random seed.
export function buildWorkflow(
  preset: Preset,
  workflow: Workflow,
  values: unknown,
): { workflow: Workflow; usedValues: Record<string, string | number> } {
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new HttpError(400, "inputs must be an object, for example { \"prompt\": \"a red car\" }.");
  }
  const userValues = values as Record<string, unknown>;

  // Reject keys the preset does not know about.
  const knownKeys = preset.inputs.map((input) => input.key);
  for (const key of Object.keys(userValues)) {
    if (!knownKeys.includes(key)) {
      throw new HttpError(400, `Unknown input "${key}". This preset accepts: ${knownKeys.join(", ")}.`);
    }
  }

  const result: Workflow = structuredClone(workflow);
  const usedValues: Record<string, string | number> = {};

  for (const input of preset.inputs) {
    const value = checkValue(input, userValues[input.key]);
    usedValues[input.key] = value;

    // Node ids like "57:27" are plain text keys.
    const node = result[input.node];
    if (!node || !(input.field in node.inputs)) {
      throw new HttpError(500, `Preset error: node "${input.node}" field "${input.field}" is not in workflow.json.`);
    }
    node.inputs[input.field] = value;
  }

  return { workflow: result, usedValues };
}

// Check one value. Returns the value to use (the default if the user gave none).
function checkValue(input: PresetInput, value: unknown): string | number {
  if (input.kind === "text") {
    if (value === undefined && typeof input.default === "string") return input.default;
    if (typeof value !== "string" || value.trim() === "") {
      throw new HttpError(400, `${input.label} is required and must be text.`);
    }
    if (value.length > MAX_TEXT_LENGTH) {
      throw new HttpError(400, `${input.label} is too long. Maximum is ${MAX_TEXT_LENGTH} characters.`);
    }
    return value;
  }

  if (input.kind === "seed") {
    // No seed given: pick a random one, so each image is different.
    if (value === undefined) return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new HttpError(400, `${input.label} must be a whole number, 0 or more.`);
    }
    return value as number;
  }

  if (input.kind === "number") {
    if (value === undefined && typeof input.default === "number") return input.default;
    if (!Number.isInteger(value) || (value as number) < MIN_NUMBER || (value as number) > MAX_NUMBER) {
      throw new HttpError(400, `${input.label} must be a whole number from ${MIN_NUMBER} to ${MAX_NUMBER}.`);
    }
    return value as number;
  }

  if (input.kind === "image") {
    if (typeof value !== "string" || value === "") {
      throw new HttpError(400, `${input.label} is required. Pick an image.`);
    }
    if (!IMAGE_NAME_PATTERN.test(value)) {
      throw new HttpError(400, `${input.label} is not a valid uploaded image. Pick the image again.`);
    }
    return value;
  }

  throw new HttpError(500, `Preset error: unknown input kind "${(input as PresetInput).kind}".`);
}
