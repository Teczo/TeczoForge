// Tables in a translation text (FRG-95).
// The model writes a table as a Markdown table:
//   | Name | Amount |
//   |---|---|
//   | Bolt | 12 |
// This file cuts a text into blocks: plain text, and tables. The Translate page uses the blocks
// to show real tables. The same code is in backend/src/translateTables.ts, for the PDF download.

export type TextBlock =
  | { kind: "text"; text: string }
  // rows[0] is the header row when `header` is true. Every row has the same number of cells.
  | { kind: "table"; header: boolean; rows: string[][] };

// A table line starts and ends with "|", for example "| a | b |".
function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith("|") && trimmed.endsWith("|");
}

// The cells of one table line. "\|" is a real "|" inside a cell, and <br> is a line break.
function cellsOf(line: string): string[] {
  const inner = line.trim().slice(1, -1);
  return inner.split(/(?<!\\)\|/).map((cell) =>
    cell
      .replace(/\\\|/g, "|")
      .replace(/<br\s*\/?>/gi, "\n")
      .trim(),
  );
}

// The line under the header row: only "-", ":" and spaces in every cell, for example "|---|:--|".
function isSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-+:?$/.test(cell));
}

// Cut a text into text blocks and table blocks, in the order they are written.
export function splitIntoBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let textLines: string[] = [];
  let tableLines: string[] = [];

  function endText() {
    const joined = textLines.join("\n").trim();
    if (joined !== "") blocks.push({ kind: "text", text: joined });
    textLines = [];
  }

  function endTable() {
    if (tableLines.length === 0) return;
    const all = tableLines.map(cellsOf);
    tableLines = [];
    const header = all.length > 1 && isSeparator(all[1]);
    const rows = all.filter((cells) => !isSeparator(cells));
    // One single line with "|" around it is not a table. Keep it as text.
    if (rows.length === 0 || (rows.length === 1 && !header)) {
      textLines.push(...all.map((cells) => cells.join(" | ")));
      return;
    }
    endText();
    // Make every row as long as the longest one.
    const width = Math.max(...rows.map((cells) => cells.length));
    blocks.push({ kind: "table", header, rows: rows.map((cells) => [...cells, ...Array(width - cells.length).fill("")]) });
  }

  for (const line of text.split("\n")) {
    if (isTableLine(line)) {
      tableLines.push(line);
    } else {
      endTable();
      textLines.push(line);
    }
  }
  endTable();
  endText();
  return blocks;
}

// ---------- Empty rows (FRG-110, plan: docs/translate-downloads-and-tables.md section 8) ----------

// The line numbers of the empty rows of the tables in a text. An empty row is a table line where every
// cell is empty or only spaces. The header row (the line above "|---|") is never an empty row.
// A single line with "|" around it is not a table (see splitIntoBlocks), so it is never an empty row.
function emptyRowLines(lines: string[]): Set<number> {
  const found = new Set<number>();
  let start = 0;
  while (start < lines.length) {
    if (!isTableLine(lines[start])) {
      start++;
      continue;
    }
    // One table: the table lines that follow each other.
    let end = start;
    while (end < lines.length && isTableLine(lines[end])) end++;
    if (end - start >= 2) {
      for (let index = start; index < end; index++) {
        const cells = cellsOf(lines[index]);
        if (cells.some((cell) => cell !== "") || isSeparator(cells)) continue;
        const isHeader = index + 1 < end && isSeparator(cellsOf(lines[index + 1]));
        if (!isHeader) found.add(index);
      }
    }
    start = end;
  }
  return found;
}

// How many empty rows the tables of a text have.
export function countEmptyRows(text: string): number {
  return emptyRowLines(text.split("\n")).size;
}

// The same text without the lines of empty rows. All other lines stay exactly as they are.
export function withoutEmptyRows(text: string): string {
  const lines = text.split("\n");
  const empty = emptyRowLines(lines);
  return empty.size === 0 ? text : lines.filter((_line, index) => !empty.has(index)).join("\n");
}
