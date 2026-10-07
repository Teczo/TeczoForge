import { useEffect, useState } from "react";
import type { StartValues } from "./Generate";
import Media, { isVideo } from "./Media";

// One job, as GET /api/jobs returns it (see backend/src/db.ts).
type Job = {
  presetId: string | null;
  inputs: Record<string, unknown>;
  status: "done" | "failed";
  outputFile: string | null;
  imageUrl: string | null;
  error: string | null;
  durationMs: number;
  createdAt: string;
  createdBy?: string | null; // Missing on jobs from before team logins (FRG-16).
};

// Who made a job, for showing on the page.
function madeBy(job: Job): string {
  return job.createdBy ?? "Unknown";
}

type GalleryProps = {
  // "Use again": open the Generate page with this job's preset and values.
  onUseAgain: (values: StartValues) => void;
};

export default function Gallery({ onUseAgain }: GalleryProps) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Job | null>(null);

  // Load the job history once, when the page opens.
  useEffect(() => {
    async function loadJobs() {
      try {
        const response = await fetch("/api/jobs");
        const body = await response.json().catch(() => null);
        if (!body) {
          setError("Could not reach the backend. Make sure it is running, then refresh the page.");
        } else if (!response.ok) {
          setError(body.error ?? "Could not load the gallery.");
        } else {
          // Only finished jobs have an image. The backend sends them newest first.
          setJobs(body.jobs.filter((job: Job) => job.status === "done" && job.imageUrl));
        }
      } catch {
        setError("Could not reach the backend. Make sure it is running, then refresh the page.");
      }
    }
    loadJobs();
  }, []);

  if (error) return <p style={{ color: "red" }}>{error}</p>;
  if (!jobs) return <p>Loading the gallery...</p>;
  if (selected) {
    return (
      <Detail
        job={selected}
        onBack={() => setSelected(null)}
        onUseAgain={() => onUseAgain({ presetId: selected.presetId, inputs: selected.inputs })}
      />
    );
  }
  if (jobs.length === 0) return <p>No images yet. Make one on the Generate page.</p>;

  return (
    <section>
      <h2>Gallery</h2>
      <p>{jobs.length} results, newest first. Click one to see it large.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
        {jobs.map((job) => (
          <button
            key={job.imageUrl}
            onClick={() => setSelected(job)}
            title={String(job.inputs.prompt ?? "")}
            style={{ position: "relative", padding: 0, border: "1px solid #ccc", background: "none", cursor: "pointer" }}
          >
            <Media
              url={job.imageUrl!}
              mode="thumbnail"
              alt={String(job.inputs.prompt ?? "")}
              style={{ display: "block", width: "100%", aspectRatio: "1 / 1", objectFit: "cover" }}
            />
            {isVideo(job.imageUrl!) && (
              <span style={{ position: "absolute", left: 6, bottom: 6, background: "rgba(0,0,0,0.7)", color: "white", padding: "2px 6px", fontSize: 12 }}>
                &#9654; Video
              </span>
            )}
            <small style={{ display: "block", padding: "4px 6px", textAlign: "left", color: "#555" }}>by {madeBy(job)}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

// The large image or video with its prompt and settings.
function Detail({ job, onBack, onUseAgain }: { job: Job; onBack: () => void; onUseAgain: () => void }) {
  const { prompt, seed, width, height } = job.inputs;

  return (
    <section>
      <button onClick={onBack}>&larr; Back to gallery</button>{" "}
      <button onClick={onUseAgain}>Use again</button>
      <Media
        url={job.imageUrl!}
        mode="full"
        alt={String(prompt ?? "")}
        style={{ display: "block", maxWidth: "100%", width: 768, margin: "16px 0" }}
      />
      <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px" }}>
        <dt><strong>Prompt</strong></dt>
        <dd style={{ margin: 0 }}>{String(prompt ?? "")}</dd>
        <dt><strong>Made by</strong></dt>
        <dd style={{ margin: 0 }}>{madeBy(job)}</dd>
        <dt><strong>Preset</strong></dt>
        <dd style={{ margin: 0 }}>{job.presetId}</dd>
        <dt><strong>Seed</strong></dt>
        <dd style={{ margin: 0 }}>{String(seed ?? "")}</dd>
        <dt><strong>Size</strong></dt>
        <dd style={{ margin: 0 }}>{String(width ?? "")} x {String(height ?? "")}</dd>
        <dt><strong>Time taken</strong></dt>
        <dd style={{ margin: 0 }}>{(job.durationMs / 1000).toFixed(1)} seconds</dd>
        <dt><strong>Made on</strong></dt>
        <dd style={{ margin: 0 }}>{new Date(job.createdAt).toLocaleString()}</dd>
      </dl>
    </section>
  );
}
