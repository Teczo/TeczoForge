import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { uploadImage } from "./comfyui.js";
import { imageInfo, keepInput } from "./inputs.js";

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
