# TeczoForge Studio — "Translate" (Japanese handwriting to English) (FRG-90 to FRG-94)

Tickets for the Japanese translation feature. Run them in order, one at a time.
Each ticket follows `CLAUDE.md` (git rules, definition of done, report format).

**Wroom is not connected right now.** This file takes its place. Treat each ticket below
exactly like a Wroom ticket. Ticket refs FRG-90 to FRG-94 follow the last Wroom ticket (FRG-89).
If Wroom is used again later, Jaya adds these tickets there with the same numbers.

**The full plan is `docs/japanese-translate.md`.** Read it before every ticket.
Section numbers below ("spec 7") point to that file. T1 to T5 in the spec are FRG-90 to FRG-94 here.

**Goal of the whole feature:** on a new **Translate** page, Jaya adds photos of handwritten
Japanese documents. For each photo, TeczoForge shows the Japanese text and the English translation
next to the photo. Everything runs on System 1. Nothing leaves the PC.

**What is already done (not part of any ticket)**

1. llama.cpp build 12282 (CUDA 13.5) is in `C:\llama.cpp`. `llama-server.exe --list-devices`
   shows `CUDA0: NVIDIA GeForce RTX 5090`. Checked on 11 Nov 2026.
2. The Qwen3.8-27B model file and its `mmproj` file are downloaded by Jaya.
3. `backend/.env` has the translation env vars from spec 6 (Jaya filled them in).
4. NVIDIA "CUDA - Sysmem Fallback Policy" is set to "Prefer No Sysmem Fallback".
5. `CLAUDE.md` has the new rules: section 3 (engine row, port 8190), section 5 (`POST /free`),
   section 7 rules 9, 10 and 11.

**Rules for all tickets**

1. No new npm dependency. Use only Node built-ins: `node:child_process`, `node:fs`, `fetch`.
2. Start `llama-server.exe` with `spawn` and an argument list. No shell. `windowsHide: true`.
3. Do not install or update llama.cpp. Do not download model files. Jaya does this by hand.
4. Client documents are private. Never send them, or their text, to the Claude API or any
   internet service. Never write document text into logs.
5. Do not change how Generate, Games, Packs, Avatar, chains or the existing presets work,
   except where FRG-93 says so.
6. If something fails 2 times with the same error, stop and report. Do not keep retrying.
7. If a ticket and `CLAUDE.md` disagree, `CLAUDE.md` wins. Say so in the report.

---

## FRG-90 — Start and stop llama-server, and the status route

**Branch:** `feat/FRG-90-llama-server-start-stop`

**Goal:** The backend can start llama-server, check that it is ready, send it one message,
and stop it again. The GPU memory goes back down afterwards.

**Check before coding:** run `C:\llama.cpp\llama-server.exe --help` on System 1. Confirm that
every flag in spec 7 exists in this build. If one is missing or has a new name, stop and report.

**In scope**

1. Read the env vars from spec 6. Add them to `backend/.env.example` with the comments from spec 6.
2. If `LLAMA_SERVER_PATH` is empty: the feature is off. If it is set but a file path does not
   exist: say which one (`problem` text).
3. Start llama-server with the exact arguments in spec 7.
4. Ready check: `GET /health`. 503 means still loading. 200 means ready. Wait up to 5 minutes,
   then fail with a clear message.
5. If `/health` already answers before we start (Jaya started it by hand): use it, and do not stop it.
6. Stop: kill the child process. Also kill it when the backend exits.
7. If the process ends by itself while loading, write its last output lines to the backend log.
8. Route `GET /api/translate/status` (spec 8). In this ticket `gpuBusy` is always `false`
   and `waiting` is always `0`.
9. Test script `npm run translate-test` (in `backend/package.json`): starts the server,
   sends the text "Say OK", prints the answer, stops the server.

**Out of scope:** documents, photos, the two model calls (FRG-91), ComfyUI (FRG-93), the page (FRG-92).

**Exit criteria**

1. With `.env` filled in, `npm run translate-test` prints an answer from the model and stops the server.
   Task Manager shows GPU memory going back down.
2. With `LLAMA_SERVER_PATH` empty, `GET /api/translate/status` says it is not set up, and the backend still starts.
3. With a wrong model path, the status says which path is wrong.
4. `tsc --noEmit` passes. No new dependency.

**Stop and report if:** a flag is missing in `--help`, or the model runs out of GPU memory while loading.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-91 — Documents, the worker, the two model calls, files on disk

**Branch:** `feat/FRG-91-translate-documents-worker`

**Goal:** Uploading a photo makes a document. The backend reads it into Japanese, translates it
to English, and saves both on disk.

**Needs from Jaya before starting:** 2 or 3 test photos of handwritten Japanese. Jaya says where they are.

**Check before coding:** send one test photo and confirm the server accepts `repeat_penalty`
in the request body (spec 9). If it does not, move it to the start command as `--repeat-penalty 1.1`.

**In scope**

1. Routes from spec 8, except `PUT .../japanese` (that is FRG-94).
   1. Upload rules from spec 8: reuse `IMAGE_TYPES`, `MAX_UPLOAD_BYTES` and `imageInfo()`.
   2. HEIC photos are refused with "This photo is a HEIC file. Convert it to JPEG first."
   3. The `name` value is only shown on screen. Never a file name on disk. Cut to 120 characters.
   4. `:id` must match `^tr-[0-9]+-[0-9a-f]{6}$` before it is used in any path.
2. Files on disk and `record.json` exactly as in spec 10.
3. One worker. One document at a time, oldest first (spec 5).
4. The two calls with the prompts in spec 9. Prompts live in `translatePrompt.ts`.
5. If `finish_reason` is `"length"`, add the warning "The text may be cut off at the end."
6. Empty answer from call 1: status `failed`, "The model found no text in this photo."
7. When no document is waiting, stop llama-server.
8. After a backend restart, documents with status `reading` or `translating` go back to `waiting`.
9. `GET /api/translate/status` now gives the real `serverRunning` and `waiting`.

**Out of scope:** the page (FRG-92), ComfyUI sharing (FRG-93), the other checks in spec 11 (FRG-94).

**Exit criteria**

1. Uploading one photo with `curl` gives a folder in `data/translations/` with `source.*`,
   `record.json`, `japanese.txt` and `english.txt`.
2. Three photos uploaded together are done one after another. Then llama-server stops.
3. A HEIC file and a text file renamed to `.jpg` are refused with clear messages.
4. The backend log has no document text in it.
5. `tsc --noEmit` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-92 — The Translate page

**Branch:** `feat/FRG-92-translate-page`

**Goal:** Jaya can add photos on a page, watch the status change, and read both texts next to the photo.

**In scope**

1. Everything in spec 13. New page `translate` in `AppShell.tsx`, label "Translate",
   icon `Languages`, address `#/translate`, new file `TranslatePage.tsx`. Tailwind classes only.
2. "Add photos" button and drop area. Photos upload one at a time.
3. If `setUp` is false, show only the `problem` text.
4. List on the left, result on the right, "Copy" buttons, "Download .txt", "Try again".
5. The line "Machine reading of handwriting makes mistakes. Check the Japanese text against the photo."
   is always shown above the texts.
6. While any document is not done, ask the backend again every 2 seconds.

**Out of scope:** the GPU-busy message (FRG-93), warnings box details and editing the Japanese (FRG-94).

**Exit criteria**

1. The sidebar shows Translate. It opens `#/translate`.
2. Jaya adds 3 photos and sees each status change, then reads both texts next to each photo.
3. Copy, Download .txt and Try again work.
4. Other pages look and work as before.
5. `tsc --noEmit` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-93 — Share the GPU with ComfyUI

**Branch:** `feat/FRG-93-translate-gpu-sharing`

**Goal:** A translation and a ComfyUI job never use the GPU at the same time.

**Check before coding:** confirm that `POST /free` exists on the installed ComfyUI 0.39.0.
If it is not there, stop and report.

**In scope**

1. Everything in spec 12:
   1. Before starting llama-server: `GET {COMFYUI_URL}/queue`. If a job is running or waiting,
      do not start. `gpuBusy: true`. Check again every 10 seconds.
   2. Then `POST {COMFYUI_URL}/free` with `{"unload_models": true, "free_memory": true}`.
   3. If ComfyUI is not running, skip both steps.
2. While the translation worker holds the GPU, `POST /api/jobs` and the other routes that send
   work to ComfyUI answer HTTP 409 "The GPU is busy with a translation. Try again in a minute."
   Find the one place where work goes to ComfyUI and put the check there.
   If there is more than one place, stop and ask.
3. If llama-server fails to load after `/free`, the document fails with
   "The GPU is full. Restart ComfyUI, or wait until it is idle, then press Try again."
4. The Translate page shows the `gpuBusy` message from spec 13.

**Out of scope:** any change to ComfyUI itself or its custom nodes (CLAUDE.md section 7 rule 6).

**Exit criteria**

1. Translation waits while a ComfyUI job runs, then starts by itself.
2. Generate is refused with the clear message while a translation runs.
3. After a translation, a video job works as before.
4. `tsc --noEmit` passes. No new dependency.

**Stop and report if:** `/free` does not exist, or there is more than one place that sends work to ComfyUI.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-94 — Checking tools

**Branch:** `feat/FRG-94-translate-checking-tools`

**Goal:** The page helps Jaya find mistakes, and he can fix the Japanese text and translate it again.

**In scope**

1. The checks in spec 11: unreadable characters (□), numbers missing in the English text
   (change full-width digits to normal digits first), and repeating lines (5 or more in a row).
2. Warnings show in a yellow box above the texts, and the warning count shows in the list.
3. `PUT /api/translate/documents/:id/japanese`: saves the corrected Japanese, sets
   `japaneseEdited: true`, and runs call 2 again. It does not read the photo again with call 1.
4. On the page: an "Edit" button on the Japanese text, and "Save and translate again".

**Out of scope:** everything in spec 15.

**Exit criteria**

1. A photo with an unreadable part shows "N characters could not be read."
2. If the English is missing a number from the Japanese, the warning names that number.
3. Jaya corrects the Japanese text and gets a new English text without call 1 running again.
4. "Download .txt" has the corrected text.
5. `tsc --noEmit` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## Later (not tickets yet)

See spec 15 and spec 16. The first thing to try if small writing is read badly:
a higher `TRANSLATE_IMAGE_MAX_TOKENS`, then cutting a page into tiles.
