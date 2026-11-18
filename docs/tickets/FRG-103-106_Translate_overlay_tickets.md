# TeczoForge Studio — Translate: the translation on the photo (FRG-103 to FRG-106)

Tickets that put the English text on top of the photo, in the place of the Japanese, like Google
Translate does. Run them in order, one at a time. Each ticket follows `CLAUDE.md` (git rules,
definition of done, report format).

**Wroom is not connected right now.** This file takes its place. Treat each ticket below exactly like
a Wroom ticket. FRG-103 to FRG-106 follow the last used ticket (FRG-102). If Wroom is used again later,
Jaya adds these tickets there with the same numbers.

**The full plan is `docs/translate-overlay.md`.** Read it before every ticket, and read
`docs/japanese-translate.md` too. Section numbers below ("spec 7") point to `docs/translate-overlay.md`.

**Goal of the whole feature:** on the Translate page, a "Translated" view of the photo. The Japanese
is covered with the paper colour, and the English is written in its place, at about the same size as
the handwriting. A switch goes back to the original photo. The translated photo can be downloaded as a PNG.
Everything runs on System 1. Nothing leaves the PC.

**What is already there (checked on 18 Nov 2026)**

1. The Translate feature, FRG-90 to FRG-95. The worker is `handleDocument()` in
   `backend/src/translateDocuments.ts`: call 1 (photo to Japanese), then call 2 (Japanese and photo to English).
2. `askModel()` in the same file sends one request to llama-server. Today it always sends the photo,
   always uses `max_tokens` 4096, and has no `response_format`.
3. The prompts are in `backend/src/translatePrompt.ts`.
4. The page is `frontend/src/TranslatePage.tsx`. The photo is shown in `Result()`, inside a link that
   opens it full size.
5. A PDF is cut into pages by the browser, and each page is uploaded as a PNG (FRG-95). So a page of a
   PDF has a `source.png` in its folder, like a photo.
6. Jaya's test file: `Downloads\TestPDF.pdf`, page 4 (spec 3). It is client data.

**Rules for all tickets**

1. No new npm dependency.
2. Calls 1 and 2 send exactly the same request as today. Do not change their prompts.
3. Client documents are private. Never send them, or their text, to the Claude API or any internet
   service. Never write document text into logs or the console, and never write the model's answer
   to call 3 or 4 there. Print counts only.
4. Do not copy `TestPDF.pdf`, or any page of it, into the repo. Test files go in `data/` only.
5. Do not change how Generate, Games, Packs, Avatar, batches or the other Translate parts work,
   except where a ticket says so.
6. If something fails 2 times with the same error, stop and report. Do not keep retrying.
7. If a ticket and `CLAUDE.md` disagree, `CLAUDE.md` wins. Say so in the report.

---

## FRG-103 — Test script: where each line is, drawn on the photo

**Branch:** `feat/FRG-103-translate-layout-test`

**Goal:** Find out if the Qwen model can tell where each line of text is on a photo, before we build on it.

**Check before coding:**

1. Confirm the installed llama-server accepts `response_format` with a JSON schema in
   `/v1/chat/completions` (spec 7). If it does not, stop and report.
2. Jaya has uploaded `TestPDF.pdf` on the Translate page, and page 4 is done. Jaya gives the document id.

**In scope**

1. The call 3 prompt from spec 7 in `backend/src/translatePrompt.ts`.
2. `askModel()` gets an options object: the photo (or none), `max_tokens`, and a JSON schema.
   The defaults keep calls 1 and 2 exactly as they are today. Export it, so the test script can use it.
3. New file `backend/src/translateLayout.ts` with one function that reads the call 3 answer and does
   the checks in spec 7. It gives back the lines that pass, and how many were dropped.
4. Test script `npm run translate-layout-test -- <document id>` (new file `backend/src/translateLayoutTest.ts`):
   1. Checks the id with the same pattern as the routes (`^tr-[0-9]+-[0-9a-f]{6}$`).
      The document must be `done` (it needs the Japanese text).
   2. Starts llama-server the same way as `npm run translate-test`, sends call 3, then stops llama-server.
   3. Writes `data/translations/<id>/layout-test.html`: the photo with every box drawn on it, the block
      number next to each box, horizontal and vertical lines in two different colours. It is a test file,
      not part of the app, so the theme rules do not apply to it.
   4. Writes the checked answer to `data/translations/<id>/layout-test.json`.
   5. Prints only counts: lines, blocks, lines dropped by the checks, seconds. No text.
5. Add the command to CLAUDE.md section 10.

**Out of scope:** call 4, the worker, `layout.json`, the page (FRG-104 and later).

**Exit criteria**

1. For page 4, `layout-test.html` shows boxes on the lines of the main text.
2. The report says if the boxes are on a 0-1000 grid of the photo (the boxes line up with the text when
   read as 0-1000) or in pixels of the shrunk photo.
3. The report gives, for page 4 and for 2 other pages Jaya picks: lines found, lines dropped,
   boxes that are clearly in the wrong place, blocks that join text that should be apart (or the other
   way round), and the seconds for call 3.
4. Calls 1 and 2 still work: one new upload is read and translated as before.
5. `tsc --noEmit` passes. No new dependency.

**Stop and report if:** `response_format` is refused, the boxes are in pixels of the shrunk photo, or
most boxes are clearly wrong. Then Jaya decides what comes next (spec 13, last point).

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-104 — Backend: calls 3 and 4 in the worker, layout.json

**Branch:** `feat/FRG-104-translate-overlay-backend`

**Goal:** Every translated document also gets a `layout.json`: where each block is, and its English.

**Needs:** FRG-103 is merged, and its report showed boxes on a 0-1000 grid that are good enough.

**In scope**

1. Env var `TRANSLATE_OVERLAY` (spec 6), in `backend/.env.example` with its comment.
2. The call 4 prompt from spec 8 in `translatePrompt.ts`. Reading and checking the call 4 answer in
   `translateLayout.ts` (spec 8).
3. In `handleDocument()`, after call 2, when the overlay is on:
   1. Status `placing`, then call 3, then call 4, then save `layout.json` (spec 9). `overlay` is `"done"`.
   2. If call 3 or call 4 fails in any way: `overlay` is `"failed"`, the warning
      "The translation could not be placed on the photo." is added, and the document is still `done`.
   3. When the overlay is off: no call 3 or 4, `overlay` is `"none"`.
4. The new status `placing` in every place listed in spec 10.
5. The `overlay` field in `record.json`. An older document without it reads as `"none"`.
6. Route `GET /api/translate/documents/:id/layout` (spec 10). Check the id with the pattern first.
7. "Try again" and "Save and translate again" also run calls 3 and 4 (spec 10).
8. Show the new status words "Placing the text on the photo" on the page (spec 10). Nothing else on the page.

**Out of scope:** drawing the overlay (FRG-105), the PNG (FRG-106), a PDF with the overlay (spec 13).

**Exit criteria**

1. Page 4 of `TestPDF.pdf` goes Waiting, Reading, Translating, Placing, Done, and its folder has `layout.json`.
2. `GET .../layout` gives `layout.json`. For a document without an overlay it gives 404 with the message.
3. With `TRANSLATE_OVERLAY=off`, a new document has no `layout.json`, `overlay` is `"none"`, and it takes
   about as long as before.
4. A failed overlay keeps the document `done`, with the warning. Test this once with a small temporary
   change in the code that is not committed. Say how in the report.
5. A document that is `placing` cannot be removed. After a backend restart it goes back to `waiting`.
6. The backend log has no document text in it.
7. The report gives the seconds for page 4 with the overlay on and off.
8. `tsc --noEmit` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-105 — Frontend: the translation on the photo

**Branch:** `feat/FRG-105-translate-overlay-page`

**Goal:** Jaya sees the English on top of the photo, at about the size of the handwriting, and can switch
back to the original.

**Check before coding:** CLAUDE.md section 15, rule 3 has the exception for the overlay colours (spec 4).
If it does not, stop and ask.

**In scope**

1. Everything in spec 11. New files `frontend/src/translateOverlay.ts` and `frontend/src/TranslateOverlay.tsx`.
2. `fitBlock(block, measure)` gets the measuring function from outside (spec 11, last paragraph),
   so FRG-106 can use the same result.
3. The `Tabs` "Translated" | "Original" above the photo, and the "Open full size" button (spec 11, "On the page").
4. Tailwind classes and theme colours for all UI. Only the patch and text colours come from the photo.

**Out of scope:** the PNG download (FRG-106), editing the English on the photo, turning lines to follow a tilted photo.

**Exit criteria**

1. All checks in spec 14, step 2, pass on page 4. Say which ones do not, with a screenshot of that part.
2. The switch and the hover text work (spec 14, step 3).
3. The overlay stays in place when the window is made smaller or bigger.
4. A document with no overlay shows the photo as before, with no tabs.
5. Both themes checked. The rest of the Translate page looks and works as before.
6. `npm run typecheck` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-106 — Download the translated image

**Branch:** `feat/FRG-106-translate-overlay-png`

**Goal:** Jaya can save the translated photo as a PNG file.

**In scope**

1. Everything in spec 12. The button "Download translated image", next to "Download PDF".
2. It uses the same `fitBlock` result as the screen (FRG-105). No second way of fitting the text.

**Out of scope:** a PDF with the overlay (spec 13).

**Exit criteria**

1. The PNG of page 4 looks the same as the "Translated" view on screen, at the full size of the photo.
2. The file name is the document title, then " - translated.png".
3. The button cannot be pressed when the overlay is not `done`.
4. Pressing it sends no request to the backend (check the browser's Network tab).
5. `npm run typecheck` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.
