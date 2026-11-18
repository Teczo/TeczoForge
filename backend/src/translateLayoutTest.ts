import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { freeMemory, getQueue } from "./comfyui.js";
import { askModel, ID_PATTERN, readPhoto, TRANSLATIONS_DIR } from "./translateDocuments.js";
import { parseLayout } from "./translateLayout.js";
import type { LayoutLine } from "./translateLayout.js";
import { LAYOUT_SCHEMA, LAYOUT_SYSTEM_TEXT, layoutUserText } from "./translatePrompt.js";
import { startTranslateServer, stopTranslateServer } from "./translateServer.js";

// Test for call 3, where each line is on the photo (FRG-103, plan: docs/translate-overlay.md section 7).
// Run it with:  npm run translate-layout-test -- <document id>
// The document must be translated already (status "done"). The test starts llama-server, asks the model
// where each line is, stops llama-server, and writes two files into the document's folder:
//   layout-test.html  the photo with the boxes drawn on it. Open it in a browser.
//   layout-test.json  the checked lines and the counts.
// Only counts are printed. The text of the document is never printed (CLAUDE.md section 7, rule 11).

// The most text the call 3 answer may have. A full page has many lines, and each line needs a box.
const LAYOUT_MAX_TOKENS = 8192;

async function main() {
  const id = (process.argv[2] ?? "").trim();
  if (!ID_PATTERN.test(id)) throw new Error("Give the document id, for example:  npm run translate-layout-test -- tr-1794373826681-a1b2c3");
  const folder = path.join(TRANSLATIONS_DIR, id);

  let record: { status?: string; japanese?: string };
  try {
    record = JSON.parse(await readFile(path.join(folder, "record.json"), "utf8"));
  } catch {
    throw new Error(`There is no document ${id} in data/translations.`);
  }
  if (record.status !== "done") throw new Error(`Document ${id} is "${record.status}". Only a document that is "done" can be tested.`);
  const japanese = typeof record.japanese === "string" ? record.japanese : "";
  if (japanese === "") throw new Error(`Document ${id} has no Japanese text.`);
  const photo = await readPhoto(id);
  if (!photo) throw new Error(`The photo of document ${id} is not on disk.`);
  const photoUrl = `data:${photo.info.mediaType};base64,${photo.data.toString("base64")}`;

  await makeRoomOnGpu();
  const startedAt = Date.now();
  await startTranslateServer();
  console.log(`The model was ready after ${Math.round((Date.now() - startedAt) / 1000)} seconds.`);

  let answer;
  const askedAt = Date.now();
  try {
    answer = await askModel(LAYOUT_SYSTEM_TEXT, layoutUserText(japanese), {
      photoUrl,
      maxTokens: LAYOUT_MAX_TOKENS,
      schema: LAYOUT_SCHEMA,
    });
  } finally {
    await stopTranslateServer();
  }
  const seconds = Math.round((Date.now() - askedAt) / 1000);

  const result = parseLayout(answer.text);
  if (!result) {
    // The answer is not shown: it could hold text from the document.
    throw new Error(`The answer was not JSON in the expected shape${answer.cutOff ? " (it was cut off at the end)" : ""}.`);
  }
  const blocks = new Set(result.lines.map((line) => line.block)).size;
  const vertical = result.lines.filter((line) => line.dir === "v").length;
  const counts = {
    photoWidth: photo.info.width,
    photoHeight: photo.info.height,
    linesGiven: result.given,
    linesKept: result.lines.length,
    linesDropped: result.dropped,
    blocks,
    horizontal: result.lines.length - vertical,
    vertical,
    highestNumber: result.highestNumber,
    cutOff: answer.cutOff,
    seconds,
  };

  await writeFile(path.join(folder, "layout-test.json"), JSON.stringify({ counts, lines: result.lines }, null, 2), "utf8");
  await writeFile(path.join(folder, "layout-test.html"), testPage(id, `source.${photo.info.extension}`, photo.info.width, photo.info.height, result.lines, counts), "utf8");

  console.log(`Photo: ${counts.photoWidth} x ${counts.photoHeight} pixels.`);
  console.log(`Lines: ${counts.linesGiven} given, ${counts.linesKept} kept, ${counts.linesDropped} dropped by the checks.`);
  console.log(`Blocks: ${blocks}. Horizontal lines: ${counts.horizontal}. Vertical lines: ${vertical}.`);
  console.log(`Highest box number: ${counts.highestNumber} (above 1000 means pixels, not the 0-1000 grid).`);
  if (answer.cutOff) console.log("The answer was cut off at the end: some lines are missing.");
  console.log(`Call 3 took ${seconds} seconds.`);
  console.log(`Open this file to see the boxes: ${path.join(folder, "layout-test.html")}`);
}

// Like the translation worker: do not run while ComfyUI has a job, and ask ComfyUI to unload
// its models first (CLAUDE.md section 7, rule 10). A test does not wait: it stops and says why.
async function makeRoomOnGpu(): Promise<void> {
  let queue;
  try {
    queue = await getQueue();
  } catch {
    return; // ComfyUI is not running: the GPU is free.
  }
  if (queue.running.length > 0 || queue.pending.length > 0) {
    throw new Error("ComfyUI has a job. Wait until it is finished, then run the test again.");
  }
  await freeMemory();
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

// The test page: the photo, and over it one box per line, on the 0-1000 grid.
// Boxes of the same block have the same colour. Hover a box to see its block and text.
function testPage(id: string, photoFile: string, width: number, height: number, lines: LayoutLine[], counts: object): string {
  const boxes = lines
    .map((line) => {
      const [x1, y1, x2, y2] = line.box;
      const hue = (line.block * 47) % 360;
      return `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="hsla(${hue},90%,50%,0.18)" stroke="hsl(${hue},90%,40%)" stroke-width="1.5" vector-effect="non-scaling-stroke"><title>block ${line.block}, ${line.dir}: ${escapeHtml(line.text)}</title></rect>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Layout test ${id}</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 16px; background: #f4f4f4; color: #111; }
  .page { position: relative; display: inline-block; max-width: 100%; }
  .page img { display: block; max-width: 100%; height: auto; }
  .page svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  pre { background: #fff; padding: 8px; display: inline-block; }
</style>
</head>
<body>
<h1>Layout test ${id}</h1>
<p>Boxes are drawn on a 0-1000 grid of the photo (${width} x ${height} pixels). If they sit on the lines, the model gives the grid.</p>
<pre>${escapeHtml(JSON.stringify(counts, null, 2))}</pre>
<div class="page">
<img src="${photoFile}" alt="The photo of the document">
<svg viewBox="0 0 1000 1000" preserveAspectRatio="none">
${boxes}
</svg>
</div>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

main().catch((error) => {
  console.error(`The test failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
