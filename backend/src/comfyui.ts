import { HttpError } from "./httpError.js";
import type { Workflow } from "./presets.js";

export const COMFYUI_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";

// Our name in ComfyUI. ComfyUI sends live progress only to the client that queued the job,
// so we send this id with every job and use it for the WebSocket (see progress.ts).
// It stays the same after a backend restart, so jobs started before the restart still get progress.
export const CLIENT_ID = "teczoforge-backend";

// How long to wait for one ComfyUI request (not the whole job).
const REQUEST_TIMEOUT_MS = 10_000;

// One output file, as ComfyUI describes it.
export type OutputFile = { filename: string; subfolder: string; type: string };

// Call ComfyUI. If it does not answer, throw a clear "offline" error.
async function callComfyUI(urlPath: string, options: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${COMFYUI_URL}${urlPath}`, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(503, "ComfyUI is not running or not answering. Start ComfyUI and try again.");
  }
}

// Send a workflow to ComfyUI's queue. Returns the job id (prompt_id).
export async function queueWorkflow(workflow: Workflow): Promise<string> {
  const response = await callComfyUI("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    // ComfyUI explains what is wrong, for example a missing model file.
    const reason = body?.error?.message ?? `HTTP ${response.status}`;
    throw new HttpError(502, `ComfyUI did not accept the job: ${reason}${findNodeErrors(body?.node_errors)}`);
  }
  return body.prompt_id;
}

// ComfyUI's queue: the job ids running now, and the ones waiting, first in line first.
export async function getQueue(): Promise<{ running: string[]; pending: string[] }> {
  const response = await callComfyUI("/queue");
  const queue = await response.json();
  // Each item is [number, prompt_id, ...]. A lower number was queued earlier.
  const ids = (items: [number, string][]) => [...items].sort((a, b) => a[0] - b[0]).map((item) => item[1]);
  return { running: ids(queue.queue_running ?? []), pending: ids(queue.queue_pending ?? []) };
}

// Remove a waiting job from ComfyUI's queue. A job that is already running is not touched.
export async function removeFromQueue(promptId: string): Promise<void> {
  const response = await callComfyUI("/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
  });
  if (!response.ok) {
    throw new HttpError(502, `ComfyUI did not remove the job from its queue (HTTP ${response.status}).`);
  }
}

// Stop the running job, but only if it is this one. ComfyUI checks the prompt_id itself too,
// so another job is never stopped.
export async function interruptJob(promptId: string): Promise<void> {
  const response = await callComfyUI("/interrupt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt_id: promptId }),
  });
  if (!response.ok) {
    throw new HttpError(502, `ComfyUI did not stop the job (HTTP ${response.status}).`);
  }
}

// Upload a picture into ComfyUI's input folder. Returns the file name ComfyUI saved it as.
export async function uploadImage(image: Buffer, fileName: string, contentType: string): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(image)], { type: contentType }), fileName);
  form.append("overwrite", "false"); // Never replace a file that is already there.
  const response = await callComfyUI("/upload/image", { method: "POST", body: form });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.name) {
    throw new HttpError(502, `ComfyUI did not accept the image (HTTP ${response.status}).`);
  }
  return body.name;
}

// Is the job finished? Returns the files from the output node, or null if it is not in
// ComfyUI's history (not finished yet, or ComfyUI does not know it). Throws if the job failed.
export async function getFinishedOutput(promptId: string, outputNode: string): Promise<OutputFile[] | null> {
  const response = await callComfyUI(`/history/${encodeURIComponent(promptId)}`);
  const history = await response.json();
  const job = history[promptId];

  // The job shows up in history only when it is finished.
  if (!job) return null;
  if (job.status?.status_str === "error") {
    throw new HttpError(502, `ComfyUI job failed: ${findErrorMessage(job.status.messages)}`);
  }
  // Pictures and videos both come in "images". Save Video also sets "animated": [true].
  const files: OutputFile[] = job.outputs?.[outputNode]?.images ?? [];
  if (files.length === 0) {
    throw new HttpError(502, "ComfyUI finished the job but made no picture or video.");
  }
  return files;
}

// Download one output file from ComfyUI.
export async function downloadOutput(file: OutputFile): Promise<Buffer> {
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
  const response = await callComfyUI(`/view?${query}`);
  if (!response.ok) {
    throw new HttpError(502, `Could not download the image from ComfyUI (HTTP ${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// Turn ComfyUI's per-node errors into one line,
// for example ". width: Value 1 smaller than min of 16".
function findNodeErrors(nodeErrors: unknown): string {
  if (typeof nodeErrors !== "object" || nodeErrors === null) return "";
  const lines: string[] = [];
  for (const node of Object.values(nodeErrors)) {
    for (const error of node?.errors ?? []) {
      lines.push(error.details ? `${error.details}: ${error.message}` : error.message);
    }
  }
  return lines.length > 0 ? `. ${lines.join("; ")}` : "";
}

// Find the error text inside ComfyUI's status messages.
function findErrorMessage(messages: unknown): string {
  if (Array.isArray(messages)) {
    for (const [type, data] of messages) {
      if (type === "execution_error" && data?.exception_message) return data.exception_message;
    }
  }
  return "unknown error";
}
