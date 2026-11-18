# Translation on the photo (feature spec)

It is the plan for one feature. It is NOT a ticket. The tickets are in
`docs/tickets/FRG-103-106_Translate_overlay_tickets.md`.
It adds to the Translate feature. Read `docs/japanese-translate.md` first.

Written: 18 November 2026.

## 1. What the feature does

Today the Translate page shows the photo, the Japanese text and the English text next to each other.
This feature also puts the English text **on top of the photo**, in the place of the Japanese.
This works like Google Translate on a photo:

1. Find each block of text on the photo (a paragraph, a note, a table cell).
2. Cover the Japanese with the colour of the paper.
3. Write the English in the same place, at about the same size as the handwriting.

A switch above the photo changes between "Translated" and "Original".
"Download translated image" saves the translated photo as a PNG file.

The Japanese and English text boxes stay. They are still the place to check the work.
The overlay helps a person read the page. It does not replace checking.

## 2. Decisions already made

| Topic | Decision | Why |
|---|---|---|
| Where the text positions come from | The same Qwen model in llama-server, one new call (call 3) | No new engine, no new package. Qwen vision models can give a box around each line of text. |
| What is translated for the photo | Blocks, not single lines (call 4) | A Japanese sentence often runs over 2 or 3 lines. Line by line, the English breaks in the middle of a sentence. |
| Where the drawing happens | In the browser, as an SVG layer on top of the photo | It can be switched on and off. It grows and shrinks with the photo. No new package. |
| The two texts that already exist | Calls 1 and 2 do not change | Copy, Edit, Download .txt and Download PDF keep working as they are today. |
| GPU | Calls 3 and 4 run in the same worker, while llama-server is still loaded | Nothing changes for GPU sharing with ComfyUI. |
| Cloud | None | The same rule as the whole Translate feature (CLAUDE.md section 7, rule 11). |

## 3. The test page

Jaya's test file is `Downloads\TestPDF.pdf`, page 4. It is client data: do not copy it into the repo,
and do not write its text into docs, tickets or logs. Upload it on the Translate page like any PDF.

Page 4 is a **photo** of a page (it has no text layer). It shows the hard cases this feature must handle:

1. The main text is handwritten in horizontal lines. Most sentences run on to the next line.
2. Short notes are written **vertically** in the top-left corner. A small handwritten note is in the top-right corner.
3. The printed letterhead is already in **English**. It must stay as it is.
4. **Red seals and stamps.** They must stay as they are.
5. Faint text **shows through from the back** of the paper. It must not be translated.
6. The photo is a little **tilted**, and the paper is curved.

## 4. Changes needed in CLAUDE.md

Jaya must add this to CLAUDE.md first. Until then CLAUDE.md wins and Claude Code must stop and ask.

Proposed text, CLAUDE.md section 15, rule 3, one new line at the end:

`Exception: the translation overlay on the Translate page (docs/translate-overlay.md) takes the paper colour and the ink colour from the photo itself. Those colours come from the picture, not from the theme.`

No new npm package is needed.

## 5. How it works

```
Worker, for each document:
  call 1   photo                         -> Japanese text        (no change)
  call 2   Japanese + photo              -> English text         (no change)
  call 3   photo + Japanese              -> where each line is   (new)
  call 4   Japanese blocks + English     -> English per block    (new, text only, no photo)
           save layout.json

Browser:
  GET /api/translate/documents/:id/layout
  find the ink, cover the Japanese, fit and draw the English  (SVG on top of the photo)
```

Calls 3 and 4 make the "overlay". If they fail, the document is still **done**: the texts are fine.
The page then shows a warning, and the photo without an overlay.

## 6. Env var (add to `backend/.env.example` with this comment)

| Name | Example | Meaning |
|---|---|---|
| `TRANSLATE_OVERLAY` | `on` | `on`: put the translation on the photo (calls 3 and 4). `off`: skip them. Each page takes longer with `on`. |

Any value other than `off` means `on`.

## 7. Call 3: where each line is

Same address and settings as calls 1 and 2 (`docs/japanese-translate.md` section 9), with these changes:

- `max_tokens`: 8192. A full page has many lines, and each line needs a box.
- `response_format`: a JSON schema (below), so the answer is always JSON.
  **Check before coding (FRG-103):** confirm the installed llama-server accepts `response_format` with a
  JSON schema in `/v1/chat/completions`. If it does not, stop and report.

System text:

```
You find where text is written in a photo of a Japanese document.
You get the photo, and a transcript that was made from the same photo.
For every line of Japanese text in the photo, give:
- "box": the box around the line, as [x1, y1, x2, y2] on a 0-1000 grid.
  0,0 is the top left corner of the photo. 1000,1000 is the bottom right corner.
- "text": the text of that line, copied from the transcript.
- "dir": "h" for a horizontal line, "v" for a vertical column.
- "block": a number. Lines of the same paragraph, the same note or the same table cell get the same number.
  Number the blocks from 1, in reading order.
Rules:
- One entry for each line of the page. A vertical column is one line.
- A table cell is its own block.
- Leave out seals, stamps, signatures and drawings.
- Leave out text that is only in English, or only numbers and codes.
- Leave out faint text that shows through from the back of the paper.
Answer with JSON only.
```

User text: `Transcript:\n<the Japanese text>\n\nFind every line of Japanese text in the photo.`

JSON schema of the answer:

```jsonc
{ "lines": [ { "block": 4, "dir": "h", "box": [118, 452, 905, 478], "text": "..." } ] }
```

**Check before coding (FRG-103):** Qwen3-VL models give boxes on a 0-1000 grid of the photo.
Older Qwen models gave pixels of the shrunk photo instead. Find out which one Qwen3.8 gives
(the test script in FRG-103 draws the boxes, so it is easy to see). If it gives pixels, stop and report.

Checks on the answer (the backend drops a line that fails a check):

1. `box` has 4 numbers. Each is cut to 0-1000. `x1 < x2` and `y1 < y2`.
2. `block` is a whole number from 1 to 500. `dir` is `h` or `v`.
3. `text` is at most 500 characters, and has at least one Japanese character (kanji, hiragana or katakana).
   This is a second guard for the English letterhead and for lines that are only numbers.
4. At most 300 lines are kept.

If the answer is not JSON, or no line is left: the overlay fails with
"The translation could not be placed on the photo." (section 9).

## 8. Call 4: English for each block

Text only. **No photo**, so it is quick. `max_tokens`: 4096. `response_format`: a JSON schema.
Put the value of `TRANSLATE_TARGET_LANGUAGE` in place of English.

System text:

```
You are a careful translator of Japanese business and technical documents into English.
You get numbered blocks of Japanese text from one page, and a full translation of the same page.
Translate each block on its own, so it can be printed in the place of the Japanese.
Rules:
- Where the full translation already covers the same text, use its wording. Do not translate it in a new way.
- Keep the block numbers. Give every block exactly one translation.
- Copy all numbers, dates, units and codes exactly.
- Write names of people and places in romaji only, without the Japanese in brackets.
- Keep it short: it must fit in the same space as the Japanese. Do not add notes or explanations.
- If a block cannot be read, write [unclear].
Answer with JSON only.
```

User text: `Full translation:\n<the English text>\n\nBlocks:\n<JSON list of { "block": n, "japanese": "..." }>`

The Japanese of a block is its lines from call 3, in order, joined with a new line.

JSON schema of the answer:

```jsonc
{ "blocks": [ { "block": 4, "english": "..." } ] }
```

A block with no translation in the answer is not drawn. If that happens to one or more blocks, add the
warning "Some parts of the page have no translation on the photo."

Both prompts go into `backend/src/translatePrompt.ts`, next to the prompts of calls 1 and 2.
`askModel()` gets an options object: the photo (or none), `max_tokens`, and the JSON schema.

## 9. Files on disk and the record

New file in each document folder: `data/translations/<id>/layout.json`.

```jsonc
{
  "grid": 1000,              // boxes are on a 0-1000 grid of the photo
  "blocks": [
    {
      "block": 4,
      "dir": "h",
      "lines": [ { "box": [118, 452, 905, 478], "japanese": "..." } ],
      "english": "..."
    }
  ]
}
```

New fields in `record.json`:

| Field | Values | Meaning |
|---|---|---|
| `overlay` | `"none"`, `"done"`, `"failed"` | `none`: not made (switched off, or an old document). |

Older documents have no `overlay` field: read it as `"none"`, like the page fields in FRG-95.

When the overlay fails, add the warning "The translation could not be placed on the photo."
The document is still `done`. Never write the model's answer into the log: it holds document text.

## 10. Status and routes

New status `placing`, between `translating` and `done`. Words on the page: "Placing the text on the photo".

Every place that lists the statuses must know it:

1. `backend/src/translateDocuments.ts`: the `Status` type, the reset after a restart (back to `waiting`),
   and the guard in the remove route (a document that is `placing` cannot be removed).
2. `frontend/src/TranslatePage.tsx`: the `DocStatus` type, `STATUS_WORDS`, and the Remove button.
   While a document is `placing`, the English text box already shows the English.

New route:

| Route | What it does |
|---|---|
| `GET /api/translate/documents/:id/layout` | `layout.json`. HTTP 404 "This document has no overlay." when there is none. |

"Try again" and "Save and translate again" (FRG-94) run calls 3 and 4 again too, so the overlay
always matches the newest texts. An old document gets an overlay after "Try again".

## 11. Drawing the overlay (frontend)

New files: `frontend/src/translateOverlay.ts` (the sums: find the ink, colours, fitting the text)
and `frontend/src/TranslateOverlay.tsx` (the SVG layer). Each step below is a small function.

The photo is read once into a canvas at full size, to look at its pixels. A box on the 0-1000 grid
becomes pixels by `x * photoWidth / 1000` and `y * photoHeight / 1000`.

1. **Find the ink.** The model's box is often a little too big or too small. For each line:
   1. Make the box bigger by 10% of its height on each side.
   2. Paper colour: the middle value (median) of the pixels on the edge of that bigger box.
   3. Ink: pixels that are at least 60 (of 255) darker than the paper.
   4. The new box is the rows and columns that have ink. If there is no ink, keep the model's box.
   5. If less than 1% of the box is ink, the line is faint text from the back of the paper. Do not draw it.
   The new box gives the real height of the handwriting. That is what makes the English the same size.
2. **The block.** The block's area is all of its line boxes together, plus a small margin
   (15% of the middle line height).
3. **Cover the Japanese.** Fill the block's area with the paper colour. Take the paper colour at the
   left edge and at the right edge, and fill with a gradient from one to the other, because a photo is
   lit unevenly. Give it a soft edge of about 3 pixels. The patch is 3 pixels bigger on each side, so the
   soft edge does not show the old ink.
4. **Ink colour.** The middle value of the ink pixels of the block. The English is written in this colour.
5. **Font size.** Start at 0.85 times the middle line height of the block (for a vertical block: the
   middle column width). Font: the app font (`--font` in `theme.css`, "Inter Variable").
   Wait for `document.fonts.load()` before measuring.
6. **Fit the text.** Break the English into lines that fit the block's width (`measureText` on the canvas).
   The line height is 1.2 times the font size. If the lines do not fit the block's height, make the
   font 5% smaller and try again. Stop at 55% of the start size. If it still does not fit:
   1. Let the block grow down into empty paper, up to the next block below or the end of the photo.
   2. If it still does not fit, cut the last line with "…". The full text shows on hover.
   A single word that is wider than the block is broken.
7. **Vertical blocks** (`dir: "v"`): the English is turned 90 degrees clockwise, so it runs down the column.
   Fitting uses the block's height as the width.
8. **Draw.** An `<svg>` on top of the `<img>`, with `viewBox="0 0 <photo width> <photo height>"`.
   So all sizes are photo pixels, and the layer grows and shrinks with the photo by itself.
   For each block: a `<rect>` (the patch) and a `<text>` with one `<tspan>` for each line.
   A `<title>` in each block shows "Japanese: ... English: ..." on hover.

The fitting function, `fitBlock(block, measure)`, gets the measuring function from outside. So the
SVG, the PNG download, and a PDF later all use the same result.

On the page:

1. Above the photo: `Tabs` (from `ui.tsx`) "Translated" | "Original". "Translated" is picked when the
   overlay is `done`. With no overlay, the tabs are not shown.
2. In the "Translated" view the photo is not a link (the hover needs the mouse). A small
   "Open full size" button opens the photo in a new tab, like the link today.
3. The colours of the patch and the text come from the photo (section 4). They are the same in light
   and dark mode. That is correct: they are part of the picture.

## 12. Download translated image

A button "Download translated image" next to "Download PDF". Only when the overlay is `done`.

In the browser: a canvas at the photo's full size. Draw the photo, then each block with the same result
from `fitBlock` (patch with `createLinearGradient`, soft edge with the canvas `filter: blur(3px)`,
then `fillText` line by line). Save with `toBlob("image/png")`.
File name: the document title, then " - translated.png".

Nothing is uploaded. The PNG is made in the browser and saved by the browser.

## 13. Not in the first version

- A PDF download with the overlay (`translatePdf.ts` can draw the photo and the same blocks later).
- Lines turned to follow a tilted photo. The boxes are straight. On a tilted photo a patch can touch the
  line above or below. Finding the ink (section 11, step 1) makes this smaller.
- Removing the old text with a ComfyUI inpainting workflow. That needs the GPU, and ComfyUI is
  unloaded while translating.
- Editing the English of one block on the photo.
- Another engine for the boxes. Jaya's earlier OCR test (`OCR/ocr-test-out`) gave block boxes on a
  0-999 grid, but it runs in Python. That is a change to the stack in CLAUDE.md section 3: only if
  FRG-103 shows that Qwen's boxes are not good enough, and only after Jaya says yes.

## 14. How Jaya tests the result

1. Upload `TestPDF.pdf`. Open page 4. Wait until it is done.
2. Look at the "Translated" view:
   1. The main text is covered, and the English is easy to read, at about the size of the handwriting.
   2. Sentences that run over two lines read as one English sentence.
   3. The letterhead, the seals and the stamps are not touched.
   4. The vertical notes in the top-left corner have English turned along the column.
   5. The faint text from the back of the paper has no English on it.
3. Switch to "Original" and back. Hover over a block: it shows the Japanese and the English.
4. Download the translated image. It looks the same as the screen.
5. Note the seconds per page with `TRANSLATE_OVERLAY=on` and with `off`.
6. Do the same with 3 or 4 other pages, including a page with a table.

## 15. Tickets

| # | Ticket | Needs |
|---|---|---|
| FRG-103 | Test script: call 3 on one document, boxes drawn on the photo | — |
| FRG-104 | Backend: calls 3 and 4, `layout.json`, status `placing`, layout route | FRG-103 |
| FRG-105 | Frontend: the overlay on the photo | FRG-104 |
| FRG-106 | Download translated image | FRG-105 |
