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
