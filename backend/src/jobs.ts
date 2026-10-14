import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { buildWorkflow, loadPreset } from "./presets.js";
import { ensureStartImages, inputFilesFor } from "./inputs.js";
import type { Workflow } from "./presets.js";
import { downloadOutput, getFinishedOutput, getQueue, interruptJob, queueWorkflow, removeFromQueue } from "./comfyui.js";
import { findActiveJobs, findJob, knownUnsortedProjectId, listJobs, markChainRoot, moveJobToProject, safeMessage, saveJob } from "./db.js";
import type { Job, JobStatus } from "./db.js";
import { forgetSteps, getSteps } from "./progress.js";
import { pickOutputFile } from "./outputKinds.js";
import { checkTargetProjectId, projectForNewItem } from "./projects.js";

// Jobs (FRG-20).
// 1. POST /api/jobs checks the inputs, saves the job as "queued", sends it to ComfyUI,
//    and answers at once with the job id. It does not wait for the result.
// 2. Every second the backend asks ComfyUI about all unfinished jobs. Each status change
//    (queued -> running -> done or failed) is saved in MongoDB.
// 3. The page asks GET /api/jobs/<id> every 1 to 2 seconds until the job is done.
// 4. When the backend starts, it picks up the jobs that were not finished (recoverJobs).
// 5. POST /api/jobs/<id>/cancel stops a waiting or running job (FRG-21).
// 6. Board cards (drafts.ts) are jobs too. A card's job that fails or is cancelled goes back
//    to the Ready column as a draft, with the reason on the card (FRG-22).
// Unfinished jobs are also kept in memory, so jobs still work when MongoDB is offline.
// ComfyUI's queue is the only queue. The backend only follows it.

// Finished images and videos are saved here: data/outputs at the root of the repo.
export const OUTPUTS_DIR = path.join(import.meta.dirname, "..", "..", "data", "outputs");

export const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// How often to ask ComfyUI about unfinished jobs.
const CHECK_INTERVAL_MS = 1000;
// A job that runs longer than this fails. A video (image-to-video preset) takes about 4.5 minutes,
// longer right after ComfyUI starts. Waiting in the queue does not count.
const RUNNING_TIMEOUT_MS = 20 * 60_000;
// If ComfyUI does not answer for this long, the job fails.
const UNREACHABLE_TIMEOUT_MS = 5 * 60_000;
// A finished job stays in memory this long, so the page gets the result also when MongoDB is offline.
const KEEP_FINISHED_MS = 60 * 60_000;

// GET /api/jobs?limit=
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Where a job is now. The page shows it as text and a progress bar.
export type Progress =
  | { state: "waiting"; jobsAhead: number } // In ComfyUI's queue behind other jobs.
  // steps is 0 until sampling starts. stage of stages: the sampler pass (FRG-32, "stages" in
  // preset.json). percent: the whole job from 0 to 100, over all passes. It never goes down.
  | { state: "running"; step: number; steps: number; stage: number; stages: number; percent: number }
  | { state: "finishing" } // ComfyUI is done; the backend is saving the file.
  | { state: "joining"; frame: number; frames: number; percent: number } // ffmpeg joins clips (FRG-55).
  // "Make a longer video" (FRG-56): clip "clip" of "clips", with that clip's own progress (or the join).
  | { state: "chain"; clip: number; clips: number; inner: Progress | null };

// A job the backend is following, with what it knows besides the saved record.
export type LiveJob = {
  job: Job;
  jobsAhead: number; // Jobs before this one in ComfyUI's queue.
  runningSince: number | null; // When we first saw ComfyUI working on it.
  lastAnswerAt: number; // When ComfyUI last answered about it.
  finishing: boolean; // Copying the result into data/outputs.
  warning: string | undefined; // Set when the last save to MongoDB did not work.
  saving: Promise<void>; // Saves run one after the other, so the last save has the newest status.
  stages: number; // Sampler passes, from preset.json (FRG-32). 1 until the preset is read.
  percent: number; // The highest percent shown so far, so the bar never goes back.
  joinProgress?: Progress; // A join (FRG-55) runs in the backend, not in ComfyUI: its own progress.
};

// Unfinished jobs, and jobs that finished in the last hour. Key: job id.
const liveJobs = new Map<string, LiveJob>();

export function isActive(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

export function follow(job: Job): LiveJob {
  const live: LiveJob = {
    job,
    jobsAhead: 0,
    runningSince: null,
    lastAnswerAt: Date.now(),
    finishing: false,
    warning: undefined,
    saving: Promise.resolve(),
    stages: 1,
    percent: 0,
  };
  liveJobs.set(job.id, live);
  // How many sampler passes this preset makes. Not waited for: progress only needs it later.
  loadPreset(job.presetId)
    .then(({ preset }) => (live.stages = preset.stages ?? 1))
    .catch(() => {});
  return live;
}

// Save the job as it is when the save runs. Never throws (see saveJob in db.ts).
export function save(live: LiveJob): Promise<void> {
  live.saving = live.saving.then(async () => {
    live.warning = await saveJob(live.job);
  });
  return live.saving;
}

// The job is done, failed or cancelled: save it, and forget it after a while.
export async function finish(live: LiveJob, status: "done" | "failed" | "cancelled", fields: Partial<Job>) {
  const { job } = live;
  Object.assign(job, fields, { status, durationMs: Date.now() - job.createdAt.getTime() });
  live.finishing = false;
  if (job.promptId) forgetSteps(job.promptId);

  // A board card (it has a title) that did not finish goes back to Ready as a draft,
  // with the reason on the card. It is not followed any more: drafts live in MongoDB.
  if (job.title !== undefined && status !== "done") {
    const reason = status === "cancelled" ? "The job was cancelled. Press Generate to run it again." : job.error;
    Object.assign(job, { status: "draft", column: "ready", promptId: null, durationMs: 0, error: reason });
    await save(live);
    if (liveJobs.get(job.id) === live) liveJobs.delete(job.id);
    return;
  }

  await save(live);
  // Only forget this run: the same card may have been run again since.
  setTimeout(() => {
    if (liveJobs.get(job.id) === live) liveJobs.delete(job.id);
  }, KEEP_FINISHED_MS).unref();
}

// A message that is safe to show the user. Unexpected errors go to the backend log.
function errorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  console.error("Job failed:", error);
  return "Something went wrong on the server. See the backend log.";
}

export function sendError(res: Response, error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  res.status(status).json({ error: errorMessage(error) });
}

function progressOf(live: LiveJob): Progress | null {
  const { status, promptId } = live.job;
  if (!isActive(status)) return null;
  const chain = live.job.chain;
  if (chain) {
    // Joining after the last clip, or the progress of the clip being made now.
    if (live.joinProgress) return { state: "chain", clip: chain.clips, clips: chain.clips, inner: live.joinProgress };
    const current = liveJobs.get(chain.clipJobIds.at(-1) ?? "");
    const inner = current && isActive(current.job.status) ? progressOf(current) : null;
    return { state: "chain", clip: Math.max(chain.clipJobIds.length, 1), clips: chain.clips, inner };
  }
  if (live.joinProgress) return live.joinProgress;
  if (live.finishing) return { state: "finishing" };
  if (status === "running" && promptId) {
    const { step, steps, pass } = getSteps(promptId);
    const stage = Math.min(pass, live.stages);
    // Each pass is an equal part of the bar: pass 1 of 2 is 0 to 50, pass 2 of 2 is 50 to 100.
    const done = steps > 0 ? (stage - 1 + step / steps) / live.stages : 0;
    live.percent = Math.max(live.percent, Math.min(100, Math.round(done * 100)));
    return { state: "running", step, steps, stage, stages: live.stages, percent: live.percent };
  }
  return { state: "waiting", jobsAhead: live.jobsAhead };
}

// Every waiting or running job, newest first, with its progress. Used by the board.
export function activeJobs(): (Job & { progress: Progress | null })[] {
  return [...liveJobs.values()]
    .filter((live) => isActive(live.job.status))
    .sort((a, b) => b.job.createdAt.getTime() - a.job.createdAt.getTime())
    .map((live) => ({ ...live.job, progress: progressOf(live) }));
}

// ---- Following jobs in ComfyUI ----

// ComfyUI has finished the job (or does not know it): copy the result and mark the job done or failed.
async function collectResult(live: LiveJob) {
  const { job } = live;
  live.finishing = true;
  try {
    const { preset } = await loadPreset(job.presetId);
    const files = await getFinishedOutput(job.promptId!, preset.output.node);
    if (!files) {
      await finish(live, "failed", {
        error:
          "ComfyUI does not know this job any more. ComfyUI was probably restarted while the job was waiting or running. Please start it again.",
      });
      return;
    }

    // Keep one file: the first with an accepted ending (picture, video, sound or 3D model, FRG-29).
    // An ending that is not accepted fails the job with a message that names it.
    const { file, kind } = pickOutputFile(files, preset.type);

    // Copy it into data/outputs (it keeps ComfyUI's extension, for example .png, .mp4 or .glb).
    // A short random part, like uploads have, so two jobs that finish in the same millisecond
    // never get the same name (FRG-28).
    const data = await downloadOutput(file);
    const fileName = `${job.presetId}-${Date.now()}-${randomBytes(3).toString("hex")}${path.extname(file.filename)}`;
    await mkdir(OUTPUTS_DIR, { recursive: true });
    await writeFile(path.join(OUTPUTS_DIR, fileName), data);
    await finish(live, "done", {
      outputFile: `data/outputs/${fileName}`,
      imageUrl: `/api/outputs/${fileName}`,
      outputKind: kind,
    });
  } catch (error) {
    // 503: ComfyUI did not answer (see callComfyUI). Try again at the next check.
    if (error instanceof HttpError && error.status === 503) {
      live.finishing = false;
      return;
    }
    await finish(live, "failed", { error: errorMessage(error) });
  }
}

async function checkJob(live: LiveJob, queue: { running: string[]; pending: string[] }) {
  const promptId = live.job.promptId!;
  live.lastAnswerAt = Date.now();

  if (queue.running.includes(promptId)) {
    live.runningSince ??= Date.now();
    if (live.job.status === "queued") {
      live.job.status = "running";
      save(live); // Not waited for, so a slow MongoDB does not hold up the other jobs.
    }
    if (Date.now() - live.runningSince > RUNNING_TIMEOUT_MS) {
      await finish(live, "failed", { error: "ComfyUI took too long to finish the job." });
    }
    return;
  }

  const place = queue.pending.indexOf(promptId);
  if (place >= 0) {
    live.jobsAhead = queue.running.length + place;
    return;
  }

  // Not in the queue: finished, or ComfyUI does not know it. The queue is read before the history,
  // so a job that finishes in between is found in the history.
  await collectResult(live);
}

// The checker and Cancel take turns, so they never change the same job at the same time.
let lock: Promise<unknown> = Promise.resolve();
export function withLock<T>(work: () => Promise<T>): Promise<T> {
  const result = lock.then(work);
  lock = result.catch(() => {});
  return result;
}

// Ask ComfyUI about every unfinished job. One question about the queue covers all of them.
async function checkActiveJobs() {
  const active = [...liveJobs.values()].filter(
    (live) => isActive(live.job.status) && live.job.promptId && !live.finishing,
  );
  if (active.length === 0) return;

  let queue;
  try {
    queue = await getQueue();
  } catch {
    // ComfyUI is not answering. Keep waiting, but not forever.
    for (const live of active) {
      if (Date.now() - live.lastAnswerAt > UNREACHABLE_TIMEOUT_MS) {
        await finish(live, "failed", {
          error: "ComfyUI stopped answering, so this job could not be finished. Start ComfyUI, then start the job again.",
        });
      }
    }
    return;
  }
  for (const live of active) await checkJob(live, queue);
}

let checking = false;

async function checkJobs() {
  if (checking) return;
  checking = true;
  try {
    await withLock(checkActiveJobs);
  } finally {
    checking = false;
  }
}

export function startJobChecker() {
  setInterval(() => {
    checkJobs().catch((error) => console.error("Checking jobs failed:", error));
  }, CHECK_INTERVAL_MS);
}

// When the backend starts (or MongoDB first works, see connectDatabase in db.ts): follow the jobs
// that were waiting or running when it stopped.
// The checker then finds out what happened to each one in ComfyUI: still running (keep following),
// finished (copy the result), or unknown (failed).
// "Make a longer video" (FRG-56): chain.ts gives the function that carries on a chain after a
// restart. It is set this way because chain.ts uses this file, not the other way round.
let resumeChain: ((live: LiveJob) => void) | null = null;
export function onResumeChain(resume: (live: LiveJob) => void) {
  resumeChain = resume;
}

export async function recoverJobs() {
  let jobs: Job[];
  try {
    jobs = await findActiveJobs();
  } catch (error) {
    console.warn(`Warning: could not look for unfinished jobs. ${safeMessage(error)}`);
    return;
  }
  // Jobs started since this backend started are already followed (MongoDB may have come back late).
  jobs = jobs.filter((job) => !liveJobs.has(job.id));
  if (jobs.length === 0) {
    console.log("Recovery: no unfinished jobs from before the restart.");
    return;
  }

  console.log(`Recovery: found ${jobs.length} unfinished job(s) from before the restart. Checking them with ComfyUI.`);
  for (const job of jobs) {
    const live = follow(job);
    if (job.chain) {
      // A chain (FRG-56) carries on: finished clips are kept, a running clip is followed as usual.
      if (resumeChain) resumeChain(live);
      else await finish(live, "failed", { error: "The backend stopped while making this longer video." });
    } else if (job.sourceJobIds) {
      // A join (FRG-55) runs in the backend itself, so it stopped with the backend.
      await finish(live, "failed", { error: "The backend stopped while joining the clips. Press Join all again." });
    } else if (!job.promptId) {
      await finish(live, "failed", {
        error: "The backend stopped before this job was sent to ComfyUI. Please start it again.",
      });
    }
  }
}

// ---- Routes ----

// The project of a new job (FRG-40). Like a card (see projectForNewItem), but a job must still
// start when MongoDB is offline. Then the project cannot be checked: a projectId that looks like
// an id is kept, otherwise "Unsorted" (empty if it was never known; fixed at the next start).
export async function jobProjectId(projectId: unknown, sourceJobId: string | undefined): Promise<string> {
  try {
    return await projectForNewItem(projectId, sourceJobId);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 503) throw error;
    if (typeof projectId === "string" && JOB_ID_PATTERN.test(projectId)) return projectId;
    return knownUnsortedProjectId() ?? "";
  }
}

// POST /api/jobs
// Body: { "presetId": "text-to-image-basic", "inputs": { "prompt": "a red car" }, "sourceJobId": "<optional>",
//         "parentJobId": "<optional>", "projectId": "<optional, default Unsorted>" }
// parentJobId (FRG-54 "Extend video"): the finished clip this job continues. The job saves it,
// with the chain's first clip as chainRootId, and goes into the parent's project.
// Answer: { "jobId": "<uuid>" }, plus "warning" if the job could not be saved in MongoDB.
// If ComfyUI does not accept the job, the answer is an error, with the jobId of the failed job.
export async function createJobHandler(req: Request, res: Response) {
  const { presetId, inputs, sourceJobId, parentJobId, projectId } = req.body ?? {};
  // "Send to -> Open in Generate" (FRG-26): the job whose result is the start image.
  if (sourceJobId !== undefined && (typeof sourceJobId !== "string" || !JOB_ID_PATTERN.test(sourceJobId))) {
    res.status(400).json({ error: "sourceJobId must be a job id." });
    return;
  }
  if (parentJobId !== undefined && (typeof parentJobId !== "string" || !JOB_ID_PATTERN.test(parentJobId))) {
    res.status(400).json({ error: "parentJobId must be a job id." });
    return;
  }

  let made;
  try {
    made = await newJob({ presetId, inputs, sourceJobId, parentJobId, projectId, createdBy: res.locals.username ?? null });
  } catch (error) {
    sendError(res, error);
    return;
  }
  // 3. and 4.
  await sendToComfyUI(made.live, made.workflow, res);
}

// Steps 1 and 2 of a new job: check everything, then save it as "queued" and follow it.
// Used by POST /api/jobs and by "Make a longer video" for each clip (FRG-56).
// Throws an HttpError (and saves nothing) if a value, the preset or the project is not right.
export async function newJob(request: {
  presetId: unknown;
  inputs: unknown;
  sourceJobId?: string;
  parentJobId?: string;
  projectId?: unknown;
  createdBy: string | null;
}): Promise<{ live: LiveJob; workflow: Workflow }> {
  const { presetId, inputs, sourceJobId, parentJobId, projectId, createdBy } = request;
  // 1. Load the preset and put the user's values into its workflow. Bad values: answer 400, save nothing.
  //    Start images must be in ComfyUI's input folder; a missing one is uploaded again (FRG-25).
  //    An unknown or archived project also answers 400 (FRG-40).
  let built;
  let inputFiles: string[];
  let project: string;
  let parent: Job | undefined;
  {
    const { preset, workflow } = await loadPreset(presetId);
    built = await ensureStartImages(preset, workflow, buildWorkflow(preset, workflow, inputs ?? {}));
    inputFiles = await inputFilesFor(preset, built.usedValues);
    if (parentJobId) {
      parent = (await findAnyJob(parentJobId)) ?? undefined;
      if (!parent || parent.status !== "done" || parent.outputKind !== "video") {
        throw new HttpError(400, "The clip to extend is not a finished video. Open it in the gallery and press Extend again.");
      }
    }
    // A job made from another job's result goes into that job's project (FRG-26, FRG-54).
    project = await jobProjectId(projectId, sourceJobId ?? parentJobId);
  }

  // 2. Save the job first, so it is not lost if the backend stops.
  const live = follow({
    id: crypto.randomUUID(),
    presetId: presetId as string, // Checked by loadPreset.
    inputs: built.usedValues,
    status: "queued",
    promptId: null,
    outputFile: null,
    imageUrl: null,
    error: null,
    durationMs: 0,
    createdAt: new Date(),
    createdBy, // Set by requireLogin in auth.ts.
    projectId: project,
    ...(inputFiles.length > 0 ? { inputFiles } : {}),
    ...(sourceJobId ? { sourceJobId } : {}),
    // The first clip of a chain is its own chain root (FRG-54).
    ...(parent ? { parentJobId: parent.id, chainRootId: parent.chainRootId ?? parent.id } : {}),
  });
  await save(live);
  // The parent was the first clip: mark it, also in the copy in memory if it is still there.
  if (parent && !parent.chainRootId && (await markChainRoot(parent.id))) parent.chainRootId = parent.id;
  return { live, workflow: built.workflow };
}

// Send a saved, queued job to ComfyUI. If ComfyUI does not accept it, the job fails, and the
// answer is the HTTP status for that error; otherwise null.
// ComfyUI's job id is saved at once. We do not wait for that save, so the answer stays fast
// when MongoDB is slow or offline. The checker follows the job from here.
export async function queueJob(live: LiveJob, workflow: Workflow): Promise<number | null> {
  try {
    live.job.promptId = await queueWorkflow(workflow);
  } catch (error) {
    await finish(live, "failed", { error: errorMessage(error) });
    return error instanceof HttpError ? error.status : 500;
  }
  save(live);
  return null;
}

// Send a saved, queued job to ComfyUI and answer the request. Also used to run a board card.
export async function sendToComfyUI(live: LiveJob, workflow: Workflow, res: Response) {
  const status = await queueJob(live, workflow);
  if (status !== null) {
    res.status(status).json({ jobId: live.job.id, error: live.job.error, warning: live.warning });
    return;
  }
  res.json({ jobId: live.job.id, warning: live.warning });
}

// Why a finished job cannot be cancelled.
function finishedMessage(status: JobStatus): string {
  if (status === "done") return "This job is already done, so there is nothing to cancel.";
  if (status === "failed") return "This job already failed, so there is nothing to cancel.";
  return "This job was already cancelled.";
}

// Stop the job in ComfyUI and mark it cancelled. Returns why it could not be cancelled, or null.
// Runs inside the lock, so the checker does not change the job meanwhile.
async function cancelJob(live: LiveJob, username: string | null): Promise<string | null> {
  const { job } = live;
  if (!isActive(job.status)) return finishedMessage(job.status);
  if (live.joinProgress || job.sourceJobIds) return "Joining clips cannot be cancelled. It only takes a short time."; // FRG-55
  if (job.chain) {
    // "Make a longer video" (FRG-56): stop the clip being made, then the chain. Clips already
    // made stay in the gallery. A new clip only starts inside the lock, after checking the chain.
    const current = liveJobs.get(job.chain.clipJobIds.at(-1) ?? "");
    if (current && isActive(current.job.status)) {
      const reason = await cancelJob(current, username);
      if (reason && isActive(current.job.status)) return reason;
    }
    await finish(live, "cancelled", { cancelledBy: username, cancelledAt: new Date() });
    return null;
  }
  if (!job.promptId) return "The job is still being sent to ComfyUI. Try again in a moment.";
  const promptId = job.promptId;

  const queue = await getQueue();
  const waiting = queue.pending.includes(promptId);
  let running = queue.running.includes(promptId);
  // In neither list: ComfyUI has just finished it. The checker saves the result.
  if (!waiting && !running) return "This job has just finished, so it could not be cancelled.";

  if (waiting) {
    await removeFromQueue(promptId);
    // It may have started just before we removed it.
    running = (await getQueue()).running.includes(promptId);
  }
  // Only stop ComfyUI when it is running this exact job. Never stop another user's job.
  if (running) await interruptJob(promptId);

  await finish(live, "cancelled", { cancelledBy: username, cancelledAt: new Date() });
  return null;
}

// POST /api/jobs/<id>/cancel
// A waiting job is removed from ComfyUI's queue. A running job is stopped.
// Only the user who started the job can cancel it.
// Answer: the job, now with status "cancelled". A finished job is not changed: the answer is 409.
export async function cancelJobHandler(req: Request, res: Response) {
  const id = String(req.params.id);
  if (!JOB_ID_PATTERN.test(id)) {
    res.status(400).json({ error: "This is not a job id." });
    return;
  }
  const username: string | null = res.locals.username ?? null;

  const live = liveJobs.get(id);
  let job = live?.job ?? null;
  if (!job) {
    try {
      job = await findJob(id);
    } catch (error) {
      sendError(res, error);
      return;
    }
  }
  if (!job) {
    res.status(404).json({ error: "There is no job with this id." });
    return;
  }
  if (!username || job.createdBy !== username) {
    res.status(403).json({ error: "You can only cancel your own jobs. This job was started by someone else." });
    return;
  }
  if (!live || !isActive(live.job.status)) {
    // Not followed by the backend: it is finished (or MongoDB still says waiting after a failed recovery).
    const message = isActive(job.status) ? "This job cannot be cancelled right now." : finishedMessage(job.status);
    res.status(409).json({ error: message });
    return;
  }

  try {
    const reason = await withLock(() => cancelJob(live, username));
    if (reason) {
      res.status(409).json({ error: reason });
      return;
    }
    res.json({ ...live.job, progress: null, warning: live.warning });
  } catch (error) {
    sendError(res, error);
  }
}

// PATCH /api/jobs/<id>/project
// Body: { "projectId": "..." }. Move one job (or board card) to another project (FRG-43).
// Only its projectId changes: its files stay where they are. Everyone on the team can move any job.
// An unknown or archived project answers 400. Answer: the job.
export async function moveJobHandler(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, "This is not a job id.");
    const projectId = await checkTargetProjectId(req.body?.projectId);
    const job = await moveJobToProject(id, projectId);
    if (!job) throw new HttpError(404, "There is no job with this id.");
    // A job the backend is still following is saved again on each change. Keep the new project there too.
    const live = liveJobs.get(id);
    if (live) live.job.projectId = projectId;
    res.json(job);
  } catch (error) {
    sendError(res, error);
  }
}

// One job, from memory (unfinished or just finished) or from MongoDB. null if there is none.
export async function findAnyJob(id: string): Promise<Job | null> {
  return liveJobs.get(id)?.job ?? (await findJob(id));
}

// GET /api/jobs/<id>
// Answer: the job (status, outputFile, imageUrl, error, ...), plus "progress" while it is
// unfinished, and "warning" if it could not be saved in MongoDB.
export async function getJobHandler(req: Request, res: Response) {
  const id = String(req.params.id);
  if (!JOB_ID_PATTERN.test(id)) {
    res.status(400).json({ error: "This is not a job id." });
    return;
  }

  const live = liveJobs.get(id);
  if (live) {
    res.json({ ...live.job, progress: progressOf(live), warning: live.warning });
    return;
  }

  try {
    const job = await findJob(id);
    if (!job) {
      res.status(404).json({ error: "There is no job with this id." });
      return;
    }
    res.json({ ...job, progress: null });
  } catch (error) {
    sendError(res, error);
  }
}

// One value from the query string, or undefined.
function queryValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// GET /api/jobs
//   ?limit=10           at most this many jobs (default 50, max 200), newest first
//   ?before=<createdAt> only jobs made before this time (for the next page)
//   ?status=active      only queued and running jobs (from memory, also works when MongoDB is offline)
//   ?status=done        only finished jobs with a result (for the gallery)
//   ?mine=1             only jobs I started
//   ?projectId=<id>     only jobs in this project (FRG-40)
// Answer: { "jobs": [...] }
export async function listJobsHandler(req: Request, res: Response) {
  const limitText = queryValue(req.query.limit);
  const limit = limitText === undefined ? DEFAULT_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    res.status(400).json({ error: `limit must be a whole number from 1 to ${MAX_LIMIT}.` });
    return;
  }

  const beforeText = queryValue(req.query.before);
  const before = beforeText === undefined ? null : new Date(beforeText);
  if (before && Number.isNaN(before.getTime())) {
    res.status(400).json({ error: "before must be a date, for example a createdAt value." });
    return;
  }

  const status = queryValue(req.query.status);
  if (status !== undefined && status !== "active" && status !== "done") {
    res.status(400).json({ error: 'status must be "active" or "done".' });
    return;
  }

  const createdBy: string | null = queryValue(req.query.mine) === "1" ? (res.locals.username ?? null) : null;

  const projectId = queryValue(req.query.projectId) ?? null;
  if (projectId !== null && !JOB_ID_PATTERN.test(projectId)) {
    res.status(400).json({ error: "projectId must be a project id." });
    return;
  }

  if (status === "active") {
    const jobs = [...liveJobs.values()]
      .map((live) => live.job)
      .filter((job) => isActive(job.status))
      .filter((job) => !createdBy || job.createdBy === createdBy)
      .filter((job) => !projectId || job.projectId === projectId)
      .filter((job) => !before || job.createdAt < before)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    res.json({ jobs });
    return;
  }

  try {
    res.json({ jobs: await listJobs({ limit, before, status: status === "done" ? "done" : null, createdBy, projectId }) });
  } catch (error) {
    sendError(res, error);
  }
}
