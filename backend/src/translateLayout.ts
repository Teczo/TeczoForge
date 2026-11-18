// The translation on the photo (FRG-103, plan: docs/translate-overlay.md section 7).
// Call 3 answers with JSON: where each line of Japanese text is on the photo.
// This file reads that answer and drops every line that fails a check.
// The text of the lines is never written to the log (CLAUDE.md section 7, rule 11).

// Boxes are on a 0-1000 grid of the photo: 0,0 is the top left corner, 1000,1000 the bottom right.
export const GRID_SIZE = 1000;
// The highest block number we accept.
const MAX_BLOCK = 500;
// The longest text one line may have.
const MAX_LINE_LENGTH = 500;
// The most lines we keep for one page.
export const MAX_LINES = 300;
// At least one kanji, hiragana or katakana character.
const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export type LayoutLine = {
  block: number;
  dir: "h" | "v";
  box: [number, number, number, number]; // [x1, y1, x2, y2] on the 0-1000 grid.
  text: string;
};

export type LayoutResult = {
  lines: LayoutLine[];
  // How many lines the model gave, and how many of them failed a check or were over MAX_LINES.
  given: number;
  dropped: number;
  // The highest box number the model gave, before cutting to 0-1000.
  // Far above 1000 means the model gave pixels, not the grid (the FRG-103 check).
  highestNumber: number;
};

// Read the call 3 answer. Returns null when the answer is not JSON in the expected shape.
export function parseLayout(answer: string): LayoutResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return null;
  }
  const given = (parsed as { lines?: unknown })?.lines;
  if (!Array.isArray(given)) return null;

  const lines: LayoutLine[] = [];
  let highestNumber = 0;
  for (const item of given) {
    const box = (item as { box?: unknown })?.box;
    if (Array.isArray(box)) {
      for (const n of box) if (typeof n === "number" && Number.isFinite(n)) highestNumber = Math.max(highestNumber, n);
    }
    const line = checkLine(item);
    if (line && lines.length < MAX_LINES) lines.push(line);
  }
  return { lines, given: given.length, dropped: given.length - lines.length, highestNumber };
}

// One line of the answer, checked (spec 7, checks 1 to 3). Null when it fails a check.
function checkLine(item: unknown): LayoutLine | null {
  if (typeof item !== "object" || item === null) return null;
  const { block, dir, box, text } = item as Record<string, unknown>;

  // Check 1: four numbers, each cut to 0-1000, and the box is not empty.
  if (!Array.isArray(box) || box.length !== 4) return null;
  if (!box.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [x1, y1, x2, y2] = (box as number[]).map((n) => Math.min(GRID_SIZE, Math.max(0, n)));
  if (!(x1 < x2 && y1 < y2)) return null;

  // Check 2: a whole block number from 1 to 500, and a known direction.
  if (typeof block !== "number" || !Number.isInteger(block) || block < 1 || block > MAX_BLOCK) return null;
  if (dir !== "h" && dir !== "v") return null;

  // Check 3: not too long, and at least one Japanese character.
  if (typeof text !== "string" || text.length > MAX_LINE_LENGTH || !JAPANESE.test(text)) return null;

  return { block, dir, box: [x1, y1, x2, y2], text };
}

// ---------- Call 4 and layout.json (FRG-104, spec 8 and 9) ----------

// The longest translation of one block we accept.
const MAX_BLOCK_ENGLISH_LENGTH = 2000;

// One block in layout.json: its lines from call 3, and its translation from call 4.
export type LayoutBlock = {
  block: number;
  dir: "h" | "v";
  lines: { box: [number, number, number, number]; japanese: string }[];
  english: string;
};

// layout.json. Boxes are on a 0-1000 grid of the photo.
export type Layout = { grid: number; blocks: LayoutBlock[] };

// The lines of call 3 put together by block number, in the order the blocks first appear.
// A block takes the direction of its first line.
export function groupBlocks(lines: LayoutLine[]): Omit<LayoutBlock, "english">[] {
  const blocks = new Map<number, Omit<LayoutBlock, "english">>();
  for (const line of lines) {
    let block = blocks.get(line.block);
    if (!block) {
      block = { block: line.block, dir: line.dir, lines: [] };
      blocks.set(line.block, block);
    }
    block.lines.push({ box: line.box, japanese: line.text });
  }
  return [...blocks.values()];
}

// Read the call 4 answer: the translation of each block, by block number.
// Only block numbers in `known` are kept, and the first translation of a block wins.
// Returns null when the answer is not JSON in the expected shape.
export function parseBlockEnglish(answer: string, known: Set<number>): Map<number, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return null;
  }
  const given = (parsed as { blocks?: unknown })?.blocks;
  if (!Array.isArray(given)) return null;
  const english = new Map<number, string>();
  for (const item of given) {
    const { block, english: text } = (item ?? {}) as Record<string, unknown>;
    if (typeof block !== "number" || !known.has(block) || english.has(block)) continue;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.length > MAX_BLOCK_ENGLISH_LENGTH) continue;
    english.set(block, trimmed);
  }
  return english;
}
