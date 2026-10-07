import { useEffect, useState } from "react";
import type { StartValues } from "./Generate";
import Media, { isVideo } from "./Media";
import { ArrowLeftIcon, DownloadIcon, PlayIcon, RepeatIcon } from "./Icons";

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

  let content;
  if (error) content = <p className="message error">{error}</p>;
  else if (!jobs) content = <p className="empty">Loading the gallery...</p>;
  else if (selected) {
    content = (
      <Detail
        job={selected}
        onBack={() => setSelected(null)}
        onUseAgain={() => onUseAgain({ presetId: selected.presetId, inputs: selected.inputs })}
      />
    );
  } else if (jobs.length === 0) {
    content = (
      <p className="empty">
        No results yet. Make one on the <a href="#/">Generate</a> page.
      </p>
    );
  } else {
    content = (
      <>
        <div className="gallery-head">
          <h1>Gallery</h1>
          <p>{jobs.length} results, newest first. Click one to see it large.</p>
        </div>
        <div className="gallery-grid">
          {jobs.map((job) => (
            <button key={job.imageUrl} className="tile" onClick={() => setSelected(job)} title={String(job.inputs.prompt ?? "")}>
              <Media url={job.imageUrl!} mode="thumbnail" alt={String(job.inputs.prompt ?? "")} />
              {isVideo(job.imageUrl!) && (
                <span className="video-tag">
                  <PlayIcon size={10} /> Video
                </span>
              )}
              <span className="tile-info">
                <span className="tile-prompt">{String(job.inputs.prompt ?? "")}</span>
                <span className="tile-by" style={{ display: "block" }}>
                  by {madeBy(job)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </>
    );
  }

  return <main className="page">{content}</main>;
}

// The large image or video with its prompt and settings.
function Detail({ job, onBack, onUseAgain }: { job: Job; onBack: () => void; onUseAgain: () => void }) {
  const { prompt, seed, width, height } = job.inputs;

  return (
    <>
      <div className="gallery-head">
        <button className="button" onClick={onBack}>
          <ArrowLeftIcon size={18} /> Back to gallery
        </button>
      </div>
      <div className="detail">
        <div className="detail-media panel">
          <Media url={job.imageUrl!} mode="full" alt={String(prompt ?? "")} />
        </div>
        <div className="detail-info panel">
          <h2>Prompt</h2>
          <p className="detail-prompt">{String(prompt ?? "")}</p>
          <dl className="facts">
            <dt>Made by</dt>
            <dd>{madeBy(job)}</dd>
            <dt>Preset</dt>
            <dd>{job.presetId}</dd>
            <dt>Seed</dt>
            <dd>{String(seed ?? "")}</dd>
            {width !== undefined && (
              <>
                <dt>Size</dt>
                <dd>
                  {String(width)} x {String(height ?? "")}
                </dd>
              </>
            )}
            <dt>Time taken</dt>
            <dd>{(job.durationMs / 1000).toFixed(1)} seconds</dd>
            <dt>Made on</dt>
            <dd>{new Date(job.createdAt).toLocaleString()}</dd>
          </dl>
          <div className="button-row">
            <button className="button primary" onClick={onUseAgain}>
              <RepeatIcon size={18} /> Use again
            </button>
            <a className="button" href={job.imageUrl!} download>
              <DownloadIcon size={18} /> Download
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
