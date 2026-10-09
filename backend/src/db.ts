import { MongoClient } from "mongodb";
import type { Collection, Db, Filter } from "mongodb";
import { HttpError } from "./httpError.js";

// The connection string is a secret. Never print it.
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "teczoforge";

// How long to wait for MongoDB before giving up. Generation must not wait long for it.
const TIMEOUT_MS = 3000;

// draft: a board card, saved but not run yet (FRG-22). queued: waiting in ComfyUI's queue.
// running: ComfyUI is working on it. done, failed or cancelled: finished.
export type JobStatus = "draft" | "queued" | "running" | "done" | "failed" | "cancelled";

// The two board columns a draft can be in. The user moves drafts between them.
export type DraftColumn = "idea" | "ready";

// One record per job. It is saved when the job starts, and again each time its status changes.
export type Job = {
  id: string; // A UUID. Jobs from before FRG-20 do not have it.
  presetId: string | null;
  inputs: unknown; // The values used, including the random seed. A draft keeps the values as typed.
  status: JobStatus;
  promptId: string | null; // ComfyUI's job id. null until ComfyUI has accepted the job.
  outputFile: string | null; // For example "data/outputs/text-to-image-basic-1791353459669.png"
  imageUrl: string | null;
  error: string | null;
  durationMs: number; // 0 until the job is finished.
  createdAt: Date;
  createdBy: string | null; // The username of who started the job. Jobs from before FRG-16 do not have it.
  cancelledBy?: string | null; // Only on cancelled jobs: who cancelled it, and when.
  cancelledAt?: Date;
  title?: string; // Only on jobs that started as a board card (FRG-22).
  column?: DraftColumn; // Only used while the job is a draft.
  conversationId?: string; // Only on cards Claude made in a chat (FRG-24).
};

// Which jobs GET /api/jobs returns. See listJobs.
export type JobQuery = {
  limit: number;
  before: Date | null; // Only jobs made before this time (for the next page).
  status: JobStatus | null;
  createdBy: string | null;
};

// One team member who can log in. Accounts are made with "npm run user" (see setUser.ts).
export type User = {
  username: string; // Lowercase, unique.
  passwordHash: string; // Never the password itself (see auth.ts).
  createdAt: Date;
  updatedAt: Date;
};

// One message in a chat conversation (FRG-23).
export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt: Date;
  username: string; // Who sent it, or who asked for this reply.
  // Only on replies: tokens used for this reply. Input includes cached tokens.
  inputTokens?: number;
  outputTokens?: number;
  stopped?: boolean; // The user pressed Stop. The text is what arrived until then.
  cards?: { id: string; title: string; presetId: string }[]; // Board cards Claude made in this reply (FRG-24).
};

// A chat conversation. Only its owner can read it.
export type Conversation = {
  id: string; // A UUID.
  owner: string;
  title: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
};

// Tokens used by one chat reply. Kept apart from the conversation, so deleting a
// conversation does not change what was used today (CHAT_DAILY_TOKEN_LIMIT).
export type ChatUsage = {
  username: string;
  conversationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
};

let connecting: Promise<MongoClient> | null = null;

// Connect once and reuse the connection. If it fails, the next call tries again.
async function getDatabase(): Promise<Db> {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not set in backend/.env");
  }
  if (!connecting) {
    connecting = (async () => {
      const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: TIMEOUT_MS });
      try {
        return await client.connect();
      } catch (error) {
        connecting = null;
        await client.close().catch(() => {});
        throw error;
      }
    })();
  }
  const client = await connecting;
  return client.db(DB_NAME);
}

async function getJobsCollection(): Promise<Collection<Job>> {
  return (await getDatabase()).collection<Job>("jobs");
}

// The users collection. Usernames are unique.
export async function getUsersCollection(): Promise<Collection<User>> {
  const users = (await getDatabase()).collection<User>("users");
  await users.createIndex({ username: 1 }, { unique: true });
  return users;
}

// The chat conversations (FRG-23).
export async function getConversationsCollection(): Promise<Collection<Conversation>> {
  return (await getDatabase()).collection<Conversation>("conversations");
}

export async function getChatUsageCollection(): Promise<Collection<ChatUsage>> {
  return (await getDatabase()).collection<ChatUsage>("chat_usage");
}

// Close the connection (used by the "npm run user" command when it is done).
export async function closeDatabase(): Promise<void> {
  if (connecting) await (await connecting).close();
  connecting = null;
}

// Save a job: add it, or replace the saved copy with the same id. Returns a warning if it could
// not be saved. Never throws, so generation still works when MongoDB is offline.
export async function saveJob(job: Job): Promise<string | undefined> {
  try {
    const jobs = await getJobsCollection();
    await jobs.replaceOne({ id: job.id }, job, { upsert: true });
    return undefined;
  } catch (error) {
    console.warn(`Warning: job not saved. ${safeMessage(error)}`);
    return "This job was not saved to the job history because MongoDB cannot be reached.";
  }
}

// One page of jobs, newest first.
export async function listJobs(query: JobQuery): Promise<Job[]> {
  const filter: Filter<Job> = {};
  if (query.before) filter.createdAt = { $lt: query.before };
  if (query.status) filter.status = query.status;
  if (query.createdBy) filter.createdBy = query.createdBy;
  try {
    const jobs = await getJobsCollection();
    return await jobs.find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(query.limit).toArray();
  } catch (error) {
    console.warn(`Warning: could not read jobs. ${safeMessage(error)}`);
    throw new HttpError(503, "The job history is not available because MongoDB cannot be reached.");
  }
}

// One job by its id, or null if there is none.
export async function findJob(id: string): Promise<Job | null> {
  try {
    const jobs = await getJobsCollection();
    return await jobs.findOne({ id }, { projection: { _id: 0 } });
  } catch (error) {
    console.warn(`Warning: could not read the job. ${safeMessage(error)}`);
    throw new HttpError(503, "This job is not available because MongoDB cannot be reached.");
  }
}

// ---- Board drafts (FRG-22) ----
// Drafts need MongoDB. These functions throw a clear 503 error when it cannot be reached.

const BOARD_OFFLINE_MESSAGE =
  "The board needs MongoDB, which cannot be reached right now. The Generate page still works.";

async function withJobs<T>(work: (jobs: Collection<Job>) => Promise<T>): Promise<T> {
  try {
    return await work(await getJobsCollection());
  } catch (error) {
    console.warn(`Warning: board not available. ${safeMessage(error)}`);
    throw new HttpError(503, BOARD_OFFLINE_MESSAGE);
  }
}

export function insertDraft(draft: Job): Promise<void> {
  return withJobs(async (jobs) => {
    await jobs.insertOne({ ...draft }); // A copy: insertOne adds MongoDB's own _id to what it gets.
  });
}

// Change a draft. Only while it is still a draft. Returns false if there is no such draft.
export function updateDraft(id: string, fields: Partial<Job>): Promise<boolean> {
  return withJobs(async (jobs) => (await jobs.updateOne({ id, status: "draft" }, { $set: fields })).matchedCount > 0);
}

// Delete a draft. A job that has run is never deleted. Returns false if there is no such draft.
export function deleteDraft(id: string): Promise<boolean> {
  return withJobs(async (jobs) => (await jobs.deleteOne({ id, status: "draft" })).deletedCount > 0);
}

// Turn a draft into a job, in one step, so it can never run twice.
// Returns the changed job, or null if it is no longer a draft.
export function claimDraft(id: string, fields: Partial<Job>): Promise<Job | null> {
  return withJobs((jobs) =>
    jobs.findOneAndUpdate(
      { id, status: "draft" },
      { $set: fields },
      { returnDocument: "after", projection: { _id: 0 } },
    ),
  );
}

// One job by id, for the board routes (throws the board message when MongoDB is offline).
export function findBoardJob(id: string): Promise<Job | null> {
  return withJobs((jobs) => jobs.findOne({ id }, { projection: { _id: 0 } }));
}

// The saved cards for the board: all drafts (oldest first), and the newest finished jobs
// that started as a draft (they have a title).
export function listBoardJobs(doneLimit: number): Promise<{ drafts: Job[]; done: Job[] }> {
  return withJobs(async (jobs) => ({
    drafts: await jobs.find({ status: "draft" }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray(),
    done: await jobs
      .find({ status: "done", title: { $exists: true } }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(doneLimit)
      .toArray(),
  }));
}

// Jobs that were waiting or running. Used once when the backend starts (see recoverJobs in jobs.ts).
export async function findActiveJobs(): Promise<Job[]> {
  const jobs = await getJobsCollection();
  return await jobs.find({ status: { $in: ["queued", "running"] } }, { projection: { _id: 0 } }).toArray();
}

// Check the connection when the backend starts, and say clearly if it does not work.
// Also makes the indexes: createdAt for the newest-first list, id to find one job.
// Returns true if MongoDB works.
export async function checkDatabase(): Promise<boolean> {
  try {
    const jobs = await getJobsCollection();
    await jobs.createIndex({ createdAt: -1 });
    await jobs.createIndex({ id: 1 });
    // Chat: my conversations, newest first, and one conversation by id.
    const conversations = await getConversationsCollection();
    await conversations.createIndex({ owner: 1, updatedAt: -1 });
    await conversations.createIndex({ id: 1 });
    await (await getChatUsageCollection()).createIndex({ username: 1, createdAt: -1 });
    console.log("MongoDB: connected");
    return true;
  } catch (error) {
    console.warn(`Warning: MongoDB is not available. Images still work, but jobs are not saved. ${safeMessage(error)}`);
    return false;
  }
}

// An error message that is safe to log: any connection string is hidden.
export function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/mongodb(\+srv)?:\/\/\S+/gi, "[connection string hidden]");
}
