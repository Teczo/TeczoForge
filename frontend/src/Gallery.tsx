import { useEffect, useState } from "react";

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
};

export default function Gallery() {
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
  if (selected) return <Detail job={selected} onBack={() => setSelected(null)} />;
  if (jobs.length === 0) return <p>No images yet. Make one on the Generate page.</p>;

  return (
    <section>
      <h2>Gallery</h2>
      <p>{jobs.length} images, newest first. Click an image to see it large.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
        {jobs.map((job) => (
          <button
            key={job.imageUrl}
            onClick={() => setSelected(job)}
            title={String(job.inputs.prompt ?? "")}
            style={{ padding: 0, border: "1px solid #ccc", background: "none", cursor: "pointer" }}
          >
            <img
              src={job.imageUrl!}
              alt={String(job.inputs.prompt ?? "")}
              loading="lazy"
              style={{ display: "block", width: "100%", aspectRatio: "1 / 1", objectFit: "cover" }}
            />
          </button>
        ))}
      </div>
    </section>
  );
}

// The large image with its prompt and settings.
function Detail({ job, onBack }: { job: Job; onBack: () => void }) {
  const { prompt, seed, width, height } = job.inputs;

  return (
    <section>
      <button onClick={onBack}>&larr; Back to gallery</button>
      <img
        src={job.imageUrl!}
        alt={String(prompt ?? "")}
        style={{ display: "block", maxWidth: "100%", width: 768, margin: "16px 0" }}
      />
      <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px" }}>
        <dt><strong>Prompt</strong></dt>
        <dd style={{ margin: 0 }}>{String(prompt ?? "")}</dd>
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
