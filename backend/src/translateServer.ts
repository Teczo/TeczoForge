import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Japanese translation (FRG-90, plan: docs/japanese-translate.md).
// This file starts and stops llama-server, the program that runs the translation model.
// The model uses about 20 GB of GPU memory, so it is loaded only while it is needed.
// llama-server listens on 127.0.0.1 only, and only the backend talks to it (CLAUDE.md section 7, rule 9).

// How long to wait for the model to load. The first load reads about 20 GB from disk.
const LOAD_TIMEOUT_MS = 5 * 60 * 1000;
// How often to ask "are you ready?" while the model loads.
const HEALTH_EVERY_MS = 1000;
// How long to wait for one answer to "are you ready?".
const HEALTH_TIMEOUT_MS = 2000;
// How many of llama-server's last output lines we keep, to show them if it stops while loading.
const KEEP_LINES = 30;

// The folder with all model files: MODELS_DIR in backend/.env, or the models folder in the repo.
function modelsDir(): string {
  const dir = (process.env.MODELS_DIR ?? "").trim();
  return dir ? path.resolve(dir) : path.join(import.meta.dirname, "..", "..", "models");
}

// A model path from backend/.env. A relative path (llm\...) is inside MODELS_DIR.
// A full path (C:\...) is used as it is. Empty stays empty, so the setup check can say so.
function modelFile(value: string | undefined): string {
  const file = (value ?? "").trim();
  if (!file || path.isAbsolute(file)) return file;
  return path.join(modelsDir(), file);
}

// The settings from backend/.env. The defaults match .env.example.
function settings() {
  const env = process.env;
  return {
    serverPath: (env.LLAMA_SERVER_PATH ?? "").trim(),
    modelPath: modelFile(env.TRANSLATE_MODEL_PATH),
    mmprojPath: modelFile(env.TRANSLATE_MMPROJ_PATH),
    port: (env.TRANSLATE_PORT ?? "").trim() || "8190",
    imageMinTokens: (env.TRANSLATE_IMAGE_MIN_TOKENS ?? "").trim() || "2048",
    imageMaxTokens: (env.TRANSLATE_IMAGE_MAX_TOKENS ?? "").trim() || "8192",
    context: (env.TRANSLATE_CONTEXT ?? "").trim() || "24576",
    targetLanguage: (env.TRANSLATE_TARGET_LANGUAGE ?? "").trim() || "English",
  };
}

// What a document record needs to know about the settings (FRG-91).
export function translateSettings() {
  const s = settings();
  return {
    modelName: path.basename(s.modelPath), // The file name only, not the folder.
    imageMinTokens: s.imageMinTokens,
    imageMaxTokens: s.imageMaxTokens,
    targetLanguage: s.targetLanguage,
  };
}

// The address of llama-server. Always on this PC.
export function translateServerUrl(): string {
  return `http://127.0.0.1:${settings().port}`;
}

// Is the feature set up? If not, `problem` says why, in plain English.
export function checkTranslateSetup(): { setUp: boolean; problem: string | null } {
  const s = settings();
  if (!s.serverPath) {
    return { setUp: false, problem: "Translation is not set up. LLAMA_SERVER_PATH in backend/.env is empty." };
  }
  // Each path must be set and must be a file that exists. Say which one is wrong.
  const paths: [string, string][] = [
    ["LLAMA_SERVER_PATH", s.serverPath],
    ["TRANSLATE_MODEL_PATH", s.modelPath],
    ["TRANSLATE_MMPROJ_PATH", s.mmprojPath],
  ];
  for (const [name, value] of paths) {
    if (!value) return { setUp: false, problem: `Translation is not set up. ${name} in backend/.env is empty.` };
    if (!existsSync(value)) {
      return { setUp: false, problem: `Translation is not set up. ${name} in backend/.env points to a file that does not exist: ${value}` };
    }
  }
  // These must be whole numbers, because they go into the start command.
  const numbers: [string, string][] = [
    ["TRANSLATE_PORT", s.port],
    ["TRANSLATE_IMAGE_MIN_TOKENS", s.imageMinTokens],
    ["TRANSLATE_IMAGE_MAX_TOKENS", s.imageMaxTokens],
    ["TRANSLATE_CONTEXT", s.context],
  ];
  for (const [name, value] of numbers) {
    if (!/^[0-9]+$/.test(value)) {
      return { setUp: false, problem: `Translation is not set up. ${name} in backend/.env must be a whole number.` };
    }
  }
  return { setUp: true, problem: null };
}

// Ask llama-server if it is ready.
// "ready": the model is loaded. "loading": it runs but the model is still loading. "off": no answer.
async function health(): Promise<"ready" | "loading" | "off"> {
  try {
    const response = await fetch(`${translateServerUrl()}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (response.ok) return "ready";
    if (response.status === 503) return "loading";
    return "off";
  } catch {
    return "off";
  }
}

// True when llama-server answers and the model is loaded.
export async function isTranslateServerRunning(): Promise<boolean> {
  return (await health()) === "ready";
}

// Sharing the GPU with ComfyUI (FRG-93). The translation model and a ComfyUI job do not fit on
// the GPU together. This is true from the moment the translation worker takes the GPU until
// llama-server has stopped. While it is true, no work is sent to ComfyUI (see queueWorkflow in comfyui.ts).
let holdsGpu = false;

export function translationHoldsGpu(): boolean {
  return holdsGpu;
}

export function setTranslationHoldsGpu(value: boolean): void {
  holdsGpu = value;
}

// The llama-server process that WE started. Null when we did not start one.
// If someone started llama-server by hand, this stays null and we never stop it.
let child: ChildProcess | null = null;
// The last output lines of our llama-server.
let lastLines: string[] = [];

function keepOutput(chunk: Buffer) {
  const lines = chunk.toString("utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  lastLines = [...lastLines, ...lines].slice(-KEEP_LINES);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Start llama-server and wait until the model is loaded.
// If a llama-server already answers on the port, it is used as it is.
// Throws an error with a plain-English message if it cannot start.
export async function startTranslateServer(): Promise<void> {
  const setup = checkTranslateSetup();
  if (!setup.setUp) throw new Error(setup.problem ?? "Translation is not set up.");

  // Our llama-server is already running and ready: nothing to do.
  if (child !== null && (await health()) === "ready") return;

  if (child === null) {
    if ((await health()) !== "off") {
      // Someone started llama-server by hand. Use it. We do not stop it afterwards.
      console.log("Translation: llama-server is already running. Using it.");
    } else {
      const s = settings();
      // An argument list, no shell: a path with spaces or odd characters cannot become a command.
      const args = [
        "-m", s.modelPath,
        "--mmproj", s.mmprojPath,
        "--host", "127.0.0.1",
        "--port", s.port,
        "--n-gpu-layers", "all",
        "--ctx-size", s.context,
        "-np", "1",
        "--jinja",
        "--reasoning", "off",
        "--image-min-tokens", s.imageMinTokens,
        "--image-max-tokens", s.imageMaxTokens,
      ];
      console.log("Translation: starting llama-server. Loading the model can take a few minutes.");
      lastLines = [];
      const started = spawn(s.serverPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child = started;
      started.stdout?.on("data", keepOutput);
      started.stderr?.on("data", keepOutput);
      started.on("error", (error) => {
        keepOutput(Buffer.from(`Could not start llama-server: ${error.message}`));
        if (child === started) child = null;
      });
      started.on("exit", () => {
        if (child === started) child = null;
      });
    }
  }

  // Wait until the model is loaded.
  const startedByUs = child !== null;
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await health()) === "ready") {
      console.log("Translation: llama-server is ready.");
      return;
    }
    if (startedByUs && child === null) {
      // Our llama-server ended by itself. Its last lines say why (a full GPU shows up here).
      console.error("Translation: llama-server stopped while loading. Its last output lines:");
      for (const line of lastLines) console.error(`  ${line}`);
      throw new Error("llama-server stopped while loading the model. See the backend log for the reason.");
    }
    await sleep(HEALTH_EVERY_MS);
  }
  await stopTranslateServer();
  throw new Error("llama-server did not get ready in 5 minutes. It was stopped.");
}

// Stop the llama-server that we started, and wait until it is gone. This frees the GPU memory.
// A llama-server that was started by hand is not touched.
export async function stopTranslateServer(): Promise<void> {
  const running = child;
  if (running === null) return;
  child = null;
  await new Promise<void>((resolve) => {
    if (running.exitCode !== null || running.signalCode !== null) return resolve();
    running.once("exit", () => resolve());
    running.kill();
  });
  console.log("Translation: llama-server stopped.");
}

// When the backend exits, llama-server must not stay behind with 20 GB on the GPU.
process.on("exit", () => {
  child?.kill();
});
// Ctrl+C and a stop request end the backend through "exit" above.
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
