import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, FileUp, Gamepad2, Hand, X } from "lucide-react";

// The Games section (FRG-67): the list of games as tiles, "Import game design (.md)" with a preview
// of the plan before anything is saved, and the detail page of one game with its assets.
// The file format is in docs/game-design-format.md. The backend checks it (backend/src/gameFile.ts)
// and saves it (backend/src/games.ts). Nothing is generated here: that is FRG-68.

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

// How often the game page loads the game again while something is being made (FRG-68).
const POLL_MS = 3000;

// The biggest design file the backend reads (MAX_GAME_FILE_BYTES in backend/src/gameFile.ts).
const MAX_FILE_BYTES = 1024 * 1024;

type AssetStatus = "planned" | "generating" | "review" | "approved" | "external";
type StatusCounts = Record<AssetStatus, number>;

// One game, as GET /api/games returns it. Only the parts the page uses.
type GameTile = { id: string; name: string; code: string; dimension: string; pipeline: string; counts: StatusCounts };

// The checked plan, as POST /api/games/check returns it. Only the parts the page uses.
type PlanStep = { preset: string; prompt: string };
type PlannedAsset = { id: string; type: string; use: string; source: "forge" | "external"; needs: string[]; steps: PlanStep[] };
type GamePlan = {
  game: { code: string; name: string; dimension: string; pipeline: string; style: string; palette: string[] };
  concept: PlannedAsset;
  assets: PlannedAsset[];
};
type CheckAnswer = { ok: true; plan: GamePlan } | { ok: false; errors: string[] };

// One game with its assets, as GET /api/games/<id> returns it.
type GameAsset = {
  id: string;
  assetId: string;
  type: string;
  use: string;
  needs: string[];
  source: "forge" | "external";
  status: AssetStatus;
  removed: boolean;
  steps: { presetId: string; jobIds: string[]; approvedJobId: string | null }[];
};
type GameDetailAnswer = {
  game: GameTile & { style: string; palette: string[]; fileName: string | null };
  assets: GameAsset[];
};

// The average job time per preset (GET /api/games/preset-times). "offline": the times could not be loaded.
type PresetTimes = Record<string, { averageMs: number; jobs: number }> | "offline";

// The asset types in the order of the format doc.
const TYPES = ["model", "texture", "sprite", "background", "ui", "icon", "music", "sfx"];

const NEED_LABELS: Record<string, string> = {
  rigging: "Rigging",
  animation: "Animation",
  transparent_bg: "Transparent background",
  tiling: "Tiling",
};

const STATUS_STYLES: Record<AssetStatus, { label: string; className: string }> = {
  planned: { label: "Planned", className: "bg-slate-700/60 text-slate-300" },
  generating: { label: "Generating", className: "bg-sky-500/15 text-sky-300" },
  review: { label: "Review", className: "bg-amber-500/15 text-amber-300" },
  approved: { label: "Approved", className: "bg-emerald-500/15 text-emerald-300" },
  external: { label: "External", className: "bg-violet-500/15 text-violet-300" },
};

// The file chosen with "Import game design (.md)", read in the browser.
type ChosenFile = { fileName: string; text: string } | { fileName: string; error: string };

export default function GamesPage({ gameId }: { gameId: string | null }) {
  return gameId ? <GameDetail id={gameId} /> : <GamesList />;
}

// ---- The list of games, and the import ----

function GamesList() {
  const [games, setGames] = useState<GameTile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ChosenFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch("/api/games");
        const body = await response.json().catch(() => null);
        if (!body) setError(NO_BACKEND);
        else if (!response.ok) setError(body.error ?? "Could not load the games.");
        else setGames(body.games);
      } catch {
        setError(NO_BACKEND);
      }
    }
    load();
  }, []);

  function chooseFile() {
    fileInputRef.current?.click();
  }

  // Read the chosen file as text. The backend checks it (see ImportPreview).
  async function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // So choosing the same file again (after a fix) reads it again.
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setChosen({ fileName: file.name, error: "This file is too big. The limit is 1 MB." });
      return;
    }
    try {
      setChosen({ fileName: file.name, text: await file.text() });
    } catch {
      setChosen({ fileName: file.name, error: "Could not read this file." });
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-8 pt-2 pb-12">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="m-0 text-2xl font-semibold text-slate-100">Games</h1>
        <button
          type="button"
          onClick={chooseFile}
          className="flex cursor-pointer items-center gap-2 rounded-xl border-0 bg-teal-600/90 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-teal-900/20 transition-colors hover:bg-teal-500"
        >
          <FileUp size={16} />
          Import game design (.md)
        </button>
        <input ref={fileInputRef} type="file" accept=".md,text/markdown" onChange={onFileChosen} className="hidden" />
      </div>

      {/* MongoDB offline: the backend's message. Import still checks a file, but cannot save it. */}
      {error && <p className="message warning">{error}</p>}
      {!games && !error && <p className="text-sm text-slate-500">Loading the games...</p>}
      {games && games.length === 0 && (
        <p className="text-sm text-slate-400">No games yet. Import a game design file to start one.</p>
      )}

      {games && games.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-5">
          {games.map((game) => (
            <Tile key={game.id} game={game} />
          ))}
        </div>
      )}

      {chosen && (
        <ImportPreview
          chosen={chosen}
          onClose={() => setChosen(null)}
          onChooseAnother={chooseFile}
          onCreated={(id) => {
            setChosen(null);
            window.location.hash = `#/games/${id}`;
          }}
        />
      )}
    </main>
  );
}

// "12 of 24 approved". External assets are not made by TeczoForge, so they are counted apart.
function approvedText(counts: StatusCounts): string {
  const made = counts.planned + counts.generating + counts.review + counts.approved;
  const text = `${counts.approved} of ${made} approved`;
  return counts.external > 0 ? `${text} · ${counts.external} by hand` : text;
}

function Tile({ game }: { game: GameTile }) {
  return (
    <a
      href={`#/games/${game.id}`}
      title={`Open "${game.name}"`}
      className="block overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-800/60 no-underline transition-colors hover:border-slate-600"
    >
      <div className="flex aspect-video items-center justify-center bg-slate-900/60">
        <Gamepad2 size={40} className="text-slate-600" />
      </div>
      <div className="px-4 pt-3 pb-4">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-slate-100">{game.name}</span>
          <CodeChip code={game.code} />
        </div>
        <div className="mt-2 text-xs text-slate-400">{approvedText(game.counts)}</div>
        <div className="mt-1 text-xs text-slate-500">
          {game.dimension} · {game.pipeline}
        </div>
      </div>
    </a>
  );
}

function CodeChip({ code }: { code: string }) {
  return (
    <span className="shrink-0 rounded-md bg-slate-700/70 px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-300">{code}</span>
  );
}

// ---- The preview of an import ----

type ImportPreviewProps = {
  chosen: ChosenFile;
  onClose: () => void;
  onChooseAnother: () => void;
  onCreated: (gameId: string) => void;
};

// Shows the checked file before anything is saved. With errors: the list, and no Create button.
// When it is correct: counts per type, the asset table, a time estimate, and "Create game".
function ImportPreview({ chosen, onClose, onChooseAnother, onCreated }: ImportPreviewProps) {
  const [answer, setAnswer] = useState<CheckAnswer | null>(null);
  const [times, setTimes] = useState<PresetTimes | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  // Check the file (needs only the backend), and load the job times (needs MongoDB; without it, all times are unknown).
  useEffect(() => {
    setAnswer(null);
    setProblem(null);
    setSaveErrors(null);
    if ("error" in chosen) return;
    async function check(text: string) {
      try {
        const response = await fetch("/api/games/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: chosen.fileName, text }),
        });
        const body = await response.json().catch(() => null);
        if (!body) setProblem(NO_BACKEND);
        else if (!response.ok) setProblem(body.error ?? "Could not check the file.");
        else setAnswer(body);
      } catch {
        setProblem(NO_BACKEND);
      }
    }
    async function loadTimes() {
      try {
        const response = await fetch("/api/games/preset-times");
        setTimes(response.ok ? (await response.json()).presets : "offline");
      } catch {
        setTimes("offline");
      }
    }
    check(chosen.text);
    loadTimes();
  }, [chosen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function createGame() {
    if ("error" in chosen) return;
    setSaving(true);
    setSaveErrors(null);
    try {
      const response = await fetch("/api/games/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: chosen.fileName, text: chosen.text }),
      });
      const body = await response.json().catch(() => null);
      if (!body) setSaveErrors([NO_BACKEND]);
      else if (response.ok && body.ok) onCreated(body.game.id);
      else setSaveErrors(body.errors ?? [body.error ?? "Could not save the game."]);
    } catch {
      setSaveErrors([NO_BACKEND]);
    } finally {
      setSaving(false);
    }
  }

  const error = "error" in chosen ? chosen.error : problem;
  const plan = answer?.ok ? answer.plan : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-10" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-4xl rounded-2xl border border-slate-700 bg-slate-800 p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="m-0 text-lg font-semibold text-slate-100">Import game design</h2>
            <div className="mt-1 truncate text-sm text-slate-400">{chosen.fileName}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="flex cursor-pointer items-center rounded-lg border-0 bg-transparent p-1.5 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
          >
            <X size={18} />
          </button>
        </div>

        {error && <p className="message error">{error}</p>}
        {!error && !answer && <p className="text-sm text-slate-500">Checking the file...</p>}

        {answer && !answer.ok && <ErrorList title="This file has problems. Fix them in the file, then import it again." errors={answer.errors} />}

        {plan && (
          <>
            <div className="mb-5 flex items-center gap-2 text-sm text-emerald-300">
              <CheckCircle2 size={16} />
              The file is correct. Nothing is saved until you press Create game.
            </div>
            <PlanSummary plan={plan} />
            <TypeCounts assets={plan.assets} />
            <TimeEstimate plan={plan} times={times} />
            <PreviewTable assets={plan.assets} />
          </>
        )}

        {saveErrors && <ErrorList title="The game was not saved." errors={saveErrors} />}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onChooseAnother}
            className="cursor-pointer rounded-lg border border-slate-600 bg-transparent px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
          >
            Choose another file
          </button>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-slate-600 bg-transparent px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
          >
            Cancel
          </button>
          {/* Only a correct file can be saved. */}
          {plan && (
            <button
              type="button"
              onClick={createGame}
              disabled={saving}
              className="cursor-pointer rounded-lg border-0 bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:cursor-wait disabled:opacity-50"
            >
              {saving ? "Creating..." : "Create game"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorList({ title, errors }: { title: string; errors: string[] }) {
  return (
    <div className="mb-4 rounded-xl border border-red-400/40 bg-red-400/5 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-red-300">
        <AlertTriangle size={16} />
        {title}
      </div>
      <ul className="m-0 space-y-1 pl-6 text-sm text-red-200">
        {errors.map((error, index) => (
          <li key={index}>{error}</li>
        ))}
      </ul>
    </div>
  );
}

function PlanSummary({ plan }: { plan: GamePlan }) {
  const { game } = plan;
  return (
    <div className="mb-5 rounded-xl border border-slate-700/60 bg-slate-900/40 p-4">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-slate-100">{game.name}</span>
        <CodeChip code={game.code} />
        <span className="text-xs text-slate-500">
          {game.dimension} · {game.pipeline}
        </span>
      </div>
      <p className="mt-2 mb-0 text-sm text-slate-400">{game.style}</p>
      <Palette colours={game.palette} />
    </div>
  );
}

function Palette({ colours }: { colours: string[] }) {
  if (colours.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {colours.map((colour) => (
        <span key={colour} title={colour} className="h-5 w-5 rounded-md border border-slate-600" style={{ backgroundColor: colour }} />
      ))}
    </div>
  );
}

function TypeCounts({ assets }: { assets: PlannedAsset[] }) {
  return (
    <div className="mb-5 flex flex-wrap gap-2">
      {TYPES.map((type) => {
        const count = assets.filter((asset) => asset.type === type).length;
        if (count === 0) return null;
        return (
          <span key={type} className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-1.5 text-xs text-slate-300">
            {count} {type}
          </span>
        );
      })}
      <span className="rounded-lg px-3 py-1.5 text-xs text-slate-500">+ concept art, made by TeczoForge</span>
    </div>
  );
}

// How long the generation will take: every step, plus the concept art, times the average time of
// finished jobs of that preset. A preset with no finished jobs has an unknown time.
function TimeEstimate({ plan, times }: { plan: GamePlan; times: PresetTimes | null }) {
  const stepsPerPreset = new Map<string, number>();
  for (const asset of [plan.concept, ...plan.assets]) {
    for (const step of asset.steps) stepsPerPreset.set(step.preset, (stepsPerPreset.get(step.preset) ?? 0) + 1);
  }
  const rows = [...stepsPerPreset].map(([preset, steps]) => {
    const average = times === null || times === "offline" ? undefined : times[preset]?.averageMs;
    return { preset, steps, average, total: average === undefined ? undefined : average * steps };
  });
  const knownTotal = rows.reduce((sum, row) => sum + (row.total ?? 0), 0);
  const unknownSteps = rows.filter((row) => row.total === undefined).reduce((sum, row) => sum + row.steps, 0);

  let summary: string;
  if (times === null) summary = "Working out the time...";
  else if (times === "offline") summary = "Unknown: the job times need MongoDB, which cannot be reached right now.";
  else if (unknownSteps === 0) summary = `About ${formatDuration(knownTotal)} of generation.`;
  else if (knownTotal === 0) summary = "Unknown: none of these presets has a finished job yet.";
  else summary = `At least ${formatDuration(knownTotal)}, plus ${unknownSteps} step${unknownSteps === 1 ? "" : "s"} with an unknown time.`;

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200">
        <Clock size={16} className="text-slate-400" />
        Time estimate
      </div>
      <p className="mt-0 mb-2 text-sm text-slate-400">{summary}</p>
      <Table head={["Preset", "Steps", "Average", "Total"]}>
        {rows.map((row) => (
          <tr key={row.preset} className="border-t border-slate-700/50">
            <Cell mono>{row.preset}</Cell>
            <Cell>{row.steps}</Cell>
            <Cell>{row.average === undefined ? "unknown" : formatDuration(row.average)}</Cell>
            <Cell>{row.total === undefined ? "unknown" : formatDuration(row.total)}</Cell>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function PreviewTable({ assets }: { assets: PlannedAsset[] }) {
  return (
    <Table head={["Id", "Type", "Use", "Needs"]}>
      {assets.map((asset) => (
        <tr key={asset.id} className="border-t border-slate-700/50 align-top">
          <Cell mono>{asset.id}</Cell>
          <Cell>{asset.type}</Cell>
          <Cell>{asset.use}</Cell>
          <Cell>
            <Needs needs={asset.needs} external={asset.source === "external"} />
          </Cell>
        </tr>
      ))}
    </Table>
  );
}

// ---- The detail page of one game ----

function GameDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<GameDetailAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(id)}`);
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not load the game.");
      else {
        setDetail(body);
        setError(null);
      }
    } catch {
      setError(NO_BACKEND);
    }
  }

  useEffect(() => {
    setDetail(null);
    setError(null);
    load();
  }, [id]);

  // While something is being made, load the game again every few seconds, so the statuses
  // (generating -> review) and the concept pictures show up by themselves (FRG-68).
  const generating = detail?.assets.some((asset) => !asset.removed && asset.status === "generating") ?? false;
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [generating, id]);

  // Removed assets (after a re-import, FRG-72) are not shown. The concept art (type "reference",
  // FRG-68) is shown in step 1, not in the table.
  const concept = detail?.assets.find((asset) => asset.type === "reference" && !asset.removed);
  const assets = detail?.assets.filter((asset) => !asset.removed && asset.type !== "reference") ?? [];
  const counts = Object.fromEntries(Object.keys(STATUS_STYLES).map((status) => [status, 0])) as StatusCounts;
  for (const asset of assets) counts[asset.status] += 1;

  return (
    <main className="mx-auto w-full max-w-6xl px-8 pt-2 pb-12">
      <a href="#/games" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 no-underline hover:text-slate-200">
        <ArrowLeft size={16} />
        Games
      </a>

      {error && <p className="message warning">{error}</p>}
      {!detail && !error && <p className="text-sm text-slate-500">Loading the game...</p>}

      {detail && (
        <>
          <div className="mb-6">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="m-0 text-2xl font-semibold text-slate-100">{detail.game.name}</h1>
              <CodeChip code={detail.game.code} />
              <span className="text-sm text-slate-500">
                {detail.game.dimension} · {detail.game.pipeline}
              </span>
            </div>
            <p className="mt-2 mb-0 max-w-3xl text-sm text-slate-400">{detail.game.style}</p>
            <Palette colours={detail.game.palette} />
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-400">{approvedText(counts)}</span>
              {(Object.keys(STATUS_STYLES) as AssetStatus[]).map((status) =>
                counts[status] > 0 ? (
                  <span key={status} className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[status].className}`}>
                    {counts[status]} {STATUS_STYLES[status].label.toLowerCase()}
                  </span>
                ) : null,
              )}
            </div>
          </div>

          <GameSteps gameId={detail.game.id} projectName={detail.game.name} concept={concept} assets={assets} onChanged={load} />

          <Table head={["Id", "Type", "Use", "Needs", "Status"]}>
            {assets.map((asset) => (
              <tr key={asset.id} className="border-t border-slate-700/50 align-top">
                <Cell mono>{asset.assetId}</Cell>
                <Cell>{asset.type}</Cell>
                <Cell>{asset.use}</Cell>
                <Cell>
                  <Needs needs={asset.needs} external={asset.source === "external"} />
                </Cell>
                <Cell>
                  <StatusBadge status={asset.status} />
                </Cell>
              </tr>
            ))}
          </Table>
        </>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: AssetStatus }) {
  const style = STATUS_STYLES[status];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${style.className}`}>{style.label}</span>;
}

// The needs of an asset, and the "to do by hand" note. TeczoForge does not do any of these:
// someone does them by hand after the export. An external asset is made by hand as a whole.
function Needs({ needs, external }: { needs: string[]; external: boolean }) {
  if (needs.length === 0 && !external) return <span className="text-slate-600">-</span>;
  return (
    <div className="space-y-1">
      {external && <HandNote>To do by hand: not made by TeczoForge</HandNote>}
      {needs.length > 0 && <HandNote>To do by hand: {needs.map((need) => NEED_LABELS[need] ?? need).join(", ")}</HandNote>}
    </div>
  );
}

function HandNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 text-xs text-amber-300/90">
      <Hand size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

// ---- Concept art first, then all asset cards (FRG-68) ----

// One concept job, as GET /api/jobs/<id> returns it. Only the parts the page uses.
type ConceptJob = { id: string; status: string; imageUrl: string | null; error: string | null };

// The answer of a step: what happened, and any problems.
type StepResult = { text: string; errors: string[] };

type GameStepsProps = {
  gameId: string;
  projectName: string;
  concept: GameAsset | undefined;
  assets: GameAsset[];
  onChanged: () => void; // Load the game again.
};

// The three steps on the game page:
// 1. "Make concept art": 3 pictures in the game's style. "Use this concept" on a finished one.
// 2. "Create all asset cards": only after a concept is chosen. One board card per planned asset.
// 3. "Generate all": runs every Ready card of this game. ComfyUI's own queue runs them.
function GameSteps({ gameId, projectName, concept, assets, onChanged }: GameStepsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<StepResult | null>(null);
  const [conceptJobs, setConceptJobs] = useState<ConceptJob[]>([]);
  // Goes up every few seconds while a concept picture is still being made, so it is loaded again.
  const [tick, setTick] = useState(0);

  // Load the concept jobs again each time the concept asset changes (the page reloads it while something runs).
  const conceptJobIds = concept?.steps[0]?.jobIds ?? [];
  const conceptKey = `${conceptJobIds.join(",")}|${concept?.status}`;
  useEffect(() => {
    if (conceptJobIds.length === 0) {
      setConceptJobs([]);
      return;
    }
    async function load() {
      const loaded = await Promise.all(
        conceptJobIds.map(async (jobId) => {
          try {
            const response = await fetch(`/api/jobs/${jobId}`);
            return response.ok ? ((await response.json()) as ConceptJob) : null;
          } catch {
            return null;
          }
        }),
      );
      setConceptJobs(loaded.filter((job): job is ConceptJob => job !== null));
    }
    load();
  }, [conceptKey, tick]);

  async function post(name: string, url: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(name);
    setResult(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const answer = await response.json().catch(() => null);
      if (!answer) {
        setResult({ text: "", errors: [NO_BACKEND] });
        return null;
      }
      if (!response.ok) {
        setResult({ text: "", errors: [answer.error ?? "Something went wrong."] });
        return null;
      }
      return answer;
    } catch {
      setResult({ text: "", errors: [NO_BACKEND] });
      return null;
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  async function makeConcept() {
    const answer = await post("concept", `/api/games/${gameId}/concept`);
    if (answer) setResult({ text: `Started ${answer.queued} concept picture(s).`, errors: answer.errors as string[] });
  }

  async function useConcept(jobId: string) {
    await post("choose", `/api/games/${gameId}/concept/choose`, { jobId });
  }

  async function createCards() {
    const answer = await post("cards", `/api/games/${gameId}/cards`);
    if (answer) {
      setResult({ text: `Made ${answer.created} card(s) on the Board, in the project "${projectName}".`, errors: answer.errors as string[] });
    }
  }

  async function generateAll() {
    const answer = await post("generate", `/api/games/${gameId}/generate`);
    if (answer) {
      const text =
        answer.queued === 0 ? "No Ready cards to start." : `Started ${answer.queued} card(s). ComfyUI runs them one after the other.`;
      setResult({ text, errors: answer.errors as string[] });
    }
  }

  const chosenJobId = concept?.steps[0]?.approvedJobId ?? null;
  const conceptChosen = concept?.status === "approved";
  const conceptRunning = conceptJobs.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!conceptRunning) return;
    const timer = setInterval(() => setTick((t) => t + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [conceptRunning]);
  const plannedCount = assets.filter((asset) => asset.status === "planned").length;
  const hasCards = assets.some((asset) => asset.steps[0]?.jobIds.length) || conceptJobs.some((job) => job.status === "draft");

  return (
    <div className="mb-6 space-y-3">
      <StepBox
        number={1}
        title="Make concept art"
        text="Three pictures in the game's style. Choose one before the asset cards are made."
        done={conceptChosen}
        action={
          <StepButton
            label={busy === "concept" ? "Starting..." : "Make concept art"}
            onClick={makeConcept}
            disabled={busy !== null || conceptChosen || conceptRunning}
          />
        }
      >
        {conceptJobs.length > 0 && (
          <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {conceptJobs.map((job) => (
              <ConceptTile
                key={job.id}
                job={job}
                chosen={job.id === chosenJobId}
                canChoose={!conceptChosen && busy === null}
                onChoose={() => useConcept(job.id)}
              />
            ))}
          </div>
        )}
      </StepBox>

      <StepBox
        number={2}
        title="Create all asset cards"
        text={
          conceptChosen
            ? `One board card per planned asset, in the Ready column. ${plannedCount} planned asset(s) left.`
            : "Choose a concept in step 1 first."
        }
        done={conceptChosen && plannedCount === 0}
        action={
          <StepButton
            label={busy === "cards" ? "Creating..." : "Create all asset cards"}
            onClick={createCards}
            disabled={busy !== null || !conceptChosen || plannedCount === 0}
          />
        }
      />

      <StepBox
        number={3}
        title="Generate all"
        text="Starts every Ready card of this game. Finished assets show Review."
        done={false}
        action={
          <StepButton label={busy === "generate" ? "Starting..." : "Generate all"} onClick={generateAll} disabled={busy !== null || !hasCards} />
        }
      />

      {result && (result.text || result.errors.length > 0) && (
        <div>
          {result.text && <p className="m-0 text-sm text-emerald-300">{result.text}</p>}
          {result.errors.length > 0 && <ErrorList title="Some steps did not work." errors={result.errors} />}
        </div>
      )}
    </div>
  );
}

type StepBoxProps = { number: number; title: string; text: string; done: boolean; action: ReactNode; children?: ReactNode };

function StepBox({ number, title, text, done, action, children }: StepBoxProps) {
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            done ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-700 text-slate-300"
          }`}
        >
          {done ? <CheckCircle2 size={16} /> : number}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-100">{title}</div>
          <div className="text-xs text-slate-400">{text}</div>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function StepButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="cursor-pointer rounded-lg border-0 bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

// One concept picture: waiting, being made, finished (with "Use this concept"), or back on the board after a failure.
function ConceptTile({ job, chosen, canChoose, onChoose }: { job: ConceptJob; chosen: boolean; canChoose: boolean; onChoose: () => void }) {
  return (
    <div className={`overflow-hidden rounded-lg border ${chosen ? "border-emerald-500/70 ring-2 ring-emerald-500/30" : "border-slate-700/60"}`}>
      <div className="flex aspect-square items-center justify-center bg-slate-900/60">
        {job.status === "done" && job.imageUrl ? (
          <img src={job.imageUrl} alt="Concept art" className="h-full w-full object-cover" />
        ) : (
          <span className="px-3 text-center text-xs text-slate-500">
            {job.status === "queued"
              ? "Waiting in ComfyUI's queue..."
              : job.status === "running"
                ? "Making..."
                : job.status === "draft"
                  ? `Back on the board: ${job.error ?? "it did not finish."}`
                  : "Not finished."}
          </span>
        )}
      </div>
      <div className="p-2">
        {chosen ? (
          <span className="flex items-center justify-center gap-1.5 py-1 text-xs font-medium text-emerald-300">
            <CheckCircle2 size={14} /> Chosen concept
          </span>
        ) : (
          <button
            type="button"
            onClick={onChoose}
            disabled={!canChoose || job.status !== "done"}
            className="w-full cursor-pointer rounded-md border border-slate-600 bg-transparent px-2 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Use this concept
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Small shared parts ----

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-700/60">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-slate-900/50">
          <tr>
            {head.map((title) => (
              <th key={title} className="px-3 py-2 text-xs font-semibold tracking-wider text-slate-400 uppercase">
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Cell({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return <td className={`px-3 py-2 text-slate-300 ${mono ? "font-mono text-xs break-all" : ""}`}>{children}</td>;
}

// "45 s", "12 min", "1 h 20 min".
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
