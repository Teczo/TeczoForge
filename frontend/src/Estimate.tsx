import { useEffect, useState } from "react";
import { Clock } from "lucide-react";

// Time estimate (FRG-76): how long a list of jobs takes, from POST /api/estimate (backend/src/estimate.ts).
// Each preset's time comes from its last 20 finished jobs ("history"), else from preset.json ("preset"),
// else it is not known. With a preset that is not known, the total is "at least" that long.

// One row per preset, as POST /api/estimate answers it.
export type Estimate = {
  totalMs: number;
  perPreset: { presetId: string; name: string; count: number; eachMs: number | null; totalMs: number | null; source: "history" | "preset" | "unknown" }[];
  unknownPresets: string[];
};

// A length of time in plain words: "40 s", "12 min", "4 h 20 min".
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// The clock time on this PC, for example "02:40".
export function clockTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const SOURCE_LABELS: Record<Estimate["perPreset"][number]["source"], string> = {
  history: "From finished jobs",
  preset: "From preset.json",
  unknown: "Not known",
};

// Ask the backend for the estimate of these jobs. Loads again when the list changes.
// undefined while loading, a text when it did not work.
function useEstimate(items: { presetId: string; count: number }[]): Estimate | string | undefined {
  const [estimate, setEstimate] = useState<Estimate | string | undefined>(undefined);
  const key = JSON.stringify(items);
  useEffect(() => {
    let stopped = false;
    setEstimate(undefined);
    if (items.length === 0) return;
    fetch("/api/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: key })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (stopped) return;
        if (!body) setEstimate("Could not reach the backend.");
        else if (!response.ok) setEstimate(body.error ?? "Could not work out the time.");
        else setEstimate(body);
      })
      .catch(() => !stopped && setEstimate("Could not reach the backend."));
    return () => {
      stopped = true;
    };
  }, [key]);
  return estimate;
}

// The summary line, the hint, and a table per preset.
export default function EstimateView({ items, title = "Time estimate" }: { items: { presetId: string; count: number }[]; title?: string }) {
  const estimate = useEstimate(items);
  // Clock times move on: work the finish time out again every 30 seconds.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  let summary: string;
  if (estimate === undefined) summary = "Working out the time...";
  else if (typeof estimate === "string") summary = estimate;
  else {
    const atLeast = estimate.unknownPresets.length > 0;
    const finish = clockTime(new Date(Date.now() + estimate.totalMs));
    summary = `${atLeast ? "At least about" : "About"} ${formatDuration(estimate.totalMs)} · ends about ${finish}${atLeast ? " at the earliest" : ""}`;
  }

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-ink">
        <Clock size={16} className="text-ink-2" />
        {title}
      </div>
      <p className="mt-0 mb-1 text-sm text-ink-2">{summary}</p>
      {typeof estimate === "object" && estimate.unknownPresets.length > 0 && (
        <p className="mt-0 mb-2 text-xs text-warning">
          {estimate.unknownPresets.length === 1 ? "One preset has" : `${estimate.unknownPresets.length} presets have`} no known time. Run
          Time test to measure it.
        </p>
      )}
      {typeof estimate === "object" && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-frame text-xs text-ink-2">
              <tr>
                {["Preset", "Jobs", "Each", "Total", "Source"].map((head) => (
                  <th key={head} className="px-3 py-2 font-medium">
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {estimate.perPreset.map((row) => (
                <tr key={row.presetId} className="border-t border-line text-ink-2">
                  <td className="px-3 py-2">{row.name}</td>
                  <td className="px-3 py-2">{row.count}</td>
                  <td className="px-3 py-2">{row.eachMs === null ? "not known" : formatDuration(row.eachMs)}</td>
                  <td className="px-3 py-2">{row.totalMs === null ? "not known" : formatDuration(row.totalMs)}</td>
                  <td className={`px-3 py-2 text-xs ${row.source === "unknown" ? "text-warning" : "text-ink-2"}`}>{SOURCE_LABELS[row.source]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
