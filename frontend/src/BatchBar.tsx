import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { CircleX, Layers, Pause, Play, Square } from "lucide-react";
import { clockTime, formatDuration } from "./Estimate";

// Batches (FRG-75): a list of board cards that runs by itself, one card at a time (backend/src/batches.ts).
// The bar shows one batch: its name, how far it is, the card running now, and the buttons.
// Only the user who started the batch sees the buttons. Everyone else can watch it.

const REFRESH_MS = 2000;
const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

// One batch, as GET /api/batches returns it. Only the parts the page uses.
export type Batch = {
  id: string;
  name: string;
  projectId: string | null;
  owner: { type: "game" | "pack" | "time-test" | null; id: string | null };
  state: "running" | "paused" | "done" | "ended";
  cardIds: string[];
  doneCardIds: string[];
  failedCardIds: string[];
};

// GET /api/batches/<id> also has each card and whether I may use the buttons.
type BatchCard = { id: string; title: string; status: string | null };
// timeLeft (FRG-76): leftMs counts only cards with a known time; unknownCards have none, so it is "at least".
type TimeLeft = { done: number; left: number; failed: number; leftMs: number; finishAt: string; unknownCards: number };
type BatchDetail = Batch & {
  currentCardId: string | null;
  note: string | null;
  createdBy: string | null;
  cards: BatchCard[];
  canControl: boolean;
  timeLeft: TimeLeft;
};

// The running and paused batches, loaded again every few seconds. Used by the board and the game page.
export function useActiveBatches(): Batch[] {
  const [batches, setBatches] = useState<Batch[]>([]);
  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const response = await fetch("/api/batches?state=running,paused");
        const body = await response.json().catch(() => null);
        if (!stopped && response.ok && body) setBatches(body.batches ?? []);
      } catch {
        // The backend is not answering. Keep what is shown; the page says so elsewhere.
      }
    }
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  return batches;
}

// The cards of these batches that still have to run (not done, not failed). The board labels them "In batch".
export function cardsInBatches(batches: Batch[]): Set<string> {
  return new Set(
    batches.flatMap((batch) => batch.cardIds.filter((id) => !batch.doneCardIds.includes(id) && !batch.failedCardIds.includes(id))),
  );
}

const STATE_STYLES: Record<Batch["state"], { label: string; className: string }> = {
  running: { label: "Running", className: "bg-sky-500/15 text-sky-300" },
  paused: { label: "Paused", className: "bg-amber-500/15 text-amber-300" },
  done: { label: "Done", className: "bg-emerald-500/15 text-emerald-300" },
  ended: { label: "Ended", className: "bg-slate-600/40 text-slate-300" },
};

export default function BatchBar({ batchId }: { batchId: string }) {
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const response = await fetch(`/api/batches/${encodeURIComponent(batchId)}`);
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not load the batch.");
      else {
        setBatch(body);
        setError(null);
      }
    } catch {
      setError(NO_BACKEND);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [batchId]);

  async function press(action: "pause" | "resume" | "stop-now" | "end") {
    if (action === "end" && !window.confirm("End this batch? Cards that have not run stay on the board in Ready.")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/batches/${encodeURIComponent(batchId)}/${action}`, { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "That did not work. Please try again.");
      else setError(null);
    } catch {
      setError(NO_BACKEND);
    } finally {
      setBusy(false);
      load();
    }
  }

  if (!batch) return error ? <p className="message warning">{error}</p> : null;

  const total = batch.cardIds.length;
  const failed = batch.failedCardIds.length;
  const current = batch.cards.find((card) => card.id === batch.currentCardId);
  const open = batch.state === "running" || batch.state === "paused";
  const style = STATE_STYLES[batch.state];

  return (
    <div className="mb-4 rounded-xl border border-slate-700/60 bg-slate-800/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Layers size={18} className="shrink-0 text-slate-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-100">{batch.name}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>{style.label}</span>
          </div>
          <div className="text-xs text-slate-400">
            {batch.doneCardIds.length} of {total} done{failed > 0 && <span className="text-red-300">, {failed} failed</span>}
            {current && (
              <>
                {" · "}Now: <span className="text-slate-200">{current.title}</span>
              </>
            )}
            {batch.createdBy && <> · started by {batch.createdBy}</>}
          </div>
          {open && batch.timeLeft.left > 0 && (
            <div className="text-xs text-slate-300">
              {batch.timeLeft.unknownCards > 0 ? "at least about" : "about"} {formatDuration(batch.timeLeft.leftMs)} left · ends about{" "}
              {clockTime(new Date(batch.timeLeft.finishAt))}
              {batch.state === "paused" && " if you resume now"}
            </div>
          )}
        </div>
        {batch.canControl && open && (
          <div className="flex flex-wrap gap-2">
            {batch.state === "running" ? (
              <BarButton label="Pause" icon={<Pause size={14} />} onClick={() => press("pause")} disabled={busy} />
            ) : (
              <BarButton label="Resume" icon={<Play size={14} />} onClick={() => press("resume")} disabled={busy} />
            )}
            <BarButton label="Stop now" icon={<Square size={14} />} onClick={() => press("stop-now")} disabled={busy || !batch.currentCardId} />
            <BarButton label="End batch" icon={<CircleX size={14} />} onClick={() => press("end")} disabled={busy} />
          </div>
        )}
      </div>
      {batch.note && <p className="mt-2 mb-0 text-xs text-amber-300">{batch.note}</p>}
      {error && <p className="mt-2 mb-0 text-xs text-red-300">{error}</p>}
    </div>
  );
}

function BarButton({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-700/60 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );
}
