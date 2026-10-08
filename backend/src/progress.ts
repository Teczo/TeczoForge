import { CLIENT_ID, COMFYUI_URL } from "./comfyui.js";

// Live step progress.
// The backend keeps one WebSocket open to ComfyUI and remembers the step progress of each job.
// GET /api/jobs/<id> reads it from here (see jobs.ts).

// If the WebSocket closes (for example ComfyUI was restarted), try again after this long.
const RECONNECT_MS = 3000;

// Step progress per ComfyUI job id (prompt_id), for example { step: 3, steps: 8 }.
const stepsByPrompt = new Map<string, { step: number; steps: number }>();

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

// The last step ComfyUI reported for this job. steps is 0 until sampling starts.
export function getSteps(promptId: string): { step: number; steps: number } {
  return stepsByPrompt.get(promptId) ?? { step: 0, steps: 0 };
}

// The job is finished: forget its steps.
export function forgetSteps(promptId: string) {
  stepsByPrompt.delete(promptId);
}
