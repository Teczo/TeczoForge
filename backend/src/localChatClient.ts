import type { ChatMessage } from "./db.js";
import { picturesToSend } from "./chatImages.js";
import { checkTranslateSetup, translateServerUrl, translateSettings } from "./translateServer.js";

// Chat with the local model (FRG-115, plan: docs/tickets/FRG-114-118_Chat_local_model_tickets.md).
// The local model is Qwen in llama-server, the same program and model that Translate uses.
// It runs on this PC, so the chat text never goes to the Claude API. But the conversation is still
// saved in MongoDB Atlas, like every chat.
// llama-server speaks the OpenAI style: POST /v1/chat/completions with a list of messages.
// The chat text is never written to the log.

// ---- Settings from backend/.env (defaults match .env.example) ----

function wholeNumber(name: string, fallback: number): number {
  const text = (process.env[name] ?? "").trim();
  if (text === "") return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    console.warn(`Warning: ${name} in backend/.env must be a whole number. Using ${fallback}.`);
    return fallback;
  }
  return value;
}

export const LOCAL_ON = (process.env.CHAT_LOCAL ?? "on").trim().toLowerCase() !== "off";
export const LOCAL_LABEL = (process.env.CHAT_LOCAL_LABEL ?? "").trim() || "Qwen3.8-27B";
export const LOCAL_IDLE_MINUTES = wholeNumber("CHAT_LOCAL_IDLE_MINUTES", 5);
const MAX_REPLY_TOKENS = Math.max(1, wholeNumber("CHAT_LOCAL_MAX_REPLY_TOKENS", 4000));

// Why the local model cannot be used in chat, or null when it can. Does not start llama-server.
export function localChatProblem(): string | null {
  if (!LOCAL_ON) return "The local model is turned off for chat (CHAT_LOCAL=off in backend/.env).";
  return checkTranslateSetup().problem;
}

// ---- The conversation in the OpenAI style ----

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type LocalMessage = { role: "system" | "user" | "assistant"; content: string | Part[] };

// The chat template adds a few tokens around each message. A safe guess.
const TOKENS_PER_MESSAGE = 10;
// llama-server answers /tokenize quickly; give up after this long.
const TOKENIZE_TIMEOUT_MS = 10_000;

// How many tokens a text is, counted by llama-server itself.
async function countTokens(text: string): Promise<number> {
  if (text === "") return 0;
  const response = await fetch(`${translateServerUrl()}/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(TOKENIZE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`llama-server could not count tokens (HTTP ${response.status}).`);
  const body = (await response.json()) as { tokens?: unknown[] };
  return body.tokens?.length ?? 0;
}

// Build the request messages: the system prompt, then the newest messages that fit in the model.
// `textOf` is the text of a message as the model should see it (chat.ts adds the card note).
// Pictures: a picture costs up to TRANSLATE_IMAGE_MAX_TOKENS tokens. The newest pictures are sent
// while they take at most half of the room. Older ones are named in the text, like with Claude.
// Then the oldest messages are left out until everything fits next to the longest reply.
// `leftOut` is true when messages were left out because they did not fit.
export async function localHistory(
  messages: ChatMessage[],
  systemPrompt: string,
  textOf: (message: ChatMessage) => string,
  historyLimit: number,
): Promise<{ messages: LocalMessage[]; leftOut: boolean }> {
  const settings = translateSettings();
  const imageTokens = Number(settings.imageMaxTokens);
  const room = settings.context - MAX_REPLY_TOKENS - (await countTokens(systemPrompt)) - TOKENS_PER_MESSAGE;

  const recent = messages.filter((m) => textOf(m).trim() !== "" || (m.images?.length ?? 0) > 0).slice(-historyLimit);

  // The newest pictures, while they take at most half of the room.
  const loaded = await picturesToSend(recent.flatMap((m) => (m.images ?? []).map((image) => image.id)));
  const sendIds = new Set<string>();
  const newestFirst = recent.flatMap((m) => (m.images ?? []).map((image) => image.id)).reverse();
  for (const id of newestFirst) {
    if (!loaded.has(id)) continue;
    if ((sendIds.size + 1) * imageTokens > room / 2) break;
    sendIds.add(id);
  }

  // Each message in the OpenAI style, with its size in tokens.
  const built: { message: LocalMessage; tokens: number; role: string }[] = [];
  for (const m of recent) {
    const text = textOf(m).trim();
    let tokens = TOKENS_PER_MESSAGE + (await countTokens(text));
    if (!m.images?.length) {
      built.push({ message: { role: m.role, content: text }, tokens, role: m.role });
      continue;
    }
    const parts: Part[] = [];
    for (const image of m.images) {
      const picture = loaded.get(image.id);
      if (picture && sendIds.has(image.id)) {
        parts.push({ type: "text", text: `Image ${image.id}:` });
        parts.push({ type: "image_url", image_url: { url: `data:${picture.mediaType};base64,${picture.data}` } });
        tokens += imageTokens + TOKENS_PER_MESSAGE;
      } else {
        const note = `[Image ${image.id} was attached here. It is not sent again, to keep the request small.]`;
        parts.push({ type: "text", text: note });
        tokens += await countTokens(note);
      }
    }
    if (text) parts.push({ type: "text", text });
    built.push({ message: { role: m.role, content: parts }, tokens, role: m.role });
  }

  // Leave out the oldest messages until the rest fits. The newest message always stays.
  let total = built.reduce((sum, b) => sum + b.tokens, 0);
  let leftOut = false;
  while (built.length > 1 && total > room) {
    total -= built.shift()!.tokens;
    leftOut = true;
  }
  // The first message after the system prompt must be from the user.
  while (built.length > 1 && built[0].role !== "user") {
    built.shift();
  }
  return { messages: [{ role: "system", content: systemPrompt }, ...built.map((b) => b.message)], leftOut };
}

// ---- The request ----

// An error from llama-server, with a plain-English text for the page.
export class LocalChatError extends Error {}

// Ask the model and stream the answer. `onText` gets each new piece of text.
// Answers the token counts and why the model stopped ("stop", or "length" when the reply was cut off).
// Throws an AbortError when `signal` is aborted (the Stop button).
export async function streamLocalReply(
  messages: LocalMessage[],
  signal: AbortSignal,
  onText: (piece: string) => void,
): Promise<{ inputTokens: number; outputTokens: number; finish: string | null }> {
  const response = await fetch(`${translateServerUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: MAX_REPLY_TOKENS,
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    // The error body from llama-server says what is wrong. Only its type and status are logged, never chat text.
    const body = (await response.json().catch(() => null)) as { error?: { type?: string } } | null;
    const type = body?.error?.type ?? "unknown";
    console.warn(`Warning: llama-server did not accept the chat request (HTTP ${response.status}, ${type}).`);
    if (type === "exceed_context_size_error") {
      throw new LocalChatError("This conversation is too long for the local model. Start a new chat, or use Claude.");
    }
    throw new LocalChatError(`The local model did not accept the request (HTTP ${response.status}). See the backend log.`);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let finish: string | null = null;
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Each SSE line looks like "data: {...}". The last one is "data: [DONE]".
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice("data: ".length).trim();
      if (data === "[DONE]") continue;
      let chunk: {
        choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        // The parse error would repeat a piece of the reply, so it is not logged.
        console.warn("Warning: llama-server sent a piece of the chat reply that is not valid JSON.");
        throw new LocalChatError("The local model sent an answer that could not be read. Try again, or use Claude.");
      }
      const choice = chunk.choices?.[0];
      const piece = choice?.delta?.content;
      if (piece) onText(piece);
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }
    }
  }
  return { inputTokens, outputTokens, finish };
}

// A plain-English message for an error from the local model. The details go to the backend log.
export function localErrorMessage(error: unknown): string {
  if (error instanceof LocalChatError) return error.message;
  const text = error instanceof Error ? error.message : String(error);
  console.warn(`Warning: local chat failed. ${text}`);
  return "The local model stopped answering. Try again, or use Claude.";
}
