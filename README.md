# TeczoForge — App Audit & Roadmap

> A private, self-hosted image and video generator for the Teczo team, similar in idea to Higgsfield.
> You pick a preset, type a prompt, and press **Generate**. ComfyUI does the work on our own GPU.

This file is an audit of the app as of **2026-10-07**. It covers what is built, how it works, what is
weak or risky, and what is coming next. It is written for brainstorming improvements.
`CLAUDE.md` is still the source of truth for rules and decisions.

---

## 1. At a glance

| | |
|---|---|
| **Status** | Phases 0–3 done. Phase 4 partly done (team login is merged; LAN access is on a branch that is not merged). |
| **Works well** | Text to image, image to image, image to video, gallery, live progress, team login |
| **Stack** | Vite + React 19 + TypeScript (frontend) · Node + Express 5 + TypeScript (backend) · MongoDB Atlas · ComfyUI 0.39 |
| **Hardware** | "System 1": Windows 11, RTX 5090 (32 GB VRAM), 128 GB RAM |
| **Size** | About 1,300 lines of backend TS, about 1,500 lines of frontend TSX, about 1,300 lines of CSS |
| **Dependencies** | Very few: backend `express`, `mongodb`, `dotenv`; frontend `react`, `react-dom` |
| **Tests / lint** | None yet. `tsc --noEmit` passes for both backend and frontend. |

---

## 2. Architecture

```
Browser (React, port 5173)
   │  only talks to /api
   ▼
Backend (Express, 127.0.0.1:4000) ──► ComfyUI (127.0.0.1:8188)   HTTP + one WebSocket for progress
   │
   ├──► MongoDB Atlas   jobs + users   (optional: generating still works when it is offline)
   └──► data/outputs/   finished .png / .mp4 files
```

**Main design ideas**

- **Presets are folders.** `presets/<id>/workflow.json` (a ComfyUI API export) and `preset.json`
  (which user inputs map to which node and field). A new preset needs no code change.
- **The browser never talks to ComfyUI.** ComfyUI has no login and its custom nodes can run code on the PC.
- **No second queue.** ComfyUI's own queue is used. The backend only tracks status.
- **MongoDB can fail without breaking generation.** You see a warning, not a crash.
- **Login is stateless.** A signed HMAC cookie means logged-in users keep working when Atlas is down.

### Backend files (`backend/src/`)

| File | What it does |
|---|---|
| `server.ts` | Routes, login check, static file serving for outputs, JSON error handling |
| `generate.ts` | `POST /api/generate`: load preset → build workflow → queue → wait → copy output → save job |
| `presets.ts` | List and load presets, check user inputs (text / seed / number / image), put values into the workflow |
| `comfyui.ts` | ComfyUI client: queue, history polling, upload, view, error parsing |
| `progress.ts` | One WebSocket to ComfyUI. Maps the page's job id to ComfyUI's prompt id, plus queue position |
| `upload.ts` | Raw image upload. Checks the file's first bytes (magic bytes). 20 MB limit. Our own file name. |
| `auth.ts` | scrypt password hashes, HMAC session cookie (7 days), `requireLogin` middleware |
| `db.ts` | Mongo connection with a 3 s timeout, `jobs` and `users` collections, hides the connection string in logs |
| `setUser.ts` | CLI `npm run user -- <name>` to create an account or reset a password |

### API

| Method | Route | Login? | Purpose |
|---|---|---|---|
| POST | `/api/login` | no | Log in, sets the session cookie |
| POST | `/api/logout` | no | Clears the cookie |
| GET | `/api/me` | yes | Who is logged in |
| GET | `/api/health` | yes | Backend + ComfyUI reachable? |
| GET | `/api/presets` | yes | Preset list (node ids stay hidden from the page) |
| POST | `/api/upload` | yes | Upload a start image → ComfyUI input folder |
| POST | `/api/generate` | yes | Run a preset. **Blocks until done** (up to 20 min) |
| GET | `/api/progress/:jobId` | yes | starting / waiting (jobs ahead) / running (step x of y) / finishing |
| GET | `/api/jobs` | yes | **Whole** job history, newest first |
| GET | `/api/outputs/*` | yes | Finished files |

### Frontend (`frontend/src/`)

- `App.tsx`: login gate, header with Backend/ComfyUI status, user menu, page switch by URL hash (`#/`, `#/gallery`).
- `Generate.tsx`: three columns. **Sidebar** (categories + models), **Create panel** (image upload,
  prompt, preset picker, Quick Prompts, Advanced Settings, Generate), **Result panel** (large view,
  download, full screen, strip of the 10 latest results).
- `Gallery.tsx`: grid of finished jobs → detail view (prompt, maker, preset, seed, size, time) with **Use again** and **Download**.
- `Media.tsx`: shows `<img>` or `<video>` based on the file ending.
- `Icons.tsx`, `Logo.tsx`, `Login.tsx`, `styles.css`: dark theme, inline SVG icons, no UI library.

---

## 3. Features that work today

### Generation presets

| Preset | Model | Inputs | Speed (measured) |
|---|---|---|---|
| **Text to Image** (`text-to-image-basic`) | Z-Image-Turbo bf16, 8 steps | prompt, seed, width, height (default 1024²) | about 2.7 s warm, 7.9 s cold |
| **Image to Image** (`image-to-image-basic`) | Z-Image-Turbo, denoise 0.8, about 1 MP | start image, prompt, seed | a few seconds |
| **Image to Video** (`image-to-video-basic`) | Wan 2.2 14B I2V fp8 (high + low noise), 20 steps | start image, motion prompt, seed | **about 266 s** for 5 s of video, 640², 16 fps. Peak VRAM about 29–31 GB |

### App features

- ✅ Preset picker built from `preset.json`, grouped by category (Image / Image to Video, …)
- ✅ Image upload with a preview, file type and size checks in the browser and in the backend
- ✅ Live progress: queue position ("2 jobs ahead"), step progress bar, "Saving the result…"
- ✅ Random seed by default, or a fixed seed you type, with a shuffle button
- ✅ Result viewer with download and full screen. Videos autoplay, loop and are muted.
- ✅ Recent results strip on the Generate page
- ✅ Gallery with video tags, a detail view and "made by"
- ✅ **Use again**: fills the Generate form from a gallery job
- ✅ Every job is saved to MongoDB (also failed ones, with the error), including the seed that was used
- ✅ Team login (usernames + scrypt hashes in Mongo, accounts made by CLI, no sign-up page)
- ✅ Clear, plain-English error messages, for example "ComfyUI is not running", a missing model from `node_errors`, or a file that is too big
- ✅ One-click start: `start-teczoforge.bat` starts ComfyUI, waits for it, then starts the backend and frontend and opens the browser

---

## 4. Audit findings

Severity: 🔴 fix soon · 🟠 important before team or remote use · 🟡 improvement · 🟢 good as is

### 4.1 Security

| # | Sev | Finding | Suggestion |
|---|---|---|---|
| S1 | 🔴 | `backend/.env` has **no `SESSION_SECRET`**, so a random key is made at every start and everyone is logged out on each backend restart (and `tsx watch` restarts on every save). | Add a 64-hex-character secret to `backend/.env`. |
| S2 | 🟠 | **No limit on login attempts.** Passwords can be guessed again and again (scrypt slows it down but does not stop it). It matters once the app is on the LAN or Tailscale. | A simple in-memory counter per IP and per username, for example 5 tries then a 1 minute wait. |
| S3 | 🟠 | Sessions **cannot be revoked.** Log out only deletes the cookie in the browser. A copied cookie works for 7 days, also after a password reset. | Store a `sessionVersion` on the user and put it in the cookie. A password reset increases it. Or keep a small session list in Mongo. |
| S4 | 🟠 | The cookie has no `Secure` flag. That is fine on http://localhost, but needed if Tailscale HTTPS (`tailscale serve`) is used. | Set `secure` when the request comes over HTTPS. |
| S5 | 🟡 | No user roles. Every user can see every job, and there is no admin view (users, disk, queue). | Add a `role: "admin"` field later for delete and user management. |
| S6 | 🟡 | `GET /api/progress/:jobId` does not check the format of the id (harmless: it is only a map lookup). | Use the same UUID check as `/generate`. |
| S7 | 🟢 | Good: ComfyUI is on localhost only. Preset ids are checked against a pattern (no path tricks). Unknown input keys are refused. Image names are checked. Uploads are checked by magic bytes and renamed. Secrets are hidden in logs. The same error is shown for a wrong user and a wrong password. HttpOnly + SameSite=Lax cookie. Timing-safe compares. | — |

### 4.2 Reliability and correctness

| # | Sev | Finding | Suggestion |
|---|---|---|---|
| R1 | 🔴 | **`/api/generate` keeps one HTTP request open for the whole job** (videos take about 4.5 min, the limit is 20 min). If the user refreshes, closes the tab, or the network drops, the page loses the job. The backend still finishes and saves it, but the user only sees it later in the gallery. | Make it async: `POST /api/jobs` answers at once with a job id. The page then polls `/api/jobs/:id` (or uses SSE). This also makes a "My running jobs" view possible. |
| R2 | 🔴 | **Jobs are written to Mongo only at the end.** A backend restart during a job means: ComfyUI still makes the file, but it is never copied to `data/outputs` and never recorded. | Insert a `queued` record first, then update it to `running` / `done` / `failed`. When the backend starts, check ComfyUI `/history` for jobs that were still open. |
| R3 | 🟠 | **There is no Cancel.** `POST /interrupt` and removing from the queue are not used. A wrong 5-minute video blocks the GPU for everyone. | A Cancel button: `/interrupt` if it is running, `POST /queue {delete:[id]}` if it is waiting. |
| R4 | 🟠 | **Start images are not kept by the app.** They live only in ComfyUI's `input/` folder. "Use again" for image-to-image or image-to-video breaks if that folder is cleaned, and the gallery detail does not show the start image. | Copy uploads to `data/inputs/`, save the path on the job, and show "Start image → Result" in the detail view. |
| R5 | 🟠 | **`GET /api/jobs` returns every job with no paging.** The Generate page loads the whole history just to show 10 thumbnails. It gets slow as the history grows. | Add `?limit=&before=` (cursor on `createdAt`), add a Mongo index on `createdAt`, and add infinite scroll in the gallery. |
| R6 | 🟡 | Video progress looks odd: Wan runs **two samplers** (high noise, then low noise), so the bar goes 0→100% two times. Then the VAE decode and video encode show nothing. | Use preset metadata, for example `"stages": 2`, or show "Pass 1 of 2". Also show elapsed time and an estimated time left from past `durationMs`. |
| R7 | 🟡 | Only the **first** output file is kept (`const [file] = …`). Batch outputs are dropped. | Keep all files (`outputFiles: []`) when batch size is more than 1. |
| R8 | 🟡 | Output file names are `presetId-Date.now()`. Two jobs that finish in the same millisecond would overwrite each other (rare). | Add a short random suffix, like uploads already do. |
| R9 | 🟡 | Number inputs only allow 1–4096 for all presets. 4096² on Z-Image may run out of VRAM. Sizes that are not multiples of 16 are allowed. | Let `preset.json` set `min`, `max`, `step` and `options` (for example aspect ratio buttons). |
| R10 | 🟡 | The health status is checked **only once**, right after login. If ComfyUI stops later, the header still says Online. | Check again every 15–30 s, and also after a failed generate. |
| R11 | 🟡 | `getUsersCollection()` runs `createIndex` on every login. | Run it once when the backend starts. |
| R12 | 🟡 | Leftover test file `data/outputs/zz-temporary-test-*.png`. 36 MB of outputs after a day of tests. There is no disk use view and no way to delete. | Delete from the gallery (soft delete), and show disk use. |

### 4.3 Developer experience and operations

| # | Sev | Finding | Suggestion |
|---|---|---|---|
| D1 | 🟠 | **FRG-15 (LAN access) is pushed but not merged.** `feat/start-teczoforge-script` is also not merged. `main` stops at FRG-18. | Review and merge, or close, the open branches. |
| D2 | 🟠 | The app runs with **dev servers only** (`tsx watch` + Vite). There is no production build or `npm start`. (FRG-15 adds a frontend build.) | A `build` + `start` script: Express serves `frontend/dist`. That means one port and one process for the team. |
| D3 | 🟡 | No tests. | Start with unit tests for `buildWorkflow` / `checkValue` and auth (`node:test`, no new package needed). Add a smoke test that runs all presets against a live ComfyUI. |
| D4 | 🟡 | No lint or format setup. | Prettier only, or `tsc --strict` as the gate. Keep it small. |
| D5 | 🟡 | `start-teczoforge.bat` waits **forever** if ComfyUI never starts, and opens the browser after a fixed 5 s. | Add a time limit with a clear message, and wait for `/api/health` before opening the browser. |
| D6 | 🟡 | Logs are only in the console windows. | Add a simple log file or a `/api/admin/logs` tail for fixing problems from another PC. |

### 4.4 UX

| # | Sev | Finding |
|---|---|---|
| U1 | 🟠 | A lot of the UI is **"Soon" placeholders** (see section 5). It looks polished, but you cannot tell what is real. Some placeholders should become real soon. |
| U2 | 🟡 | The gallery has no **filter, search or sort** (by preset, user, image or video, date) and no "only mine". |
| U3 | 🟡 | No **negative prompt**, no aspect-ratio presets, no batch count (make 4 at once). |
| U4 | 🟡 | You cannot **send a result into another preset** (for example "Animate this image" → Image to Video, "Upscale this"). This is the core loop of tools like Higgsfield. |
| U5 | 🟡 | There is no team **queue view**: who is running what, and how long until my job starts. |
| U6 | 🟡 | Images in the result viewer cannot be compared side by side, and there is no keyboard navigation in the gallery. |
| U7 | 🟢 | Good: clear status dots, plain-English errors, the prompt character count matches the backend, "Use again" handles deleted presets. |

---

## 5. Coming soon

### 5.1 Placeholders already in the UI (marked "Soon")

| Where | Item | What it needs |
|---|---|---|
| Sidebar → Create | **Video** (text to video) | A preset with `"type": "video"` and no image input. Could be Wan 2.2 T2V. |
| Sidebar → Create | **3D** | A preset with `"type": "3d"` (for example Hunyuan3D / TRELLIS) and a 3D viewer for `.glb` files |
| Sidebar → Create | **Edit / Inpaint** | A preset with `"type": "edit"` and a mask input (new input kind `mask` + a brush canvas) |
| Sidebar → Create | **Upscale** | A preset with `"type": "upscale"` (for example an ESRGAN model or a tiled diffusion upscale) |
| Sidebar → Models | **Flux**, **SDXL**, **Playground**, **Custom (ComfyUI)** | The model list is display only for now. Each needs presets, and maybe a real `model` field in `preset.json`. |
| Create panel | **Presets** button | A browser for saved prompt and style presets |
| Create panel | **Quick Prompts** (Cinematic Landscape, Futuristic City, Product Render, Anime Character, Interior Design) + "View more" | A list of starter prompts / style templates that fill the prompt box |
| Advanced Settings | **Steps** selector | A new `steps` input in `preset.json` (or Fast / Quality modes) |

The sidebar categories turn on **by themselves** when a matching preset folder exists. No code change is needed.

### 5.2 Roadmap tickets

- **FRG-15**: use from other PCs on the same network. *(Built on a branch, not merged.)*
- **FRG-17**: remote access with Tailscale, behind the login.
- **Later** (from `CLAUDE.md`): text to video, image editing, upscaling, camera motion presets,
  consistent characters (LoRA), projects and folders.

### 5.3 Open decision

- The final video model. Wan 2.2 14B is in use now. `CLAUDE.md` still lists this as open.

---

## 6. Ideas to brainstorm

Sorted from quick wins to bigger bets.

**Quick wins (mostly no code, or very little)**
1. **"Image to Video (Fast)" preset.** The Wan 4-step LightX2V LoRAs are already installed. In the
   test, turning the switch on gave **32.8 s instead of 266 s (about 8× faster)**. Export a second workflow with the switch on. It needs no code, only a new folder.
2. Add `SESSION_SECRET` (S1).
3. Text to image presets for portrait and landscape (for example 832×1216 and 1216×832).
4. Fill **Quick Prompts** with real starter prompts (a small JSON file).

**Medium**
5. Async jobs + Cancel + jobs saved first (R1, R2, R3), the biggest gain in reliability.
6. "Send to…" actions on every result: Animate, Upscale, Edit, Use as start image.
7. Gallery filters, paging, "only mine", favorites, soft delete.
8. Keep start images and show them in the detail view (R4).
9. Preset schema v2: `min`/`max`/`step`/`options`, `negative_prompt`, `batch`, `aspect` choices, `estimatedSeconds`.
10. Queue view: who is running what, and the estimated wait.

**Bigger bets**
11. **Camera motion presets** (dolly in, orbit, crane), the Higgsfield signature feature, using Wan + motion LoRAs.
12. **Consistent characters**: train or load a LoRA per character, with a "Characters" library to choose from.
13. **Projects / folders** to group outputs per client or campaign.
14. **Prompt helper**: a small local LLM that rewrites short prompts into detailed ones.
15. Text to video, 3D, inpaint and upscale presets to light up the "Soon" items.
16. GPU scheduling: show VRAM use, warn before a video job while a big image batch is running, and maybe let urgent jobs go first.

---

## 7. How to run

```bat
:: Everything at once (System 1)
start-teczoforge.bat

:: Or one at a time
cd backend  && npm run dev
cd frontend && npm run dev

:: Add a team account or reset a password
cd backend && npm run user -- <username>
```

Set up `backend/.env` from `backend/.env.example` (`PORT`, `COMFYUI_URL`, `MONGODB_URI`, `SESSION_SECRET`).
For ComfyUI install details, models and measured speeds, see `docs/comfyui-setup.md`.
