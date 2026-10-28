import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import BatchBar, { useActiveBatches } from "./BatchBar";
import EstimateView from "./Estimate";
import type { Project } from "./App";

// "Time test" (FRG-76, backend/src/timeTest.ts): a batch with one Text to Image picture, then one card
// per preset with a start image made from it. The finished jobs give every tested preset a time.
// Below the button: the time of one job of each preset, and where that time comes from.

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

export default function TimeTest({ presetIds, project }: { presetIds: string[]; project?: Project | null }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [showTimes, setShowTimes] = useState(false);
  const testBatches = useActiveBatches().filter((batch) => batch.owner.type === "time-test");
  // Load the times again when a Time test ends, so the new history shows.
  const [round, setRound] = useState(0);
  const testing = testBatches.length > 0;
  useEffect(() => {
    if (!testing) setRound((value) => value + 1);
  }, [testing]);

  async function start() {
    if (!window.confirm("Run Time test? It makes 1 picture, then one job for each preset that takes a picture (3D, edit, video). This takes a few minutes.")) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/time-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project ? { projectId: project.id } : {}),
      });
      const body = await response.json().catch(() => null);
      if (!body) setMessage({ text: NO_BACKEND, error: true });
      else if (!response.ok) setMessage({ text: body.error ?? "The Time test could not start.", error: true });
      else setMessage({ text: "Time test started. It runs as a batch; see its bar below.", error: false });
    } catch {
      setMessage({ text: NO_BACKEND, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={start}
          disabled={busy || testing}
          title="Measure how long each preset takes"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-700/60 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Timer size={14} /> {testing ? "Time test running" : "Time test"}
        </button>
        <button
          type="button"
          onClick={() => setShowTimes(!showTimes)}
          className="cursor-pointer border-0 bg-transparent p-0 text-xs text-slate-400 underline hover:text-slate-200"
        >
          {showTimes ? "Hide times" : "Show times"}
        </button>
      </div>
      {message && <p className={`mt-2 mb-0 text-xs ${message.error ? "text-red-300" : "text-emerald-300"}`}>{message.text}</p>}
      {testBatches.map((batch) => (
        <div key={batch.id} className="mt-3">
          <BatchBar batchId={batch.id} />
        </div>
      ))}
      {showTimes && presetIds.length > 0 && (
        <div className="mt-3">
          <EstimateView key={round} title="One job of each preset" items={presetIds.map((presetId) => ({ presetId, count: 1 }))} />
        </div>
      )}
    </div>
  );
}
