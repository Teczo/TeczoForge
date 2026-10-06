# TeczoAIGenerator

A private web app to generate images and videos on our own GPU.
It is similar in idea to Higgsfield: the user picks a preset, types a prompt, and presses Generate.
ComfyUI does the real generation work. This app is a simple, friendly layer on top of it.

## 1. Who uses it and where it runs

- Owner: Jaya (Teczo). Private tool. Not a public product.
- It runs on "System 1": a Windows PC with an RTX 5090 (32 GB VRAM), 128 GB RAM.
- First it is used on System 1 only. Later it is opened from other PCs in a browser.
- The DocuNest training platform is a separate project. Do not add training features here.

## 2. How we work (read this first)

1. Build ONLY the ticket you are given. Do not build ahead. Do not add extra features.
2. Tickets are small and come one at a time (often from Wroom, our project tracker).
3. The roadmap in section 9 is for context only. It is not a task list.
4. If a ticket is unclear, or needs a decision that is not in this file, stop and ask.
5. If something fails 2 times with the same error, stop and report. Do not keep retrying.
6. Never change the stack in section 3 without asking.
7. Keep code simple and easy to read. Jaya wants to understand every part of the app.

## 3. Tech stack

| Part | Choice | Notes |
|---|---|---|
| Frontend | Vite + React + TypeScript | In `frontend/`. No Next.js. |
| Backend | Node.js + Express + TypeScript | In `backend/`. Separate from the frontend. |
| Database | SQLite (one local file) | In `data/app.db`. The app must work with no internet. |
| Generation engine | ComfyUI | Installed separately on System 1. Not part of this repo. |
| File storage | Local disk | Outputs in `data/outputs/`. |

Rules:
- Frontend and backend stay in separate folders with separate `package.json` files.
- No cloud services in version 1. No Auth0, no Azure, no MongoDB Atlas.
- No Docker unless Jaya asks for it.

## 4. Folder layout

```
TeczoAIGenerator/
  CLAUDE.md
  frontend/          Vite + React app
  backend/           Express API
  presets/           One folder per preset (see section 6)
  data/              Database and outputs. NOT in git.
  docs/              Notes and decisions
```

Add `data/`, `node_modules/`, `.env`, and all model files to `.gitignore`.

## 5. How the parts talk to each other

```
Browser  --->  Backend (Express)  --->  ComfyUI (127.0.0.1:8188)
                    |
                    +--> SQLite (jobs, gallery)
                    +--> data/outputs (image and video files)
```

1. The browser talks ONLY to our backend. It never talks to ComfyUI.
2. The backend sends a workflow to ComfyUI and watches its progress.
3. When ComfyUI finishes, the backend copies the result to `data/outputs/` and saves a row in SQLite.
4. ComfyUI has its own job queue. Our app does not need a second queue. It only tracks job status.

ComfyUI API (default port 8188). Check these against the installed ComfyUI version before use:
- `POST /prompt` : start a job. Body is a workflow in "API format".
- `GET /history/{prompt_id}` : result of a finished job.
- `GET /view?filename=...` : download an output file.
- `POST /upload/image` : upload an input image.
- `GET /queue` : jobs waiting and running.
- `POST /interrupt` : stop the running job.
- WebSocket `/ws?clientId=...` : live progress messages.

The ComfyUI address comes from the env var `COMFYUI_URL`. Default: `http://127.0.0.1:8188`.

## 6. Presets (the main idea of the app)

A preset hides all technical settings. The user only sees a few simple inputs.

Each preset is one folder:

```
presets/text-to-image-basic/
  workflow.json      ComfyUI workflow, exported in API format
  preset.json        Name, type, and which inputs the user can change
```

Example `preset.json`:

```json
{
  "id": "text-to-image-basic",
  "name": "Text to Image",
  "type": "image",
  "inputs": [
    { "key": "prompt", "label": "Prompt", "kind": "text", "node": "6", "field": "text" },
    { "key": "seed", "label": "Seed", "kind": "seed", "node": "3", "field": "seed" }
  ]
}
```

Rules:
- `node` and `field` say where the value goes inside `workflow.json`.
- Adding a new preset must NOT need code changes. Only a new folder.
- Jaya creates and tests workflows in ComfyUI. Do not invent workflow files or node IDs.
  If a ticket needs a workflow that does not exist, stop and ask for it.

## 7. Safety rules (do not break these)

1. ComfyUI must listen on `127.0.0.1` only. Never expose it to the network or the internet.
   Reason: ComfyUI has no login, and its custom nodes can run code on the PC.
2. Only the backend may call ComfyUI.
3. Do not open the backend to the internet. Remote access is a later ticket, with a login.
4. Never commit secrets, `.env` files, model files, or generated outputs.
5. Do not download AI models. They are very large. Jaya downloads them by hand.
6. Do not install or change ComfyUI or its custom nodes. Ask first.
7. Do not delete anything inside `data/` without asking.
8. Validate every user input in the backend before it goes into a workflow.

## 8. Git rules

Follow these steps for EVERY ticket. This avoids merge conflicts.

1. Before starting: `git checkout main`, then `git pull`.
2. Create a new branch from main. Name: `feature/<ticket-id>-<short-name>`.
3. Never start a new ticket on an old feature branch.
4. If the working folder has uncommitted changes at the start, stop and report. Do not discard them.
5. Commit in small steps with clear messages.
6. When done: push the branch and open a pull request to `main`. Do not merge it yourself.
7. Never commit directly to `main`. Never force-push.

## 9. Roadmap (context only, not a task list)

- Phase 0 (Jaya, by hand): install ComfyUI. Run one image workflow and one video workflow. Note time and memory.
- Phase 1: thin base. One page. Prompt in, image out, shown on screen.
- Phase 2: gallery, job progress, and the preset system.
- Phase 3: image-to-video presets.
- Phase 4: use from other PCs (local network first, then private remote access with a login).
- Later: text-to-video, image editing, upscaling, camera motion presets, consistent characters (LoRA), projects and folders.

## 10. Commands

Fill this in when the ticket that creates each part is done.

- Frontend dev: `cd frontend && npm run dev`
- Backend dev: `cd backend && npm run dev`
- Tests: (not set yet)
- Lint: (not set yet)

System 1 is Windows. Write scripts that work in PowerShell. Use `path.join`, not hard-coded slashes.

## 11. Definition of done for a ticket

A ticket is done only when ALL of these are true:
1. The feature works when run on System 1 (or you say clearly that you could not test it).
2. Frontend and backend both start with no errors.
3. No unrelated files were changed.
4. Section 10 is updated if commands changed.
5. A pull request is open.

## 12. Status report format

End every session with a short report in plain English. No jargon.

1. What was done.
2. What is blocked, and why.
3. What you need from Jaya.
4. How to test it (exact steps).

## 13. Open decisions (ask before assuming)

1. Database: SQLite is the current choice. Jaya may change it to MongoDB.
2. Users: only Jaya for now. Team access is not decided.
3. Remote access tool: Tailscale or Cloudflare Tunnel. Not decided.
4. Which image and video models to use. Jaya decides after Phase 0.
