import { MongoClient } from "mongodb";
import type { Collection } from "mongodb";
import { HttpError } from "./httpError.js";

// The connection string is a secret. Never print it.
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "teczoforge";

// How long to wait for MongoDB before giving up. Generation must not wait long for it.
const TIMEOUT_MS = 3000;

// One record per generate call.
export type Job = {
  presetId: string | null;
  inputs: unknown; // The values used, including the random seed.
  status: "done" | "failed";
  outputFile: string | null; // For example "data/outputs/text-to-image-basic-1791353459669.png"
  imageUrl: string | null;
  error: string | null;
  durationMs: number;
  createdAt: Date;
};

let connecting: Promise<MongoClient> | null = null;

// Connect once and reuse the connection. If it fails, the next call tries again.
async function getJobsCollection(): Promise<Collection<Job>> {
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
  return client.db(DB_NAME).collection<Job>("jobs");
}

// Save a job. Returns a warning if it could not be saved. Never throws,
// so generation still works when MongoDB is offline.
export async function saveJob(job: Job): Promise<string | undefined> {
  try {
    const jobs = await getJobsCollection();
    await jobs.insertOne(job);
    return undefined;
  } catch (error) {
    console.warn(`Warning: job not saved. ${safeMessage(error)}`);
    return "This job was not saved to the job history because MongoDB cannot be reached.";
  }
}

// All jobs, newest first.
export async function listJobs(limit: number): Promise<Job[]> {
  try {
    const jobs = await getJobsCollection();
    return await jobs.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
  } catch (error) {
    console.warn(`Warning: could not read jobs. ${safeMessage(error)}`);
    throw new HttpError(503, "The job history is not available because MongoDB cannot be reached.");
  }
}

// Check the connection when the backend starts, and say clearly if it does not work.
export async function checkDatabase(): Promise<void> {
  try {
    await getJobsCollection();
    console.log("MongoDB: connected");
  } catch (error) {
    console.warn(`Warning: MongoDB is not available. Images still work, but jobs are not saved. ${safeMessage(error)}`);
  }
}

// An error message that is safe to log: any connection string is hidden.
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/mongodb(\+srv)?:\/\/\S+/gi, "[connection string hidden]");
}
