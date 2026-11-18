// The translation on the photo (FRG-105, plan: docs/translate-overlay.md section 11).
// The sums: find the ink of each line, the paper and ink colours, and fit the English into each block.
// The drawing is in TranslateOverlay.tsx. (Not named translateOverlay.ts: on Windows that name and
// TranslateOverlay.tsx are the same import.) The PNG download (FRG-106) uses the same fitBlock().
// The colours here come from the photo, not from the theme (CLAUDE.md section 15, rule 3, exception).

// [x1, y1, x2, y2]. In layout.json on the 0-1000 grid; everywhere else in photo pixels.
export type Box = [number, number, number, number];
export type Rgb = [number, number, number];

// layout.json, as GET /api/translate/documents/<id>/layout gives it (FRG-104).
export type LayoutBlock = {
  block: number;
  dir: "h" | "v";
  lines: { box: Box; japanese: string }[];
  english: string;
};
export type Layout = { grid: number; blocks: LayoutBlock[] };

// The pixels of the photo at full size, as a canvas gives them.
export type Pixels = { data: Uint8ClampedArray; width: number; height: number };

// One block, ready to fit and draw. All sizes in photo pixels.
export type PreparedBlock = {
  block: number;
  dir: "h" | "v";
  japanese: string;
  english: string;
  // All line boxes of the block together, after finding the ink.
  inner: Box;
  // The space kept around the ink: 15% of the middle line height.
  margin: number;
  // The middle line height (for a vertical block: the middle column width).
  lineSize: number;
  // The paper at the left and right edge of the block, and the ink of the block.
  paperLeft: Rgb;
  paperRight: Rgb;
  ink: Rgb;
  // How far down the block may grow: the next block below, or the end of the photo.
  maxBottom: number;
};

// The result of fitting one block.
export type FittedBlock = {
  fontSize: number;
  lineHeight: number;
  lines: string[];
  // The box the text is written in. Lower than `inner` when the block grew down into empty paper.
  inner: Box;
  // True when the text did not fit and the last line was cut with "…".
  cut: boolean;
};

// The width of a text at a font size, in photo pixels. Given from outside, so the screen and the
// PNG download (FRG-106) measure the same way and get the same result.
export type Measure = (text: string, fontSize: number) => number;

// A pixel is ink when it is at least this much darker than the paper (of 255).
const INK_DARKER_BY = 60;
// A line with less ink than this part of its box is faint text from the back of the paper.
const MIN_INK_PART = 0.01;
// The model's box is made bigger by this part of its height on each side, before looking for ink.
const GROW_PART = 0.1;
// The space around a block: this part of the middle line height.
const MARGIN_PART = 0.15;
// The first font size: this part of the middle line height.
const START_PART = 0.85;
// Each try makes the font this much smaller, down to this part of the first size.
const SHRINK_STEP = 0.05;
const SMALLEST_PART = 0.55;
// The line height of the English, as a part of the font size.
export const LINE_HEIGHT = 1.2;
// The patch is this many pixels bigger than the block on each side, so its soft edge does not show old ink.
export const PATCH_EXTRA = 3;
// Following the ink past the model's box: stop at a gap of this part of the line height,
// and never go further than this many line heights.
const FOLLOW_GAP_PART = 0.5;
const FOLLOW_MAX_PART = 6;
// A position along a line has no paper when it is dark across more than this part of the line, or
// when even its lightest pixel is this much darker than the paper. A run of such positions longer than
// this part of the line height is a shadow or the edge of the page, not writing.
const SHADOW_PART = 0.8;
const NO_PAPER_DARKER_BY = 40;
const SHADOW_RUN_PART = 0.4;
// A side of the patch takes the block's middle paper colour when the side is this much darker
// (a shadow, or the edge of the page).
const SIDE_DARKER_LIMIT = 25;
// Used when the ink is not clearly darker than the paper.
const FALLBACK_INK: Rgb = [34, 34, 34];

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function medianColour(colours: Rgb[]): Rgb {
  return [median(colours.map((c) => c[0])), median(colours.map((c) => c[1])), median(colours.map((c) => c[2]))];
}

export function brightness([r, g, b]: Rgb): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function pixelAt(pixels: Pixels, x: number, y: number): Rgb {
  const at = (y * pixels.width + x) * 4;
  return [pixels.data[at], pixels.data[at + 1], pixels.data[at + 2]];
}

// A box from the 0-1000 grid to photo pixels.
export function toPixels(box: Box, grid: number, width: number, height: number): Box {
  return [(box[0] * width) / grid, (box[1] * height) / grid, (box[2] * width) / grid, (box[3] * height) / grid];
}

// Step 1: find the ink of one line. Returns the box around the ink, the paper colour and some ink pixels.
// Returns null for faint text from the back of the paper (less than 1% ink).
// `others`: the boxes of the lines of other blocks. Following the ink stops at them.
export function findInk(pixels: Pixels, box: Box, dir: "h" | "v", others: Box[] = []): { box: Box; paper: Rgb; inkSamples: Rgb[] } | null {
  const grow = (box[3] - box[1]) * GROW_PART;
  const x1 = clamp(Math.floor(box[0] - grow), 0, pixels.width - 1);
  const y1 = clamp(Math.floor(box[1] - grow), 0, pixels.height - 1);
  const x2 = clamp(Math.ceil(box[2] + grow), x1 + 1, pixels.width);
  const y2 = clamp(Math.ceil(box[3] + grow), y1 + 1, pixels.height);

  // The paper: the middle colour of the pixels on the edge of the bigger box.
  const edge: Rgb[] = [];
  const stepX = Math.max(1, Math.floor((x2 - x1) / 200));
  const stepY = Math.max(1, Math.floor((y2 - y1) / 50));
  for (let x = x1; x < x2; x += stepX) edge.push(pixelAt(pixels, x, y1), pixelAt(pixels, x, y2 - 1));
  for (let y = y1; y < y2; y += stepY) edge.push(pixelAt(pixels, x1, y), pixelAt(pixels, x2 - 1, y));
  const limit = brightness(medianColour(edge)) - INK_DARKER_BY;

  // The ink: pixels much darker than the paper. Count them per row and per column.
  const rows = new Array<number>(y2 - y1).fill(0);
  const columns = new Array<number>(x2 - x1).fill(0);
  const inkSamples: Rgb[] = [];
  let inkCount = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const colour = pixelAt(pixels, x, y);
      if (brightness(colour) > limit) continue;
      inkCount++;
      rows[y - y1]++;
      columns[x - x1]++;
      if (inkCount % 7 === 0 && inkSamples.length < 3000) inkSamples.push(colour);
    }
  }
  const paper = medianColour(edge);
  if (inkCount < (x2 - x1) * (y2 - y1) * MIN_INK_PART) return null;

  // The new box: the rows and columns with ink. A single dark speck does not count.
  const first = (counts: number[]) => counts.findIndex((n) => n >= 2);
  const last = (counts: number[]) => counts.length - 1 - [...counts].reverse().findIndex((n) => n >= 2);
  const top = first(rows);
  const left = first(columns);
  if (top < 0 || left < 0) return { box, paper, inkSamples };
  const found: Box = [x1 + left, y1 + top, x1 + last(columns) + 1, y1 + last(rows) + 1];
  // Across the line, the ink decides: that is the real height of the handwriting. Along the line, the
  // box is never shorter than the model's box, because lighter ink at the ends can miss the ink test.
  const kept: Box =
    dir === "h"
      ? [Math.min(found[0], box[0]), found[1], Math.max(found[2], box[2]), found[3]]
      : [found[0], Math.min(found[1], box[1]), found[2], Math.max(found[3], box[3])];
  return { box: followInk(pixels, kept, dir, limit, others), paper, inkSamples };
}

// The model's box often ends a character or two early. Follow the ink along the line, past both
// ends of the box, until there is a gap of half a line with no ink (FRG-105).
// It never runs into the line of another block (`others`), so a block does not swallow its neighbour.
function followInk(pixels: Pixels, box: Box, dir: "h" | "v", limit: number, others: Box[]): Box {
  const [x1, y1, x2, y2] = box.map(Math.round) as Box;
  const thickness = dir === "h" ? y2 - y1 : x2 - x1;
  const maxGap = Math.max(2, Math.round(thickness * FOLLOW_GAP_PART));
  const maxReach = Math.round(thickness * FOLLOW_MAX_PART);
  // What is across the line at this position along it: ink, only paper, or no paper at all.
  // "no paper": nothing as light as the paper, or dark almost from edge to edge. One such position is
  // a pen stroke; many in a row are a shadow or the edge of the page, and stop the search.
  const paperLevel = limit + INK_DARKER_BY - NO_PAPER_DARKER_BY;
  const lookAt = (at: number): "ink" | "paper" | "noPaper" => {
    let count = 0;
    let lightest = 0;
    for (let across = dir === "h" ? y1 : x1; across < (dir === "h" ? y2 : x2); across++) {
      const value = brightness(dir === "h" ? pixelAt(pixels, at, across) : pixelAt(pixels, across, at));
      if (value <= limit) count++;
      lightest = Math.max(lightest, value);
    }
    if (lightest < paperLevel || count > thickness * SHADOW_PART) return "noPaper";
    return count >= 2 ? "ink" : "paper";
  };
  const maxNoPaper = Math.max(3, Math.round(thickness * SHADOW_RUN_PART));
  // Is this position along the line inside the line of another block?
  const across: [number, number] = dir === "h" ? [y1, y2] : [x1, x2];
  const inOther = (at: number): boolean =>
    others.some((other) => {
      const [along1, along2, across1, across2] = dir === "h" ? [other[0], other[2], other[1], other[3]] : [other[1], other[3], other[0], other[2]];
      return at >= along1 && at < along2 && across1 < across[1] && across2 > across[0];
    });
  const end = dir === "h" ? pixels.width : pixels.height;
  const follow = (from: number, step: 1 | -1): number => {
    let lastInk = from;
    let noPaperRun = 0;
    for (let at = from + step, gap = 0; at >= 0 && at < end && Math.abs(at - from) <= maxReach && gap <= maxGap; at += step) {
      if (inOther(at)) break;
      const found = lookAt(at);
      if (found === "noPaper") {
        if (++noPaperRun >= maxNoPaper) break;
        continue;
      }
      noPaperRun = 0;
      if (found === "ink") {
        lastInk = at;
        gap = 0;
      } else {
        gap++;
      }
    }
    return lastInk;
  };
  if (dir === "h") return [follow(x1, -1), y1, follow(x2 - 1, 1) + 1, y2];
  return [x1, follow(y1, -1), x2, follow(y2 - 1, 1) + 1];
}

// The middle colour of a strip 4 pixels wide, down one side of a box.
function stripColour(pixels: Pixels, x: number, y1: number, y2: number): Rgb {
  const colours: Rgb[] = [];
  const left = clamp(Math.round(x) - 2, 0, pixels.width - 4);
  const top = clamp(Math.floor(y1), 0, pixels.height - 1);
  const bottom = clamp(Math.ceil(y2), top + 1, pixels.height);
  const step = Math.max(1, Math.floor((bottom - top) / 60));
  for (let y = top; y < bottom; y += step) {
    for (let dx = 0; dx < 4; dx++) colours.push(pixelAt(pixels, left + dx, y));
  }
  // The brightest half is paper. Ink that touches the edge does not change the colour.
  colours.sort((a, b) => brightness(b) - brightness(a));
  return medianColour(colours.slice(0, Math.max(1, Math.ceil(colours.length / 2))));
}

// The English of a table row comes with the "|" of the Markdown table from the transcript.
// On the photo the cells are already drawn, so the "|" become spaces, and "|---|" lines go.
function plainEnglish(english: string): string {
  return english
    .split("\n")
    .filter((line) => !/^[\s|:-]*$/.test(line))
    .map((line) => line.replace(/\s*\|\s*/g, "   ").trim())
    .join("\n");
}

// Steps 1 to 4 for all blocks of a page: find the ink, the block's box, its colours and how far it may grow.
// Lines with no ink are dropped, and so are blocks with no line left.
export function prepareBlocks(layout: Layout, pixels: Pixels): PreparedBlock[] {
  const prepared: Omit<PreparedBlock, "maxBottom">[] = [];
  // The model's line boxes of every block, in photo pixels.
  const lineBoxes = layout.blocks.map((block) =>
    block.lines.map((line) => toPixels(line.box, layout.grid, pixels.width, pixels.height)),
  );
  for (const [index, block] of layout.blocks.entries()) {
    const others = lineBoxes.flatMap((boxes, other) => (other === index ? [] : boxes));
    const boxes: Box[] = [];
    const papers: Rgb[] = [];
    const inkSamples: Rgb[] = [];
    for (const line of block.lines) {
      const found = findInk(pixels, toPixels(line.box, layout.grid, pixels.width, pixels.height), block.dir, others);
      if (!found) continue;
      boxes.push(found.box);
      papers.push(found.paper);
      inkSamples.push(...found.inkSamples);
    }
    if (boxes.length === 0) continue;

    const inner: Box = [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3])),
    ];
    const lineSize = median(boxes.map((b) => (block.dir === "v" ? b[2] - b[0] : b[3] - b[1])));
    // The paper at each side, taken just inside the block. A side much darker than the block's
    // middle paper colour is a shadow or the edge of the page: it takes the middle colour instead.
    const paperMiddle = medianColour(papers);
    const side = (x: number): Rgb => {
      const colour = stripColour(pixels, x, inner[1], inner[3]);
      return brightness(colour) < brightness(paperMiddle) - SIDE_DARKER_LIMIT ? paperMiddle : colour;
    };
    const paperLeft = side(inner[0] + 2);
    const paperRight = side(inner[2] - 2);

    // The ink colour: the darker half of the ink pixels, so the soft edges of the strokes do not make it pale.
    inkSamples.sort((a, b) => brightness(a) - brightness(b));
    let ink = medianColour(inkSamples.slice(0, Math.max(1, Math.ceil(inkSamples.length / 2))));
    const paper = Math.min(brightness(paperLeft), brightness(paperRight));
    if (brightness(ink) > paper - INK_DARKER_BY) ink = FALLBACK_INK;

    prepared.push({
      block: block.block,
      dir: block.dir,
      japanese: block.lines.map((line) => line.japanese).join("\n"),
      english: plainEnglish(block.english),
      inner,
      margin: lineSize * MARGIN_PART,
      lineSize,
      paperLeft,
      paperRight,
      ink,
    });
  }

  // How far each block may grow down: to just above the next block below it that it overlaps
  // from left to right, or to the end of the photo. A block that starts lower counts even when it
  // touches this one (table rows sit close together); the block then does not grow at all.
  return prepared.map((block) => {
    let maxBottom = pixels.height - block.margin;
    for (const other of prepared) {
      if (other === block || other.inner[1] <= block.inner[1]) continue;
      const overlaps = other.inner[0] < block.inner[2] && other.inner[2] > block.inner[0];
      if (overlaps) maxBottom = Math.min(maxBottom, other.inner[1] - other.margin - block.margin - PATCH_EXTRA * 2);
    }
    return { ...block, maxBottom: Math.max(maxBottom, block.inner[3]) };
  });
}

// Break a text into lines no wider than `width`. A word wider than the width is broken.
export function wrapText(text: string, width: number, fontSize: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const tried = line ? `${line} ${word}` : word;
      if (measure(tried, fontSize) <= width) {
        line = tried;
        continue;
      }
      if (line) lines.push(line);
      // The word alone is too wide: break it into pieces that fit.
      line = "";
      for (const character of word) {
        if (line && measure(line + character, fontSize) > width) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

// The biggest font size, from the first size down to 55% of it, at which the text fits.
function tryToFit(text: string, width: number, height: number, start: number, measure: Measure) {
  for (let step = 0; 1 - step * SHRINK_STEP >= SMALLEST_PART - 1e-9; step++) {
    const fontSize = start * (1 - step * SHRINK_STEP);
    const lines = wrapText(text, width, fontSize, measure);
    if (lines.length * fontSize * LINE_HEIGHT <= height) return { fontSize, lines };
  }
  return null;
}

// Cut a line so that it ends with "…" and still fits the width.
function cutLine(line: string, width: number, fontSize: number, measure: Measure): string {
  let kept = line;
  while (kept.length > 0 && measure(`${kept}…`, fontSize) > width) kept = kept.slice(0, -1);
  return `${kept.trimEnd()}…`;
}

// Steps 5 to 7: the font size and the lines of the English of one block.
// A vertical block is fitted as if it were turned 90 degrees: its height is the width of the text.
export function fitBlock(block: PreparedBlock, measure: Measure): FittedBlock {
  const [x1, y1, x2, y2] = block.inner;
  const vertical = block.dir === "v";
  const width = vertical ? y2 - y1 : x2 - x1;
  const height = vertical ? x2 - x1 : y2 - y1;
  const start = block.lineSize * START_PART;

  const fits = tryToFit(block.english, width, height, start, measure);
  if (fits) return { ...fits, lineHeight: fits.fontSize * LINE_HEIGHT, inner: block.inner, cut: false };

  // The block may grow down into empty paper. A horizontal block gets room for more lines;
  // a vertical block gets longer lines, because its text runs down the column.
  const room = block.maxBottom - y1;
  const grownWidth = vertical ? Math.max(width, room) : width;
  const grownHeight = vertical ? height : Math.max(height, room);
  // The box after growing: down to the end of the text, never less than the ink.
  const grownBox = (lines: string[], fontSize: number): Box => {
    const used = vertical
      ? Math.max(...lines.map((line) => measure(line, fontSize)))
      : lines.length * fontSize * LINE_HEIGHT;
    return [x1, y1, x2, Math.max(y2, y1 + used)];
  };
  if (grownWidth > width || grownHeight > height) {
    const grown = tryToFit(block.english, grownWidth, grownHeight, start, measure);
    if (grown) {
      return { ...grown, lineHeight: grown.fontSize * LINE_HEIGHT, inner: grownBox(grown.lines, grown.fontSize), cut: false };
    }
  }

  // Still too long: the smallest size, as many lines as there is room for, the last one cut with "…".
  const fontSize = start * SMALLEST_PART;
  const lineHeight = fontSize * LINE_HEIGHT;
  const all = wrapText(block.english, grownWidth, fontSize, measure);
  const fitting = Math.max(1, Math.floor(grownHeight / lineHeight));
  const lines = all.slice(0, fitting);
  const cut = all.length > fitting;
  if (cut) lines[lines.length - 1] = cutLine(lines[lines.length - 1], grownWidth, fontSize, measure);
  return { fontSize, lineHeight, lines, inner: grownBox(lines, fontSize), cut };
}

// A colour for SVG and canvas.
export function cssColour([r, g, b]: Rgb): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

// A seal, a stamp or a single-character mark: one line of at most 2 Japanese characters, whose English
// cannot be written without breaking words. Broken words cannot be read, and the spec says seals and
// stamps are not touched (section 14), so such a block is not drawn and its Japanese stays visible.
export function isMark(block: PreparedBlock, fitted: FittedBlock, measure: Measure): boolean {
  // Only kanji, hiragana and katakana count: the model often writes a seal as "(控)".
  const characters = block.japanese.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? [];
  if (block.japanese.includes("\n") || characters.length > 2) return false;
  const [x1, y1, x2, y2] = fitted.inner;
  const width = block.dir === "v" ? y2 - y1 : x2 - x1;
  return block.english.split(/\s+/).some((word) => measure(word, fitted.fontSize) > width);
}
