import { useState } from "react";
import type { FormEvent } from "react";

// The only preset for now. Picking a preset is ticket FRG-10.
const PRESET_ID = "text-to-image-basic";

// How often to ask the backend where the job is.
const PROGRESS_INTERVAL_MS = 500;

// The answer from GET /api/progress/<jobId> (see backend/src/progress.ts).
type Progress =
  | { state: "unknown" }
  | { state: "starting" }
  | { state: "waiting"; jobsAhead: number }
  | { state: "running"; step: number; steps: number }
  | { state: "finishing" };

export default function Generate() {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setRunning(true);
    setProgress(null);
    setError(null);
    setWarning(null);
    setImageUrl(null);

    // Give the job an id, so we can ask the backend about it while we wait.
    const jobId = crypto.randomUUID();
    let finished = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/progress/${jobId}`);
        const answer: Progress = await response.json();
        if (response.ok && !finished) setProgress(answer);
      } catch {
        // Missing one update is fine. The next one comes soon.
      }
    }, PROGRESS_INTERVAL_MS);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId: PRESET_ID, inputs: { prompt }, jobId }),
      });
      // The backend always answers with JSON. If not, the backend is not running.
      const body = await response.json().catch(() => null);

      if (!body) {
        setError("Could not reach the backend. Make sure it is running, then try again.");
      } else if (!response.ok) {
        setError(body.error ?? "Something went wrong. Please try again.");
      } else {
        setImageUrl(body.imageUrl);
      }
      // For example: the image was made, but the job history (MongoDB) is offline.
      if (body?.warning) setWarning(body.warning);
    } catch {
      setError("Could not reach the backend. Make sure it is running, then try again.");
    } finally {
      finished = true;
      clearInterval(timer);
      setProgress(null);
      setRunning(false);
    }
  }

  return (
    <section>
      <h2>Generate an image</h2>
      <form onSubmit={handleSubmit}>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the image, for example: a red car by the sea at sunset"
          rows={4}
          disabled={running}
          style={{ width: "100%", maxWidth: 600, display: "block", marginBottom: 8 }}
        />
        <button type="submit" disabled={running || prompt.trim() === ""}>
          {running ? "Generating..." : "Generate"}
        </button>
      </form>

      {running && <ProgressView progress={progress} />}
      {error && <p style={{ color: "red" }}>{error}</p>}
      {warning && <p style={{ color: "darkorange" }}>Warning: {warning}</p>}
      {imageUrl && (
        <img src={imageUrl} alt={prompt} style={{ display: "block", maxWidth: "100%", width: 600, marginTop: 16 }} />
      )}
    </section>
  );
}

// Shows where the job is: waiting in the queue, a progress bar, or saving.
function ProgressView({ progress }: { progress: Progress | null }) {
  if (progress?.state === "waiting") {
    const ahead = progress.jobsAhead === 1 ? "1 job" : `${progress.jobsAhead} jobs`;
    return <p>Waiting in the queue: {ahead} ahead of yours.</p>;
  }
  if (progress?.state === "running" && progress.steps > 0) {
    return (
      <p>
        <progress value={progress.step} max={progress.steps} style={{ width: 300, verticalAlign: "middle" }} /> Step{" "}
        {progress.step} of {progress.steps}
      </p>
    );
  }
  // Running, but no steps yet: ComfyUI is loading the model (slow only the first time).
  if (progress?.state === "running") return <p>Starting...</p>;
  if (progress?.state === "finishing") return <p>Saving the image...</p>;
  return <p>Sending your job to ComfyUI...</p>;
}
