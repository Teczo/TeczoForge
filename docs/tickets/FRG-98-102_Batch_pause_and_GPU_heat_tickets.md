# TeczoForge Studio — Batches: pause every game step, and protect the GPU from heat (FRG-98 to FRG-102)

Tickets that make long game runs safe to leave alone. Run them in order, one at a time. Each ticket
follows `CLAUDE.md` (git rules, definition of done, report format).

Wroom is not connected right now. This file takes its place. Treat each ticket below exactly like a
Wroom ticket. FRG-98 to FRG-102 follow the last used ticket (FRG-97). If Wroom is used again later,
Jaya adds these tickets there with the same numbers.

## Goal of the whole feature

1. Every game step can be paused. Today only "Generate all" makes a batch (`batches.ts`, FRG-75).
   When Jaya approves a picture, the next step (3D, make tileable, remove background) goes straight
   to ComfyUI, so it cannot be paused.
2. TeczoForge reads the GPU temperature. When the GPU is too hot, batches wait until it has cooled down.
3. After a long run, batches take a short rest by themselves, then go on.
4. The time estimate counts these pauses.

Why now: on 18 Nov 2026 the NBO game had 34 approved steps waiting in ComfyUI and no way to pause
them. They had to be cancelled one by one.

## What is already there (checked on 18 Nov 2026)

1. Batches (`backend/src/batches.ts`, FRG-75). The runner checks every 2 seconds. At most one batch
   card is in ComfyUI at a time. Pause means: no new card starts, and the running card finishes.
   A paused batch has a `note` in plain English. When the backend starts, running batches are paused.
2. `addCardsToBatch` adds cards to the end of a batch. A done batch runs again for the new cards.
   Packs already use it: `addToPackBatch` and `runOneCard` in `packRun.ts`. Games do not use it yet.
3. The batch bar (`frontend/src/BatchBar.tsx`) shows Pause, Resume, Stop now and End, and the time
   left (FRG-76, `estimate.ts`).
4. `nvidia-smi` is installed with the NVIDIA driver on System 1. This command works and needs no
   new dependency:
   `nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits`
   It answered about 42 (°C) with the GPU idle. It is the GPU core temperature. The memory
   temperature is not shown by `nvidia-smi` on GeForce cards.
5. ComfyUI cannot pause a job halfway. It can only stop it (`POST /interrupt`). A stopped board card
   goes back to Ready as a draft, with nothing lost.

## Important: why a hot job still always finishes

Every pause in these tickets happens BETWEEN jobs. The running job always finishes, even if the GPU
goes above the limit while it runs. A pause only stops the NEXT job from starting. So a job that makes
the GPU hot is never stuck: it finishes, the GPU cools down, then the next job starts.

Only the emergency stop in FRG-100 stops a running job, and it lets that job run again at most one
more time (see FRG-100).

## Rules for all tickets

1. No new npm dependency.
2. Do not create or edit any `workflow.json` or `preset.json`.
3. Do not install, start, stop or change ComfyUI or its custom nodes (CLAUDE.md section 7 rule 6).
   The emergency stop in FRG-100 uses the same cancel path as "Stop now" (`cancelFollowedJob`). It
   never stops ComfyUI itself.
4. Do not change GPU settings (power limit, fan speed, clocks). Only READ the temperature.
5. Single jobs (Generate page, a Generate button on the board, chat) and Translate (llama-server)
   still go straight to the GPU. These tickets do not hold them back. They only show the warning.
6. A pause made by TeczoForge (heat, rest) must never undo a pause Jaya made by hand. Jaya's Pause
   always wins: only Jaya's Resume ends it.
7. All limits are env vars in `backend/.env`, listed in `backend/.env.example` with their defaults.
   The value 0 turns that rule off.
8. If `nvidia-smi` cannot be read, nothing is blocked. The bar says "GPU temperature unknown".
9. If something fails 2 times with the same error, stop and report. Do not keep retrying.
10. If a ticket and `CLAUDE.md` disagree, `CLAUDE.md` wins. Say so in the report.

## FRG-98 — Approved game steps go into a batch

**Branch:** `feat/FRG-98-game-steps-in-a-batch`

**Goal:** When Jaya approves a step of a game asset, the card of the next step goes into the game's
batch, not straight to ComfyUI. So every game step can be paused, like "Generate all".

**Check before coding**

1. Find every place in `games.ts` that sends a game card straight to ComfyUI (`runCards`). Today:
   the approve route, "Make variant", and "Make concept art". List them in the report.
2. Read `addToPackBatch` and `runOneCard` in `packRun.ts`. Reuse the same idea. Do not copy batch code.

**In scope**

1. The approve route (`approveHandler`): the next step's card is added to the game's batch:
   1. The game's newest batch that is running or paused: the card goes to the end of it.
   2. Else the game's newest batch that is done: it runs again with the new card (`addCardsToBatch`
      already does this).
   3. Else a new batch, named "{game name}: next steps", owner `{ type: "game", id }`.
2. "Make variant" (`variantHandler`): the same.
3. "Make concept art" stays as it is (3 quick cards at the start of a game). Say so in the report.
4. The game page already shows the bar of the game's running or paused batches. Check that it shows
   after an approve, with no page reload.
5. If the batch is paused by Jaya, the new card waits in it. The answer of the approve route says so
   in plain English, for example "Added to the paused batch. Press Resume to run it."

**Out of scope:** heat, rest, packs, the Generate page, the board.

**Exit criteria**

1. Approve a model's reference picture. Its 3D card shows in the game's batch bar, and runs.
2. Pause the batch, then approve another picture. Its next card waits. Resume runs it.
3. Approve a picture when the game has no running or paused batch. A batch starts by itself.
4. "Make variant" adds its card to the batch the same way.
5. Packs, Generate, Avatar and Translate work as before.
6. `tsc --noEmit` passes in backend and frontend. No new dependency.

**Stop and report if:** a game card is sent to ComfyUI from a place not listed in check 1, or
`addCardsToBatch` would need a change that changes how packs work.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

## FRG-99 — Read the GPU temperature

**Branch:** `feat/FRG-99-gpu-temperature`

**Goal:** TeczoForge knows the GPU temperature, shows it, and remembers how hot each job made the GPU.
No pausing yet. This ticket gives Jaya real numbers to choose the limits in FRG-100.

**In scope**

1. A small file `backend/src/gpuTemp.ts`. Every 5 seconds it runs `nvidia-smi` (path from env var
   `NVIDIA_SMI_PATH`, default `nvidia-smi`) with the command from "What is already there", item 4.
   It keeps the last value and the time it was read.
   1. Use `execFile` with a 3 second timeout. Never a shell string.
   2. If it fails or the answer is not a number: the value is "unknown". Log the problem once, not every 5 seconds.
2. `GET /api/gpu` answers `{ "temperatureC": 62, "readAt": "...", "known": true }`.
3. The batch bar shows the temperature, for example "GPU 62 °C", or "GPU temperature unknown".
   Theme colours only (CLAUDE.md section 15).
4. Each job saves the highest temperature seen while it ran (`maxGpuTempC` on the job). The Time test
   (`timeTest.ts`) and the job details show it.

**Out of scope:** pausing (FRG-100), any change to GPU settings.

**Exit criteria**

1. With the backend running, `GET /api/gpu` answers the same number as `nvidia-smi` in PowerShell (±2 °C).
2. With `NVIDIA_SMI_PATH` set to a wrong path, the backend starts with no error, the bar says
   "GPU temperature unknown", and the log has one warning.
3. After a batch runs, every finished job of it has `maxGpuTempC`.
4. `tsc --noEmit` passes in backend and frontend. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST. In NOTICED, list the highest
temperature seen for each preset Jaya ran, so he can pick the limits for FRG-100.

## FRG-100 — Heat pause

**Branch:** `feat/FRG-100-heat-pause`

**Goal:** When the GPU is too hot, batches wait between jobs until it has cooled down. Then they go
on by themselves.

**Settings (`backend/.env`)**

| Env var | Default | Meaning |
|---|---|---|
| `GPU_PAUSE_AT_C` | 80 | At this temperature or more, no new batch card starts. |
| `GPU_RESUME_AT_C` | 70 | Batches go on only at this temperature or less. |
| `GPU_MIN_COOL_S` | 120 | And only after at least this many seconds of cooling. |
| `GPU_MAX_COOL_MIN` | 20 | Still too hot after this many minutes: stay paused and warn. |
| `GPU_EMERGENCY_C` | 0 (off) | Optional, for example 88: stop the RUNNING card too. |

`GPU_RESUME_AT_C` must be lower than `GPU_PAUSE_AT_C`. If not, the backend says so at start and uses
the defaults. The gap stops the batch from switching between pause and run every few seconds.

**In scope**

1. One "GPU gate" for ALL batches (one GPU), in the batch runner. Before any batch card starts, the
   runner asks the gate. Closed: no card starts, and every running batch shows the reason.
2. A batch paused by the gate has a reason "heat", kept apart from Jaya's own pause (Rules item 6).
   The bar says, for example: "Cooling down: GPU 82 °C. Goes on at 70 °C (about 2 min)."
3. The gate opens again only when the GPU is at or below `GPU_RESUME_AT_C` AND it has cooled for
   `GPU_MIN_COOL_S` seconds. Only batches paused by the gate go on.
4. Still too hot after `GPU_MAX_COOL_MIN` minutes: batches stay paused, and the bar says "Still hot
   after 20 minutes. Check the fans and the room, then press Resume." Pressing Resume then makes the
   batch run whatever the temperature is, until the next card ends.
5. Temperature unknown: the gate stays open (Rules item 8).
6. Emergency stop (only when `GPU_EMERGENCY_C` is not 0): at or above it, the running batch card is
   stopped with the same path as "Stop now". The card goes back to Ready and stays first.
   1. It may be stopped this way at most 2 times. The 2nd time it is marked failed with the reason
      "Too hot: stopped twice at {n} °C". The batch goes on with the next card after cooling.
   2. This is how a job that always makes the GPU too hot can never block a batch.
7. While single jobs or Translate run (they are not batch cards), the gate cannot stop them. The
   bar only shows "GPU 83 °C: a job outside the batch is running".

**Out of scope:** the rest timer (FRG-101), the time estimate (FRG-102), GPU settings.

**Exit criteria (test with low limits, so the GPU does not need to get really hot)**

1. With `GPU_PAUSE_AT_C=45` and `GPU_RESUME_AT_C=40`, a running batch pauses between two cards when
   the GPU passes 45 °C. The running card finishes first.
2. When the GPU is back at 40 °C and 2 minutes have passed, the batch goes on by itself.
3. A batch Jaya paused by hand stays paused after the GPU cools down.
4. With `GPU_EMERGENCY_C` set just above the idle temperature, a running card is stopped, goes back
   to Ready, runs once more, and is marked "Too hot" the second time. The batch goes on.
5. With `nvidia-smi` not readable, batches run as before.
6. With the limits back at 80/70, a normal batch runs as before.
7. `tsc --noEmit` passes in backend and frontend. No new dependency.

**Stop and report if:** the gate would need ComfyUI's own queue to be changed, or a single job would
need to be held back.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

## FRG-101 — Work and rest timer

**Branch:** `feat/FRG-101-batch-rest-timer`

**Goal:** After a long run, batches take a short rest by themselves, then go on.

**Settings (`backend/.env`)**

| Env var | Default | Meaning |
|---|---|---|
| `BATCH_WORK_MIN` | 30 | After this many minutes of batch work, rest. 0 = never rest. |
| `BATCH_REST_MIN` | 5 | How long the rest is (Jaya may choose 10). |

**In scope**

1. The same GPU gate as FRG-100, with a second reason "rest".
2. Work time counts while a batch card runs in ComfyUI, over all batches. It does not count time when
   no batch card runs. A rest of any kind (rest, heat, Jaya's pause longer than the rest time) sets
   it back to 0.
3. When the work time reaches `BATCH_WORK_MIN`, the rest starts when the running card has finished
   (never in the middle of a card). The bar says "Resting: goes on at 14:35".
4. After `BATCH_REST_MIN` minutes, batches paused for the rest go on by themselves. If the GPU is
   still too hot then, the heat pause of FRG-100 takes over. Both must be clear before a card starts.
5. Jaya's own Pause wins over the rest, as in FRG-100.
6. A backend restart starts the work time at 0 again (running batches are already paused at restart).

**Exit criteria (test with short times)**

1. With `BATCH_WORK_MIN=2` and `BATCH_REST_MIN=1`, a batch rests after the card that passes 2 minutes,
   and goes on by itself 1 minute later.
2. A rest during a heat pause: the batch waits for both.
3. With `BATCH_WORK_MIN=0`, batches never rest.
4. A batch Jaya paused by hand stays paused after a rest ends.
5. `tsc --noEmit` passes in backend and frontend. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

## FRG-102 — Time estimate with pauses

**Branch:** `feat/FRG-102-estimate-with-pauses`

**Goal:** The time estimate before a run, and the time left in the batch bar, count the rest pauses,
and show how long cooling pauses take.

**In scope**

1. In `estimate.ts`, add the rests: number of rests = whole number of (work time ÷ `BATCH_WORK_MIN`),
   each `BATCH_REST_MIN` long. For example, 4 hours of work with 30/5 adds 8 × 5 = 40 minutes.
2. Cooling pauses cannot be known before. Save the length of each heat pause (FRG-100). The estimate
   then says, for example, "plus cooling pauses: 3 so far today, about 2 min each".
3. The batch bar's time left and "ends about" include the rests still to come.
4. The estimate before an import (Games) and before a pack run shows the rests in one extra line,
   for example "includes 8 rests of 5 min".

**Out of scope:** guessing how many heat pauses will happen.

**Exit criteria**

1. With `BATCH_WORK_MIN=30` and `BATCH_REST_MIN=5`, a run estimated at 2 h of work shows 2 h 20 min
   (4 rests), and says so.
2. With `BATCH_WORK_MIN=0`, the estimates are the same as before this ticket.
3. After a heat pause, the batch bar shows the cooling line.
4. `tsc --noEmit` passes in backend and frontend. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

## Later (not tickets yet)

1. Settings page: change the limits in the app instead of `backend/.env`.
2. A lower GPU power limit (set by Jaya, for example with MSI Afterburner) makes jobs a little slower
   and much cooler. TeczoForge does not change GPU settings itself (Rules item 4).
3. Hold back single jobs and Translate too while the GPU is too hot.
