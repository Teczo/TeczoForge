import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { findExtensions } from "./db.js";
import type { Job } from "./db.js";
import { findAnyJob, finish, follow, jobProjectId, OUTPUTS_DIR, save, sendError } from "./jobs.js";
import type { LiveJob } from "./jobs.js";
import { findVideoJob, requireFfmpeg, runFfmpeg, videoPathOf } from "./lastFrame.js";

// Chains of clips and "Join all" (FRG-55).
// A chain is a first clip and the clips made from it with "Extend" (FRG-54): each extension has
// parentJobId (the clip before it) and chainRootId (the first clip).
// Joining makes one video from the first clip up to a chosen clip. Each extension starts with
// (almost) the last frame of the clip before it, so that first frame is dropped: no frozen frame
// at the joins. The result is re-encoded like the other videos: MP4, H.264, yuv420p, no sound.
// A join runs in the backend with ffmpeg, not in ComfyUI's queue, but it is a normal job
// (saved first, followed with GET /api/jobs/<id>, a gallery item when done). One join at a time.

const MAX_CLIPS = 10;
const MAX_SECONDS = 60;
// A chain longer than this is broken data (for example a loop), not a real chain.
const MAX_CHAIN_STEPS = 100;
// Re-encoding 60 seconds of 640 x 640 video takes well under a minute; this is a safety limit.
const JOIN_TIMEOUT_MS = 10 * 60_000;

// Frames, frame rate and size of a video, read by ffmpeg without decoding it.
type VideoFacts = { frames: number; fps: number; width: number; height: number };

async function probeVideo(file: string): Promise<VideoFacts> {
  const text = await runFfmpeg(["-hide_banner", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"]);
  const stream = /Stream #.*?Video:.*?(\d{2,5})x(\d{2,5}).*?([\d.]+) fps/.exec(text);
  const frameCounts = [...text.matchAll(/frame=\s*(\d+)/g)];
  if (!stream || frameCounts.length === 0) throw new Error(`Could not read the video ${path.basename(file)}.`);
  return {
    frames: Number(frameCounts.at(-1)![1]),
    fps: Number(stream[3]),
    width: Number(stream[1]),
    height: Number(stream[2]),
  };
}

// Seconds of the joined video: every frame of the first clip, and all but the first frame of the others.
function joinedSeconds(facts: VideoFacts[]): number {
  const frames = facts.reduce((sum, clip, index) => sum + clip.frames - (index > 0 ? 1 : 0), 0);
  return frames / facts[0].fps;
}

// The clips from the first clip of the chain up to this clip, in order. Each must be a finished video.
async function clipsUpTo(jobId: string): Promise<Job[]> {
  const clips = [await findVideoJob(jobId)];
  while (clips[0].parentJobId) {
    if (clips.length > MAX_CHAIN_STEPS) throw new HttpError(500, "This chain of clips is broken. See the backend log.");
    const parent = await findAnyJob(clips[0].parentJobId);
    if (!parent || parent.status !== "done" || parent.outputKind !== "video") {
      throw new HttpError(409, "A clip earlier in this chain is missing, so the chain cannot be shown or joined.");
    }
    clips.unshift(parent);
  }
  return clips;
}

// The whole line of a chain through this clip: the clips before it, and after it the newest
// extension of each clip, to the end.
async function chainLine(jobId: string): Promise<Job[]> {
  const clips = await clipsUpTo(jobId);
  while (clips.length <= MAX_CHAIN_STEPS) {
    const next = (await findExtensions(clips.at(-1)!.id)).find((job) => job.outputKind === "video" && job.imageUrl);
    if (!next) break;
    clips.push(next);
  }
  return clips;
}

// GET /api/jobs/<id>/chain
// Answer: { clips: [{ id, presetId, imageUrl, prompt, seconds }], totalSeconds }: the chain through
// this clip, in order. totalSeconds is the length after joining. A clip with no chain gives one clip.
export async function chainHandler(req: Request, res: Response) {
  try {
    const clips = await chainLine(String(req.params.id));
    // Lengths need ffmpeg. Without it the chain still shows, with no lengths.
    let facts: VideoFacts[] | null = null;
    try {
      requireFfmpeg("Reading video lengths");
      facts = await Promise.all(clips.map((clip) => probeVideo(videoPathOf(clip.imageUrl))));
    } catch (error) {
      console.warn(`Warning: could not read the clip lengths. ${(error as Error).message}`);
    }
    res.json({
      clips: clips.map((clip, index) => ({
        id: clip.id,
        presetId: clip.presetId,
        imageUrl: clip.imageUrl,
        prompt: String((clip.inputs as Record<string, unknown>)?.prompt ?? ""),
        seconds: facts ? facts[index].frames / facts[index].fps : null,
      })),
      totalSeconds: facts ? joinedSeconds(facts) : null,
    });
  } catch (error) {
    sendError(res, error);
  }
}

// Only one join runs at a time. Take the slot before a join; joinInto gives it back.
let joining = false;
export function takeJoinSlot(): boolean {
  if (joining) return false;
  joining = true;
  return true;
}

// The checks before a join: 2 to 10 clips, ffmpeg set up, the same size and frame rate, at most
// 60 seconds together. Returns the video files and the frame count of the joined video.
// "Make a longer video" (FRG-56) uses it too.
export async function prepareJoin(clips: Job[]): Promise<{ files: string[]; totalFrames: number }> {
  if (clips.length < 2) throw new HttpError(400, "This clip is not part of a chain. Extend it first, then join.");
  if (clips.length > MAX_CLIPS) {
    throw new HttpError(400, `This chain has ${clips.length} clips. Join works for at most ${MAX_CLIPS} clips.`);
  }
  requireFfmpeg("Joining clips");

  const files = clips.map((clip) => videoPathOf(clip.imageUrl));
  const facts = await Promise.all(files.map(probeVideo));
  const first = facts[0];
  if (facts.some((clip) => clip.fps !== first.fps || clip.width !== first.width || clip.height !== first.height)) {
    throw new HttpError(400, "These clips have different sizes or frame rates, so they cannot be joined.");
  }
  const seconds = joinedSeconds(facts);
  if (seconds > MAX_SECONDS) {
    throw new HttpError(400, `Together these clips are ${Math.round(seconds)} seconds long. Join works for at most ${MAX_SECONDS} seconds.`);
  }
  return { files, totalFrames: Math.round(seconds * first.fps) };
}

// Join the clips into this running job, then mark it done (with sourceJobIds) or failed.
// The caller has taken the join slot (takeJoinSlot); it is given back here.
export async function joinInto(live: LiveJob, clips: Job[], prepared: { files: string[]; totalFrames: number }): Promise<void> {
  const { files, totalFrames } = prepared;
  live.joinProgress = { state: "joining", frame: 0, frames: totalFrames, percent: 0 };
  try {
    const fileName = await runJoin(files, (frame) => {
      const done = Math.min(frame, totalFrames);
      live.joinProgress = { state: "joining", frame: done, frames: totalFrames, percent: Math.round((done / totalFrames) * 100) };
    });
    live.joinProgress = undefined;
    await finish(live, "done", {
      outputFile: `data/outputs/${fileName}`,
      imageUrl: `/api/outputs/${fileName}`,
      outputKind: "video",
      sourceJobIds: clips.map((clip) => clip.id),
    });
  } catch (error) {
    console.error(`Join ${live.job.id} failed:`, (error as Error).message);
    live.joinProgress = undefined;
    await finish(live, "failed", { error: "Could not join the clips. See the backend log." });
  } finally {
    joining = false;
  }
}

// POST /api/jobs/<id>/join
// Join the chain from its first clip up to this clip into one video.
// Answer at once: { jobId }. Follow the job with GET /api/jobs/<id> (progress state "joining").
export async function joinHandler(req: Request, res: Response) {
  try {
    const clips = await clipsUpTo(String(req.params.id));
    const prepared = await prepareJoin(clips);
    // The joined video goes into the project of the clips (see projectForNewItem).
    const project = await jobProjectId(undefined, clips.at(-1)!.id);
    if (!takeJoinSlot()) throw new HttpError(409, "Another join is running. Wait until it is done, then try again.");

    const live = follow({
      id: crypto.randomUUID(),
      presetId: null,
      inputs: { prompt: (clips[0].inputs as Record<string, unknown>)?.prompt ?? "" },
      status: "running",
      promptId: null,
      outputFile: null,
      imageUrl: null,
      error: null,
      durationMs: 0,
      createdAt: new Date(),
      createdBy: res.locals.username ?? null, // Set by requireLogin in auth.ts.
      projectId: project,
      sourceJobIds: clips.map((clip) => clip.id),
    });
    live.joinProgress = { state: "joining", frame: 0, frames: prepared.totalFrames, percent: 0 };
    await save(live);
    res.json({ jobId: live.job.id, warning: live.warning });
    joinInto(live, clips, prepared).catch((error) => console.error("Join failed:", error));
  } catch (error) {
    sendError(res, error);
  }
}

// Run ffmpeg: drop the first frame of every clip after the first, join them, and re-encode.
// Returns the new file name in data/outputs. onFrame gets the number of frames written so far.
async function runJoin(files: string[], onFrame: (frame: number) => void): Promise<string> {
  const fileName = `join-${Date.now()}-${randomBytes(3).toString("hex")}.mp4`;
  const outPath = path.join(OUTPUTS_DIR, fileName);
  await mkdir(OUTPUTS_DIR, { recursive: true });

  // For example with 3 clips:
  // [0:v]setpts=PTS-STARTPTS[v0];[1:v]trim=start_frame=1,setpts=PTS-STARTPTS[v1];...;[v0][v1][v2]concat=n=3:v=1:a=0[out]
  const parts = files.map((_, i) => `[${i}:v]${i > 0 ? "trim=start_frame=1," : ""}setpts=PTS-STARTPTS[v${i}]`);
  const filter = `${parts.join(";")};${files.map((_, i) => `[v${i}]`).join("")}concat=n=${files.length}:v=1:a=0[out]`;
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
    ...files.flatMap((file) => ["-i", file]),
    "-filter_complex", filter, "-map", "[out]", "-an",
    // The same format as the clips from ComfyUI: H.264, yuv420p, BT.709 colour tags.
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-color_range", "tv",
    "-movflags", "+faststart", "-y", outPath,
  ];
  try {
    await runFfmpeg(args, {
      timeoutMs: JOIN_TIMEOUT_MS,
      onOutput: (text) => {
        const frames = [...text.matchAll(/frame=(\d+)/g)];
        if (frames.length > 0) onFrame(Number(frames.at(-1)![1]));
      },
    });
  } catch (error) {
    await rm(outPath, { force: true });
    throw error;
  }
  return fileName;
}
