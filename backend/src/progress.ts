import { CLIENT_ID, COMFYUI_URL, getQueue } from "./comfyui.js";

// Live job progress.
// 1. The backend keeps one WebSocket open to ComfyUI and remembers the step progress of each job.
// 2. The page asks GET /api/progress/<jobId> a few times a second while it waits.

// If the WebSocket closes (for example ComfyUI was restarted), try again after this long.
const RECONNECT_MS = 3000;

// Step progress per ComfyUI job id (prompt_id), for example { step: 3, steps: 8 }.
const stepsByPrompt = new Map<string, { step: number; steps: number }>();

// Our job id (made by the page) -> ComfyUI job id. null until ComfyUI has accepted the job.
const promptByJob = new Map<string, string | null>();

export type Progress =
  | { state: "unknown" } // We do not know this job (not started yet, or already finished).
  | { state: "starting" } // Sending the job to ComfyUI.
  | { state: "waiting"; jobsAhead: number } // In ComfyUI's queue behind other jobs.
  | { state: "running"; step: number; steps: number } // steps is 0 until sampling starts.
  | { state: "finishing" }; // ComfyUI is done; the backend is saving the image.

// Open the WebSocket to ComfyUI and keep it open.
export function startProgressListener() {
  const socket = new WebSocket(`${COMFYUI_URL.replace(/^http/, "ws")}/ws?clientId=${CLIENT_ID}`);

  socket.onmessage = (event) => {
    // ComfyUI also sends preview images as binary data. We only need the text messages.
    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data);
      // Example: { "type": "progress", "data": { "value": 3, "max": 8, "prompt_id": "..." } }
      if (message.type === "progress") {
        stepsByPrompt.set(message.data.prompt_id, { step: message.data.value, steps: message.data.max });
      }
    } catch {
      // Not JSON. Ignore it.
    }
  };

  // Closed or could not connect (ComfyUI not running): try again later.
  socket.onclose = () => setTimeout(startProgressListener, RECONNECT_MS);
}

// Called by the generate route.
export function startJob(jobId: string) {
  promptByJob.set(jobId, null);
}

export function setJobPrompt(jobId: string, promptId: string) {
  promptByJob.set(jobId, promptId);
}

export function endJob(jobId: string) {
  const promptId = promptByJob.get(jobId);
  if (promptId) stepsByPrompt.delete(promptId);
  promptByJob.delete(jobId);
}

// Where is this job now?
export async function getProgress(jobId: string): Promise<Progress> {
  if (!promptByJob.has(jobId)) return { state: "unknown" };
  const promptId = promptByJob.get(jobId);
  if (!promptId) return { state: "starting" };

  const queue = await getQueue();
  if (queue.running.includes(promptId)) {
    const steps = stepsByPrompt.get(promptId);
    return { state: "running", step: steps?.step ?? 0, steps: steps?.steps ?? 0 };
  }
  const place = queue.pending.indexOf(promptId);
  if (place >= 0) {
    return { state: "waiting", jobsAhead: queue.running.length + place };
  }
  return { state: "finishing" };
}
