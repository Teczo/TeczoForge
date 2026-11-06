import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./httpError.js";
import { getInputImage, uploadImage } from "./comfyui.js";
import { AUDIO_NAME_PATTERN, buildWorkflow, IMAGE_NAME_PATTERN } from "./presets.js";
import type { Preset, Workflow } from "./presets.js";

// Start images (FRG-25, audit R4) and voice files (FRG-84).
// Every uploaded file is also kept in data/inputs, with the same name it has in ComfyUI.
// ComfyUI's input folder may be cleaned, so before a job is queued the backend checks that the
// file is still there, and uploads it again from data/inputs if it is not.

// data/inputs at the root of the repo.
export const INPUTS_DIR = path.join(import.meta.dirname, "..", "..", "data", "inputs");

export type ImageInfo = { extension: "png" | "jpg" | "webp"; mediaType: string; width: number; height: number };

// What kind of picture this is, and its size in pixels, read from the first bytes of the file.
// Returns null if it is not a PNG, JPEG or WebP picture (so a renamed non-image is refused).
export function imageInfo(data: Buffer): ImageInfo | null {
  // PNG: fixed signature, then the IHDR chunk with width and height.
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png", mediaType: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  // JPEG: walk the markers until the "start of frame" that holds the size.
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    let at = 2;
    while (at + 9 < data.length) {
      if (data[at] !== 0xff) return { extension: "jpg", mediaType: "image/jpeg", width: 0, height: 0 };
      const marker = data[at + 1];
      if (marker === 0xff) {
        at++; // Padding.
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return { extension: "jpg", mediaType: "image/jpeg", width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
      }
      at += 2 + data.readUInt16BE(at + 2);
    }
    return { extension: "jpg", mediaType: "image/jpeg", width: 0, height: 0 };
  }
  // WebP: RIFF container with one of three chunk kinds.
  if (data.length >= 30 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") {
    const chunk = data.subarray(12, 16).toString("latin1");
    let width = 0;
    let height = 0;
    if (chunk === "VP8 ") {
      width = data.readUInt16LE(26) & 0x3fff;
      height = data.readUInt16LE(28) & 0x3fff;
    } else if (chunk === "VP8L") {
      const bits = data.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    } else if (chunk === "VP8X") {
      width = data.readUIntLE(24, 3) + 1;
      height = data.readUIntLE(27, 3) + 1;
    }
    return { extension: "webp", mediaType: "image/webp", width, height };
  }
  return null;
}

// What kind of sound file this is, read from the first bytes (FRG-84). Returns null if it is not
// a WAV, FLAC or MP3 file, so a renamed file of another kind is refused.
export function audioInfo(data: Buffer): { extension: "wav" | "flac" | "mp3"; mediaType: string } | null {
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WAVE") {
    return { extension: "wav", mediaType: "audio/wav" };
  }
  if (data.length >= 4 && data.subarray(0, 4).toString("latin1") === "fLaC") {
    return { extension: "flac", mediaType: "audio/flac" };
  }
  // MP3: an ID3 tag, or straight away a frame start.
  if (data.length >= 3 && data.subarray(0, 3).toString("latin1") === "ID3") {
    return { extension: "mp3", mediaType: "audio/mpeg" };
  }
  if (data.length >= 2 && data[0] === 0xff && [0xfb, 0xf3, 0xf2].includes(data[1])) {
    return { extension: "mp3", mediaType: "audio/mpeg" };
  }
  return null;
}

// The path of a kept start image or voice file, after checking the name (no folders, no "..").
export function inputFilePath(name: string): string {
  if (!IMAGE_NAME_PATTERN.test(name) && !AUDIO_NAME_PATTERN.test(name)) throw new HttpError(400, "This is not a valid file name.");
  return path.join(INPUTS_DIR, name);
}

// Keep a copy of an uploaded picture in data/inputs.
export async function keepInput(name: string, data: Buffer): Promise<void> {
  await mkdir(INPUTS_DIR, { recursive: true });
  await writeFile(inputFilePath(name), data);
}

// The kept copy, or null if there is none (pictures uploaded before FRG-25).
export async function readKeptInput(name: string): Promise<Buffer | null> {
  try {
    return await readFile(inputFilePath(name));
  } catch {
    return null;
  }
}

// The kept start images and voice files of a job, as paths from the repo root, for example
// "data/inputs/teczoforge-1-a1b2c3.png".
export async function inputFilesFor(preset: Preset, values: Record<string, unknown>): Promise<string[]> {
  const files: string[] = [];
  for (const input of preset.inputs) {
    const value = values[input.key];
    if ((input.kind === "image" || input.kind === "audio") && typeof value === "string" && (await readKeptInput(value))) {
      files.push(`data/inputs/${value}`);
    }
  }
  return files;
}

// Make sure ComfyUI has this file in its input folder. Returns the name to use in the workflow.
// Missing in ComfyUI: upload it again from data/inputs. Missing in data/inputs: keep a copy now.
async function ensureInComfyUI(name: string, label: string): Promise<string> {
  const inComfyUI = await getInputImage(name);
  if (inComfyUI) {
    if (!(await readKeptInput(name))) await keepInput(name, inComfyUI);
    return name;
  }
  const kept = await readKeptInput(name);
  if (!kept) {
    throw new HttpError(400, `The ${label} "${name}" is no longer in ComfyUI and there is no saved copy. Pick the file again.`);
  }
  const mediaType = imageInfo(kept)?.mediaType ?? audioInfo(kept)?.mediaType ?? "application/octet-stream";
  console.log(`The ${label} "${name}" was missing in ComfyUI. Uploading it again from data/inputs.`);
  return uploadImage(kept, name, mediaType);
}

// Before a job is queued: make sure every start image and voice file is in ComfyUI. If ComfyUI gave
// a file a new name, build the workflow again with that name.
export async function ensureStartImages(
  preset: Preset,
  workflow: Workflow,
  built: { workflow: Workflow; usedValues: Record<string, string | number> },
): Promise<{ workflow: Workflow; usedValues: Record<string, string | number> }> {
  const values = { ...built.usedValues };
  let renamed = false;
  for (const input of preset.inputs) {
    const value = values[input.key];
    if ((input.kind !== "image" && input.kind !== "audio") || typeof value !== "string") continue;
    const name = await ensureInComfyUI(value, input.kind === "audio" ? "voice file" : "start image");
    if (name !== value) {
      values[input.key] = name;
      renamed = true;
    }
  }
  return renamed ? buildWorkflow(preset, workflow, values) : built;
}
