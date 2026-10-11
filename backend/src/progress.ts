import { CLIENT_ID, COMFYUI_URL } from "./comfyui.js";

// Live step progress.
// The backend keeps one WebSocket open to ComfyUI and remembers the step progress of each job.
// GET /api/jobs/<id> reads it from here (see jobs.ts).

// If the WebSocket closes (for example ComfyUI was restarted), try again after this long.
const RECONNECT_MS = 3000;

// Step progress per ComfyUI job id (prompt_id), for example { step: 3, steps: 8, pass: 1 }.
// pass counts the sampler passes (FRG-32): it goes up by one each time the progress comes from
// another node, for example Wan 2.2's high noise sampler, then its low noise sampler.
type Steps = { step: number; steps: number; pass: number; node: string | null };
const stepsByPrompt = new Map<string, Steps>();

// Open the WebSocket to ComfyUI and keep it open.
export function startProgressListener() {
  const socket = new WebSocket(`${COMFYUI_URL.replace(/^http/, "ws")}/ws?clientId=${CLIENT_ID}`);

  socket.onmessage = (event) => {
    // ComfyUI also sends preview images as binary data. We only need the text messages.
    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data);
      // Example: { "type": "progress", "data": { "value": 3, "max": 8, "prompt_id": "..." } }
      // ComfyUI also sends "node": the id of the node that is working.
      if (message.type === "progress") {
        const { prompt_id: promptId, value, max } = message.data;
        const node: string | null = message.data.node ?? null;
        const last = stepsByPrompt.get(promptId);
        // A new pass: another node, or (without node ids) the steps start again.
        const newPass = last !== undefined && (node !== null ? node !== last.node : value < last.step);
        const pass = last === undefined ? 1 : last.pass + (newPass ? 1 : 0);
        stepsByPrompt.set(promptId, { step: value, steps: max, pass, node });
      }
    } catch {
      // Not JSON. Ignore it.
    }
  };

  // Closed or could not connect (ComfyUI not running): try again later.
  socket.onclose = () => setTimeout(startProgressListener, RECONNECT_MS);
}

// The last step ComfyUI reported for this job, and which pass it is in (1 for the first).
// steps is 0 until sampling starts.
export function getSteps(promptId: string): { step: number; steps: number; pass: number } {
  const steps = stepsByPrompt.get(promptId);
  return steps ? { step: steps.step, steps: steps.steps, pass: steps.pass } : { step: 0, steps: 0, pass: 1 };
}

// The job is finished: forget its steps.
export function forgetSteps(promptId: string) {
  stepsByPrompt.delete(promptId);
}
