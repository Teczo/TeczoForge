import Anthropic from "@anthropic-ai/sdk";
import type { Request, Response } from "express";
import type { Collection } from "mongodb";
import { HttpError } from "./httpError.js";
import { getChatUsageCollection, getConversationsCollection } from "./db.js";
import type { ChatMessage, ChatUsage, Conversation } from "./db.js";
import { CHAT_SYSTEM_PROMPT, LOCAL_CHAT_SYSTEM_PROMPT } from "./chatPrompt.js";
import { checkMessageImages, picturesToSend } from "./chatImages.js";
import { buildChatTools, runChatTool } from "./chatTools.js";
import { checkProjectId, checkTargetProjectId } from "./projects.js";
import { CLAUDE_MODEL, claudeClient as client, claudeErrorMessage, fallbackOptions, NOT_SET_UP_MESSAGE, safeLogText } from "./claudeClient.js";
import type { ChatCard, ChatTools } from "./chatTools.js";
import { LOCAL_IDLE_MINUTES, LOCAL_LABEL, localChatProblem, localErrorMessage, localHistory, streamLocalReply } from "./localChatClient.js";
import { localModelUsers, releaseLocalModel, takeLocalModel } from "./localModel.js";

// Chat with Claude (FRG-23), or with the local model Qwen in llama-server (FRG-115, see localChatClient.ts).
// Claude can make board cards with tools (FRG-24, see chatTools.ts). It never starts a generation.
// The chat text goes to the Claude API on the internet. Generation stays on this PC.
// The API key stays here in the backend: it is never sent to the browser and never logged (claudeClient.ts).
// Conversations are saved in MongoDB. Each user can only see their own.
// A reply is streamed to the page with SSE: one open response that sends the text piece by piece.

const DAILY_LIMIT_TEXT = process.env.CHAT_DAILY_TOKEN_LIMIT ?? "";

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
  const localProblem = localChatProblem();
  console.log(localProblem ? `Chat: the local model cannot be used. ${localProblem}` : `Chat: local model ready (${LOCAL_LABEL})`);
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

// Claude tokens this user used since midnight (on System 1's clock).
// Local model tokens cost nothing, so they do not count (FRG-115).
async function tokensUsedToday(username: string): Promise<number> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const rows = await withCollection(getChatUsageCollection, (usage: Collection<ChatUsage>) =>
    usage
      .aggregate<{ total: number }>([
        { $match: { username, createdAt: { $gte: midnight }, model: { $ne: "local" } } },
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

// ---- The two engines (FRG-115) ----

// "claude": the Claude API. "local": Qwen in llama-server on this PC.
type Engine = "claude" | "local";

function checkEngine(value: unknown): Engine {
  if (value === undefined) return "claude";
  if (value === "claude" || value === "local") return value;
  throw new HttpError(400, 'model must be "claude" or "local".');
}

// What an engine made for one reply. sendMessageHandler saves it.
type ReplyParts = { text: string; cards: ChatCard[]; inputTokens: number; outputTokens: number; errorText: string | null };

// The Stop button: the page closes the request. `current` is the model request running now.
type StopState = { stopped: boolean; current: { abort(): void } | null };

// The local model stays loaded for CHAT_LOCAL_IDLE_MINUTES after the last local reply, so the next
// message is fast. Then chat lets go of it, and llama-server stops if Translate does not use it.
let localReplies = 0; // Local replies running now.
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function localReplyStarts() {
  localReplies++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function localReplyEnds() {
  localReplies--;
  if (localReplies > 0) return;
  const letGo = () => {
    idleTimer = null;
    if (localReplies > 0 || !localModelUsers().includes("chat")) return;
    releaseLocalModel("chat").then(
      () => console.log("Chat: let go of the local model (no local message for a while)."),
      (error: unknown) => console.error(`Chat: could not let go of the local model. ${safeLogText(error)}`),
    );
  };
  if (LOCAL_IDLE_MINUTES === 0) letGo();
  else idleTimer = setTimeout(letGo, LOCAL_IDLE_MINUTES * 60_000);
}

// ---- Routes ----

// GET /api/chat/status  Answer: { "ready": true } or { "ready": false, "error": "Chat is not set up..." }
export function chatStatusHandler(_req: Request, res: Response) {
  res.json(client ? { ready: true } : { ready: false, error: NOT_SET_UP_MESSAGE });
}

// GET /api/chat/models  The models the chat can use (FRG-115). Does not start llama-server.
// Answer: [{ "id": "claude", "label": "Claude", "ready": true }, { "id": "local", "label": "Qwen3.8-27B", "ready": false, "problem": "..." }]
export function chatModelsHandler(_req: Request, res: Response) {
  const localProblem = localChatProblem();
  res.json([
    { id: "claude", label: "Claude", ready: client !== null, ...(client ? {} : { problem: NOT_SET_UP_MESSAGE }) },
    { id: "local", label: LOCAL_LABEL, ready: localProblem === null, ...(localProblem ? { problem: localProblem } : {}) },
  ]);
}

// GET /api/chat/conversations  My conversations, newest first, without their messages.
//   ?projectId=<id>  only conversations in this project (FRG-42)
export async function listConversationsHandler(req: Request, res: Response) {
  try {
    const owner: string = res.locals.username;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    if (projectId !== null && !ID_PATTERN.test(projectId)) throw new HttpError(400, "projectId must be a project id.");
    const conversations = await withConversations((c) =>
      c
        .find(
          { owner, ...(projectId ? { projectId } : {}) },
          { projection: { _id: 0, id: 1, title: 1, projectId: 1, createdAt: 1, updatedAt: 1 } },
        )
        .sort({ updatedAt: -1 })
        .limit(LIST_LIMIT)
        .toArray(),
    );
    res.json({ conversations });
  } catch (error) {
    sendError(res, error);
  }
}

// POST /api/chat/conversations  Body: { "title": "...", "projectId": "..." } (both optional).
// No projectId: "Unsorted". An unknown or archived project answers 400 (FRG-42).
// Answer: the new conversation.
export async function createConversationHandler(req: Request, res: Response) {
  try {
    const title = req.body?.title === undefined ? DEFAULT_TITLE : checkTitle(req.body.title);
    const projectId = await checkProjectId(req.body?.projectId);
    const now = new Date();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      owner: res.locals.username,
      projectId,
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

// PATCH /api/chat/conversations/<id>  Body: any of { "title": "...", "projectId": "..." }
// Rename one of my conversations, or move it to another project (FRG-43).
// An unknown or archived project answers 400. Moving does not change the order of the list.
export async function renameConversationHandler(req: Request, res: Response) {
  try {
    const id = checkId(req.params.id);
    const { title, projectId } = req.body ?? {};
    if (title === undefined && projectId === undefined) throw new HttpError(400, "Send a title or a projectId to change.");
    const fields: { title?: string; updatedAt?: Date; projectId?: string } = {};
    if (title !== undefined) {
      fields.title = checkTitle(title);
      fields.updatedAt = new Date();
    }
    if (projectId !== undefined) fields.projectId = await checkTargetProjectId(projectId);
    const owner: string = res.locals.username;
    const result = await withConversations((c) => c.updateOne({ id, owner }, { $set: fields }));
    if (result.matchedCount === 0) throw NOT_FOUND();
    res.json({ id, ...(fields.title ? { title: fields.title } : {}), ...(fields.projectId ? { projectId: fields.projectId } : {}) });
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
//
// Body field "model" (FRG-115): "claude" (also when missing) or "local" (Qwen in llama-server).
// The local model sends the same events, never "card", and one more:
//   event: status data: { "text": "Loading Qwen. ..." }  while the model loads
// The local model answers 409 before the stream when the GPU is busy with a generation or a translation.
export async function sendMessageHandler(req: Request, res: Response) {
  const username: string = res.locals.username;
  // The SSE stream. For the local model it can start early, to show that the model is loading.
  let streaming = false;
  const startStream = () => {
    if (streaming) return;
    streaming = true;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
  };
  const sendEvent = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Stop button: the page closes the request. Stop asking the model, keep what arrived.
  const stop: StopState = { stopped: false, current: null };
  res.on("close", () => {
    if (!res.writableEnded) {
      stop.stopped = true;
      stop.current?.abort();
    }
  });

  let engine: Engine = "claude";
  let localStarted = false; // localReplyStarts() was called, so localReplyEnds() must follow.
  try {
    let conversation: Conversation;
    let tools: ChatTools | null = null;
    let usedBefore = 0; // Claude tokens this user used today before this reply (only counted when there is a limit).
    try {
      engine = checkEngine(req.body?.model);
      if (engine === "claude" && !client) throw new HttpError(503, NOT_SET_UP_MESSAGE);
      if (engine === "local") {
        const problem = localChatProblem();
        if (problem) throw new HttpError(503, problem);
      }
      const id = checkId(req.params.conversationId);
      const text = req.body?.text ?? "";
      // Check the pictures first: a picture the model cannot take gives a clear message and no model call.
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

      if (engine === "claude") {
        if (dailyTokenLimit > 0) usedBefore = await tokensUsedToday(username);
        if (dailyTokenLimit > 0 && usedBefore >= dailyTokenLimit) {
          throw new HttpError(
            429,
            `You have used your chat limit for today (${dailyTokenLimit.toLocaleString("en")} tokens). It starts again at midnight.`,
          );
        }
      } else {
        // Do not wait in line behind a translation: it can take minutes.
        if (localModelUsers().includes("translate")) {
          throw new HttpError(409, "Qwen is busy with a translation. Use Claude, or try again later.");
        }
        localReplyStarts();
        localStarted = true;
        const state = await takeLocalModel("chat", () => {
          // ComfyUI is free and the model starts to load: start the stream and say so.
          startStream();
          sendEvent("status", { text: "Loading Qwen. The first time takes about a minute." });
        }).catch((error: unknown) => {
          throw new HttpError(503, error instanceof Error ? error.message : String(error));
        });
        if (state === "busy") {
          throw new HttpError(409, "The GPU is busy with a generation. Use Claude, or try again when it is done.");
        }
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

      // The card tools, from the preset folders as they are now. Only Claude gets them.
      if (engine === "claude") tools = await buildChatTools();
    } catch (error) {
      if (streaming) {
        sendEvent("error", { error: error instanceof HttpError ? error.message : "Something went wrong on the server. See the backend log." });
        res.end();
      } else {
        sendError(res, error);
      }
      return;
    }

    // From here on the answer is an SSE stream.
    startStream();
    if (stop.stopped) return; // Stopped while the model was loading.
    const parts =
      engine === "claude"
        ? await claudeReply(client!, conversation, username, tools!, usedBefore, sendEvent, stop)
        : await localReply(conversation, sendEvent, stop);
    await saveReply(engine, parts, conversation, username, sendEvent, stop);
    if (!stop.stopped) {
      if (parts.errorText) sendEvent("error", { error: parts.errorText });
      res.end();
    }
  } finally {
    if (localStarted) localReplyEnds();
  }
}

// Save the reply, its cards and its tokens, also when it was stopped or cut off.
// If saving fails, parts.errorText says so.
async function saveReply(
  engine: Engine,
  parts: ReplyParts,
  conversation: Conversation,
  username: string,
  sendEvent: (event: string, data: unknown) => void,
  stop: StopState,
) {
  if (parts.text === "" && parts.cards.length === 0 && parts.inputTokens === 0 && parts.outputTokens === 0) return;
  const modelLabel = engine === "claude" ? CLAUDE_MODEL : LOCAL_LABEL;
  const reply: ChatMessage = {
    role: "assistant",
    text: parts.text,
    createdAt: new Date(),
    username,
    inputTokens: parts.inputTokens,
    outputTokens: parts.outputTokens,
    ...(stop.stopped ? { stopped: true } : {}),
    ...(parts.cards.length > 0 ? { cards: parts.cards } : {}),
    model: engine,
    modelLabel,
  };
  try {
    await withConversations((c) =>
      c.updateOne({ id: conversation.id, owner: username }, { $push: { messages: reply }, $set: { updatedAt: reply.createdAt } }),
    );
    await withCollection(getChatUsageCollection, (usage: Collection<ChatUsage>) =>
      usage.insertOne({
        username,
        conversationId: conversation.id,
        model: engine,
        modelLabel,
        inputTokens: parts.inputTokens,
        outputTokens: parts.outputTokens,
        createdAt: reply.createdAt,
      }),
    );
    if (!stop.stopped) sendEvent("done", { message: reply });
  } catch (error) {
    parts.errorText ??= error instanceof HttpError ? error.message : "The reply could not be saved. See the backend log.";
  }
}

// The local engine (FRG-115): one request to Qwen in llama-server, streamed. No tools, no cards.
async function localReply(
  conversation: Conversation,
  sendEvent: (event: string, data: unknown) => void,
  stop: StopState,
): Promise<ReplyParts> {
  const parts: ReplyParts = { text: "", cards: [], inputTokens: 0, outputTokens: 0, errorText: null };
  const controller = new AbortController();
  stop.current = controller;
  try {
    const history = await localHistory(conversation.messages, LOCAL_CHAT_SYSTEM_PROMPT, (m) => m.text + cardsNote(m), HISTORY_LIMIT);
    const result = await streamLocalReply(history.messages, controller.signal, (piece) => {
      parts.text += piece;
      sendEvent("text", { text: piece });
    });
    parts.inputTokens = result.inputTokens;
    parts.outputTokens = result.outputTokens;
    if (result.finish === "length") parts.errorText = "The reply was too long and was cut off. Ask for a shorter answer.";
    if (history.leftOut) {
      const note = `${parts.text === "" ? "" : "\n\n"}Older messages were left out, because they do not fit in the local model.`;
      parts.text += note;
      sendEvent("text", { text: note });
    }
  } catch (error) {
    if (!stop.stopped) parts.errorText = localErrorMessage(error);
  }
  return parts;
}

// The Claude engine (FRG-23, FRG-24): rounds of API requests, with the card tools.
async function claudeReply(
  api: Anthropic,
  conversation: Conversation,
  username: string,
  tools: ChatTools,
  usedBefore: number,
  sendEvent: (event: string, data: unknown) => void,
  stop: StopState,
): Promise<ReplyParts> {
  // The conversation for the API. Tool calls and their results are added during this reply only.
  let messages: Anthropic.Beta.BetaMessageParam[];
  try {
    messages = await historyFor(conversation.messages);
  } catch (error) {
    return { text: "", cards: [], inputTokens: 0, outputTokens: 0, errorText: claudeErrorMessage(error) };
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
    while (!stop.stopped) {
      const stream = api.beta.messages.stream({
        model: CLAUDE_MODEL,
        max_tokens: MAX_REPLY_TOKENS,
        system: CHAT_SYSTEM_PROMPT,
        tools: tools.tools,
        messages,
        cache_control: { type: "ephemeral" }, // Reuse the earlier part of the conversation: cheaper and faster.
        ...fallbackOptions(),
      });
      stop.current = stream;
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
        const outcome = await runChatTool(block, {
          tools,
          username,
          conversationId: conversation.id,
          projectId: conversation.projectId,
          imageIds,
        });
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
      // Each round costs tokens. Check the daily limit before asking Claude again (FRG-28).
      if (dailyTokenLimit > 0 && usedBefore + inputTokens + outputTokens >= dailyTokenLimit) {
        const made = cards.length > 0 ? " The cards made so far are on the board." : "";
        const note =
          `${replyText === "" ? "" : "\n\n"}I stopped here: you have used your chat limit for today ` +
          `(${dailyTokenLimit.toLocaleString("en")} tokens).${made} It starts again at midnight.`;
        replyText += note;
        sendEvent("text", { text: note });
        break;
      }
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    if (stop.stopped) {
      inputTokens += roundInput;
      outputTokens += roundOutput;
    } else {
      errorText = claudeErrorMessage(error);
    }
  }

  return { text: replyText, cards, inputTokens, outputTokens, errorText };
}
