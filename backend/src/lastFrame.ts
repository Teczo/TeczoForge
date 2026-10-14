import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { imageInfo, INPUTS_DIR, inputFilePath } from "./inputs.js";
import { findAnyJob, JOB_ID_PATTERN, OUTPUTS_DIR, sendError } from "./jobs.js";
import type { Job } from "./db.js";

// Last frame of a video job (FRG-53). The base for "Extend video" (FRG-54).
// ffmpeg takes the last frame of the finished video in data/outputs and saves it as a PNG in
// data/inputs, with a start image name like an upload ("teczoforge-<time>-<random>.png").
// It goes into ComfyUI's input folder only when a job needs it (see ensureStartImages in inputs.ts).

// The full path to ffmpeg.exe, from backend/.env. Empty: this feature is off.
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? "";
// ffmpeg gets this long. Taking one frame from a short video takes well under a second.
const FFMPEG_TIMEOUT_MS = 60_000;

// Run ffmpeg with a list of arguments. No shell, so a file name can never become a command.
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, args, { shell: false, windowsHide: true });
    let errorText = "";
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      errorText = (errorText + chunk.toString()).slice(-2000); // Keep only the end.
    });
    const timer = setTimeout(() => ffmpeg.kill(), FFMPEG_TIMEOUT_MS);
    ffmpeg.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg could not start (${error.message}). Check FFMPEG_PATH in backend/.env.`));
    });
    ffmpeg.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg stopped with code ${code}: ${errorText.trim()}`));
    });
  });
}

// The video file of a finished job, after checking that it is a plain file name in data/outputs.
function videoPathOf(imageUrl: string | null): string {
  const fileName = (imageUrl ?? "").replace(/^\/api\/outputs\//, "");
  // Only a plain file name (no folders, no "..").
  if (!/^[A-Za-z0-9_-]+\.(mp4|webm|mov|mkv)$/i.test(fileName)) {
    throw new HttpError(400, "This job has no video file.");
  }
  return path.join(OUTPUTS_DIR, fileName);
}

// A finished video job, or a plain-English error: bad id, no such job, not finished, not a video.
// "Extend video" (FRG-54) uses it too.
export async function findVideoJob(jobId: string): Promise<Job> {
  if (!JOB_ID_PATTERN.test(jobId)) throw new HttpError(400, "This is not a job id.");

  const job = await findAnyJob(jobId);
  if (!job) throw new HttpError(404, "There is no job with this id.");
  if (job.status === "failed" || job.status === "cancelled") {
    throw new HttpError(400, `This job ${job.status === "failed" ? "failed" : "was cancelled"}, so it has no video.`);
  }
  if (job.status !== "done") throw new HttpError(400, "This job is not finished yet. Wait until the video is done.");
  if (job.outputKind !== "video") {
    throw new HttpError(400, `Only a video has a last frame. This job made ${job.outputKind === "image" ? "an image" : `a ${job.outputKind ?? "file of an unknown kind"}`}.`);
  }
  return job;
}

// Save the last frame of a finished video job as a new start image.
// Returns { name, width, height }, like POST /api/upload. Use the name as an "image" input.
export async function extractLastFrame(jobId: string): Promise<{ name: string; width: number; height: number }> {
  const job = await findVideoJob(jobId);
  const videoPath = videoPathOf(job.imageUrl);
  try {
    await access(videoPath);
  } catch {
    throw new HttpError(404, "This video is not in data/outputs any more.");
  }

  if (FFMPEG_PATH === "") {
    throw new HttpError(503, "Taking the last frame is not set up. Put the path to ffmpeg.exe in FFMPEG_PATH in backend/.env.");
  }
  const name = `teczoforge-${Date.now()}-${randomBytes(3).toString("hex")}.png`;
  const framePath = inputFilePath(name);
  await mkdir(INPUTS_DIR, { recursive: true });
  try {
    // -sseof -1: start 1 second before the end. -update 1: write every frame to the same file,
    // so the file ends up holding the very last frame.
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-sseof", "-1", "-i", videoPath, "-an", "-update", "1", "-y", framePath]);
    const info = imageInfo(await readFile(framePath));
    if (!info) throw new Error("ffmpeg did not write a PNG.");
    return { name, width: info.width, height: info.height };
  } catch (error) {
    await rm(framePath, { force: true });
    console.error(`Last frame of job ${jobId} failed:`, (error as Error).message);
    throw new HttpError(500, "Could not take the last frame of this video. See the backend log.");
  }
}

// POST /api/jobs/<id>/last-frame
// Answer: { "name", "width", "height" }, like POST /api/upload. The name works as a start image.
export async function lastFrameHandler(req: Request, res: Response) {
  try {
    res.json(await extractLastFrame(String(req.params.id)));
  } catch (error) {
    sendError(res, error);
  }
}
