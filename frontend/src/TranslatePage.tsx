import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { AlertTriangle, Check, Copy, Download, ImagePlus, RefreshCw } from "lucide-react";

// The Translate page (FRG-92, plan: docs/japanese-translate.md section 13).
// The user adds photos of handwritten Japanese documents. For each photo the backend makes the
// Japanese text and the translation (backend/src/translateDocuments.ts). This page shows the list
// of documents on the left, and the photo with both texts on the right.
// Everything stays on this PC: the page only talks to our own backend.

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";
// While a document is not finished, ask the backend again this often.
const REFRESH_MS = 2000;

type DocStatus = "waiting" | "reading" | "translating" | "done" | "failed";

// GET /api/translate/status
type TranslateStatus = { setUp: boolean; problem: string | null; serverRunning: boolean; gpuBusy: boolean; waiting: number };

// One document in the list, as GET /api/translate/documents returns it (without the long texts).
type DocSummary = {
  id: string;
  originalName: string;
  createdAt: string;
  status: DocStatus;
  error: string | null;
  warnings: string[];
  model: string;
  imageTokens: string;
  seconds: number;
};
// One document with both texts, as GET /api/translate/documents/<id> returns it.
type DocDetail = DocSummary & { japanese: string; english: string };

const STATUS_WORDS: Record<DocStatus, string> = {
  waiting: "Waiting",
  reading: "Reading the handwriting",
  translating: "Translating",
  done: "Done",
  failed: "Failed",
};

function isFinished(status: DocStatus): boolean {
  return status === "done" || status === "failed";
}

// The backend's error text, or a general one.
async function errorOf(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : "Something went wrong. Try again.";
}

export default function TranslatePage() {
  const [status, setStatus] = useState<TranslateStatus | null>(null);
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Uploading 2 of 5", or null when no upload is running.
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Is translation set up? Asked once when the page opens.
  useEffect(() => {
    fetch("/api/translate/status")
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorOf(response));
        setStatus(await response.json());
      })
      .catch((problem: Error) => setError(problem instanceof TypeError ? NO_BACKEND : problem.message));
  }, []);

  const loadDocs = useCallback(async () => {
    try {
      const response = await fetch("/api/translate/documents");
      if (!response.ok) throw new Error(await errorOf(response));
      const list: DocSummary[] = (await response.json()).documents;
      setDocs(list);
      // While documents are not finished, also ask if they wait for the GPU (FRG-93).
      if (list.some((doc) => !isFinished(doc.status))) {
        const statusResponse = await fetch("/api/translate/status");
        if (statusResponse.ok) setStatus(await statusResponse.json());
      } else {
        setStatus((current) => (current ? { ...current, gpuBusy: false } : current));
      }
      // Open the newest document if none is picked yet.
      setPickedId((current) => current ?? list[0]?.id ?? null);
    } catch (problem) {
      setError(problem instanceof TypeError ? NO_BACKEND : (problem as Error).message);
    }
  }, []);

  // The list: once when the page opens, then every 2 seconds while a document is not finished.
  const setUp = status?.setUp === true;
  const anyUnfinished = docs?.some((doc) => !isFinished(doc.status)) ?? false;
  useEffect(() => {
    if (setUp) void loadDocs();
  }, [setUp, loadDocs]);
  useEffect(() => {
    if (!anyUnfinished) return;
    const timer = window.setInterval(() => void loadDocs(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [anyUnfinished, loadDocs]);

  // The picked document with its texts. Read again whenever its status changes in the list.
  const picked = docs?.find((doc) => doc.id === pickedId) ?? null;
  const pickedStatus = picked?.status;
  useEffect(() => {
    if (!pickedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/translate/documents/${pickedId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorOf(response));
        const doc: DocDetail = await response.json();
        if (!cancelled) setDetail(doc);
      })
      .catch((problem: Error) => {
        if (!cancelled) setError(problem instanceof TypeError ? NO_BACKEND : problem.message);
      });
    return () => {
      cancelled = true;
    };
  }, [pickedId, pickedStatus]);

  // Upload the photos one at a time. A photo the backend refuses does not stop the others.
  async function addPhotos(files: File[]) {
    if (files.length === 0 || uploading) return;
    setError(null);
    const problems: string[] = [];
    let lastId: string | null = null;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      setUploading(`Uploading ${index + 1} of ${files.length}`);
      try {
        const response = await fetch(`/api/translate/documents?name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!response.ok) {
          problems.push(`${file.name}: ${await errorOf(response)}`);
        } else {
          lastId = (await response.json()).id;
        }
      } catch {
        problems.push(`${file.name}: ${NO_BACKEND}`);
      }
      await loadDocs();
    }
    setUploading(null);
    if (lastId) setPickedId(lastId);
    if (problems.length > 0) setError(problems.join("\n"));
  }

  function onPickFiles(event: ChangeEvent<HTMLInputElement>) {
    void addPhotos([...(event.target.files ?? [])]);
    event.target.value = ""; // So the same file can be picked again.
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    void addPhotos([...event.dataTransfer.files]);
  }

  async function tryAgain(id: string) {
    setError(null);
    try {
      const response = await fetch(`/api/translate/documents/${id}/retry`, { method: "POST" });
      if (!response.ok) throw new Error(await errorOf(response));
      await loadDocs();
    } catch (problem) {
      setError(problem instanceof TypeError ? NO_BACKEND : (problem as Error).message);
    }
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-8 pt-2 pb-12">
      <h1 className="m-0 mb-6 text-2xl font-semibold text-slate-100">Translate</h1>

      {error && (
        <p className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm whitespace-pre-line text-red-200">{error}</p>
      )}
      {!status && !error && <p className="text-sm text-slate-500">Loading...</p>}

      {/* Not set up: the reason, and nothing else. */}
      {status && !status.setUp && (
        <p className="rounded-xl border border-slate-700/60 bg-slate-800/60 px-4 py-3 text-sm text-slate-300">
          {status.problem ?? "Translation is not set up."}
        </p>
      )}

      {setUp && (
        <>
          {/* Add photos: a button, and the same box is a drop area. */}
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`mb-6 flex flex-wrap items-center gap-4 rounded-2xl border-2 border-dashed px-5 py-5 transition-colors ${
              dragOver ? "border-teal-400 bg-teal-500/10" : "border-slate-700 bg-slate-800/40"
            }`}
          >
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={onPickFiles} className="hidden" />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={uploading !== null}
              className="flex cursor-pointer items-center gap-2 rounded-xl border-0 bg-teal-600/90 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-teal-900/20 transition-colors hover:bg-teal-500 disabled:cursor-wait disabled:opacity-60"
            >
              <ImagePlus size={16} />
              Add photos
            </button>
            <span className="text-sm text-slate-400">
              {uploading ?? "Or drop photos here. PNG, JPEG or WebP. Photos of handwritten Japanese documents."}
            </span>
          </div>

          {status.gpuBusy && (
            <p className="mt-0 mb-6 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
              The GPU is busy with a generation job. Translation starts when it finishes.
            </p>
          )}

          {docs && docs.length === 0 && <p className="text-sm text-slate-500">No documents yet. Add a photo to start.</p>}

          {docs && docs.length > 0 && (
            <div className="flex items-start gap-6">
              {/* Left: the documents, newest first. */}
              <ul className="m-0 w-72 shrink-0 list-none space-y-2 p-0">
                {docs.map((doc) => (
                  <li key={doc.id}>
                    <button
                      type="button"
                      onClick={() => setPickedId(doc.id)}
                      className={`flex w-full cursor-pointer items-center gap-3 rounded-xl border p-2 text-left transition-colors ${
                        doc.id === pickedId ? "border-teal-500/70 bg-slate-700/50" : "border-slate-700/60 bg-slate-800/60 hover:border-slate-600"
                      }`}
                    >
                      <img
                        src={`/api/translate/documents/${doc.id}/image`}
                        alt=""
                        loading="lazy"
                        className="h-14 w-14 shrink-0 rounded-lg bg-slate-900 object-cover"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-100">{doc.originalName}</span>
                        <span className={`block text-xs ${statusColour(doc.status)}`}>{STATUS_WORDS[doc.status]}</span>
                        {doc.warnings.length > 0 && (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-300">
                            <AlertTriangle size={12} />
                            {doc.warnings.length} {doc.warnings.length === 1 ? "warning" : "warnings"}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              {/* Right: the picked document. */}
              <div className="min-w-0 flex-1">
                {picked && <Result doc={picked} detail={detail?.id === picked.id ? detail : null} onTryAgain={() => void tryAgain(picked.id)} />}
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function statusColour(status: DocStatus): string {
  if (status === "done") return "text-teal-300";
  if (status === "failed") return "text-red-300";
  return "text-slate-400";
}

// The photo, the two texts and the buttons of one document.
function Result({ doc, detail, onTryAgain }: { doc: DocSummary; detail: DocDetail | null; onTryAgain: () => void }) {
  const imageUrl = `/api/translate/documents/${doc.id}/image`;
  const finished = isFinished(doc.status);

  return (
    <div className="rounded-2xl border border-slate-700/60 bg-slate-800/60 p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="m-0 min-w-0 flex-1 truncate text-lg font-semibold text-slate-100">{doc.originalName}</h2>
        <span className={`text-sm ${statusColour(doc.status)}`}>{STATUS_WORDS[doc.status]}</span>
        <a
          href={`/api/translate/documents/${doc.id}/text`}
          download
          className={`flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 no-underline transition-colors hover:bg-slate-700/60 ${
            doc.status === "done" ? "" : "pointer-events-none opacity-40"
          }`}
        >
          <Download size={14} />
          Download .txt
        </a>
        <button
          type="button"
          onClick={onTryAgain}
          disabled={!finished}
          className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-600 bg-transparent px-3 py-1.5 text-sm text-slate-200 transition-colors hover:bg-slate-700/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw size={14} />
          Try again
        </button>
      </div>

      {/* The photo: big, scrolls inside its box, a click opens it full size in a new tab. */}
      <a href={imageUrl} target="_blank" rel="noreferrer" title="Open the photo full size" className="mb-4 block max-h-[70vh] overflow-auto rounded-xl bg-slate-900">
        <img src={imageUrl} alt={`Photo: ${doc.originalName}`} className="block w-full" />
      </a>

      {doc.status === "failed" && (
        <p className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {doc.error ?? "This document failed."}
        </p>
      )}

      {doc.warnings.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          {doc.warnings.map((warning) => (
            <div key={warning} className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {warning}
            </div>
          ))}
        </div>
      )}

      <p className="mt-0 mb-4 text-sm text-slate-400">
        Machine reading of handwriting makes mistakes. Check the Japanese text against the photo.
      </p>

      <TextBox title="Japanese" lang="ja" text={detail?.japanese ?? ""} waiting={doc.status === "waiting" || doc.status === "reading"} />
      <TextBox title="Translation" text={detail?.english ?? ""} waiting={!finished} />

      {finished && (
        <p className="mt-4 mb-0 text-xs text-slate-500">
          Model: {doc.model} · Image tokens: {doc.imageTokens} · {doc.seconds} seconds
        </p>
      )}
    </div>
  );
}

// One text with its "Copy" button.
function TextBox({ title, text, lang, waiting }: { title: string; text: string; lang?: string; waiting: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The browser did not allow it (for example the page is not on localhost or https).
      window.alert("Copying did not work in this browser. Select the text and press Ctrl+C.");
    }
  }

  return (
    <section className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="m-0 text-sm font-semibold text-slate-200">{title}</h3>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={text === ""}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-600 bg-transparent px-2.5 py-1 text-xs text-slate-200 transition-colors hover:bg-slate-700/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div lang={lang} className="min-h-12 rounded-xl bg-slate-900/60 px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap text-slate-100">
        {text !== "" ? text : <span className="text-slate-500">{waiting ? "Not ready yet..." : "No text."}</span>}
      </div>
    </section>
  );
}
