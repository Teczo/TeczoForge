import { MongoClient } from "mongodb";
import type { CollationOptions, Collection, Db, Filter } from "mongodb";
import { HttpError } from "./httpError.js";
import { kindOfFile } from "./outputKinds.js";
import type { OutputKind } from "./outputKinds.js";

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
  outputFile: string | null; // For example "data/outputs/text-to-image-basic-1791353459669-a1b2c3.png"
  imageUrl: string | null; // The finished file, of any kind (the name is from before FRG-29).
  outputKind?: OutputKind; // image, video, audio or 3d (FRG-29). Older jobs: see withOutputKind.
  error: string | null;
  durationMs: number; // 0 until the job is finished.
  createdAt: Date;
  createdBy: string | null; // The username of who started the job. Jobs from before FRG-16 do not have it.
  cancelledBy?: string | null; // Only on cancelled jobs: who cancelled it, and when.
  cancelledAt?: Date;
  title?: string; // Only on jobs that started as a board card (FRG-22).
  column?: DraftColumn; // Only used while the job is a draft.
  conversationId?: string; // Only on cards Claude made in a chat (FRG-24).
  inputFiles?: string[]; // Kept start images, for example "data/inputs/teczoforge-1-a1b2c3.png" (FRG-25).
  sourceJobId?: string; // "Send to": the job whose result is this job's start image (FRG-26).
  // The project this job or card belongs to (FRG-40). Older jobs get "Unsorted" when the backend
  // starts (see moveOldJobsToUnsorted). Empty only if MongoDB was never reached since the start.
  projectId: string;
};

// Which jobs GET /api/jobs returns. See listJobs.
export type JobQuery = {
  limit: number;
  before: Date | null; // Only jobs made before this time (for the next page).
  status: JobStatus | null;
  createdBy: string | null;
  projectId: string | null; // Only jobs in this project (FRG-40).
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
  images?: { id: string; path: string }[]; // Pictures attached to this message, kept in data/inputs (FRG-25).
};

// A chat conversation. Only its owner can read it.
export type Conversation = {
  id: string; // A UUID.
  owner: string;
  // The project this conversation belongs to (FRG-42). Cards Claude makes here go into it.
  // Older conversations get "Unsorted" when the backend starts (see moveOldConversationsToUnsorted).
  projectId: string;
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

// A project: a named container for jobs, board cards and chats (FRG-39).
// Everyone on the team can see and use every project. Projects are never deleted, only archived.
export type Project = {
  id: string; // A UUID.
  name: string; // 1 to 60 characters. Unique, not counting capital letters.
  createdBy: string | null; // The username. null for "Unsorted", which the backend makes itself.
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
};

// The project that always exists. Made when the backend starts, if it is missing (FRG-39).
export const UNSORTED_PROJECT_NAME = "Unsorted";

// Compare project names without capital letters: "Summer" and "summer" are the same name.
// Used by the unique index on name, and to sort the list by name.
export const PROJECT_NAME_COLLATION: CollationOptions = { locale: "en", strength: 2 };

// The id of "Unsorted", kept once it is known. It never changes: "Unsorted" cannot be renamed.
let unsortedProjectId: string | null = null;

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

// The users collection. Usernames are unique (the index is made once, in checkDatabase).
export async function getUsersCollection(): Promise<Collection<User>> {
  return (await getDatabase()).collection<User>("users");
}

// The chat conversations (FRG-23).
export async function getConversationsCollection(): Promise<Collection<Conversation>> {
  return (await getDatabase()).collection<Conversation>("conversations");
}

// The projects (FRG-39). Names are unique (the index is made once, in checkDatabase).
export async function getProjectsCollection(): Promise<Collection<Project>> {
  return (await getDatabase()).collection<Project>("projects");
}

export async function getChatUsageCollection(): Promise<Collection<ChatUsage>> {
  return (await getDatabase()).collection<ChatUsage>("chat_usage");
}

// Close the connection (used by the "npm run user" command when it is done).
export async function closeDatabase(): Promise<void> {
  if (connecting) await (await connecting).close();
  connecting = null;
}

// Jobs from before FRG-29 have no outputKind. Work it out from the file ending when reading.
function withOutputKind(job: Job): Job {
  if (job.outputKind || !job.imageUrl) return job;
  const kind = kindOfFile(job.imageUrl);
  return kind ? { ...job, outputKind: kind } : job;
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
  if (query.projectId) filter.projectId = query.projectId;
  try {
    const jobs = await getJobsCollection();
    const found = await jobs.find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(query.limit).toArray();
    return found.map(withOutputKind);
  } catch (error) {
    console.warn(`Warning: could not read jobs. ${safeMessage(error)}`);
    throw new HttpError(503, "The job history is not available because MongoDB cannot be reached.");
  }
}

// One job by its id, or null if there is none.
export async function findJob(id: string): Promise<Job | null> {
  try {
    const jobs = await getJobsCollection();
    const job = await jobs.findOne({ id }, { projection: { _id: 0 } });
    return job && withOutputKind(job);
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
  return withJobs(async (jobs) => {
    const job = await jobs.findOne({ id }, { projection: { _id: 0 } });
    return job && withOutputKind(job);
  });
}

// The saved cards for the board: all drafts (oldest first), and the newest finished jobs
// that started as a draft (they have a title). With a projectId, only that project's cards (FRG-42).
export function listBoardJobs(doneLimit: number, projectId: string | null): Promise<{ drafts: Job[]; done: Job[] }> {
  const inProject: Filter<Job> = projectId ? { projectId } : {};
  return withJobs(async (jobs) => ({
    drafts: await jobs.find({ status: "draft", ...inProject }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray(),
    done: (
      await jobs
        .find({ status: "done", title: { $exists: true }, ...inProject }, { projection: { _id: 0 } })
        .sort({ createdAt: -1 })
        .limit(doneLimit)
        .toArray()
    ).map(withOutputKind),
  }));
}

// How many jobs each project has, for "Manage projects" (FRG-43). Board cards that have not run
// (drafts) are not counted. Key: project id.
export async function countJobsByProject(): Promise<Map<string, number>> {
  try {
    const jobs = await getJobsCollection();
    const rows = await jobs
      .aggregate<{ _id: string; count: number }>([
        { $match: { status: { $ne: "draft" } } },
        { $group: { _id: "$projectId", count: { $sum: 1 } } },
      ])
      .toArray();
    return new Map(rows.map((row) => [row._id, row.count]));
  } catch (error) {
    console.warn(`Warning: could not count the jobs. ${safeMessage(error)}`);
    throw new HttpError(503, "Projects are not available because MongoDB cannot be reached.");
  }
}

// Move one job or card to another project (FRG-43). Only its projectId changes: its files stay
// where they are. Returns the changed job, or null if there is no job with this id.
export async function moveJobToProject(id: string, projectId: string): Promise<Job | null> {
  try {
    const jobs = await getJobsCollection();
    const job = await jobs.findOneAndUpdate({ id }, { $set: { projectId } }, { returnDocument: "after", projection: { _id: 0 } });
    return job && withOutputKind(job);
  } catch (error) {
    console.warn(`Warning: could not move the job. ${safeMessage(error)}`);
    throw new HttpError(503, "This job cannot be moved because MongoDB cannot be reached.");
  }
}

// The jobs and cards made from this job's result with "Send to" (FRG-26), oldest first.
export async function findUsedIn(id: string): Promise<Job[]> {
  try {
    const jobs = await getJobsCollection();
    return await jobs.find({ sourceJobId: id }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  } catch (error) {
    console.warn(`Warning: could not read the jobs. ${safeMessage(error)}`);
    throw new HttpError(503, "This is not available because MongoDB cannot be reached.");
  }
}

// Jobs that were waiting or running. Used once when the backend starts (see recoverJobs in jobs.ts).
export async function findActiveJobs(): Promise<Job[]> {
  const jobs = await getJobsCollection();
  return await jobs.find({ status: { $in: ["queued", "running"] } }, { projection: { _id: 0 } }).toArray();
}

// Check the connection when the backend starts, and say clearly if it does not work.
// Also makes the indexes: createdAt for the newest-first list, id to find one job, and the others below.
// Returns true if MongoDB works.
export async function checkDatabase(): Promise<boolean> {
  try {
    const jobs = await getJobsCollection();
    await jobs.createIndex({ createdAt: -1 });
    await jobs.createIndex({ id: 1 });
    await jobs.createIndex({ sourceJobId: 1 }); // "Used in" (FRG-26).
    await jobs.createIndex({ projectId: 1, createdAt: -1 }); // One project's jobs, newest first (FRG-40).
    // Chat: my conversations, newest first, and one conversation by id.
    const conversations = await getConversationsCollection();
    await conversations.createIndex({ owner: 1, updatedAt: -1 });
    await conversations.createIndex({ id: 1 });
    await (await getChatUsageCollection()).createIndex({ username: 1, createdAt: -1 });
    // Usernames are unique. Made here once, not on every login (FRG-28).
    await (await getUsersCollection()).createIndex({ username: 1 }, { unique: true });
    // Project names are unique, not counting capital letters (FRG-39).
    const projects = await getProjectsCollection();
    await projects.createIndex({ name: 1 }, { unique: true, collation: PROJECT_NAME_COLLATION });
    await projects.createIndex({ id: 1 });
    await ensureUnsortedProject(projects);
    await moveOldJobsToUnsorted(jobs);
    await moveOldConversationsToUnsorted(conversations);
    console.log("MongoDB: connected");
    return true;
  } catch (error) {
    console.warn(`Warning: MongoDB is not available. Images still work, but jobs are not saved. ${safeMessage(error)}`);
    return false;
  }
}

// Make the "Unsorted" project if it is missing (FRG-39). Runs each time the backend starts.
// It only adds the project when no project has this name, and the unique index above
// stops a second one, so a restart never makes two.
async function ensureUnsortedProject(projects: Collection<Project>): Promise<void> {
  const now = new Date();
  const result = await projects.updateOne(
    { name: UNSORTED_PROJECT_NAME },
    {
      $setOnInsert: {
        id: crypto.randomUUID(),
        name: UNSORTED_PROJECT_NAME,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
        archived: false,
      },
    },
    { upsert: true, collation: PROJECT_NAME_COLLATION },
  );
  if (result.upsertedCount > 0) console.log(`Projects: made the "${UNSORTED_PROJECT_NAME}" project.`);
  await getUnsortedProjectId();
}

// The id of "Unsorted" (FRG-40). Throws if MongoDB cannot be reached and the id is not known yet.
export async function getUnsortedProjectId(): Promise<string> {
  if (unsortedProjectId) return unsortedProjectId;
  const projects = await getProjectsCollection();
  const unsorted = await projects.findOne({ name: UNSORTED_PROJECT_NAME }, { collation: PROJECT_NAME_COLLATION });
  if (!unsorted) throw new Error(`The "${UNSORTED_PROJECT_NAME}" project is missing.`);
  unsortedProjectId = unsorted.id;
  return unsortedProjectId;
}

// The id of "Unsorted" if it is already known, without asking MongoDB. Used when MongoDB is offline.
export function knownUnsortedProjectId(): string | null {
  return unsortedProjectId;
}

// Give "Unsorted" to every job and card that has no project yet (FRG-40). Runs each time the
// backend starts. It only changes jobs without a project, so running it again changes nothing.
async function moveOldJobsToUnsorted(jobs: Collection<Job>): Promise<void> {
  const projectId = await getUnsortedProjectId();
  const result = await jobs.updateMany({ $or: [{ projectId: { $exists: false } }, { projectId: "" }] }, { $set: { projectId } });
  if (result.modifiedCount > 0) {
    console.log(`Projects: moved ${result.modifiedCount} job(s) without a project to "${UNSORTED_PROJECT_NAME}".`);
  }
}

// Give "Unsorted" to every chat conversation that has no project yet (FRG-42). Runs each time the
// backend starts. It only changes conversations without a project, so running it again changes nothing.
async function moveOldConversationsToUnsorted(conversations: Collection<Conversation>): Promise<void> {
  const projectId = await getUnsortedProjectId();
  const result = await conversations.updateMany({ projectId: { $exists: false } }, { $set: { projectId } });
  if (result.modifiedCount > 0) {
    console.log(`Projects: moved ${result.modifiedCount} chat(s) without a project to "${UNSORTED_PROJECT_NAME}".`);
  }
}

// How often to try MongoDB again when it could not be reached at start (FRG-28).
const RETRY_MS = 60_000;

// Check MongoDB when the backend starts. If it cannot be reached, try again every minute until
// it works. onFirstConnect runs once, the first time it works (used to recover unfinished jobs).
export async function connectDatabase(onFirstConnect: () => Promise<void>): Promise<void> {
  if (await checkDatabase()) {
    await onFirstConnect();
    return;
  }
  console.log(`MongoDB: trying again in ${RETRY_MS / 1000} seconds.`);
  setTimeout(() => {
    connectDatabase(onFirstConnect).catch((error) => console.error("Connecting to MongoDB failed:", safeMessage(error)));
  }, RETRY_MS);
}

// An error message that is safe to log: any connection string is hidden.
export function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/mongodb(\+srv)?:\/\/\S+/gi, "[connection string hidden]");
}
