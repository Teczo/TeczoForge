import { useState } from "react";
import type { ReactNode } from "react";
import { btn, Modal, Notice, Tabs } from "./ui";
import { overlayPng } from "./TranslateOverlay";
import type { Overlay } from "./TranslateOverlay";

// The Download dialog of the Translate page (FRG-107, plan: docs/translate-downloads-and-tables.md section 5).
// One "Download" button opens it. It asks what to save (the translated photo, the translated text as a PDF,
// or the plain text) and which pages (all pages of the PDF file, or only this page).
// The browser fetches the file and saves it under a readable name. The translated photo is made in the
// browser (FRG-106): nothing is sent to the backend for it.

// What the dialog needs to know about one page. The documents of the Translate page have these fields.
export type DownloadPage = {
  id: string;
  originalName: string;
  fileId: string | null;
  page: number;
  pages: number;
  status: string;
  overlay: "none" | "done" | "failed";
};

type What = "photo" | "text" | "plain";
type Pages = "all" | "one";

const NO_BACKEND = "Could not reach the backend. Make sure it is running, then try again.";
// The last choice is kept here, so the dialog opens with it next time (spec 5.5).
const STORAGE_KEY = "teczoforge.translateDownload";

// The file name without its extension, with the characters that Windows does not allow made into "_".
function baseNameOf(originalName: string): string {
  const withoutExtension = originalName.replace(/\.(pdf|png|jpe?g|webp)$/i, "");
  return withoutExtension.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "document";
}

// "Page 3", "Pages 3 and 7", "Pages 3, 7 and 9", or "Pages 3, 7, 9, 11, 12 and 4 more".
function listPages(numbers: number[]): string {
  if (numbers.length === 1) return `Page ${numbers[0]}`;
  if (numbers.length <= 5) return `Pages ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
  return `Pages ${numbers.slice(0, 5).join(", ")} and ${numbers.length - 5} more`;
}

// The remembered choice, or null. The page must work when the browser does not allow localStorage.
function readRemembered(): { what?: What; pages?: Pages } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return typeof saved === "object" && saved !== null ? saved : null;
  } catch {
    return null;
  }
}

function remember(what: What, pages: Pages) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ what, pages }));
  } catch {
    // Not allowed in this browser. The dialog works without it.
  }
}

// The backend's error text, or a general one.
async function errorOf(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : "Something went wrong. Try again.";
}

// Fetch a file from our backend. Throws an error with the text to show.
async function fetchFile(url: string): Promise<Blob> {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(NO_BACKEND);
  }
  if (!response.ok) throw new Error(await errorOf(response));
  return response.blob();
}

// Let the browser save a file that is already in memory.
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function DownloadDialog({
  doc,
  filePages,
  overlay,
  onClose,
}: {
  // The open page.
  doc: DownloadPage;
  // All pages of its file, in page order. For a photo: only `doc`.
  filePages: DownloadPage[];
  // The translation on the photo of the open page, or null when it has none (or is still loading).
  overlay: Overlay | null;
  onClose: () => void;
}) {
  // A file with more than one page: the dialog asks which pages.
  const manyPages = doc.fileId !== null && filePages.length > 1;
  // The translated photo is this page only for now (FRG-108 and FRG-109 add all pages).
  const photoProblem =
    doc.overlay !== "done"
      ? "This page has no translation on the photo."
      : overlay === null
        ? "The translation on the photo is still loading."
        : null;

  const [what, setWhat] = useState<What>(() => {
    const saved = readRemembered()?.what;
    if (saved === "text" || saved === "plain") return saved;
    if (saved === "photo" && photoProblem === null) return "photo";
    return photoProblem === null && saved === undefined ? "photo" : "text";
  });
  const [pagesChoice, setPagesChoice] = useState<Pages>(() => (readRemembered()?.pages === "one" ? "one" : "all"));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The pages this download really holds.
  const pages: Pages = what === "photo" || !manyPages ? "one" : pagesChoice;
  const base = baseNameOf(doc.originalName);
  const pagePart = doc.fileId !== null ? ` - page ${doc.page}` : "";
  const fileName =
    what === "photo"
      ? `${base}${pagePart} - translated.png`
      : what === "text"
        ? pages === "one" ? `${base}${pagePart} - translation.pdf` : `${base} - translation.pdf`
        : pages === "one" ? `${base}${pagePart} - text.txt` : `${base} - text.txt`;

  // Pages of the file that are not done yet (spec 5.4). They say so in the file.
  const notReady = pages === "all" ? filePages.filter((one) => one.status !== "done").map((one) => one.page) : [];
  const notReadyNote =
    notReady.length === 0
      ? null
      : `${listPages(notReady)} ${notReady.length === 1 ? "is" : "are"} not translated yet. ${notReady.length === 1 ? "It says" : "They say"} so in the file.`;

  async function download() {
    setBusy(true);
    setProblem(null);
    try {
      let blob: Blob;
      if (what === "photo") {
        if (!overlay) throw new Error("This page has no translation on the photo.");
        blob = await overlayPng(overlay);
      } else {
        const route = what === "text" ? "pdf" : "text";
        blob = await fetchFile(`/api/translate/documents/${doc.id}/${route}?pages=${pages}`);
      }
      saveBlob(blob, fileName);
      remember(what, pagesChoice);
      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The file could not be made.");
      setBusy(false);
    }
  }

  return (
    <Modal title={`Download ${doc.originalName}`} onClose={() => !busy && onClose()}>
      <p className="mt-0 mb-2 text-[13px] font-medium text-ink">What</p>
      <div className="space-y-2" role="radiogroup" aria-label="What to download">
        <Choice
          checked={what === "photo"}
          onPick={() => setWhat("photo")}
          disabled={photoProblem !== null}
          title="Translated photo"
          text={photoProblem ?? "The photo with the translation written on it"}
        />
        <Choice checked={what === "text"} onPick={() => setWhat("text")} title="Translated text" text="The translation, with tables, as a PDF file" />
        <Choice checked={what === "plain"} onPick={() => setWhat("plain")} title="Plain text" text="The Japanese text and the translation, as a .txt file" />
      </div>

      {manyPages && what !== "photo" && (
        <>
          <p className="mt-4 mb-2 text-[13px] font-medium text-ink">Pages</p>
          <Tabs
            label="Pages"
            items={[
              { value: "all", label: `All ${filePages.length} pages` },
              { value: "one", label: `Only page ${doc.page}` },
            ]}
            value={pagesChoice}
            onChange={setPagesChoice}
            disabled={busy}
          />
        </>
      )}

      {notReadyNote && <Notice tone="warning" className="mt-4">{notReadyNote}</Notice>}
      {problem && <Notice tone="danger" className="mt-4">{problem}</Notice>}

      <p className="mt-4 mb-0 text-[13px] break-all text-ink-2">
        You get: <span className="text-ink">{fileName}</span>
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className={btn("secondary", "sm")}>
          Cancel
        </button>
        <button type="button" onClick={() => void download()} disabled={busy} className={`${btn("primary", "sm")} disabled:cursor-wait`}>
          {busy ? "Making the file..." : "Download"}
        </button>
      </div>
    </Modal>
  );
}

// One choice of "What": a radio button with a title and a short grey line under it.
function Choice({
  checked,
  onPick,
  disabled = false,
  title,
  text,
}: {
  checked: boolean;
  onPick: () => void;
  disabled?: boolean;
  title: string;
  text: ReactNode;
}) {
  return (
    <label
      className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
        disabled ? "cursor-not-allowed border-line opacity-50" : checked ? "cursor-pointer border-line-strong bg-hover" : "cursor-pointer border-line hover:bg-hover"
      }`}
    >
      <input type="radio" name="download-what" checked={checked} onChange={onPick} disabled={disabled} className="mt-0.5 accent-ink" />
      <span className="min-w-0">
        <span className="block text-sm text-ink">{title}</span>
        <span className="block text-xs text-ink-2">{text}</span>
      </span>
    </label>
  );
}
