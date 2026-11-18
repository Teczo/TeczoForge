# TeczoForge Studio — Translate: downloads, empty table rows and tables (FRG-107 to FRG-113)

Tickets for a Download dialog with more choices, removing empty table rows, and turning a page that is
a table into a table. Run them in order, one at a time. Each ticket follows `CLAUDE.md` (git rules,
definition of done, report format).

**Wroom is not connected right now.** This file takes its place. Treat each ticket below exactly like
a Wroom ticket. FRG-107 to FRG-113 follow the last used ticket (FRG-106). If Wroom is used again later,
Jaya adds these tickets there with the same numbers.

**The full plan is `docs/translate-downloads-and-tables.md`.** Read it before every ticket, and read
`docs/japanese-translate.md` and `docs/translate-overlay.md` too. Section numbers below ("spec 5") point to
`docs/translate-downloads-and-tables.md`.

**Goal of the whole feature:** on the Translate page, one Download button that asks what to save (the
translated photo, the translated text, or the plain text), which pages, and as one file or one file per page.
A bar offers to hide empty table rows. A bar offers to rewrite a page as a table when the photo shows a
table but the text is not one. Both bars can be undone. Everything runs on System 1. Nothing leaves the PC.

**What is already there (checked on 19 Nov 2026)**

1. The Translate feature, FRG-90 to FRG-106, all merged into `main`.
2. `Result()` in `frontend/src/TranslatePage.tsx` has three download controls in its header:
   "Download .txt" (a link to `.../text`), "Download PDF" (a link to `.../pdf`, which gives all pages of a
   PDF file) and "Download translated image" (`overlayPng()`, made in the browser, FRG-106).
3. The page loads the list of all documents (`DocSummary`, with `fileId`, `page`, `pages`, `status`,
   `overlay`). So the browser knows every page of a file and its state.
4. `TranslateOverlay.tsx`: `useOverlay()` loads `layout.json` and the photo and fits the blocks for the open
   document. `makeOverlay()` is not exported. `overlayPng()` draws on a canvas and gives a PNG.
5. `translateTables.ts` is the same small file in `backend/src/` and in `frontend/src/` (`splitIntoBlocks`).
6. The worker is `handleDocument()` in `backend/src/translateDocuments.ts`: calls 1 and 2, then calls 3 and 4
   (`makeLayout()`) when the overlay is on. `askModel()` takes an options object. The prompts are in
   `backend/src/translatePrompt.ts`; `TABLE_RULE` is a constant there.
7. `backend/src/translatePdf.ts` makes the PDF of the translation with `pdfkit`.
8. `ui.tsx` has `Modal`, `Notice` (tones `danger`, `warning`, `success`, `info`, `neutral`) and `btn()`.
   `dialogs.ts` has `askConfirm()` and `showMessage()`.
9. Jaya's test file: `Downloads\TestPDF.pdf` (spec 3). Page 2 is a table written as plain lines. Page 4 is
   the page with the translation on the photo. It is client data.

**Rules for all tickets**

1. No new npm dependency. The .zip and the photo PDF are our own small code (spec 6 and 7).
2. Calls 1 to 4 send exactly the same request as today. Do not change their prompts.
3. Client documents are private. Never send them, or their text, to the Claude API or any internet
   service. Never write document text into logs or the console, and never write the answer of call 5
   there. Print counts only.
4. Do not copy `TestPDF.pdf`, or any page of it, into the repo. Test files go in `data/` only.
5. Do not change how Generate, Games, Packs, Avatar, batches or the other Translate parts work,
   except where a ticket says so.
6. If something fails 2 times with the same error, stop and report. Do not keep retrying.
7. If a ticket and `CLAUDE.md` disagree, `CLAUDE.md` wins. Say so in the report.
8. Tailwind classes and theme colours for all new UI (CLAUDE.md section 15). Check both themes.

---

## FRG-107 — The Download dialog

**Branch:** `feat/FRG-107-translate-download-dialog`

**Goal:** One "Download" button opens a dialog that asks what to save and which pages.

**In scope**

1. The "Download" button in place of the three download controls (spec 5.1).
2. New file `frontend/src/TranslateDownload.tsx` with the dialog (spec 5.2), using `Modal` from `ui.tsx`.
   The choices "What" and "Pages". Not yet "Save as" (FRG-108).
3. The cells of spec 5.3 marked FRG-107 or "today":
   1. Translated photo: this page only, as a PNG. Move the code of FRG-106 here. Use the overlay that the
      page already loaded. The Pages choice is hidden for it.
   2. Translated text: this page, or all pages in one PDF.
   3. Plain text: this page, or all pages in one .txt.
4. The backend options `pdf?pages=one` and `text?pages=all` (spec 5.6). Without the option, both routes work
   exactly as today.
5. The note about pages that are not ready (spec 5.4), and the line "You get: ...".
6. The remembered choice in `localStorage` (spec 5.5), with try/catch.
7. The browser fetches each file and saves it with the names of spec 5.7. Backend errors are shown with
   `showMessage`.

**Out of scope:** the .zip (FRG-108), translated photos of all pages (FRG-108, FRG-109), empty rows (FRG-110).

**Exit criteria**

1. For page 4 of `TestPDF.pdf` each choice gives the right file, with the right name (spec 5.7).
2. "Translated text, Only page 2" gives a PDF with only page 2. "All pages" gives the same PDF as today.
3. "Plain text, All pages" gives one .txt with all pages in page order, each with its title line.
4. For a single photo (not a PDF file), the Pages choice is not shown.
5. A page without the translation on the photo shows "Translated photo" greyed out with the reason.
6. The dialog opens the next time with the last choice. It still works with `localStorage` blocked
   (test once in a private window).
7. A backend error (for example the PDF font missing) shows its text, and the dialog stays open.
8. Both themes checked. `npm run typecheck` and `tsc --noEmit` (backend) pass. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-108 — All pages, one file per page (.zip)

**Branch:** `feat/FRG-108-translate-download-zip`

**Goal:** Jaya can save all pages of a file as separate files, in one .zip.

**Needs:** FRG-107 is merged.

**In scope**

1. The "Save as" choice in the dialog (spec 5.2, point 3), shown only for "All pages".
2. New file `frontend/src/zipFiles.ts` (spec 6). Our own code, no package.
3. The .zip cells of spec 5.3: translated text, plain text and translated photos, one file per page.
4. A function in `TranslateOverlay.tsx` that makes the translated photo of any document, not only the open
   one, and the split of `overlayPng()` into `overlayCanvas()` and the PNG step (spec 6, last paragraph).
5. Pages are made one after another. The dialog button shows "Making page 3 of 12..." (spec 5.2).
6. Pages that are not ready, as in spec 5.4.

**Out of scope:** translated photos in one PDF (FRG-109). Until then, "Translated photo" with "All pages"
offers only "One file per page".

**Exit criteria**

1. For `TestPDF.pdf`, each of the three .zip files opens in Windows Explorer ("Extract all"). The files
   inside open, and they sort in page order (spec 5.7).
2. A file name with Japanese characters shows correctly in Windows Explorer. If it does not, say so in the report.
3. In the photo .zip, a page without the translation on the photo is the original file, named `... - original.<ext>`.
4. In the text .zip, a page that is not done is left out, and the dialog said so first.
5. The translated view on screen and the single PNG of one page look exactly as before (compare with a PNG
   saved before this ticket).
6. Making the photo .zip sends no request to the backend except the layout and the photos (check the
   browser's Network tab).
7. `npm run typecheck` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-109 — Translated photos of all pages in one PDF

**Branch:** `feat/FRG-109-translate-photo-pdf`

**Goal:** Jaya can save the translated photos of all pages as one PDF file.

**Needs:** FRG-108 is merged.

**In scope**

1. New file `frontend/src/imagePdf.ts` (spec 7). Our own code, no package.
2. The cell "Translated photo, All pages, one file" of spec 5.3, using the canvas function of FRG-108 and a
   JPEG at quality 0.9.
3. Pages that are not ready: the original photo (spec 5.4).

**Out of scope:** a PDF with the photo and the text together (spec 14).

**Exit criteria**

1. The PDF of `TestPDF.pdf` opens in Edge and in Chrome. It has one sheet per page, in page order.
2. Each sheet looks like the "Translated" view of that page. The text on the photo is sharp enough to read
   at 100% zoom.
3. The long side of each sheet is 842 points (the long side of A4, about 29.7 cm when printed), and the
   photo is not stretched.
4. A page without the translation on the photo is the original photo, and the dialog said so first.
5. The report gives the file size of the PDF for `TestPDF.pdf` and how many seconds it took.
6. No request to the backend except the layouts and the photos. `npm run typecheck` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-110 — Remove empty table rows

**Branch:** `feat/FRG-110-translate-empty-rows`

**Goal:** When the tables of a file have empty rows, Jaya can hide them on screen and in every download,
and show them again.

**Needs:** FRG-107 is merged (so all download routes of spec 5.6 exist).

**In scope**

1. `countEmptyRows()` and `withoutEmptyRows()` in both copies of `translateTables.ts`, the same code (spec 8.1, 8.2).
2. The field `hideEmptyRows` in `record.json`. An older document reads as false (spec 8.3).
3. The route `PUT /api/translate/documents/:id/empty-rows`. It sets all pages of the file (spec 8.3).
4. `emptyRows` in the answer of `GET /api/translate/documents` (spec 8.3).
5. The setting used on screen, in Copy, in the PDF and in the .txt, for one page and for all pages (spec 8.4).
   The Edit box still shows the full text.
6. The bar (spec 8.5).

**Out of scope:** the table bars (FRG-113), removing rows on only some pages (spec 14).

**Exit criteria**

1. On Jaya's page with empty rows, the bar shows the right counts, for the page and for the file.
2. "Remove empty rows" hides them in both text boxes, in Copy, in the PDF and in the .txt (one page and all pages).
   The header row stays. A row with `□` or `-` in it stays.
3. "Show them again" brings them back everywhere. The setting is still there after a backend restart.
4. Edit shows the full Japanese text, and "Save and translate again" keeps the setting.
5. A page without tables, or without empty rows in the file, shows no bar.
6. Both themes checked. `npm run typecheck` and `tsc --noEmit` (backend) pass. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-111 — Backend: find pages that look like a table

**Branch:** `feat/FRG-111-translate-table-hint`

**Goal:** After a page is translated, the backend knows if the photo looks like a table while the text is
not a table.

**In scope**

1. `looksLikeTable(layout)` in `backend/src/translateLayout.ts`, with the steps and constants of spec 9.
2. The field `tableHint` in `record.json`, worked out after every run of the worker (spec 9). An older
   document reads as `"none"`. `"dismissed"` stays `"dismissed"`.
3. The check script `npm run translate-table-check` (new file `backend/src/translateTableCheck.ts`, spec 9).
   Prints counts and "table" / "no table" only. No document text. No model, no GPU.
4. Add the command to CLAUDE.md section 10.

**Out of scope:** call 5 and the routes (FRG-112), anything on the page (FRG-113).

**Exit criteria**

1. After "Try again" on page 2 of `TestPDF.pdf`, `record.json` has `tableHint: "offer"`.
2. Page 4 has `tableHint: "none"`.
3. The report has the output of `npm run translate-table-check` for all of Jaya's done pages, and says which
   answers are wrong when Jaya looks at the photos. If more than 1 in 5 is wrong, say which constant would
   help, but do not change the method.
4. A page whose Japanese text already has a table gets `"none"`.
5. With `TRANSLATE_OVERLAY=off`, a new document gets `"none"`.
6. The backend log has no document text. `tsc --noEmit` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-112 — Backend: make it a table (call 5), Undo

**Branch:** `feat/FRG-112-translate-make-table`

**Goal:** The backend can rewrite the Japanese text of a page as a table, translate it again, and undo that.

**Needs:** FRG-111 is merged.

**In scope**

1. The call 5 prompt from spec 10.1 in `translatePrompt.ts`, using `TABLE_RULE`.
2. The fields `makeTable` and `tableUndo` in `record.json`. Older documents read as false.
3. The new status `arranging` in every place listed in spec 10.2 (last paragraph). Words on the page:
   "Making a table". Nothing else on the page.
4. In `handleDocument()`: when `makeTable` is true, call 5 in place of call 1, then calls 2, 3 and 4, and the
   checks of spec 10.2.
5. The copy of the old state (spec 11.1), and its removal by "Try again" and "Save and translate again".
6. The route `POST /api/translate/documents/:id/table` with the actions `make`, `undo`, `keep` and `dismiss`
   (spec 11). Check the id with the pattern first. `express.json()` like the Japanese route.

**Out of scope:** the bars and the button on the page (FRG-113).

**Exit criteria**

1. `make` on page 2 of `TestPDF.pdf` (with `curl` or the browser console): Waiting, Making a table,
   Translating, Placing, Done. Both texts now have a table. `tableUndo` is true.
2. The report says if the table on page 2 matches the photo (rows, columns, nothing left out), and gives
   the seconds of call 5.
3. `undo` puts back the old texts, `layout.json` and warnings at once, and `tableHint` becomes `"dismissed"`.
   The copy files are gone.
4. `make` on a page that already has a table gives 409 with the message. `undo` with nothing to undo gives 409.
5. When call 5 gives no table, the old state comes back with the warning. Test this once with a small temporary
   change in the code that is not committed. Say how in the report.
6. A document that is `arranging` cannot be removed. After a backend restart it goes back to `waiting` and
   the table is made.
7. A hand-corrected Japanese text keeps its corrections in the table, and stays "corrected by hand".
8. The backend log has no document text. `tsc --noEmit` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.

---

## FRG-113 — Frontend: the table bars and the "Make a table" button

**Branch:** `feat/FRG-113-translate-table-bars`

**Goal:** Jaya sees the offer to make a table, can make it, and can undo it or keep it.

**Needs:** FRG-112 is merged.

**In scope**

1. The offer bar and the after bar (spec 12, points 1 and 2), using `Notice` from `ui.tsx`.
2. The "Make a table" button in the header of the Japanese text box (spec 12, point 3).
3. The buttons call `POST .../table` with the right action and load the list again. Errors show like other
   errors on the page.
4. The page shows "Making a table" while the status is `arranging`.

**Out of scope:** changing the table by hand other than with Edit (spec 14).

**Exit criteria**

1. Page 2 of `TestPDF.pdf` shows the offer bar. Page 4 does not.
2. "Make it a table" shows "Making a table", then both texts as tables, and the after bar.
3. "Undo" brings back the old texts and the bar goes away. The offer bar does not come back.
4. "Keep the table" hides the after bar and keeps the table.
5. "Keep as text" hides the offer bar, also after "Try again".
6. The "Make a table" button shows only on a done page whose Japanese text has no table.
7. With the empty rows bar of FRG-110, the bars are in the order of spec 12.
8. Both themes checked. `npm run typecheck` passes. No new dependency.

**Report:** DONE / NOT DONE / BLOCKED / NOTICED / HOW TO TEST.
