import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { imageInfo } from "./inputs.js";
import type { ImageInfo } from "./inputs.js";
import { IMAGE_TYPES } from "./upload.js";
import { READ_SYSTEM_TEXT, READ_USER_TEXT, translateSystemText, translateUserText } from "./translatePrompt.js";
import {
  checkTranslateSetup,
  isTranslateServerRunning,
  startTranslateServer,
  stopTranslateServer,
  translateServerUrl,
  translateSettings,
} from "./translateServer.js";

// Japanese translation: documents (FRG-91, plan: docs/japanese-translate.md).
// A "document" is one uploaded photo with its Japanese text and its translation.
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
// The most text one model call may write.
const MAX_ANSWER_TOKENS = 4096;
// How long to wait for one model call.
const CALL_TIMEOUT_MS = 10 * 60 * 1000;
// The body types the upload route reads. The first bytes decide what the file really is.
// HEIC is read too, only so we can refuse it with a clear message.
export const TRANSLATE_UPLOAD_TYPES = [...IMAGE_TYPES, "image/heic", "image/heif", "application/octet-stream"];

type Status = "waiting" | "reading" | "translating" | "done" | "failed";

// This is record.json (spec 10).
type TranslateDocument = {
  id: string;
  originalName: string;
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
    for (let doc = nextWaiting(); doc; doc = nextWaiting()) {
      try {
        // The first document starts llama-server. For the next ones it is already running.
        await startTranslateServer();
      } catch (error) {
        // llama-server cannot start. Trying again for every document would only take longer.
        console.error(`Translation: llama-server could not start. ${messageOf(error)}`);
        for (const waiting of documents.values()) {
          if (waiting.status !== "waiting") continue;
          waiting.status = "failed";
          waiting.error = messageOf(error);
          await saveDocument(waiting);
        }
        break;
      }
      await handleDocument(doc);
    }
    await stopTranslateServer();
  } catch (error) {
    console.error(`Translation: the worker stopped with an error. ${messageOf(error)}`);
  } finally {
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
    const photo = await readPhoto(doc.id);
    if (!photo) throw new Error("The photo of this document is not on disk any more.");
    const photoUrl = `data:${photo.info.mediaType};base64,${photo.data.toString("base64")}`;

    doc.status = "reading";
    doc.japanese = "";
    doc.japaneseEdited = false;
    doc.english = "";
    doc.error = null;
    doc.warnings = [];
    doc.model = settings.modelName;
    doc.imageTokens = `${settings.imageMinTokens}-${settings.imageMaxTokens}`;
    doc.seconds = 0;
    await saveDocument(doc);

    // Call 1: photo -> Japanese text.
    const read = await askModel(READ_SYSTEM_TEXT, READ_USER_TEXT, photoUrl);
    if (read.text === "") throw new Error("The model found no text in this photo.");
    doc.japanese = read.text;
    if (read.cutOff) doc.warnings.push("The text may be cut off at the end.");
    doc.status = "translating";
    await saveDocument(doc);

    // Call 2: Japanese text + photo -> translation.
    const translated = await askModel(translateSystemText(settings.targetLanguage), translateUserText(doc.japanese), photoUrl);
    doc.english = translated.text;
    if (translated.cutOff && !read.cutOff) doc.warnings.push("The text may be cut off at the end.");
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
// Answer: { setUp, problem, serverRunning, gpuBusy, waiting }. gpuBusy gets its real value in FRG-93.
export async function translateStatusHandler(_req: Request, res: Response) {
  const setup = checkTranslateSetup();
  res.json({
    setUp: setup.setUp,
    problem: setup.problem,
    serverRunning: setup.setUp ? await isTranslateServerRunning() : false,
    gpuBusy: false,
    waiting: waitingCount(),
  });
}

// POST /api/translate/documents?name=<original file name>
// Body: the photo itself (PNG, JPEG or WebP). Makes a document with status "waiting".
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

    const settings = translateSettings();
    const doc: TranslateDocument = {
      id: `tr-${Date.now()}-${randomBytes(3).toString("hex")}`,
      originalName,
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
