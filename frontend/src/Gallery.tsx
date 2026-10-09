import { useEffect, useState } from "react";
import type { StartValues } from "./Generate";
import type { Attachment } from "./Chat";
import Media, { isVideo } from "./Media";
import SendToMenu from "./SendToMenu";
import { ArrowLeftIcon, ArrowRightIcon, ChatIcon, DownloadIcon, PlayIcon, RepeatIcon } from "./Icons";

// How many results the gallery shows: the newest ones.
const GALLERY_LIMIT = 100;

// One job, as GET /api/jobs returns it (see backend/src/db.ts).
type Job = {
  id?: string; // Missing on jobs from before FRG-20.
  presetId: string | null;
  inputs: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  outputFile: string | null;
  imageUrl: string | null;
  error: string | null;
  durationMs: number;
  createdAt: string;
  createdBy?: string | null; // Missing on jobs from before team logins (FRG-16).
  inputFiles?: string[]; // Kept start images, for example "data/inputs/<name>" (FRG-25).
  sourceJobId?: string; // "Send to": the job whose result is the start image (FRG-26).
};

// A job made from this one with "Send to" (GET /api/jobs/<id>/used-in).
type UsedIn = { id: string; presetId: string | null; status: string; title: string | null };

// The address of a kept start image: "data/inputs/<name>" is served at /api/inputs/<name>.
function inputUrl(file: string): string {
  return `/api/inputs/${encodeURIComponent(file.replace(/^data\/inputs\//, ""))}`;
}

// Who made a job, for showing on the page.
function madeBy(job: Job): string {
  return job.createdBy ?? "Unknown";
}

type GalleryProps = {
  // "Use again": open the Generate page with this job's preset and values.
  onUseAgain: (values: StartValues) => void;
  // "Use in chat": attach this picture in the last open chat (FRG-25).
  onUseInChat: (attachment: Attachment) => void;
  // From #/gallery/<job id>: show this job large (the board's Open button).
  openJobId?: string | null;
};

export default function Gallery({ onUseAgain, onUseInChat, openJobId = null }: GalleryProps) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Job | null>(null);

  // Load the job history once, when the page opens.
  useEffect(() => {
    async function loadJobs() {
      try {
        const response = await fetch(`/api/jobs?status=done&limit=${GALLERY_LIMIT}`);
        const body = await response.json().catch(() => null);
        if (!body) {
          setError("Could not reach the backend. Make sure it is running, then refresh the page.");
        } else if (!response.ok) {
          setError(body.error ?? "Could not load the gallery.");
        } else {
          // Only finished jobs have an image. The backend sends them newest first.
          setJobs(body.jobs.filter((job: Job) => job.imageUrl));
        }
      } catch {
        setError("Could not reach the backend. Make sure it is running, then refresh the page.");
      }
    }
    loadJobs();
  }, []);

  // Open one job from a link. It may be older than the jobs in the grid, so ask for it by id.
  useEffect(() => {
    if (!openJobId) return;
    async function loadOneJob() {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(openJobId!)}`);
        const body = await response.json().catch(() => null);
        if (!body) setError("Could not reach the backend. Make sure it is running, then refresh the page.");
        else if (!response.ok) setError(body.error ?? "Could not load this result.");
        else if (body.status !== "done" || !body.imageUrl) setError("This job has no finished result to show.");
        else setSelected(body);
      } catch {
        setError("Could not reach the backend. Make sure it is running, then refresh the page.");
      }
    }
    loadOneJob();
  }, [openJobId]);

  // Back to the grid. A job opened from a link also goes back to the plain #/gallery address.
  function closeDetail() {
    setSelected(null);
    if (openJobId) window.location.hash = "#/gallery";
  }

  let content;
  if (error) content = <p className="message error">{error}</p>;
  else if (!jobs) content = <p className="empty">Loading the gallery...</p>;
  else if (selected) {
    content = (
      <Detail
        job={selected}
        onBack={closeDetail}
        onUseAgain={() => onUseAgain({ presetId: selected.presetId, inputs: selected.inputs })}
        onUseInChat={onUseInChat}
        onSendToGenerate={onUseAgain}
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
          <p>
            {jobs.length < GALLERY_LIMIT ? `${jobs.length} results` : `The latest ${GALLERY_LIMIT} results`}, newest
            first. Click one to see it large.
          </p>
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
type DetailProps = {
  job: Job;
  onBack: () => void;
  onUseAgain: () => void;
  onUseInChat: (a: Attachment) => void;
  onSendToGenerate: (values: StartValues) => void; // "Send to -> Open in Generate" (FRG-26).
};
function Detail({ job, onBack, onUseAgain, onUseInChat, onSendToGenerate }: DetailProps) {
  const { prompt, seed, width, height } = job.inputs;
  const [chatError, setChatError] = useState<string | null>(null);
  const [usedIn, setUsedIn] = useState<UsedIn[]>([]);

  // "Used in": the jobs and cards made from this result with "Send to".
  useEffect(() => {
    setUsedIn([]);
    if (!job.id) return;
    fetch(`/api/jobs/${job.id}/used-in`)
      .then((response) => (response.ok ? response.json() : { jobs: [] }))
      .then((body) => setUsedIn(body.jobs ?? []))
      .catch(() => {});
  }, [job.id]);

  // "Use in chat": the backend copies the picture into data/inputs as a new start image.
  async function useInChat() {
    setChatError(null);
    try {
      const response = await fetch("/api/inputs/from-output", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: job.imageUrl }),
      });
      const body = await response.json().catch(() => null);
      if (!body) setChatError("Could not reach the backend. Make sure it is running, then try again.");
      else if (!response.ok) setChatError(body.error ?? "Could not use this picture in chat.");
      else onUseInChat({ id: body.name, width: body.width, height: body.height });
    } catch {
      setChatError("Could not reach the backend. Make sure it is running, then try again.");
    }
  }

  return (
    <>
      <div className="gallery-head">
        <button className="button" onClick={onBack}>
          <ArrowLeftIcon size={18} /> Back to gallery
        </button>
      </div>
      <div className="detail">
        <div className="detail-media panel">
          {job.inputFiles?.length ? (
            // A job with a start image: show Start image -> Result.
            <div className="start-result">
              <figure>
                {job.inputFiles.map((file) => (
                  <img key={file} src={inputUrl(file)} alt="Start image" />
                ))}
                <figcaption>Start image</figcaption>
              </figure>
              <ArrowRightIcon size={26} />
              <figure>
                <Media url={job.imageUrl!} mode="full" alt={String(prompt ?? "")} />
                <figcaption>Result</figcaption>
              </figure>
            </div>
          ) : (
            <Media url={job.imageUrl!} mode="full" alt={String(prompt ?? "")} />
          )}
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
            {job.sourceJobId && (
              <>
                <dt>Made from</dt>
                <dd>
                  <a href={`#/gallery/${job.sourceJobId}`}>Open the start picture's job</a>
                </dd>
              </>
            )}
            {usedIn.length > 0 && (
              <>
                <dt>Used in</dt>
                <dd>
                  <ul className="used-in">
                    {usedIn.map((item) => (
                      <li key={item.id}>
                        {item.status === "done" ? (
                          <a href={`#/gallery/${item.id}`}>{item.title ?? item.presetId}</a>
                        ) : (
                          <a href="#/board">{item.title ?? item.presetId}</a>
                        )}{" "}
                        <span className="board-meta">
                          ({item.presetId}
                          {item.status === "done" ? "" : item.status === "draft" ? ", card on the board" : `, ${item.status}`})
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
          <div className="button-row">
            <button className="button primary" onClick={onUseAgain}>
              <RepeatIcon size={18} /> Use again
            </button>
            {!isVideo(job.imageUrl!) && job.id && <SendToMenu jobId={job.id} onOpenInGenerate={onSendToGenerate} />}
            {!isVideo(job.imageUrl!) && (
              <button className="button" onClick={useInChat}>
                <ChatIcon size={18} /> Use in chat
              </button>
            )}
            <a className="button" href={job.imageUrl!} download>
              <DownloadIcon size={18} /> Download
            </a>
          </div>
          {chatError && <p className="message error">{chatError}</p>}
        </div>
      </div>
    </>
  );
}
