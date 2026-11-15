import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { imageInfo } from "./inputs.js";
import { OUTPUTS_DIR, sendError } from "./jobs.js";

// Pictures of 3D models, for the grids (gallery, board, packs, games).
// The backend cannot draw a .glb file, so the browser draws the picture once and sends it here.
// The picture of "data/outputs/<name>.glb" is "data/thumbnails/<name>.glb.png". The address comes
// from the model's file name, so nothing is saved in MongoDB and old jobs work too.

export const THUMBNAILS_DIR = path.join(import.meta.dirname, "..", "..", "data", "thumbnails");
// A 512 x 512 PNG of one model is far below this.
export const MAX_THUMBNAIL_BYTES = 1024 * 1024;
const MAX_THUMBNAIL_SIDE = 1024;

// POST /api/thumbnails/<model file name>   Body: the PNG picture itself (Content-Type image/png).
// Answer: { "url": "/api/thumbnails/<model file name>.png" }. 409 if the model already has a picture:
// a picture is never replaced.
export async function saveThumbnailHandler(req: Request, res: Response) {
  try {
    const modelName = String(req.params.name ?? "");
    // Only a plain .glb file name from data/outputs (no folders, no "..").
    if (!/^[A-Za-z0-9_-]+\.glb$/i.test(modelName)) {
      throw new HttpError(400, "Only a 3D model (.glb) from data/outputs can get a picture.");
    }
    try {
      await access(path.join(OUTPUTS_DIR, modelName));
    } catch {
      throw new HttpError(404, "This 3D model is not in data/outputs any more.");
    }

    const data = req.body;
    // The first bytes tell the image type, so a renamed non-image is refused.
    const info = Buffer.isBuffer(data) ? imageInfo(data) : null;
    if (!info || info.extension !== "png") {
      throw new HttpError(400, "The picture of a 3D model must be a PNG image.");
    }
    if (info.width > MAX_THUMBNAIL_SIDE || info.height > MAX_THUMBNAIL_SIDE) {
      throw new HttpError(400, `The picture of a 3D model can be at most ${MAX_THUMBNAIL_SIDE} pixels wide and high.`);
    }

    await mkdir(THUMBNAILS_DIR, { recursive: true });
    try {
      // "wx": fail if the file is already there, so the first picture stays.
      await writeFile(path.join(THUMBNAILS_DIR, `${modelName}.png`), data, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new HttpError(409, "This 3D model already has a picture.");
      }
      throw error;
    }
    res.json({ url: `/api/thumbnails/${modelName}.png` });
  } catch (error) {
    sendError(res, error);
  }
}
