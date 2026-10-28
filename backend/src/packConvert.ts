import type Anthropic from "@anthropic-ai/sdk";
import type { Request, Response } from "express";
import { HttpError } from "./httpError.js";
import { sendError } from "./jobs.js";
import { findSchemaBlock } from "./gameFile.js";
import { checkPackFile, PACK_SCHEMA, readPackFileBody } from "./packFile.js";
import type { PackPlan } from "./packFile.js";
import { CLAUDE_MODEL, claudeClient, claudeErrorMessage, fallbackOptions, NOT_SET_UP_MESSAGE } from "./claudeClient.js";
import { convertRequest, fixRequest, PACK_CONVERT_SYSTEM_PROMPT } from "./packConvertPrompt.js";

// "Import any document" (FRG-79): Claude turns a normal asset document into a pack file.
// 1. The document goes to the Claude API with the fixed instructions (packConvertPrompt.ts).
//    Generation stays on this PC: only the text of the document is sent.
// 2. The pack file in the answer is checked (packFile.ts). If it has errors, they go back to Claude
//    once to fix. There is never a third try: what is left is shown to the user.
// 3. Every prompt and edit_prompt must be in the document word for word (only spaces and line breaks
//    may differ). Each one that is not is a warning.
// Nothing is saved here. The user checks and edits the pack file, then imports it (packs.ts).

// The longest answer. A pack of 300 items with long prompts fits; a longer one is cut off.
const MAX_ANSWER_TOKENS = 64000;

type ConvertAnswer = {
  ok: boolean;
  packText: string;
  plan?: PackPlan;
  errors?: string[];
  warnings: string[];
  couldNotMap: string[];
};

// Ask Claude once. Streams, because a long answer can take minutes. Returns the answer, or throws an
// HttpError with a clear message (cut off, declined, or an API problem).
async function askClaude(client: Anthropic, messages: Anthropic.Beta.BetaMessageParam[], documentText: string): Promise<Anthropic.Beta.BetaMessage> {
  let answer: Anthropic.Beta.BetaMessage;
  try {
    answer = await client.beta.messages
      .stream({
        model: CLAUDE_MODEL,
        max_tokens: MAX_ANSWER_TOKENS,
        system: PACK_CONVERT_SYSTEM_PROMPT,
        messages,
        ...fallbackOptions(),
      })
      .finalMessage();
  } catch (error) {
    throw new HttpError(502, claudeErrorMessage(error));
  }
  console.log(`Pack convert: ${answer.usage.input_tokens} input and ${answer.usage.output_tokens} output tokens (stop: ${answer.stop_reason}).`);
  if (answer.stop_reason === "max_tokens") {
    const words = documentText.trim().split(/\s+/).length;
    throw new HttpError(
      422,
      `Claude's answer was cut off because the pack file got too long. The document is ${documentText.length} characters (about ${words} words). Nothing was split. Ask Jaya what to do with this document.`,
    );
  }
  if (answer.stop_reason === "refusal") throw new HttpError(422, "Claude declined to read this document.");
  return answer;
}

// The text of an answer: its text blocks joined.
function answerText(answer: Anthropic.Beta.BetaMessage): string {
  return answer.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

// The "Could not map:" list after the json block: one entry per "- " line. "nothing" is left out.
function readCouldNotMap(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\W*could not map\W*$/i.test(line.trim()));
  if (start < 0) return [];
  const list: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s*[-*]\s+(.*)$/);
    if (match) {
      const entry = match[1].trim();
      if (entry !== "" && !/^nothing\.?$/i.test(entry)) list.push(entry);
    } else if (line.trim() !== "") {
      break;
    }
  }
  return list;
}

// The pack file to show: a short heading, the json block, and the "Could not map" list.
// If the answer has no usable json block, the answer itself, so the user can see and fix it.
function packFileFrom(text: string, fileName: string | null, couldNotMap: string[]): { packText: string; data: Record<string, unknown> | null } {
  const block = findSchemaBlock(text, PACK_SCHEMA);
  if ("errors" in block) return { packText: text, data: null };
  const name = typeof (block.data.pack as { name?: unknown })?.name === "string" ? (block.data.pack as { name: string }).name : "Pack";
  const source = fileName ? ` from the document "${fileName}"` : "";
  const notMapped = couldNotMap.length > 0 ? couldNotMap.map((entry) => `- ${entry}`).join("\n") : "- nothing";
  const packText = [
    `# Pack file: ${name}`,
    "",
    `Made by TeczoForge${source} with the Claude API. Check every item before you create the pack.`,
    "",
    "```json",
    JSON.stringify(block.data, null, 2),
    "```",
    "",
    "Could not map:",
    notMapped,
    "",
  ].join("\n");
  return { packText, data: block.data };
}

// Text with every run of spaces and line breaks made one space, for the word-for-word check.
function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Every prompt and edit_prompt that is not in the document word for word, as a warning by item id.
function wordForWordWarnings(data: Record<string, unknown>, documentText: string): string[] {
  const document = squeeze(documentText);
  const warnings: string[] = [];
  const items = Array.isArray(data.items) ? data.items : [];
  items.forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : `item ${index + 1}`;
    for (const field of ["prompt", "edit_prompt"]) {
      const value = record[field];
      if (typeof value !== "string" || value.trim() === "") continue;
      if (!document.includes(squeeze(value))) {
        const start = squeeze(value).slice(0, 60);
        warnings.push(`${id}: the ${field} is not in the document word for word ("${start}${value.length > 60 ? "..." : ""}").`);
      }
    }
  });
  return warnings;
}

// POST /api/packs/convert
// Body: { "fileName": "...", "text": "..." } (the document, .md or .txt, max 1 MB).
// Answer: { ok, packText, plan | errors, warnings, couldNotMap }. ok is false when the pack file still
// has errors after the one fix round; the user can edit packText and check it again.
// Chat not set up: 503 with the same message as chat. Answer cut off or declined: 422 with the reason.
export async function convertDocumentHandler(req: Request, res: Response) {
  try {
    const { fileName, text } = readPackFileBody(req.body);
    if (text.trim() === "") throw new HttpError(400, "The document is empty.");
    if (!claudeClient) throw new HttpError(503, NOT_SET_UP_MESSAGE);

    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: convertRequest(fileName, text) }];
    let answer = await askClaude(claudeClient, messages, text);
    let couldNotMap = readCouldNotMap(answerText(answer));
    let made = packFileFrom(answerText(answer), fileName, couldNotMap);
    let result = checkPackFile(made.packText);

    // One fix round, never more.
    if (!result.ok) {
      messages.push({ role: "assistant", content: answer.content });
      messages.push({ role: "user", content: fixRequest(result.errors) });
      answer = await askClaude(claudeClient, messages, text);
      couldNotMap = readCouldNotMap(answerText(answer));
      made = packFileFrom(answerText(answer), fileName, couldNotMap);
      result = checkPackFile(made.packText);
    }

    const answerBody: ConvertAnswer = {
      ok: result.ok,
      packText: made.packText,
      ...(result.ok ? { plan: result.plan } : { errors: result.errors }),
      warnings: made.data ? wordForWordWarnings(made.data, text) : [],
      couldNotMap,
    };
    res.json(answerBody);
  } catch (error) {
    sendError(res, error);
  }
}
