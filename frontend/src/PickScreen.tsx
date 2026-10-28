import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { CheckCircle2, X } from "lucide-react";
import Media, { outputKind } from "./Media";
import { ProgressView } from "./Generate";
import type { PackItem, PackJob } from "./PacksPage";

// The fast pick screen of a pack (FRG-81): one item at a time, in file order, picked with the keyboard.
// Picks go through the same route as the Pick buttons on the pack page (backend/src/packRun.ts), so the
// item records are the only source of truth.
// Keys: 1-9 pick that result and go to the next item. N one more picture. E edit a picture. S skip for now.
// Left / Right: previous / next item. P one more 3D run. Esc closes.

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";
// The most 3D results shown side by side: each one is a live 3D view, and a browser only allows a few.
const MAX_MODELS = 4;
const MODEL_LABELS: Record<string, string> = { "image-to-3d-trellis2": "TRELLIS.2", "image-to-3d-pixal3d": "Pixal3D" };

type PickScreenProps = {
  packId: string;
  packName: string;
  items: PackItem[];
  jobs: Record<string, PackJob>;
  onClose: () => void;
  reload: () => void; // Load the pack again after a change.
};

// Waiting for a pick: finished pictures and no picked picture yet, or finished 3D results and no pick yet.
function isWaiting(item: PackItem): boolean {
  return (item.status === "pick_picture" && !item.pickedPictureJobId) || item.status === "pick_model";
}

// "h 12 m · w 0.45 m"
function realSizeText(realSize: PackItem["realSize"]): string {
  if (!realSize) return "";
  const parts: string[] = [];
  if (realSize.height_m !== undefined) parts.push(`h ${realSize.height_m} m`);
  if (realSize.length_m !== undefined) parts.push(`l ${realSize.length_m} m`);
  if (realSize.width_m !== undefined) parts.push(`w ${realSize.width_m} m`);
  return parts.join(" · ");
}

export default function PickScreen({ packId, packName, items, jobs, onClose, reload }: PickScreenProps) {
  // Every item that has results, in file order. Left / Right move through these.
  const shown = items.filter((item) => item.kind !== "skip" && (item.pictureJobIds.length > 0 || item.modelJobIds.length > 0));
  const waiting = shown.filter(isWaiting);
  const [currentId, setCurrentId] = useState<string | null>(() => (waiting[0] ?? shown[0])?.id ?? null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ number: string; text: string } | null>(null);
  const editTextRef = useRef<HTMLTextAreaElement>(null);

  const index = Math.max(0, shown.findIndex((item) => item.id === currentId));
  const item = shown[index] as PackItem | undefined;
  // The 3D stage once the item has 3D jobs; before that, the pictures.
  const stage: "picture" | "model" = item && item.modelJobIds.length > 0 ? "model" : "picture";
  const results = !item ? [] : stage === "picture" ? item.pictureJobIds : item.modelJobIds.slice(-MAX_MODELS);

  // The next item that still waits for a pick, after this one (and then from the start). null if none.
  function nextWaitingId(): string | null {
    const order = [...shown.slice(index + 1), ...shown.slice(0, index)];
    return order.find(isWaiting)?.id ?? null;
  }

  function goTo(offset: number) {
    if (shown.length === 0) return;
    setMessage(null);
    setEditing(null);
    setCurrentId(shown[(index + offset + shown.length) % shown.length].id);
  }

  // Send a change, show what happened, and load the pack again. Returns true if it worked.
  async function post(url: string, body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const answer = await response.json().catch(() => null);
      if (!answer) {
        setMessage({ text: NO_BACKEND, error: true });
        return null;
      }
      if (!response.ok) {
        setMessage({ text: answer.error ?? "That did not work.", error: true });
        return null;
      }
      return answer;
    } catch {
      setMessage({ text: NO_BACKEND, error: true });
      return null;
    } finally {
      setBusy(false);
      reload();
    }
  }

  async function pick(number: number) {
    if (!item || busy) return;
    const jobId = results[number - 1];
    if (!jobId) return;
    if (jobs[jobId]?.status !== "done") {
      setMessage({ text: `Result ${number} is not finished yet.`, error: true });
      return;
    }
    const next = nextWaitingId();
    const answer = await post(`/api/packs/${packId}/items/${item.id}/pick`, { jobId, target: stage });
    if (!answer) return;
    setMessage({ text: `${item.itemId}: ${stage === "model" ? "3D model" : "picture"} ${number} picked.`, error: false });
    if (next) setCurrentId(next);
  }

  async function addResult(kind: "more-picture" | "more-model") {
    if (!item || busy) return;
    if (kind === "more-picture" && stage === "model") {
      setMessage({ text: "This item already has 3D jobs, so it gets no more pictures. Press P for one more 3D run.", error: true });
      return;
    }
    if (kind === "more-model" && (item.kind !== "model" || !item.pickedPictureJobId)) {
      setMessage({ text: "P is for model items with a picked picture.", error: true });
      return;
    }
    const answer = await post(`/api/packs/${packId}/items/${item.id}/${kind}`, {});
    if (answer) setMessage({ text: `${kind === "more-picture" ? "One more picture" : "One more 3D run"}: ${answer.note}`, error: false });
  }

  function openEdit() {
    if (!item) return;
    if (stage === "model") {
      setMessage({ text: "This item already has 3D jobs, so its pictures cannot change any more.", error: true });
      return;
    }
    const picked = item.pictureJobIds.indexOf(item.pickedPictureJobId ?? "");
    setEditing({ number: String(picked >= 0 ? picked + 1 : 1), text: "" });
  }

  async function submitEdit(event?: FormEvent) {
    event?.preventDefault();
    if (!item || !editing || busy) return;
    const jobId = item.pictureJobIds[Number(editing.number) - 1];
    if (!jobId || jobs[jobId]?.status !== "done") {
      setMessage({ text: `Picture ${editing.number} is not a finished picture of this item.`, error: true });
      return;
    }
    const answer = await post(`/api/packs/${packId}/items/${item.id}/edit-picture`, { jobId, instruction: editing.text });
    if (answer) {
      setEditing(null);
      setMessage({ text: `Edit of picture ${editing.number}: ${answer.note}`, error: false });
    }
  }

  useEffect(() => {
    if (editing) editTextRef.current?.focus();
  }, [editing !== null]);

  // The keys. Typing in the edit box is left alone (Esc closes the box).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
      if (event.key === "Escape") {
        event.preventDefault();
        if (editing) setEditing(null);
        else onClose();
        return;
      }
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (/^[1-9]$/.test(key)) pick(Number(key));
      else if (key === "n") addResult("more-picture");
      else if (key === "e") openEdit();
      else if (key === "p") addResult("more-model");
      else if (key === "s") {
        setMessage(null);
        const next = nextWaitingId();
        if (next) setCurrentId(next);
        else goTo(1);
      } else if (event.key === "ArrowLeft") goTo(-1);
      else if (event.key === "ArrowRight") goTo(1);
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const picked = item ? (stage === "picture" ? item.pickedPictureJobId : item.pickedModelJobId) : null;
  // A grid that fits 4 big pictures (or 4 3D views) on a 1920 x 1080 screen without scrolling.
  const columns = Math.min(Math.max(results.length, 1), 4);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-slate-200">
      <div className="flex items-center gap-4 border-b border-slate-800 px-8 py-3">
        <span className="text-base font-semibold text-slate-100">Pick: {packName}</span>
        <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-sm font-medium text-amber-300">{waiting.length} left to pick</span>
        {item && (
          <span className="text-sm text-slate-500">
            Item {index + 1} of {shown.length}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="ml-auto flex cursor-pointer items-center rounded-lg border-0 bg-transparent p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >
          <X size={20} />
        </button>
      </div>

      {!item ? (
        <div className="flex flex-1 items-center justify-center text-slate-400">Nothing to pick yet. Start the pictures on the pack page first.</div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-8 pt-4 pb-2">
            <span className="font-mono text-lg font-semibold text-slate-100">
              {item.itemId}_{item.name}
            </span>
            <span className="text-sm text-slate-400">{stage === "model" ? "Pick the 3D model" : item.kind === "model" ? "Pick the picture for 3D" : "Pick the picture"}</span>
            {realSizeText(item.realSize) && <span className="text-sm text-slate-400">{realSizeText(item.realSize)}</span>}
            {item.editFrom && <span className="text-sm text-slate-500">edit of {item.editFrom}</span>}
            {item.autoPicked && stage === "picture" && <span className="text-sm text-teal-300">Auto-picked</span>}
            {!isWaiting(item) && <span className="text-sm text-emerald-300">Already picked</span>}
            {item.notes && <span className="w-full text-sm text-slate-500">{item.notes}</span>}
            {stage === "model" && (
              <span className="w-full text-xs text-slate-500">
                The picture cannot be changed any more: this item has 3D jobs made from it.
                {item.modelJobIds.length > MAX_MODELS && ` Showing the newest ${MAX_MODELS} of ${item.modelJobIds.length} 3D results.`}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-8 py-2">
            <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {results.map((jobId, position) => (
                <Tile
                  key={jobId}
                  number={position + 1}
                  job={jobs[jobId]}
                  picked={picked === jobId}
                  stage={stage}
                  onClick={() => pick(position + 1)}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {editing && item && (
        <form onSubmit={submitEdit} className="mx-8 mb-2 flex flex-wrap items-start gap-3 rounded-xl border border-slate-700 bg-slate-900 p-3">
          <label className="flex items-center gap-2 text-sm">
            Edit picture
            <input
              value={editing.number}
              onChange={(event) => setEditing({ ...editing, number: event.target.value.replace(/[^0-9]/g, "") })}
              className="w-12 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-center text-slate-100"
              aria-label="Picture number"
            />
          </label>
          <textarea
            ref={editTextRef}
            value={editing.text}
            onChange={(event) => setEditing({ ...editing, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) submitEdit(event);
            }}
            placeholder='What to change, for example "make the paint dark red, keep everything else the same". Enter sends, Esc closes.'
            maxLength={1000}
            className="h-16 min-w-[400px] flex-1 resize-none rounded-md border border-slate-600 bg-slate-950 p-2 text-sm text-slate-100"
          />
          <button
            type="submit"
            disabled={busy || editing.text.trim() === ""}
            className="cursor-pointer rounded-lg border-0 bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Make edit
          </button>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-slate-800 px-8 py-2.5 text-xs text-slate-400">
        <Key k="1-9">pick and go on</Key>
        {stage === "picture" ? (
          <>
            <Key k="N">one more picture</Key>
            <Key k="E">edit a picture</Key>
          </>
        ) : (
          <Key k="P">one more 3D run</Key>
        )}
        <Key k="S">skip for now</Key>
        <Key k="← →">previous / next</Key>
        <Key k="Esc">close</Key>
        {message && <span className={`ml-auto text-sm ${message.error ? "text-red-300" : "text-emerald-300"}`}>{message.text}</span>}
      </div>
    </div>
  );
}

function Key({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span>
      <kbd className="rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200">{k}</kbd> {children}
    </span>
  );
}

type TileProps = { number: number; job: PackJob | undefined; picked: boolean; stage: "picture" | "model"; onClick: () => void };

// One numbered result. A finished picture is shown large; a 3D result in the 3D viewer, with its preset and seed.
function Tile({ number, job, picked, stage, onClick }: TileProps) {
  // Tall enough for 4 in a row on a 1080 high screen, with the header, the item line and the key help.
  const height = "min(calc(100vh - 290px), 30vw)";
  let body: ReactNode;
  if (!job) body = <Centered>Card deleted</Centered>;
  else if (job.status === "done" && job.imageUrl)
    body = <Media url={job.imageUrl} kind={outputKind(job)} mode="full" alt={`Result ${number}`} style={{ width: "100%", height, objectFit: "contain" }} />;
  else if (job.status === "queued" || job.status === "running")
    body = (
      <Centered>
        <div className="w-4/5">
          <ProgressView progress={job.progress} onCancel={null} cancelling={false} />
        </div>
      </Centered>
    );
  else if (job.error) body = <Centered>Failed: {job.error}</Centered>;
  else body = <Centered>Waiting in the batch</Centered>;

  const label =
    stage === "model" && job ? `${MODEL_LABELS[job.presetId ?? ""] ?? job.presetId ?? "3D"} · ${job.seed !== null ? `seed ${job.seed}` : "seed not set yet"}` : null;

  return (
    <div
      className={`overflow-hidden rounded-xl border-2 bg-slate-900 ${picked ? "border-teal-400" : "border-slate-800"} ${stage === "picture" ? "cursor-pointer hover:border-slate-500" : ""}`}
      // A 3D view is turned with the mouse, so only pictures are picked by a click. 3D: the number key or the button.
      onClick={stage === "picture" ? onClick : undefined}
    >
      <div style={{ height }} className="flex items-center justify-center">
        {body}
      </div>
      <div className="flex items-center gap-3 px-3 py-2 text-sm">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-700 font-mono text-xs font-semibold text-slate-100">{number}</span>
        {label && <span className="text-slate-400">{label}</span>}
        {picked && (
          <span className="flex items-center gap-1 text-teal-300">
            <CheckCircle2 size={14} /> Picked
          </span>
        )}
        {stage === "model" && job?.status === "done" && !picked && (
          <button
            type="button"
            onClick={onClick}
            className="ml-auto cursor-pointer rounded-md border border-slate-600 bg-transparent px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700"
          >
            Pick
          </button>
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full w-full items-center justify-center p-4 text-center text-sm text-slate-500">{children}</div>;
}
