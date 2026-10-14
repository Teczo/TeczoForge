import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { buildWorkflow, loadPreset } from "./presets.js";
import type { Preset } from "./presets.js";
import type { Job } from "./db.js";
import { findAnyJob, finish, follow, isActive, jobProjectId, newJob, onResumeChain, queueJob, save, sendError, withLock } from "./jobs.js";
import type { LiveJob } from "./jobs.js";
import { extractLastFrame, requireFfmpeg } from "./lastFrame.js";
import { joinInto, prepareJoin, takeJoinSlot } from "./join.js";

// "Make a longer video" (FRG-56). The user picks a total length once (preset.json "totalLengths").
// One chain job is saved first, with its state in MongoDB (job.chain). Then the backend:
// 1. makes clip 1 from the start image, as a normal job;
// 2. takes the last frame of each finished clip and makes the next clip from it (like "Extend",
//    FRG-54: parentJobId and chainRootId), until there are enough clips for the total length;
// 3. joins all clips into the chain job itself (FRG-55), which then is the joined video.
// Every clip gets a new random seed. Cancel on the chain job stops the clip being made and the
// chain; clips already made stay in the gallery. After a backend restart the chain carries on
// from its saved state (recoverJobs in jobs.ts).

const CHECK_INTERVAL_MS = 1000;
// Same limit as joining (join.ts).
const MAX_CLIPS = 10;
// Same limit as other text inputs (presets.ts).
const MAX_TEXT_LENGTH = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The inputs a chain needs: the start image, the clip length in seconds, and (if there is one) the prompt.
function chainInputs(preset: Preset) {
  return {
    image: preset.inputs.find((input) => input.kind === "image"),
    duration: preset.inputs.find((input) => input.unit === "seconds"),
    prompt: preset.inputs.find((input) => input.kind === "text" && !input.options),
  };
}

// "1, 2 or 3": a list of numbers in plain English.
function orList(values: number[]): string {
  return values.length === 1 ? String(values[0]) : `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

// POST /api/chains
// Body: { "presetId", "inputs" (like POST /api/jobs), "totalSeconds": 15, "prompts": ["...", ""] (optional,
//         one per clip; an empty one uses the main prompt), "projectId" (optional) }
// Answer at once: { jobId }. Follow it with GET /api/jobs/<id>: progress state "chain" says
// which clip is being made. When it is done, the job is the joined video.
export async function createChainHandler(req: Request, res: Response) {
  try {
    const { presetId, inputs, totalSeconds, prompts, projectId } = req.body ?? {};
    const { preset, workflow } = await loadPreset(presetId);
    const lengths = preset.totalLengths ?? [];
    if (lengths.length === 0) throw new HttpError(400, `The preset "${preset.name}" cannot make a longer video.`);
    if (!lengths.includes(totalSeconds)) throw new HttpError(400, `Total length must be ${orList(lengths)} seconds.`);

    // Check the values like a normal job. The seed is left out, so every clip gets its own.
    const { usedValues } = buildWorkflow(preset, workflow, inputs ?? {});
    const values: Record<string, string | number> = {};
    for (const input of preset.inputs) if (input.kind !== "seed") values[input.key] = usedValues[input.key];

    const keys = chainInputs(preset);
    const clipSeconds = Number(values[keys.duration!.key]);
    const clips = Math.ceil(totalSeconds / clipSeconds);
    if (clips < 2) throw new HttpError(400, "Choose a total length that is longer than one clip.");
    if (clips > MAX_CLIPS) throw new HttpError(400, `That needs ${clips} clips. A longer video can have at most ${MAX_CLIPS} clips.`);

    // One prompt per clip (optional). An empty line uses the main prompt.
    if (prompts !== undefined && (!Array.isArray(prompts) || !prompts.every((line) => typeof line === "string"))) {
      throw new HttpError(400, "prompts must be a list of texts, one per clip.");
    }
    const lines: string[] = prompts ?? [];
    if (lines.length > clips) {
      throw new HttpError(400, `You wrote ${lines.length} prompt lines, but this video has ${clips} clips. Write at most one line per clip.`);
    }
    if (lines.some((line) => line.length > MAX_TEXT_LENGTH)) {
      throw new HttpError(400, `A prompt line is too long. Maximum is ${MAX_TEXT_LENGTH} characters.`);
    }
    const mainPrompt = keys.prompt ? String(values[keys.prompt.key]) : "";
    const clipPrompts = Array.from({ length: clips }, (_, i) => lines[i]?.trim() || mainPrompt);

    requireFfmpeg("Making a longer video");
    const project = await jobProjectId(projectId, undefined);

    // Save the chain job first, so it is not lost if the backend stops.
    const live = follow({
      id: crypto.randomUUID(),
      presetId: preset.id,
      inputs: values,
      status: "running",
      promptId: null,
      outputFile: null,
      imageUrl: null,
      error: null,
      durationMs: 0,
      createdAt: new Date(),
      createdBy: res.locals.username ?? null, // Set by requireLogin in auth.ts.
      projectId: project,
      chain: { totalSeconds, clips, prompts: clipPrompts, clipJobIds: [] },
    });
    await save(live);
    res.json({ jobId: live.job.id, warning: live.warning });
    runChain(live);
  } catch (error) {
    sendError(res, error);
  }
}

// Start clip number i (0 is the first) as a normal job, inside the lock, so Cancel cannot run in
// between. Returns null if the chain was cancelled: then no new clip starts.
function startClip(live: LiveJob, preset: Preset, i: number, previous: Job | undefined): Promise<Job | null> {
  return withLock(async () => {
    const chain = live.job.chain!;
    if (live.job.status !== "running") return null;
    const keys = chainInputs(preset);
    const values = { ...(live.job.inputs as Record<string, unknown>) };
    if (keys.prompt) values[keys.prompt.key] = chain.prompts[i];
    // From clip 2 on, the start image is the last frame of the clip before (FRG-53).
    if (previous) values[keys.image!.key] = (await extractLastFrame(previous.id)).name;

    const { live: clip, workflow } = await newJob({
      presetId: preset.id,
      inputs: values,
      parentJobId: previous?.id,
      projectId: live.job.projectId,
      createdBy: live.job.createdBy,
    });
    chain.clipJobIds.push(clip.job.id);
    await save(live);
    await queueJob(clip, workflow);
    return clip.job;
  });
}

// Wait until the clip is finished. Returns null if the chain stopped meanwhile (Cancel).
async function waitForClip(live: LiveJob, clipId: string): Promise<Job | null> {
  for (;;) {
    if (!isActive(live.job.status)) return null;
    const clip = await findAnyJob(clipId);
    if (!clip) throw new HttpError(500, "A clip of this video is missing. See the backend log.");
    if (!isActive(clip.status)) return clip;
    await sleep(CHECK_INTERVAL_MS);
  }
}

// Make the missing clips one after the other, then join them. Also carries on after a restart:
// clips that are already in job.chain.clipJobIds are not made again.
async function runChain(live: LiveJob): Promise<void> {
  const chain = live.job.chain!;
  try {
    const { preset } = await loadPreset(live.job.presetId);
    const clips: Job[] = [];
    for (let i = 0; i < chain.clips; i++) {
      const savedId = chain.clipJobIds[i];
      let clip = savedId ? await findAnyJob(savedId) : await startClip(live, preset, i, clips[i - 1]);
      if (!clip) {
        if (!savedId) return; // Cancelled: no new clip was started.
        throw new HttpError(500, `Clip ${i + 1} of this video is missing. See the backend log.`);
      }
      clip = await waitForClip(live, clip.id);
      // Cancelled while the clip was being made.
      if (!clip || !isActive(live.job.status)) return;
      if (clip.status !== "done") {
        const what = clip.status === "cancelled" ? "was cancelled" : `failed: ${clip.error ?? "no reason given"}`;
        await finish(live, "failed", { error: `Clip ${i + 1} of ${chain.clips} ${what}. The clips made so far are in the gallery.` });
        return;
      }
      clips.push(clip);
    }

    // All clips are made: join them into this job. Only one join runs at a time, so wait for a turn.
    const prepared = await prepareJoin(clips);
    for (;;) {
      if (!isActive(live.job.status)) return;
      if (takeJoinSlot()) break;
      await sleep(CHECK_INTERVAL_MS);
    }
    // No await between taking the slot and joinInto, so Cancel cannot come in between.
    await joinInto(live, clips, prepared);
  } catch (error) {
    if (!isActive(live.job.status)) return;
    const message = error instanceof HttpError ? error.message : "Something went wrong on the server. See the backend log.";
    if (!(error instanceof HttpError)) console.error(`Chain ${live.job.id} failed:`, error);
    await finish(live, "failed", { error: `${message} The clips made so far are in the gallery.` });
  }
}

// After a backend restart, recoverJobs (jobs.ts) hands each unfinished chain back to here.
onResumeChain((live) => {
  console.log(`Recovery: carrying on with the longer video ${live.job.id} (${live.job.chain!.clipJobIds.length} clip(s) started).`);
  runChain(live);
});
