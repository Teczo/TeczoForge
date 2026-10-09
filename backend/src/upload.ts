import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { uploadImage } from "./comfyui.js";
import { imageInfo, keepInput } from "./inputs.js";
import { OUTPUTS_DIR } from "./jobs.js";

// Biggest picture we accept.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

// POST /api/upload
// Body: the picture itself, with Content-Type image/png, image/jpeg or image/webp.
// Answer: { "name": "<file name in ComfyUI>", "width", "height" }. Send that name as the value of an
// "image" input. A copy is kept in data/inputs under the same name (FRG-25).
export async function uploadHandler(req: Request, res: Response) {
  try {
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new HttpError(400, "Pick a PNG, JPEG or WebP image.");
    }
    // The first bytes tell the image type, so a renamed non-image is refused.
    const info = imageInfo(data);
    if (!info) {
      throw new HttpError(400, "This file is not a PNG, JPEG or WebP image.");
    }

    // Our own file name, so the user's file name never reaches ComfyUI.
    const fileName = `teczoforge-${Date.now()}-${randomBytes(3).toString("hex")}.${info.extension}`;
    const name = await uploadImage(data, fileName, info.mediaType);
    // Keep a copy under the name ComfyUI uses, in case ComfyUI's input folder is cleaned.
    await keepInput(name, data);
    res.json({ name, width: info.width, height: info.height });
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
    } else {
      console.error("Upload failed:", error);
      res.status(500).json({ error: "Something went wrong on the server. See the backend log." });
    }
  }
}

// Copy a finished picture from data/outputs into data/inputs as a new start image, with our own
// name. With toComfyUI it also goes into ComfyUI's input folder at once (FRG-26 "Send to");
// otherwise it goes there only when a job needs it (see ensureStartImages in inputs.ts).
// Videos are refused.
export async function copyOutputToInputs(
  imageUrl: unknown,
  toComfyUI: boolean,
): Promise<{ name: string; width: number; height: number }> {
  const fileName = typeof imageUrl === "string" ? imageUrl.replace(/^\/api\/outputs\//, "") : "";
  // Only a plain file name from data/outputs (no folders, no "..").
  if (!/^[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/i.test(fileName)) {
    throw new HttpError(400, "Only a finished picture (PNG, JPEG or WebP) can be used here.");
  }
  let data: Buffer;
  try {
    data = await readFile(path.join(OUTPUTS_DIR, fileName));
  } catch {
    throw new HttpError(404, "This picture is not in data/outputs any more.");
  }
  const info = imageInfo(data);
  if (!info) throw new HttpError(400, "This file is not a PNG, JPEG or WebP image.");
  let name = `teczoforge-${Date.now()}-${randomBytes(3).toString("hex")}.${info.extension}`;
  if (toComfyUI) name = await uploadImage(data, name, info.mediaType);
  await keepInput(name, data);
  return { name, width: info.width, height: info.height };
}

// POST /api/inputs/from-output  Body: { "imageUrl": "/api/outputs/<file name>" }
// "Use in chat" in the gallery (FRG-25): copy a finished picture into data/inputs as a new start
// image. Answer: { "name", "width", "height" }, like POST /api/upload. Videos are refused.
export async function useOutputHandler(req: Request, res: Response) {
  try {
    res.json(await copyOutputToInputs(req.body?.imageUrl, false));
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
    } else {
      console.error("Use in chat failed:", error);
      res.status(500).json({ error: "Something went wrong on the server. See the backend log." });
    }
  }
}
