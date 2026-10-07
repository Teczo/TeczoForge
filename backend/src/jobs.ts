import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { buildWorkflow, loadPreset } from "./presets.js";
import { downloadOutput, getFinishedOutput, getQueue, queueWorkflow } from "./comfyui.js";
import { findActiveJobs, findJob, listJobs, safeMessage, saveJob } from "./db.js";
import type { Job, JobStatus } from "./db.js";
import { forgetSteps, getSteps } from "./progress.js";

// Jobs (FRG-20).
// 1. POST /api/jobs checks the inputs, saves the job as "queued", sends it to ComfyUI,
//    and answers at once with the job id. It does not wait for the result.
// 2. Every second the backend asks ComfyUI about all unfinished jobs. Each status change
//    (queued -> running -> done or failed) is saved in MongoDB.
// 3. The page asks GET /api/jobs/<id> every 1 to 2 seconds until the job is done.
// 4. When the backend starts, it picks up the jobs that were not finished (recoverJobs).
// Unfinished jobs are also kept in memory, so jobs still work when MongoDB is offline.
// ComfyUI's queue is the only queue. The backend only follows it.

// Finished images and videos are saved here: data/outputs at the root of the repo.
export const OUTPUTS_DIR = path.join(import.meta.dirname, "..", "..", "data", "outputs");

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  | { state: "running"; step: number; steps: number } // steps is 0 until sampling starts.
  | { state: "finishing" }; // ComfyUI is done; the backend is saving the file.

// A job the backend is following, with what it knows besides the saved record.
type LiveJob = {
  job: Job;
  jobsAhead: number; // Jobs before this one in ComfyUI's queue.
  runningSince: number | null; // When we first saw ComfyUI working on it.
  lastAnswerAt: number; // When ComfyUI last answered about it.
  finishing: boolean; // Copying the result into data/outputs.
  warning: string | undefined; // Set when the last save to MongoDB did not work.
  saving: Promise<void>; // Saves run one after the other, so the last save has the newest status.
};

// Unfinished jobs, and jobs that finished in the last hour. Key: job id.
const liveJobs = new Map<string, LiveJob>();

function isActive(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

function follow(job: Job): LiveJob {
  const live: LiveJob = {
    job,
    jobsAhead: 0,
    runningSince: null,
    lastAnswerAt: Date.now(),
    finishing: false,
    warning: undefined,
    saving: Promise.resolve(),
  };
  liveJobs.set(job.id, live);
  return live;
}

// Save the job as it is when the save runs. Never throws (see saveJob in db.ts).
function save(live: LiveJob): Promise<void> {
  live.saving = live.saving.then(async () => {
    live.warning = await saveJob(live.job);
  });
  return live.saving;
}

// The job is done or failed: save it, and forget it after a while.
async function finish(live: LiveJob, status: "done" | "failed", fields: Partial<Job>) {
  Object.assign(live.job, fields, { status, durationMs: Date.now() - live.job.createdAt.getTime() });
  live.finishing = false;
  if (live.job.promptId) forgetSteps(live.job.promptId);
  await save(live);
  setTimeout(() => liveJobs.delete(live.job.id), KEEP_FINISHED_MS).unref();
}

// A message that is safe to show the user. Unexpected errors go to the backend log.
function errorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  console.error("Job failed:", error);
  return "Something went wrong on the server. See the backend log.";
}

function sendError(res: Response, error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  res.status(status).json({ error: errorMessage(error) });
}

function progressOf(live: LiveJob): Progress | null {
  const { status, promptId } = live.job;
  if (!isActive(status)) return null;
  if (live.finishing) return { state: "finishing" };
  if (status === "running" && promptId) return { state: "running", ...getSteps(promptId) };
  return { state: "waiting", jobsAhead: live.jobsAhead };
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

    // Copy the image or video into data/outputs (it keeps ComfyUI's extension, for example .png or .mp4).
    const [file] = files;
    const data = await downloadOutput(file);
    const fileName = `${job.presetId}-${Date.now()}${path.extname(file.filename)}`;
    await mkdir(OUTPUTS_DIR, { recursive: true });
    await writeFile(path.join(OUTPUTS_DIR, fileName), data);
    await finish(live, "done", { outputFile: `data/outputs/${fileName}`, imageUrl: `/api/outputs/${fileName}` });
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

let checking = false;

// Ask ComfyUI about every unfinished job. One question about the queue covers all of them.
async function checkJobs() {
  if (checking) return;
  const active = [...liveJobs.values()].filter(
    (live) => isActive(live.job.status) && live.job.promptId && !live.finishing,
  );
  if (active.length === 0) return;

  checking = true;
  try {
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
  } finally {
    checking = false;
  }
}

export function startJobChecker() {
  setInterval(() => {
    checkJobs().catch((error) => console.error("Checking jobs failed:", error));
  }, CHECK_INTERVAL_MS);
}

// When the backend starts: follow the jobs that were waiting or running when it stopped.
// The checker then finds out what happened to each one in ComfyUI: still running (keep following),
// finished (copy the result), or unknown (failed).
export async function recoverJobs() {
  let jobs: Job[];
  try {
    jobs = await findActiveJobs();
  } catch (error) {
    console.warn(`Warning: could not look for unfinished jobs. ${safeMessage(error)}`);
    return;
  }
  if (jobs.length === 0) return;

  console.log(`Found ${jobs.length} unfinished job(s) from before the restart. Checking them with ComfyUI.`);
  for (const job of jobs) {
    const live = follow(job);
    if (!job.promptId) {
      await finish(live, "failed", {
        error: "The backend stopped before this job was sent to ComfyUI. Please start it again.",
      });
    }
  }
}

// ---- Routes ----

// POST /api/jobs
// Body: { "presetId": "text-to-image-basic", "inputs": { "prompt": "a red car" } }
// Answer: { "jobId": "<uuid>" }, plus "warning" if the job could not be saved in MongoDB.
// If ComfyUI does not accept the job, the answer is an error, with the jobId of the failed job.
export async function createJobHandler(req: Request, res: Response) {
  const { presetId, inputs } = req.body ?? {};

  // 1. Load the preset and put the user's values into its workflow. Bad values: answer 400, save nothing.
  let built;
  try {
    const { preset, workflow } = await loadPreset(presetId);
    built = buildWorkflow(preset, workflow, inputs ?? {});
  } catch (error) {
    sendError(res, error);
    return;
  }

  // 2. Save the job first, so it is not lost if the backend stops.
  const live = follow({
    id: crypto.randomUUID(),
    presetId,
    inputs: built.usedValues,
    status: "queued",
    promptId: null,
    outputFile: null,
    imageUrl: null,
    error: null,
    durationMs: 0,
    createdAt: new Date(),
    createdBy: res.locals.username ?? null, // Set by requireLogin in auth.ts.
  });
  await save(live);

  // 3. Send it to ComfyUI, and save ComfyUI's job id at once. We do not wait for that save,
  //    so the answer stays fast when MongoDB is slow or offline.
  try {
    live.job.promptId = await queueWorkflow(built.workflow);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    await finish(live, "failed", { error: errorMessage(error) });
    res.status(status).json({ jobId: live.job.id, error: live.job.error, warning: live.warning });
    return;
  }
  save(live);

  // 4. Answer now. The checker follows the job from here.
  res.json({ jobId: live.job.id, warning: live.warning });
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

  if (status === "active") {
    const jobs = [...liveJobs.values()]
      .map((live) => live.job)
      .filter((job) => isActive(job.status))
      .filter((job) => !createdBy || job.createdBy === createdBy)
      .filter((job) => !before || job.createdAt < before)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    res.json({ jobs });
    return;
  }

  try {
    res.json({ jobs: await listJobs({ limit, before, status: status === "done" ? "done" : null, createdBy }) });
  } catch (error) {
    sendError(res, error);
  }
}
