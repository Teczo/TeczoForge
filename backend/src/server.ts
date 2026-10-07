import "dotenv/config";
import express from "express";
import { generateHandler, OUTPUTS_DIR } from "./generate.js";

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

app.get("/api/health", async (_req, res) => {
  const reachable = await isComfyUIReachable();
  res.json({
    backend: "ok",
    comfyui: { reachable },
  });
});

// Make an image from a preset and the user's values.
app.post("/api/generate", express.json(), generateHandler);

// Serve finished images from data/outputs.
app.use("/api/outputs", express.static(OUTPUTS_DIR));

// If the request body is not valid JSON, say so clearly instead of showing an HTML error page.
app.use((error: { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error.type === "entity.parse.failed") {
    res.status(400).json({ error: "The request body is not valid JSON." });
    return;
  }
  next(error);
});

app.listen(PORT, HOST, () => {
  console.log(`Backend running at http://${HOST}:${PORT}`);
  console.log(`ComfyUI address: ${COMFYUI_URL}`);
});
