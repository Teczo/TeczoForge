import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { uploadImage } from "./comfyui.js";

// Biggest picture we accept.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

// The first bytes of each image type. We check these, so a renamed non-image is refused.
function imageExtension(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") {
    return "webp";
  }
  return null;
}

// POST /api/upload
// Body: the picture itself, with Content-Type image/png, image/jpeg or image/webp.
// Answer: { "name": "<file name in ComfyUI>" }. Send that name as the value of an "image" input.
export async function uploadHandler(req: Request, res: Response) {
  try {
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new HttpError(400, "Pick a PNG, JPEG or WebP image.");
    }
    const extension = imageExtension(data);
    if (!extension) {
      throw new HttpError(400, "This file is not a PNG, JPEG or WebP image.");
    }

    // Our own file name, so the user's file name never reaches ComfyUI.
    const fileName = `teczoforge-${Date.now()}-${randomBytes(3).toString("hex")}.${extension}`;
    const name = await uploadImage(data, fileName, req.headers["content-type"] ?? "application/octet-stream");
    res.json({ name });
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
    } else {
      console.error("Upload failed:", error);
      res.status(500).json({ error: "Something went wrong on the server. See the backend log." });
    }
  }
}
