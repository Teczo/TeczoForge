# Translate: downloads, empty table rows and tables (feature spec)

It is the plan for one feature. It is NOT a ticket. The tickets are in
`docs/tickets/FRG-107-113_Translate_downloads_and_tables_tickets.md`.
It adds to the Translate feature. Read `docs/japanese-translate.md` and `docs/translate-overlay.md` first.

Written: 19 November 2026.

## 1. What the feature does

Four small things on the Translate page:

1. **Download dialog.** One "Download" button opens a dialog. It asks:
   what (translated photo, translated text as a PDF, or plain text), which pages (all pages of the
   file, or only this page), and how (one file, or one file per page in a .zip).
2. **Translated photos of all pages.** The translated photos of all pages of a PDF file can be saved
   as one PDF, or as one PNG for each page.
3. **Remove empty table rows.** When the tables of a file have rows with nothing in them, a bar offers
   to hide those rows on screen and in every download. It can be undone.
4. **Make it a table.** When a page looks like a table on the photo, but the text was not written as
   a table, a bar offers to rewrite the text as a table. It can be undone.

## 2. Decisions already made

| Topic | Decision | Why |
|---|---|---|
| Where the downloads are | One "Download" button and a dialog (`Modal` from `ui.tsx`), in place of the three download buttons | Three choices with 2 or 3 options each. A list of 9 menu items is harder to read. |
| What a "file" is | The pages of one uploaded PDF file (same `fileId`). A photo is a file of one page. | Same as "Download PDF" and "Remove" today. |
| One file per page | A .zip, made in the browser by our own small code | No loose files in Downloads. No new package. PNG and PDF are already compressed, so the zip only stores them. |
| Translated photos in one PDF | Made in the browser by our own small code, with each photo as a JPEG | The photos are drawn in the browser (FRG-106). Nothing is uploaded. A PDF can hold a JPEG as it is. |
| Empty rows | One setting for the whole file, saved in `record.json`. The text itself is not changed. | One click for a form of 20 pages. "Show them again" works, and Edit still sees the full text. |
| Finding a table page | Look at the boxes of call 3 (`layout.json`): do they line up in rows and columns? | No extra model call and no extra time. It is based on the photo. |
| Making the table | A new call 5: the photo and the current Japanese text in, the same text as a Markdown table out | The reading stays the same, also a hand correction. Only the layout changes. |
| Undo | The old texts are kept in the document folder until the person keeps the table | Undo is instant and needs no GPU. |
| Cloud | None | The same rule as the whole Translate feature (CLAUDE.md section 7, rule 11). |

## 3. The test pages

Jaya's test file is `Downloads\TestPDF.pdf`. It is client data: do not copy it into the repo, and do not
write its text into docs, tickets or logs. Upload it on the Translate page like any PDF.

1. **Page 2** is a table on the photo, but the model wrote the text as plain lines. It is the test page
   for "Make it a table".
2. **Page 4** is the handwritten page with the translation on the photo. It is the test page for the
   translated photo downloads. It is not a table: the table bar must not show there.
3. For empty rows: Jaya picks a page whose table has empty rows (for example a form with blank lines).

## 4. Changes needed in CLAUDE.md

None before the first ticket. No new npm package is needed.
FRG-111 adds one command to CLAUDE.md section 10 (definition of done, point 4).

## 5. The Download dialog (FRG-107)

### 5.1 The button

In `Result()` on the Translate page, the three download controls ("Download .txt", "Download PDF",
"Download translated image") become one button **Download** (icon `Download`). It can be pressed when
the document is `done`, like the buttons today. It opens the dialog. The dialog is a new file,
`frontend/src/TranslateDownload.tsx`, so `TranslatePage.tsx` does not grow much.

### 5.2 The dialog

Title: `Download <file name>`.

1. **What** (one choice, each with a short grey line under it):
   1. "Translated photo": "The photo with the translation written on it".
      Not possible when no page that the download would hold has the translation on the photo
      (`overlay` is not `done`). Then it is shown greyed out, with that reason in its grey line.
   2. "Translated text": "The translation, with tables, as a PDF file".
   3. "Plain text": "The Japanese text and the translation, as a .txt file".
2. **Pages**. Only for a PDF file with more than one page:
   "All 12 pages" | "Only page 2". For a photo it is not shown.
3. **Save as**. Only when "All pages" is picked (FRG-108):
   "One file with all pages" | "One file per page (.zip)".
4. A line "You get: <file name>" that changes with the choices.
5. A note about pages that are not ready (5.4), when there are any.
6. Buttons "Cancel" and "Download". While the file is made, the Download button says
   "Making the file..." (or "Making page 3 of 12..." when pages are made one by one) and cannot be pressed.
   When the file is saved, the dialog closes. On an error, `showMessage` shows the error text and the
   dialog stays open.

### 5.3 What each choice gives

| What | Only this page | All pages, one file | All pages, one file per page |
|---|---|---|---|
| Translated photo | PNG (today, FRG-106) | PDF, one photo on each sheet (FRG-109) | .zip of PNG files (FRG-108) |
| Translated text | PDF of this page (FRG-107) | PDF of all pages (today) | .zip of PDF files (FRG-108) |
| Plain text | .txt of this page (today) | .txt of all pages (FRG-107) | .zip of .txt files (FRG-108) |

For a photo (not a PDF file) only the first column exists. Each ticket adds its cells.
A choice that is not built yet is not offered: for example, in FRG-107 "Translated photo" is always
this page only, and the Pages choice is hidden for it.

### 5.4 Pages that are not ready

The browser already has the list of all documents, so the dialog knows the state of every page of the file.
Before the download, it says which pages are not ready, with at most 5 page numbers ("Pages 3, 7 and 9",
or "Pages 3, 7, 9, 11, 12 and 4 more"):

| Download | A page that is not `done` | A done page without the translation on the photo |
|---|---|---|
| Text or plain text, one file | Its part says "This page is not translated yet." (as the PDF does today) | — |
| Text or plain text, one file per page | Left out of the .zip | — |
| Translated photo, one file | The original photo | The original photo |
| Translated photo, one file per page | The original file, named `... - original.<jpg, png or webp>` | The same |

Note texts, for example: "Pages 3 and 7 are not translated yet. They say so in the file." and
"Page 7 has no translation on the photo. It goes in as the original photo."

### 5.5 The remembered choice

The last choice is kept in `localStorage` (`teczoforge.translateDownload`): what, pages, save as.
Wrap every read and write in try/catch: the dialog must work without it. When the remembered choice is
not possible for this document (for example "Translated photo" and no overlay), the dialog picks
"Translated text" instead.

First time: "Translated photo" when this page has the translation on the photo, else "Translated text".
"All pages". "One file with all pages".

### 5.6 Backend changes

1. `GET /api/translate/documents/:id/pdf?pages=one`: only this page. Without `pages`, or with
   `pages=all`: all pages of the file, as today. Any other value: HTTP 400.
2. `GET /api/translate/documents/:id/text?pages=all`: all pages of the file in page order. Each page
   starts with its title line (`TestPDF.pdf - page 2 of 12`), then "Japanese:", the text, the language
   name and the translation, then one empty line. A page that is not done says "This page is not
   translated yet." Without `pages`, or with `pages=one`: this page only, as today. Any other value: HTTP 400.

The download name in the `Content-Disposition` header stays the id (the user's file name never goes into
a header). The browser fetches the file and saves it under a good name itself (5.7).

### 5.7 File names

`<name>` is the uploaded file name without its extension (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`),
with the characters that Windows does not allow made into `_` (the `fileNameOf()` rule from FRG-106).
For a photo, the part ` - page 2` is left out.

| Download | File name |
|---|---|
| Translated photo, one page | `<name> - page 2 - translated.png` |
| Translated photos, one PDF | `<name> - translated.pdf` |
| Translated photos, .zip | `<name> - translated photos.zip` |
| Translated text, one page | `<name> - page 2 - translation.pdf` |
| Translated text, all pages | `<name> - translation.pdf` |
| Translated text, .zip | `<name> - translation.zip` |
| Plain text, one page | `<name> - page 2 - text.txt` |
| Plain text, all pages | `<name> - text.txt` |
| Plain text, .zip | `<name> - text.zip` |

Inside a .zip, each file is named like a one-page download, with the page number in 2 digits so the
files sort in page order: `<name> - page 02 - translated.png`.

This changes the PNG name of FRG-106 a little (the file name without ".pdf", and without "of 12").

## 6. One file per page: the .zip (FRG-108)

New file `frontend/src/zipFiles.ts` with one function:
`zipFiles(files: { name: string; data: Blob }[]): Promise<Blob>`.

1. A normal .zip file that Windows Explorer can open. Each file is stored as it is, without compression
   (compression method 0). PNG, PDF and JPEG are already compressed.
2. Each file needs its CRC-32 check number. It is a short sum with a table of 256 numbers. Write it in
   the same file, with a comment.
3. The parts: for each file a "local file header" and the file itself, then the "central directory"
   (one entry per file), then the "end of central directory" record. All numbers are little-endian.
4. File names are UTF-8, and the "UTF-8 names" flag (bit 11) is set, so Japanese file names work.
5. No "zip64": the total must stay under 4 GB. 30 pages are far below that. Over it: an error
   "These files are too big for one .zip file."

The pages are made one after another, not all at once, so the browser does not hold all big pictures at the same time:

1. Translated text: `GET .../pdf?pages=one` for each done page.
2. Plain text: `GET .../text` for each done page.
3. Translated photo: the translated PNG of each page (below), or the original photo (5.4).

To make the translated photo of a page that is not open on the screen, `TranslateOverlay.tsx` gets a
function that does what `useOverlay()` and `overlayPng()` do together, for any document id:
load `layout.json` and the photo, fit the blocks, draw on a canvas. Split `overlayPng()` into
`overlayCanvas(overlay)` (draws the photo and the blocks) and the PNG step, so FRG-109 can make a JPEG
from the same canvas. The screen and the single PNG must look exactly as before.

## 7. Translated photos in one PDF (FRG-109)

New file `frontend/src/imagePdf.ts` with one function:
`imagesToPdf(pages: { jpeg: Uint8Array; width: number; height: number }[]): Blob`.

1. Each page of the PDF is one photo, as a JPEG (`canvas.toBlob("image/jpeg", 0.9)`). A PDF can hold a
   JPEG file as it is (`/Filter /DCTDecode`). A PNG would need to be unpacked first, so JPEG is used here.
2. The sheet size: the longest side of the photo becomes 842 points (the long side of A4). The other side
   follows the shape of the photo. The photo fills the whole sheet.
3. The parts of the PDF, written by hand: the header `%PDF-1.4`, the catalog, the page list, and for each
   page: the page, its content (`q <w> 0 0 <h> 0 0 cm /Im0 Do Q`) and the image. Then the "xref" table
   with the byte position of every object, the trailer and `%%EOF`. Only plain ASCII text besides the
   JPEG bytes.
4. Pages that are not ready: the original photo (5.4), drawn on a canvas and saved as JPEG the same way.

Nothing is sent to the backend. The single PNG of one page stays a PNG.

## 8. Empty table rows (FRG-110)

### 8.1 What an empty row is

A row of a table (a Markdown table, see `docs/japanese-translate.md` section 17) where every cell is
empty or only spaces. The header row (the row above the `|---|` line) is never removed.
A cell with `□`, `-` or `[unclear]` is not empty: something is written there.

### 8.2 Two new functions in `translateTables.ts`

In both copies (`backend/src/` and `frontend/src/`), the same code:

1. `countEmptyRows(text: string): number`
2. `withoutEmptyRows(text: string): string`: the same text without the lines of empty rows. All other
   lines stay exactly as they are.

### 8.3 The setting

New field in `record.json`: `hideEmptyRows` (true or false). An older document without it reads as false.
It is the same for all pages of one file.

New route `PUT /api/translate/documents/:id/empty-rows`, body `{ "hide": true }` or `{ "hide": false }`.
It sets `hideEmptyRows` on all pages of the file and saves them. It works in every status (it is only a
setting). Answer: `{ changed: <number of pages> }`.

`GET /api/translate/documents` also gives `emptyRows` for each document: `countEmptyRows(english)`.
It is worked out when the list is asked for, not saved.

### 8.4 Where the setting is used

When `hideEmptyRows` is true, `withoutEmptyRows()` is used on:

1. Both text boxes on the page (Japanese and translation), and their "Copy".
2. The PDF download and the .txt download, for each page by its own setting.

Not on: the Edit box (it shows and saves the full Japanese text), the model calls, and the translation
on the photo (an empty row has no text on the photo).

### 8.5 The bar

Above the texts, under the photo and the warnings, when the document is `done` and the file has empty rows
(the sum of `emptyRows` over the pages of the file is more than 0). A `Notice` with tone `neutral`:

1. Not hidden: "The tables in this file have 7 empty rows (3 on this page)." Button "Remove empty rows".
   For a photo: "The tables on this page have 3 empty rows."
   When this page has none, but other pages of the file have some: "(none on this page)".
2. Hidden: "7 empty rows are hidden on screen and in downloads." Button "Show them again".

## 9. Finding a page that looks like a table (FRG-111)

After calls 3 and 4 have made `layout.json`, the backend looks at the boxes.
New function `looksLikeTable(layout)` in `backend/src/translateLayout.ts`. It gives back the counts and
the answer: `{ rows: number; columns: number; table: boolean }`.

All sizes are on the 0-1000 grid. The numbers are constants at the top of the file, so they are easy to change.

1. Use the horizontal blocks (`dir: "h"`). The box of a block is the box around all its lines.
2. **Rows.** Go through the blocks from top to bottom (by the top of their box). A block belongs to the row
   of an earlier block when its middle (top to bottom) lies between the top and the bottom of that block.
   Otherwise it starts a new row.
3. A row **has cells** when it has 2 or more blocks next to each other that do not overlap from left to right.
4. **Columns.** Go through the blocks of the rows with cells. A block belongs to a column when, from left to
   right, it overlaps the first block of that column by at least half of the narrower of the two.
   Otherwise it starts a new column.
5. The page **looks like a table** when at least 3 rows have cells (`MIN_TABLE_ROWS = 3`), and at least
   2 columns (`MIN_TABLE_COLUMNS = 2`) each have a block in at least 3 of those rows.

New field in `record.json`: `tableHint`:

| Value | Meaning |
|---|---|
| `"none"` | No bar. Also for an older document without the field. |
| `"offer"` | The page looks like a table, and the Japanese text has no table (`splitIntoBlocks`). The bar shows. |
| `"dismissed"` | The person pressed "Keep as text". It stays like this, also after "Try again". |

It is worked out again after every run of the worker. When the overlay is off or failed, it is `"none"`
(unless it is `"dismissed"`).

Known limit: call 3 leaves out text that is only numbers or codes. So a column with only numbers has
no boxes. A table is found only when at least 2 of its columns have Japanese words. For other pages the
person uses the "Make a table" button (section 12).

**Check script.** `npm run translate-table-check` reads `layout.json` of every done document and prints
one line for each: the id, rows with cells, columns, and "table" or "no table". With `-- <document id>`
it does one document. It reads files only: no model, no GPU. It prints no document text.
It is for Jaya to tune the numbers above on real pages.

## 10. Make it a table: call 5 (FRG-112)

### 10.1 The call

Same address and settings as calls 1 and 2 (`docs/japanese-translate.md` section 9), with the photo,
`max_tokens` 4096, no JSON schema. The prompt goes into `backend/src/translatePrompt.ts`.
It uses the same `TABLE_RULE` as call 1, so the table has the same form.

System text:

```
You rewrite the transcript of a Japanese document as a table.
You get the photo of a page, and a transcript of the same page that was written as plain lines.
The page has a table (a grid of rows and columns), but the transcript does not show it.
Rules:
- Look at the photo to see the rows and the columns of the table.
<TABLE_RULE>
- Use the text of the transcript. Do not read the photo again for the text, and do not correct it:
  only put the text into the right cells.
- Do not leave out any text. Text that is not in the table stays as plain lines, before or after the
  table, in the reading order of the page.
- Do not translate. Do not explain.
Answer with the transcript only.
```

User text: `Transcript:\n<the Japanese text>\n\nWrite this transcript with its table.`

### 10.2 How it runs

1. `POST /api/translate/documents/:id/table` with `{ "action": "make" }` (11) saves a copy of the old
   state (11.1), sets the new field `makeTable` to true and the status to `waiting`, and starts the worker.
2. In `handleDocument()`, when `makeTable` is true: new status `arranging` ("Making a table"), then call 5
   on the current Japanese text, in place of call 1. Then calls 2, 3 and 4 as usual. `japaneseEdited`
   stays as it was: a hand correction stays a hand correction.
3. Checks on the answer of call 5:
   1. No table in it (`splitIntoBlocks`): the old state comes back (11.1), with the warning
      "No table could be made from this page. The text is as before." The document is `done`.
   2. The characters are compared with the old Japanese text, leaving out spaces, new lines, `|`, `-`
      and `:`. When N characters are missing or new, add the warning
      "N characters of the table are not the same as in the text before. Compare the table with the photo."
4. At the end `makeTable` is false, and `tableUndo` is true (11.1).

Every place that lists the statuses must know `arranging` (like `placing` in `docs/translate-overlay.md`
section 10): the `Status` type, the reset after a restart (back to `waiting`; `makeTable` stays true, so the
work starts again), the guard in the remove route, and on the page `DocStatus`, `STATUS_WORDS` and the
Remove button.

## 11. Undo, Keep the table, Keep as text (FRG-112)

One route: `POST /api/translate/documents/:id/table`, body `{ "action": "..." }`. Check the id first.

| Action | When | What it does | Refused with |
|---|---|---|---|
| `make` | Status `done`. The Japanese text is not empty and has no table. | 10.2 | 409 "Wait until this page is done." / 409 "The text already has a table. Use Edit to change it." |
| `undo` | Status `done` or `failed`, and `tableUndo` is true | Puts the old state back (11.1). `tableHint` becomes `"dismissed"`. Instant, no GPU. | 409 "There is nothing to undo." |
| `keep` | `tableUndo` is true | Deletes the copy. `tableUndo` becomes false. | 409 "There is nothing to undo." |
| `dismiss` | Any status | `tableHint` becomes `"dismissed"`. | — |

Any other action: HTTP 400.

### 11.1 The copy of the old state

1. `before-table.json` in the document folder: `japanese`, `japaneseEdited`, `english`, `warnings`,
   `overlay`, `seconds` and `tableHint`, as they were before "make".
2. `before-table-layout.json`: a copy of `layout.json`, when there was one.
3. New field `tableUndo` in `record.json`: true while the copy exists.
4. Undo writes these back, puts `layout.json` back (or removes it when there was none), and deletes the copy.
5. "Try again" and "Save and translate again" delete the copy first, and set `tableUndo` to false. Their
   result is newer than the copy.
6. If the make-table run fails (status `failed`), Undo still puts the old texts back.
7. "Remove" deletes the whole folder, the copy too.

## 12. The table bars on the page (FRG-113)

Above the texts, under the photo and the warnings, above the empty rows bar.

1. **Offer** (`tableHint` is `"offer"` and the status is `done`). `Notice` tone `info`, with a table icon from
   `lucide-react`: "This page looks like a table, but the text is not written as one."
   Buttons "Make it a table" and "Keep as text".
2. **After** (`tableUndo` is true and the status is `done` or `failed`). `Notice` tone `success`:
   "The text is now a table. Check it against the photo." Buttons "Undo" and "Keep the table".
3. **The "Make a table" button**: in the header of the Japanese text box, next to "Edit". Shown when the
   status is `done` and the Japanese text has no table. For pages where the bar does not show (9, known limit).
   It does the same as "Make it a table" in the bar.

While the status is `arranging`, the page shows "Making a table". The Japanese box keeps showing the old
text until call 5 is done.

## 13. Summary: new fields, status and routes

New fields in `record.json` (an older document without them reads as the first value):

| Field | Values | Ticket |
|---|---|---|
| `hideEmptyRows` | false, true | FRG-110 |
| `tableHint` | `"none"`, `"offer"`, `"dismissed"` | FRG-111 |
| `makeTable` | false, true | FRG-112 |
| `tableUndo` | false, true | FRG-112 |

`GET /api/translate/documents` also gives `emptyRows` (worked out, not saved, FRG-110).

New status: `arranging`, words "Making a table" (FRG-112).

New and changed routes:

| Route | Ticket |
|---|---|
| `GET /api/translate/documents/:id/pdf?pages=one` | FRG-107 |
| `GET /api/translate/documents/:id/text?pages=all` | FRG-107 |
| `PUT /api/translate/documents/:id/empty-rows` | FRG-110 |
| `POST /api/translate/documents/:id/table` | FRG-112 |

New files: `frontend/src/TranslateDownload.tsx` (FRG-107), `frontend/src/zipFiles.ts` (FRG-108),
`frontend/src/imagePdf.ts` (FRG-109), `backend/src/translateTableCheck.ts` (FRG-111, the check script).

## 14. Not in the first version

- Downloading several separate photos together (photos that were not one PDF file). That needs a way to
  pick documents in the list. Later, if Jaya asks.
- A PDF with the translated photo and the translated text of each page together.
- Removing empty rows on only some pages of a file.
- Making a table from a part of a page only, or changing the table by hand other than with Edit.
- The download dialog opening by itself when a file is done. The person checks the text first.

## 15. How Jaya tests the result

1. Upload `TestPDF.pdf`. Wait until all pages are done.
2. Download, page 4: each choice of the dialog once. Open every file. Check the names (5.7).
   The translated photos look the same as the "Translated" view on screen.
3. Download with a page that is not done (upload again and download while it runs): the note in the dialog
   is right, and the files do what 5.4 says.
4. Empty rows: on the page with empty rows, press "Remove empty rows". The rows are gone in both text boxes,
   in Copy, in the PDF and in the .txt. Edit still shows them. "Show them again" brings them back.
5. Table: page 2 shows the table bar. Page 4 does not. "Make it a table" gives a table in both texts.
   Compare it with the photo. "Undo" brings the old text back at once. Do it again, then "Keep the table".
6. `npm run translate-table-check` on all pages. Note the pages where the answer is wrong.

## 16. Tickets

| # | Ticket | Needs |
|---|---|---|
| FRG-107 | The Download dialog | — |
| FRG-108 | All pages, one file per page (.zip) | FRG-107 |
| FRG-109 | Translated photos of all pages in one PDF | FRG-108 |
| FRG-110 | Remove empty table rows | FRG-107 |
| FRG-111 | Backend: find pages that look like a table | — |
| FRG-112 | Backend: make it a table (call 5), Undo | FRG-111 |
| FRG-113 | Frontend: the table bars and the "Make a table" button | FRG-112 |
