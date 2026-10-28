import { readFileSync } from "node:fs";
import path from "node:path";

// The fixed instructions for Claude when it turns an asset document into a pack file (FRG-79, packConvert.ts).
// The pack format ("Appendix B") is read from docs/pack-format.md, so there is only one copy of it.

const PACK_FORMAT = readFileSync(path.join(import.meta.dirname, "..", "..", "docs", "pack-format.md"), "utf8");

export const PACK_CONVERT_SYSTEM_PROMPT = `You turn an asset document written by a person into a TeczoForge pack file.
TeczoForge makes the pictures and 3D models of the pack on a local GPU. The pack file format is below.

Rules:
1. Copy every image prompt from the document word for word into "prompt" (or "edit_prompt"). Never shorten,
   fix, translate or add to a prompt. Keep its spelling, punctuation and capital letters exactly. Only the line
   breaks inside a prompt may become spaces.
2. Never invent items. Every item in the document's asset list must be in the pack, in the document's order.
3. Items with no TeczoForge step (built by hand, made in Unreal, bought, and so on) get "kind": "skip", with the
   reason in "notes".
4. Picture-only or reference items get "kind": "picture".
5. "Edit Image on X" (or the same meaning) becomes "edit_from": "X" and "edit_prompt" with the edit instruction.
   Such an item has no "prompt" and no "size".
6. "Make N versions" or "make N pictures" becomes "pictures": N. The most is 6.
7. One asset with two or more prompts becomes one item per prompt, with a letter after the id: REF-09A, REF-09B.
8. Settings for a whole group (for example "TRELLIS.2 first, Pixal3D second") are set on each item of that group.
9. Real sizes from the document go into "real_size".
10. Use the document's own asset ids when they fit the id rule. Pick a short pack code and the pack name from the
    document. Use "engine": "unreal" if the document is for Unreal, otherwise "none". Leave "style" empty unless the
    document asks for one style for every prompt.

Answer with exactly one \`\`\`json block with the whole pack file, and nothing else, except this list after the block:

Could not map:
- one line for each thing in the document you could not put into the pack, and why

If everything was mapped, write "Could not map:" and then "- nothing".

The pack file format:

${PACK_FORMAT}`;

// The message that holds the document.
export function convertRequest(fileName: string | null, text: string): string {
  return `Document${fileName ? ` "${fileName}"` : ""}:\n\n<document>\n${text}\n</document>\n\nMake the pack file from this document.`;
}

// The one follow-up message when the checker found errors in the first answer.
export function fixRequest(errors: string[]): string {
  return `The TeczoForge checker found these errors in your pack file:\n\n${errors.map((error) => `- ${error}`).join("\n")}\n\nFix them and answer again with the whole pack file, in the same form (one \`\`\`json block, then the "Could not map:" list). Keep every prompt word for word.`;
}
