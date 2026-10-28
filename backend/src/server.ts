import "dotenv/config";
import express from "express";
import {
  cancelJobHandler,
  createJobHandler,
  getJobHandler,
  listJobsHandler,
  moveJobHandler,
  OUTPUTS_DIR,
  recoverJobs,
  startJobChecker,
} from "./jobs.js";
import { connectDatabase } from "./db.js";
import { contentTypeOf } from "./outputKinds.js";
import {
  chatStatusHandler,
  checkChatSetup,
  createConversationHandler,
  deleteConversationHandler,
  getConversationHandler,
  listConversationsHandler,
  renameConversationHandler,
  sendMessageHandler,
} from "./chat.js";
import { boardHandler, createDraftHandler, deleteDraftHandler, runDraftHandler, updateDraftHandler } from "./drafts.js";
import { startProgressListener } from "./progress.js";
import { INPUTS_DIR } from "./inputs.js";
import { lastFrameHandler } from "./lastFrame.js";
import { chainHandler, joinHandler } from "./join.js";
import { createChainHandler } from "./chain.js";
import { extendHandler, sendToHandler, usedInHandler } from "./sendTo.js";
import { listPresets } from "./presets.js";
import { createProjectHandler, listProjectsHandler, updateProjectHandler } from "./projects.js";
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, uploadHandler, useOutputHandler } from "./upload.js";
import { checkSessionSecret, loginHandler, logoutHandler, meHandler, requireLogin } from "./auth.js";
import { checkGameFileHandler } from "./gameFile.js";
import { checkPackFileHandler } from "./packFile.js";
import { getPackHandler, importPackHandler, listPacksHandler } from "./packs.js";
import { convertDocumentHandler } from "./packConvert.js";
import { editPictureHandler, makeModelsHandler, moreModelHandler, morePictureHandler, pickHandler, runPackHandler } from "./packRun.js";
import {
  approveHandler,
  createAssetCardsHandler,
  doneByHandHandler,
  editAssetHandler,
  exportGameHandler,
  generateAllHandler,
  getGameHandler,
  importGameHandler,
  listGamesHandler,
  makeConceptHandler,
  presetTimesHandler,
  variantHandler,
} from "./games.js";
import {
  createBatchHandler,
  endBatchHandler,
  getBatchHandler,
  listBatchesHandler,
  pauseBatchHandler,
  resumeBatchHandler,
  startBatchRunner,
  stopNowHandler,
} from "./batches.js";
import { estimateHandler } from "./estimate.js";
import { timeTestHandler } from "./timeTest.js";

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
// "Send to" (see sendTo.ts): use a finished picture as the start image of another preset,
// and the jobs that were made that way from one job ("Used in").
app.post("/api/send-to", express.json(), sendToHandler);
app.get("/api/jobs/:id/used-in", usedInHandler);
app.post("/api/jobs/:id/cancel", cancelJobHandler);
// Save the last frame of a finished video as a new start image (FRG-53).
app.post("/api/jobs/:id/last-frame", lastFrameHandler);
// "Extend video" (FRG-54): the Generate form values to continue a clip from its last frame.
app.post("/api/jobs/:id/extend", extendHandler);
// Chains of extended clips (FRG-55): the clips in order, and joining them into one video.
app.get("/api/jobs/:id/chain", chainHandler);
app.post("/api/jobs/:id/join", joinHandler);
// "Make a longer video" (FRG-56): make all clips one after the other, then join them.
app.post("/api/chains", express.json(), createChainHandler);
// Move one job to another project (FRG-43).
app.patch("/api/jobs/:id/project", express.json(), moveJobHandler);

// The board (see drafts.ts): cards are saved jobs that have not run yet ("drafts").
app.get("/api/board", boardHandler);
app.post("/api/drafts", express.json(), createDraftHandler);
app.patch("/api/drafts/:id", express.json(), updateDraftHandler);
app.delete("/api/drafts/:id", deleteDraftHandler);
app.post("/api/drafts/:id/run", runDraftHandler);

// Projects (see projects.ts, FRG-39): everyone on the team can see and use every project.
// No delete: a project is archived instead.
app.get("/api/projects", listProjectsHandler);
app.post("/api/projects", express.json(), createProjectHandler);
app.patch("/api/projects/:id", express.json(), updateProjectHandler);

// Games (see gameFile.ts, FRG-65): check a game design .md file and answer with its asset plan.
// The text can be up to 1 MB. JSON escaping can make the body bigger, so the body limit is higher.
app.post("/api/games/check", express.json({ limit: "3mb" }), checkGameFileHandler);
// Import a game design file: save the game, its project and its planned assets (FRG-66).
app.post("/api/games/import", express.json({ limit: "3mb" }), importGameHandler);
app.get("/api/games", listGamesHandler);
// The average job time per preset, for the time estimate before an import (FRG-67). Above /:id.
app.get("/api/games/preset-times", presetTimesHandler);
app.get("/api/games/:id", getGameHandler);
// Concept art first, then all asset cards, then Generate all (FRG-68).
app.post("/api/games/:id/concept", makeConceptHandler);
app.post("/api/games/:id/cards", createAssetCardsHandler);
app.post("/api/games/:id/generate", generateAllHandler);
// Review (FRG-69): approve a result, make a variant, edit the prompt, or mark an external asset as done by hand.
app.post("/api/games/:id/assets/:assetId/approve", express.json(), approveHandler);
app.post("/api/games/:id/assets/:assetId/variant", variantHandler);
app.patch("/api/games/:id/assets/:assetId", express.json(), editAssetHandler);
app.post("/api/games/:id/assets/:assetId/done-by-hand", doneByHandHandler);
// Export to a Unity-ready folder with asset_manifest.json (FRG-70).
app.post("/api/games/:id/export", exportGameHandler);

// Packs (see packFile.ts, FRG-77): check a pack .md file and answer with its plan. Same 1 MB limit as game files.
app.post("/api/packs/check", express.json({ limit: "3mb" }), checkPackFileHandler);
// Import a pack file: save the pack, its project and its items (FRG-78). The list, and one pack with its items.
app.post("/api/packs/import", express.json({ limit: "3mb" }), importPackHandler);
app.get("/api/packs", listPacksHandler);
app.get("/api/packs/:id", getPackHandler);
// "Import any document" (FRG-79): Claude turns an asset document into a pack file. Nothing is saved.
app.post("/api/packs/convert", express.json({ limit: "3mb" }), convertDocumentHandler);
// Run a pack (FRG-80): phase 1 pictures (or full auto), phase 2 3D models, and Pick a result.
app.post("/api/packs/:id/run", express.json(), runPackHandler);
app.post("/api/packs/:id/models", makeModelsHandler);
app.post("/api/packs/:id/items/:itemId/pick", express.json(), pickHandler);
// The fast pick screen (FRG-81): one more picture (N), an edit of a picture (E), one more 3D run (P).
app.post("/api/packs/:id/items/:itemId/more-picture", morePictureHandler);
app.post("/api/packs/:id/items/:itemId/edit-picture", express.json(), editPictureHandler);
app.post("/api/packs/:id/items/:itemId/more-model", moreModelHandler);

// Batches (see batches.ts, FRG-75): a list of board cards that runs one card at a time and can pause.
// Everyone can see a batch. Only the user who started it can use the buttons.
app.post("/api/batches", express.json(), createBatchHandler);
app.get("/api/batches", listBatchesHandler);
app.get("/api/batches/:id", getBatchHandler);
app.post("/api/batches/:id/pause", pauseBatchHandler);
app.post("/api/batches/:id/resume", resumeBatchHandler);
app.post("/api/batches/:id/stop-now", stopNowHandler);
app.post("/api/batches/:id/end", endBatchHandler);

// Time estimate (see estimate.ts, FRG-76): how long a list of jobs takes, and the Time test that measures each preset.
app.post("/api/estimate", express.json(), estimateHandler);
app.post("/api/time-test", express.json(), timeTestHandler);

// Chat with Claude (see chat.ts). Each user only sees their own conversations.
app.get("/api/chat/status", chatStatusHandler);
app.get("/api/chat/conversations", listConversationsHandler);
app.post("/api/chat/conversations", express.json(), createConversationHandler);
app.get("/api/chat/conversations/:id", getConversationHandler);
app.patch("/api/chat/conversations/:id", express.json(), renameConversationHandler);
app.delete("/api/chat/conversations/:id", deleteConversationHandler);
// Sends one message and streams the reply (SSE).
app.post("/api/chat/:conversationId/messages", express.json(), sendMessageHandler);

// Serve finished files from data/outputs, each ending with its own content type (FRG-29).
app.use(
  "/api/outputs",
  express.static(OUTPUTS_DIR, {
    setHeaders: (res, filePath) => {
      const contentType = contentTypeOf(filePath);
      if (contentType) res.setHeader("Content-Type", contentType);
    },
  }),
);
// Serve kept start images from data/inputs (FRG-25). Behind the login, like outputs.
app.use("/api/inputs", express.static(INPUTS_DIR));
// "Use in chat": copy a finished picture into data/inputs as a start image (FRG-25).
app.post("/api/inputs/from-output", express.json(), useOutputHandler);

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
checkChatSetup();

app.listen(PORT, HOST, () => {
  console.log(`Backend running at http://${HOST}:${PORT}`);
  console.log(`ComfyUI address: ${COMFYUI_URL}`);
  // Once MongoDB works (tried again every minute if not), pick up the jobs that were not
  // finished when the backend stopped. This runs only once.
  connectDatabase(recoverJobs);
  startProgressListener();
  startJobChecker();
  // The first check pauses the batches that were running when the backend stopped.
  startBatchRunner();
});
