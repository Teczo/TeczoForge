import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./httpError.js";

// The presets folder at the root of the repo.
const PRESETS_DIR = path.join(import.meta.dirname, "..", "..", "presets");

// Limits for user input.
const MAX_TEXT_LENGTH = 2000;
// A number input without "min" and "max" in preset.json must be in this range.
const MIN_NUMBER = 1;
const MAX_NUMBER = 4096;
// The preset types the app knows (the sidebar groups on the Generate page). "audio" is the
// Music group (FRG-30). "avatar" makes a talking video (FRG-84). Another type still loads, with a
// warning, and shows under "Other".
export const PRESET_TYPES = ["image", "video", "audio", "3d", "edit", "upscale", "avatar"];
// "stages" in preset.json can be at most this.
const MAX_STAGES = 10;
// "fps" in preset.json can be at most this (FRG-52).
const MAX_FPS = 120;
// A "totalLengths" choice can be at most this many seconds (FRG-56; joining allows 60).
const MAX_TOTAL_LENGTH = 60;
// The longest typical run time preset.json may give, in seconds (2 hours, FRG-76).
const MAX_ESTIMATED_SECONDS = 7200;
// An image input is the file name from POST /api/upload, for example "teczoforge-1791361258118-a1b2c3.png".
// ComfyUI may add " (1)" if the name is taken. Nothing else is allowed (no folders, no "..").
export const IMAGE_NAME_PATTERN = /^[A-Za-z0-9_-]+( \(\d+\))?\.(png|jpe?g|webp)$/i;
// An audio input is the file name from POST /api/upload-audio. The same rules as an image name (FRG-84).
export const AUDIO_NAME_PATTERN = /^[A-Za-z0-9_-]+( \(\d+\))?\.(wav|mp3|flac)$/i;

// One allowed value of an input, with the text the page shows for it (FRG-32).
export type InputOption = { value: string | number; label: string };

// One input the user can change, from preset.json.
type PresetInput = {
  key: string;
  label: string;
  kind: "text" | "seed" | "number" | "image" | "audio";
  node: string;
  field: string;
  default?: number | string;
  // Optional (FRG-32). min, max and step only on kind "number"; options on "number" or "text".
  min?: number;
  max?: number;
  step?: number;
  options?: InputOption[];
  // Optional (FRG-52). "seconds": the user picks seconds, and the backend writes the frame count
  // (seconds x the preset's fps + 1) into the workflow. Only on kind "number" with options.
  unit?: "seconds";
  note?: string; // One short line shown under the input.
};

// May the results be used for client work? "conditions": read licenceNote first (FRG-32).
export type ClientWork = "yes" | "no" | "conditions";

export type Preset = {
  id: string;
  name: string;
  description?: string;
  promptGuide?: string; // How to write a good prompt for this model. Chat gives it to Claude (FRG-24).
  sendToLabel?: string; // Name in the "Send to" menu, for example "Animate" (FRG-26). Default: the preset name.
  type: string;
  inputs: PresetInput[];
  output: { node: string };
  // Optional (FRG-32). Old presets without them still load (see checkPreset).
  model?: string; // For example "Z-Image-Turbo".
  licence?: string; // For example "Apache 2.0".
  clientWork?: ClientWork;
  licenceNote?: string; // One short line about the licence.
  experimental?: boolean; // Shown with a "Test" label.
  stages?: number; // Sampler passes, for example 2 for Wan 2.2 (high noise, then low noise). Default 1.
  estimatedSeconds?: number; // A typical run time. Also used by the time estimate (estimate.ts, FRG-76) when there is no history.
  fps?: number; // Frames per second of a video preset. Needed by inputs with "unit": "seconds" (FRG-52).
  // "Make a longer video" (FRG-56): the total lengths in seconds the user can choose, for example
  // [10, 15, 20]. Needs an image input and an input with "unit": "seconds" (the clip length).
  totalLengths?: number[];
  // Make the voice fit the video (FRG-85): the audio input, and the real video length of the
  // workflow in seconds. A longer voice is cut, and a shorter one gets silence at the end.
  audioFit?: { input: string; seconds: number };
  // One exported workflow per video length (FRG-89). A value cannot add nodes, so "input" (a number
  // input with options and no node or field) only picks the file. Its value 0 is "Fit to voice".
  // stages: the sampler passes of that file. Default 1.
  workflowFiles?: { input: string; files: WorkflowFile[] };
  workflows?: Map<number, Workflow>; // The loaded files, by value. Not in preset.json; set by loadWorkflowFiles.
};

export type WorkflowFile = { value: number; file: string; seconds: number; stages?: number };

// A ComfyUI workflow in API format: node id -> node.
export type Workflow = Record<string, { inputs: Record<string, unknown> }>;

// What the page needs to show a preset and build its form.
// Node ids and fields stay in the backend.
export type PresetSummary = {
  id: string;
  name: string;
  description: string;
  promptGuide: string;
  sendToLabel: string;
  type: string;
  model: string; // Empty if preset.json has none.
  licence: string;
  clientWork: ClientWork | null; // null: preset.json does not say.
  licenceNote: string;
  experimental: boolean;
  stages: number;
  estimatedSeconds: number | null;
  totalLengths: number[]; // Empty: the preset makes single clips only (FRG-56).
  audioFit: { input: string; seconds: number } | null; // The page warns before Generate if a voice is longer (FRG-86).
  // The lengths to choose from (FRG-89). The file names stay in the backend.
  workflowFiles: { input: string; files: { value: number; seconds: number }[] } | null;
  inputs: {
    key: string;
    label: string;
    kind: string;
    default?: number | string;
    min?: number;
    max?: number;
    step?: number;
    options?: InputOption[];
    unit?: "seconds";
    note?: string;
  }[];
};

// Warnings already written to the log, so each one shows only once (FRG-28, FRG-32).
const warned = new Set<string>();
function warnOnce(folder: string, text: string) {
  const message = `Warning: preset folder "${folder}": ${text}`;
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

// Check the optional fields of preset.json (FRG-32). A bad value is warned about in the log
// and left out, so the preset still loads with the default. Returns a cleaned copy.
function checkPreset(folder: string, raw: Preset): Preset {
  const preset: Preset = { ...raw };
  const warn = (text: string) => warnOnce(folder, text);

  if (preset.id !== undefined && preset.id !== folder) {
    warn(`"id" is "${preset.id}" in preset.json. The folder name is used as the id.`);
  }
  for (const key of ["model", "licence", "licenceNote"] as const) {
    if (preset[key] !== undefined && (typeof preset[key] !== "string" || preset[key].trim() === "")) {
      warn(`"${key}" must be text. It is ignored.`);
      delete preset[key];
    }
  }
  if (preset.clientWork !== undefined && !["yes", "no", "conditions"].includes(preset.clientWork)) {
    warn(`"clientWork" must be "yes", "no" or "conditions". It is ignored.`);
    delete preset.clientWork;
  }
  if (preset.experimental !== undefined && typeof preset.experimental !== "boolean") {
    warn(`"experimental" must be true or false. It is ignored.`);
    delete preset.experimental;
  }
  if (preset.stages !== undefined && (!Number.isInteger(preset.stages) || preset.stages < 1 || preset.stages > MAX_STAGES)) {
    warn(`"stages" must be a whole number from 1 to ${MAX_STAGES}. 1 is used.`);
    delete preset.stages;
  }
  if (
    preset.estimatedSeconds !== undefined &&
    (!Number.isInteger(preset.estimatedSeconds) || preset.estimatedSeconds < 1 || preset.estimatedSeconds > MAX_ESTIMATED_SECONDS)
  ) {
    warn(`"estimatedSeconds" must be a whole number from 1 to ${MAX_ESTIMATED_SECONDS}. It is ignored.`);
    delete preset.estimatedSeconds;
  }
  if (preset.fps !== undefined && (!Number.isInteger(preset.fps) || preset.fps < 1 || preset.fps > MAX_FPS)) {
    warn(`"fps" must be a whole number from 1 to ${MAX_FPS}. It is ignored.`);
    delete preset.fps;
  }
  if (!PRESET_TYPES.includes(preset.type)) {
    warn(`"type" is "${preset.type}". Known types: ${PRESET_TYPES.join(", ")}. It shows under "Other".`);
  }
  preset.inputs = (preset.inputs ?? [])
    .map((input) => checkInput(folder, input))
    .filter((input) => checkSecondsInput(folder, input, preset.fps));
  if (preset.totalLengths !== undefined) {
    const canChain = preset.inputs.some((input) => input.kind === "image") && preset.inputs.some((input) => input.unit === "seconds");
    if (!canChain) {
      warn(`"totalLengths" needs an image input and an input with "unit": "seconds". It is ignored.`);
      delete preset.totalLengths;
    } else if (
      !Array.isArray(preset.totalLengths) ||
      preset.totalLengths.length === 0 ||
      !preset.totalLengths.every((seconds) => Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_TOTAL_LENGTH)
    ) {
      warn(`"totalLengths" must be a list of whole numbers of seconds from 1 to ${MAX_TOTAL_LENGTH}. It is ignored.`);
      delete preset.totalLengths;
    }
  }
  if (preset.audioFit !== undefined) {
    const { input, seconds } = (preset.audioFit ?? {}) as { input?: unknown; seconds?: unknown };
    const hasInput = preset.inputs.some((item) => item.key === input && item.kind === "audio");
    if (!hasInput || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_TOTAL_LENGTH) {
      warn(`"audioFit" must be like { "input": "<an audio input>", "seconds": 4.875 }, with seconds above 0, up to ${MAX_TOTAL_LENGTH}. It is ignored.`);
      delete preset.audioFit;
    }
  }
  return preset;
}

// Check min, max, step and options of one input. Bad ones are warned about and left out.
function checkInput(folder: string, raw: PresetInput): PresetInput {
  const input: PresetInput = { ...raw };
  const warn = (text: string) => warnOnce(folder, `input "${input.key}": ${text}`);

  for (const key of ["min", "max", "step"] as const) {
    if (input[key] === undefined) continue;
    if (input.kind !== "number") {
      warn(`"${key}" only works on kind "number". It is ignored.`);
      delete input[key];
    } else if (!Number.isInteger(input[key]) || (input[key] as number) < (key === "step" ? 1 : 0)) {
      warn(`"${key}" must be a whole number${key === "step" ? " above 0" : ", 0 or more"}. It is ignored.`);
      delete input[key];
    }
  }
  if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
    warn(`"min" is bigger than "max". Both are ignored.`);
    delete input.min;
    delete input.max;
  }

  if (input.options !== undefined) {
    const valueType = input.kind === "number" ? "number" : "string";
    const good =
      (input.kind === "number" || input.kind === "text") &&
      Array.isArray(input.options) &&
      input.options.length > 0 &&
      input.options.every(
        (option) =>
          typeof option?.label === "string" &&
          typeof option.value === valueType &&
          (valueType === "string" || Number.isInteger(option.value)),
      );
    if (!good) {
      warn(
        input.kind === "number" || input.kind === "text"
          ? `"options" must be a list like [{ "value": ${valueType === "number" ? "512" : '"a"'}, "label": "..." }]. It is ignored.`
          : `"options" only works on kind "number" or "text". It is ignored.`,
      );
      delete input.options;
    }
  }
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.trim() === "")) {
    warn(`"note" must be text. It is ignored.`);
    delete input.note;
  }
  return input;
}

// The frame count for a length in seconds: seconds x fps + 1 (FRG-52).
// For example 5 s at 16 fps is 81 frames. Wan 2.2 needs 4n + 1 frames, so 81 is good and 80 is not.
export function secondsToFrames(seconds: number, fps: number): number {
  return seconds * fps + 1;
}
function isGoodFrameCount(frames: number): boolean {
  return Number.isInteger(frames) && frames >= 1 && (frames - 1) % 4 === 0;
}

// An input with "unit": "seconds" (FRG-52). It needs the preset's fps and a list of options,
// and every option must give 4n + 1 frames. Bad options are left out. Returns false if the
// input cannot be used at all: it is then left out, and the workflow keeps its own length.
function checkSecondsInput(folder: string, input: PresetInput, fps: number | undefined): boolean {
  if (input.unit === undefined) return true;
  const warn = (text: string) => warnOnce(folder, `input "${input.key}": ${text}`);
  if (input.unit !== "seconds" || input.kind !== "number" || !input.options) {
    warn(`"unit" must be "seconds", on kind "number" with "options". The input is left out.`);
    return false;
  }
  if (fps === undefined) {
    warn(`"unit": "seconds" needs "fps" in preset.json. The input is left out.`);
    return false;
  }
  input.options = input.options.filter((option) => {
    const frames = secondsToFrames(option.value as number, fps);
    if (option.value as number >= 1 && isGoodFrameCount(frames)) return true;
    warn(`${option.value} s at ${fps} fps is ${frames} frames, which is not 4n + 1. This option is left out.`);
    return false;
  });
  if (input.options.length === 0) {
    warn(`no option is left. The input is left out.`);
    return false;
  }
  if (input.default !== undefined && !input.options.some((option) => option.value === input.default)) {
    warn(`"default" is not one of the options. The first option is used.`);
    input.default = input.options[0].value;
  }
  return true;
}

// Load the files of "workflowFiles" (FRG-89). Any problem gives one warning, and the preset carries
// on with only workflow.json, without the input that picks the file.
async function loadWorkflowFiles(folder: string, folderPath: string, preset: Preset): Promise<void> {
  const list = preset.workflowFiles;
  if (list === undefined) return;
  const problem = await workflowFilesProblem(folderPath, preset);
  if (problem === null) return;
  warnOnce(folder, `"workflowFiles": ${problem} Only workflow.json is used.`);
  preset.inputs = preset.inputs.filter((input) => input.key !== list?.input);
  delete preset.workflowFiles;
  delete preset.workflows;
}

// Checks every file and fills preset.workflows. Returns what is wrong, or null.
async function workflowFilesProblem(folderPath: string, preset: Preset): Promise<string | null> {
  const { input: key, files } = preset.workflowFiles!;
  const picker = preset.inputs.find((input) => input.key === key);
  if (!picker || picker.kind !== "number" || !picker.options || picker.node !== undefined || picker.field !== undefined) {
    return `"${key}" must be a number input with options and no node or field.`;
  }
  if (!preset.audioFit) return `it needs "audioFit".`;
  if (!Array.isArray(files) || files.length === 0) return `"files" must be a list.`;
  const workflows = new Map<number, Workflow>();
  for (const entry of files) {
    if (!Number.isInteger(entry?.value) || entry.value < 1 || !/^[A-Za-z0-9_-]+\.json$/.test(String(entry.file))) {
      return `each file needs a "value" above 0 and a plain file name.`;
    }
    if (typeof entry.seconds !== "number" || entry.seconds <= 0 || entry.seconds > MAX_TOTAL_LENGTH) {
      return `"${entry.file}" needs "seconds" above 0, up to ${MAX_TOTAL_LENGTH}.`;
    }
    if (entry.stages !== undefined && (!Number.isInteger(entry.stages) || entry.stages < 1 || entry.stages > MAX_STAGES)) {
      return `"${entry.file}" has bad "stages".`;
    }
    let workflow: Workflow;
    try {
      workflow = JSON.parse(await readFile(path.join(folderPath, entry.file), "utf8"));
    } catch {
      return `"${entry.file}" is missing or is not valid JSON.`;
    }
    for (const input of preset.inputs) {
      if (input.key === key) continue;
      if (!workflow[input.node] || !(input.field in workflow[input.node].inputs)) {
        return `"${entry.file}" has no node "${input.node}" field "${input.field}".`;
      }
    }
    if (!workflow[preset.output?.node]) return `"${entry.file}" has no output node.`;
    workflows.set(entry.value, workflow);
  }
  // Every button must have a file. 0 is "Fit to voice".
  for (const option of picker.options) {
    if (option.value !== 0 && !workflows.has(option.value as number)) return `the option ${option.value} has no file.`;
  }
  preset.workflows = workflows;
  return null;
}

// "Fit to voice" (FRG-89): the shortest file that holds the voice. Too long for all: the longest.
export function fileForVoice(files: WorkflowFile[], voiceSeconds: number | null): WorkflowFile {
  const sorted = [...files].sort((a, b) => a.seconds - b.seconds);
  if (voiceSeconds === null) return sorted.at(-1)!;
  return sorted.find((file) => file.seconds >= voiceSeconds) ?? sorted.at(-1)!;
}

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
      const preset = checkPreset(folder.name, JSON.parse(await readFile(path.join(folderPath, "preset.json"), "utf8")));
      await loadWorkflowFiles(folder.name, folderPath, preset);
      presets.push({
        id: folder.name, // The folder name is the id used by POST /api/jobs.
        name: preset.name ?? folder.name,
        description: preset.description ?? "",
        promptGuide: preset.promptGuide ?? "",
        sendToLabel: preset.sendToLabel ?? "",
        type: preset.type,
        model: preset.model ?? "",
        licence: preset.licence ?? "",
        clientWork: preset.clientWork ?? null,
        licenceNote: preset.licenceNote ?? "",
        experimental: preset.experimental ?? false,
        stages: preset.stages ?? 1,
        estimatedSeconds: preset.estimatedSeconds ?? null,
        totalLengths: preset.totalLengths ?? [],
        audioFit: preset.audioFit ?? null,
        workflowFiles: preset.workflowFiles
          ? { input: preset.workflowFiles.input, files: preset.workflowFiles.files.map(({ value, seconds }) => ({ value, seconds })) }
          : null,
        inputs: preset.inputs.map(({ key, label, kind, default: defaultValue, min, max, step, options, unit, note }) => ({
          key,
          label,
          kind,
          default: defaultValue,
          min,
          max,
          step,
          options,
          unit,
          note,
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

  const preset = checkPreset(presetId, JSON.parse(presetText));
  await loadWorkflowFiles(presetId, folder, preset);
  return { preset, workflow: JSON.parse(workflowText) };
}

// Check the user's values and put them into a copy of the workflow.
// Also returns the values used, including defaults and the random seed.
// With "workflowFiles" (FRG-89) the workflow is the chosen file: fileValue, else the value of the
// input that picks it. "Fit to voice" (0) needs the voice length, so fitVoice passes fileValue;
// until then the longest file is used to check the values.
export function buildWorkflow(
  preset: Preset,
  workflow: Workflow,
  values: unknown,
  fileValue?: number,
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

  const usedValues: Record<string, string | number> = {};
  let source = workflow;
  const list = preset.workflowFiles;
  const picker = preset.inputs.find((input) => input.key === list?.input);
  if (list && picker && preset.workflows) {
    const chosen = fileValue ?? (checkValue(picker, userValues[picker.key]) as number);
    source = preset.workflows.get(chosen === 0 ? fileForVoice(list.files, null).value : chosen) ?? workflow;
  }
  const result: Workflow = structuredClone(source);

  for (const input of preset.inputs) {
    const value = checkValue(input, userValues[input.key]);
    usedValues[input.key] = value;
    if (input === picker) continue; // It only picks the file.

    // Node ids like "57:27" are plain text keys.
    const node = result[input.node];
    if (!node || !(input.field in node.inputs)) {
      throw new HttpError(500, `Preset error: node "${input.node}" field "${input.field}" is not in workflow.json.`);
    }
    node.inputs[input.field] = input.unit === "seconds" ? framesFor(preset, input, value as number) : value;
  }

  return { workflow: result, usedValues };
}

// The frame count to write for a value in seconds (FRG-52). checkPreset already checked the
// options, so this only fails if preset.json changed in a way the checks did not expect.
function framesFor(preset: Preset, input: PresetInput, seconds: number): number {
  const frames = secondsToFrames(seconds, preset.fps ?? 0);
  if (!isGoodFrameCount(frames)) {
    throw new HttpError(500, `Preset error: ${input.label} ${seconds} s gives ${frames} frames, which is not 4n + 1.`);
  }
  return frames;
}

// The allowed values of an input as one line, for example "512 (Small), 1024 (Large)".
function optionList(options: InputOption[]): string {
  return options.map((option) => (String(option.value) === option.label ? option.label : `${option.value} (${option.label})`)).join(", ");
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
    if (input.options && !input.options.some((option) => option.value === value)) {
      throw new HttpError(400, `${input.label} must be one of: ${optionList(input.options)}.`);
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
    if (input.options) {
      if (!input.options.some((option) => option.value === value)) {
        if (input.unit === "seconds") {
          // For example "Duration must be 3, 5 or 7 seconds."
          const values = input.options.map((option) => String(option.value));
          throw new HttpError(400, `${input.label} must be ${values.slice(0, -1).join(", ")}${values.length > 1 ? " or " : ""}${values.at(-1)} seconds.`);
        }
        throw new HttpError(400, `${input.label} must be one of: ${optionList(input.options)}.`);
      }
      return value as number;
    }
    // min and max from preset.json (FRG-32). Without them: the old 1 to 4096 rule.
    const min = input.min ?? MIN_NUMBER;
    const max = input.max ?? MAX_NUMBER;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      throw new HttpError(400, `${input.label} must be a whole number from ${min} to ${max}.`);
    }
    if (input.step && (value as number) % input.step !== 0) {
      throw new HttpError(400, `${input.label} must be a multiple of ${input.step}, for example ${Math.round((value as number) / input.step) * input.step}.`);
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

  if (input.kind === "audio") {
    if (typeof value !== "string" || value === "") {
      throw new HttpError(400, `${input.label} is required. Pick a voice file.`);
    }
    if (!AUDIO_NAME_PATTERN.test(value)) {
      throw new HttpError(400, `${input.label} is not a valid uploaded voice file. Pick the file again.`);
    }
    return value;
  }

  throw new HttpError(500, `Preset error: unknown input kind "${(input as PresetInput).kind}".`);
}
