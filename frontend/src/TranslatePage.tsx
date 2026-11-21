import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { AlertTriangle, Check, Copy, Download, ExternalLink, ImagePlus, Pencil, RefreshCw, Rows3, Table2, Trash2 } from "lucide-react";
import { askConfirm, showMessage } from "./dialogs";
import { btn, CARD, EmptyState, FIELD, Loading, Notice, PageHeader, Tabs } from "./ui";
import { TranslateOverlay, useOverlay } from "./TranslateOverlay";
import type { Overlay } from "./TranslateOverlay";
import { DownloadDialog } from "./TranslateDownload";
import { forEachPdfPage, isPdf } from "./pdfPages";
import { splitIntoBlocks, withoutEmptyRows } from "./translateTables";

// True when a text has a Markdown table in it (FRG-113, the same rule as the backend).
function hasTable(text: string): boolean {
  return splitIntoBlocks(text).some((block) => block.kind === "table");
}

// The Translate page (FRG-92, plan: docs/japanese-translate.md section 13).
// The user adds photos or PDF files of handwritten Japanese documents. A PDF file is cut into
// pages in the browser (pdfPages.ts), and each page is handled like a photo (FRG-95). For each photo the backend makes the
// Japanese text and the translation (backend/src/translateDocuments.ts). This page shows the list
// of documents on the left, and the photo with both texts on the right.
// Everything stays on this PC: the page only talks to our own backend.

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";
// While a document is not finished, ask the backend again this often.
const REFRESH_MS = 2000;

// "arranging": call 5 makes a table of the Japanese text (FRG-112).
type DocStatus = "waiting" | "reading" | "arranging" | "translating" | "placing" | "done" | "failed";

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
  // The translation on the photo (FRG-104): "none", "done" or "failed".
  overlay: "none" | "done" | "failed";
  // True when the empty table rows are hidden on screen and in downloads (FRG-110). Same for all pages of a file.
  hideEmptyRows: boolean;
  // How many empty table rows the translation has. Only in the list, not in one document (FRG-110).
  emptyRows: number;
  // "Make it a table" (FRG-111 to FRG-113). tableHint "offer": the photo has a table, the text does not.
  // tableUndo: the text before the table is kept, so it can be put back.
  tableHint: "none" | "offer" | "dismissed";
  tableUndo: boolean;
};

// The actions of POST /api/translate/documents/<id>/table (FRG-112).
type TableAction = "make" | "undo" | "keep" | "dismiss";
// One document with both texts, as GET /api/translate/documents/<id> returns it.
type DocDetail = DocSummary & { japanese: string; english: string };

const STATUS_WORDS: Record<DocStatus, string> = {
  waiting: "Waiting",
  reading: "Reading the handwriting",
  arranging: "Making a table",
  translating: "Translating",
  placing: "Placing the text on the photo",
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

  // The picked document with its texts. Read again whenever its status changes in the list, and when
  // Undo or "Keep the table" changes its texts without a new status (FRG-113).
  const picked = docs?.find((doc) => doc.id === pickedId) ?? null;
  const pickedStatus = picked ? versionOf(picked) : undefined;
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
    if (!(await askConfirm({ title: "Remove document?", message: question, confirmLabel: "Remove", danger: true }))) return;
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

  // "Make it a table" (FRG-113): make, undo, keep the table, or keep as text.
  // Making a table runs on the GPU like a translation; the list shows its status.
  async function tableAction(id: string, action: TableAction) {
    setError(null);
    try {
      const response = await fetch(`/api/translate/documents/${id}/table`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(await errorOf(response));
      await loadDocs();
    } catch (problem) {
      setError(problem instanceof TypeError ? NO_BACKEND : (problem as Error).message);
    }
  }

  // Hide or show the empty table rows, for all pages of the file (FRG-110).
  async function setHideEmptyRows(id: string, hide: boolean) {
    setError(null);
    try {
      const response = await fetch(`/api/translate/documents/${id}/empty-rows`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hide }),
      });
      if (!response.ok) throw new Error(await errorOf(response));
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
                {picked && <Result doc={picked} filePages={pagesOfFile(docs, picked)} detail={detail?.id === picked.id ? detail : null} onTryAgain={() => void tryAgain(picked.id)} onRemove={() => void remove(picked)} onSaveJapanese={(text) => saveJapanese(picked.id, text)} onHideEmptyRows={(hide) => void setHideEmptyRows(picked.id, hide)} onTableAction={(action) => tableAction(picked.id, action)} />}
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

type PhotoMode = "translated" | "original";

// True when the document has the translation on the photo (FRG-104).
function hasOverlayOf(doc: DocSummary): boolean {
  return doc.status === "done" && doc.overlay === "done";
}

// Changes whenever the texts or the overlay of a document may have changed: a new status or run time,
// or Undo / "Keep the table", which change the texts but keep the status "done" (FRG-113).
function versionOf(doc: DocSummary): string {
  return `${doc.status}-${doc.seconds}-${doc.tableUndo}`;
}

// All pages of the file of a document, in page order (FRG-107). For a photo: only the document itself.
function pagesOfFile(docs: DocSummary[], doc: DocSummary): DocSummary[] {
  if (!doc.fileId) return [doc];
  return docs.filter((other) => other.fileId === doc.fileId).sort((a, b) => a.page - b.page);
}

// The photo. With a translation on the photo (FRG-105): the tabs "Translated" | "Original" above it.
// The original photo is a link that opens it full size. The translated view is not a link, so the mouse
// can hover the blocks; it has an "Open full size" button instead.
function PhotoView({
  doc,
  imageUrl,
  overlay,
  problem,
}: {
  doc: DocSummary;
  imageUrl: string;
  overlay: Overlay | null;
  problem: string | null;
}) {
  const hasOverlay = hasOverlayOf(doc);
  const [mode, setMode] = useState<PhotoMode>("translated");
  const alt = `Photo: ${titleOf(doc)}`;
  const box = "mb-4 block max-h-[70vh] overflow-auto rounded-xl bg-frame";

  if (!hasOverlay) {
    return (
      <a href={imageUrl} target="_blank" rel="noreferrer" title="Open the photo full size" className={box}>
        <img src={imageUrl} alt={alt} className="block w-full" />
      </a>
    );
  }
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Tabs
          label="Photo"
          items={[
            { value: "translated", label: "Translated", title: "The translation on the photo" },
            { value: "original", label: "Original", title: "The photo as uploaded" },
          ]}
          value={mode}
          onChange={setMode}
        />
        <a href={imageUrl} target="_blank" rel="noreferrer" className={`${btn("ghost", "sm")} ml-auto`}>
          <ExternalLink size={14} />
          Open full size
        </a>
      </div>
      {mode === "translated" ? (
        <div className={box}>
          <TranslateOverlay docId={doc.id} imageUrl={imageUrl} alt={alt} overlay={overlay} problem={problem} />
        </div>
      ) : (
        <a href={imageUrl} target="_blank" rel="noreferrer" title="Open the photo full size" className={box}>
          <img src={imageUrl} alt={alt} className="block w-full" />
        </a>
      )}
    </>
  );
}

// The photo, the two texts and the buttons of one document.
function Result({
  doc,
  filePages,
  detail,
  onTryAgain,
  onRemove,
  onSaveJapanese,
  onHideEmptyRows,
  onTableAction,
}: {
  doc: DocSummary;
  filePages: DocSummary[];
  detail: DocDetail | null;
  onTryAgain: () => void;
  onRemove: () => void;
  onSaveJapanese: (japanese: string) => Promise<boolean>;
  onHideEmptyRows: (hide: boolean) => void;
  onTableAction: (action: TableAction) => Promise<void>;
}) {
  const imageUrl = `/api/translate/documents/${doc.id}/image`;
  const finished = isFinished(doc.status);
  // The translation on the photo, loaded once for the screen and the PNG download (FRG-105, FRG-106).
  // The version changes when the document is translated again, so a new overlay is drawn.
  const { overlay, problem } = useOverlay(doc.id, imageUrl, hasOverlayOf(doc) ? versionOf(doc) : null);
  // The Download dialog (FRG-107): the translated photo, the translated text or the plain text.
  const [downloading, setDownloading] = useState(false);
  // True while a "Make it a table" request is sent (FRG-113), so a button is not pressed twice.
  const [tableBusy, setTableBusy] = useState(false);

  async function runTableAction(action: TableAction) {
    setTableBusy(true);
    await onTableAction(action);
    setTableBusy(false);
  }

  // "Make a table" next to Edit (FRG-113): only on a done page whose Japanese text has no table.
  const canMakeTable = doc.status === "done" && detail !== null && detail.japanese !== "" && !hasTable(detail.japanese);

  return (
    <div className={`${CARD} p-5`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="m-0 min-w-0 flex-1 truncate text-lg font-medium text-ink">{titleOf(doc)}</h2>
        <span className={`text-sm ${statusColour(doc.status)}`}>{STATUS_WORDS[doc.status]}</span>
        <button
          type="button"
          onClick={() => setDownloading(true)}
          disabled={doc.status !== "done"}
          title="Save the translation as a file"
          className={btn("secondary", "sm")}
        >
          <Download size={14} />
          Download
        </button>
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
          disabled={doc.status === "reading" || doc.status === "arranging" || doc.status === "translating" || doc.status === "placing"}
          title={doc.fileId ? "Remove all pages of this PDF file" : "Remove this document"}
          className={btn("danger", "sm")}
        >
          <Trash2 size={14} />
          Remove
        </button>
      </div>

      {/* key: each document starts in the "Translated" view, and a new overlay is drawn after Try again. */}
      <PhotoView key={`${doc.id}-${versionOf(doc)}`} doc={doc} imageUrl={imageUrl} overlay={overlay} problem={problem} />

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

      <TableBars doc={doc} busy={tableBusy} onAction={(action) => void runTableAction(action)} />
      {doc.status === "done" && <EmptyRowsBar doc={doc} filePages={filePages} onHide={onHideEmptyRows} />}

      <p className="mt-0 mb-4 text-sm text-ink-2">
        Machine reading of handwriting makes mistakes. Check the Japanese text against the photo.
      </p>

      {/* key: a half-typed correction is dropped when another document is opened. */}
      <TextBox
        key={doc.id}
        title={doc.japaneseEdited ? "Japanese (corrected by hand)" : "Japanese"}
        lang="ja"
        text={detail?.japanese ?? ""}
        hideEmptyRows={doc.hideEmptyRows}
        waiting={doc.status === "waiting" || doc.status === "reading"}
        onSave={finished ? onSaveJapanese : undefined}
        onMakeTable={canMakeTable ? () => void runTableAction("make") : undefined}
        makeTableBusy={tableBusy}
      />
      {/* While the text is placed on the photo, the translation is already there. */}
      <TextBox title="Translation" text={detail?.english ?? ""} hideEmptyRows={doc.hideEmptyRows} waiting={!finished && doc.status !== "placing"} />

      {finished && (
        <p className="mt-4 mb-0 text-xs text-ink-3">
          Model: {doc.model} · Image tokens: {doc.imageTokens} · {doc.seconds} seconds
        </p>
      )}

      {downloading && <DownloadDialog doc={doc} filePages={filePages} overlay={overlay} onClose={() => setDownloading(false)} />}
    </div>
  );
}

// The table bars (FRG-113, plan: docs/translate-downloads-and-tables.md section 12).
// Offer: the photo has a table, but the text is not written as one. After: a table was made, and the
// text before it can still be put back.
function TableBars({ doc, busy, onAction }: { doc: DocSummary; busy: boolean; onAction: (action: TableAction) => void }) {
  if (doc.tableUndo && (doc.status === "done" || doc.status === "failed")) {
    return (
      <Notice tone="success" className="mb-4 flex flex-wrap items-center gap-3">
        <Table2 size={16} className="shrink-0" />
        <span className="min-w-0 flex-1">The text is now a table. Check it against the photo.</span>
        <button type="button" onClick={() => onAction("undo")} disabled={busy} className={btn("secondary", "sm")}>
          Undo
        </button>
        <button type="button" onClick={() => onAction("keep")} disabled={busy} className={btn("secondary", "sm")}>
          Keep the table
        </button>
      </Notice>
    );
  }
  if (doc.tableHint === "offer" && doc.status === "done") {
    return (
      <Notice tone="info" className="mb-4 flex flex-wrap items-center gap-3">
        <Table2 size={16} className="shrink-0" />
        <span className="min-w-0 flex-1">This page looks like a table, but the text is not written as one.</span>
        <button type="button" onClick={() => onAction("make")} disabled={busy} className={btn("primary", "sm")}>
          Make it a table
        </button>
        <button type="button" onClick={() => onAction("dismiss")} disabled={busy} className={btn("secondary", "sm")}>
          Keep as text
        </button>
      </Notice>
    );
  }
  return null;
}

// "1 empty row" or "3 empty rows".
function rowsWord(count: number): string {
  return count === 1 ? "1 empty row" : `${count} empty rows`;
}

// The bar that offers to hide the empty table rows of the file (FRG-110, plan: docs/translate-downloads-and-tables.md section 8.5).
// Shown only when the tables of the file have empty rows. The setting is the same for all pages of the file.
function EmptyRowsBar({ doc, filePages, onHide }: { doc: DocSummary; filePages: DocSummary[]; onHide: (hide: boolean) => void }) {
  const inFile = filePages.reduce((sum, one) => sum + one.emptyRows, 0);
  if (inFile === 0) return null;
  const onPage = doc.emptyRows;
  let message: string;
  if (doc.hideEmptyRows) {
    message = `${rowsWord(inFile)} ${inFile === 1 ? "is" : "are"} hidden on screen and in downloads.`;
  } else if (filePages.length > 1) {
    message = `The tables in this file have ${rowsWord(inFile)} (${onPage === 0 ? "none" : onPage} on this page).`;
  } else {
    message = `The tables on this page have ${rowsWord(inFile)}.`;
  }
  return (
    <Notice tone="neutral" className="mb-4 flex flex-wrap items-center gap-3">
      <Rows3 size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      <button type="button" onClick={() => onHide(!doc.hideEmptyRows)} className={btn("secondary", "sm")}>
        {doc.hideEmptyRows ? "Show them again" : "Remove empty rows"}
      </button>
    </Notice>
  );
}

// One text with its "Copy" button. With onSave it also has "Edit": the text becomes a box to
// type in, with "Save and translate again" (FRG-94).
// hideEmptyRows (FRG-110): the empty table rows are left out on screen and in Copy. Edit still shows
// and saves the full text.
// onMakeTable (FRG-113): a "Make a table" button next to Edit, for a page where the table bar does not show.
function TextBox({
  title,
  text,
  lang,
  hideEmptyRows = false,
  waiting,
  onSave,
  onMakeTable,
  makeTableBusy = false,
}: {
  title: string;
  text: string;
  lang?: string;
  hideEmptyRows?: boolean;
  waiting: boolean;
  onSave?: (text: string) => Promise<boolean>;
  onMakeTable?: () => void;
  makeTableBusy?: boolean;
}) {
  const shown = hideEmptyRows ? withoutEmptyRows(text) : text;
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
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The browser did not allow it (for example the page is not on localhost or https).
      await showMessage({ title: "Could not copy", message: "Copying did not work in this browser. Select the text and press Ctrl+C." });
    }
  }

  return (
    <section className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="m-0 mr-auto text-sm font-medium text-ink">{title}</h3>
        {onMakeTable && (
          <button
            type="button"
            onClick={onMakeTable}
            disabled={makeTableBusy}
            title="Rewrite this text as a table, then translate it again. It can be undone."
            className={`${btn("secondary", "xs")} mr-2`}
          >
            <Table2 size={12} />
            Make a table
          </button>
        )}
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
        {text !== "" ? <TextWithTables text={shown} /> :<span className="text-ink-3">{waiting ? "Not ready yet..." : "No text."}</span>}
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
