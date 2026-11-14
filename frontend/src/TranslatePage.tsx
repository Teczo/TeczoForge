import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { AlertTriangle, Check, Copy, Download, ImagePlus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { btn, CARD, EmptyState, FIELD, Loading, Notice, PageHeader } from "./ui";
import { forEachPdfPage, isPdf } from "./pdfPages";
import { splitIntoBlocks } from "./translateTables";

// The Translate page (FRG-92, plan: docs/japanese-translate.md section 13).
// The user adds photos or PDF files of handwritten Japanese documents. A PDF file is cut into
// pages in the browser (pdfPages.ts), and each page is handled like a photo (FRG-95). For each photo the backend makes the
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
  // Set when the document is one page of a PDF file (FRG-95). Otherwise null, 1 and 1.
  fileId: string | null;
  page: number;
  pages: number;
  createdAt: string;
  status: DocStatus;
  japaneseEdited: boolean;
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

// The name shown for a document: the file name, and the page for a PDF file.
function titleOf(doc: DocSummary): string {
  return doc.fileId ? `${doc.originalName} – page ${doc.page} of ${doc.pages}` : doc.originalName;
}

// 12 random hex characters. The pages of one PDF file share this id.
function newFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

  // Upload one picture. `pageQuery` is "" for a photo, or the page information of a PDF page.
  // Returns the id of the new document. Throws an error with the text to show.
  async function uploadPicture(name: string, picture: Blob, pageQuery: string): Promise<string> {
    let response;
    try {
      response = await fetch(`/api/translate/documents?name=${encodeURIComponent(name)}${pageQuery}`, {
        method: "POST",
        headers: { "Content-Type": picture.type || "application/octet-stream" },
        body: picture,
      });
    } catch {
      throw new Error(NO_BACKEND);
    }
    if (!response.ok) throw new Error(await errorOf(response));
    return (await response.json()).id;
  }

  // Upload the files one at a time. A file the backend refuses does not stop the others.
  // A PDF file is cut into pages first: each page is uploaded as its own picture (FRG-95).
  async function addFiles(files: File[]) {
    if (files.length === 0 || uploading) return;
    setError(null);
    const problems: string[] = [];
    // The document to open afterwards: the last photo, or the first page of the last PDF.
    let openId: string | null = null;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const progress = `Uploading ${index + 1} of ${files.length}`;
      setUploading(progress);
      try {
        if (isPdf(file)) {
          const fileId = newFileId();
          await forEachPdfPage(file, async (picture, page, pages) => {
            setUploading(`${progress}: page ${page} of ${pages}`);
            const id = await uploadPicture(file.name, picture, `&fileId=${fileId}&page=${page}&pages=${pages}`);
            if (page === 1) openId = id;
            await loadDocs();
          });
        } else {
          openId = await uploadPicture(file.name, file, "");
        }
      } catch (problem) {
        problems.push(`${file.name}: ${(problem as Error).message}`);
      }
      await loadDocs();
    }
    setUploading(null);
    if (openId) setPickedId(openId);
    if (problems.length > 0) setError(problems.join("\n"));
  }

  function onPickFiles(event: ChangeEvent<HTMLInputElement>) {
    void addFiles([...(event.target.files ?? [])]);
    event.target.value = ""; // So the same file can be picked again.
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    void addFiles([...event.dataTransfer.files]);
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

  // Remove a document from the list and from the disk. For a page of a PDF file, all pages of
  // that file are removed together. The user is asked first, because it cannot be undone.
  async function remove(doc: DocSummary) {
    const question = doc.fileId
      ? `Remove all ${doc.pages} pages of "${doc.originalName}"? The pictures and the texts are deleted. This cannot be undone.`
      : `Remove "${doc.originalName}"? The photo and the texts are deleted. This cannot be undone.`;
    if (!window.confirm(question)) return;
    setError(null);
    try {
      const response = await fetch(`/api/translate/documents/${doc.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await errorOf(response));
      // Nothing is picked now, so the newest document that is left is opened.
      setPickedId(null);
      await loadDocs();
    } catch (problem) {
      setError(problem instanceof TypeError ? NO_BACKEND : (problem as Error).message);
    }
  }

  // Save a corrected Japanese text. The backend translates it again without reading the photo (FRG-94).
  // Returns true when it was saved.
  async function saveJapanese(id: string, japanese: string): Promise<boolean> {
    setError(null);
    try {
      const response = await fetch(`/api/translate/documents/${id}/japanese`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ japanese }),
      });
      if (!response.ok) throw new Error(await errorOf(response));
      await loadDocs();
      return true;
    } catch (problem) {
      setError(problem instanceof TypeError ? NO_BACKEND : (problem as Error).message);
      return false;
    }
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-8 pt-8 pb-16">
      <PageHeader title="Translate" />

      {error && (
        <Notice tone="danger" className="mb-4 whitespace-pre-line">{error}</Notice>
      )}
      {!status && !error && <Loading>Loading...</Loading>}

      {/* Not set up: the reason, and nothing else. */}
      {status && !status.setUp && (
        <Notice>{status.problem ?? "Translation is not set up."}</Notice>
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
            className={`mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-dashed px-5 py-5 transition-colors ${
              dragOver ? "border-accent bg-accent-soft" : "border-line-strong bg-sidebar"
            }`}
          >
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" multiple onChange={onPickFiles} className="hidden" />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={uploading !== null}
              className={`${btn("primary")} disabled:cursor-wait`}
            >
              <ImagePlus size={16} />
              Add photos or PDF
            </button>
            <span className="text-sm text-ink-2">
              {uploading ?? "Or drop files here. PNG, JPEG, WebP or PDF. Photos or scans of handwritten Japanese documents."}
            </span>
          </div>

          {status.gpuBusy && (
            <Notice tone="warning" className="mb-6">The GPU is busy with a generation job. Translation starts when it finishes.</Notice>
          )}

          {docs && docs.length === 0 && <EmptyState icon={<ImagePlus size={18} />} title="No documents yet" text="Add a photo or a PDF file to start." />}

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
                        doc.id === pickedId ? "border-line-strong bg-hover" : "border-line bg-card hover:bg-hover"
                      }`}
                    >
                      <img
                        src={`/api/translate/documents/${doc.id}/image`}
                        alt=""
                        loading="lazy"
                        className="h-14 w-14 shrink-0 rounded-lg bg-frame object-cover"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{titleOf(doc)}</span>
                        <span className={`block text-xs ${statusColour(doc.status)}`}>{STATUS_WORDS[doc.status]}</span>
                        {doc.warnings.length > 0 && (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-warning">
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
                {picked && <Result doc={picked} detail={detail?.id === picked.id ? detail : null} onTryAgain={() => void tryAgain(picked.id)} onRemove={() => void remove(picked)} onSaveJapanese={(text) => saveJapanese(picked.id, text)} />}
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function statusColour(status: DocStatus): string {
  if (status === "done") return "text-success";
  if (status === "failed") return "text-danger";
  return "text-ink-2";
}

// The photo, the two texts and the buttons of one document.
function Result({
  doc,
  detail,
  onTryAgain,
  onRemove,
  onSaveJapanese,
}: {
  doc: DocSummary;
  detail: DocDetail | null;
  onTryAgain: () => void;
  onRemove: () => void;
  onSaveJapanese: (japanese: string) => Promise<boolean>;
}) {
  const imageUrl = `/api/translate/documents/${doc.id}/image`;
  const finished = isFinished(doc.status);

  return (
    <div className={`${CARD} p-5`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="m-0 min-w-0 flex-1 truncate text-lg font-medium text-ink">{titleOf(doc)}</h2>
        <span className={`text-sm ${statusColour(doc.status)}`}>{STATUS_WORDS[doc.status]}</span>
        <a
          href={`/api/translate/documents/${doc.id}/text`}
          download
          className={`${btn("secondary", "sm")} ${
            doc.status === "done" ? "" : "pointer-events-none opacity-40"
          }`}
        >
          <Download size={14} />
          Download .txt
        </a>
        {/* The translation as a PDF, with tables. For a page of a PDF file: all pages of that file (FRG-95). */}
        <a
          href={`/api/translate/documents/${doc.id}/pdf`}
          download
          title={doc.fileId ? "The translation of all pages of this PDF file" : "The translation as a PDF file"}
          className={`${btn("secondary", "sm")} ${
            doc.status === "done" ? "" : "pointer-events-none opacity-40"
          }`}
        >
          <Download size={14} />
          Download PDF
        </a>
        <button
          type="button"
          onClick={onTryAgain}
          disabled={!finished}
          className={btn("secondary", "sm")}
        >
          <RefreshCw size={14} />
          Try again
        </button>
        {/* Not while the model works on it. A waiting document can be removed. */}
        <button
          type="button"
          onClick={onRemove}
          disabled={doc.status === "reading" || doc.status === "translating"}
          title={doc.fileId ? "Remove all pages of this PDF file" : "Remove this document"}
          className={btn("danger", "sm")}
        >
          <Trash2 size={14} />
          Remove
        </button>
      </div>

      {/* The photo: big, scrolls inside its box, a click opens it full size in a new tab. */}
      <a href={imageUrl} target="_blank" rel="noreferrer" title="Open the photo full size" className="mb-4 block max-h-[70vh] overflow-auto rounded-xl bg-frame">
        <img src={imageUrl} alt={`Photo: ${titleOf(doc)}`} className="block w-full" />
      </a>

      {doc.status === "failed" && (
        <p className="mb-4 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">
          {doc.error ?? "This document failed."}
        </p>
      )}

      {doc.warnings.length > 0 && (
        <div className="mb-4 rounded-xl border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning">
          {doc.warnings.map((warning) => (
            <div key={warning} className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {warning}
            </div>
          ))}
        </div>
      )}

      <p className="mt-0 mb-4 text-sm text-ink-2">
        Machine reading of handwriting makes mistakes. Check the Japanese text against the photo.
      </p>

      {/* key: a half-typed correction is dropped when another document is opened. */}
      <TextBox
        key={doc.id}
        title={doc.japaneseEdited ? "Japanese (corrected by hand)" : "Japanese"}
        lang="ja"
        text={detail?.japanese ?? ""}
        waiting={doc.status === "waiting" || doc.status === "reading"}
        onSave={finished ? onSaveJapanese : undefined}
      />
      <TextBox title="Translation" text={detail?.english ?? ""} waiting={!finished} />

      {finished && (
        <p className="mt-4 mb-0 text-xs text-ink-3">
          Model: {doc.model} · Image tokens: {doc.imageTokens} · {doc.seconds} seconds
        </p>
      )}
    </div>
  );
}

// One text with its "Copy" button. With onSave it also has "Edit": the text becomes a box to
// type in, with "Save and translate again" (FRG-94).
function TextBox({
  title,
  text,
  lang,
  waiting,
  onSave,
}: {
  title: string;
  text: string;
  lang?: string;
  waiting: boolean;
  onSave?: (text: string) => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  // The text being corrected, or null when not editing.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (draft === null || !onSave) return;
    setSaving(true);
    const saved = await onSave(draft);
    setSaving(false);
    if (saved) setDraft(null);
  }

  if (draft !== null) {
    return (
      <section className="mt-4">
        <h3 className="m-0 mb-2 text-sm font-medium text-ink">{title}</h3>
        <textarea
          lang={lang}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={Math.min(Math.max(draft.split("\n").length + 1, 6), 30)}
          className={`${FIELD} resize-y px-4 py-3 text-[15px] leading-relaxed`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || draft.trim() === ""}
            className={btn("primary", "sm")}
          >
            Save and translate again
          </button>
          <button
            type="button"
            onClick={() => setDraft(null)}
            disabled={saving}
            className={btn("secondary", "sm")}
          >
            Cancel
          </button>
          <span className="text-xs text-ink-3">The photo is not read again. Only the translation is made again.</span>
        </div>
      </section>
    );
  }

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
        <h3 className="m-0 mr-auto text-sm font-medium text-ink">{title}</h3>
        {onSave && (
          <button
            type="button"
            onClick={() => setDraft(text)}
            disabled={text === ""}
            className={`${btn("secondary", "xs")} mr-2`}
          >
            <Pencil size={12} />
            Edit
          </button>
        )}
        <button
          type="button"
          onClick={() => void copy()}
          disabled={text === ""}
          className={btn("secondary", "xs")}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div lang={lang} className="min-h-12 rounded-xl border border-line bg-sidebar px-4 py-3 text-[15px] leading-relaxed text-ink">
        {text !== "" ? <TextWithTables text={text} /> : <span className="text-ink-3">{waiting ? "Not ready yet..." : "No text."}</span>}
      </div>
    </section>
  );
}

// A text, with its tables shown as real tables (FRG-95). The model writes a table as a
// Markdown table; translateTables.ts finds the tables in the text.
function TextWithTables({ text }: { text: string }) {
  return (
    <div className="space-y-3">
      {splitIntoBlocks(text).map((block, index) =>
        block.kind === "text" ? (
          <div key={index} className="whitespace-pre-wrap">{block.text}</div>
        ) : (
          // A wide table scrolls sideways inside its box.
          <div key={index} className="overflow-x-auto">
            <table className="border-collapse text-sm">
              <tbody>
                {block.rows.map((cells, rowIndex) => (
                  <tr key={rowIndex} className={block.header && rowIndex === 0 ? "bg-hover font-medium" : ""}>
                    {cells.map((cell, cellIndex) => (
                      <td key={cellIndex} className="border border-line-strong px-2.5 py-1.5 align-top whitespace-pre-wrap">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </div>
  );
}
