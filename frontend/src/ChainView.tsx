import { useEffect, useState } from "react";
import { Combine } from "lucide-react";
import Media from "./Media";
import { ExtendButton } from "./SendToMenu";
import { ProgressView } from "./Generate";
import type { Progress, StartValues } from "./Generate";

// The chain view in the gallery detail (FRG-55): the clips of a chain made with "Extend" (FRG-54),
// in order, with the length after joining. "Extend last clip" continues the chain; "Join all"
// joins the clips into one video. Shown only for a clip that is part of a chain.

// How often to ask the backend about a running join.
const PROGRESS_INTERVAL_MS = 1500;
const OFFLINE = "Could not reach the backend. Make sure it is running, then try again.";

// From GET /api/jobs/<id>/chain. seconds and totalSeconds are null if ffmpeg could not read them.
type ChainClip = { id: string; presetId: string | null; imageUrl: string; prompt: string; seconds: number | null };
type Chain = { clips: ChainClip[]; totalSeconds: number | null };

// "Join all": nothing yet, following the join job, or the result.
type JoinState =
  | { state: "idle" }
  | { state: "running"; jobId: string; progress: Progress | null }
  | { state: "done"; jobId: string }
  | { state: "failed"; error: string };

function formatLength(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}

export default function ChainView(props: { jobId: string; onOpenInGenerate: (values: StartValues) => void }) {
  const { jobId, onOpenInGenerate } = props;
  const [chain, setChain] = useState<Chain | null>(null);
  const [join, setJoin] = useState<JoinState>({ state: "idle" });

  // Load the chain through this clip.
  useEffect(() => {
    let stale = false;
    setChain(null);
    setJoin({ state: "idle" });
    fetch(`/api/jobs/${jobId}/chain`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: Chain | null) => {
        if (!stale && body) setChain(body);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [jobId]);

  // Follow a running join until it is done or failed.
  const followId = join.state === "running" ? join.jobId : null;
  useEffect(() => {
    if (!followId) return;
    let stopped = false;
    async function check() {
      try {
        const response = await fetch(`/api/jobs/${followId}`);
        const body = await response.json().catch(() => null);
        if (stopped || !body) return;
        if (!response.ok) setJoin({ state: "failed", error: body.error ?? "Could not follow the join." });
        else if (body.status === "done") setJoin({ state: "done", jobId: followId! });
        else if (body.status === "failed" || body.status === "cancelled") setJoin({ state: "failed", error: body.error ?? "The join failed." });
        else setJoin({ state: "running", jobId: followId!, progress: body.progress });
      } catch {
        // Missing one update is fine. The next one comes soon.
      }
    }
    check();
    const timer = setInterval(check, PROGRESS_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [followId]);

  if (!chain || chain.clips.length < 2) return null;
  const last = chain.clips.at(-1)!;

  async function joinAll() {
    setJoin({ state: "running", jobId: "", progress: null });
    try {
      const response = await fetch(`/api/jobs/${last.id}/join`, { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!body) setJoin({ state: "failed", error: OFFLINE });
      else if (!response.ok) setJoin({ state: "failed", error: body.error ?? "Could not join the clips." });
      else setJoin({ state: "running", jobId: body.jobId, progress: null });
    } catch {
      setJoin({ state: "failed", error: OFFLINE });
    }
  }

  return (
    <section className="panel mt-4 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-base font-semibold text-slate-100">Chain of {chain.clips.length} clips</h2>
        {chain.totalSeconds !== null && (
          <span className="text-sm text-slate-400">Total length after joining: {formatLength(chain.totalSeconds)}</span>
        )}
      </div>

      <ol className="m-0 flex list-none gap-3 overflow-x-auto p-0 pb-1">
        {chain.clips.map((clip, index) => (
          <li key={clip.id} className="w-36 shrink-0">
            <a
              href={`#/gallery/${clip.id}`}
              title={clip.prompt}
              className={`block overflow-hidden rounded-lg border-2 ${clip.id === jobId ? "border-teal-400" : "border-transparent hover:border-slate-500"}`}
            >
              <Media url={clip.imageUrl} kind="video" mode="thumbnail" alt={clip.prompt} />
            </a>
            <div className="mt-1 text-xs text-slate-400">
              Clip {index + 1}
              {clip.seconds !== null && ` · ${formatLength(clip.seconds)}`}
              {clip.id === jobId && <span className="text-teal-300"> · this clip</span>}
            </div>
          </li>
        ))}
      </ol>

      <div className="button-row mt-3">
        <ExtendButton jobId={last.id} presetId={last.presetId} onOpenInGenerate={onOpenInGenerate} label="Extend last clip" />
        <button className="button" onClick={joinAll} disabled={join.state === "running"}>
          <Combine size={18} /> Join all
        </button>
      </div>

      {join.state === "running" && (
        <div className="mt-3">
          <ProgressView progress={join.progress} onCancel={null} cancelling={false} />
        </div>
      )}
      {join.state === "done" && (
        <p className="message info">
          The clips are joined. <a href={`#/gallery/${join.jobId}`}>Open the joined video</a>
        </p>
      )}
      {join.state === "failed" && <p className="message error">{join.error}</p>}
    </section>
  );
}
