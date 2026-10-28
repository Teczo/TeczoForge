import { Fragment, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, FileUp, Package, X } from "lucide-react";
import EstimateView from "./Estimate";

// The Packs section (FRG-78): the list of packs as tiles, "Import pack file (.md)" with a preview
// of the plan and the time estimate before anything is saved, and the detail page of one pack.
// The file format is in docs/pack-format.md. The backend checks it (backend/src/packFile.ts)
// and saves it (backend/src/packs.ts). Nothing runs here: that is FRG-80.

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";

// The biggest pack file the backend reads (MAX_GAME_FILE_BYTES in backend/src/gameFile.ts).
const MAX_FILE_BYTES = 1024 * 1024;

type ItemKind = "model" | "picture" | "skip";
type ItemStatus = "planned" | "pictures" | "pick_picture" | "models" | "pick_model" | "done" | "skip" | "failed";
type StatusCounts = Record<ItemStatus, number>;
type RealSize = { height_m?: number; length_m?: number; width_m?: number } | null;

// One pack, as GET /api/packs returns it. Only the parts the page uses.
type PackTile = { id: string; name: string; code: string; engine: string; counts: StatusCounts };

// The checked plan, as POST /api/packs/check returns it. Only the parts the page uses.
type PlannedItem = {
  id: string;
  name: string;
  group: string;
  kind: ItemKind;
  edit_from: string | null;
  pictures: number;
  model_presets: string[]; // Short names, for example "trellis2".
  model_seeds: number;
  real_size: RealSize;
  notes: string;
};
type PackPlan = {
  pack: { code: string; name: string; engine: string; style: string };
  items: PlannedItem[];
  jobTotals: { presetId: string; count: number }[];
};
type CheckAnswer = { ok: true; plan: PackPlan } | { ok: false; errors: string[] };

// One saved item, as GET /api/packs/<id> returns it.
type PackItem = {
  id: string;
  itemId: string;
  name: string;
  group: string;
  kind: ItemKind;
  editFrom: string | null;
  pictures: number;
  modelPresetIds: string[]; // Full preset ids, for example "image-to-3d-trellis2".
  modelSeeds: number;
  realSize: RealSize;
  notes: string;
  status: ItemStatus;
};
type PackDetailAnswer = { pack: PackTile & { style: string; fileName: string | null }; items: PackItem[] };

const KINDS: ItemKind[] = ["model", "picture", "skip"];
const KIND_LABELS: Record<ItemKind, string> = { model: "3D model", picture: "Picture", skip: "Made outside" };

// The 3D presets by short name (in the file) and by preset id (saved items).
const MODEL_LABELS: Record<string, string> = {
  trellis2: "TRELLIS.2",
  pixal3d: "Pixal3D",
  "image-to-3d-trellis2": "TRELLIS.2",
  "image-to-3d-pixal3d": "Pixal3D",
};

const STATUS_STYLES: Record<ItemStatus, { label: string; className: string }> = {
  planned: { label: "Planned", className: "bg-slate-700/60 text-slate-300" },
  pictures: { label: "Making pictures", className: "bg-sky-500/15 text-sky-300" },
  pick_picture: { label: "Pick a picture", className: "bg-amber-500/15 text-amber-300" },
  models: { label: "Making 3D", className: "bg-sky-500/15 text-sky-300" },
  pick_model: { label: "Pick a model", className: "bg-amber-500/15 text-amber-300" },
  done: { label: "Done", className: "bg-emerald-500/15 text-emerald-300" },
  skip: { label: "Made outside", className: "bg-slate-700/40 text-slate-500" },
  failed: { label: "Failed", className: "bg-red-500/15 text-red-300" },
};

// The file chosen with "Import pack file (.md)", read in the browser.
type ChosenFile = { fileName: string; text: string } | { fileName: string; error: string };

export default function PacksPage({ packId }: { packId: string | null }) {
  return packId ? <PackDetail id={packId} /> : <PacksList />;
}

// ---- The list of packs, and the import ----

function PacksList() {
  const [packs, setPacks] = useState<PackTile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ChosenFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch("/api/packs");
        const body = await response.json().catch(() => null);
        if (!body) setError(NO_BACKEND);
        else if (!response.ok) setError(body.error ?? "Could not load the packs.");
        else setPacks(body.packs);
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
        <h1 className="m-0 text-2xl font-semibold text-slate-100">Packs</h1>
        <button
          type="button"
          onClick={chooseFile}
          className="flex cursor-pointer items-center gap-2 rounded-xl border-0 bg-teal-600/90 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-teal-900/20 transition-colors hover:bg-teal-500"
        >
          <FileUp size={16} />
          Import pack file (.md)
        </button>
        <input ref={fileInputRef} type="file" accept=".md,text/markdown" onChange={onFileChosen} className="hidden" />
      </div>

      {/* MongoDB offline: the backend's message. Import still checks a file, but cannot save it. */}
      {error && <p className="message warning">{error}</p>}
      {!packs && !error && <p className="text-sm text-slate-500">Loading the packs...</p>}
      {packs && packs.length === 0 && <p className="text-sm text-slate-400">No packs yet. Import a pack file to start one.</p>}

      {packs && packs.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-5">
          {packs.map((pack) => (
            <Tile key={pack.id} pack={pack} />
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
            window.location.hash = `#/packs/${id}`;
          }}
        />
      )}
    </main>
  );
}

// "12 of 42 done". Items made outside TeczoForge (skip) are not counted: "· 3 made outside".
function doneText(counts: StatusCounts): string {
  const all = Object.values(counts).reduce((sum, count) => sum + count, 0) - counts.skip;
  const text = `${counts.done} of ${all} done`;
  return counts.skip > 0 ? `${text} · ${counts.skip} made outside` : text;
}

function Tile({ pack }: { pack: PackTile }) {
  return (
    <a
      href={`#/packs/${pack.id}`}
      title={`Open "${pack.name}"`}
      className="block overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-800/60 no-underline transition-colors hover:border-slate-600"
    >
      <div className="flex aspect-video items-center justify-center bg-slate-900/60">
        <Package size={40} className="text-slate-600" />
      </div>
      <div className="px-4 pt-3 pb-4">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-slate-100">{pack.name}</span>
          <CodeChip code={pack.code} />
        </div>
        <div className="mt-2 text-xs text-slate-400">{doneText(pack.counts)}</div>
        <div className="mt-1 text-xs text-slate-500">{pack.engine === "unreal" ? "For Unreal" : "No engine"}</div>
      </div>
    </a>
  );
}

function CodeChip({ code }: { code: string }) {
  return <span className="shrink-0 rounded-md bg-slate-700/70 px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-300">{code}</span>;
}

// ---- The preview of an import ----

type ImportPreviewProps = {
  chosen: ChosenFile;
  onClose: () => void;
  onChooseAnother: () => void;
  onCreated: (packId: string) => void;
};

// Shows the checked file before anything is saved. With errors: the list, and no Create button.
// When it is correct: counts per kind and per group, the item table, the time estimate, and "Create pack".
function ImportPreview({ chosen, onClose, onChooseAnother, onCreated }: ImportPreviewProps) {
  const [answer, setAnswer] = useState<CheckAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  // Check the file. It needs only the backend, not MongoDB.
  useEffect(() => {
    setAnswer(null);
    setProblem(null);
    setSaveErrors(null);
    if ("error" in chosen) return;
    async function check(text: string) {
      try {
        const response = await fetch("/api/packs/check", {
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
    check(chosen.text);
  }, [chosen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function createPack() {
    if ("error" in chosen) return;
    setSaving(true);
    setSaveErrors(null);
    try {
      const response = await fetch("/api/packs/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: chosen.fileName, text: chosen.text }),
      });
      const body = await response.json().catch(() => null);
      if (!body) setSaveErrors([NO_BACKEND]);
      else if (response.ok && body.ok) onCreated(body.pack.id);
      else setSaveErrors(body.errors ?? [body.error ?? "Could not save the pack."]);
    } catch {
      setSaveErrors([NO_BACKEND]);
    } finally {
      setSaving(false);
    }
  }

  const error = "error" in chosen ? chosen.error : problem;
  const plan = answer?.ok ? answer.plan : null;
  const rows = plan ? plan.items.map(plannedRow) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-10" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} className="w-full max-w-5xl rounded-2xl border border-slate-700 bg-slate-800 p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="m-0 text-lg font-semibold text-slate-100">Import pack file</h2>
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
              The file is correct. Nothing is saved until you press Create pack.
            </div>
            <div className="mb-5 rounded-xl border border-slate-700/60 bg-slate-900/40 p-4">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-slate-100">{plan.pack.name}</span>
                <CodeChip code={plan.pack.code} />
                <span className="text-xs text-slate-500">{plan.pack.engine === "unreal" ? "For Unreal" : "No engine"}</span>
              </div>
              {plan.pack.style && <p className="mt-2 mb-0 text-sm text-slate-400">Style added to every prompt: {plan.pack.style}</p>}
            </div>
            <Counts rows={rows} />
            <EstimateView items={plan.jobTotals} />
            <ItemTable rows={rows} showStatus={false} />
          </>
        )}

        {saveErrors && <ErrorList title="The pack was not saved." errors={saveErrors} />}

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
              onClick={createPack}
              disabled={saving}
              className="cursor-pointer rounded-lg border-0 bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:cursor-wait disabled:opacity-50"
            >
              {saving ? "Creating..." : "Create pack"}
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

// ---- The item table (preview and detail page) ----

// One row of the item table, from a checked item (preview) or a saved item (detail page).
type Row = {
  key: string;
  itemId: string;
  name: string;
  group: string;
  kind: ItemKind;
  editFrom: string | null;
  pictures: number;
  models: string[]; // 3D preset labels.
  modelSeeds: number;
  realSize: RealSize;
  notes: string;
  status?: ItemStatus;
};

function plannedRow(item: PlannedItem): Row {
  return {
    key: item.id,
    itemId: item.id,
    name: item.name,
    group: item.group,
    kind: item.kind,
    editFrom: item.edit_from,
    pictures: item.pictures,
    models: item.model_presets.map((name) => MODEL_LABELS[name] ?? name),
    modelSeeds: item.model_seeds,
    realSize: item.real_size,
    notes: item.notes,
  };
}

function savedRow(item: PackItem): Row {
  return {
    key: item.id,
    itemId: item.itemId,
    name: item.name,
    group: item.group,
    kind: item.kind,
    editFrom: item.editFrom,
    pictures: item.pictures,
    models: item.modelPresetIds.map((id) => MODEL_LABELS[id] ?? id),
    modelSeeds: item.modelSeeds,
    realSize: item.realSize,
    notes: item.notes,
    status: item.status,
  };
}

// The groups in the order they first appear in the file.
function groupsOf(rows: Row[]): string[] {
  return [...new Set(rows.map((row) => row.group))];
}

// How many items of each kind, and in each group.
function Counts({ rows }: { rows: Row[] }) {
  const chip = (label: string, count: number) => (
    <span key={label} className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-1.5 text-xs text-slate-300">
      {count} {label}
    </span>
  );
  return (
    <div className="mb-5 space-y-2">
      <div className="flex flex-wrap gap-2">
        {KINDS.map((kind) => {
          const count = rows.filter((row) => row.kind === kind).length;
          return count > 0 ? chip(KIND_LABELS[kind].toLowerCase(), count) : null;
        })}
      </div>
      <div className="flex flex-wrap gap-2">{groupsOf(rows).map((group) => chip(group, rows.filter((row) => row.group === group).length))}</div>
    </div>
  );
}

// "h 12 m · w 0.45 m"
function realSizeText(realSize: RealSize): string {
  if (!realSize) return "-";
  const parts: string[] = [];
  if (realSize.height_m !== undefined) parts.push(`h ${realSize.height_m} m`);
  if (realSize.length_m !== undefined) parts.push(`l ${realSize.length_m} m`);
  if (realSize.width_m !== undefined) parts.push(`w ${realSize.width_m} m`);
  return parts.join(" · ") || "-";
}

// "4 (TRELLIS.2 ×2, Pixal3D ×2)", or "-" for items with no 3D step.
function modelRunsText(row: Row): string {
  if (row.models.length === 0) return "-";
  return `${row.models.length * row.modelSeeds} (${row.models.map((label) => `${label} ×${row.modelSeeds}`).join(", ")})`;
}

// The items grouped by group. Skip items are grey with their notes. showStatus: the detail page.
function ItemTable({ rows, showStatus }: { rows: Row[]; showStatus: boolean }) {
  const head = ["Id", "Name", "Kind", "Pictures", "3D runs", "Real size", "Notes", ...(showStatus ? ["Status"] : [])];
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-700/60">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-slate-900/50 text-xs text-slate-400">
          <tr>
            {head.map((label) => (
              <th key={label} className="px-3 py-2 font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groupsOf(rows).map((group) => (
            <Fragment key={group}>
              <tr className="border-t border-slate-700/50 bg-slate-900/30">
                <td colSpan={head.length} className="px-3 py-1.5 text-xs font-semibold text-slate-300">
                  {group}/
                </td>
              </tr>
              {rows
                .filter((row) => row.group === group)
                .map((row) => {
                  const skip = row.kind === "skip";
                  return (
                    <tr key={row.key} className={`border-t border-slate-700/50 align-top ${skip ? "text-slate-500" : "text-slate-300"}`}>
                      <Cell mono>{row.itemId}</Cell>
                      <Cell>{row.name}</Cell>
                      <Cell>
                        {KIND_LABELS[row.kind]}
                        {row.editFrom && <div className="text-xs text-slate-500">edit of {row.editFrom}</div>}
                      </Cell>
                      <Cell>{skip ? "-" : row.pictures}</Cell>
                      <Cell>{modelRunsText(row)}</Cell>
                      <Cell>{realSizeText(row.realSize)}</Cell>
                      <Cell>
                        {skip && <div className="text-xs italic">made outside TeczoForge</div>}
                        {row.notes || (skip ? "" : "-")}
                      </Cell>
                      {showStatus && row.status && (
                        <Cell>
                          <StatusBadge status={row.status} />
                        </Cell>
                      )}
                    </tr>
                  );
                })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return <td className={`px-3 py-2 ${mono ? "font-mono text-xs break-all" : ""}`}>{children}</td>;
}

function StatusBadge({ status }: { status: ItemStatus }) {
  const style = STATUS_STYLES[status];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${style.className}`}>{style.label}</span>;
}

// ---- The detail page of one pack ----

function PackDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<PackDetailAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    async function load() {
      try {
        const response = await fetch(`/api/packs/${encodeURIComponent(id)}`);
        const body = await response.json().catch(() => null);
        if (!body) setError(NO_BACKEND);
        else if (!response.ok) setError(body.error ?? "Could not load the pack.");
        else setDetail(body);
      } catch {
        setError(NO_BACKEND);
      }
    }
    load();
  }, [id]);

  const counts = Object.fromEntries(Object.keys(STATUS_STYLES).map((status) => [status, 0])) as StatusCounts;
  for (const item of detail?.items ?? []) counts[item.status] += 1;

  return (
    <main className="mx-auto w-full max-w-6xl px-8 pt-2 pb-12">
      <a href="#/packs" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 no-underline hover:text-slate-200">
        <ArrowLeft size={16} />
        Packs
      </a>

      {error && <p className="message warning">{error}</p>}
      {!detail && !error && <p className="text-sm text-slate-500">Loading the pack...</p>}

      {detail && (
        <>
          <div className="mb-6">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="m-0 text-2xl font-semibold text-slate-100">{detail.pack.name}</h1>
              <CodeChip code={detail.pack.code} />
              <span className="text-sm text-slate-500">{detail.pack.engine === "unreal" ? "For Unreal" : "No engine"}</span>
            </div>
            {detail.pack.style && <p className="mt-2 mb-0 max-w-3xl text-sm text-slate-400">Style: {detail.pack.style}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-400">{doneText(counts)}</span>
              {(Object.keys(STATUS_STYLES) as ItemStatus[]).map((status) =>
                counts[status] > 0 ? (
                  <span key={status} className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[status].className}`}>
                    {counts[status]} {STATUS_STYLES[status].label.toLowerCase()}
                  </span>
                ) : null,
              )}
            </div>
          </div>
          <ItemTable rows={detail.items.map(savedRow)} showStatus />
        </>
      )}
    </main>
  );
}
