import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { uploadImage } from "./comfyui.js";
import type { Job } from "./db.js";
import { HttpError } from "./httpError.js";
import { inputFilePath } from "./inputs.js";
import { durationInLog, requireFfmpeg, runFfmpeg } from "./lastFrame.js";
import { buildWorkflow, fileForVoice } from "./presets.js";
import type { Preset, Workflow } from "./presets.js";

// Make the voice fit the video (FRG-85). One S2V part makes a fixed number of frames, so a preset
// with "audioFit" in preset.json gets a voice of exactly that length: a longer one is cut, and a
// shorter one gets silence at the end. The fitted voice is a new WAV in data/inputs, and is the one
// ComfyUI gets. The upload is not changed, and job.inputs keeps its name, so "Use again" starts
// from the voice the user picked.

// ffmpeg gives a length in steps of 0.01 s. A voice this close to the video length is not "cut".
const CUT_MARGIN_SECONDS = 0.05;

type Built = { workflow: Workflow; usedValues: Record<string, string | number> };
type Fitted = { workflow: Workflow; fields: Pick<Job, "audioOriginal" | "audioUsed" | "audioCut" | "stages">; warning: string | undefined };

// The length of the voice in seconds, or null if ffmpeg cannot read it. Decodes nothing.
async function voiceLength(file: string): Promise<number | null> {
  try {
    return durationInLog(await runFfmpeg(["-nostdin", "-hide_banner", "-i", file, "-t", "0", "-f", "null", "-"]));
  } catch {
    return null;
  }
}

// Call this after ensureStartImages, so the voice is in data/inputs.
// Returns the workflow to send, the fields to save on the job, and a warning if the voice was cut.
// A preset without "audioFit": the same workflow, and nothing else.
export async function fitVoice(preset: Preset, workflow: Workflow, built: Built): Promise<Fitted> {
  if (!preset.audioFit) return { workflow: built.workflow, fields: {}, warning: undefined };

  const { input } = preset.audioFit;
  const original = String(built.usedValues[input]);
  requireFfmpeg("Fitting the voice to the video");

  // The workflow file for this job (FRG-89). Its length replaces the one in audioFit.
  const list = preset.workflowFiles;
  const chosen = list ? Number(built.usedValues[list.input]) : undefined;
  const file = !list
    ? undefined
    : chosen === 0
      ? fileForVoice(list.files, await voiceLength(inputFilePath(original)))
      : list.files.find((item) => item.value === chosen);
  const seconds = file?.seconds ?? preset.audioFit.seconds;

  // Our own file name. One ffmpeg run does both: apad adds silence up to the length, and -t cuts at it.
  const fileName = `teczoforge-${Date.now()}-${randomBytes(3).toString("hex")}.wav`;
  const fittedPath = inputFilePath(fileName);
  let voiceSeconds: number | null;
  let audioUsed: string;
  try {
    const log = await runFfmpeg([
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-i",
      inputFilePath(original),
      "-vn",
      "-af",
      `apad=whole_dur=${seconds}`,
      "-t",
      String(seconds),
      "-y",
      fittedPath,
    ]);
    voiceSeconds = durationInLog(log);
    audioUsed = await uploadImage(await readFile(fittedPath), fileName, "audio/wav");
  } catch (error) {
    await rm(fittedPath, { force: true });
    if (error instanceof HttpError) throw error;
    console.error(`Fitting the voice "${original}" failed:`, (error as Error).message);
    throw new HttpError(500, "Could not fit the voice to the video. See the backend log.");
  }

  const cut = voiceSeconds !== null && voiceSeconds > seconds + CUT_MARGIN_SECONDS;
  return {
    // The workflow gets the fitted voice. The values and the seed stay the same.
    workflow: buildWorkflow(preset, workflow, { ...built.usedValues, [input]: audioUsed }, file?.value).workflow,
    fields: { audioOriginal: original, audioUsed, ...(cut ? { audioCut: true } : {}), ...(file ? { stages: file.stages ?? 1 } : {}) },
    warning: cut ? `The voice was ${voiceSeconds!.toFixed(1)} s. Only the first ${seconds.toFixed(1)} s is used.` : undefined,
  };
}
