import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./httpError.js";
import { getInputImage, uploadImage } from "./comfyui.js";
import { buildWorkflow, IMAGE_NAME_PATTERN } from "./presets.js";
import type { Preset, Workflow } from "./presets.js";

// Start images (FRG-25, audit R4).
// Every uploaded picture is also kept in data/inputs, with the same name it has in ComfyUI.
// ComfyUI's input folder may be cleaned, so before a job is queued the backend checks that the
// picture is still there, and uploads it again from data/inputs if it is not.

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

// The path of a kept start image, after checking the name (no folders, no "..").
export function inputFilePath(name: string): string {
  if (!IMAGE_NAME_PATTERN.test(name)) throw new HttpError(400, "This is not a valid image name.");
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

// The kept start images of a job, as paths from the repo root, for example "data/inputs/teczoforge-1-a1b2c3.png".
export async function inputFilesFor(preset: Preset, values: Record<string, unknown>): Promise<string[]> {
  const files: string[] = [];
  for (const input of preset.inputs) {
    const value = values[input.key];
    if (input.kind === "image" && typeof value === "string" && (await readKeptInput(value))) {
      files.push(`data/inputs/${value}`);
    }
  }
  return files;
}

// Make sure ComfyUI has this picture in its input folder. Returns the name to use in the workflow.
// Missing in ComfyUI: upload it again from data/inputs. Missing in data/inputs: keep a copy now.
async function ensureInComfyUI(name: string): Promise<string> {
  const inComfyUI = await getInputImage(name);
  if (inComfyUI) {
    if (!(await readKeptInput(name))) await keepInput(name, inComfyUI);
    return name;
  }
  const kept = await readKeptInput(name);
  if (!kept) {
    throw new HttpError(400, `The start image "${name}" is no longer in ComfyUI and there is no saved copy. Pick the image again.`);
  }
  const info = imageInfo(kept);
  console.log(`Start image "${name}" was missing in ComfyUI. Uploading it again from data/inputs.`);
  return uploadImage(kept, name, info?.mediaType ?? "application/octet-stream");
}

// Before a job is queued: make sure every start image is in ComfyUI. If ComfyUI gave a picture
// a new name, build the workflow again with that name.
export async function ensureStartImages(
  preset: Preset,
  workflow: Workflow,
  built: { workflow: Workflow; usedValues: Record<string, string | number> },
): Promise<{ workflow: Workflow; usedValues: Record<string, string | number> }> {
  const values = { ...built.usedValues };
  let renamed = false;
  for (const input of preset.inputs) {
    const value = values[input.key];
    if (input.kind !== "image" || typeof value !== "string") continue;
    const name = await ensureInComfyUI(value);
    if (name !== value) {
      values[input.key] = name;
      renamed = true;
    }
  }
  return renamed ? buildWorkflow(preset, workflow, values) : built;
}
