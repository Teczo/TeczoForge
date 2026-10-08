import { MongoClient } from "mongodb";
import type { Collection, Db, Filter } from "mongodb";
import { HttpError } from "./httpError.js";

// The connection string is a secret. Never print it.
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "teczoforge";

// How long to wait for MongoDB before giving up. Generation must not wait long for it.
const TIMEOUT_MS = 3000;

// queued: waiting in ComfyUI's queue. running: ComfyUI is working on it.
// done, failed or cancelled: finished.
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

// One record per job. It is saved when the job starts, and again each time its status changes.
export type Job = {
  id: string; // A UUID. Jobs from before FRG-20 do not have it.
  presetId: string | null;
  inputs: unknown; // The values used, including the random seed.
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
