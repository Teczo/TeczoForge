import type Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "./httpError.js";
import { listPresets } from "./presets.js";
import type { PresetSummary } from "./presets.js";
import { createDraft } from "./drafts.js";

// Chat tools (FRG-24): Claude can make board cards from the conversation.
// There is one tool per preset folder, built fresh for every message, so a new preset folder
// gives a new tool with no code change. The tool inputs come from preset.json; ComfyUI node ids
// are never part of a tool (listPresets leaves them out).
// KEY RULE: a tool only makes a draft card in the Ready column. It never starts a generation.
// The user starts it by clicking Generate.

const TOOL_PREFIX = "create_card_";
// Tool names may be at most 64 characters (Claude API rule).
const MAX_TOOL_NAME_LENGTH = 64;

// A card Claude made, as the chat keeps it.
export type ChatCard = { id: string; title: string; presetId: string };

export type ChatTools = {
  tools: Anthropic.Beta.BetaTool[];
  // Presets that need a start image. Pictures in chat come in FRG-25, so these have no tool yet.
  needImage: string[];
};

// The tool for one preset, or null if chat cannot fill all its inputs.
function toolFor(preset: PresetSummary): Anthropic.Beta.BetaTool | null {
  const name = TOOL_PREFIX + preset.id;
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    console.warn(`Warning: preset "${preset.id}" has a name too long for a chat tool, so chat cannot use it.`);
    return null;
  }

  const properties: Record<string, unknown> = {
    title: { type: "string", description: "A short name for the card on the board, at most 100 characters." },
  };
  const required = ["title"];
  for (const input of preset.inputs) {
    if (input.kind === "text") {
      properties[input.key] = { type: "string", description: input.label };
      if (input.default === undefined) required.push(input.key);
    } else if (input.kind === "seed") {
      properties[input.key] = { type: "integer", description: `${input.label}. Leave it out for a random seed.` };
    } else if (input.kind === "number") {
      const fallback = input.default === undefined ? "" : ` Default ${input.default}.`;
      properties[input.key] = { type: "integer", description: `${input.label}. A whole number.${fallback}` };
      if (input.default === undefined) required.push(input.key);
    } else {
      return null; // A kind chat does not know (images are handled before this).
    }
  }

  const guide = preset.promptGuide ? `\nHow to write the prompt: ${preset.promptGuide}` : "";
  return {
    name,
    description:
      `Make a board card for the preset "${preset.name}": ${preset.description}\n` +
      `The card goes to the Ready column. It does not start a generation: the user clicks Generate.${guide}`,
    input_schema: { type: "object", properties, required, additionalProperties: false },
    eager_input_streaming: true, // Inputs stream as they are written. They are checked before use (runChatTool).
  };
}

// The tools for this message, from the preset folders as they are now.
export async function buildChatTools(): Promise<ChatTools> {
  const tools: Anthropic.Beta.BetaTool[] = [];
  const needImage: string[] = [];
  for (const preset of await listPresets()) {
    if (preset.inputs.some((input) => input.kind === "image")) {
      needImage.push(preset.name);
      continue;
    }
    const tool = toolFor(preset);
    if (tool) tools.push(tool);
  }
  return { tools, needImage };
}

// Run one tool call from Claude: check the values with the same checks as the board, then save
// a draft in Ready. A wrong value goes back to Claude as the tool result, so it can fix it.
export async function runChatTool(
  block: Anthropic.Beta.BetaToolUseBlock,
  context: { tools: ChatTools; username: string; conversationId: string },
): Promise<{ result: Anthropic.Beta.BetaToolResultBlockParam; card?: ChatCard }> {
  const error = (text: string) => ({
    result: { type: "tool_result" as const, tool_use_id: block.id, is_error: true, content: text },
  });

  if (!context.tools.tools.some((tool) => tool.name === block.name)) return error("This tool does not exist.");
  if (typeof block.input !== "object" || block.input === null || Array.isArray(block.input)) {
    return error("The tool input must be an object.");
  }

  const { title, ...inputs } = block.input as Record<string, unknown>;
  try {
    const draft = await createDraft({
      presetId: block.name.slice(TOOL_PREFIX.length),
      inputs,
      title,
      column: "ready",
      createdBy: context.username,
      conversationId: context.conversationId,
    });
    return {
      result: {
        type: "tool_result",
        tool_use_id: block.id,
        content: `Card "${draft.title}" is in the Ready column. Nothing has started: the user clicks Generate on the card.`,
      },
      card: { id: draft.id, title: draft.title!, presetId: draft.presetId! },
    };
  } catch (caught) {
    if (caught instanceof HttpError) {
      return error(`The card was not made: ${caught.message} Fix the values and try again, or explain the problem to the user.`);
    }
    console.error("Chat tool failed:", caught);
    return error("The card was not made because of a server error. Tell the user to try again.");
  }
}
