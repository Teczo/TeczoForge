# Japanese document translation (feature spec)

Put this file at `docs/japanese-translate.md` in the TeczoForge repo.
It is the plan for one feature. It is NOT a ticket. Tickets come from Wroom, one at a time.
Section 14 shows how to cut this plan into small tickets.

Written: 11 November 2026. Model facts in this file were checked on that day.

## 1. What the feature does

A client gave us photos of documents written by hand in Japanese.
The user opens a new "Translate" page, picks one or more photos, and gets for each photo:

1. The Japanese text, typed out (the "transcript").
2. The English translation.

Both are shown next to the photo, so a person can check the result.
Everything runs on System 1. No document, text or image leaves the PC.

## 2. Decisions already made

| Topic | Decision | Why |
|---|---|---|
| Model | Qwen3.8-27B (Apache-2.0), GGUF file, about 20 GB | Newest open Qwen model with vision. One model reads the photo and translates. Free for client work. |
| Model runner | llama.cpp `llama-server.exe` (CUDA build) | It is the only runner where we can set how many image tokens the model gets. That setting matters most for small handwriting. |
| Steps per photo | Two calls: photo to Japanese, then Japanese + photo to English | We keep the Japanese text so a person can check it. No local model reads Japanese handwriting without mistakes. |
| Storage | Files on disk in `data/translations/` | Simple. Works without MongoDB. |
| GPU | The model is loaded only while translating, then unloaded | ComfyUI video jobs need up to 31 GB of the 32 GB. Both cannot be loaded together. |
| Cloud | None | Client documents are private. This feature must never call the Claude API or any other internet service. |

Honest limit: the best published test of local models on handwritten Japanese shows about
1 wrong character in 5. Qwen3.8 has no published score on that test. So the output is a
draft for a person to check, not a finished translation. The page must make checking easy.

## 3. What Jaya does by hand (before the first ticket)

Claude Code must NOT do these steps (CLAUDE.md section 7, rules 5 and 6 in spirit).

1. **Install llama.cpp.** From the llama.cpp GitHub Releases page, download the newest
   Windows CUDA zip (`llama-<build>-bin-win-cuda-13.x-x64.zip`) and the matching
   `cudart-llama-bin-win-cuda-13.x-x64.zip`. Extract both into one folder, for example
   `C:\llama.cpp`. Check: `C:\llama.cpp\llama-server.exe --version`.
2. **Download the model.** From `huggingface.co/unsloth/Qwen3.8-27B-GGUF`, tab "Files",
   download two files into one folder, for example `D:\models\qwen3.8-27b`:
   - the main model: the `UD-Q5_K_M` file (about 20 GB)
   - the vision file: the `mmproj` file (`mmproj-F32.gguf` if it is there, else `mmproj-BF16.gguf`)
3. **Fill in `backend/.env`** (section 6).
4. **NVIDIA setting.** NVIDIA Control Panel > Manage 3D Settings > "CUDA - Sysmem Fallback
   Policy" > "Prefer No Sysmem Fallback". Then a full GPU gives a clear error. Without it,
   Windows quietly uses normal RAM and everything gets 5 to 10 times slower.

## 4. Changes needed in CLAUDE.md

This feature needs new rules. Jaya must add them to CLAUDE.md first. Until then CLAUDE.md
wins and Claude Code must stop and ask.

Proposed text:

- Section 3, new table row: `Translation engine | llama.cpp llama-server | Installed separately on System 1. Not part of this repo.`
- Section 3, ports: `llama-server: http://127.0.0.1:8190 (env var TRANSLATE_PORT). Only the backend talks to it.`
- Section 7, new rule: `The backend may start and stop llama-server.exe (path from LLAMA_SERVER_PATH). It must listen on 127.0.0.1 only. Do not install or update llama.cpp. Do not download model files.`
- Section 7, new rule: `The backend may call ComfyUI POST /free to ask it to unload its models before a translation. This is the only way the app may change ComfyUI's state.`
- Section 7, new rule: `Translation documents are private client data. They never go to the Claude API or any internet service. Do not write document text into logs.`

No new npm packages are needed. Use only Node built-ins: `node:child_process`, `node:fs`, `fetch`.

## 5. How it works

```
Browser --> Backend (Express) --> llama-server (127.0.0.1:8190)   started and stopped by the backend
                 |
                 +--> ComfyUI: "is the queue empty?" then "please unload" (POST /free)
                 +--> data/translations/<id>/   photo, Japanese text, English text
```

1. The browser uploads photos, one request per photo. Each becomes a "document" with status `waiting`.
2. One worker in the backend handles documents one at a time, oldest first.
3. Before the first document, the worker checks the GPU and starts llama-server (section 12).
4. For each document: call 1 makes the Japanese transcript, call 2 makes the English text.
5. When no document is waiting, the worker stops llama-server. The GPU is free again.

## 6. Env vars (add to `backend/.env.example` with these comments)

| Name | Example | Meaning |
|---|---|---|
| `LLAMA_SERVER_PATH` | `C:\llama.cpp\llama-server.exe` | Empty: the feature is off. The page says "Translation is not set up". |
| `TRANSLATE_MODEL_PATH` | `D:\models\qwen3.8-27b\Qwen3.8-27B-UD-Q5_K_M.gguf` | The main model file. |
| `TRANSLATE_MMPROJ_PATH` | `D:\models\qwen3.8-27b\mmproj-F32.gguf` | The vision file. |
| `TRANSLATE_PORT` | `8190` | Port for llama-server. |
| `TRANSLATE_IMAGE_MIN_TOKENS` | `2048` | Lowest number of image tokens per photo. |
| `TRANSLATE_IMAGE_MAX_TOKENS` | `8192` | Highest number of image tokens per photo. |
| `TRANSLATE_CONTEXT` | `24576` | Context size for llama-server. |
| `TRANSLATE_TARGET_LANGUAGE` | `English` | The language to translate into. |

If `LLAMA_SERVER_PATH` is set but a file path does not exist, the status route must say which one.

## 7. How the backend starts llama-server

Use `spawn` from `node:child_process` with an argument list. No shell. `windowsHide: true`.

```
llama-server.exe
  -m <TRANSLATE_MODEL_PATH>
  --mmproj <TRANSLATE_MMPROJ_PATH>
  --host 127.0.0.1 --port <TRANSLATE_PORT>
  --n-gpu-layers all
  --ctx-size <TRANSLATE_CONTEXT>
  -np 1
  --jinja
  --reasoning off
  --image-min-tokens <TRANSLATE_IMAGE_MIN_TOKENS>
  --image-max-tokens <TRANSLATE_IMAGE_MAX_TOKENS>
```

- Ready check: `GET http://127.0.0.1:<port>/health`. HTTP 503 means "still loading". HTTP 200 means ready.
  Wait up to 5 minutes (the first load reads 20 GB from disk). After that: fail with a clear message.
- If `/health` already answers before we start (someone started llama-server by hand): use it, and do not stop it afterwards.
- Stop: kill the child process. Also kill it when the backend exits.
- If the process ends by itself during loading, show the last lines of its output in the backend log.
  A full GPU shows up here as an out-of-memory error.

**Check before coding (T1):** run `llama-server.exe --help` on System 1 and confirm every flag above exists
in the installed build. If one is missing or has a new name, stop and report.

## 8. Backend routes

All are under `/api`, so the login check already applies.

| Route | What it does |
|---|---|
| `GET /api/translate/status` | `{ setUp, problem, serverRunning, gpuBusy, waiting }`. `problem` is a plain-English text or null. |
| `POST /api/translate/documents?name=<original file name>` | Body: the photo itself (same as `POST /api/upload`). Makes a document. Answer: the document record. |
| `GET /api/translate/documents` | All documents, newest first. Without the long texts. |
| `GET /api/translate/documents/:id` | One document with both texts. |
| `GET /api/translate/documents/:id/image` | The photo. |
| `POST /api/translate/documents/:id/retry` | Run a failed or finished document again. |
| `PUT /api/translate/documents/:id/japanese` | Body `{ "japanese": "..." }`. Saves the corrected Japanese and runs call 2 again (ticket T5). |
| `GET /api/translate/documents/:id/text` | A `.txt` download: file name, Japanese, English. |

Upload rules: reuse `IMAGE_TYPES`, `MAX_UPLOAD_BYTES` and `imageInfo()` from the existing upload code.
PNG, JPEG or WebP only, checked by the first bytes. iPhone HEIC photos are refused with:
"This photo is a HEIC file. Convert it to JPEG first."
The `name` value is only shown on screen. Never use it as a file name on disk. Cut it to 120 characters.
`:id` must match `^tr-[0-9]+-[0-9a-f]{6}$` before it is used in any path.

There is no delete route in the first version (CLAUDE.md section 7, rule 7).

## 9. The two model calls

Both go to `POST http://127.0.0.1:<port>/v1/chat/completions`. The photo is sent as base64 text.

```jsonc
{
  "temperature": 0,
  "repeat_penalty": 1.1,
  "max_tokens": 4096,
  "messages": [
    { "role": "system", "content": "<system text below>" },
    { "role": "user", "content": [
      { "type": "text", "text": "<user text below>" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,<photo>" } }
    ] }
  ]
}
```

The answer text is in `choices[0].message.content`. If `choices[0].finish_reason` is `"length"`,
save a warning: "The text may be cut off at the end."

**Check before coding (T2):** send one test photo and confirm the server accepts `repeat_penalty`
in this request. If it does not, move it to the start command as `--repeat-penalty 1.1`.

### Call 1: photo to Japanese

System text:

```
You are a careful transcriber of handwritten Japanese documents.
Write out exactly the text that is written in the image, in Japanese.
Rules:
- Keep the reading order of the page. Vertical text is read top to bottom, columns right to left.
- One line of the page is one line of your answer. Keep tables as rows, cells separated by " | ".
- Copy numbers, dates, names and codes exactly as written.
- If you cannot read a character, write □ for it. Never guess. Never complete a sentence.
- Do not translate. Do not explain. Do not add anything that is not on the page.
Answer with the transcript only.
```

User text: `Transcribe this document.`

### Call 2: Japanese + photo to English

System text (put the value of `TRANSLATE_TARGET_LANGUAGE` in place of English):

```
You are a careful translator of Japanese business and technical documents into English.
You get a transcript of a handwritten document and the photo of the same document.
The transcript was made by a machine and may contain wrong characters. □ marks an unreadable character.
Rules:
- Translate the transcript faithfully, line by line, in the same order.
- Copy all numbers, dates, units and codes exactly.
- Write names of people and places in romaji, with the original Japanese in brackets the first time.
- Where the transcript has □, or a word makes no sense, look at the photo. If you are still not sure, write [unclear] and keep going. Never invent text.
- Do not add comments, summaries or explanations.
Answer with the translation only.
```

User text: `Transcript:\n<the Japanese text>\n\nTranslate this document.`

These prompts are a starting point. Nobody has published a tested prompt for this job.
Keep both prompts together in one small file (`translatePrompt.ts`), like `chatPrompt.ts`, so they are easy to change.

## 10. Files on disk

```
data/translations/
  tr-1794373826681-a1b2c3/
    source.jpg        the photo, as uploaded
    record.json       see below
    japanese.txt      the transcript (also inside record.json)
    english.txt       the translation (also inside record.json)
```

`record.json`:

```jsonc
{
  "id": "tr-1794373826681-a1b2c3",
  "originalName": "page 03.jpg",
  "createdAt": "2026-11-11T05:10:17.496Z",
  "createdBy": "<username>",
  "status": "waiting",          // waiting | reading | translating | done | failed
  "japanese": "",
  "japaneseEdited": false,      // true after a person corrected it (T5)
  "english": "",
  "error": null,                // plain-English text when status is failed
  "warnings": [],               // plain-English texts, see section 11
  "model": "Qwen3.8-27B-UD-Q5_K_M.gguf",   // file name of TRANSLATE_MODEL_PATH
  "imageTokens": "2048-8192",
  "seconds": 0                  // time for both calls
}
```

`data/` is already in `.gitignore`. If the backend restarts, documents with status `reading` or
`translating` go back to `waiting`.

## 11. Checks the backend does on each result

1. **Unreadable characters.** Count `□` in the transcript. If more than 0, add the warning
   "N characters could not be read."
2. **Numbers.** Collect every run of digits in the transcript (change full-width digits ０-９ to 0-9 first).
   Each one must also be in the English text. For each missing one, add the warning
   `The number 1234 is in the Japanese text but not in the translation.`
3. **Empty answer.** If call 1 gives no text, status is `failed` with "The model found no text in this photo."
4. **Repeating text.** If the same line comes 5 or more times in a row, add the warning
   "The model may have got stuck and repeated itself."

## 12. Sharing the GPU with ComfyUI

Before the worker starts llama-server:

1. `GET {COMFYUI_URL}/queue`. If a job is running or waiting: do not start. Documents stay `waiting`.
   The status route says `gpuBusy: true`. Check again every 10 seconds.
2. `POST {COMFYUI_URL}/free` with body `{"unload_models": true, "free_memory": true}`.
   **Check before coding (T4):** confirm this route on the installed ComfyUI 0.39.0. If it is not there, stop and report.
3. If ComfyUI is not running at all: skip both steps and go on.
4. Start llama-server (section 7).

While llama-server is running, a new generation job would not fit on the GPU.
So in T4: while the translation worker holds the GPU, `POST /api/jobs` and the other routes that
send work to ComfyUI answer HTTP 409 with
"The GPU is busy with a translation. Try again in a minute."
Find the one place where jobs are sent to ComfyUI and put the check there. If there is more than
one place, stop and ask.

Some ComfyUI custom nodes keep their models in memory even after `/free`. If llama-server then
fails to load, the document fails with:
"The GPU is full. Restart ComfyUI, or wait until it is idle, then press Try again."

## 13. The Translate page (frontend)

- New page name `translate` in `AppShell.tsx` (`Page` type and the sidebar list). Label "Translate",
  icon `Languages` from `lucide-react`. Address `#/translate`. New file `TranslatePage.tsx`.
  Tailwind classes only (CLAUDE.md section 14).
- Top: "Add photos" button (file picker, many files allowed) and a drop area. Photos upload one at a time.
- If `setUp` is false: show the `problem` text and nothing else.
- If `gpuBusy` is true: show "The GPU is busy with a generation job. Translation starts when it finishes."
- Left: the list of documents, newest first: small photo, file name, status in words
  ("Waiting", "Reading the handwriting", "Translating", "Done", "Failed"), warning count.
  While any document is not done, ask the backend again every 2 seconds.
- Right, for the picked document: the photo (big, can scroll, click to open full size),
  then the Japanese text (`lang="ja"`), then the English text. Each text has a "Copy" button.
  Warnings in a yellow box above the texts. "Download .txt" button. "Try again" button.
- Under the result, in small grey text: model file name, image tokens, seconds.
- Always show this line above the texts:
  "Machine reading of handwriting makes mistakes. Check the Japanese text against the photo."

## 14. Suggested tickets (Jaya makes these in Wroom)

Each ticket is small and can be tested alone.

| # | Ticket | Exit criteria |
|---|---|---|
| T1 | Backend: start and stop llama-server, status route | With `.env` filled in, a small test script (`npm run translate-test`) starts the server, sends the text "Say OK", prints the answer, stops the server. Task Manager shows GPU memory going back down. With `.env` empty, `GET /api/translate/status` says not set up, and the backend still starts. |
| T2 | Backend: documents, worker, the two calls, files on disk | Uploading one photo with `curl` gives a folder in `data/translations/` with `japanese.txt` and `english.txt`. Three photos uploaded together are done one after another, then llama-server stops. |
| T3 | Frontend: Translate page | Jaya can add photos, watch the status change, and read both texts next to the photo. |
| T4 | GPU sharing with ComfyUI | Translation waits while a ComfyUI job runs. Generation is refused with a clear message while a translation runs. After a translation, a video job works as before. |
| T5 | Checking tools | The warnings from section 11 show on the page. Jaya can correct the Japanese text and get a new English text without reading the photo again. "Download .txt" works. |

T2 needs T1. T3 needs T2. T4 and T5 can come in either order.

## 15. Not in the first version

- HEIC photos, rotating or cropping photos in the app. (PDF files were added later: section 17.)
- Cutting a big page into tiles. (If small writing is read badly, this is the first thing to try next.)
- MongoDB records, projects, gallery entries for translations.
- Deleting documents.
- Choosing the model on the page. To test another model: change `TRANSLATE_MODEL_PATH` and
  `TRANSLATE_MMPROJ_PATH` in `.env` and restart the backend. Each result records which model made it.

## 16. How Jaya tests the result

1. Pick 10 to 20 of the client's photos. Include the hardest ones.
2. Run them. For each, compare the Japanese text with the photo first. The English can only be as good as the Japanese.
3. Note: wrong characters, missing lines, invented text, wrong numbers.
4. If the reading is poor, try in this order, one change at a time:
   - `TRANSLATE_IMAGE_MAX_TOKENS=16384` (and `TRANSLATE_CONTEXT=40960`)
   - crop the photos to the written area before upload
   - the `UD-Q6_K` model file (about 22 GB)
   - the model Qwen3-VL-8B-Instruct (`unsloth/Qwen3-VL-8B-Instruct-GGUF`). It is older, but it is
     the only local model with a published score on handwritten Japanese (about 79% of characters right).

## 17. PDF files and tables (FRG-95, added later)

Three things were added on top of the first version.

**Tables.** The model now writes a table as a Markdown table: every row starts and ends with `|`,
and the second line is `|---|---|`. Both prompts in `backend/src/translatePrompt.ts` say so
(the prompt texts in section 9 are the first version; the file is the truth).
`translateTables.ts` (the same small file in `backend/src/` and in `frontend/src/`) cuts a text
into plain text and tables. The page shows the tables as real tables. Edit, Copy and
"Download .txt" still use the plain text.
A merged cell cannot be written in this form: its text goes into the first cell, the others stay empty.
An old document keeps its old text until "Try again" is pressed.

**PDF files in.** The model reads pictures, not PDF files. So the browser cuts a PDF into pages
(`frontend/src/pdfPages.ts`, package `pdfjs-dist`) and uploads each page as a PNG picture
(200 dots per inch, longest side at most 3000) through the normal upload route. The PDF itself never
leaves the browser. Each page is its own document. `record.json` has three new fields:
`fileId` (the same for all pages of one file, or null for a photo), `page` and `pages`.
The limit is 30 pages for one PDF file.
`frontend/public/pdfjs/` holds copies of two folders from the `pdfjs-dist` package (`wasm` and
`cmaps`). Some PDFs need them. Copy them again when `pdfjs-dist` is updated.

**PDF files out.** `GET /api/translate/documents/:id/pdf` gives the translation as a PDF
(`backend/src/translatePdf.ts`, package `pdfkit`). Tables are drawn as tables. For a page of a PDF
file, the download holds all pages of that file, in order; a page that is not done yet says so.
Only the translation is in the PDF, not the Japanese text and not the warnings.
The font comes from `TRANSLATE_PDF_FONT_PATH` (Yu Gothic from Windows by default), because a
translation keeps Japanese names in brackets.
