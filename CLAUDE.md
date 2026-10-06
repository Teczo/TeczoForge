# TeczoForge

A private web app to generate images and videos on our own GPU.
It is similar in idea to Higgsfield: the user picks a preset, types a prompt, and presses Generate.
ComfyUI does the real generation work. This app is a simple, friendly layer on top of it.

- Repo: `Teczo/TeczoForge`
- Tracker: Wroom, project "TeczoForge Studio". Ticket refs look like `FRG-3`.
- Note: the local folder on System 1 may still be named `TeczoAIGenerator`. It is the same project.

## 1. Who uses it and where it runs

- Owner: Jaya (Teczo). Used by Jaya and the Teczo team. Not a public product.
- It runs on "System 1": a Windows PC with an RTX 5090 (32 GB VRAM), 128 GB RAM.
- First it is used on System 1 only. Later the team opens it from other PCs in a browser.
- The DocuNest training platform is a separate project. Do not add training features here.

## 2. How we work (read this first)

1. Build ONLY the ticket you are given. Do not build ahead. Do not add extra features.
2. Tickets are small and come one at a time from Wroom.
3. The roadmap in section 9 is for context only. It is not a task list.
4. If a ticket is unclear, or needs a decision that is not in this file, stop and ask.
5. If something fails 2 times with the same error, stop and report. Do not keep retrying.
6. Never change the stack in section 3 without asking.
7. Keep code simple and easy to read. Jaya wants to understand every part of the app.
8. If a ticket and this file disagree, this file wins. Say so in your report.

## 3. Tech stack

| Part | Choice | Notes |
|---|---|---|
| Frontend | Vite + React + TypeScript | In `frontend/`. No Next.js. |
| Backend | Node.js + Express + TypeScript | In `backend/`. Separate from the frontend. |
| Database | MongoDB Atlas (cloud) | Address from env var `MONGODB_URI`. First used in FRG-7. |
| Generation engine | ComfyUI | Installed separately on System 1. Not part of this repo. |
| File storage | Local disk | Outputs in `data/outputs/`. |

Rules:
- Frontend and backend stay in separate folders with separate `package.json` files.
- MongoDB Atlas is the only cloud service. No Auth0, no Azure, no Stripe, no other cloud service unless a ticket says so.
- No Docker unless Jaya asks for it.
- Atlas needs internet. Generation must still work if MongoDB cannot be reached. Show a clear warning instead of crashing.
- The Atlas connection string is a secret. It goes in `backend/.env` only. Never commit it. Never print it in logs.

### Allowed dependencies

Wroom tickets say "do not add a dependency". The packages below are part of the
locked stack, so they are allowed when a ticket needs them. Use the smallest set.

- Backend: `express`, `cors`, `dotenv`, `ws`, `mongodb`, `typescript`, `tsx`, `@types/node`, `@types/express`, `@types/cors`, `@types/ws`
- Frontend: `vite`, `react`, `react-dom`, `typescript`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`

Anything not on this list: say what and why, then stop and ask.

### Ports and addresses

- Backend: port `4000` (env var `PORT`). Listens on `127.0.0.1` until ticket FRG-15.
- Frontend dev server: port `5173` (Vite default). It proxies `/api` to the backend.
- ComfyUI: `http://127.0.0.1:8188` (env var `COMFYUI_URL`).
- Every backend route starts with `/api`.

## 4. Folder layout

```
TeczoForge/
  CLAUDE.md
  frontend/          Vite + React app
  backend/           Express API
  presets/           One folder per preset (see section 6)
  data/              Generated outputs. NOT in git.
  docs/              Notes and decisions
```

`data/`, `node_modules/`, `.env`, and all model files are in `.gitignore`. Keep it that way.
Each of `backend/` and `frontend/` has a `.env.example` file that lists its env vars with safe default values.

## 5. How the parts talk to each other

```
Browser  --->  Backend (Express)  --->  ComfyUI (127.0.0.1:8188)
                    |
                    +--> MongoDB (jobs, gallery, users)
                    +--> data/outputs (image and video files)
```

1. The browser talks ONLY to our backend. It never talks to ComfyUI.
2. The backend sends a workflow to ComfyUI and watches its progress.
3. When ComfyUI finishes, the backend copies the result to `data/outputs/` and saves a record in MongoDB.
4. ComfyUI has its own job queue. Our app does not need a second queue. It only tracks job status.

ComfyUI API. Check these against the installed ComfyUI version (0.39.0) before use:
- `POST /prompt` : start a job. Body is a workflow in "API format".
- `GET /history/{prompt_id}` : result of a finished job.
- `GET /view?filename=...` : download an output file.
- `POST /upload/image` : upload an input image.
- `GET /queue` : jobs waiting and running.
- `GET /system_stats` : simple check that ComfyUI is running.
- `POST /interrupt` : stop the running job.
- WebSocket `/ws?clientId=...` : live progress messages.

## 6. Presets (the main idea of the app)

A preset hides all technical settings. The user only sees a few simple inputs.

Each preset is one folder:

```
presets/text-to-image-basic/
  workflow.json      ComfyUI workflow, exported in API format
  preset.json        Name, type, and which inputs the user can change
```

`presets/text-to-image-basic/` is the real, working example. Read it before any preset work.

Rules:
- In `preset.json`, `node` and `field` say where a value goes inside `workflow.json`.
- Node IDs can contain a colon, for example `57:27`. Treat them as plain text keys.
- Adding a new preset must NOT need code changes. Only a new folder.
- Jaya creates and tests workflows in ComfyUI. Do not invent workflow files or node IDs.
  If a ticket needs a workflow that does not exist, stop and ask for it.
- Never edit a `workflow.json` by hand.

## 7. Safety rules (do not break these)

1. ComfyUI must listen on `127.0.0.1` only. Never expose it to the network or the internet.
   Reason: ComfyUI has no login, and its custom nodes can run code on the PC.
2. Only the backend may call ComfyUI.
3. Do not open the backend to the internet. Remote access is a later ticket (FRG-17), with a login.
4. Never commit secrets, `.env` files, model files, or generated outputs.
5. Do not download AI models. They are very large. Jaya downloads them by hand.
6. Do not install, start, stop, or change ComfyUI or its custom nodes. Jaya starts it by hand.
   If ComfyUI is not running when you need it, stop and ask Jaya to start it.
7. Do not delete anything inside `data/` without asking.
8. Validate every user input in the backend before it goes into a workflow.

## 8. Git rules

Follow these steps for EVERY ticket. This avoids merge conflicts.

1. Before starting: `git checkout main`, then `git pull`.
2. Create a new branch from main. Use the branch name written in the Wroom ticket.
   It looks like `feat/FRG-3-backend-skeleton-with-comfyui-status-check`.
3. Never start a new ticket on an old feature branch.
4. If the working folder has uncommitted changes at the start, stop and report. Do not discard them.
5. Commit in small steps with clear messages. Start each message with the ticket ref, for example `FRG-3: add health route`.
6. When done: push the branch and open a pull request to `main`. Do not merge it yourself.
   If you cannot open a pull request, push the branch and say so in the report.
7. Never commit directly to `main`. Never force-push.
   (Jaya may commit changes to `CLAUDE.md` and `docs/` directly to `main` himself.)

## 9. Roadmap (context only, not a task list)

- Phase 0 (done): ComfyUI installed, first image made, repo pushed.
- Phase 1 (FRG-3 to FRG-6): thin base. One page. Prompt in, image out, shown on screen.
- Phase 2 (FRG-7 to FRG-11): jobs saved in MongoDB, gallery, job progress, preset picker.
- Phase 3 (FRG-12 to FRG-14): image upload, image-to-video preset, video output.
- Phase 4 (FRG-15 to FRG-17): use from other PCs, team login, remote access with Tailscale.
- Later: text-to-video, image editing, upscaling, camera motion presets, consistent characters (LoRA), projects and folders.

## 10. Commands

Fill this in when the ticket that creates each part is done.

- Start ComfyUI (Jaya does this): see `docs/comfyui-setup.md`
- Backend dev: `cd backend`, then `npm run dev`. Or double-click `backend\start-backend.bat`.
- Frontend dev: `cd frontend`, then `npm run dev`
- Tests: (not set yet)
- Lint: (not set yet)

System 1 is Windows. Write scripts that work in PowerShell. Use `path.join`, not hard-coded slashes.

## 11. Definition of done for a ticket

A ticket is done only when ALL of these are true:
1. The ticket's EXIT CRITERIA are met, and you tested them on System 1
   (or you say clearly which ones you could not test, and why).
2. Every part that exists (backend, frontend) starts with no errors.
3. No unrelated files were changed.
4. Section 10 is updated if commands changed.
5. The branch is pushed and a pull request is open.

## 12. Status report format

End every session with the report the Wroom ticket asks for: DONE, NOT DONE, BLOCKED, NOTICED.
Then add one more part:

- HOW TO TEST: the exact steps Jaya can follow to check the work himself.

Write it in plain English. Short sentences. No jargon.

## 13. Decisions

Decided:
1. App name: TeczoForge.
2. Database: MongoDB Atlas (cloud).
3. Users: Jaya and the Teczo team. So the app needs user accounts (FRG-16).
4. Remote access: Tailscale (FRG-17).
5. First image model: Z-Image-Turbo.

Still open (ask before assuming):
1. Login method for the team. Decide before FRG-16.
2. Which video model to use. Jaya decides after the image-to-video test (FRG-13).
