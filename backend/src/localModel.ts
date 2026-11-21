import { freeMemory, getQueue } from "./comfyui.js";
import { setTranslationHoldsGpu, startTranslateServer, stopTranslateServer, translationHoldsGpu } from "./translateServer.js";

// The owner of the local model on the GPU (FRG-114, plan: docs/tickets/FRG-114-118_Chat_local_model_tickets.md).
// The local model runs in llama-server (translateServer.ts). Translate uses it, and later Chat too.
// Each part "takes" the model before it uses it and "releases" it when it is done.
// llama-server only stops when nobody holds it any more, so one part never stops it under the other.
// The GPU rules stay as in FRG-93: the model and a ComfyUI job are never on the GPU together.

export type LocalModelUser = "translate" | "chat";

// After asking ComfyUI to unload its models, give it this long to do it.
const FREE_WAIT_MS = 3000;

// The parts that hold the model now.
const users = new Set<LocalModelUser>();
// True after ComfyUI was asked to unload its models for this hold of the GPU.
// It decides the error text when llama-server cannot start.
let askedComfyUIToFree = false;
// Take and release run one at a time, in the order they were called.
// So two parts can never start or stop llama-server at the same moment.
let line: Promise<unknown> = Promise.resolve();

function inLine<T>(step: () => Promise<T>): Promise<T> {
  const result = line.then(step);
  line = result.catch(() => undefined);
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// What ComfyUI is doing: "busy" (a job is running or waiting), "idle", or "off" (not running).
async function comfyuiState(): Promise<"busy" | "idle" | "off"> {
  try {
    const queue = await getQueue();
    return queue.running.length > 0 || queue.pending.length > 0 ? "busy" : "idle";
  } catch {
    return "off";
  }
}

// Take the local model for `user`. Answers "ready" when llama-server runs and the model is loaded.
// Answers "busy" when ComfyUI has a job: nothing is loaded, and it does not wait. The caller decides
// whether to ask again later. Throws an error with a plain-English message if llama-server cannot start.
// Calling it again while `user` already holds the model is fine: it only checks that llama-server still runs.
// `onGpuTaken` is called when ComfyUI turned out to be free and the GPU is now ours, just before
// the model starts to load (it is not called when the model was already on the GPU).
export function takeLocalModel(user: LocalModelUser, onGpuTaken?: () => void): Promise<"ready" | "busy"> {
  return inLine(async () => {
    if (!translationHoldsGpu()) {
      // Take the GPU first, then look at ComfyUI's queue. From here on no new job is sent to
      // ComfyUI, so a job cannot slip in between the look and the start of llama-server.
      setTranslationHoldsGpu(true);
      askedComfyUIToFree = false;
      const comfyui = await comfyuiState();
      if (comfyui === "busy") {
        // A generation job is running or waiting. Give the GPU back.
        setTranslationHoldsGpu(false);
        return "busy";
      }
      onGpuTaken?.();
      if (comfyui === "idle") {
        try {
          await freeMemory();
          askedComfyUIToFree = true;
          await sleep(FREE_WAIT_MS);
        } catch (error) {
          // Not fatal: llama-server may still fit. If it does not, the start below fails with a clear text.
          console.warn(`Warning: ComfyUI did not free its memory. ${messageOf(error)}`);
        }
      }
    }
    try {
      // Starts llama-server the first time. After that it only checks that it is ready.
      await startTranslateServer();
    } catch (error) {
      console.error(`Local model: llama-server could not start (for ${user}). ${messageOf(error)}`);
      // Nobody else holds the model: give the GPU back, so generation jobs are allowed again.
      if (users.size === 0) await letGo();
      // ComfyUI is running and was asked to unload, but the model still did not load:
      // most likely a custom node kept its models on the GPU.
      throw new Error(
        askedComfyUIToFree
          ? "The GPU is full. Restart ComfyUI, or wait until it is idle, then press Try again."
          : messageOf(error),
      );
    }
    users.add(user);
    return "ready";
  });
}

// `user` is done with the local model. When nobody holds it any more, llama-server stops
// and the GPU is given back to ComfyUI.
export function releaseLocalModel(user: LocalModelUser): Promise<void> {
  return inLine(async () => {
    users.delete(user);
    if (users.size === 0) await letGo();
  });
}

// The parts that hold the local model now. For the status routes.
export function localModelUsers(): LocalModelUser[] {
  return [...users];
}

// Stop llama-server and give the GPU back. The GPU is given back even if stopping fails.
async function letGo(): Promise<void> {
  try {
    await stopTranslateServer();
  } finally {
    // llama-server has stopped (or never started): generation jobs are allowed again.
    setTranslationHoldsGpu(false);
    askedComfyUIToFree = false;
  }
}
