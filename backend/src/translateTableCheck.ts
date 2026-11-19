import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Layout } from "./translateLayout.js";
import { splitIntoBlocks } from "./translateTables.js";

// Which pages have a table, and which get the offer to make one (FRG-111,
// plan: docs/translate-downloads-and-tables.md section 9).
// Run it with:  npm run translate-table-check            (every done document)
//          or:  npm run translate-table-check -- <id>    (one document)
// It reads record.json and layout.json only. No model, no GPU, no change to any file.
// It prints yes/no answers only. The text of a document is never printed (CLAUDE.md section 7, rule 11).
//
// "table on photo" is the answer of call 3, saved in layout.json. A document translated before FRG-111
// has no answer yet ("?"): press "Try again" on it first.

// The same folder and id pattern as translateDocuments.ts. That file is not imported, so this
// script does not load the worker.
const TRANSLATIONS_DIR = path.join(import.meta.dirname, "..", "..", "data", "translations");
const ID_PATTERN = /^tr-[0-9]+-[0-9a-f]{6}$/;

type DocRecord = { status?: string; japanese?: string; page?: number; pages?: number; fileId?: string | null; tableHint?: string };

function main() {
  const wanted = (process.argv[2] ?? "").trim();
  if (wanted !== "" && !ID_PATTERN.test(wanted)) {
    throw new Error("Give a document id, for example:  npm run translate-table-check -- tr-1794373826681-a1b2c3");
  }
  if (!existsSync(TRANSLATIONS_DIR)) throw new Error("There is no data/translations folder yet.");

  const ids = wanted !== "" ? [wanted] : readdirSync(TRANSLATIONS_DIR).filter((name) => ID_PATTERN.test(name));
  console.log("id                          page    table on photo  table in text  offer");

  let checked = 0;
  for (const id of ids.sort()) {
    const folder = path.join(TRANSLATIONS_DIR, id);
    let record: DocRecord;
    try {
      record = JSON.parse(readFileSync(path.join(folder, "record.json"), "utf8"));
    } catch {
      if (wanted !== "") throw new Error(`There is no document ${id} in data/translations.`);
      continue;
    }
    if (record.status !== "done") {
      if (wanted !== "") throw new Error(`Document ${id} is "${record.status}". Only a document that is "done" can be checked.`);
      continue;
    }
    // No layout.json: the translation on the photo is off, or failed. Then there is no answer.
    const layoutPath = path.join(folder, "layout.json");
    let onPhoto = "no layout";
    if (existsSync(layoutPath)) {
      const layout = JSON.parse(readFileSync(layoutPath, "utf8")) as Layout;
      onPhoto = layout.table === undefined ? "?" : layout.table ? "yes" : "no";
    }
    const inText = splitIntoBlocks(record.japanese ?? "").some((block) => block.kind === "table");
    const page = record.fileId ? `${record.page}/${record.pages}` : "photo";
    console.log([id.padEnd(26), page.padEnd(6), onPhoto.padEnd(14), (inText ? "yes" : "no").padEnd(13), record.tableHint ?? "none"].join("  "));
    checked++;
  }
  console.log("");
  console.log(`${checked} document(s) checked.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
