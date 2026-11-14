import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { freeMemory, getQueue } from "./comfyui.js";
import { imageInfo } from "./inputs.js";
import type { ImageInfo } from "./inputs.js";
import { IMAGE_TYPES } from "./upload.js";
import { makeTranslationPdf, pdfFontProblem } from "./translatePdf.js";
import type { PdfPart } from "./translatePdf.js";
import { READ_SYSTEM_TEXT, READ_USER_TEXT, translateSystemText, translateUserText } from "./translatePrompt.js";
import {
  checkTranslateSetup,
  isTranslateServerRunning,
  setTranslationHoldsGpu,
  translationHoldsGpu,
  startTranslateServer,
  stopTranslateServer,
  translateServerUrl,
  translateSettings,
} from "./translateServer.js";

// Japanese translation: documents (FRG-91, plan: docs/japanese-translate.md).
// A "document" is one uploaded photo with its Japanese text and its translation.
// A PDF file is cut into pages by the browser: each page comes here as one picture and is one
// document. The pages of one file share a fileId (FRG-95).
// Each document is a folder in data/translations. No MongoDB is used.
// One worker handles the documents one at a time, oldest first:
//   call 1: photo -> Japanese text.   call 2: Japanese text + photo -> translation.
// The documents are private client data. Their text is never written to the log (CLAUDE.md section 7, rule 11).

// data/translations at the root of the repo.
export const TRANSLATIONS_DIR = path.join(import.meta.dirname, "..", "..", "data", "translations");

// An id looks like tr-1794373826681-a1b2c3. It is checked before it is used in any path.
const ID_PATTERN = /^tr-[0-9]+-[0-9a-f]{6}$/;
// The file name the user sees is cut to this many characters.
const MAX_NAME_LENGTH = 120;
// The pages of one PDF file share this id. The browser makes it: 12 hex characters (FRG-95).
const FILE_ID_PATTERN = /^[0-9a-f]{12}$/;
// The most pages one PDF file may have.
export const MAX_PDF_PAGES = 30;
// The most text one model call may write.
const MAX_ANSWER_TOKENS = 4096;
// How long to wait for one model call.
const CALL_TIMEOUT_MS = 10 * 60 * 1000;
// The longest corrected Japanese text we accept (FRG-94). A full page is far below this.
const MAX_JAPANESE_LENGTH = 20_000;
// While ComfyUI has a job, look at its queue again this often (FRG-93).
const GPU_CHECK_MS = 10_000;
// After asking ComfyUI to unload its models, give it this long to do it.
const FREE_WAIT_MS = 3000;
// The body types the upload route reads. The first bytes decide what the file really is.
// HEIC is read too, only so we can refuse it with a clear message.
export const TRANSLATE_UPLOAD_TYPES = [...IMAGE_TYPES, "image/heic", "image/heif", "application/octet-stream"];

type Status = "waiting" | "reading" | "translating" | "done" | "failed";

// This is record.json (spec 10).
type TranslateDocument = {
  id: string;
  originalName: string;
  // Set when this document is one page of a PDF file (FRG-95). Otherwise null, 1 and 1.
  fileId: string | null;
  page: number;
  pages: number;
  createdAt: string;
  createdBy: string | null;
  status: Status;
  japanese: string;
  japaneseEdited: boolean;
  english: string;
  error: string | null;
  warnings: string[];
  model: string;
  imageTokens: string;
  seconds: number;
};

// All documents, by id. Read from disk once at the start, then every change is also saved to disk.
const documents = new Map<string, TranslateDocument>();

function folderOf(id: string): string {
  return path.join(TRANSLATIONS_DIR, id);
}

// Save a document: record.json, and the two texts as their own files once they exist.
async function saveDocument(doc: TranslateDocument): Promise<void> {
  const folder = folderOf(doc.id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "record.json"), JSON.stringify(doc, null, 2), "utf8");
  if (doc.japanese) await writeFile(path.join(folder, "japanese.txt"), doc.japanese, "utf8");
  if (doc.english) await writeFile(path.join(folder, "english.txt"), doc.english, "utf8");
}

// The photo of a document, as uploaded: source.jpg, source.png or source.webp.
async function readPhoto(id: string): Promise<{ data: Buffer; info: ImageInfo } | null> {
  for (const extension of ["jpg", "png", "webp"]) {
    const filePath = path.join(folderOf(id), `source.${extension}`);
    if (!existsSync(filePath)) continue;
    const data = await readFile(filePath);
    const info = imageInfo(data);
    if (info) return { data, info };
  }
  return null;
}

// Read all documents from data/translations when the backend starts.
// A document that was being worked on when the backend stopped goes back to "waiting".
export function loadTranslateDocuments(): void {
  mkdirSync(TRANSLATIONS_DIR, { recursive: true });
  for (const name of readdirSync(TRANSLATIONS_DIR)) {
    if (!ID_PATTERN.test(name)) continue;
    try {
      const doc = JSON.parse(readFileSync(path.join(TRANSLATIONS_DIR, name, "record.json"), "utf8")) as TranslateDocument;
      if (doc.id !== name) continue;
      // Documents from before FRG-95 have no page fields.
      doc.fileId ??= null;
      doc.page ??= 1;
      doc.pages ??= 1;
      if (doc.status === "reading" || doc.status === "translating") doc.status = "waiting";
      documents.set(doc.id, doc);
    } catch {
      console.warn(`Warning: translation document ${name} has no readable record.json. It is skipped.`);
    }
  }
  const waiting = waitingCount();
  if (waiting > 0) {
    console.log(`Translation: ${waiting} document(s) are waiting.`);
    void runWorker();
  }
}

function waitingCount(): number {
  return [...documents.values()].filter((doc) => doc.status === "waiting").length;
}

// ---------- The worker ----------

// True while the worker is handling documents. Only one worker runs at a time.
let working = false;
// True while documents wait because ComfyUI has a generation job (FRG-93). Shown by the status route.
let gpuBusy = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// What ComfyUI is doing: "busy" (a job is running or waiting), "idle", or "off" (not running).
async function comfyuiState(): Promise<"busy" | "idle" | "off"> {
  try {
    const queue = await getQueue();
    return queue.running.length > 0 || queue.pending.length > 0 ? "busy" : "idle";
  } catch {
    return "off";
  }
}

// The oldest waiting document, or null.
function nextWaiting(): TranslateDocument | null {
  const waiting = [...documents.values()].filter((doc) => doc.status === "waiting");
  waiting.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return waiting[0] ?? null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Handle waiting documents one after another. When none is left, stop llama-server so the GPU is free.
async function runWorker(): Promise<void> {
  if (working) return;
  working = true;
  try {
    // True after ComfyUI was asked to unload its models for this run.
    let askedComfyUIToFree = false;
    for (let doc = nextWaiting(); doc; doc = nextWaiting()) {
      if (!translationHoldsGpu()) {
        // Take the GPU first, then look at ComfyUI's queue. From here on no new job is sent to
        // ComfyUI, so a job cannot slip in between the look and the start of llama-server.
        setTranslationHoldsGpu(true);
        const comfyui = await comfyuiState();
        if (comfyui === "busy") {
          // A generation job is running or waiting. Give the GPU back and look again later.
          setTranslationHoldsGpu(false);
          if (!gpuBusy) console.log("Translation: waiting, because ComfyUI has a job.");
          gpuBusy = true;
          await sleep(GPU_CHECK_MS);
          continue;
        }
        gpuBusy = false;
        if (comfyui === "idle") {
          try {
            await freeMemory();
            askedComfyUIToFree = true;
            await sleep(FREE_WAIT_MS);
          } catch (error) {
            // Not fatal: llama-server may still fit. If it does not, the documents fail with a clear text.
            console.warn(`Warning: ComfyUI did not free its memory. ${messageOf(error)}`);
          }
        }
      }
      try {
        // The first document starts llama-server. For the next ones it is already running.
        await startTranslateServer();
      } catch (error) {
        // llama-server cannot start. Trying again for every document would only take longer.
        console.error(`Translation: llama-server could not start. ${messageOf(error)}`);
        // ComfyUI is running and was asked to unload, but the model still did not load:
        // most likely a custom node kept its models on the GPU.
        const reason = askedComfyUIToFree
          ? "The GPU is full. Restart ComfyUI, or wait until it is idle, then press Try again."
          : messageOf(error);
        for (const waiting of documents.values()) {
          if (waiting.status !== "waiting") continue;
          waiting.status = "failed";
          waiting.error = reason;
          await saveDocument(waiting);
        }
        break;
      }
      // The document was removed while llama-server was starting: skip it.
      if (!documents.has(doc.id)) continue;
      await handleDocument(doc);
    }
    await stopTranslateServer();
  } catch (error) {
    console.error(`Translation: the worker stopped with an error. ${messageOf(error)}`);
  } finally {
    // llama-server has stopped (or never started): generation jobs are allowed again.
    setTranslationHoldsGpu(false);
    gpuBusy = false;
    working = false;
  }
  // A photo may have arrived while llama-server was stopping.
  if (nextWaiting()) void runWorker();
}

// Run both model calls for one document and save the result.
async function handleDocument(doc: TranslateDocument): Promise<void> {
  const startedAt = Date.now();
  const settings = translateSettings();
  console.log(`Translation: ${doc.id} started.`);
  try {
    // Not "waiting" any more from this moment, so the document cannot be removed while it is worked on.
    doc.status = "reading";
    const photo = await readPhoto(doc.id);
    if (!photo) throw new Error("The photo of this document is not on disk any more.");
    const photoUrl = `data:${photo.info.mediaType};base64,${photo.data.toString("base64")}`;

    // A person corrected the Japanese text (FRG-94): keep it, and do not read the photo again.
    const keepJapanese = doc.japaneseEdited && doc.japanese !== "";
    if (!keepJapanese) {
      doc.japanese = "";
      doc.japaneseEdited = false;
    }
    doc.status = keepJapanese ? "translating" : "reading";
    doc.english = "";
    doc.error = null;
    doc.warnings = [];
    doc.model = settings.modelName;
    doc.imageTokens = `${settings.imageMinTokens}-${settings.imageMaxTokens}`;
    doc.seconds = 0;
    await saveDocument(doc);

    let cutOff = false;
    if (!keepJapanese) {
      // Call 1: photo -> Japanese text.
      const read = await askModel(READ_SYSTEM_TEXT, READ_USER_TEXT, photoUrl);
      if (read.text === "") throw new Error("The model found no text in this photo.");
      doc.japanese = read.text;
      cutOff = read.cutOff;
      doc.status = "translating";
      await saveDocument(doc);
    }

    // Call 2: Japanese text + photo -> translation.
    const translated = await askModel(translateSystemText(settings.targetLanguage, keepJapanese), translateUserText(doc.japanese), photoUrl);
    doc.english = translated.text;
    cutOff = cutOff || translated.cutOff;
    doc.warnings = [...(cutOff ? ["The text may be cut off at the end."] : []), ...checkResult(doc.japanese, doc.english)];
    doc.status = "done";
    console.log(`Translation: ${doc.id} done.`);
  } catch (error) {
    doc.status = "failed";
    doc.error = messageOf(error);
    // The error text is our own wording. It never holds text from the document.
    console.error(`Translation: ${doc.id} failed. ${doc.error}`);
  }
  doc.seconds = Math.round((Date.now() - startedAt) / 1000);
  await saveDocument(doc);
}

// ---------- Checks on a result (FRG-94, spec 11) ----------

// The first three letters of the English month names. "nov" matches "November" and "Nov.".
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Make numbers easy to compare: full-width digits ０-９ become 0-9, and a comma inside a
// number is removed. So "３，８００", "3,800" and "3800" are all "3800".
function plainNumbers(text: string): string {
  return text
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/(?<=[0-9])[,，](?=[0-9])/g, "");
}

// Every run of digits in a text.
function numbersIn(text: string): string[] {
  return plainNumbers(text).match(/[0-9]+/g) ?? [];
}

// Does the same line come `times` or more times in a row? Empty lines do not count.
function hasRepeatedLine(text: string, times: number): boolean {
  let last = "";
  let count = 0;
  for (const line of text.split("\n").map((part) => part.trim())) {
    if (line === "") continue;
    // A table line with nothing in it, such as "| | |" or "|---|---|", is not repeated text (FRG-95).
    if (/^[|\s:-]+$/.test(line)) continue;
    count = line === last ? count + 1 : 1;
    last = line;
    if (count >= times) return true;
  }
  return false;
}

// Look at the two texts and return warnings in plain English. They help a person find mistakes.
// The warnings hold numbers only, never other text from the document.
export function checkResult(japanese: string, english: string): string[] {
  const warnings: string[] = [];

  // 1. Unreadable characters: the model writes □ for each one.
  const unreadable = [...japanese].filter((character) => character === "□").length;
  if (unreadable > 0) {
    warnings.push(unreadable === 1 ? "1 character could not be read." : `${unreadable} characters could not be read.`);
  }

  // 2. Numbers: every number written with digits in the Japanese text must also be in the translation.
  //    "3,800" in the translation counts as 3800.
  const englishNumbers = new Set(numbersIn(english));
  const japaneseNumbers = new Set(numbersIn(japanese));
  for (const number of japaneseNumbers) {
    // A month: "11月" is usually translated as "November", with no digits. That is not a mistake.
    const month = MONTH_NAMES[Number(number) - 1];
    const isMonth = month !== undefined && new RegExp(`(?<![0-9])0?${Number(number)}月`).test(plainNumbers(japanese));
    if (isMonth && english.toLowerCase().includes(month)) continue;
    if (!englishNumbers.has(number)) {
      warnings.push(`The number ${number} is in the Japanese text but not in the translation.`);
    }
  }

  // 4. Repeating text: the same line 5 or more times in a row.
  if (hasRepeatedLine(japanese, 5) || hasRepeatedLine(english, 5)) {
    warnings.push("The model may have got stuck and repeated itself.");
  }
  return warnings;
}

// One call to the model: a system text, a user text and the photo. Returns the answer text,
// and cutOff = true when the model ran out of room before it finished.
async function askModel(systemText: string, userText: string, photoUrl: string): Promise<{ text: string; cutOff: boolean }> {
  let response;
  try {
    response = await fetch(`${translateServerUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        temperature: 0,
        repeat_penalty: 1.1,
        max_tokens: MAX_ANSWER_TOKENS,
        messages: [
          { role: "system", content: systemText },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: photoUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new Error("The translation model did not answer. Press Try again.");
  }
  if (!response.ok) {
    // The answer body is not logged or shown: it could hold text from the document.
    throw new Error(`The translation model refused the request (HTTP ${response.status}). Press Try again.`);
  }
  const body = await response.json();
  const choice = body?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
  return { text, cutOff: choice?.finish_reason === "length" };
}

// ---------- The routes ----------

function sendError(res: Response, error: unknown) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`Translation: a request failed. ${messageOf(error)}`);
  res.status(500).json({ error: "Something went wrong on the server. See the backend log." });
}

// The document for the :id in the address. The id is checked before anything else uses it.
function findDocument(req: Request): TranslateDocument {
  const id = String(req.params.id ?? "");
  const doc = ID_PATTERN.test(id) ? documents.get(id) : undefined;
  if (!doc) throw new HttpError(404, "There is no document with this id.");
  return doc;
}

// iPhone photos are often HEIC files. They start with a "ftyp" box that names the format.
function isHeic(data: Buffer): boolean {
  if (data.length < 12 || data.toString("latin1", 4, 8) !== "ftyp") return false;
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(data.toString("latin1", 8, 12));
}

// GET /api/translate/status
// Answer: { setUp, problem, serverRunning, gpuBusy, waiting }.
// gpuBusy is true while documents wait because ComfyUI has a generation job.
export async function translateStatusHandler(_req: Request, res: Response) {
  const setup = checkTranslateSetup();
  res.json({
    setUp: setup.setUp,
    problem: setup.problem,
    serverRunning: setup.setUp ? await isTranslateServerRunning() : false,
    gpuBusy,
    waiting: waitingCount(),
  });
}

// POST /api/translate/documents?name=<original file name>
// Body: the photo itself (PNG, JPEG or WebP). Makes a document with status "waiting".
// For one page of a PDF file the browser adds &fileId=<12 hex>&page=<n>&pages=<total> (FRG-95).
// Answer: the document record.
export async function createDocumentHandler(req: Request, res: Response) {
  try {
    const setup = checkTranslateSetup();
    if (!setup.setUp) throw new HttpError(503, setup.problem ?? "Translation is not set up.");

    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, "Pick a PNG, JPEG or WebP photo.");
    if (isHeic(data)) throw new HttpError(400, "This photo is a HEIC file. Convert it to JPEG first.");
    // The first bytes tell the image type, so a renamed non-image is refused.
    const info = imageInfo(data);
    if (!info) throw new HttpError(400, "This file is not a PNG, JPEG or WebP image.");

    // The name is only shown on screen. It is never used as a file name on disk.
    const rawName = typeof req.query.name === "string" ? req.query.name : "";
    const originalName = rawName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH) || "photo";

    // One page of a PDF file: the id of the file, the page number, and how many pages the file has.
    let fileId: string | null = null;
    let page = 1;
    let pages = 1;
    if (req.query.fileId !== undefined) {
      fileId = typeof req.query.fileId === "string" && FILE_ID_PATTERN.test(req.query.fileId) ? req.query.fileId : null;
      page = Number(req.query.page);
      pages = Number(req.query.pages);
      const pageOk = Number.isInteger(page) && Number.isInteger(pages) && pages >= 1 && pages <= MAX_PDF_PAGES && page >= 1 && page <= pages;
      if (fileId === null || !pageOk) throw new HttpError(400, "The page information of this PDF page is not valid.");
    }

    const settings = translateSettings();
    const doc: TranslateDocument = {
      id: `tr-${Date.now()}-${randomBytes(3).toString("hex")}`,
      originalName,
      fileId,
      page,
      pages,
      createdAt: new Date().toISOString(),
      createdBy: res.locals.username ?? null, // Set by requireLogin in auth.ts.
      status: "waiting",
      japanese: "",
      japaneseEdited: false,
      english: "",
      error: null,
      warnings: [],
      model: settings.modelName,
      imageTokens: `${settings.imageMinTokens}-${settings.imageMaxTokens}`,
      seconds: 0,
    };
    await mkdir(folderOf(doc.id), { recursive: true });
    await writeFile(path.join(folderOf(doc.id), `source.${info.extension}`), data);
    await saveDocument(doc);
    documents.set(doc.id, doc);

    void runWorker();
    res.status(201).json(doc);
  } catch (error) {
    sendError(res, error);
  }
}

// GET /api/translate/documents
// All documents, newest first, without the two long texts.
export function listDocumentsHandler(_req: Request, res: Response) {
  const list = [...documents.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ japanese: _japanese, english: _english, ...rest }) => rest);
  res.json({ documents: list });
}

// GET /api/translate/documents/:id
// One document with both texts.
export function getDocumentHandler(req: Request, res: Response) {
  try {
    res.json(findDocument(req));
  } catch (error) {
    sendError(res, error);
  }
}

// GET /api/translate/documents/:id/image
// The photo, as uploaded.
export async function documentImageHandler(req: Request, res: Response) {
  try {
    const photo = await readPhoto(findDocument(req).id);
    if (!photo) throw new HttpError(404, "The photo of this document is not on disk any more.");
    res.setHeader("Content-Type", photo.info.mediaType);
    res.send(photo.data);
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/translate/documents/:id/retry
// Run a failed or finished document again, from the photo. Answer: the document record.
export async function retryDocumentHandler(req: Request, res: Response) {
  try {
    const doc = findDocument(req);
    if (doc.status !== "done" && doc.status !== "failed") {
      throw new HttpError(409, "This document is waiting or being worked on. Wait until it is done.");
    }
    doc.status = "waiting";
    doc.error = null;
    // Start from the photo again. A corrected Japanese text is replaced by a new reading.
    doc.japaneseEdited = false;
    await saveDocument(doc);
    void runWorker();
    res.json(doc);
  } catch (error) {
    sendError(res, error);
  }
}

// PUT /api/translate/documents/:id/japanese  (FRG-94)
// Body: { "japanese": "..." }. Saves the corrected Japanese text and translates it again.
// The photo is not read again: only call 2 runs. Answer: the document record.
export async function editJapaneseHandler(req: Request, res: Response) {
  try {
    const doc = findDocument(req);
    if (doc.status !== "done" && doc.status !== "failed") {
      throw new HttpError(409, "This document is waiting or being worked on. Wait until it is done.");
    }
    const japanese = typeof req.body?.japanese === "string" ? req.body.japanese.replace(/\r\n/g, "\n").trim() : "";
    if (japanese === "") throw new HttpError(400, "The Japanese text is empty. Type the text, or press Try again to read the photo again.");
    if (japanese.length > MAX_JAPANESE_LENGTH) {
      throw new HttpError(400, `The Japanese text is too long. The limit is ${MAX_JAPANESE_LENGTH} characters.`);
    }
    doc.japanese = japanese;
    doc.japaneseEdited = true;
    doc.status = "waiting";
    doc.error = null;
    await saveDocument(doc);
    void runWorker();
    res.json(doc);
  } catch (error) {
    sendError(res, error);
  }
}

// GET /api/translate/documents/:id/text
// A .txt download with the file name, the Japanese text and the translation.
export function documentTextHandler(req: Request, res: Response) {
  try {
    const doc = findDocument(req);
    const language = translateSettings().targetLanguage;
    const text = [`File: ${doc.originalName}`, "", "Japanese:", doc.japanese, "", `${language}:`, doc.english, ""].join("\r\n");
    // The download is named after the id, so the user's file name never goes into a header.
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.id}.txt"`);
    res.send(text);
  } catch (error) {
    sendError(res, error);
  }
}

// The title of a document for a person: the file name, and the page for a PDF file.
function titleOf(doc: TranslateDocument): string {
  return doc.fileId ? `${doc.originalName} - page ${doc.page} of ${doc.pages}` : doc.originalName;
}

// GET /api/translate/documents/:id/pdf  (FRG-95)
// A .pdf download with the translation. Tables are drawn as tables.
// For a page of a PDF file, the download holds all pages of that file, in page order.
export async function documentPdfHandler(req: Request, res: Response) {
  try {
    const doc = findDocument(req);
    if (doc.status !== "done") throw new HttpError(409, "This document is not translated yet. Wait until it is done.");
    const problem = pdfFontProblem();
    if (problem) throw new HttpError(503, problem);

    const group = doc.fileId
      ? [...documents.values()].filter((other) => other.fileId === doc.fileId).sort((a, b) => a.page - b.page)
      : [doc];
    const parts: PdfPart[] = group.map((one) => ({ title: titleOf(one), text: one.status === "done" ? one.english : null }));
    const pdf = await makeTranslationPdf(parts);
    // The download is named after the id, so the user's file name never goes into a header.
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.id}.pdf"`);
    res.send(pdf);
  } catch (error) {
    sendError(res, error);
  }
}

// DELETE /api/translate/documents/:id
// Remove a document from the list and from the disk: its photo, its texts and its record.
// For a page of a PDF file, all pages of that file are removed together.
// A document that is being worked on right now cannot be removed. Answer: { removed: <how many> }.
export async function deleteDocumentHandler(req: Request, res: Response) {
  try {
    const doc = findDocument(req);
    const group = doc.fileId ? [...documents.values()].filter((other) => other.fileId === doc.fileId) : [doc];
    if (group.some((one) => one.status === "reading" || one.status === "translating")) {
      throw new HttpError(409, "This document is being worked on. Wait until it is done, then remove it.");
    }
    for (const one of group) {
      // Out of the list first, so the worker cannot pick it up while its folder is removed.
      documents.delete(one.id);
      // The id was checked against ID_PATTERN when the document was made or loaded.
      await rm(folderOf(one.id), { recursive: true, force: true });
    }
    console.log(`Translation: ${group.length} document(s) removed.`);
    res.json({ removed: group.length });
  } catch (error) {
    sendError(res, error);
  }
}
