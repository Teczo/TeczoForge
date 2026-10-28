import { Fragment, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, FileText, FileUp, Package, RefreshCw, X } from "lucide-react";
import EstimateView from "./Estimate";
import BatchBar, { useActiveBatches } from "./BatchBar";
import Media, { outputKind } from "./Media";
import { ProgressView } from "./Generate";
import type { Progress } from "./Generate";
import PickScreen from "./PickScreen";

// The Packs section (FRG-78): the list of packs as tiles, "Import pack file (.md)" with a preview
// of the plan and the time estimate before anything is saved, and the detail page of one pack.
// "Import any document (.md or .txt)" (FRG-79): Claude turns an asset document into a pack file
// (backend/src/packConvert.ts), shown with the same preview and an editable copy of the pack file.
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
// The answer of POST /api/packs/convert (FRG-79): the made pack file, checked, with warnings.
type ConvertAnswer = { ok: boolean; packText: string; plan?: PackPlan; errors?: string[]; warnings: string[]; couldNotMap: string[] };

// One saved item, as GET /api/packs/<id> returns it. The pick screen uses it too (FRG-81).
export type PackItem = {
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
  // What has been made for it (FRG-80).
  pictureJobIds: string[];
  pickedPictureJobId: string | null;
  autoPicked: boolean;
  modelJobIds: string[];
  pickedModelJobId: string | null;
  error: string | null;
};
// One card of an item, as GET /api/packs/<id> returns it in "jobs" (FRG-80).
export type PackJob = {
  id: string;
  status: "draft" | "queued" | "running" | "done" | "failed" | "cancelled";
  imageUrl: string | null;
  outputKind: string | null;
  error: string | null;
  progress: Progress | null;
  presetId: string | null; // The 3D preset of a 3D result on the pick screen (FRG-81).
  seed: number | null; // null until the card runs.
};
type RunMode = "pictures_first" | "full_auto";
type PackDetailAnswer = {
  pack: PackTile & { style: string; fileName: string | null; runMode?: RunMode };
  items: PackItem[];
  jobs: Record<string, PackJob>;
};

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
  const [documentFile, setDocumentFile] = useState<ChosenFile | null>(null); // "Import any document" (FRG-79).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);

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

  // Read the chosen file as text: a pack file (see ImportPreview) or a document (see ConvertPreview).
  async function readChosen(event: ChangeEvent<HTMLInputElement>, show: (file: ChosenFile) => void) {
    const file = event.target.files?.[0];
    event.target.value = ""; // So choosing the same file again (after a fix) reads it again.
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      show({ fileName: file.name, error: "This file is too big. The limit is 1 MB." });
      return;
    }
    try {
      show({ fileName: file.name, text: await file.text() });
    } catch {
      show({ fileName: file.name, error: "Could not read this file." });
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-8 pt-2 pb-12">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="m-0 text-2xl font-semibold text-slate-100">Packs</h1>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => documentInputRef.current?.click()}
            className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700"
          >
            <FileText size={16} />
            Import any document (.md or .txt)
          </button>
          <button
            type="button"
            onClick={chooseFile}
            className="flex cursor-pointer items-center gap-2 rounded-xl border-0 bg-teal-600/90 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-teal-900/20 transition-colors hover:bg-teal-500"
          >
            <FileUp size={16} />
            Import pack file (.md)
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept=".md,text/markdown" onChange={(event) => readChosen(event, setChosen)} className="hidden" />
        <input
          ref={documentInputRef}
          type="file"
          accept=".md,.txt,text/markdown,text/plain"
          onChange={(event) => readChosen(event, setDocumentFile)}
          className="hidden"
        />
      </div>
      <p className="mt-0 mb-5 text-xs text-slate-500">
        Import any document: the document is sent to the Claude API to read it. Generation stays on this PC.
      </p>

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

      {documentFile && (
        <ConvertPreview
          chosen={documentFile}
          onClose={() => setDocumentFile(null)}
          onCreated={(id) => {
            setDocumentFile(null);
            window.location.hash = `#/packs/${id}`;
          }}
        />
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

        {plan && <PlanView plan={plan} />}

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

// A correct plan: the pack, counts per kind and group, the time estimate (FRG-76) and the item table.
function PlanView({ plan }: { plan: PackPlan }) {
  const rows = plan.items.map(plannedRow);
  return (
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
  );
}

// ---- "Import any document" (FRG-79) ----

// "aquatwin-assets.md" -> "aquatwin-assets.pack.md"
function packFileName(documentName: string): string {
  return `${documentName.replace(/\.(md|txt)$/i, "")}.pack.md`;
}

type ConvertPreviewProps = { chosen: ChosenFile; onClose: () => void; onCreated: (packId: string) => void };

// Claude makes the pack file from the document (POST /api/packs/convert). Then: the warnings, the
// "Could not map" list, the pack file in a text box that can be edited, "Check again", "Download .pack.md",
// and the same preview as a pack file import. "Create pack" saves the checked text, with the document's name.
function ConvertPreview({ chosen, onClose, onCreated }: ConvertPreviewProps) {
  const [converted, setConverted] = useState<ConvertAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [packText, setPackText] = useState("");
  // The last check, and the text it was for. Create pack only saves text that was checked as it is now.
  const [check, setCheck] = useState<{ text: string; answer: CheckAnswer } | null>(null);
  const [checking, setChecking] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setConverted(null);
    setProblem(null);
    setCheck(null);
    if ("error" in chosen) return;
    let stopped = false;
    async function convert(text: string) {
      try {
        const response = await fetch("/api/packs/convert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: chosen.fileName, text }),
        });
        const body = await response.json().catch(() => null);
        if (stopped) return;
        if (!body) setProblem(NO_BACKEND);
        else if (!response.ok) setProblem(body.error ?? "Could not make a pack file from this document.");
        else {
          const answer = body as ConvertAnswer;
          setConverted(answer);
          setPackText(answer.packText);
          setCheck({ text: answer.packText, answer: answer.ok && answer.plan ? { ok: true, plan: answer.plan } : { ok: false, errors: answer.errors ?? [] } });
        }
      } catch {
        if (!stopped) setProblem(NO_BACKEND);
      }
    }
    convert(chosen.text);
    return () => {
      stopped = true;
    };
  }, [chosen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // "Check again": the pack file check (FRG-77) on the edited text.
  async function checkAgain() {
    setChecking(true);
    setSaveErrors(null);
    const text = packText;
    try {
      const response = await fetch("/api/packs/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: packFileName(chosen.fileName), text }),
      });
      const body = await response.json().catch(() => null);
      if (!body) setSaveErrors([NO_BACKEND]);
      else if (!response.ok) setSaveErrors([body.error ?? "Could not check the pack file."]);
      else setCheck({ text, answer: body });
    } catch {
      setSaveErrors([NO_BACKEND]);
    } finally {
      setChecking(false);
    }
  }

  // Save the pack file on this PC. It never leaves the browser.
  function download() {
    const url = URL.createObjectURL(new Blob([packText], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = packFileName(chosen.fileName);
    link.click();
    URL.revokeObjectURL(url);
  }

  async function createPack() {
    setSaving(true);
    setSaveErrors(null);
    try {
      const response = await fetch("/api/packs/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: packFileName(chosen.fileName), text: packText, sourceDocName: chosen.fileName }),
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
  const upToDate = check !== null && check.text === packText;
  const plan = upToDate && check.answer.ok ? check.answer.plan : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-10" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} className="w-full max-w-5xl rounded-2xl border border-slate-700 bg-slate-800 p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="m-0 text-lg font-semibold text-slate-100">Make a pack from a document</h2>
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
        {!error && !converted && (
          <p className="text-sm text-slate-400">Claude is reading the document and writing the pack file. A long document can take a few minutes...</p>
        )}

        {converted && (
          <>
            {converted.warnings.length > 0 && (
              <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-400/5 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-300">
                  <AlertTriangle size={16} />
                  These prompts are not in the document word for word. Compare them before you create the pack.
                </div>
                <ul className="m-0 space-y-1 pl-6 text-sm text-amber-200">
                  {converted.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mb-4 rounded-xl border border-slate-700/60 bg-slate-900/40 p-4 text-sm">
              <div className="mb-1 font-medium text-slate-200">Could not map</div>
              {converted.couldNotMap.length === 0 ? (
                <div className="text-slate-400">Nothing. Claude put everything from the document into the pack file.</div>
              ) : (
                <ul className="m-0 space-y-1 pl-6 text-slate-300">
                  {converted.couldNotMap.map((entry, index) => (
                    <li key={index}>{entry}</li>
                  ))}
                </ul>
              )}
            </div>

            <label className="mb-2 block text-sm font-medium text-slate-200" htmlFor="pack-text">
              The pack file (you can edit it)
            </label>
            <textarea
              id="pack-text"
              value={packText}
              onChange={(event) => setPackText(event.target.value)}
              spellCheck={false}
              className="mb-2 h-72 w-full resize-y rounded-xl border border-slate-700 bg-slate-950/60 p-3 font-mono text-xs text-slate-200"
            />
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={checkAgain}
                disabled={checking}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-600 bg-transparent px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700 disabled:cursor-wait disabled:opacity-50"
              >
                <RefreshCw size={14} /> {checking ? "Checking..." : "Check again"}
              </button>
              <button
                type="button"
                onClick={download}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-600 bg-transparent px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
              >
                <Download size={14} /> Download .pack.md
              </button>
              {!upToDate && <span className="text-xs text-amber-300">You changed the pack file. Press Check again before you create the pack.</span>}
            </div>

            {upToDate && !check.answer.ok && (
              <ErrorList title="The pack file still has problems. Fix them in the text above, then press Check again." errors={check.answer.errors} />
            )}
            {plan && <PlanView plan={plan} />}
          </>
        )}

        {saveErrors && <ErrorList title="The pack was not saved." errors={saveErrors} />}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-slate-600 bg-transparent px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
          >
            Cancel
          </button>
          {/* Only text that was checked as it is now, and is correct, can be saved. */}
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
  extra?: ReactNode; // Shown in a row under the item: its pictures and 3D results (FRG-80).
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
                    <Fragment key={row.key}>
                      <tr className={`border-t border-slate-700/50 align-top ${skip ? "text-slate-500" : "text-slate-300"}`}>
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
                      {row.extra && (
                        <tr>
                          <td colSpan={head.length} className="px-3 pb-4">
                            {row.extra}
                          </td>
                        </tr>
                      )}
                    </Fragment>
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

// How often the pack page loads again (FRG-80), so new pictures and statuses show up by themselves.
const POLL_MS = 3000;

// The jobs a list of items makes, per preset, for the time estimate (FRG-76).
type JobItem = { presetId: string; count: number };
function addJobs(totals: Map<string, number>, presetId: string, count: number) {
  if (count > 0) totals.set(presetId, (totals.get(presetId) ?? 0) + count);
}
function jobList(totals: Map<string, number>): JobItem[] {
  return [...totals].map(([presetId, count]) => ({ presetId, count }));
}

// Phase 1 of the planned items (their pictures and edits), and in full auto also their 3D models.
function phaseOneJobs(items: PackItem[], mode: RunMode): JobItem[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    if (item.status !== "planned" || item.kind === "skip") continue;
    addJobs(totals, item.editFrom ? "image-edit-klein" : "text-to-image-basic", item.pictures);
    if (mode === "full_auto") for (const presetId of item.modelPresetIds) addJobs(totals, presetId, item.modelSeeds);
  }
  return jobList(totals);
}

// Model items with a picked picture and no 3D cards yet: phase 2 is for them.
function readyForModels(items: PackItem[]): PackItem[] {
  return items.filter((item) => item.kind === "model" && item.status === "pick_picture" && item.pickedPictureJobId && item.modelJobIds.length === 0);
}

function phaseTwoJobs(items: PackItem[]): JobItem[] {
  const totals = new Map<string, number>();
  for (const item of readyForModels(items)) for (const presetId of item.modelPresetIds) addJobs(totals, presetId, item.modelSeeds);
  return jobList(totals);
}

function PackDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<PackDetailAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RunMode>("pictures_first");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [picking, setPicking] = useState(false); // The fast pick screen (FRG-81).
  const [exportReport, setExportReport] = useState<ExportReport | null>(null); // FRG-82.
  const packBatches = useActiveBatches().filter((batch) => batch.owner.type === "pack" && batch.owner.id === id);

  async function load() {
    try {
      const response = await fetch(`/api/packs/${encodeURIComponent(id)}`);
      const body = await response.json().catch(() => null);
      if (!body) setError(NO_BACKEND);
      else if (!response.ok) setError(body.error ?? "Could not load the pack.");
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
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [id]);

  // A button: send it, show what happened, and load the pack again.
  async function post(name: string, url: string, body: unknown, done: (answer: Record<string, unknown>) => string) {
    setBusy(name);
    setMessage(null);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const answer = await response.json().catch(() => null);
      if (!answer) setMessage({ text: NO_BACKEND, error: true });
      else if (!response.ok) setMessage({ text: answer.error ?? "That did not work.", error: true });
      else setMessage({ text: done(answer), error: false });
    } catch {
      setMessage({ text: NO_BACKEND, error: true });
    } finally {
      setBusy(null);
      load();
    }
  }

  function makePictures() {
    post("run", `/api/packs/${id}/run`, { mode }, (answer) =>
      mode === "full_auto"
        ? `Full auto started with ${answer.cards} picture card(s). Edits and 3D models follow by themselves.`
        : `Started ${answer.cards} picture card(s) as one batch. Pick a picture for each item when they are done.`,
    );
  }

  // "Export" (FRG-82): the backend writes the folder for Unreal and answers with a report.
  async function exportPack() {
    setBusy("export");
    setMessage(null);
    setExportReport(null);
    try {
      const response = await fetch(`/api/packs/${id}/export`, { method: "POST" });
      const answer = await response.json().catch(() => null);
      if (!answer) setMessage({ text: NO_BACKEND, error: true });
      else if (!response.ok) setMessage({ text: answer.error ?? "The export did not work.", error: true });
      else setExportReport(answer as ExportReport);
    } catch {
      setMessage({ text: NO_BACKEND, error: true });
    } finally {
      setBusy(null);
    }
  }

  function makeModels() {
    post("models", `/api/packs/${id}/models`, {}, (answer) => `Started ${answer.cards} 3D card(s) for ${answer.items} item(s) as one batch.`);
  }

  function pick(item: PackItem, jobId: string, target: "picture" | "model") {
    post(`pick-${jobId}`, `/api/packs/${id}/items/${item.id}/pick`, { jobId, target }, () =>
      target === "model" ? `${item.itemId}: 3D model picked.` : `${item.itemId}: picture picked.`,
    );
  }

  const counts = Object.fromEntries(Object.keys(STATUS_STYLES).map((status) => [status, 0])) as StatusCounts;
  for (const item of detail?.items ?? []) counts[item.status] += 1;
  const items = detail?.items ?? [];
  const planned = items.filter((item) => item.status === "planned" && item.kind !== "skip" && !item.editFrom).length;
  const pickedForModels = readyForModels(items).length;
  const hasResults = items.some((item) => item.pictureJobIds.length > 0 || item.modelJobIds.length > 0);
  const leftToPick = items.filter((item) => (item.status === "pick_picture" && !item.pickedPictureJobId) || item.status === "pick_model").length;

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
              {detail.pack.runMode && (
                <span className="text-xs text-slate-500">Last run: {detail.pack.runMode === "full_auto" ? "full auto" : "pictures first"}</span>
              )}
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

          {packBatches.map((batch) => (
            <BatchBar key={batch.id} batchId={batch.id} />
          ))}

          <div className="mb-4 flex flex-wrap items-center gap-3">
            {hasResults && (
              <>
                <button
                  type="button"
                  onClick={() => setPicking(true)}
                  className="cursor-pointer rounded-lg border-0 bg-amber-500/90 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-amber-400"
                >
                  Pick ({leftToPick} left)
                </button>
                <span className="text-xs text-slate-500">A full screen to pick with the keyboard: 1-9 pick, N more, E edit, S skip, arrows move.</span>
              </>
            )}
            <button
              type="button"
              onClick={exportPack}
              disabled={busy !== null}
              title="Write every picked result into one folder, with forge_manifest.json and forge_record.md"
              className="ml-auto cursor-pointer rounded-lg border border-slate-600 bg-transparent px-4 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:cursor-wait disabled:opacity-50"
            >
              {busy === "export" ? "Exporting..." : detail.pack.engine === "unreal" ? "Export for Unreal" : "Export"}
            </button>
          </div>
          {exportReport && <ExportSummary report={exportReport} />}
          {picking && (
            <PickScreen packId={id} packName={detail.pack.name} items={items} jobs={detail.jobs} onClose={() => setPicking(false)} reload={load} />
          )}

          <div className="mb-6 space-y-3">
            {planned > 0 && (
              <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <span className="text-sm font-semibold text-slate-100">Step 1: Make pictures</span>
                  <div className="flex overflow-hidden rounded-lg border border-slate-600 text-xs" role="group" aria-label="Run mode">
                    {(["pictures_first", "full_auto"] as RunMode[]).map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        onClick={() => setMode(choice)}
                        aria-pressed={mode === choice}
                        className={`cursor-pointer border-0 px-3 py-1.5 ${mode === choice ? "bg-teal-600 text-white" : "bg-transparent text-slate-300 hover:bg-slate-700"}`}
                      >
                        {choice === "pictures_first" ? "Pictures first" : "Full auto"}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={makePictures}
                    disabled={busy !== null}
                    className="ml-auto cursor-pointer rounded-lg border-0 bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:cursor-wait disabled:opacity-50"
                  >
                    {busy === "run" ? "Starting..." : mode === "full_auto" ? "Run full auto" : `Make pictures for ${planned} item(s)`}
                  </button>
                </div>
                <p className="mt-0 mb-3 text-xs text-slate-400">
                  {mode === "full_auto"
                    ? "Everything runs alone: pictures, then the first finished picture of each item is picked, then edits and 3D models. You pick the 3D models at the end."
                    : "Makes every picture as one batch. Then you pick a picture for each item, and start the 3D models in step 2. Edits start when their source picture is picked."}
                </p>
                <EstimateView key={mode} title={mode === "full_auto" ? "Time for everything" : "Time for the pictures"} items={phaseOneJobs(items, mode)} />
              </div>
            )}

            {pickedForModels > 0 && (
              <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <span className="text-sm font-semibold text-slate-100">Step 2: Make 3D models</span>
                  <button
                    type="button"
                    onClick={makeModels}
                    disabled={busy !== null}
                    className="ml-auto cursor-pointer rounded-lg border-0 bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:cursor-wait disabled:opacity-50"
                  >
                    {busy === "models" ? "Starting..." : `Make 3D models for ${pickedForModels} picked item(s)`}
                  </button>
                </div>
                <EstimateView title="Time for the 3D models" items={phaseTwoJobs(items)} />
              </div>
            )}

            {message && <p className={`m-0 text-sm ${message.error ? "text-red-300" : "text-emerald-300"}`}>{message.text}</p>}
          </div>

          <ItemTable
            rows={items.map((item) => ({
              ...savedRow(item),
              extra:
                item.pictureJobIds.length > 0 || item.error ? (
                  <ItemResults item={item} jobs={detail.jobs} busy={busy} onPick={(jobId, target) => pick(item, jobId, target)} />
                ) : undefined,
            }))}
            showStatus
          />
        </>
      )}
    </main>
  );
}

type ItemResultsProps = {
  item: PackItem;
  jobs: Record<string, PackJob>;
  busy: string | null;
  onPick: (jobId: string, target: "picture" | "model") => void;
};

// The pictures of an item with a Pick button under each finished one, then its 3D results.
// A 3D result opens in the 3D viewer (ModelViewer) with "View 3D", one at a time: a browser can only
// show a few 3D views at once. The fast pick screen is FRG-81; this is the simple version.
function ItemResults({ item, jobs, busy, onPick }: ItemResultsProps) {
  const [viewing, setViewing] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {item.error && <p className="m-0 text-xs text-red-300">{item.error}</p>}
      {item.pictureJobIds.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {item.pictureJobIds.map((jobId) => (
            <ResultTile
              key={jobId}
              job={jobs[jobId]}
              picked={item.pickedPictureJobId === jobId}
              autoPicked={item.pickedPictureJobId === jobId && item.autoPicked}
              size={160}
              open
              busy={busy === `pick-${jobId}`}
              onPick={() => onPick(jobId, "picture")}
            />
          ))}
        </div>
      )}
      {item.modelJobIds.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {item.modelJobIds.map((jobId) => (
            <ResultTile
              key={jobId}
              job={jobs[jobId]}
              picked={item.pickedModelJobId === jobId}
              autoPicked={false}
              size={viewing === jobId ? 320 : 160}
              open={viewing === jobId}
              onView={() => setViewing(viewing === jobId ? null : jobId)}
              busy={busy === `pick-${jobId}`}
              onPick={() => onPick(jobId, "model")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type ResultTileProps = {
  job: PackJob | undefined;
  picked: boolean;
  autoPicked: boolean;
  size: number;
  open?: boolean; // Show it in full: always for pictures, for a 3D model only after "View 3D".
  onView?: () => void; // 3D results only: open or close the viewer.
  busy: boolean;
  onPick: () => void;
};

// One result: the picture or 3D model when it is done, else its state. Pick under a finished one.
function ResultTile({ job, picked, autoPicked, size, open, onView, busy, onPick }: ResultTileProps) {
  const style = { width: size, height: size };
  let body: ReactNode;
  if (!job) body = <div className="flex items-center justify-center text-xs text-slate-500" style={style}>Card deleted</div>;
  else if (job.status === "done" && job.imageUrl)
    body = <Media url={job.imageUrl} kind={outputKind(job)} mode={open ? "full" : "thumbnail"} alt="" style={{ ...style, objectFit: "cover" }} />;
  else if (job.status === "queued" || job.status === "running")
    body = (
      <div className="flex items-center p-2" style={style}>
        <ProgressView progress={job.progress} onCancel={null} cancelling={false} />
      </div>
    );
  else if (job.error) body = <div className="overflow-auto p-2 text-xs text-red-300" style={style}>Failed: {job.error}</div>;
  else body = <div className="flex items-center justify-center text-xs text-slate-500" style={style}>Waiting in the batch</div>;

  return (
    <div className={`overflow-hidden rounded-xl border ${picked ? "border-teal-400" : "border-slate-700/60"} bg-slate-900/40`} style={{ width: size }}>
      {body}
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        {picked ? (
          <span className="flex items-center gap-1 text-teal-300">
            <CheckCircle2 size={13} /> {autoPicked ? "Auto-picked" : "Picked"}
          </span>
        ) : (
          job?.status === "done" && (
            <button
              type="button"
              onClick={onPick}
              disabled={busy}
              className="cursor-pointer rounded-md border border-slate-600 bg-transparent px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700 disabled:cursor-wait disabled:opacity-50"
            >
              {busy ? "Picking..." : "Pick"}
            </button>
          )
        )}
        {onView && job?.status === "done" && (
          <button
            type="button"
            onClick={onView}
            className="ml-auto cursor-pointer rounded-md border border-slate-600 bg-transparent px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700"
          >
            {open ? "Close 3D" : "View 3D"}
          </button>
        )}
      </div>
    </div>
  );
}

// The answer of POST /api/packs/<id>/export (PackExportReport in backend/src/packExport.ts).
type ExportReport = { folder: string; written: string[]; overwritten: string[]; missing: string[]; problems: string[] };

// Where the export is, and what it did: files written and overwritten, and items still missing (FRG-82).
function ExportSummary({ report }: { report: ExportReport }) {
  return (
    <div className="mb-4 space-y-2 rounded-xl border border-slate-700/60 bg-slate-800/40 p-4 text-sm">
      <div className="text-slate-300">
        Folder: <span className="font-mono text-xs break-all text-slate-100 select-all">{report.folder}</span>
      </div>
      <div className="text-slate-400">
        {report.written.length} new file(s) written, {report.overwritten.length} file(s) overwritten. Nothing in the folder was deleted.
      </div>
      {report.missing.length === 0 ? (
        <div className="text-emerald-300">Every item is in the folder (items made outside TeczoForge are listed in the manifest).</div>
      ) : (
        <div className="text-amber-300">Still missing (not done yet): {report.missing.join(", ")}</div>
      )}
      {report.problems.length > 0 && <ErrorList title="Some picked files could not be found." errors={report.problems} />}
    </div>
  );
}
