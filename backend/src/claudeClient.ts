import Anthropic from "@anthropic-ai/sdk";
import { safeMessage } from "./db.js";

// The Claude API client, shared by the chat (chat.ts) and the document to pack converter (packConvert.ts, FRG-79).
// The key and the model come from backend/.env. The key stays here in the backend: it is never sent
// to the browser and never logged.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "";

// Only made when the key and the model are set.
export const claudeClient = ANTHROPIC_API_KEY && CLAUDE_MODEL ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

export const NOT_SET_UP_MESSAGE =
  "Chat is not set up. Jaya needs to put ANTHROPIC_API_KEY and CLAUDE_MODEL into backend/.env and restart the backend.";

// Models that support the API's refusal fallback: if Claude declines a message for safety
// reasons, the API tries the same request on another model instead of stopping.
const FALLBACK_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];

// The request fields that turn the refusal fallback on, for the models that support it.
export function fallbackOptions() {
  return FALLBACK_MODELS.includes(CLAUDE_MODEL) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {};
}

// Text that is safe to log: the key is hidden, in case an error ever repeats it.
export function safeLogText(error: unknown): string {
  const text = safeMessage(error);
  return ANTHROPIC_API_KEY ? text.replaceAll(ANTHROPIC_API_KEY, "[key hidden]") : text;
}

// A plain-English message for an error from the Claude API. The details go to the backend log.
export function claudeErrorMessage(error: unknown): string {
  console.warn(`Warning: Claude API error. ${safeLogText(error)}`);
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return "Chat is not set up correctly: the Claude API did not accept the key in backend/.env.";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `The Claude model "${CLAUDE_MODEL}" was not found. Check CLAUDE_MODEL in backend/.env.`;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "The Claude API is busy right now (too many requests). Wait a minute and try again.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "The Claude API cannot be reached. Check the internet connection on System 1, then try again.";
  }
  if (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500) {
    return "The Claude API is having problems right now. Try again in a minute.";
  }
  if (error instanceof Anthropic.APIError) {
    return `The Claude API did not accept the request (HTTP ${error.status}). See the backend log.`;
  }
  return "Something went wrong on the server. See the backend log.";
}
