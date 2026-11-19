// The texts we send to the translation model (FRG-91, plan: docs/japanese-translate.md section 9).
// Both prompts are here, in one small file, so they are easy to change.
// These are a starting point. Change them here when testing shows a better wording.

// How the model writes a table (FRG-95). translateTables.ts reads this form, so the page and
// the PDF download can show a real table. Used in call 1.
const TABLE_RULE = `- If the page has a table (a grid of rows and columns), write it as a Markdown table:
  every row is one line that starts and ends with "|", the cells are separated by "|",
  and the second line of the table is "|---|---|" with one "---" for each column.
  Every row has the same number of cells. Keep an empty cell empty.
  If a cell is merged over several columns or rows, write its text in the first cell and leave the others empty.
  Text that is not in a table stays as plain lines.`;

// Call 1: the photo goes in, the Japanese text comes out.
export const READ_SYSTEM_TEXT = `You are a careful transcriber of handwritten Japanese documents.
Write out exactly the text that is written in the image, in Japanese.
Rules:
- Keep the reading order of the page. Vertical text is read top to bottom, columns right to left.
- One line of the page is one line of your answer.
${TABLE_RULE}
- Copy numbers, dates, names and codes exactly as written.
- If you cannot read a character, write □ for it. Never guess. Never complete a sentence.
- Do not translate. Do not explain. Do not add anything that is not on the page.
Answer with the transcript only.`;

export const READ_USER_TEXT = "Transcribe this document.";

// Call 2: the Japanese text and the photo go in, the translation comes out.
// `language` is TRANSLATE_TARGET_LANGUAGE from backend/.env, for example "English".
// `checkedByPerson` is true when a person corrected the transcript (FRG-94). Then the model is
// told to trust the transcript, so it does not change the correction back to what it sees in the photo.
export function translateSystemText(language: string, checkedByPerson: boolean): string {
  const aboutTranscript = checkedByPerson
    ? "The transcript was checked and corrected by a person. Trust it. Where the transcript and the photo differ, follow the transcript. □ marks a character the person could not read."
    : "The transcript was made by a machine and may contain wrong characters. □ marks an unreadable character.";
  return `You are a careful translator of Japanese business and technical documents into ${language}.
You get a transcript of a handwritten document and the photo of the same document.
${aboutTranscript}
Rules:
- Translate the transcript faithfully, line by line, in the same order.
- A Markdown table in the transcript (lines that start and end with "|") stays a Markdown table:
  the same rows, the same columns, the "|---|---|" line kept. Translate the text inside each cell. Keep an empty cell empty.
  Text that is not in a table stays as plain lines. Do not make a table that is not in the transcript.
- Copy all numbers, dates, units and codes exactly.
- Write names of people and places in romaji, with the original Japanese in brackets the first time.
- Where the transcript has □, or a word makes no sense, look at the photo. If you are still not sure, write [unclear] and keep going. Never invent text.
- Do not add comments, summaries or explanations.
Answer with the translation only.`;
}

export function translateUserText(japanese: string): string {
  return `Transcript:\n${japanese}\n\nTranslate this document.`;
}

// Call 5 (FRG-112, plan: docs/translate-downloads-and-tables.md section 10): "Make it a table".
// The photo and the current Japanese text go in, the same text written as a Markdown table comes out.
// It runs in place of call 1, so the reading (and a correction by hand) stays: only the layout changes.
// It uses the same TABLE_RULE as call 1, so the table has the same form.
export const TABLE_SYSTEM_TEXT = `You rewrite the transcript of a Japanese document as a table.
You get the photo of a page, and a transcript of the same page that was written as plain lines.
The page has a table (a grid of rows and columns), but the transcript does not show it.
Rules:
- Look at the photo to see the rows and the columns of the table: the lines of the grid, or the text
  that stands in columns under each other.
- Each space between the lines of the grid is one cell. One row of the grid is one row of the table.
  The table has at least 2 columns. Never put a whole line of the page into one cell.
${TABLE_RULE}
- Use the text of the transcript. Do not read the photo again for the text, and do not correct it:
  only put the text into the right cells.
- Do not leave out any text. Text that is not in the table stays as plain lines, before or after the
  table, in the reading order of the page.
- Do not translate. Do not explain.
Answer with the transcript only.`;

export function tableUserText(japanese: string): string {
  return `Transcript:\n${japanese}\n\nWrite this transcript with its table.`;
}

// Call 3 (FRG-103, plan: docs/translate-overlay.md section 7): the photo and the Japanese text go in,
// the place of every line comes out, as JSON. Boxes are on a 0-1000 grid of the photo.
// FRG-111 added "table": does the page have a table? (docs/translate-downloads-and-tables.md section 9).
export const LAYOUT_SYSTEM_TEXT = `You find where text is written in a photo of a Japanese document.
You get the photo, and a transcript that was made from the same photo.
First give "table": true when the page has a table (a grid of rows and columns, often with lines between them),
also when the transcript does not show it as a table. Otherwise false.
Then, for every line of Japanese text in the photo, give:
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
Answer with JSON only.`;

export function layoutUserText(japanese: string): string {
  return `Transcript:\n${japanese}\n\nFind every line of Japanese text in the photo.`;
}

// The JSON schema of the call 3 answer. llama-server makes the model follow it.
// The numbers in "box" have no range here on purpose: the backend checks and cuts them (translateLayout.ts),
// and the FRG-103 test needs to see the numbers the model really gives.
// "table" (FRG-111) comes first, so the model decides it before it lists the lines.
export const LAYOUT_SCHEMA = {
  type: "object",
  properties: {
    table: { type: "boolean" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          block: { type: "integer" },
          dir: { type: "string", enum: ["h", "v"] },
          box: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
          text: { type: "string" },
        },
        required: ["block", "dir", "box", "text"],
      },
    },
  },
  required: ["table", "lines"],
};

// Call 4 (FRG-104, plan: docs/translate-overlay.md section 8): text only, no photo.
// The Japanese of each block from call 3 and the full translation from call 2 go in,
// the translation of each block comes out, as JSON. `language` is TRANSLATE_TARGET_LANGUAGE.
export function blocksSystemText(language: string): string {
  return `You are a careful translator of Japanese business and technical documents into ${language}.
You get numbered blocks of Japanese text from one page, and a full translation of the same page.
Translate each block on its own, so it can be printed in the place of the Japanese.
Rules:
- Where the full translation already covers the same text, use its wording. Do not translate it in a new way.
- Keep the block numbers. Give every block exactly one translation.
- Copy all numbers, dates, units and codes exactly.
- Write names of people and places in romaji only, without the Japanese in brackets.
- Keep it short: it must fit in the same space as the Japanese. Do not add notes or explanations.
- If a block cannot be read, write [unclear].
Answer with JSON only.`;
}

// `blocks`: the Japanese of each block, its lines joined with a new line.
export function blocksUserText(english: string, blocks: { block: number; japanese: string }[]): string {
  return `Full translation:\n${english}\n\nBlocks:\n${JSON.stringify(blocks, null, 1)}`;
}

// The JSON schema of the call 4 answer.
export const BLOCKS_SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          block: { type: "integer" },
          english: { type: "string" },
        },
        required: ["block", "english"],
      },
    },
  },
  required: ["blocks"],
};
