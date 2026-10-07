import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { generateHandler, OUTPUTS_DIR } from "./generate.js";
import { checkDatabase, listJobs } from "./db.js";
import { HttpError } from "./httpError.js";
import { getProgress, startProgressListener } from "./progress.js";
import { listPresets } from "./presets.js";
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, uploadHandler } from "./upload.js";
import { localNetworkAddresses, localNetworkOnly } from "./network.js";

// Settings come from backend/.env. The defaults match .env.example.
const PORT = Number(process.env.PORT ?? 4000);
const COMFYUI_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";

// Where the backend listens.
// 127.0.0.1 (default): this PC only. 0.0.0.0: other PCs on the local network can use the app too.
// Even with 0.0.0.0, only this PC and the local network are answered (see network.ts).
const HOST = process.env.HOST ?? "127.0.0.1";

// The built frontend (cd frontend, then npm run build). The backend serves it, so other PCs
// only need the backend address. While developing, the Vite dev server on port 5173 still works.
const FRONTEND_DIR = path.join(import.meta.dirname, "..", "..", "frontend", "dist");

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

// Only this PC and the local network. Checked before anything else.
app.use(localNetworkOnly);

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

// Make an image from a preset and the user's values.
app.post("/api/generate", express.json(), generateHandler);

// Where a running job is now: waiting in the queue, or which step it is on.
app.get("/api/progress/:jobId", async (req, res) => {
  try {
    res.json(await getProgress(req.params.jobId));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "Could not read the job progress.";
    res.status(status).json({ error: message });
  }
});

// The whole job history, newest first.
app.get("/api/jobs", async (_req, res) => {
  try {
    res.json({ jobs: await listJobs() });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "Could not read the job history.";
    res.status(status).json({ error: message });
  }
});

// Serve finished images from data/outputs.
app.use("/api/outputs", express.static(OUTPUTS_DIR));

// Serve the built frontend (index.html and its files) for every address that is not /api.
const frontendBuilt = existsSync(path.join(FRONTEND_DIR, "index.html"));
if (frontendBuilt) app.use(express.static(FRONTEND_DIR));

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

app.listen(PORT, HOST, () => {
  console.log(`Backend running at http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`);
  if (HOST === "0.0.0.0") {
    for (const address of localNetworkAddresses()) console.log(`Other PCs on the network: http://${address}:${PORT}`);
  } else {
    console.log("This PC only. To let other PCs on the network use it, set HOST=0.0.0.0 in backend/.env.");
  }
  if (!frontendBuilt) {
    console.log("The frontend is not built yet, so only the API is served here. Build it: cd frontend, then npm run build.");
  }
  console.log(`ComfyUI address: ${COMFYUI_URL}`);
  checkDatabase();
  startProgressListener();
});
