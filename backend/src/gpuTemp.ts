import { execFile } from "node:child_process";
import type { Request, Response } from "express";

// GPU temperature (FRG-99).
// Every 5 seconds the backend asks nvidia-smi (installed with the NVIDIA driver) for the GPU core
// temperature, and keeps the last value. Only READ: TeczoForge never changes a GPU setting.
// If nvidia-smi cannot be read, the temperature is "unknown" and nothing is blocked.
// FRG-100 will use it to pause batches when the GPU is too hot.

const NVIDIA_SMI = process.env.NVIDIA_SMI_PATH || "nvidia-smi";
const ARGS = ["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"];
const READ_EVERY_MS = 5000;
const TIMEOUT_MS = 3000;
// A value older than this is not trusted any more (for example nvidia-smi hangs).
const STALE_MS = 15000;

let lastC: number | null = null;
let lastReadAt: Date | null = null;
let lastProblem = ""; // So a problem is logged once, not every 5 seconds.

// Functions that get each new reading. jobs.ts uses it to keep the highest temperature of a running job.
const listeners: ((temperatureC: number) => void)[] = [];
export function onGpuTemperature(listener: (temperatureC: number) => void) {
  listeners.push(listener);
}

// Ask nvidia-smi once. Resolves the temperature in °C, or rejects with the reason in plain English.
// execFile with a list of arguments, never a shell string.
function readOnce(): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(NVIDIA_SMI, ARGS, { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(new Error(`nvidia-smi could not be run (${error.message.split("\n")[0]})`));
        return;
      }
      // One line per GPU. System 1 has one GPU: use the first line.
      const value = Number.parseFloat(stdout.trim().split(/\r?\n/)[0]);
      if (!Number.isFinite(value) || value < 0 || value > 150) reject(new Error(`nvidia-smi gave no temperature (answer: ${JSON.stringify(stdout.trim().slice(0, 80))})`));
      else resolve(value);
    });
  });
}

async function read() {
  try {
    const value = await readOnce();
    lastC = Math.round(value * 10) / 10;
    lastReadAt = new Date();
    if (lastProblem) console.log("GPU temperature can be read again.");
    lastProblem = "";
    for (const listener of listeners) listener(lastC);
  } catch (error) {
    const problem = (error as Error).message;
    if (problem !== lastProblem) console.warn(`Warning: GPU temperature unknown. ${problem}. Set NVIDIA_SMI_PATH in backend/.env if nvidia-smi is somewhere else.`);
    lastProblem = problem;
  }
}

// The last reading. known is false when nvidia-smi could not be read, or the value is too old.
export function gpuTemperature(): { temperatureC: number | null; readAt: Date | null; known: boolean } {
  const known = lastC !== null && lastReadAt !== null && Date.now() - lastReadAt.getTime() < STALE_MS && lastProblem === "";
  return { temperatureC: known ? lastC : null, readAt: lastReadAt, known };
}

export function startGpuReader() {
  read();
  setInterval(read, READ_EVERY_MS).unref();
}

// GET /api/gpu
// Answer: { "temperatureC": 62, "readAt": "...", "known": true }. temperatureC is null when unknown.
export function gpuHandler(_req: Request, res: Response) {
  res.json(gpuTemperature());
}
