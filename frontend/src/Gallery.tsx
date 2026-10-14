import { useEffect, useState } from "react";
import type { Preset, StartValues } from "./Generate";
import PresetBadges from "./PresetBadges";
import type { Attachment } from "./Chat";
import type { Project } from "./App";
import { MoveToProject } from "./ProjectDialogs";
import Media, { outputKind } from "./Media";
import SendToMenu, { ExtendButton } from "./SendToMenu";
import ChainView from "./ChainView";
import { ArrowLeft, ArrowRight, Download, Folder, MessageSquare, Play, Repeat } from "lucide-react";

// How many results the gallery shows: the newest ones.
const GALLERY_LIMIT = 100;

// One job, as GET /api/jobs returns it (see backend/src/db.ts).
type Job = {
  id?: string; // Missing on jobs from before FRG-20.
  presetId: string | null;
  inputs: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  outputFile: string | null;
  imageUrl: string | null; // The finished file, of any kind.
  outputKind?: string; // image, video, audio or 3d (FRG-29). Missing on older jobs.
  error: string | null;
  durationMs: number;
  createdAt: string;
  createdBy?: string | null; // Missing on jobs from before team logins (FRG-16).
  inputFiles?: string[]; // Kept start images, for example "data/inputs/<name>" (FRG-25).
  sourceJobId?: string; // "Send to": the job whose result is the start image (FRG-26).
  parentJobId?: string; // "Extend": the clip this one continues from its last frame (FRG-54).
  chainRootId?: string; // The first clip of its chain (FRG-54). Set on a first clip once it is extended.
  sourceJobIds?: string[]; // "Join all": the clips joined into this video, in order (FRG-55).
  projectId?: string; // The project of the job (FRG-40).
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
  // The project chosen in the header (FRG-41): only its jobs are shown.
  // undefined while the projects load. null if they could not be loaded: then all jobs are shown.
  project: Project | null | undefined;
  projects: Project[]; // For "Move to project" (FRG-43).
  // A job opened from a link is in another project: switch the picker to it (FRG-42).
  onShowProject: (projectId: string | undefined) => void;
};

export default function Gallery({ onUseAgain, onUseInChat, openJobId = null, project, projects, onShowProject }: GalleryProps) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // For example "Moved to Client X." (FRG-43)
  const [selected, setSelected] = useState<Job | null>(null);
  const projectId = project === undefined ? undefined : (project?.id ?? null);

  // Load the job history when the page opens, and again when the project changes (FRG-41).
  useEffect(() => {
    if (projectId === undefined) return; // Wait for the projects, so the list loads only once.
    // Another project was chosen: go back to its grid. Not for a job that is in the new project:
    // the picker switched to show it (a link to a job, FRG-42).
    if (projectId && selected && selected.projectId !== projectId) closeDetail();
    // A slower answer for the project chosen before must not replace the new list.
    let stale = false;
    setJobs(null);
    setError(null);
    setNotice(null);
    async function loadJobs() {
      try {
        const filter = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
        const response = await fetch(`/api/jobs?status=done&limit=${GALLERY_LIMIT}${filter}`);
        const body = await response.json().catch(() => null);
        if (stale) return;
        if (!body) {
          setError("Could not reach the backend. Make sure it is running, then refresh the page.");
        } else if (!response.ok) {
          setError(body.error ?? "Could not load the gallery.");
        } else {
          // Only finished jobs have an image. The backend sends them newest first.
          setJobs(body.jobs.filter((job: Job) => job.imageUrl));
        }
      } catch {
        if (!stale) setError("Could not reach the backend. Make sure it is running, then refresh the page.");
      }
    }
    loadJobs();
    return () => {
      stale = true;
    };
  }, [projectId]);

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
        else {
          setSelected(body);
          onShowProject(body.projectId); // A job of another project: switch the picker to it (FRG-42).
        }
      } catch {
        setError("Could not reach the backend. Make sure it is running, then refresh the page.");
      }
    }
    loadOneJob();
  }, [openJobId]);

  // "Move to project" worked (FRG-43): the job leaves this project's grid, and the grid shows again.
  function handleMoved(moved: Job, target: Project) {
    setJobs((current) => current?.filter((job) => job.id !== moved.id || !projectId || target.id === projectId) ?? null);
    setNotice(`Moved to the project "${target.name}".`);
    closeDetail();
  }

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
        projects={projects}
        onMoved={handleMoved}
      />
    );
  } else if (jobs.length === 0) {
    content = (
      <p className="empty">
        No results {project ? `in the project "${project.name}" ` : ""}yet. Make one on the <a href="#/generate">Generate</a> page.
      </p>
    );
  } else {
    content = (
      <>
        <div className="gallery-head">
          <h1>Gallery</h1>
          {project && (
            <span className="project-name" title="The project chosen in the header">
              <Folder size={16} /> {project.name}
            </span>
          )}
          <p>
            {jobs.length < GALLERY_LIMIT ? `${jobs.length} results` : `The latest ${GALLERY_LIMIT} results`}, newest
            first. Click one to see it large.
          </p>
        </div>
        <div className="gallery-grid">
          {jobs.map((job) => (
            <button key={job.imageUrl} className="tile" onClick={() => setSelected(job)} title={String(job.inputs.prompt ?? "")}>
              <Media url={job.imageUrl!} kind={outputKind(job)} mode="thumbnail" alt={String(job.inputs.prompt ?? "")} />
              {outputKind(job) === "video" && (
                <span className="video-tag">
                  <Play size={10} className="fill-current" /> {job.sourceJobIds ? `Joined (${job.sourceJobIds.length} clips)` : "Video"}
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

  return (
    <main className="page">
      {notice && !selected && <p className="message info">{notice}</p>}
      {content}
    </main>
  );
}

// The large image or video with its prompt and settings.
type DetailProps = {
  job: Job;
  onBack: () => void;
  onUseAgain: () => void;
  onUseInChat: (a: Attachment) => void;
  onSendToGenerate: (values: StartValues) => void; // "Send to -> Open in Generate" (FRG-26).
  projects: Project[];
  onMoved: (job: Job, project: Project) => void; // "Move to project" worked (FRG-43).
};
function Detail({ job, onBack, onUseAgain, onUseInChat, onSendToGenerate, projects, onMoved }: DetailProps) {
  const { prompt, seed, width, height } = job.inputs;
  const [chatError, setChatError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  // "Move to project" (FRG-43): only this job's project changes. Its file stays where it is.
  async function moveTo(project: Project): Promise<string | null> {
    try {
      const response = await fetch(`/api/jobs/${job.id}/project`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const body = await response.json().catch(() => null);
      if (!body) return "Could not reach the backend. Make sure it is running, then try again.";
      if (!response.ok) return body.error ?? "Could not move this job.";
      onMoved(job, project);
      return null;
    } catch {
      return "Could not reach the backend. Make sure it is running, then try again.";
    }
  }
  const [usedIn, setUsedIn] = useState<UsedIn[]>([]);
  // The job's preset, for its name and licence badge (FRG-32). Missing if the folder is gone.
  const [preset, setPreset] = useState<Preset | null>(null);

  useEffect(() => {
    setPreset(null);
    fetch("/api/presets")
      .then((response) => (response.ok ? response.json() : { presets: [] }))
      .then((body: { presets?: Preset[] }) => setPreset(body.presets?.find((p) => p.id === job.presetId) ?? null))
      .catch(() => {});
  }, [job.presetId]);

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
          <ArrowLeft size={18} /> Back to gallery
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
              <ArrowRight size={26} />
              <figure>
                <Media url={job.imageUrl!} kind={outputKind(job)} mode="full" alt={String(prompt ?? "")} />
                <figcaption>Result</figcaption>
              </figure>
            </div>
          ) : (
            <Media url={job.imageUrl!} kind={outputKind(job)} mode="full" alt={String(prompt ?? "")} />
          )}
        </div>
        <div className="detail-info panel">
          <h2>Prompt</h2>
          <p className="detail-prompt">{String(prompt ?? "")}</p>
          <dl className="facts">
            <dt>Made by</dt>
            <dd>{madeBy(job)}</dd>
            <dt>Preset</dt>
            <dd>
              {job.presetId}
              {preset && (
                <>
                  {" "}
                  <PresetBadges preset={preset} />
                </>
              )}
            </dd>
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
            {job.sourceJobIds && (
              <>
                <dt>Joined</dt>
                <dd>
                  {job.sourceJobIds.length} clips (
                  <a href={`#/gallery/${job.sourceJobIds.at(-1)}`}>open the last clip</a>)
                </dd>
              </>
            )}
            {job.parentJobId && (
              <>
                <dt>Extended from</dt>
                <dd>
                  <a href={`#/gallery/${job.parentJobId}`}>Open the previous clip</a>
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
            {/* A joined video (FRG-55) has no preset to use again. */}
            {!job.sourceJobIds && (
              <button className="button primary" onClick={onUseAgain}>
                <Repeat size={18} /> Use again
              </button>
            )}
            {outputKind(job) === "image" && job.id && <SendToMenu jobId={job.id} onOpenInGenerate={onSendToGenerate} />}
            {outputKind(job) === "video" && job.id && (
              <ExtendButton jobId={job.id} presetId={job.presetId} onOpenInGenerate={onSendToGenerate} />
            )}
            {outputKind(job) === "image" && (
              <button className="button" onClick={useInChat}>
                <MessageSquare size={18} /> Use in chat
              </button>
            )}
            <a className="button" href={job.imageUrl!} download>
              <Download size={18} /> Download
            </a>
            {/* Jobs from before FRG-20 have no id, so they cannot be moved. */}
            {job.id && projects.length > 0 && (
              <button className="button" onClick={() => setMoving(true)}>
                <Folder size={18} /> Move to project...
              </button>
            )}
          </div>
          {chatError && <p className="message error">{chatError}</p>}
          {moving && (
            <MoveToProject
              what="this job"
              projects={projects}
              currentProjectId={job.projectId}
              onMove={moveTo}
              onClose={() => setMoving(false)}
            />
          )}
        </div>
      </div>
      {/* A clip in a chain made with "Extend" (FRG-55). ChainView shows nothing for a single clip. */}
      {job.id && (job.parentJobId || job.chainRootId) && <ChainView jobId={job.id} onOpenInGenerate={onSendToGenerate} />}
    </>
  );
}
