import "dotenv/config";
import express from "express";
import { cancelJobHandler, createJobHandler, getJobHandler, listJobsHandler, OUTPUTS_DIR, recoverJobs, startJobChecker } from "./jobs.js";
import { checkDatabase } from "./db.js";
import { boardHandler, createDraftHandler, deleteDraftHandler, runDraftHandler, updateDraftHandler } from "./drafts.js";
import { startProgressListener } from "./progress.js";
import { listPresets } from "./presets.js";
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, uploadHandler } from "./upload.js";
import { checkSessionSecret, loginHandler, logoutHandler, meHandler, requireLogin } from "./auth.js";

// Settings come from backend/.env. The defaults match .env.example.
const PORT = Number(process.env.PORT ?? 4000);
const COMFYUI_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";

// Listen on this PC only, until ticket FRG-15.
const HOST = "127.0.0.1";

// How long to wait for ComfyUI before we say it is not reachable.
const COMFYUI_TIMEOUT_MS = 2000;

// Ask ComfyUI for its system stats. If it answers in time, it is running.
async function isComfyUIReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${COMFYUI_URL}/system_stats`, {
      signal: AbortSignal.timeout(COMFYUI_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    // Connection refused, timeout, or bad address: ComfyUI is not reachable.
    return false;
  }
}

const app = express();

// Logging in and out works without a login.
app.post("/api/login", express.json(), loginHandler);
app.post("/api/logout", logoutHandler);

// Every other /api address needs a login (see auth.ts). This must stay above the routes below.
app.use("/api", requireLogin);

// Who is logged in. The page asks this first: 401 means "show the login form".
app.get("/api/me", meHandler);

app.get("/api/health", async (_req, res) => {
  const reachable = await isComfyUIReachable();
  res.json({
    backend: "ok",
    comfyui: { reachable },
  });
});

// Every preset folder, read fresh each time, so a new folder shows up after a page refresh.
app.get("/api/presets", async (_req, res) => {
  try {
    res.json({ presets: await listPresets() });
  } catch (error) {
    console.error("Could not read presets:", error);
    res.status(500).json({ error: "Could not read the presets folder. See the backend log." });
  }
});

// Upload a picture for an "image" input. The body is the picture itself (no extra package needed).
app.post("/api/upload", express.raw({ type: IMAGE_TYPES, limit: MAX_UPLOAD_BYTES }), uploadHandler);

// Jobs (see jobs.ts): start one from a preset and the user's values (answers at once),
// a page of the job history, one job with its progress, and cancel my own job.
app.post("/api/jobs", express.json(), createJobHandler);
app.get("/api/jobs", listJobsHandler);
app.get("/api/jobs/:id", getJobHandler);
app.post("/api/jobs/:id/cancel", cancelJobHandler);

// The board (see drafts.ts): cards are saved jobs that have not run yet ("drafts").
app.get("/api/board", boardHandler);
app.post("/api/drafts", express.json(), createDraftHandler);
app.patch("/api/drafts/:id", express.json(), updateDraftHandler);
app.delete("/api/drafts/:id", deleteDraftHandler);
app.post("/api/drafts/:id/run", runDraftHandler);

// Serve finished images from data/outputs.
app.use("/api/outputs", express.static(OUTPUTS_DIR));

// If the request body is not valid JSON, say so clearly instead of showing an HTML error page.
app.use((error: { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error.type === "entity.parse.failed") {
    res.status(400).json({ error: "The request body is not valid JSON." });
    return;
  }
  if (error.type === "entity.too.large") {
    res.status(413).json({ error: `This file is too big. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
    return;
  }
  next(error);
});

// Check the login key before the server starts, so a bad SESSION_SECRET stops it right away.
checkSessionSecret();

app.listen(PORT, HOST, () => {
  console.log(`Backend running at http://${HOST}:${PORT}`);
  console.log(`ComfyUI address: ${COMFYUI_URL}`);
  // After MongoDB is checked, pick up the jobs that were not finished when the backend stopped.
  checkDatabase().then((connected) => {
    if (connected) return recoverJobs();
  });
  startProgressListener();
  startJobChecker();
});
