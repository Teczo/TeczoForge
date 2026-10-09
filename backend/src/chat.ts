import Anthropic from "@anthropic-ai/sdk";
import type { Request, Response } from "express";
import type { Collection } from "mongodb";
import { HttpError } from "./httpError.js";
import { getChatUsageCollection, getConversationsCollection, safeMessage } from "./db.js";
import type { ChatMessage, ChatUsage, Conversation } from "./db.js";
import { CHAT_SYSTEM_PROMPT } from "./chatPrompt.js";
import { checkMessageImages, picturesToSend } from "./chatImages.js";
import { buildChatTools, runChatTool } from "./chatTools.js";
import type { ChatCard, ChatTools } from "./chatTools.js";

// Chat with Claude (FRG-23). Text only.
// Claude can make board cards with tools (FRG-24, see chatTools.ts). It never starts a generation.
// The chat text goes to the Claude API on the internet. Generation stays on this PC.
// The API key stays here in the backend: it is never sent to the browser and never logged.
// Conversations are saved in MongoDB. Each user can only see their own.
// A reply is streamed to the page with SSE: one open response that sends the text piece by piece.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "";
const DAILY_LIMIT_TEXT = process.env.CHAT_DAILY_TOKEN_LIMIT ?? "";

// Only made when the key and the model are set.
const client = ANTHROPIC_API_KEY && CLAUDE_MODEL ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const NOT_SET_UP_MESSAGE =
  "Chat is not set up. Jaya needs to put ANTHROPIC_API_KEY and CLAUDE_MODEL into backend/.env and restart the backend.";
const OFFLINE_MESSAGE =
  "Chat needs MongoDB, which cannot be reached right now. Generating images and videos still works.";

const MAX_MESSAGE_LENGTH = 8000;
// Only the newest messages go to the API, so long conversations stay fast and cheap.
const HISTORY_LIMIT = 40;
// The longest reply. Claude thinks before it answers, and thinking counts too.
const MAX_REPLY_TOKENS = 16000;
const DEFAULT_TITLE = "New chat";
const MAX_TITLE_LENGTH = 80;
const LIST_LIMIT = 100;
// The most tool calls (cards) for one user message.
const MAX_TOOL_CALLS = 8;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Models that support the API's refusal fallback: if Claude declines a message for safety
// reasons, the API tries the same request on another model instead of stopping.
const FALLBACK_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];

// The token limit per user per day, or 0 for no limit.
let dailyTokenLimit = 0;

// Say at start whether chat is ready. Never prints the key.
export function checkChatSetup() {
  if (DAILY_LIMIT_TEXT !== "") {
    dailyTokenLimit = Number(DAILY_LIMIT_TEXT);
    if (!Number.isInteger(dailyTokenLimit) || dailyTokenLimit < 1) {
      console.warn("Warning: CHAT_DAILY_TOKEN_LIMIT in backend/.env must be a whole number above 0. Chat runs without a limit.");
      dailyTokenLimit = 0;
    }
  }
  if (client) {
    const limit = dailyTokenLimit > 0 ? `, ${dailyTokenLimit} tokens per user per day` : "";
    console.log(`Chat: ready (model ${CLAUDE_MODEL}${limit})`);
  } else {
    console.warn("Warning: chat is not set up. Put ANTHROPIC_API_KEY and CLAUDE_MODEL into backend/.env to use it.");
  }
}

// Text that is safe to log: the key is hidden, in case an error ever repeats it.
function safeLogText(error: unknown): string {
  const text = safeMessage(error);
  return ANTHROPIC_API_KEY ? text.replaceAll(ANTHROPIC_API_KEY, "[key hidden]") : text;
}

function sendError(res: Response, error: unknown) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error("Chat failed:", safeLogText(error));
  res.status(500).json({ error: "Something went wrong on the server. See the backend log." });
}

// Run work on a MongoDB collection. If MongoDB cannot be reached, throw the clear 503 message.
async function withCollection<T, C>(open: () => Promise<C>, work: (collection: C) => Promise<T>): Promise<T> {
  try {
    return await work(await open());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn(`Warning: chat could not use MongoDB. ${safeLogText(error)}`);
    throw new HttpError(503, OFFLINE_MESSAGE);
  }
}

function withConversations<T>(work: (c: Collection<Conversation>) => Promise<T>): Promise<T> {
  return withCollection(getConversationsCollection, work);
}

function checkId(value: unknown): string {
  const id = String(value);
  if (!ID_PATTERN.test(id)) throw new HttpError(400, "This is not a conversation id.");
  return id;
}

function checkTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim() === "") throw new HttpError(400, "A title cannot be empty.");
  if (title.trim().length > MAX_TITLE_LENGTH) {
    throw new HttpError(400, `A title can be at most ${MAX_TITLE_LENGTH} characters.`);
  }
  return title.trim();
}

const NOT_FOUND = () => new HttpError(404, "There is no conversation with this id.");

// Tokens this user used since midnight (on System 1's clock).
async function tokensUsedToday(username: string): Promise<number> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const rows = await withCollection(getChatUsageCollection, (usage: Collection<ChatUsage>) =>
    usage
      .aggregate<{ total: number }>([
        { $match: { username, createdAt: { $gte: midnight } } },
        { $group: { _id: null, total: { $sum: { $add: ["$inputTokens", "$outputTokens"] } } } },
      ])
      .toArray(),
  );
  return rows[0]?.total ?? 0;
}

// A short note about the cards in a reply, so Claude knows later which cards it already made.
function cardsNote(message: ChatMessage): string {
  if (!message.cards?.length) return "";
  const list = message.cards.map((card) => `"${card.title}" (${card.presetId})`).join(", ");
  return `\n\n[Cards made in this reply: ${list}]`;
}

// The newest messages, as the API wants them. The first one must be from the user.
// Attached pictures go along as image content, each after a line "Image <id>:" (FRG-25).
async function historyFor(messages: ChatMessage[]): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const recent = messages
    .filter((m) => (m.text + cardsNote(m)).trim() !== "" || (m.images?.length ?? 0) > 0)
    .slice(-HISTORY_LIMIT);
  while (recent.length > 0 && recent[0].role !== "user") recent.shift();

  const sent = await picturesToSend(recent.flatMap((m) => (m.images ?? []).map((image) => image.id)));
  return recent.map((m) => {
    const text = (m.text + cardsNote(m)).trim();
    if (!m.images?.length) return { role: m.role, content: text };
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const image of m.images) {
      const loaded = sent.get(image.id);
      if (loaded) {
        blocks.push({ type: "text", text: `Image ${image.id}:` });
        blocks.push({ type: "image", source: { type: "base64", media_type: loaded.mediaType, data: loaded.data } });
      } else {
        blocks.push({ type: "text", text: `[Image ${image.id} was attached here. It is not sent again, to keep the request small.]` });
      }
    }
    if (text) blocks.push({ type: "text", text });
    return { role: m.role, content: blocks };
  });
}

// A plain-English message for an error from the Claude API. The details go to the backend log.
function claudeErrorMessage(error: unknown): string {
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

// ---- Routes ----

// GET /api/chat/status  Answer: { "ready": true } or { "ready": false, "error": "Chat is not set up..." }
export function chatStatusHandler(_req: Request, res: Response) {
  res.json(client ? { ready: true } : { ready: false, error: NOT_SET_UP_MESSAGE });
}

// GET /api/chat/conversations  My conversations, newest first, without their messages.
export async function listConversationsHandler(_req: Request, res: Response) {
  try {
    const owner: string = res.locals.username;
    const conversations = await withConversations((c) =>
      c
        .find({ owner }, { projection: { _id: 0, id: 1, title: 1, createdAt: 1, updatedAt: 1 } })
        .sort({ updatedAt: -1 })
        .limit(LIST_LIMIT)
        .toArray(),
    );
    res.json({ conversations });
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/chat/conversations  Body: { "title": "..." } (optional). Answer: the new conversation.
export async function createConversationHandler(req: Request, res: Response) {
  try {
    const title = req.body?.title === undefined ? DEFAULT_TITLE : checkTitle(req.body.title);
    const now = new Date();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      owner: res.locals.username,
      title,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    // A copy: insertOne adds MongoDB's own _id to what it gets.
    await withConversations((c) => c.insertOne({ ...conversation }));
    res.status(201).json(conversation);
  } catch (error) {
    sendError(res, error);
  }
}

// GET /api/chat/conversations/<id>  One of my conversations, with its messages.
export async function getConversationHandler(req: Request, res: Response) {
  try {
    const id = checkId(req.params.id);
    const owner: string = res.locals.username;
    const conversation = await withConversations((c) => c.findOne({ id, owner }, { projection: { _id: 0 } }));
    if (!conversation) throw NOT_FOUND(); // Also for someone else's conversation: we do not say it exists.
    res.json(conversation);
  } catch (error) {
    sendError(res, error);
  }
}

// PATCH /api/chat/conversations/<id>  Body: { "title": "..." }  Rename one of my conversations.
export async function renameConversationHandler(req: Request, res: Response) {
  try {
    const id = checkId(req.params.id);
    const title = checkTitle(req.body?.title);
    const owner: string = res.locals.username;
    const result = await withConversations((c) => c.updateOne({ id, owner }, { $set: { title, updatedAt: new Date() } }));
    if (result.matchedCount === 0) throw NOT_FOUND();
    res.json({ id, title });
  } catch (error) {
    sendError(res, error);
  }
}

// DELETE /api/chat/conversations/<id>  Delete one of my conversations.
export async function deleteConversationHandler(req: Request, res: Response) {
  try {
    const id = checkId(req.params.id);
    const owner: string = res.locals.username;
    const result = await withConversations((c) => c.deleteOne({ id, owner }));
    if (result.deletedCount === 0) throw NOT_FOUND();
    res.json({ deleted: id });
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/chat/<conversationId>/messages  Body: { "text": "...", "images": ["<picture id>", ...] }
// Pictures are uploaded first with POST /api/upload; their names are their ids (FRG-25).
// Saves the message, then streams the reply as SSE events:
//   event: text   data: { "text": "<next piece>" }
//   event: card   data: { "card": { id, title, presetId } }  Claude made a board card (FRG-24)
//   event: done   data: { "message": <the saved reply> }
//   event: error  data: { "error": "<plain English>" }
// Problems found before the reply starts (not set up, limit reached, ...) are a normal JSON error.
// If the page closes the request (the Stop button), the text so far is saved as the reply.
export async function sendMessageHandler(req: Request, res: Response) {
  const username: string = res.locals.username;
  let conversation: Conversation;
  let tools: ChatTools;
  try {
    if (!client) throw new HttpError(503, NOT_SET_UP_MESSAGE);
    const id = checkId(req.params.conversationId);
    const text = req.body?.text ?? "";
    // Check the pictures first: a picture Claude cannot take gives a clear message and no API call.
    const images = await checkMessageImages(req.body?.images);
    if (typeof text !== "string" || (text.trim() === "" && images.length === 0)) {
      throw new HttpError(400, "Type a message or attach a picture first.");
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new HttpError(
        400,
        `A message can be at most ${MAX_MESSAGE_LENGTH.toLocaleString("en")} characters. This one has ${text.length.toLocaleString("en")}.`,
      );
    }

    const found = await withConversations((c) => c.findOne({ id, owner: username }, { projection: { _id: 0 } }));
    if (!found) throw NOT_FOUND();
    conversation = found;

    if (dailyTokenLimit > 0 && (await tokensUsedToday(username)) >= dailyTokenLimit) {
      throw new HttpError(
        429,
        `You have used your chat limit for today (${dailyTokenLimit.toLocaleString("en")} tokens). It starts again at midnight.`,
      );
    }

    // Save the message first. The first message also becomes the title of a new chat.
    const message: ChatMessage = {
      role: "user",
      text,
      createdAt: new Date(),
      username,
      ...(images.length > 0 ? { images } : {}),
    };
    const fields: Partial<Conversation> = { updatedAt: message.createdAt };
    if (conversation.messages.length === 0 && conversation.title === DEFAULT_TITLE) {
      fields.title = text.trim().replace(/\s+/g, " ").slice(0, 60) || "Picture";
    }
    await withConversations((c) => c.updateOne({ id, owner: username }, { $push: { messages: message }, $set: fields }));
    conversation.messages.push(message);

    // The card tools, from the preset folders as they are now.
    tools = await buildChatTools();
  } catch (error) {
    sendError(res, error);
    return;
  }

  // From here on the answer is an SSE stream.
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const sendEvent = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Stop button: the page closes the request. Stop asking Claude, keep what arrived.
  let stoppedByUser = false;
  let current: { abort(): void } | null = null; // The request to Claude that is running now.
  res.on("close", () => {
    if (!res.writableEnded) {
      stoppedByUser = true;
      current?.abort();
    }
  });

  // The conversation for the API. Tool calls and their results are added during this reply only.
  let messages: Anthropic.Beta.BetaMessageParam[];
  try {
    messages = await historyFor(conversation.messages);
  } catch (error) {
    sendEvent("error", { error: claudeErrorMessage(error) });
    res.end();
    return;
  }
  // Pictures attached anywhere in this chat: their ids can be used as start images on cards.
  const imageIds = conversation.messages.flatMap((m) => (m.images ?? []).map((image) => image.id));
  const cards: ChatCard[] = [];
  let toolCalls = 0;
  let replyText = "";
  let inputTokens = 0; // Summed over all the rounds of this reply.
  let outputTokens = 0;
  let roundInput = 0; // This round, while it streams (used when Stop is pressed).
  let roundOutput = 0;
  let errorText: string | null = null;

  try {
    // One round per API request. When Claude calls a tool, run it and ask again with the result.
    while (!stoppedByUser) {
      const stream = client.beta.messages.stream({
        model: CLAUDE_MODEL,
        max_tokens: MAX_REPLY_TOKENS,
        system: CHAT_SYSTEM_PROMPT,
        tools: tools.tools,
        messages,
        cache_control: { type: "ephemeral" }, // Reuse the earlier part of the conversation: cheaper and faster.
        ...(FALLBACK_MODELS.includes(CLAUDE_MODEL)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
      current = stream;
      roundInput = 0;
      roundOutput = 0;
      let firstText = true;
      for await (const event of stream) {
        if (event.type === "message_start") {
          const usage = event.message.usage;
          roundInput = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        } else if (event.type === "message_delta") {
          roundOutput = event.usage.output_tokens;
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          // Text after a tool call starts on a new paragraph.
          let piece = event.delta.text;
          if (firstText && replyText !== "" && !replyText.endsWith("\n")) piece = `\n\n${piece}`;
          firstText = false;
          replyText += piece;
          sendEvent("text", { text: piece });
        }
      }
      // Finished normally: take the exact token counts of this round.
      const final = await stream.finalMessage();
      inputTokens +=
        final.usage.input_tokens + (final.usage.cache_creation_input_tokens ?? 0) + (final.usage.cache_read_input_tokens ?? 0);
      outputTokens += final.usage.output_tokens;
      roundInput = 0;
      roundOutput = 0;

      if (final.stop_reason === "refusal") {
        errorText = "Claude declined to answer this message. Try asking in a different way.";
        break;
      }
      if (final.stop_reason === "max_tokens") {
        // A tool call cut off here may look complete, so it is never run.
        errorText = "The reply was too long and was cut off. Ask for a shorter answer.";
        break;
      }
      const toolUses = final.content.filter((block) => block.type === "tool_use");
      if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;

      // Run the tool calls. Each one makes a draft card in Ready, or tells Claude what is wrong.
      messages.push({ role: "assistant", content: final.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of toolUses) {
        toolCalls++;
        if (toolCalls > MAX_TOOL_CALLS) {
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: `Not made: at most ${MAX_TOOL_CALLS} cards per message.`,
          });
          continue;
        }
        const outcome = await runChatTool(block, { tools, username, conversationId: conversation.id, imageIds });
        results.push(outcome.result);
        if (outcome.card) {
          cards.push(outcome.card);
          sendEvent("card", { card: outcome.card });
        }
      }
      // Claude asked for more than the limit: stop here and say so.
      if (toolCalls > MAX_TOOL_CALLS) {
        const note = `${replyText === "" ? "" : "\n\n"}I stopped here: I can make at most ${MAX_TOOL_CALLS} cards for one message.`;
        replyText += note;
        sendEvent("text", { text: note });
        break;
      }
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    if (stoppedByUser) {
      inputTokens += roundInput;
      outputTokens += roundOutput;
    } else {
      errorText = claudeErrorMessage(error);
    }
  }

  // Save the reply, its cards and its tokens, also when it was stopped or cut off.
  if (replyText !== "" || cards.length > 0 || inputTokens > 0 || outputTokens > 0) {
    const reply: ChatMessage = {
      role: "assistant",
      text: replyText,
      createdAt: new Date(),
      username,
      inputTokens,
      outputTokens,
      ...(stoppedByUser ? { stopped: true } : {}),
      ...(cards.length > 0 ? { cards } : {}),
    };
    try {
      await withConversations((c) =>
        c.updateOne({ id: conversation.id, owner: username }, { $push: { messages: reply }, $set: { updatedAt: reply.createdAt } }),
      );
      await withCollection(getChatUsageCollection, (usage: Collection<ChatUsage>) =>
        usage.insertOne({ username, conversationId: conversation.id, model: CLAUDE_MODEL, inputTokens, outputTokens, createdAt: reply.createdAt }),
      );
      if (!stoppedByUser) sendEvent("done", { message: reply });
    } catch (error) {
      errorText ??= error instanceof HttpError ? error.message : "The reply could not be saved. See the backend log.";
    }
  }

  if (!stoppedByUser) {
    if (errorText) sendEvent("error", { error: errorText });
    res.end();
  }
}
